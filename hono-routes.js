async function readBody(c) {
  try { return await c.req.json(); } catch { return {}; }
}

function mountHonoRoutes(hono, core) {
  const {
    store, engineTick, sseClients, ssePush, runtimeState, fetchJson, getSymbols,
    getCandlesAny, validateAlert, alertFromBody, describeAlert, sendTelegram,
    indicatorMeta, OPS, india, INDICATORS, computeSeries, CHECK_INTERVAL_MS, DELTA_BASE,
    obCache, trCache, tkCache, prodCache, barsNeeded, evaluateAlert,
  } = core;

hono.get("/api/stream", (c) => {
  return c.newResponse(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const writer = { write: (msg) => controller.enqueue(enc.encode(msg)) };
        sseClients.add(writer);
        controller.enqueue(enc.encode("retry: 3000\n\n"));
        const ping = setInterval(() => {
          try { controller.enqueue(enc.encode(": ping\n\n")); } catch {}
        }, 25000);
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(ping);
          sseClients.delete(writer);
          try { controller.close(); } catch {}
        });
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
});

hono.get("/api/health", (c) => {
  return c.json({ ok: true, ts: Date.now() });
});

hono.get("/api/meta", (c) => {
  return c.json({
    indicators: indicatorMeta(),
    ops: OPS,
    resolutions: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"],
    nseResolutions: india.RESOLUTIONS,
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
  });
});

