// CautionTrading — server: REST API + alert engine loop + SSE push + Telegram
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const { indicatorMeta, INDICATORS, computeSeries } = require("./indicators");
const { OPS, evaluateAlert, resolutionSeconds, barsNeeded } = require("./engine");
const store = require("./store");

const PORT = process.env.PORT || 8899;
const DELTA_BASE = process.env.DELTA_BASE || "https://api.india.delta.exchange";
// 1-second checks. Delta allows ~10,000 requests / 5 min (≈33/s), and alerts
// sharing a symbol+interval share one fetch, so this stays far under the limit
// for any realistic number of alerts.
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 1000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------- Delta Exchange data ----------------

let symbolCache = { at: 0, list: [] };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function getSymbols() {
  if (Date.now() - symbolCache.at < 10 * 60 * 1000 && symbolCache.list.length) {
    return symbolCache.list;
  }
  const list = [];
  let after = null;
  // paginate through all products
  for (let page = 0; page < 30; page++) {
    const url = `${DELTA_BASE}/v2/products?page_size=500${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const data = await fetchJson(url);
    if (!data.success) throw new Error("products API failed");
    for (const p of data.result) {
      if (p.trading_status !== "operational") continue;
      list.push({
        symbol: p.symbol,
        description: p.short_description || p.description || "",
        type: p.contract_type || "",
      });
    }
    after = data.meta && data.meta.after;
    if (!after) break;
  }
  // perpetuals first, then futures, then options
  const rank = (t) =>
    t.includes("perpetual") ? 0 : t.includes("futures") ? 1 : 2;
  list.sort((a, b) => rank(a.type) - rank(b.type) || a.symbol.localeCompare(b.symbol));
  symbolCache = { at: Date.now(), list };
  return list;
}

// short-lived candle cache so several alerts on the same symbol+interval share one fetch
const candleCache = new Map(); // key -> {at, candles}

async function getCandles(symbol, resolution, bars) {
  const key = `${symbol}|${resolution}|${bars}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 700) return hit.candles;

  const resSec = resolutionSeconds(resolution);
  const end = Math.floor(Date.now() / 1000) + resSec;
  const start = end - resSec * (bars + 5);
  const url = `${DELTA_BASE}/v2/history/candles?resolution=${resolution}&symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`;
  const data = await fetchJson(url);
  if (!data.success) throw new Error(`candles API failed for ${symbol}`);
  const candles = (data.result || [])
    .map(c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume }))
    .sort((a, b) => a.time - b.time);
  candleCache.set(key, { at: Date.now(), candles });
  return candles;
}

// ---------------- SSE (live push to the browser) ----------------

const sseClients = new Set();

function ssePush(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { /* dropped */ }
  }
}

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// ---------------- Telegram ----------------

async function sendTelegram(text) {
  const { settings } = store.load();
  if (!settings.telegramToken || !settings.telegramChatId) {
    return { ok: false, error: "Telegram not configured" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text }),
    });
    const data = await res.json();
    return data.ok ? { ok: true } : { ok: false, error: data.description || "Telegram error" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------- alert engine loop ----------------

const runtimeState = new Map(); // alertId -> {lastAbove, lastBarFired, lastFiredAt, ...live info}

function rtState(id) {
  if (!runtimeState.has(id)) runtimeState.set(id, {});
  return runtimeState.get(id);
}

function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(4);
}

function describeOperand(operand) {
  if (!operand) return "?";
  if (operand.kind === "value") return fmtNum(Number(operand.value));
  const spec = operand.kind === "indicator" ? operand.spec : operand;
  const def = INDICATORS[spec.type];
  if (!def) return spec.type;
  const base = def.label.split(" (")[0];
  const params = def.params.map(p => (spec.params && spec.params[p.name]) ?? p.def).join(",");
  const out = spec.output && def.outputs ? ` ${spec.output}` : "";
  return params ? `${base}(${params})${out}` : `${base}${out}`;
}

function describeAlert(a) {
  const opTxt = { cross_up: "crossing up", cross_down: "crossing down", cross: "crossing", gt: ">", lt: "<" }[a.op] || a.op;
  return `${a.symbol} ${a.resolution}: ${describeOperand(a.left)} ${opTxt} ${describeOperand(a.right)}`;
}

let engineBusy = false;

