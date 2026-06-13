#!/usr/bin/env node
/**
 * CautionTrading — real-time data latency benchmark
 *
 * HOW TO FIND THE wss:// URL (Chrome DevTools)
 * --------------------------------------------
 * 1. Open https://cautiontrading.amitynoidalibrary.workers.dev/ in Chrome
 * 2. Press F12 → Network tab → filter "WS" (WebSocket)
 * 3. Reload the page; you should see a connection to:
 *      wss://socket.india.delta.exchange
 *    The browser connects DIRECTLY to Delta's public socket (not proxied through
 *    the Cloudflare Worker). This script taps the same feed the terminal uses.
 *
 * WHAT THIS MEASURES (and why the numbers are honest)
 * ---------------------------------------------------
 * Your terminal rides Delta's push WebSocket — the same canonical feed Delta's
 * own site uses. REST polling is a SLOWER path by nature. So the meaningful
 * questions are:
 *   • Drift     — does the terminal's price agree with the official REST price?
 *                 (THE real freshness signal — should be ~0)
 *   • WS Lead   — how many ms EARLIER the WebSocket already knew the price that
 *                 REST just returned (positive = terminal is ahead of REST)
 *   • WS Age    — how old the latest WS tick is (large in a quiet market simply
 *                 because the price didn't move — not a problem on its own)
 * We do NOT block waiting for the "next" tick (that inflated latency in quiet
 * markets in the old version).
 *
 * Run: npm install && npm start   (or: node latency-check.js)
 */

"use strict";

const WebSocket = require("ws");

// ── Config (override via env) ───────────────────────────────────────────────
const SITE_URL = (process.env.SITE_URL || "https://cautiontrading.amitynoidalibrary.workers.dev").replace(/\/$/, "");
const DELTA_WS_URL = process.env.DELTA_WS_URL || "wss://socket.india.delta.exchange";
const DELTA_API_BASE = (process.env.DELTA_API_BASE || "https://api.india.delta.exchange").replace(/\/$/, "");
const DELTA_SYMBOL = process.env.DELTA_SYMBOL || "BTCUSD";
const NSE_SYMBOL = process.env.NSE_SYMBOL || "NSE:NIFTY";
const CYCLE_MS = Number(process.env.CYCLE_MS || 5000);
const DURATION_MS = Number(process.env.DURATION_MS || 120000);
const TICK_BUFFER_MS = Number(process.env.TICK_BUFFER_MS || 20000); // how far back we match prices for "WS Lead"
const UA = "CautionTrading-LatencyBench/1.0";
const PRICE_EPS = 1e-6;

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString("en-IN", { hour12: false });
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Median + p90 are robust to the odd 9-second Yahoo/Turso spike that made the
// plain average misleading in the old report.
function stat(label, values, unit = "ms") {
  if (!values.length) return `${label}: no data`;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    `${label}: median ${percentile(values, 50)}${unit} · avg ${avg(values).toFixed(0)}${unit} · ` +
    `p90 ${percentile(values, 90)}${unit} · min ${sorted[0]}${unit} · max ${sorted[sorted.length - 1]}${unit}`
  );
}

async function fetchJson(url, opts = {}) {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA, ...opts.headers },
    ...opts,
  });
  const timestamp = Date.now();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = await res.json();
  return { data, timestamp, rtt: timestamp - t0 };
}

function extractDeltaPrice(data) {
  const t = data?.result;
  if (!t) throw new Error("Delta ticker missing result");
  const price = +(t.close ?? t.mark_price);
  if (!Number.isFinite(price)) throw new Error("Delta ticker has no close/mark_price");
  return price;
}

function yahooSym(nseSym) {
  const map = {
    NIFTY: "^NSEI",
    BANKNIFTY: "^NSEBANK",
    FINNIFTY: "NIFTY_FIN_SERVICE.NS",
    MIDCPNIFTY: "NIFTY_MID_SELECT.NS",
    SENSEX: "^BSESN",
  };
  return map[nseSym] || `${nseSym}.NS`;
}

