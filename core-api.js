// Shared API logic (Express local + Hono on Cloudflare Workers)
const crypto = require("crypto");
const { indicatorMeta, INDICATORS, computeSeries } = require("./indicators");
const { OPS, evaluateAlert, resolutionSeconds, barsNeeded } = require("./engine");
const store = require("./store");
const india = require("./sources/india");

function createApiCore() {
  const DELTA_BASE = process.env.DELTA_BASE || "https://api.india.delta.exchange";
  const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 1000);
// ---------------- Delta Exchange data ----------------

let symbolCache = { at: 0, list: [] };

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CautionTrading/1.0 (Cloudflare Worker)",
    },
  });
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

// route by exchange: NSE:* → Yahoo-backed Indian source, everything else → Delta
async function getCandlesAny(symbol, resolution, bars) {
  if (india.isIndia(symbol)) return india.getCandles(symbol, resolution, bars);
  return getCandles(symbol, resolution, bars);
}

const sseClients = new Set();

function ssePush(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { /* dropped */ }
  }
}

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
        candles = await getCandlesAny(g.symbol, g.resolution, g.bars);
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


let tickerCache = { at: 0, list: [] };
const obCache = new Map();
const trCache = new Map();
const tkCache = new Map();
const prodCache = new Map();

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

  return {
    DELTA_BASE, CHECK_INTERVAL_MS, engineTick, ssePush, sseClients, runtimeState, rtState,
    fetchJson, getSymbols, getCandlesAny, validateAlert, alertFromBody, describeAlert,
    sendTelegram, indicatorMeta, OPS, india, store, INDICATORS, computeSeries, barsNeeded, evaluateAlert,
    tickerCache, obCache, trCache, tkCache, prodCache,
  };
}
module.exports = createApiCore;