async function engineTick() {
  if (engineBusy) return;
  engineBusy = true;
  const now = Date.now();
  try {
    const s = store.load();
    const active = s.alerts.filter(a => a.enabled && a.status === "active");

    // expire
    for (const a of active) {
      if (a.expiresAt && now > a.expiresAt) {
        a.status = "expired";
        store.save();
      }
    }

    // group by symbol+resolution so each pair is fetched once
    const groups = new Map();
    for (const a of active.filter(x => x.status === "active")) {
      const key = `${a.symbol}|${a.resolution}`;
      if (!groups.has(key)) groups.set(key, { symbol: a.symbol, resolution: a.resolution, alerts: [], bars: 0 });
      const g = groups.get(key);
      g.alerts.push(a);
      g.bars = Math.max(g.bars, barsNeeded(a));
    }

    for (const g of groups.values()) {
      let candles;
      try {
        candles = await getCandles(g.symbol, g.resolution, g.bars);
      } catch (e) {
        for (const a of g.alerts) {
          const st = rtState(a.id);
          st.lastError = `data fetch failed: ${e.message}`;
          st.lastChecked = now;
        }
        continue;
      }
      for (const a of g.alerts) {
        const st = rtState(a.id);
        try {
          const r = evaluateAlert(a, candles, st, now);
          st.lastChecked = now;
          st.lastError = null;
          st.leftValue = r.leftValue;
          st.rightValue = r.rightValue;
          if (candles.length) st.lastPrice = candles[candles.length - 1].close;

          if (r.fired) {
            const text = `🔔 ALERT: ${a.message || describeAlert(a)}\n${describeAlert(a)}\nValue: ${fmtNum(r.leftValue)} vs ${fmtNum(r.rightValue)}\nPrice: ${fmtNum(st.lastPrice)}\n${new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`;
            const rec = {
              id: crypto.randomUUID(),
              alertId: a.id,
              time: now,
              symbol: a.symbol,
              resolution: a.resolution,
              message: a.message || describeAlert(a),
              condition: describeAlert(a),
              leftValue: r.leftValue,
              rightValue: r.rightValue,
              price: st.lastPrice,
            };
            store.addFired(rec);
            if (a.trigger === "once") {
              a.status = "fired";
              store.save();
            }
            console.log(`[FIRED] ${describeAlert(a)} @ ${fmtNum(r.leftValue)}`);
            if (!a.channels || a.channels.app !== false) ssePush("alert", rec);
            if (a.channels && a.channels.telegram) {
              sendTelegram(text).then(t => {
                if (!t.ok) console.error("telegram send failed:", t.error);
              });
            }
          }
        } catch (e) {
          st.lastChecked = now;
          st.lastError = e.message;
        }
      }
    }
  } catch (e) {
    console.error("engine tick error:", e.message);
  } finally {
    engineBusy = false;
  }
}

setInterval(engineTick, CHECK_INTERVAL_MS);

// ---------------- REST API ----------------

app.get("/api/meta", (req, res) => {
  res.json({
    indicators: indicatorMeta(),
    ops: OPS,
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"],
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
  });
});