async function fetchYahooNse(symbol) {
  const nseSym = symbol.startsWith("NSE:") ? symbol.slice(4) : symbol;
  const y = encodeURIComponent(yahooSym(nseSym));
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${y}?interval=1d&range=5d`;
  const { data, timestamp } = await fetchJson(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  const r = data?.chart?.result?.[0];
  const meta = r?.meta || {};
  const candles = r?.indicators?.quote?.[0]?.close || [];
  const last = candles.filter((c) => c != null).pop();
  const price = meta.regularMarketPrice ?? last;
  if (!Number.isFinite(price)) throw new Error(`Yahoo has no price for ${symbol}`);
  return { price, timestamp };
}

// ── WebSocket tap (same feed as the live terminal) ──────────────────────────
function createDeltaWs(symbol) {
  let ws = null;
  let retryMs = 1000;
  let retryTimer = null;
  let closed = false;
  let latest = null; // { price, timestamp }
  const ticks = []; // ring buffer of { price, timestamp } for the last TICK_BUFFER_MS

  function pushTick(price) {
    const now = Date.now();
    latest = { price, timestamp: now };
    ticks.push(latest);
    const cutoff = now - TICK_BUFFER_MS;
    while (ticks.length && ticks[0].timestamp < cutoff) ticks.shift();
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(DELTA_WS_URL);
    } catch {
      scheduleRetry();
      return;
    }

    ws.on("open", () => {
      retryMs = 1000;
      ws.send(
        JSON.stringify({
          type: "subscribe",
          payload: { channels: [{ name: "v2/ticker", symbols: [symbol] }] },
        })
      );
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type !== "v2/ticker" || msg.symbol !== symbol) return;
      const price = +(msg.close ?? msg.mark_price);
      if (!Number.isFinite(price)) return;
      pushTick(price);
    });

    ws.on("close", () => {
      ws = null;
      scheduleRetry();
    });

    ws.on("error", () => {
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    });
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  }

  connect();

  return {
    getLatest() {
      return latest ? { ...latest } : null;
    },
    // How many ms earlier the WS already showed `price`, relative to `restArrival`.
    // Finds the EARLIEST buffered tick (within the window) matching the price.
    // null if the WS never reported that exact price (e.g. it moved past it).
    leadFor(price, restArrival) {
      for (const t of ticks) {
        if (t.timestamp > restArrival) break;
        if (Math.abs(t.price - price) < PRICE_EPS) return restArrival - t.timestamp;
      }
      return null;
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      try {
        ws?.removeAllListeners();
        ws?.terminate();
      } catch {
        /* noop */
      }
      ws = null;
    },
  };
}

// ── Table printers ──────────────────────────────────────────────────────────
const BTC_COLS = [
  ["Time", 8],
  ["My Price", 10],
  ["Delta REST", 11],
  ["Drift", 8],
  ["WS Age", 8],
  ["WS Lead", 9],
];
const NSE_COLS = [
  ["Time", 8],
  ["Worker Price", 13],
  ["Yahoo Price", 12],
  ["Drift", 8],
  ["Latency", 9],
];

function headerLine(cols) {
  return "| " + cols.map(([t, n]) => pad(t, n)).join(" | ") + " |";
}
function sepLine(cols) {
  return "|" + cols.map(([, n]) => "-".repeat(n + 2)).join("|") + "|";
}
function rowLine(cols, cells) {
  return "| " + cols.map(([, n], i) => pad(cells[i], n)).join(" | ") + " |";
}

// ── Main benchmark ──────────────────────────────────────────────────────────
async function main() {
  console.log("CautionTrading latency benchmark");
  console.log(`Site:      ${SITE_URL}`);
  console.log(`WS feed:   ${DELTA_WS_URL} (${DELTA_SYMBOL})`);
  console.log(`Delta API: ${DELTA_API_BASE}/v2/tickers/${DELTA_SYMBOL}`);
  console.log(`NSE sym:   ${NSE_SYMBOL}`);
  console.log(`Cycle:     every ${CYCLE_MS / 1000}s for ${DURATION_MS / 1000}s\n`);

  const dws = createDeltaWs(DELTA_SYMBOL);

  console.log("Connecting WebSocket…");
  const warmStart = Date.now();
  while (!dws.getLatest() && Date.now() - warmStart < 15000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!dws.getLatest()) {
    console.warn("⚠ WebSocket warm-up timed out — BTC rows may be blank until connected.");
  } else {
    console.log(`WebSocket ready (first tick @ ${fmtTime(dws.getLatest().timestamp)})`);
  }

  // Warm up the Worker once so its (and Turso's) cold start doesn't pollute the
  // measured RTTs — the old run's 12s average was a single cold-start outlier.
  try {
    const t0 = Date.now();
    await fetch(`${SITE_URL}/api/health`, { headers: { "User-Agent": UA } });
    console.log(`Worker warm-up: ${Date.now() - t0}ms\n`);
  } catch {
    console.log("Worker warm-up failed (will still try during cycles)\n");
  }

  const btcLeads = []; // ms WS was ahead of REST (only when a price match was found)
  const btcAges = [];
  const btcDrifts = [];
  const nseLatencies = [];
  const nseDrifts = [];
  const tursoRtts = [];
  let cycle = 0;

  console.log("── BTCUSD: Site WebSocket vs Delta REST ──");
  console.log(headerLine(BTC_COLS));
  console.log(sepLine(BTC_COLS));

  const endAt = Date.now() + DURATION_MS;

  while (Date.now() < endAt) {
    cycle++;
    const cycleStart = Date.now();

    // 1) BTC — latest WS tick (no blocking) vs fresh REST snapshot
    try {
      const rest = await fetchJson(`${DELTA_API_BASE}/v2/tickers/${encodeURIComponent(DELTA_SYMBOL)}`).then((r) => ({
        price: extractDeltaPrice(r.data),
        timestamp: r.timestamp,
      }));
      const ws = dws.getLatest();

      if (!ws) {
        console.log(rowLine(BTC_COLS, [fmtTime(cycleStart), "—", rest.price.toFixed(1), "—", "no WS", "—"]));
      } else {
        const drift = Math.abs(ws.price - rest.price);
        const age = rest.timestamp - ws.timestamp; // how old our latest WS tick is
        const lead = dws.leadFor(rest.price, rest.timestamp); // ms WS knew this price before REST

        btcDrifts.push(drift);
        btcAges.push(age);
        if (lead != null) btcLeads.push(lead);

        console.log(
          rowLine(BTC_COLS, [
            fmtTime(cycleStart),
            ws.price.toFixed(1),
            rest.price.toFixed(1),
            drift.toFixed(2),
            `${age}ms`,
            lead != null ? `+${lead}ms` : "—",
          ])
        );
      }
    } catch (e) {
      console.log(`| ${pad(fmtTime(cycleStart), 8)} | BTC ERROR: ${e.message}`);
    }

    // 2) NSE — Worker proxy vs Yahoo source (REST vs REST; latency = arrival gap)
    try {
      const [workerResult, yahooResult] = await Promise.all([
        fetchJson(`${SITE_URL}/api/ticker?symbol=${encodeURIComponent(NSE_SYMBOL)}`).then((r) => {
          const price = +r.data?.price;
          if (!Number.isFinite(price)) throw new Error("Worker NSE ticker missing price");
          return { price, timestamp: r.timestamp };
        }),
        fetchYahooNse(NSE_SYMBOL),
      ]);

      const latencyMs = Math.abs(workerResult.timestamp - yahooResult.timestamp);
      const drift = Math.abs(workerResult.price - yahooResult.price);
      nseLatencies.push(latencyMs);
      nseDrifts.push(drift);

      if (cycle === 1) {
        console.log("\n── NSE: Worker /api/ticker vs Yahoo Finance ──");
        console.log(headerLine(NSE_COLS));
        console.log(sepLine(NSE_COLS));
      }
      console.log(
        rowLine(NSE_COLS, [
          fmtTime(cycleStart),
          workerResult.price.toFixed(2),
          yahooResult.price.toFixed(2),
          drift.toFixed(2),
          `${latencyMs}ms`,
        ])
      );
    } catch (e) {
      if (cycle === 1) {
        console.log("\n── NSE: Worker /api/ticker vs Yahoo Finance ──");
        console.log(`  NSE skipped: ${e.message}`);
      }
    }

    // 3) Turso / Worker round-trip (GET /api/alerts → store.reload → Turso)
    try {
      const t0 = Date.now();
      const res = await fetch(`${SITE_URL}/api/alerts`, {
        headers: { Accept: "application/json", "User-Agent": UA },
      });
      const rtt = Date.now() - t0;
      tursoRtts.push(rtt);
      if (!res.ok) console.log(`  Turso probe HTTP ${res.status} (${rtt}ms)`);
      else if (cycle === 1 || cycle % 6 === 0) console.log(`  Turso/Worker GET /api/alerts: ${rtt}ms`);
    } catch (e) {
      console.log(`  Turso probe failed: ${e.message}`);
    }

    const remaining = endAt - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(CYCLE_MS - (Date.now() - cycleStart), remaining);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  dws.close();

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n════════════ SUMMARY ════════════\n");

  console.log("BTCUSD — terminal WebSocket vs official Delta REST");
  console.log(`  Price drift: avg ${avg(btcDrifts).toFixed(2)} · max ${btcDrifts.length ? Math.max(...btcDrifts).toFixed(2) : "n/a"}  ← real freshness signal`);
  if (btcLeads.length) {
    console.log("  " + stat("WS lead over REST", btcLeads));
    console.log(`  → On ${btcLeads.length}/${btcDrifts.length} cycles the terminal had the price BEFORE the official REST replied.`);
  } else {
    console.log("  WS lead: no exact price match this run (prices moved between samples)");
  }
  console.log("  " + stat("WS tick age", btcAges) + "  (large only because price was quiet)");

  if (nseLatencies.length) {
    console.log("\nNSE — Worker /api/ticker vs Yahoo");
    console.log("  " + stat("Arrival gap", nseLatencies));
    console.log(`  Price drift: avg ${avg(nseDrifts).toFixed(2)} · max ${Math.max(...nseDrifts).toFixed(2)}`);
  } else {
    console.log("\nNSE: no successful samples");
  }

  if (tursoRtts.length) {
    console.log("\nTurso / Worker round-trip (GET /api/alerts)");
    console.log("  " + stat("RTT", tursoRtts));
  }

  console.log(`
──────── Telegram delivery (manual) ────────
Start stopwatch → trigger an alert manually on the site → stop when
Telegram message arrives → note the seconds.

| Run # | Symbol | Alert type | Seconds to Telegram | Notes |
|-------|--------|------------|---------------------|-------|
| 1     |        |            |                     |       |
| 2     |        |            |                     |       |
| 3     |        |            |                     |       |
`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFatal:", e.message);
    process.exit(1);
  });
