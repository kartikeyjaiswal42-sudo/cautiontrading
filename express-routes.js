function mountExpressRoutes(app, c) {
  const {
    store, engineTick, sseClients, ssePush, runtimeState, fetchJson, getSymbols,
    getCandlesAny, validateAlert, alertFromBody, describeAlert, sendTelegram,
    indicatorMeta, OPS, india, INDICATORS, computeSeries, CHECK_INTERVAL_MS, DELTA_BASE,
    obCache, trCache, tkCache, prodCache, barsNeeded, evaluateAlert,
  } = c;

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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/api/meta", (req, res) => {
  res.json({
    indicators: indicatorMeta(),
    ops: OPS,
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"],
    nseResolutions: india.RESOLUTIONS,
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
  });
});

app.get("/api/symbols", async (req, res) => {
  try {
    const delta = (await getSymbols()).map(x => ({ ...x, src: "delta" }));
    res.json({ ok: true, symbols: [...delta, ...india.listSymbols()] });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get("/api/tickers", async (req, res) => {
  try {
    if (Date.now() - c.tickerCache.at > 10000) {
      const data = await fetchJson(`${DELTA_BASE}/v2/tickers`);
      if (data.success) {
        c.tickerCache = {
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
    res.json({ ok: true, tickers: c.tickerCache.list });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get("/api/orderbook", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  if (india.isIndia(symbol)) return res.json({ ok: false, unsupported: true });
  try {
    const hit = obCache.get(symbol);
    if (hit && Date.now() - hit.at < 1200) return res.json(hit.payload);
    const d = await fetchJson(`${DELTA_BASE}/v2/l2orderbook/${encodeURIComponent(symbol)}?depth=12`);
    const payload = {
      ok: true,
      buy: (d.result.buy || []).map(l => ({ price: +l.price, size: +l.size })),
      sell: (d.result.sell || []).map(l => ({ price: +l.price, size: +l.size })),
    };
    obCache.set(symbol, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/recent-trades", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  if (india.isIndia(symbol)) return res.json({ ok: false, unsupported: true });
  try {
    const hit = trCache.get(symbol);
    if (hit && Date.now() - hit.at < 1500) return res.json(hit.payload);
    const d = await fetchJson(`${DELTA_BASE}/v2/trades/${encodeURIComponent(symbol)}`);
    const payload = {
      ok: true,
      trades: (d.result || []).slice(0, 30).map(t => ({
        price: +t.price,
        size: +t.size,
        time: Math.floor(t.timestamp / 1000), // µs → ms
        side: t.seller_role === "taker" ? "sell" : "buy",
      })),
    };
    trCache.set(symbol, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/ticker", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  try {
    const hit = tkCache.get(symbol);
    if (hit && Date.now() - hit.at < 3000) return res.json(hit.payload);
    let payload;
    if (india.isIndia(symbol)) {
      const q = await india.getQuote(symbol);
      payload = { ok: true, src: "nse", ...q };
    } else {
      const d = await fetchJson(`${DELTA_BASE}/v2/tickers/${encodeURIComponent(symbol)}`);
      const t = d.result;
      payload = {
        ok: true,
        src: "delta",
        price: +t.close,
        changePct: t.open ? ((+t.close - +t.open) / +t.open) * 100 : null,
        high: +t.high, low: +t.low,
        turnoverUsd: +t.turnover_usd || null,
        oi: t.oi !== undefined ? +t.oi : null,
        fundingRate: t.funding_rate !== undefined ? +t.funding_rate * 100 : null,
        indexPrice: t.spot_price !== undefined ? +t.spot_price : null,
        markPrice: t.mark_price !== undefined ? +t.mark_price : null,
      };
    }
    tkCache.set(symbol, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/product", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  if (india.isIndia(symbol)) return res.json({ ok: false, unsupported: true });
  try {
    const hit = prodCache.get(symbol);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json(hit.payload);
    const d = await fetchJson(`${DELTA_BASE}/v2/products/${encodeURIComponent(symbol)}`);
    const p = d.result;
    const payload = {
      ok: true,
      product: {
        symbol: p.symbol,
        description: p.description || p.short_description || "",
        type: p.contract_type || "",
        contractValue: p.contract_value,
        contractUnit: p.contract_unit_currency,
        tickSize: p.tick_size,
        makerFee: p.maker_commission_rate,
        takerFee: p.taker_commission_rate,
        initialMargin: p.initial_margin,
        maintenanceMargin: p.maintenance_margin,
        maxLeverageNotional: p.max_leverage_notional,
        fundingMethod: p.funding_method,
        settlingAsset: p.settling_asset && p.settling_asset.symbol,
        quotingAsset: p.quoting_asset && p.quoting_asset.symbol,
        underlying: p.underlying_asset && p.underlying_asset.symbol,
        launchTime: p.launch_time,
        settlementTime: p.settlement_time,
      },
    };
    prodCache.set(symbol, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/india-search", async (req, res) => {
  try {
    res.json({ ok: true, results: await india.search(String(req.query.q || "")) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

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
    const candles = await getCandlesAny(symbol, resolution, bars);
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

app.post("/api/preview", async (req, res) => {
  try {
    const body = req.body;
    const err = validateAlert(body);
    if (err) return res.json({ ok: false, error: err });
    const fake = alertFromBody(body);
    const candles = await getCandlesAny(fake.symbol, fake.resolution, barsNeeded(fake));
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
}
module.exports = mountExpressRoutes;