app.get("/api/symbols", async (req, res) => {
  try {
    res.json({ ok: true, symbols: await getSymbols() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Live tickers (last price + 24h change) for the symbol browser
let tickerCache = { at: 0, list: [] };
app.get("/api/tickers", async (req, res) => {
  try {
    if (Date.now() - tickerCache.at > 10000) {
      const data = await fetchJson(`${DELTA_BASE}/v2/tickers`);
      if (data.success) {
        tickerCache = {
          at: Date.now(),
          list: (data.result || []).map(t => ({
            symbol: t.symbol,
            close: +t.close || null,
            changePct: t.open ? ((+t.close - +t.open) / +t.open) * 100 : null,
            turnover: +t.turnover_usd || +t.turnover || 0,
          })),
        };
      }
    }
    res.json({ ok: true, tickers: tickerCache.list });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Candles + computed indicator series for the chart
app.post("/api/series", async (req, res) => {
  try {
    const { symbol, resolution, specs } = req.body;
    if (!symbol || !resolution) return res.json({ ok: false, error: "symbol/resolution required" });
    let bars = Math.min(Number(req.body.bars) || 300, 1500);
    // give slow indicators warm-up room beyond the visible window
    for (const s of specs || []) {
      for (const v of Object.values(s.params || {})) {
        const n = Number(v);
        if (Number.isFinite(n)) bars = Math.max(bars, 300 + n * 5);
      }
    }
    const candles = await getCandles(symbol, resolution, bars);
    const series = (specs || []).slice(0, 8).map(spec => {
      try {
        return computeSeries(spec, candles).map(v => (Number.isFinite(v) ? v : null));
      } catch {
        return candles.map(() => null);
      }
    });
    res.json({ ok: true, candles, series });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/alerts", (req, res) => {
  const s = store.load();
  const alerts = s.alerts.map(a => ({ ...a, runtime: runtimeState.get(a.id) || {} }));
  res.json({ ok: true, alerts });
});

function validateAlert(body) {
  if (!body.symbol || typeof body.symbol !== "string") return "Symbol is required";
  if (!body.resolution) return "Interval is required";
  if (!body.left || !INDICATORS[body.left.type]) return "Invalid condition (left side)";
  if (!OPS[body.op]) return "Invalid operator";
  if (!body.right) return "Right side required";
  if (body.right.kind === "value") {
    if (!Number.isFinite(Number(body.right.value))) return "Value must be a number";
  } else if (body.right.kind === "indicator") {
    if (!body.right.spec || !INDICATORS[body.right.spec.type]) return "Invalid comparison indicator";
  } else return "Invalid right side";
  if (!["once", "once_per_bar", "every"].includes(body.trigger)) return "Invalid trigger";
  return null;
}

function alertFromBody(body, existing) {
  return {
    id: existing ? existing.id : crypto.randomUUID(),
    createdAt: existing ? existing.createdAt : Date.now(),
    symbol: body.symbol.trim().toUpperCase(),
    resolution: body.resolution,
    left: body.left,
    op: body.op,
    right: body.right,
    trigger: body.trigger,
    message: (body.message || "").slice(0, 300),
    expiresAt: body.expiresAt ? Number(body.expiresAt) : null,
    channels: { app: body.channels?.app !== false, telegram: !!body.channels?.telegram },
    enabled: body.enabled !== false,
    status: "active",
  };
}

app.post("/api/alerts", (req, res) => {
  const err = validateAlert(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });
  const s = store.load();
  const alert = alertFromBody(req.body);
  s.alerts.push(alert);
  store.save();
  engineTick(); // evaluate immediately
  res.json({ ok: true, alert });
});

app.put("/api/alerts/:id", (req, res) => {
  const s = store.load();
  const idx = s.alerts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Alert not found" });
  const err = validateAlert(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });
  const updated = alertFromBody(req.body, s.alerts[idx]);
  s.alerts[idx] = updated;
  runtimeState.delete(updated.id); // reset edge state after edit
  store.save();
  engineTick();
  res.json({ ok: true, alert: updated });
});

app.post("/api/alerts/:id/toggle", (req, res) => {
  const s = store.load();
  const a = s.alerts.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: "Alert not found" });
  a.enabled = !a.enabled;
  if (a.enabled) {
    a.status = "active"; // re-arming a fired/expired alert reactivates it
    runtimeState.delete(a.id);
  }
  store.save();
  if (a.enabled) engineTick();
  res.json({ ok: true, alert: a });
});

app.delete("/api/alerts/:id", (req, res) => {
  const s = store.load();
  const idx = s.alerts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Alert not found" });
  s.alerts.splice(idx, 1);
  runtimeState.delete(req.params.id);
  store.save();
  res.json({ ok: true });
});

app.get("/api/fired", (req, res) => {
  res.json({ ok: true, fired: store.load().fired.slice(0, 100) });
});

app.get("/api/settings", (req, res) => {
  const { settings } = store.load();
  res.json({
    ok: true,
    settings: {
      telegramChatId: settings.telegramChatId,
      telegramConfigured: !!(settings.telegramToken && settings.telegramChatId),
      telegramTokenMasked: settings.telegramToken ? settings.telegramToken.slice(0, 6) + "•••" : "",
      soundEnabled: settings.soundEnabled,
    },
  });
});

app.post("/api/settings", (req, res) => {
  const s = store.load();
  if (typeof req.body.telegramToken === "string" && req.body.telegramToken !== "") {
    s.settings.telegramToken = req.body.telegramToken.trim();
  }
  if (req.body.telegramToken === null) s.settings.telegramToken = "";
  if (typeof req.body.telegramChatId === "string") s.settings.telegramChatId = req.body.telegramChatId.trim();
  if (typeof req.body.soundEnabled === "boolean") s.settings.soundEnabled = req.body.soundEnabled;
  store.save();
  res.json({ ok: true });
});

// After the user messages their bot once, this finds their chat id automatically
app.get("/api/telegram/detect-chat", async (req, res) => {
  const { settings } = store.load();
  if (!settings.telegramToken) return res.json({ ok: false, error: "Save the bot token first" });
  try {
    const data = await (await fetch(`https://api.telegram.org/bot${settings.telegramToken}/getUpdates`)).json();
    if (!data.ok) return res.json({ ok: false, error: data.description || "Bad token" });
    const msgs = (data.result || []).filter(u => u.message && u.message.chat);
    if (!msgs.length) {
      return res.json({ ok: false, error: "No message found. Open Telegram, send any message (e.g. 'hi') to your bot, then try again." });
    }
    const chat = msgs[msgs.length - 1].message.chat;
    const s = store.load();
    s.settings.telegramChatId = String(chat.id);
    store.save();
    res.json({ ok: true, chatId: String(chat.id), name: chat.first_name || chat.title || "" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/telegram/test", async (req, res) => {
  const r = await sendTelegram("✅ CautionTrading test message — Telegram alerts are working!");
  res.json(r);
});

// Live preview while building an alert: current values of both sides
app.post("/api/preview", async (req, res) => {
  try {
    const body = req.body;
    const err = validateAlert(body);
    if (err) return res.json({ ok: false, error: err });
    const fake = alertFromBody(body);
    const candles = await getCandles(fake.symbol, fake.resolution, barsNeeded(fake));
    const st = {};
    const r = evaluateAlert({ ...fake, trigger: "every" }, candles, st, Date.now());
    res.json({
      ok: true,
      leftValue: Number.isNaN(r.leftValue) ? null : r.leftValue,
      rightValue: Number.isNaN(r.rightValue) ? null : r.rightValue,
      price: candles.length ? candles[candles.length - 1].close : null,
      condition: describeAlert(fake),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`CautionTrading running → http://localhost:${PORT}`);
  engineTick();
});
