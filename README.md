# CautionTrading 🔔

Live technical-indicator alerts for **Delta Exchange India** (futures + options).
Pick any of the 1,100+ symbols, build a condition like *"RSI(14) on 5m crossing above 70"*,
and the moment it happens you get:

- a **full-screen flashing alarm + loud siren** in the browser, and
- an **instant Telegram message on the phone** (free, no app to install beyond Telegram).

Conditions are checked **every 1 second** against live exchange data.

The site is a full trading terminal: a live TradingView-style candlestick chart
(with volume, crosshair, and your indicators plotted on it), a symbol browser
with live prices for every Delta product, and the alerts panel — so the client
watches everything here and only opens Delta to execute the trade.

---

## How to start it

```bash
cd cautiontrading
npm install        # first time only
npm start          # then open http://localhost:8899
```

Or just double-click **`Start CautionTrading.command`**.

Keep the terminal window open — that's the engine doing the watching.
The browser tab can be on any device on the same Wi-Fi
(`http://<your-mac-ip>:8899`), and Telegram alerts reach the phone anywhere.

## Creating an alert

1. Click **+ New Alert**
2. Type the symbol (e.g. `BTCUSD`) — the list searches all Delta products
3. Pick interval (1m / 5m / 15m / 1h …)
4. Build the condition:
   - **Watch**: Price or any of 24 indicators (RSI, EMA, SMA, MACD, Bollinger,
     Supertrend, Stochastic, ADX, VWAP, Ichimoku, ATR, CCI, MFI, PSAR …)
   - **Is**: Crossing Up / Crossing Down / Crossing / Greater Than / Less Than
   - **Compared to**: a fixed value (e.g. 70) **or another indicator**
     (e.g. EMA(9) crossing EMA(21), Price crossing VWAP)
5. The green **live preview** shows the current values so you know it's wired right
6. Choose trigger: *Only once*, *Once per bar close*, or *Every time*
7. Tick **Telegram** if you want it on the phone, then Save

## Telegram setup (one time, ~2 minutes)

1. In Telegram, search **@BotFather** → send `/newbot` → it gives you a **token**
2. In CautionTrading → ⚙️ Settings → paste the token → **Save**
3. Send any message ("hi") to your new bot in Telegram
4. Click **Detect my chat** → then **Send test message**

## Important notes

- Click **"🔇 Enable sound"** once after opening the page — browsers block
  audio until you interact. It also asks for desktop-notification permission.
- *Only once* alerts stop after firing; flip their toggle to re-arm them.
- Data source: Delta Exchange public candles API (the same exchange the trades
  happen on, so values match the trading screen). Symbols like USOIL that are
  TradingView-only are not available — use the Delta equivalent.
- Everything is saved in `data/store.json` — back that file up to keep alerts.

## Architecture (for future work)

| File | Role |
|---|---|
| `server.js` | Express API + 1s engine loop + SSE push + Telegram |
| `indicators.js` | 25 indicator implementations + registry that auto-builds the UI form |
| `engine.js` | condition evaluation (crossings, edge-triggered >/<, trigger modes) |
| `store.js` | JSON persistence (alerts, settings, fired log) |
| `public/` | single-page UI |

To run it 24/7 in the cloud later (so the Mac doesn't need to stay on),
deploy this folder to Render/Railway — it's a plain Node app, no database needed.
