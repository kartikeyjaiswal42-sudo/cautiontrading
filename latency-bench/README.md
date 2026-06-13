# CautionTrading Latency Benchmark

Measures how fresh your trading terminal's data is compared to the official source APIs.

## Quick start

```bash
cd latency-bench
npm install
npm start
```

Requires **Node.js 18+** (uses built-in `fetch`).

Optional: copy `.env.example` → `.env` and adjust URLs/symbols. The script reads `process.env` directly — export vars or use a loader if you prefer.

## What it measures

### 1. BTCUSD — WebSocket vs Delta REST

| Column | Meaning |
|--------|---------|
| **Time** | Cycle start (local clock) |
| **My Price** | Latest price from `wss://socket.india.delta.exchange` — the **same socket** your browser opens (DevTools → Network → WS) |
| **Delta REST** | `close` from `GET /v2/tickers/BTCUSD` on the official Delta India API |
| **Drift** | `|price_ws − price_rest|` — **the real freshness signal**; should be ~0 |
| **WS Age** | How old the latest WS tick is when REST replied. Large in a quiet market simply because the price didn't move — not a problem on its own |
| **WS Lead** | How many ms **earlier** the WebSocket already knew the price REST just returned. `+340ms` means your terminal had the price 340 ms before the official REST snapshot. `—` means no exact match this cycle |

> **Why not a simple "latency"?** Your terminal rides Delta's push WebSocket — the same canonical feed Delta's own site uses. REST polling is a slower path by design, so the WS is normally *ahead* of REST. The old version blocked waiting for the next tick, which made quiet markets look slow even though the feed was fresh. **Drift + WS Lead** are the honest measures.
>
> The Cloudflare Worker does **not** proxy market WebSockets — the terminal connects straight to Delta's socket. This benchmark mirrors that path.

### 2. NSE — Worker vs Yahoo Finance

| Column | Meaning |
|--------|---------|
| **Worker Price** | `GET /api/ticker?symbol=NSE:NIFTY` on your Worker (Yahoo-backed, same as production) |
| **Yahoo Price** | Direct Yahoo Finance chart API (the upstream source) |
| **Drift** | `|worker − yahoo|` — should be 0 (Worker mirrors Yahoo) |
| **Latency** | Arrival gap between the two REST responses |

NSE has no public exchange WebSocket in this stack — REST comparison is the meaningful check.

### 3. Turso round-trip

Each cycle also times `GET /api/alerts` on your Worker. That route calls `store.reload()` → Turso HTTP pipeline, isolating **Worker + database** latency from market data.

Printed every 6th cycle (and the first) to avoid clutter.

### 4. Telegram (manual)

At the end you'll see a template for timing alert → Telegram delivery. Trigger an alert on the live site and fill in the seconds by hand.

## Interpreting results

| Metric | Good | Concerning | Bad |
|--------|------|------------|-----|
| BTC drift | **< 1 USD** | 1–10 USD | > 10 USD (stale feed) |
| BTC WS lead | any positive `+ms` | near 0 | negative (REST ahead — investigate) |
| NSE drift | **0** | > 0 | persistent gap |
| NSE latency | < 1000 ms | 1–3 s | > 3 s (Yahoo throttle) |
| Turso RTT (median) | **< 400 ms** | 400–1500 ms | > 1500 ms |

Summaries report **median + p90** alongside avg/min/max, so one cold-start or
one Yahoo rate-limit spike no longer skews the headline number (a Worker
warm-up call is also made before the loop for the same reason).

**WS Age** is intentionally *not* a pass/fail metric — it's large whenever the
market is quiet (no new ticks because the price hasn't changed), which is normal.

## Finding the WebSocket URL

1. Open your site in Chrome
2. **F12** → **Network** → filter **WS**
3. Reload — you'll see `wss://socket.india.delta.exchange`

Override with `DELTA_WS_URL` if Delta changes endpoints.

## Files

| File | Purpose |
|------|---------|
| `latency-check.js` | Main 2-minute benchmark loop |
| `package.json` | Only dependency: `ws` |
| `.env.example` | Optional URL/symbol overrides |