hono.get("/api/symbols", async (c) => {
  try {
    const delta = (await getSymbols()).map(x => ({ ...x, src: "delta" }));
    return c.json({ ok: true, symbols: [...delta, ...india.listSymbols()] });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

hono.get("/api/tickers", async (c) => {
  try {
    if (Date.now() - core.tickerCache.at > 10000) {
      const data = await fetchJson(`${DELTA_BASE}/v2/tickers`);
      if (data.success) {
        core.tickerCache = {
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
    return c.json({ ok: true, tickers: core.tickerCache.list });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

hono.get("/api/orderbook", async (c) => {
  const symbol = String(c.req.query('symbol') || "");
  if (india.isIndia(symbol)) return c.json({ ok: false, unsupported: true });
  try {
    const hit = obCache.get(symbol);
    if (hit && Date.now() - hit.at < 1200) return c.json(hit.payload);
    const d = await fetchJson(`${DELTA_BASE}/v2/l2orderbook/${encodeURIComponent(symbol)}?depth=12`);
    const payload = {
      ok: true,
      buy: (d.result.buy || []).map(l => ({ price: +l.price, size: +l.size })),
      sell: (d.result.sell || []).map(l => ({ price: +l.price, size: +l.size })),
    };
    obCache.set(symbol, { at: Date.now(), payload });
    return c.json(payload);
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.get("/api/recent-trades", async (c) => {
  const symbol = String(c.req.query('symbol') || "");
  if (india.isIndia(symbol)) return c.json({ ok: false, unsupported: true });
  try {
    const hit = trCache.get(symbol);
    if (hit && Date.now() - hit.at < 1500) return c.json(hit.payload);
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
    return c.json(payload);
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.get("/api/ticker", async (c) => {
  const symbol = String(c.req.query('symbol') || "");
  try {
    const hit = tkCache.get(symbol);
    if (hit && Date.now() - hit.at < 3000) return c.json(hit.payload);
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
    return c.json(payload);
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.get("/api/product", async (c) => {
  const symbol = String(c.req.query('symbol') || "");
  if (india.isIndia(symbol)) return c.json({ ok: false, unsupported: true });
  try {
    const hit = prodCache.get(symbol);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return c.json(hit.payload);
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
    return c.json(payload);
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.get("/api/india-search", async (c) => {
  try {
    return c.json({ ok: true, results: await india.search(String(c.req.query('q') || "")) });
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.post("/api/series", async (c) => {
  try {
    const body = await readBody(c);
    const { symbol, resolution, specs } = body;
    if (!symbol || !resolution) return c.json({ ok: false, error: "symbol/resolution required" });
    let bars = Math.min(Number(body.bars) || 300, 1500);
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
    return c.json({ ok: true, candles, series });
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.get("/api/alerts", async (c) => {
  await store.reload();
  const s = store.load();
  const now = Date.now();
  const alerts = await Promise.all(s.alerts.map(async (a) => {
    let runtime = runtimeState.get(a.id) || {};
    if (a.enabled && a.status === "active" && !runtime.lastChecked) {
      try {
        const candles = await getCandlesAny(a.symbol, a.resolution, barsNeeded(a));
        const st = {};
        const r = evaluateAlert({ ...a, trigger: "every" }, candles, st, now);
        runtime = {
          lastChecked: now,
          leftValue: r.leftValue,
          rightValue: r.rightValue,
          lastPrice: candles.length ? candles[candles.length - 1].close : null,
          lastError: r.reason === "indicator warming up" ? null : (r.reason || null),
        };
      } catch (e) {
        runtime = { lastError: e.message, lastChecked: now };
      }
    }
    return { ...a, runtime };
  }));
  return c.json({ ok: true, alerts });
});

hono.post("/api/alerts", async (c) => {
  const body = await readBody(c);
  const err = validateAlert(body);
  if (err) return c.json({ ok: false, error: err }, 400);
  const s = store.load();
  const alert = alertFromBody(body);
  s.alerts.push(alert);
  await store.save();
  engineTick(); // evaluate immediately
  return c.json({ ok: true, alert });
});

hono.put("/api/alerts/:id", async (c) => {
  const body = await readBody(c);
  const s = store.load();
  const idx = s.alerts.findIndex(a => a.id === c.req.param('id'));
  if (idx === -1) return c.json({ ok: false, error: "Alert not found" }, 404);
  const err = validateAlert(body);
  if (err) return c.json({ ok: false, error: err }, 400);
  const updated = alertFromBody(body, s.alerts[idx]);
  s.alerts[idx] = updated;
  runtimeState.delete(updated.id); // reset edge state after edit
  await store.save();
  engineTick();
  return c.json({ ok: true, alert: updated });
});

hono.post("/api/alerts/:id/toggle", async (c) => {
  const s = store.load();
  const a = s.alerts.find(x => x.id === c.req.param('id'));
  if (!a) return c.json({ ok: false, error: "Alert not found" }, 404);
  a.enabled = !a.enabled;
  if (a.enabled) {
    a.status = "active"; // re-arming a fired/expired alert reactivates it
    runtimeState.delete(a.id);
  }
  await store.save();
  if (a.enabled) engineTick();
  return c.json({ ok: true, alert: a });
});

hono.delete("/api/alerts/:id", async (c) => {
  const s = store.load();
  const idx = s.alerts.findIndex(a => a.id === c.req.param('id'));
  if (idx === -1) return c.json({ ok: false, error: "Alert not found" }, 404);
  s.alerts.splice(idx, 1);
  runtimeState.delete(c.req.param('id'));
  await store.save();
  return c.json({ ok: true });
});

hono.get("/api/fired", async (c) => {
  await store.reload();
  return c.json({ ok: true, fired: store.load().fired.slice(0, 100) });
});

hono.get("/api/settings", async (c) => {
  await store.reload();
  const { settings } = store.load();
  return c.json({
    ok: true,
    settings: {
      telegramChatId: settings.telegramChatId,
      telegramConfigured: !!(settings.telegramToken && settings.telegramChatId),
      telegramTokenMasked: settings.telegramToken ? settings.telegramToken.slice(0, 6) + "•••" : "",
      soundEnabled: settings.soundEnabled,
    },
  });
});

hono.post("/api/settings", async (c) => {
  const body = await readBody(c);
  const s = store.load();
  if (typeof body.telegramToken === "string" && body.telegramToken !== "") {
    s.settings.telegramToken = body.telegramToken.trim();
  }
  if (body.telegramToken === null) s.settings.telegramToken = "";
  if (typeof body.telegramChatId === "string") s.settings.telegramChatId = body.telegramChatId.trim();
  if (typeof body.soundEnabled === "boolean") s.settings.soundEnabled = body.soundEnabled;
  await store.save();
  return c.json({ ok: true });
});

hono.get("/api/telegram/detect-chat", async (c) => {
  const { settings } = store.load();
  if (!settings.telegramToken) return c.json({ ok: false, error: "Save the bot token first" });
  try {
    const data = await (await fetch(`https://api.telegram.org/bot${settings.telegramToken}/getUpdates`)).json();
    if (!data.ok) return c.json({ ok: false, error: data.description || "Bad token" });
    const msgs = (data.result || []).filter(u => u.message && u.message.chat);
    if (!msgs.length) {
      return c.json({ ok: false, error: "No message found. Open Telegram, send any message (e.g. 'hi') to your bot, then try again." });
    }
    const chat = msgs[msgs.length - 1].message.chat;
    const s = store.load();
    s.settings.telegramChatId = String(chat.id);
    await store.save();
    return c.json({ ok: true, chatId: String(chat.id), name: chat.first_name || chat.title || "" });
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

hono.post("/api/telegram/test", async (c) => {
  const r = await sendTelegram("✅ CautionTrading test message — Telegram alerts are working!");
  return c.json(r);
});

hono.post("/api/preview", async (c) => {
  try {
    const body = await readBody(c);
    const err = validateAlert(body);
    if (err) return c.json({ ok: false, error: err });
    const fake = alertFromBody(body);
    const candles = await getCandlesAny(fake.symbol, fake.resolution, barsNeeded(fake));
    const st = {};
    const r = evaluateAlert({ ...fake, trigger: "every" }, candles, st, Date.now());
    return c.json({
      ok: true,
      leftValue: Number.isNaN(r.leftValue) ? null : r.leftValue,
      rightValue: Number.isNaN(r.rightValue) ? null : r.rightValue,
      price: candles.length ? candles[candles.length - 1].close : null,
      condition: describeAlert(fake),
    });
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});
}
module.exports = mountHonoRoutes;
