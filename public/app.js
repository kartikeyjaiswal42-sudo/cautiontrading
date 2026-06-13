// CautionTrading — frontend: Delta-style terminal (chart + order book + trades + alerts)
/* global EventSource, LightweightCharts */

const $ = (id) => document.getElementById(id);

let META = null;
let SYMBOLS = [];
let TICKERS = new Map();
let ALERTS = [];
let editingId = null;

const chartCfg = {
  symbol: "BTCUSD",
  resolution: "5m",
  spec: null,
  target: null,
  specKey: "",
};

// Layout (symbol / interval / chart type) survives reloads like TradingView's Save
let layout = {};
try { layout = JSON.parse(localStorage.getItem("ct_layout_v1")) || {}; } catch { /* fresh */ }
if (typeof layout.symbol === "string") chartCfg.symbol = layout.symbol;
if (typeof layout.resolution === "string") chartCfg.resolution = layout.resolution;
let chartType = layout.chartType || "candles"; // candles|bars|line|area|baseline|heikin
let priceMode = "traded"; // traded | mark | funding | depth (Delta tabs)
let chartBars = 300; // raised by the bottom range presets
function saveLayout() {
  localStorage.setItem("ct_layout_v1", JSON.stringify({
    symbol: chartCfg.symbol, resolution: chartCfg.resolution, chartType,
  }));
}

const RES_SEC = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800 };

// Chart "studies" — indicators added via the ƒ Indicators button (like Delta's chart),
// independent of alerts. Persisted locally; defaults seeded in boot().
let studies = [];
try { studies = JSON.parse(localStorage.getItem("ct_studies_v1")) || []; } catch { /* fresh */ }
const STUDY_COLORS = ["#5b9cf6", "#f7a600", "#e91e63", "#26c6da", "#ab47bc", "#9ccc65"];

const isNse = (s) => typeof s === "string" && s.startsWith("NSE:");
const dispSym = (s) => isNse(s) ? s.slice(4) + " · NSE" : s;

const IND_GROUPS = [
  ["Price & Volume", ["price", "volume"]],
  ["Trend", ["sma", "ema", "wma", "hma", "supertrend", "psar", "ichimoku", "adx"]],
  ["Momentum", ["rsi", "macd", "stoch", "stochrsi", "cci", "willr", "mfi", "roc", "mom"]],
  ["Volatility", ["bb", "atr", "keltner", "donchian"]],
  ["Volume-based", ["obv", "vwap"]],
];
const OVERLAY = new Set(["price", "sma", "ema", "wma", "hma", "vwap", "bb", "supertrend", "psar", "ichimoku", "keltner", "donchian"]);
const LINE_COLORS = ["#f7a600", "#5b9cf6", "#e91e63", "#26c6da", "#ab47bc"];

async function api(path, opts) {
  const res = await fetch(path, opts ? { headers: { "Content-Type": "application/json" }, ...opts } : undefined);
  return res.json();
}

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 10000) return v.toLocaleString("en-IN", { maximumFractionDigits: 1 });
  return a >= 1000 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(4);
}
function fmtBig(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ==================== CHART ====================

// lightweight-charts renders UNIX times as UTC — shift so the axis shows local (IST) time
const TZ_OFF = -new Date().getTimezoneOffset() * 60;

let chart, candleSeries, volumeSeries;
let indSeriesList = [];
let targetLine = null;
let lastCandles = [];
let lastSeriesData = [];          // raw indicator series aligned to lastCandles (for Bar Replay)
let replayMode = false;           // when true the chart is frozen at replayIdx
let replayIdx = 0;                // index into lastCandles currently shown
let replayTimer = null;           // auto-advance interval id
let replaySpeed = 1000;           // ms per bar while playing

function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "#11151c" },
      textColor: "#7c8597",
      panes: { separatorColor: "#262d3a", enableResize: true },
    },
    grid: {
      vertLines: { color: "rgba(38,45,58,.5)" },
      horzLines: { color: "rgba(38,45,58,.5)" },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#262d3a" },
    timeScale: { borderColor: "#262d3a", timeVisible: true, secondsVisible: false, rightOffset: 4 },
    localization: { locale: "en-IN" },
  });
  createMainSeries();
  volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceScaleId: "vol",
    priceFormat: { type: "volume" },
    lastValueVisible: false, priceLineVisible: false,
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  chart.subscribeCrosshairMove(updateLegendFromCrosshair);
}

// Main series varies with the chart-type switcher (TradingView toolbar)
const LINE_TYPES = new Set(["line", "area", "baseline"]);
function createMainSeries() {
  if (candleSeries) { try { chart.removeSeries(candleSeries); } catch {} }
  const L = LightweightCharts;
  if (chartType === "bars") {
    candleSeries = chart.addSeries(L.BarSeries, { upColor: "#26a69a", downColor: "#ef5350", thinBars: false }, 0);
  } else if (chartType === "line") {
    candleSeries = chart.addSeries(L.LineSeries, { color: "#2962ff", lineWidth: 2 }, 0);
  } else if (chartType === "area") {
    candleSeries = chart.addSeries(L.AreaSeries, {
      lineColor: "#2962ff", lineWidth: 2,
      topColor: "rgba(41,98,255,.32)", bottomColor: "rgba(41,98,255,.02)",
    }, 0);
  } else if (chartType === "baseline") {
    candleSeries = chart.addSeries(L.BaselineSeries, {
      topLineColor: "#26a69a", bottomLineColor: "#ef5350",
      topFillColor1: "rgba(38,166,154,.25)", topFillColor2: "rgba(38,166,154,.03)",
      bottomFillColor1: "rgba(239,83,80,.03)", bottomFillColor2: "rgba(239,83,80,.25)",
    }, 0);
  } else { // candles + heikin ashi
    candleSeries = chart.addSeries(L.CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      borderVisible: false,
    }, 0);
  }
}

function toHeikin(cs) {
  const out = [];
  let prevO = null, prevC = null;
  for (const c of cs) {
    const hc = (c.open + c.high + c.low + c.close) / 4;
    const ho = prevO === null ? (c.open + c.close) / 2 : (prevO + prevC) / 2;
    out.push({ time: c.time, open: ho, high: Math.max(c.high, ho, hc), low: Math.min(c.low, ho, hc), close: hc, volume: c.volume });
    prevO = ho; prevC = hc;
  }
  return out;
}

function setMainData(cs) {
  const arr = chartType === "heikin" ? toHeikin(cs) : cs;
  candleSeries.setData(arr.map(c => LINE_TYPES.has(chartType)
    ? { time: c.time + TZ_OFF, value: c.close }
    : { time: c.time + TZ_OFF, open: c.open, high: c.high, low: c.low, close: c.close }));
}

// /api/series symbol for the active Delta price-mode tab
function seriesSymbol() {
  if (isNse(chartCfg.symbol)) return chartCfg.symbol;
  if (priceMode === "mark") return "MARK:" + chartCfg.symbol;
  if (priceMode === "funding") return "FUNDING:" + chartCfg.symbol;
  return chartCfg.symbol;
}

function expandSpec(spec) {
  const def = META.indicators[spec.type];
  if (!def) return [];
  if (!def.outputs) return [{ ...spec, output: null }];
  return def.outputs
    .filter(o => o.name !== "direction")
    .map(o => ({ ...spec, output: o.name }));
}

// All series to plot: every study + (if set) the alert-linked spec.
// _study index / _alert flag drive pane assignment and colors.
function chartSpecs() {
  const out = [];
  studies.forEach((st, i) => { for (const sp of expandSpec(st)) out.push({ ...sp, _study: i }); });
  if (chartCfg.spec) for (const sp of expandSpec(chartCfg.spec)) out.push({ ...sp, _alert: true });
  return out;
}

function rebuildIndicatorSeries() {
  for (const s of indSeriesList) { try { chart.removeSeries(s.series); } catch {} }
  indSeriesList = [];
  if (targetLine) { try { (targetLine._host || candleSeries).removePriceLine(targetLine); } catch {} targetLine = null; }

  const specs = chartSpecs();
  const paneOf = new Map(); // overlay indicators share pane 0; each oscillator gets its own pane
  let nextPane = 1;
  const outIdx = new Map();
  for (const sp of specs) {
    const group = sp._alert ? "alert" : "s" + sp._study;
    let pane = 0;
    if (!OVERLAY.has(sp.type)) {
      if (!paneOf.has(group)) paneOf.set(group, nextPane++);
      pane = paneOf.get(group);
    }
    const oi = outIdx.get(group) || 0;
    outIdx.set(group, oi + 1);
    const color = sp._alert
      ? LINE_COLORS[oi % LINE_COLORS.length]
      : STUDY_COLORS[(sp._study + oi) % STUDY_COLORS.length];
    const isHist = sp.output === "hist";
    const series = isHist
      ? chart.addSeries(LightweightCharts.HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, pane)
      : chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth: 2, lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
        }, pane);
    indSeriesList.push({ series, spec: sp, isHist });
  }
  try {
    chart.panes().forEach((p, i) => { if (i > 0 && p.setHeight) p.setHeight(130); });
  } catch {}

  if (chartCfg.target !== null && Number.isFinite(chartCfg.target)) {
    let host = candleSeries;
    if (chartCfg.spec && !OVERLAY.has(chartCfg.spec.type) && chartCfg.spec.type !== "price") {
      const ah = indSeriesList.find(h => h.spec._alert);
      if (ah) host = ah.series;
    }
    targetLine = host.createPriceLine({
      price: chartCfg.target, color: "#f7a600", lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "alert",
    });
    targetLine._host = host;
  }
}

// Generation counter: bumped on every setChart so a slow in-flight response for
// the OLD symbol (Yahoo/NSE can take seconds) can't paint over the new one.
let chartGen = 0;
let chartBusy = false;
let chartPending = false;
async function refreshChart() {
  if (!chart) return;
  if (replayMode) return; // replay freezes the chart at the chosen bar — no live refetch
  if (chartBusy) { chartPending = true; return; }
  chartBusy = true;
  const gen = chartGen;
  try {
    const specs = chartSpecs();
    const d = await api("/api/series", {
      method: "POST",
      body: JSON.stringify({
        symbol: seriesSymbol(), resolution: chartCfg.resolution, bars: chartBars,
        specs: specs.map(s => ({ type: s.type, params: s.params, source: s.source, output: s.output })),
      }),
    });
    if (gen !== chartGen) return; // stale — chart was switched while this was in flight
    if (!d.ok) { setLegend(`⚠ ${esc(d.error)}`); return; }
    lastCandles = d.candles;
    lastSeriesData = d.series || []; // kept so Bar Replay can slice indicators without recompute
    setMainData(d.candles);
    volumeSeries.setData(d.candles.map(c => ({
      time: c.time + TZ_OFF, value: c.volume,
      color: c.close >= c.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
    })));
    specs.forEach((sp, i) => {
      const holder = indSeriesList[i];
      if (!holder) return;
      const vals = d.series[i] || [];
      const pts = [];
      for (let j = 0; j < d.candles.length; j++) {
        const v = vals[j];
        if (v === null || v === undefined) continue;
        pts.push(holder.isHist
          ? { time: d.candles[j].time + TZ_OFF, value: v, color: v >= 0 ? "rgba(38,166,154,.55)" : "rgba(239,83,80,.55)" }
          : { time: d.candles[j].time + TZ_OFF, value: v });
      }
      holder.series.setData(pts);
    });
    // the websocket may have a fresher tick than the (cached) REST response
    if (wsCandle && priceMode === "traded") applyLiveCandle(wsCandle);
    setLegendDefault();
    refreshCompare(gen);
  } catch (e) {
    if (gen === chartGen) setLegend(`⚠ chart: ${esc(e.message)}`);
  } finally {
    chartBusy = false;
    if (chartPending) { chartPending = false; refreshChart(); }
  }
}

function setChart(symbol, resolution, spec, target) {
  // Indian symbols support a reduced interval set
  if (isNse(symbol) && !META.nseResolutions.includes(resolution)) resolution = "5m";
  const newKey = JSON.stringify([symbol, resolution, spec, target]);
  if (newKey === chartCfg.specKey) return;
  cancelReplay();
  const symbolChanged = symbol !== chartCfg.symbol || resolution !== chartCfg.resolution;
  chartCfg.symbol = symbol;
  chartCfg.resolution = resolution;
  chartCfg.spec = spec || null;
  chartCfg.target = (target === undefined || target === null) ? null : Number(target);
  chartCfg.specKey = newKey;

  $("sb-name").textContent = dispSym(symbol);
  renderIntervalPills();
  $("src-note").textContent = isNse(symbol)
    ? "NSE spot via Yahoo Finance — may lag ~1 min · option-strike data needs broker API"
    : "Delta Exchange · live";
  if (isNse(symbol) && priceMode !== "traded") setPriceMode("traded");
  syncModeTabs();
  saveLayout();
  syncSidePanels();
  chartGen++; // invalidate any in-flight response for the previous symbol/spec
  dwsSync(); // re-point the realtime websocket at the new symbol/interval
  if (symbolChanged) {
    // blank stale data immediately — old symbol's numbers must never show under the new name
    lastCandles = [];
    candleSeries.setData([]);
    volumeSeries.setData([]);
    setLegend(`<b>${esc(dispSym(symbol))}</b> · ${chartCfg.resolution} loading…`);
    $("ob-sells").innerHTML = ""; $("ob-buys").innerHTML = "";
    $("ob-mid").textContent = "—"; $("trades").innerHTML = "";
    $("q-price").textContent = "—"; $("stats").innerHTML = "";
    $("bb-box").classList.add("hidden");
    refreshOrderbook();
    refreshTrades();
  }
  rebuildIndicatorSeries();
  refreshChart().then(() => { if (symbolChanged) chart.timeScale().scrollToRealTime(); });
  refreshTicker();
  if (symbolChanged) {
    obGroupSym = null; // regroup options for the new symbol's tick size
    renderWatchlist();
    refreshDetailPane();
  }
}

function renderIntervalPills() {
  const list = isNse(chartCfg.symbol) ? META.nseResolutions : META.resolutions;
  $("interval-pills").innerHTML = list
    .map(r => `<button class="pill ${r === chartCfg.resolution ? "active" : ""}" data-res="${r}">${r}</button>`).join("");
  document.querySelectorAll("#interval-pills .pill").forEach(p => {
    p.addEventListener("click", () => {
      chartBars = 300;
      document.querySelectorAll("#range-pills .rpill").forEach(r => r.classList.remove("active"));
      setChart(chartCfg.symbol, p.dataset.res, chartCfg.spec, chartCfg.target);
    });
  });
}

function setLegend(html) { $("legend").innerHTML = html; }

function describeOperandUI(operand) {
  if (!operand) return "?";
  if (operand.kind === "value") return fmt(Number(operand.value));
  const spec = operand.kind === "indicator"
    ? (operand.spec || (operand.type ? operand : null))
    : operand;
  if (!spec || !spec.type) return "?";
  const def = META.indicators[spec.type];
  if (!def) return spec.type;
  const base = def.label.split(" (")[0];
  const params = def.params.map(p => (spec.params && spec.params[p.name]) ?? p.def).join(",");
  const out = spec.output && def.outputs ? ` ${spec.output}` : "";
  return params ? `${base}(${params})${out}` : `${base}${out}`;
}

function legendLine(c) {
  return `<b>${esc(dispSym(chartCfg.symbol))}</b> · ${chartCfg.resolution} ` +
    `<span class="lg-dim">O</span> ${fmt(c.open)} <span class="lg-dim">H</span> ${fmt(c.high)} ` +
    `<span class="lg-dim">L</span> ${fmt(c.low)} <span class="lg-dim">C</span> <b class="${c.close >= c.open ? "up" : "down"}">${fmt(c.close)}</b>`;
}

function setLegendDefault() {
  const last = lastCandles[lastCandles.length - 1];
  if (!last) return;
  let html = legendLine(last);
  if (chartCfg.spec) {
    html += `<br><span class="lg-ind">${esc(describeOperandUI(chartCfg.spec))}</span>`;
    if (chartCfg.target !== null) html += ` <span class="lg-dim">· alert at ${fmt(chartCfg.target)}</span>`;
  }
  setLegend(html);
}

let crosshairActive = false; // live ticks must not overwrite the crosshair readout

function updateLegendFromCrosshair(param) {
  if (!param || !param.time || !param.seriesData) { crosshairActive = false; setLegendDefault(); return; }
  let c = param.seriesData.get(candleSeries);
  if (!c) { crosshairActive = false; setLegendDefault(); return; }
  // line/area chart types give {value} — look the full candle up by time
  if (c.open === undefined) c = lastCandles.find(x => x.time + TZ_OFF === param.time) || { open: c.value, high: c.value, low: c.value, close: c.value };
  crosshairActive = true;
  let html = legendLine(c);
  const parts = [];
  for (const h of indSeriesList) {
    const v = param.seriesData.get(h.series);
    if (v && v.value !== undefined) parts.push(`${describeOperandUI(h.spec)} ${fmt(v.value)}`);
  }
  if (parts.length) html += `<br><span class="lg-ind">${esc(parts.join(" · "))}</span>`;
  setLegend(html);
}

// ==================== STATS STRIP + TICKER ====================

function renderTicker(d) {
  const up = (d.changePct || 0) >= 0;
  $("q-price").innerHTML = `<span class="${up ? "up" : "down"}">${fmt(d.price)} ${up ? "↑" : "↓"}</span>`;
  const stat = (k, v, cls = "") => `<div class="stat"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  let html = stat("24h Change", `${d.changePct === null ? "—" : (up ? "+" : "") + d.changePct.toFixed(2) + "%"}`, up ? "up" : "down");
  if (d.src === "delta") {
    html += stat("Index Price", fmt(d.indexPrice));
    html += stat("24h High", fmt(d.high));
    html += stat("24h Low", fmt(d.low));
    html += stat("24h Vol.", d.turnoverUsd ? "$" + fmtBig(d.turnoverUsd) : "—");
    html += stat("OI", d.oi !== null ? fmtBig(d.oi) : "—");
    if (d.fundingRate !== null) {
      // funding pays every 8h (00:00 / 08:00 / 16:00 UTC) — countdown ticks via fundCountdown()
      html += stat("Funding / Countdown", `${d.fundingRate.toFixed(4)}% · <span id="fund-cd">—</span>`);
    }
  } else {
    html += stat("Day High", fmt(d.high));
    html += stat("Day Low", fmt(d.low));
    html += stat("Volume", fmtBig(d.volume));
    html += stat("Prev Close", fmt(d.prevClose));
  }
  $("stats").innerHTML = html;
  fundCountdown();
}

function fundCountdown() {
  const el = $("fund-cd");
  if (!el) return;
  const now = Date.now();
  const next = Math.ceil(now / 28800000) * 28800000; // next 8h UTC boundary
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const p2 = (n) => String(n).padStart(2, "0");
  el.textContent = `${p2(Math.floor(s / 3600))}h:${p2(Math.floor((s % 3600) / 60))}m:${p2(s % 60)}s`;
}

function updateBuySell(bid, ask) {
  if (isNse(chartCfg.symbol) || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
  $("bb-sell").innerHTML = `<span>SELL</span><b>${fmt(bid)}</b>`;
  $("bb-buy").innerHTML = `<span>BUY</span><b>${fmt(ask)}</b>`;
  $("bb-box").classList.remove("hidden");
}

let tickerSeq = 0;
async function refreshTicker() {
  const sym = chartCfg.symbol;
  // the websocket already streams this in realtime — poll only as fallback
  if (!isNse(sym) && Date.now() - wsFresh.ticker < 6000) return;
  const seq = ++tickerSeq;
  try {
    const d = await api(`/api/ticker?symbol=${encodeURIComponent(sym)}`);
    // drop out-of-order / stale responses (slow Yahoo reply after a symbol switch)
    if (seq !== tickerSeq || sym !== chartCfg.symbol) return;
    if (!d.ok) return;
    if (!isNse(sym) && Date.now() - wsFresh.ticker < 6000) return; // ws took over meanwhile
    renderTicker(d);
  } catch { /* ignore */ }
}

// ==================== ORDER BOOK + TRADES ====================

function syncSidePanels() {
  const nse = isNse(chartCfg.symbol);
  const obTab = sideTab === "ob";
  $("ob-wrap").classList.toggle("hidden", !obTab || nse);
  $("wl-wrap").classList.toggle("hidden", obTab);
  $("side-note").classList.toggle("hidden", !nse || !obTab);
  if (nse) $("bb-box").classList.add("hidden");
  if (nse) {
    $("side-note").innerHTML = `<b>${esc(dispSym(chartCfg.symbol))}</b><br><br>
      Live order book &amp; market depth for NSE need a (free) broker API key —
      Dhan or Upstox. Once added, depth, option chains and strike-level
      prices appear here.<br><br>
      Charts, all 25 indicators and alerts on this symbol are fully live.`;
  }
}

// ---- order book: grouping dropdown + both/bids/asks views + mark price (Delta-style) ----
let obView = "both"; // both | bids | asks
let obGroupSym = null; // symbol the grouping options were built for
let lastOb = null; // last full {buy, sell} so control changes re-render instantly
let wsMark = null; // mark price from the ws ticker

function obGroupVal() {
  const v = parseFloat($("ob-group").value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function buildObGroupOptions(sell) {
  // infer the tick from adjacent ask levels, offer Delta-style multiples
  let tick = Infinity;
  for (let i = 1; i < Math.min(sell.length, 10); i++) {
    const d = Math.abs(sell[i].price - sell[i - 1].price);
    if (d > 1e-12 && d < tick) tick = d;
  }
  if (!Number.isFinite(tick)) tick = Math.max(Math.abs(sell[0] ? sell[0].price : 1) * 1e-5, 1e-8);
  const opts = [0, tick, tick * 2, tick * 5, tick * 10, tick * 25];
  const lbl = (v) => v === 0 ? "—" : (v >= 1 ? +v.toFixed(2) : +v.toPrecision(3)).toString();
  $("ob-group").innerHTML = opts.map((v, i) => `<option value="${v}" ${i === 0 ? "selected" : ""}>${lbl(v)}</option>`).join("");
}

function groupLevels(lvls, g, side) {
  if (!g) return lvls;
  const m = new Map();
  for (const l of lvls) {
    const b = side === "buy" ? Math.floor(l.price / g) * g : Math.ceil(l.price / g) * g;
    m.set(b, (m.get(b) || 0) + l.size);
  }
  const out = [...m.entries()].map(([price, size]) => ({ price, size }));
  out.sort((a, b) => side === "buy" ? b.price - a.price : a.price - b.price);
  return out;
}

function renderOrderbook(buy, sell) {
  lastOb = { buy, sell };
  if (obGroupSym !== chartCfg.symbol && sell.length > 1) {
    obGroupSym = chartCfg.symbol;
    buildObGroupOptions(sell);
  }
  const g = obGroupVal();
  const gBuy = groupLevels(buy, g, "buy");
  const gSell = groupLevels(sell, g, "sell");
  const nRows = obView === "both" ? 8 : 17;
  const render = (lvls, side) => {
    let cum = 0;
    const total = lvls.reduce((s, l) => s + l.size, 0) || 1;
    const rows = lvls.map(l => {
      cum += l.size;
      const w = Math.min(100, (cum / total) * 100);
      return `<div class="ob-row">
        <span class="p-${side}">${fmt(l.price)}</span>
        <span class="r">${fmtBig(l.size)}</span>
        <span class="r">${fmtBig(cum)}</span>
        <div class="depth" style="width:${w}%;background:${side === "buy" ? "#26a69a" : "#ef5350"}"></div>
      </div>`;
    });
    return side === "sell" ? rows.reverse().join("") : rows.join("");
  };
  $("ob-sells").innerHTML = obView === "bids" ? "" : render(gSell.slice(0, nRows), "sell");
  $("ob-buys").innerHTML = obView === "asks" ? "" : render(gBuy.slice(0, nRows), "buy");
  if (buy[0] && sell[0]) {
    const last = lastCandles[lastCandles.length - 1];
    const up = last && last.close >= last.open;
    const mid = last ? last.close : (buy[0].price + sell[0].price) / 2;
    $("ob-mid").innerHTML = `<span class="${up ? "up" : "down"}">${fmt(mid)}</span>` +
      (wsMark !== null ? `<span class="ob-mark">M <b>${fmt(wsMark)}</b></span>` : "");
    updateBuySell(buy[0].price, sell[0].price);
  }
  renderDepth();
}

let obSeq = 0;
async function refreshOrderbook() {
  if (isNse(chartCfg.symbol)) return;
  const sym = chartCfg.symbol;
  if (Date.now() - wsFresh.ob < 6000) return; // websocket is streaming the book
  const seq = ++obSeq;
  try {
    const d = await api(`/api/orderbook?symbol=${encodeURIComponent(sym)}`);
    if (seq !== obSeq || sym !== chartCfg.symbol) return;
    if (!d.ok) return;
    if (Date.now() - wsFresh.ob < 6000) return;
    renderOrderbook(d.buy, d.sell);
  } catch { /* ignore */ }
}

function renderTrades(trades) {
  // Time/Taker column like Delta: /B = buyer was taker, /S = seller was taker
  $("trades").innerHTML = trades.map(t => `<div class="ob-row">
    <span class="p-${t.side}">${fmt(t.price)} ${t.side === "buy" ? "↗" : "↘"}</span>
    <span class="r">${fmtBig(t.size)}</span>
    <span class="r t-time">${new Date(t.time).toLocaleTimeString("en-IN", { hour12: false })}<span class="tk-side p-${t.side}">/${t.side === "buy" ? "B" : "S"}</span></span>
  </div>`).join("");
}

let trSeq = 0;
async function refreshTrades() {
  if (isNse(chartCfg.symbol)) return;
  const sym = chartCfg.symbol;
  if (Date.now() - wsFresh.trades < 6000) return; // websocket is streaming trades
  const seq = ++trSeq;
  try {
    const d = await api(`/api/recent-trades?symbol=${encodeURIComponent(sym)}`);
    if (seq !== trSeq || sym !== chartCfg.symbol) return;
    if (!d.ok) return;
    if (Date.now() - wsFresh.trades < 6000) return;
    renderTrades(d.trades);
  } catch { /* ignore */ }
}

// ==================== SYMBOL BROWSER ====================

let exch = "delta";
let symCat = "perp";
let symTarget = "chart";
let nseSearchResults = [];
let nseSearchTimer = null;

const CAT_SETS = {
  delta: [["perp", "Perpetuals"], ["fut", "Futures"], ["opt", "Options"], ["all", "All"]],
  nse: [["index", "Indices"], ["stock", "F&O Stocks"], ["all", "All"]],
};

function catOf(s) {
  if (s.src === "nse") return s.type === "index" ? "index" : "stock";
  const t = s.type || "";
  if (t.includes("perpetual")) return "perp";
  if (t.includes("option")) return "opt";
  if (t.includes("future")) return "fut";
  return "other";
}

function renderCatTabs() {
  $("sym-tabs").innerHTML = CAT_SETS[exch]
    .map(([k, label], i) => `<button class="pill ${k === symCat ? "active" : ""}" data-cat="${k}">${label}</button>`).join("");
  $("sym-tabs").querySelectorAll(".pill").forEach(p => {
    p.addEventListener("click", () => { symCat = p.dataset.cat; renderCatTabs(); renderSymbolList(); });
  });
}

function openSymbolModal(target) {
  symTarget = target;
  $("sym-modal-title").textContent =
    target === "watchlist" ? "Add to Watchlist" :
    target === "compare" ? "Compare With…" : "Select Symbol";
  exch = isNse(target === "dialog" ? dlgSymbol : chartCfg.symbol) ? "nse" : "delta";
  symCat = exch === "delta" ? "perp" : "index";
  document.querySelectorAll("#exch-tabs .pill").forEach(p => p.classList.toggle("active", p.dataset.exch === exch));
  renderCatTabs();
  $("symbol-modal").classList.remove("hidden");
  $("sym-search").value = "";
  nseSearchResults = [];
  renderSymbolList();
  setTimeout(() => $("sym-search").focus(), 50);
}

function renderSymbolList() {
  const q = $("sym-search").value.trim().toUpperCase();
  let list = SYMBOLS.filter(s => (exch === "nse") === (s.src === "nse"));
  if (!q && symCat !== "all") list = list.filter(s => catOf(s) === symCat);
  if (q) list = list.filter(s => s.symbol.toUpperCase().includes(q) || (s.description || "").toUpperCase().includes(q));
  if (exch === "nse" && q && nseSearchResults.length) {
    const have = new Set(list.map(s => s.symbol));
    for (const r of nseSearchResults) if (!have.has(r.symbol)) list.push(r);
  }
  if (exch === "delta") {
    list = [...list].sort((a, b) => {
      const ta = TICKERS.get(a.symbol), tb = TICKERS.get(b.symbol);
      return ((tb && tb.turnover) || 0) - ((ta && ta.turnover) || 0);
    });
  }
  const total = list.length;
  const shown = list.slice(0, 250);
  const box = $("sym-list");
  if (!shown.length) {
    box.innerHTML = `<div class="empty">${exch === "nse" && q ? "Searching NSE…" : `No symbols match "${esc(q)}"`}</div>`;
    return;
  }
  box.innerHTML = shown.map(s => {
    const t = TICKERS.get(s.symbol);
    const chg = t && t.changePct !== null && t.changePct !== undefined ? t.changePct : null;
    const inWl = watchlist.includes(s.symbol);
    return `<div class="sym-row" data-sym="${esc(s.symbol)}">
      <button class="sym-star ${inWl ? "on" : ""}" data-star="${esc(s.symbol)}" title="${inWl ? "Remove from" : "Add to"} watchlist">${inWl ? "★" : "☆"}</button>
      <span class="s">${esc(s.src === "nse" ? s.symbol.slice(4) : s.symbol)}</span>
      <span class="d">${esc(s.description || s.type)}</span>
      <span class="p r">${t && t.close ? fmt(t.close) : "—"}</span>
      <span class="c r ${chg === null ? "" : chg >= 0 ? "up" : "down"}">${chg === null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</span>
    </div>`;
  }).join("") + (total > 250 ? `<div class="sym-more">${total - 250} more — type to narrow down</div>` : "");

  box.querySelectorAll("[data-star]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWatch(el.dataset.star);
      renderSymbolList();
    });
  });
  box.querySelectorAll(".sym-row").forEach(el => {
    el.addEventListener("click", () => {
      const sym = el.dataset.sym;
      $("symbol-modal").classList.add("hidden");
      if (symTarget === "dialog") {
        dlgSymbol = sym;
        $("f-symbol-btn").textContent = dispSym(sym);
        syncDialogResolutions();
        schedulePreview();
        updateChartFromForm();
      } else if (symTarget === "watchlist") {
        if (!watchlist.includes(sym)) toggleWatch(sym);
        setSideTab("wl");
      } else if (symTarget === "compare") {
        setCompare(sym);
      } else {
        setChart(sym, chartCfg.resolution, chartCfg.spec, chartCfg.target);
      }
    });
  });
}

$("sym-search").addEventListener("input", () => {
  renderSymbolList();
  if (exch === "nse") {
    clearTimeout(nseSearchTimer);
    const q = $("sym-search").value.trim();
    if (q.length >= 2) {
      nseSearchTimer = setTimeout(async () => {
        const d = await api(`/api/india-search?q=${encodeURIComponent(q)}`);
        if (d.ok) { nseSearchResults = d.results; renderSymbolList(); }
      }, 400);
    } else nseSearchResults = [];
  }
});

document.querySelectorAll("#exch-tabs .pill").forEach(p => {
  p.addEventListener("click", () => {
    exch = p.dataset.exch;
    symCat = exch === "delta" ? "perp" : "index";
    document.querySelectorAll("#exch-tabs .pill").forEach(x => x.classList.toggle("active", x === p));
    renderCatTabs();
    renderSymbolList();
  });
});

// ==================== INDICATOR PICKER ====================

function makeIndicatorPicker(rootId, initial, onChange) {
  const root = $(rootId);
  let value = initial;
  root.className = "ipicker";
  root.innerHTML = `
    <button type="button" class="ipicker-btn"></button>
    <div class="ipicker-panel hidden">
      <input type="text" class="ipicker-search" placeholder="Search indicators…">
      <div class="ipicker-list"></div>
    </div>`;
  const btn = root.querySelector(".ipicker-btn");
  const panel = root.querySelector(".ipicker-panel");
  const search = root.querySelector(".ipicker-search");
  const listEl = root.querySelector(".ipicker-list");
  const labelOf = (k) => META.indicators[k] ? META.indicators[k].label : k;
  const renderBtn = () => { btn.textContent = labelOf(value); };
  function renderList() {
    const q = search.value.trim().toLowerCase();
    let html = "";
    for (const [group, keys] of IND_GROUPS) {
      const ks = keys.filter(k => META.indicators[k] && (!q || labelOf(k).toLowerCase().includes(q) || k.includes(q)));
      if (!ks.length) continue;
      html += `<div class="ip-group">${group}</div>`;
      html += ks.map(k => `<div class="ip-item ${k === value ? "sel" : ""}" data-k="${k}">${esc(labelOf(k))}</div>`).join("");
    }
    listEl.innerHTML = html || `<div class="empty">No match</div>`;
    listEl.querySelectorAll(".ip-item").forEach(el => {
      el.addEventListener("click", () => {
        value = el.dataset.k;
        renderBtn();
        panel.classList.add("hidden");
        onChange(value);
      });
    });
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".ipicker-panel").forEach(p => { if (p !== panel) p.classList.add("hidden"); });
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) { search.value = ""; renderList(); search.focus(); }
  });
  search.addEventListener("input", renderList);
  document.addEventListener("click", (e) => { if (!root.contains(e.target)) panel.classList.add("hidden"); });
  renderBtn();
  return { get: () => value, set: (v) => { value = v; renderBtn(); } };
}

let leftPicker, rightPicker;

// ==================== PARAM FORMS ====================

function renderParams(side) {
  const type = side === "left" ? leftPicker.get() : rightPicker.get();
  const def = META.indicators[type];
  const box = $(`f-${side}-params`);
  let html = "";
  for (const p of def.params) {
    html += `<div class="pfield"><label>${p.label}</label>
      <input type="number" step="${p.step || 1}" data-param="${p.name}" value="${p.def}"></div>`;
  }
  if (def.source) {
    html += `<div class="pfield"><label>Source</label>
      <select data-param="__source">
        ${["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"].map(s => `<option>${s}</option>`).join("")}
      </select></div>`;
  }
  if (def.outputs) {
    html += `<div class="pfield"><label>Line</label>
      <select data-param="__output">
        ${def.outputs.map(o => `<option value="${o.name}">${o.label}</option>`).join("")}
      </select></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll("input,select").forEach(el => el.addEventListener("change", () => { schedulePreview(); updateChartFromForm(); }));
}

function readSpec(side) {
  const type = side === "left" ? leftPicker.get() : rightPicker.get();
  const box = $(`f-${side}-params`);
  const spec = { type, params: {}, source: "close", output: null };
  box.querySelectorAll("[data-param]").forEach(el => {
    const k = el.dataset.param;
    if (k === "__source") spec.source = el.value;
    else if (k === "__output") spec.output = el.value;
    else spec.params[k] = Number(el.value);
  });
  return spec;
}

function writeSpec(side, spec) {
  (side === "left" ? leftPicker : rightPicker).set(spec.type);
  renderParams(side);
  const box = $(`f-${side}-params`);
  box.querySelectorAll("[data-param]").forEach(el => {
    const k = el.dataset.param;
    if (k === "__source") el.value = spec.source || "close";
    else if (k === "__output") { if (spec.output) el.value = spec.output; }
    else if (spec.params && spec.params[k] !== undefined) el.value = spec.params[k];
  });
}

// ==================== ALERT FORM ====================

let dlgSymbol = "BTCUSD";

function syncDialogResolutions() {
  const list = isNse(dlgSymbol) ? META.nseResolutions : META.resolutions;
  const cur = $("f-resolution").value;
  $("f-resolution").innerHTML = list.map(r => `<option value="${r}">${r}</option>`).join("");
  $("f-resolution").value = list.includes(cur) ? cur : "5m";
}

function buildAlertBody() {
  const rightKind = $("f-right-kind").value;
  return {
    symbol: dlgSymbol,
    resolution: $("f-resolution").value,
    left: readSpec("left"),
    op: $("f-op").value,
    right: rightKind === "value"
      ? { kind: "value", value: Number($("f-right-value").value) }
      : { kind: "indicator", spec: readSpec("right") },
    trigger: $("f-trigger").value,
    message: $("f-message").value.trim(),
    expiresAt: $("f-expires").value ? new Date($("f-expires").value).getTime() : null,
    channels: { app: $("f-ch-app").checked, telegram: $("f-ch-tg").checked },
  };
}

function updateChartFromForm() {
  if ($("modal").classList.contains("hidden")) return;
  const body = buildAlertBody();
  const target = body.right.kind === "value" && Number.isFinite(body.right.value) ? body.right.value : null;
  setChart(body.symbol, body.resolution, body.left, target);
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 450);
}

async function runPreview() {
  if ($("modal").classList.contains("hidden")) return;
  const body = buildAlertBody();
  if (body.right.kind === "value" && !Number.isFinite(body.right.value)) {
    setPreview("Enter the comparison value", false); return;
  }
  setPreview("Checking live values…", false);
  try {
    const d = await api("/api/preview", { method: "POST", body: JSON.stringify(body) });
    if (!d.ok) { setPreview("⚠ " + d.error, false); return; }
    const l = d.leftValue === null ? "warming up" : fmt(d.leftValue);
    const r = d.rightValue === null ? "—" : fmt(d.rightValue);
    setPreview(`✓ ${d.condition}\nnow: ${l} vs ${r}   ·   price ${fmt(d.price)}`, true);
  } catch {
    setPreview("Preview failed — server unreachable?", false);
  }
}

function setPreview(text, ok) {
  const p = $("preview");
  p.textContent = text;
  p.classList.toggle("ok", !!ok);
}

function openModal(alert) {
  editingId = alert ? alert.id : null;
  $("modal-title").textContent = alert ? "Edit Alert" : "Create Alert";
  $("form-error").classList.add("hidden");
  if (alert) {
    dlgSymbol = alert.symbol;
    syncDialogResolutions();
    $("f-resolution").value = alert.resolution;
    $("f-trigger").value = alert.trigger;
    $("f-op").value = alert.op;
    writeSpec("left", alert.left);
    $("f-right-kind").value = alert.right.kind;
    if (alert.right.kind === "value") $("f-right-value").value = alert.right.value;
    else writeSpec("right", alert.right.spec);
    $("f-message").value = alert.message || "";
    $("f-expires").value = alert.expiresAt ? toLocalDT(alert.expiresAt) : "";
    $("f-ch-app").checked = !alert.channels || alert.channels.app !== false;
    $("f-ch-tg").checked = !!(alert.channels && alert.channels.telegram);
  } else {
    dlgSymbol = chartCfg.symbol;
    syncDialogResolutions();
    $("f-resolution").value = chartCfg.resolution;
    $("f-message").value = "";
    $("f-expires").value = "";
    $("f-right-value").value = "70";
    $("f-right-kind").value = "value";
  }
  $("f-symbol-btn").textContent = dispSym(dlgSymbol);
  syncRightKind();
  $("modal").classList.remove("hidden");
  schedulePreview();
  updateChartFromForm();
}

function toLocalDT(ms) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function syncRightKind() {
  const isVal = $("f-right-kind").value === "value";
  $("f-right-value").classList.toggle("hidden", !isVal);
  $("f-right-ind").classList.toggle("hidden", isVal);
}

async function saveAlert() {
  const body = buildAlertBody();
  const d = editingId
    ? await api(`/api/alerts/${editingId}`, { method: "PUT", body: JSON.stringify(body) })
    : await api("/api/alerts", { method: "POST", body: JSON.stringify(body) });
  if (!d.ok) {
    const e = $("form-error");
    e.textContent = d.error;
    e.classList.remove("hidden");
    return;
  }
  $("modal").classList.add("hidden");
  refreshAlerts();
}

// ==================== ALERTS TABLE (bottom panel) ====================

const OP_TXT = { cross_up: "crossing ↑", cross_down: "crossing ↓", cross: "crossing", gt: ">", lt: "<" };

async function refreshAlerts() {
  try {
    const d = await api("/api/alerts");
    if (!d.ok) return;
    ALERTS = d.alerts;
    renderAlerts();
  } catch (e) {
    const box = $("alerts-list");
    if (box) box.innerHTML = `<div class="empty err">Could not load alerts.</div>`;
  }
}

function renderAlerts() {
  const box = $("alerts-list");
  try {
  const watching = ALERTS.filter(a => a.enabled && a.status === "active").length;
  $("alert-count").textContent = ALERTS.length ? `(${watching})` : "";
  if (!ALERTS.length) {
    box.innerHTML = `<div class="empty">No alerts yet. Click <b>+ Alert</b> to create the first one.</div>`;
    return;
  }
  const rows = ALERTS.map(a => {
    const rt = a.runtime || {};
    const badge = !a.enabled ? ["off", "OFF"]
      : a.status === "fired" ? ["fired", "FIRED"]
      : a.status === "expired" ? ["expired", "EXPIRED"]
      : ["active", "ACTIVE"];
    const live = rt.lastError
      ? `<span class="err">⚠ ${esc(rt.lastError.slice(0, 60))}</span>`
      : rt.leftValue !== undefined ? `<span class="lv">${fmt(rt.leftValue)}</span>` : `<span class="t-time">…</span>`;
    return `<tr class="arow" data-id="${a.id}">
      <td><span class="sym">${esc(dispSym(a.symbol))}</span></td>
      <td class="mono">${esc(a.resolution)}</td>
      <td>${esc(describeOperandUI(a.left))} ${OP_TXT[a.op] || a.op} ${esc(describeOperandUI(a.right))}</td>
      <td class="r">${live}</td>
      <td class="r mono">${fmt(rt.rightValue)}</td>
      <td class="r mono">${fmt(rt.lastPrice)}</td>
      <td>${a.trigger === "once" ? "once" : a.trigger === "once_per_bar" ? "per bar" : "every"}${a.channels && a.channels.telegram ? " 📱" : ""}</td>
      <td><span class="badge badge-${badge[0]}">${badge[1]}</span></td>
      <td>
        <label class="toggle"><input type="checkbox" ${a.enabled ? "checked" : ""} data-act="toggle"><span class="tr2"></span></label>
        <button class="icon-btn" data-act="edit" title="Edit">✎</button>
        <button class="icon-btn" data-act="del" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join("");
  box.innerHTML = `<table class="atable">
    <thead><tr>
      <th>Symbol</th><th>Interval</th><th>Condition</th>
      <th class="r">Live Value</th><th class="r">Target</th><th class="r">Price</th>
      <th>Trigger</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  box.querySelectorAll(".arow").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]") || e.target.closest(".toggle")) return;
      const a = ALERTS.find(x => x.id === row.dataset.id);
      if (!a) return;
      const target = a.right.kind === "value" ? Number(a.right.value) : null;
      setChart(a.symbol, a.resolution, a.left, target);
    });
  });
  box.querySelectorAll("[data-act]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = e.target.closest(".arow").dataset.id;
      const alert = ALERTS.find(a => a.id === id);
      const act = el.dataset.act;
      if (act === "toggle") {
        await api(`/api/alerts/${id}/toggle`, { method: "POST", body: "{}" });
        refreshAlerts();
      } else if (act === "edit") {
        openModal(alert);
      } else if (act === "del") {
        if (confirm(`Delete alert on ${dispSym(alert.symbol)}?`)) {
          await api(`/api/alerts/${id}`, { method: "DELETE" });
          refreshAlerts();
        }
      }
    });
  });
  } catch (e) {
    box.innerHTML = `<div class="empty err">Alert list error — try refreshing.</div>`;
  }
}

// ==================== FIRED LOG ====================

async function refreshFired() {
  try {
    const d = await api("/api/fired");
    if (!d.ok) return;
    const box = $("fired-list");
    if (!d.fired.length) {
      box.innerHTML = `<div class="empty">Nothing triggered yet.</div>`;
      return;
    }
    box.innerHTML = d.fired.map(f => `<div class="fcard">
      <div class="fcard-time">${new Date(f.time).toLocaleString()}</div>
      <div class="fcard-msg">🔔 ${esc(f.message)}</div>
      <div class="fcard-detail">${esc(f.condition)} · value ${fmt(f.leftValue)} · price ${fmt(f.price)}</div>
    </div>`).join("");
  } catch { /* ignore */ }
}

// ==================== LIVE STREAM + ALARM ====================

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.addEventListener("alert", (e) => {
    const rec = JSON.parse(e.data);
    triggerAlarm(rec);
    refreshAlerts();
    refreshFired();
  });
}

function setConn(on) {
  const c = $("conn");
  c.textContent = on ? "● live" : "● disconnected";
  c.className = `conn ${on ? "conn-on" : "conn-off"}`;
}

let audioCtx = null;
let sirenNodes = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  $("btn-sound").textContent = "🔊 Sound on";
}

function startSiren() {
  if (!audioCtx || sirenNodes) return;
  const osc = audioCtx.createOscillator();
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  const gain = audioCtx.createGain();
  osc.type = "square"; osc.frequency.value = 880;
  lfo.type = "sine"; lfo.frequency.value = 3;
  lfoGain.gain.value = 320;
  lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
  gain.gain.value = 0.18;
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); lfo.start();
  sirenNodes = { osc, lfo };
}

function stopSiren() {
  if (!sirenNodes) return;
  try { sirenNodes.osc.stop(); sirenNodes.lfo.stop(); } catch {}
  sirenNodes = null;
}

function triggerAlarm(rec) {
  $("alarm-msg").textContent = rec.message;
  $("alarm-detail").textContent = `${rec.condition} · value ${fmt(rec.leftValue)} · price ${fmt(rec.price)}`;
  $("alarm").classList.remove("hidden");
  if (audioCtx) startSiren();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("🔔 CautionTrading", { body: `${rec.message}\n${rec.condition}`, requireInteraction: true });
  }
  document.title = "🔔 ALERT — CautionTrading";
}

$("alarm-stop").addEventListener("click", () => {
  stopSiren();
  $("alarm").classList.add("hidden");
  document.title = "CautionTrading — Terminal";
});

// ==================== SETTINGS ====================

async function loadSettings() {
  const d = await api("/api/settings");
  if (!d.ok) return;
  $("s-chat").value = d.settings.telegramChatId || "";
  if (d.settings.telegramTokenMasked) $("s-token").placeholder = `saved: ${d.settings.telegramTokenMasked}`;
  $("settings-status").textContent = d.settings.telegramConfigured
    ? "✅ Telegram is configured." : "Telegram not set up yet — follow the steps above.";
}

$("btn-save-settings").addEventListener("click", async () => {
  const body = { telegramChatId: $("s-chat").value };
  if ($("s-token").value.trim()) body.telegramToken = $("s-token").value.trim();
  await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
  $("s-token").value = "";
  $("settings-status").textContent = "Saved.";
  loadSettings();
});

$("btn-detect").addEventListener("click", async () => {
  $("settings-status").textContent = "Looking for your message to the bot…";
  const d = await api("/api/telegram/detect-chat");
  if (d.ok) {
    $("s-chat").value = d.chatId;
    $("settings-status").textContent = `✅ Found chat: ${d.name} (${d.chatId}) — saved.`;
  } else {
    $("settings-status").textContent = "⚠ " + d.error;
  }
});

$("btn-tg-test").addEventListener("click", async () => {
  $("settings-status").textContent = "Sending…";
  const d = await api("/api/telegram/test", { method: "POST", body: "{}" });
  $("settings-status").textContent = d.ok ? "✅ Test sent — check Telegram on the phone!" : "⚠ " + d.error;
});

// ==================== DELTA REALTIME WEBSOCKET ====================
// The real Delta site streams over this same public socket — we use it for
// tick-level price/stats, order book, trades and the live candle. The REST
// polling above stays as fallback (NSE symbols + if the socket drops).

const DWS_URL = "wss://socket.india.delta.exchange";
let dws = null;
let dwsRetryMs = 1000;
let dwsChannels = null; // {symbol, res} currently subscribed
const wsFresh = { ticker: 0, ob: 0, trades: 0 };
let wsTrades = [];
let wsCandle = null; // latest live candle {time(s),open,high,low,close,volume}

function dwsChanList(c) {
  return [
    { name: "v2/ticker", symbols: [c.symbol] },
    { name: "l2_orderbook", symbols: [c.symbol] },
    { name: "all_trades", symbols: [c.symbol] },
    { name: `candlestick_${c.res}`, symbols: [c.symbol] },
  ];
}

function dwsSync() {
  if (!dws || dws.readyState !== 1) return;
  const want = isNse(chartCfg.symbol) ? null : { symbol: chartCfg.symbol, res: chartCfg.resolution };
  const key = (c) => c ? `${c.symbol}|${c.res}` : "";
  if (key(want) === key(dwsChannels)) return;
  if (dwsChannels) dws.send(JSON.stringify({ type: "unsubscribe", payload: { channels: dwsChanList(dwsChannels) } }));
  dwsChannels = want;
  wsTrades = [];
  wsCandle = null;
  wsTickerData = null;
  wsOb = null;
  wsFresh.ticker = wsFresh.ob = wsFresh.trades = 0;
  if (want) dws.send(JSON.stringify({ type: "subscribe", payload: { channels: dwsChanList(want) } }));
}

function connectDeltaWS() {
  try { dws = new WebSocket(DWS_URL); } catch { return dwsRetry(); }
  dws.onopen = () => { dwsRetryMs = 1000; dwsChannels = null; dwsSync(); };
  dws.onclose = () => dwsRetry();
  dws.onerror = () => { try { dws.close(); } catch { /* already closed */ } };
  dws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!dwsChannels || d.symbol !== dwsChannels.symbol) return; // stale channel after a switch
    if (d.type === "v2/ticker") onWsTicker(d);
    else if (d.type === "l2_orderbook") onWsOrderbook(d);
    else if (d.type === "all_trades_snapshot") onWsTradesSnapshot(d);
    else if (d.type === "all_trades") onWsTrade(d);
    else if (d.type === `candlestick_${dwsChannels.res}`) onWsCandle(d);
  };
}

function dwsRetry() {
  dws = null;
  dwsChannels = null;
  setTimeout(connectDeltaWS, dwsRetryMs);
  dwsRetryMs = Math.min(dwsRetryMs * 2, 15000);
}

// ticker/orderbook can push many messages a second — render at most every few
// hundred ms (with a trailing call so the last message always lands), but the
// headline price updates on every tick
function makeThrottle(ms, fn) {
  let last = 0, timer = null;
  return () => {
    const run = () => { last = Date.now(); timer = null; fn(); };
    if (Date.now() - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (Date.now() - last));
  };
}

let wsTickerData = null;
let wsOb = null;
const renderTickerThrottled = makeThrottle(700, () => { if (wsTickerData) renderTicker(wsTickerData); });
const renderObThrottled = makeThrottle(250, () => { if (wsOb) renderOrderbook(wsOb.buy, wsOb.sell); });
const renderTradesThrottled = makeThrottle(250, () => renderTrades(wsTrades));

function onWsTicker(t) {
  wsFresh.ticker = Date.now();
  wsTickerData = {
    src: "delta",
    price: t.close,
    changePct: t.open ? ((t.close - t.open) / t.open) * 100 : null,
    high: t.high,
    low: t.low,
    turnoverUsd: t.turnover_usd,
    oi: t.oi !== undefined ? parseFloat(t.oi) : null,
    fundingRate: t.funding_rate !== undefined ? parseFloat(t.funding_rate) * 100 : null,
    indexPrice: t.spot_price !== undefined ? parseFloat(t.spot_price) : null,
  };
  if (t.mark_price !== undefined) wsMark = parseFloat(t.mark_price);
  const up = (wsTickerData.changePct || 0) >= 0;
  $("q-price").innerHTML = `<span class="${up ? "up" : "down"}">${fmt(wsTickerData.price)} ${up ? "↑" : "↓"}</span>`;
  renderTickerThrottled();
  const q = t.quotes || {};
  updateBuySell(parseFloat(q.best_bid), parseFloat(q.best_ask));
  $("src-note").textContent = "Delta Exchange · realtime ⚡";
}

function onWsOrderbook(d) {
  wsFresh.ob = Date.now();
  // keep the FULL book — grouping + the depth chart need more than 8 levels
  const map = (lvls) => (lvls || []).map(l => ({ price: parseFloat(l.limit_price), size: l.size }));
  wsOb = { buy: map(d.buy), sell: map(d.sell) };
  renderObThrottled();
}

const mapWsTrade = (t) => ({
  price: parseFloat(t.price),
  size: t.size,
  side: t.buyer_role === "taker" ? "buy" : "sell",
  time: Math.floor(t.timestamp / 1000), // µs → ms
});

function onWsTradesSnapshot(d) {
  wsFresh.trades = Date.now();
  wsTrades = (d.trades || []).slice(0, 30).map(mapWsTrade);
  renderTradesThrottled();
}

function onWsTrade(t) {
  wsFresh.trades = Date.now();
  wsTrades.unshift(mapWsTrade(t));
  if (wsTrades.length > 30) wsTrades.length = 30;
  renderTradesThrottled();
}

function applyLiveCandle(cd) {
  if (replayMode) return; // chart is frozen on the replay bar
  if (priceMode !== "traded") return; // mark/funding charts refresh via REST only
  if (!lastCandles.length || cd.time < lastCandles[lastCandles.length - 1].time) return;
  if (cd.time === lastCandles[lastCandles.length - 1].time) lastCandles[lastCandles.length - 1] = cd;
  else lastCandles.push(cd);
  if (chartType === "heikin") setMainData(lastCandles); // HA candles depend on the previous HA bar
  else if (LINE_TYPES.has(chartType)) candleSeries.update({ time: cd.time + TZ_OFF, value: cd.close });
  else candleSeries.update({ time: cd.time + TZ_OFF, open: cd.open, high: cd.high, low: cd.low, close: cd.close });
  volumeSeries.update({
    time: cd.time + TZ_OFF, value: cd.volume,
    color: cd.close >= cd.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
  });
  if (!crosshairActive) setLegendDefault();
}

function onWsCandle(c) {
  if (c.symbol !== chartCfg.symbol || c.resolution !== chartCfg.resolution) return;
  wsCandle = {
    time: Math.floor(c.candle_start_time / 1e6), // µs → s
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  };
  applyLiveCandle(wsCandle);
}

// ==================== CHART INDICATORS (studies) ====================

function applyStudies() {
  cancelReplay();
  localStorage.setItem("ct_studies_v1", JSON.stringify(studies));
  renderIndBtn();
  chartGen++; // in-flight series response no longer matches the new series list
  rebuildIndicatorSeries();
  refreshChart();
}

function renderIndBtn() {
  $("ind-btn").textContent = `ƒ Indicators${studies.length ? ` (${studies.length})` : ""}`;
}

function renderIndActive() {
  const box = $("ind-active");
  if (!studies.length) {
    box.innerHTML = `<div class="empty">No indicators on the chart yet — add one below.</div>`;
    return;
  }
  box.innerHTML = studies.map((st, i) => {
    const def = META.indicators[st.type];
    if (!def) return "";
    const params = def.params.map(p => `<label class="ind-p">${p.label}
      <input type="number" step="${p.step || 1}" data-i="${i}" data-param="${p.name}" value="${(st.params && st.params[p.name]) ?? p.def}"></label>`).join("");
    const src = def.source ? `<label class="ind-p">Source <select data-i="${i}" data-param="__source">
      ${["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"].map(s => `<option ${((st.source || "close") === s) ? "selected" : ""}>${s}</option>`).join("")}</select></label>` : "";
    return `<div class="ind-row">
      <span class="ind-dot" style="background:${STUDY_COLORS[i % STUDY_COLORS.length]}"></span>
      <span class="ind-name">${esc(def.label)}</span>
      ${params}${src}
      <button class="icon-btn" data-rm="${i}" title="Remove from chart">✕</button>
    </div>`;
  }).join("");
  box.querySelectorAll("input,select").forEach(el => el.addEventListener("change", () => {
    const st = studies[+el.dataset.i];
    if (!st) return;
    if (el.dataset.param === "__source") st.source = el.value;
    else { st.params = st.params || {}; st.params[el.dataset.param] = Number(el.value); }
    applyStudies();
  }));
  box.querySelectorAll("[data-rm]").forEach(el => el.addEventListener("click", () => {
    studies.splice(+el.dataset.rm, 1);
    applyStudies();
    renderIndActive();
  }));
}

function renderIndAddList() {
  const q = $("ind-search").value.trim().toLowerCase();
  let html = "";
  for (const [group, keys] of IND_GROUPS) {
    const ks = keys.filter(k => k !== "price" && META.indicators[k] &&
      (!q || META.indicators[k].label.toLowerCase().includes(q) || k.includes(q)));
    if (!ks.length) continue;
    html += `<div class="ip-group">${group}</div>` +
      ks.map(k => `<div class="ip-item" data-add="${k}">${esc(META.indicators[k].label)}<span class="ind-plus">+</span></div>`).join("");
  }
  $("ind-add-list").innerHTML = html || `<div class="empty">No match</div>`;
  $("ind-add-list").querySelectorAll("[data-add]").forEach(el => el.addEventListener("click", () => {
    const def = META.indicators[el.dataset.add];
    const params = {};
    def.params.forEach(p => { params[p.name] = p.def; });
    studies.push({ type: el.dataset.add, params, source: "close" });
    applyStudies();
    renderIndActive();
  }));
}

// ==================== DATA LOADERS ====================

async function loadSymbols() {
  try {
    const d = await api("/api/symbols");
    if (d.ok) SYMBOLS = d.symbols;
  } catch { /* retried on open */ }
}

async function loadTickers() {
  try {
    const d = await api("/api/tickers");
    if (d.ok) {
      TICKERS = new Map(d.tickers.map(t => [t.symbol, t]));
      if (!$("symbol-modal").classList.contains("hidden")) renderSymbolList();
    }
  } catch { /* ignore */ }
}

// ==================== BOOT ====================

async function boot() {
  META = await api("/api/meta");

  // first run: seed the chart with EMA 200 + RSI 14 — same defaults the client
  // uses on the real Delta chart (the blue line + RSI pane)
  if (localStorage.getItem("ct_studies_v1") === null) {
    studies = [
      { type: "ema", params: { length: 200 }, source: "close" },
      { type: "rsi", params: { length: 14 }, source: "close" },
    ];
    localStorage.setItem("ct_studies_v1", JSON.stringify(studies));
  }
  studies = studies.filter(st => META.indicators[st.type]);
  renderIndBtn();

  renderIntervalPills();
  syncDialogResolutions();
  $("f-op").innerHTML = Object.entries(META.ops).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("ind-count").textContent = `· ${Object.keys(META.indicators).length} indicators available`;

  leftPicker = makeIndicatorPicker("ip-left", "rsi", () => { renderParams("left"); schedulePreview(); updateChartFromForm(); });
  rightPicker = makeIndicatorPicker("ip-right", "ema", () => { renderParams("right"); schedulePreview(); });
  renderParams("left");
  renderParams("right");

  initChart();
  rebuildIndicatorSeries();
  drawInit();
  renderRangePills();
  renderCtypeBtn();
  syncModeTabs();
  $("sb-name").textContent = dispSym(chartCfg.symbol);
  renderWatchlist();
  refreshDetailPane();
  syncSidePanels();
  $("src-note").textContent = "Delta Exchange · live";
  connectDeltaWS();
  refreshChart();
  refreshTicker();
  refreshOrderbook();
  refreshTrades();
  loadSymbols();
  loadTickers();
  refreshAlerts();
  refreshFired();
  loadSettings();
  connectStream();

  setInterval(refreshChart, 2000);
  setInterval(refreshTicker, 3000);
  setInterval(refreshOrderbook, 1500);
  setInterval(refreshTrades, 2500);
  setInterval(refreshAlerts, 3000);
  setInterval(refreshFired, 10000);
  setInterval(loadTickers, 15000);
  setInterval(fundCountdown, 1000);
  setInterval(tickClock, 1000);
  tickClock();
  setInterval(refreshNseWlQuotes, 20000);
  refreshNseWlQuotes();
  setInterval(renderWatchlist, 5000);
  setInterval(refreshDetailPane, 60000);
}

// ==================== WIRING ====================

$("symbol-btn").addEventListener("click", () => openSymbolModal("chart"));
$("ind-btn").addEventListener("click", () => {
  renderIndActive();
  $("ind-search").value = "";
  renderIndAddList();
  $("ind-modal").classList.remove("hidden");
});
$("ind-search").addEventListener("input", renderIndAddList);
// Buy/Sell open the same product on Delta — the client executes there
const deltaTradeUrl = () => {
  const sym = chartCfg.symbol;
  const underlying = sym.endsWith("USD") ? sym.slice(0, -3) : sym;
  return `https://www.delta.exchange/app/futures/trade/${underlying}/${sym}`;
};
$("bb-sell").addEventListener("click", () => window.open(deltaTradeUrl(), "_blank"));
$("bb-buy").addEventListener("click", () => window.open(deltaTradeUrl(), "_blank"));
$("f-symbol-btn").addEventListener("click", () => openSymbolModal("dialog"));
$("btn-new").addEventListener("click", () => openModal(null));
$("btn-settings").addEventListener("click", () => { loadSettings(); $("settings-modal").classList.remove("hidden"); });
$("btn-save").addEventListener("click", saveAlert);
$("btn-sound").addEventListener("click", () => {
  ensureAudio();
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
});

document.querySelectorAll("[data-close]").forEach(el =>
  el.addEventListener("click", () => el.closest(".modal").classList.add("hidden")));

document.querySelectorAll(".btab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".btab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("alerts-list").classList.toggle("hidden", t.dataset.tab !== "alerts");
    $("fired-list").classList.toggle("hidden", t.dataset.tab !== "log");
    $("acct-panel").classList.toggle("hidden", t.dataset.tab !== "acct");
  });
});

$("f-right-kind").addEventListener("change", () => { syncRightKind(); schedulePreview(); updateChartFromForm(); });
["f-resolution", "f-op", "f-right-value"].forEach(id => $(id).addEventListener("change", () => { schedulePreview(); updateChartFromForm(); }));
$("f-right-value").addEventListener("input", () => { schedulePreview(); });

// ==================== PRICE-MODE TABS (Traded / Mark / Funding / Depth) ====================

function setPriceMode(m) {
  if (isNse(chartCfg.symbol)) m = "traded";
  cancelReplay();
  priceMode = m;
  syncModeTabs();
  $("depth-pane").classList.toggle("hidden", m !== "depth");
  if (m === "depth") { renderDepth(); return; }
  chartGen++; // refetch the right candle stream (MARK:/FUNDING: prefix)
  refreshChart();
}

function syncModeTabs() {
  const nse = isNse(chartCfg.symbol);
  document.querySelectorAll("#mode-tabs .mtab").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === priceMode);
    b.style.display = nse && b.dataset.mode !== "traded" ? "none" : "";
  });
  if (nse) $("depth-pane").classList.add("hidden");
}

// ==================== DEPTH CHART ====================

function renderDepth() {
  if (priceMode !== "depth") return;
  const wrap = $("depth-pane");
  const cv = $("depth-canvas");
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.fillStyle = "#131722"; x.fillRect(0, 0, W, H);
  if (!lastOb || !lastOb.buy.length || !lastOb.sell.length) {
    x.fillStyle = "#787b86"; x.font = "13px Inter, sans-serif"; x.textAlign = "center";
    x.fillText("Waiting for order book…", W / 2, H / 2);
    return;
  }
  const bids = [...lastOb.buy].sort((a, b) => b.price - a.price);
  const asks = [...lastOb.sell].sort((a, b) => a.price - b.price);
  let cum = 0; const bPts = bids.map(l => ({ p: l.price, c: cum += l.size }));
  cum = 0; const aPts = asks.map(l => ({ p: l.price, c: cum += l.size }));
  const pMin = bPts[bPts.length - 1].p, pMax = aPts[aPts.length - 1].p;
  const cMax = Math.max(bPts[bPts.length - 1].c, aPts[aPts.length - 1].c) * 1.08;
  const PX = (p) => ((p - pMin) / (pMax - pMin || 1)) * (W - 20) + 10;
  const CY = (c) => H - 24 - (c / cMax) * (H - 60);
  const drawSide = (pts, color, fill) => {
    x.beginPath();
    x.moveTo(PX(pts[0].p), H - 24);
    let prevY = CY(0);
    for (const pt of pts) { x.lineTo(PX(pt.p), prevY); prevY = CY(pt.c); x.lineTo(PX(pt.p), prevY); }
    x.lineTo(PX(pts[pts.length - 1].p), H - 24);
    x.closePath();
    x.fillStyle = fill; x.fill();
    x.strokeStyle = color; x.lineWidth = 1.5; x.stroke();
  };
  drawSide(bPts, "#26a69a", "rgba(38,166,154,.18)");
  drawSide(aPts, "#ef5350", "rgba(239,83,80,.18)");
  const mid = (bids[0].price + asks[0].price) / 2;
  x.strokeStyle = "#787b86"; x.setLineDash([4, 4]);
  x.beginPath(); x.moveTo(PX(mid), 16); x.lineTo(PX(mid), H - 24); x.stroke();
  x.setLineDash([]);
  x.fillStyle = "#d1d4dc"; x.font = "600 12px 'JetBrains Mono', monospace"; x.textAlign = "center";
  x.fillText(`Mid ${fmt(mid)}`, PX(mid), 12);
  x.fillStyle = "#787b86"; x.font = "10.5px 'JetBrains Mono', monospace";
  x.textAlign = "left"; x.fillText(fmt(pMin), 10, H - 8);
  x.textAlign = "right"; x.fillText(fmt(pMax), W - 10, H - 8);
  x.textAlign = "center"; x.fillText("cumulative size by price — Depth", W / 2, H - 8);
}

// ==================== RANGE PRESETS + SCALES + CLOCK (TradingView bottom bar) ====================

const RANGES = [
  ["1D", "5m", 288], ["5D", "15m", 480], ["1M", "1h", 744], ["3M", "4h", 540],
  ["6M", "1d", 185], ["YTD", "1d", 0], ["1Y", "1d", 370], ["All", "1d", 1500],
];

function renderRangePills() {
  $("range-pills").innerHTML = RANGES.map(([k]) => `<button class="rpill" data-rg="${k}">${k}</button>`).join("");
  $("range-pills").querySelectorAll(".rpill").forEach(b => b.addEventListener("click", () => applyRange(b.dataset.rg)));
}

function applyRange(key) {
  const r = RANGES.find(v => v[0] === key);
  if (!r) return;
  cancelReplay();
  let res = r[1], bars = r[2];
  if (key === "YTD") bars = Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000) + 5;
  if (isNse(chartCfg.symbol) && !META.nseResolutions.includes(res)) res = "1d";
  chartBars = Math.max(bars, 50);
  document.querySelectorAll("#range-pills .rpill").forEach(b => b.classList.toggle("active", b.dataset.rg === key));
  chartCfg.resolution = res;
  chartCfg.specKey = JSON.stringify([chartCfg.symbol, res, chartCfg.spec, chartCfg.target]);
  renderIntervalPills();
  saveLayout();
  chartGen++;
  dwsSync();
  refreshChart().then(() => { try { chart.timeScale().fitContent(); } catch {} });
}

let scaleMode = "normal"; // normal | log | pct
function applyScale() {
  const M = LightweightCharts.PriceScaleMode;
  chart.applyOptions({ rightPriceScale: { mode: scaleMode === "log" ? M.Logarithmic : scaleMode === "pct" ? M.Percentage : M.Normal } });
  $("scale-pct").classList.toggle("active", scaleMode === "pct");
  $("scale-log").classList.toggle("active", scaleMode === "log");
}

function tickClock() {
  $("tv-clock").textContent = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }) + " UTC+5:30";
}

// ==================== CHART TYPE SWITCHER ====================

const CTYPE_LBL = { candles: "🕯 Candles", bars: "𝄚 Bars", line: "∿ Line", area: "◣ Area", baseline: "⊟ Baseline", heikin: "🕯 Heikin Ashi" };

function renderCtypeBtn() {
  $("ctype-btn").textContent = (CTYPE_LBL[chartType] || chartType) + " ▾";
  document.querySelectorAll("#ctype-menu .dd-item").forEach(d => d.classList.toggle("sel", d.dataset.ctype === chartType));
}

function setChartType(t) {
  cancelReplay();
  chartType = t;
  saveLayout();
  renderCtypeBtn();
  createMainSeries();
  chartGen++;
  rebuildIndicatorSeries();
  if (lastCandles.length) setMainData(lastCandles);
  refreshChart();
}

// ==================== BAR REPLAY (TradingView-style) ====================
// Freezes the chart at a chosen bar and lets the client step/play forward,
// so they can see exactly how each indicator/alert would have behaved bar by bar.
// No recompute: we slice the already-fetched candles + indicator series.

function enterReplay() {
  if (replayMode) { exitReplay(); return; }
  if (!lastCandles.length) return;
  if (priceMode === "depth") setPriceMode("traded");
  replayMode = true;
  replayIdx = Math.max(5, Math.floor(lastCandles.length * 0.65));
  stopReplayPlay();
  $("replay-btn").classList.add("active");
  $("replay-bar").classList.remove("hidden");
  const sc = $("rp-scrub");
  sc.min = 5; sc.max = lastCandles.length - 1; sc.value = replayIdx;
  renderReplay();
  try { chart.timeScale().scrollToRealTime(); } catch {}
}

// Synchronous teardown — used when the user navigates away (symbol/interval/study
// change) so the caller's own refreshChart repaints. Does NOT trigger a refetch.
function cancelReplay() {
  if (!replayMode) return;
  stopReplayPlay();
  replayMode = false;
  $("replay-btn").classList.remove("active");
  $("replay-bar").classList.add("hidden");
}

function exitReplay() {
  if (!replayMode) return;
  cancelReplay();
  // repaint live data and snap back to the latest bar
  refreshChart().then(() => { try { chart.timeScale().scrollToRealTime(); } catch {} });
}

// Paint everything truncated to [0 .. replayIdx]
function renderReplay() {
  if (!replayMode || !lastCandles.length) return;
  replayIdx = Math.max(5, Math.min(lastCandles.length - 1, replayIdx));
  const cs = lastCandles.slice(0, replayIdx + 1);
  setMainData(cs);
  volumeSeries.setData(cs.map(c => ({
    time: c.time + TZ_OFF, value: c.volume,
    color: c.close >= c.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
  })));
  indSeriesList.forEach((holder, i) => {
    const vals = lastSeriesData[i] || [];
    const pts = [];
    for (let j = 0; j <= replayIdx; j++) {
      const v = vals[j];
      if (v === null || v === undefined) continue;
      pts.push(holder.isHist
        ? { time: lastCandles[j].time + TZ_OFF, value: v, color: v >= 0 ? "rgba(38,166,154,.55)" : "rgba(239,83,80,.55)" }
        : { time: lastCandles[j].time + TZ_OFF, value: v });
    }
    holder.series.setData(pts);
  });
  const bar = lastCandles[replayIdx];
  const d = new Date(bar.time * 1000);
  $("rp-pos").textContent = `${replayIdx + 1}/${lastCandles.length} · ${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`;
  $("rp-scrub").value = replayIdx;
  if (!crosshairActive) setLegend(legendLine(bar) + ` <span class="lg-dim">· replay</span>`);
}

function replayStep(dir) {
  if (!replayMode) return;
  replayIdx += dir;
  if (replayIdx >= lastCandles.length - 1) { replayIdx = lastCandles.length - 1; stopReplayPlay(); }
  if (replayIdx < 5) replayIdx = 5;
  renderReplay();
}

function startReplayPlay() {
  if (replayTimer) return;
  if (replayIdx >= lastCandles.length - 1) return;
  $("rp-play").textContent = "❚❚";
  replayTimer = setInterval(() => replayStep(1), replaySpeed);
}
function stopReplayPlay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  $("rp-play").textContent = "▶";
}
function toggleReplayPlay() { replayTimer ? stopReplayPlay() : startReplayPlay(); }

// ==================== COMPARE (overlay another symbol) ====================

let compareSym = null;
let cmpSeries = null;
let cmpSeq = 0;

function setCompare(sym) {
  if (sym === chartCfg.symbol) sym = null;
  compareSym = sym;
  if (cmpSeries) { try { chart.removeSeries(cmpSeries); } catch {} cmpSeries = null; }
  const chip = $("cmp-chip");
  if (!sym) { chip.classList.add("hidden"); return; }
  chip.innerHTML = `${esc(dispSym(sym))} <b data-cmp-x title="Remove comparison">✕</b>`;
  chip.classList.remove("hidden");
  chip.querySelector("[data-cmp-x]").addEventListener("click", () => setCompare(null));
  // own hidden price scale so BTC at 63k and an NSE index at 23k can share one chart
  cmpSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: "#e91e63", lineWidth: 1, priceScaleId: "cmp",
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
  }, 0);
  refreshCompare(chartGen);
}

async function refreshCompare(gen) {
  if (!compareSym || !cmpSeries) return;
  const seq = ++cmpSeq;
  try {
    const d = await api("/api/series", {
      method: "POST",
      body: JSON.stringify({ symbol: compareSym, resolution: chartCfg.resolution, bars: chartBars, specs: [] }),
    });
    if (seq !== cmpSeq || gen !== chartGen || !cmpSeries || !d.ok) return;
    cmpSeries.setData(d.candles.map(c => ({ time: c.time + TZ_OFF, value: c.close })));
  } catch { /* ignore */ }
}

// ==================== CANDLE-CLOSE COUNTDOWN (on the price scale) ====================

function updateCdFloat() {
  const el = $("cd-float");
  const step = RES_SEC[chartCfg.resolution];
  const last = lastCandles[lastCandles.length - 1];
  if (!chart || !step || !last || replayMode || priceMode === "funding" || priceMode === "depth") { el.classList.add("hidden"); return; }
  let y = null;
  try { y = candleSeries.priceToCoordinate(last.close); } catch { /* series swapped */ }
  if (y === null || y === undefined) { el.classList.add("hidden"); return; }
  const rem = step - (Math.floor(Date.now() / 1000) % step);
  const p2 = (n) => String(n).padStart(2, "0");
  el.textContent = rem >= 3600
    ? `${p2(Math.floor(rem / 3600))}:${p2(Math.floor((rem % 3600) / 60))}:${p2(rem % 60)}`
    : `${p2(Math.floor(rem / 60))}:${p2(rem % 60)}`;
  el.style.top = (y + 10) + "px";
  el.style.background = last.close >= last.open ? "#26a69a" : "#ef5350";
  el.classList.remove("hidden");
}

// ==================== WATCHLIST + SYMBOL DETAIL (TradingView right panel) ====================

let sideTab = "ob";
let watchlist;
try { watchlist = JSON.parse(localStorage.getItem("ct_watchlist_v1")); } catch { /* fresh */ }
if (!Array.isArray(watchlist) || !watchlist.length) {
  watchlist = ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "NSE:NIFTY", "NSE:BANKNIFTY"];
}
const nseWlQuotes = new Map();
const perfCache = new Map(); // symbol -> {at, candles} daily candles for the Performance grid

function saveWatchlist() { localStorage.setItem("ct_watchlist_v1", JSON.stringify(watchlist)); }

function toggleWatch(sym) {
  const i = watchlist.indexOf(sym);
  if (i >= 0) watchlist.splice(i, 1); else watchlist.push(sym);
  saveWatchlist();
  renderWatchlist();
}

function setSideTab(t) {
  sideTab = t;
  document.querySelectorAll(".side-tabs .stab").forEach(b => b.classList.toggle("active", b.dataset.side === t));
  syncSidePanels();
  if (t === "wl") { renderWatchlist(); refreshDetailPane(); refreshNseWlQuotes(); }
}

function wlQuote(sym) {
  if (isNse(sym)) {
    const q = nseWlQuotes.get(sym);
    return q ? { last: q.price, pct: q.changePct, chg: q.prevClose ? q.price - q.prevClose : null } : null;
  }
  const t = TICKERS.get(sym);
  if (!t || t.close === null) return null;
  const open = t.changePct === null ? null : t.close / (1 + t.changePct / 100);
  return { last: t.close, pct: t.changePct, chg: open === null ? null : t.close - open };
}

function renderWatchlist() {
  if ($("wl-wrap").classList.contains("hidden")) return;
  const box = $("wl-rows");
  box.innerHTML = watchlist.map(sym => {
    const q = wlQuote(sym);
    const cls = q && q.pct !== null ? (q.pct >= 0 ? "up" : "down") : "";
    return `<div class="wl-row ${sym === chartCfg.symbol ? "sel" : ""}" data-wsym="${esc(sym)}">
      <span class="s">${esc(isNse(sym) ? sym.slice(4) : sym)}</span>
      <span class="r">${q ? fmt(q.last) : "—"}</span>
      <span class="r ${cls}">${q && q.chg !== null ? fmt(q.chg) : "—"}</span>
      <span class="r ${cls}">${q && q.pct !== null ? (q.pct >= 0 ? "+" : "") + q.pct.toFixed(2) + "%" : "—"}</span>
      <button class="wl-x" data-wx="${esc(sym)}" title="Remove from watchlist">✕</button>
    </div>`;
  }).join("") || `<div class="empty">Watchlist is empty — click ＋ to add symbols.</div>`;
  box.querySelectorAll("[data-wx]").forEach(el => el.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWatch(el.dataset.wx);
  }));
  box.querySelectorAll(".wl-row").forEach(el => el.addEventListener("click", () => {
    setChart(el.dataset.wsym, chartCfg.resolution, chartCfg.spec, chartCfg.target);
  }));
}

async function refreshNseWlQuotes() {
  if ($("wl-wrap").classList.contains("hidden")) return;
  for (const sym of watchlist.filter(isNse)) {
    try {
      const d = await api(`/api/ticker?symbol=${encodeURIComponent(sym)}`);
      if (d.ok) nseWlQuotes.set(sym, d);
    } catch { /* ignore */ }
  }
  renderWatchlist();
}

async function refreshDetailPane() {
  if ($("wl-wrap").classList.contains("hidden")) return;
  const sym = chartCfg.symbol;
  const box = $("wl-detail");
  let q = wlQuote(sym);
  if (!q) {
    try {
      const d = await api(`/api/ticker?symbol=${encodeURIComponent(sym)}`);
      if (d.ok) q = { last: d.price, pct: d.changePct, chg: d.prevClose ? d.price - d.prevClose : null };
    } catch { /* ignore */ }
    if (sym !== chartCfg.symbol) return;
  }
  const s = SYMBOLS.find(v => v.symbol === sym);
  let status;
  if (isNse(sym)) {
    const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const open = ist.getDay() >= 1 && ist.getDay() <= 5 && mins >= 555 && mins < 930; // 09:15–15:30 IST
    status = open ? `<span class="dot-open">●</span> Market open · NSE` : `<span class="dot-closed">●</span> Market closed · NSE 09:15–15:30 IST`;
  } else {
    status = `<span class="dot-open">●</span> Market open · crypto trades 24×7`;
  }
  const cls = q && q.pct !== null ? (q.pct >= 0 ? "up" : "down") : "";
  box.innerHTML = `
    <div class="wl-d-sym">${esc(dispSym(sym))}</div>
    <div class="wl-d-desc">${esc(s ? (s.description || s.type || "") : "")}</div>
    <div class="wl-d-price ${cls}">${q ? fmt(q.last) : "—"}</div>
    <div class="wl-d-chg ${cls}">${q && q.pct !== null ? `${q.chg !== null ? (q.chg >= 0 ? "+" : "") + fmt(q.chg) + " " : ""}${q.pct >= 0 ? "+" : ""}${q.pct.toFixed(2)}%` : ""}</div>
    <div class="wl-d-status">${status}</div>
    <div class="perf-title">Performance</div>
    <div class="perf-grid" id="perf-grid"><span class="muted" style="grid-column:1/-1">Loading…</span></div>`;

  let pc = perfCache.get(sym);
  if (!pc || Date.now() - pc.at > 10 * 60 * 1000) {
    try {
      const d = await api("/api/series", {
        method: "POST",
        body: JSON.stringify({ symbol: sym, resolution: "1d", bars: 400, specs: [] }),
      });
      if (d.ok && d.candles.length) { pc = { at: Date.now(), candles: d.candles }; perfCache.set(sym, pc); }
    } catch { /* ignore */ }
  }
  if (sym !== chartCfg.symbol) return;
  const grid = $("perf-grid");
  if (!grid) return;
  if (!pc) { grid.innerHTML = `<span class="muted" style="grid-column:1/-1">No daily history.</span>`; return; }
  const cs = pc.candles;
  const lastC = cs[cs.length - 1].close;
  const nowS = cs[cs.length - 1].time;
  const closeAt = (daysAgo) => {
    const t = nowS - daysAgo * 86400;
    let best = cs[0];
    for (const c of cs) { if (c.time <= t) best = c; else break; }
    return best.close;
  };
  const jan1 = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  let ytdBase = cs[0];
  for (const c of cs) { if (c.time <= jan1) ytdBase = c; else break; }
  const items = [["1W", closeAt(7)], ["1M", closeAt(30)], ["3M", closeAt(91)], ["6M", closeAt(182)], ["YTD", ytdBase.close], ["1Y", closeAt(365)]];
  grid.innerHTML = items.map(([k, base]) => {
    const pct = base ? ((lastC - base) / base) * 100 : null;
    const c2 = pct === null ? "" : pct >= 0 ? "up" : "down";
    return `<div class="perf-cell ${c2}"><span class="pv">${pct === null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%"}</span><span class="pk">${k}</span></div>`;
  }).join("");
}

// ==================== CONTRACT DETAILS ====================

async function openContractDetails() {
  $("contract-modal").classList.remove("hidden");
  $("contract-title").textContent = `Contract Details — ${dispSym(chartCfg.symbol)}`;
  const box = $("contract-body");
  box.innerHTML = `<div class="empty">Loading…</div>`;
  if (isNse(chartCfg.symbol)) {
    box.innerHTML = `<div class="empty">Contract specs for NSE instruments live on nseindia.com — this panel covers Delta Exchange products.</div>`;
    return;
  }
  const d = await api(`/api/product?symbol=${encodeURIComponent(chartCfg.symbol)}`);
  if (!d.ok) { box.innerHTML = `<div class="empty">⚠ ${esc(d.error || "unavailable")}</div>`; return; }
  const p = d.product;
  const pctf = (v) => v === undefined || v === null ? "—" : parseFloat((parseFloat(v) * 100).toFixed(4)) + "%";
  const rows = [
    ["Symbol", p.symbol],
    ["Type", (p.type || "—").replace(/_/g, " ")],
    ["Underlying", p.underlying || "—"],
    ["Contract value", `${p.contractValue || "—"} ${p.contractUnit || ""}`],
    ["Tick size", p.tickSize || "—"],
    ["Maker fee", pctf(p.makerFee)],
    ["Taker fee", pctf(p.takerFee)],
    ["Initial margin", p.initialMargin ? p.initialMargin + "% (max " + Math.round(100 / parseFloat(p.initialMargin)) + "× leverage)" : "—"],
    ["Maintenance margin", p.maintenanceMargin ? p.maintenanceMargin + "%" : "—"],
    ["Max leverage notional", p.maxLeverageNotional ? "$" + fmtBig(+p.maxLeverageNotional) : "—"],
    ["Funding method", (p.fundingMethod || "—").replace(/_/g, " ")],
    ["Settles in", p.settlingAsset || "—"],
    ["Quoted in", p.quotingAsset || "—"],
    ["Launched", p.launchTime ? new Date(p.launchTime).toLocaleDateString("en-IN") : "—"],
    ["Settlement", p.settlementTime ? new Date(p.settlementTime).toLocaleString("en-IN") : "Perpetual — no expiry"],
  ];
  box.innerHTML = `<div class="muted">${esc(p.description || "")}</div>
    <table class="ctable">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(String(v))}</td></tr>`).join("")}</table>`;
}

// ==================== DRAWING TOOLS (TradingView left rail) ====================

const drawCanvas = $("draw-canvas");
const dctx = drawCanvas.getContext("2d");
let drawings = {};
try { drawings = JSON.parse(localStorage.getItem("ct_drawings_v1")) || {}; } catch { /* fresh */ }
let tool = "cursor";
let magnetOn = false, lockOn = false, hideDraws = false;
let pending = null; // in-progress drawing
let dragging = null; // {d, pi, lx, ly}
let dMouse = null; // last mouse position over the canvas
const undoStack = [], redoStack = [];
const DRAW_COLOR = "#2962ff";
const FIBS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function symDraws() {
  const k = chartCfg.symbol;
  if (!drawings[k]) drawings[k] = [];
  return drawings[k];
}
function saveDraws() { localStorage.setItem("ct_drawings_v1", JSON.stringify(drawings)); }
function pushHistory() {
  undoStack.push(JSON.stringify(symDraws()));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}
function undoDraw() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(symDraws()));
  drawings[chartCfg.symbol] = JSON.parse(undoStack.pop());
  saveDraws();
}
function redoDraw() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(symDraws()));
  drawings[chartCfg.symbol] = JSON.parse(redoStack.pop());
  saveDraws();
}
function resetDrawHistory() { undoStack.length = 0; redoStack.length = 0; pending = null; dragging = null; }

// ----- time <-> pixel (via logical index so drawings survive pan/zoom and extend past the last bar) -----
function resSecCur() { return RES_SEC[chartCfg.resolution] || 300; }

function tToLogical(t) {
  const cs = lastCandles;
  if (!cs.length) return null;
  const step = resSecCur();
  if (t <= cs[0].time) return (t - cs[0].time) / step;
  if (t >= cs[cs.length - 1].time) return cs.length - 1 + (t - cs[cs.length - 1].time) / step;
  let lo = 0, hi = cs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cs[m].time <= t) lo = m; else hi = m; }
  return lo + (t - cs[lo].time) / (cs[hi].time - cs[lo].time || step);
}
function logicalToT(l) {
  const cs = lastCandles;
  if (!cs.length) return null;
  const step = resSecCur();
  if (l <= 0) return cs[0].time + l * step;
  if (l >= cs.length - 1) return cs[cs.length - 1].time + (l - (cs.length - 1)) * step;
  const i = Math.floor(l);
  return cs[i].time + (l - i) * (cs[i + 1].time - cs[i].time);
}
function tToX(t) {
  const l = tToLogical(t);
  if (l === null) return null;
  const x = chart.timeScale().logicalToCoordinate(l);
  return x === null || x === undefined ? null : x;
}
function xToT(x) {
  const l = chart.timeScale().coordinateToLogical(x);
  return l === null || l === undefined ? null : logicalToT(l);
}
function pToY(p) { try { const y = candleSeries.priceToCoordinate(p); return y === null || y === undefined ? null : y; } catch { return null; } }
function yToP(y) { try { const p = candleSeries.coordinateToPrice(y); return p === null || p === undefined ? null : p; } catch { return null; } }

function snapPrice(t, p) {
  if (!magnetOn || !lastCandles.length || p === null) return p;
  let idx = Math.round(tToLogical(t));
  idx = Math.max(0, Math.min(lastCandles.length - 1, idx));
  const c = lastCandles[idx];
  const py = pToY(p);
  if (py === null) return p;
  let best = p, bd = 12;
  for (const v of [c.open, c.high, c.low, c.close]) {
    const vy = pToY(v);
    if (vy === null) continue;
    const d = Math.abs(vy - py);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function canvasPoint(e) {
  const r = drawCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function dataPoint(x, y) {
  const t = xToT(x), p = yToP(y);
  if (t === null || p === null) return null;
  return { t, p: snapPrice(t, p) };
}

// ----- rendering -----
function humanDur(s) {
  s = Math.abs(s);
  if (s >= 86400) return (s / 86400).toFixed(1).replace(/\.0$/, "") + "d";
  if (s >= 3600) return (s / 3600).toFixed(1).replace(/\.0$/, "") + "h";
  return Math.round(s / 60) + "m";
}

function drawOne(d, W, H, preview) {
  const c = dctx;
  c.strokeStyle = DRAW_COLOR;
  c.fillStyle = DRAW_COLOR;
  c.lineWidth = 1.5;
  c.setLineDash(preview ? [5, 4] : []);
  const sp = d.pts.map(pt => ({ x: tToX(pt.t), y: pToY(pt.p) }));
  const dot = (x, y) => { c.beginPath(); c.arc(x, y, 3, 0, 7); c.fill(); };
  const line = (x1, y1, x2, y2) => { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };

  if (d.tool === "hline") {
    const y = sp[0].y;
    if (y === null) return;
    c.setLineDash([6, 4]);
    line(0, y, W, y);
    c.setLineDash([]);
    c.font = "600 11px 'JetBrains Mono', monospace";
    c.fillText(fmt(d.pts[0].p), 8, y - 5);
    return;
  }
  if (d.tool === "vline") {
    const x = sp[0].x;
    if (x === null) return;
    c.setLineDash([6, 4]);
    line(x, 0, x, H);
    c.setLineDash([]);
    return;
  }
  if (d.tool === "text") {
    if (sp[0].x === null || sp[0].y === null) return;
    c.font = "600 13px Inter, sans-serif";
    c.fillStyle = "#f7a600";
    c.fillText(d.text || "text", sp[0].x, sp[0].y);
    dot(sp[0].x, sp[0].y + 4);
    return;
  }
  if (d.tool === "brush") {
    if (sp.some(p => p.x === null || p.y === null)) return;
    c.beginPath();
    sp.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
    c.stroke();
    return;
  }
  if (sp.length < 2 || sp.some(p => p.x === null || p.y === null)) return;
  const [a, b] = sp;

  if (d.tool === "trend") { line(a.x, a.y, b.x, b.y); dot(a.x, a.y); dot(b.x, b.y); return; }
  if (d.tool === "ray") {
    const dx = b.x - a.x, dy = b.y - a.y;
    let ex = b.x, ey = b.y;
    if (Math.abs(dx) > 0.01) { const k = (W - a.x) / dx; if (k > 0) { ex = W; ey = a.y + dy * k; } }
    line(a.x, a.y, ex, ey);
    dot(a.x, a.y); dot(b.x, b.y);
    return;
  }
  if (d.tool === "rect") {
    c.fillStyle = "rgba(41,98,255,.12)";
    c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    dot(a.x, a.y); dot(b.x, b.y);
    return;
  }
  if (d.tool === "fib") {
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const p0 = d.pts[0].p, p1 = d.pts[1].p;
    c.font = "600 10.5px 'JetBrains Mono', monospace";
    let prevY = null;
    for (const f of FIBS) {
      const price = p1 - (p1 - p0) * f;
      const y = pToY(price);
      if (y === null) continue;
      if (prevY !== null) { c.fillStyle = "rgba(41,98,255,.05)"; c.fillRect(x1, Math.min(prevY, y), x2 - x1, Math.abs(y - prevY)); }
      c.strokeStyle = f === 0.5 ? "#f7a600" : DRAW_COLOR;
      line(x1, y, x2, y);
      c.fillStyle = "#d1d4dc";
      c.fillText(`${f}  ${fmt(price)}`, x2 + 6, y + 3);
      prevY = y;
    }
    c.strokeStyle = DRAW_COLOR;
    dot(a.x, a.y); dot(b.x, b.y);
    return;
  }
  if (d.tool === "measure") {
    const dp = d.pts[1].p - d.pts[0].p;
    const up = dp >= 0;
    const col = up ? "#26a69a" : "#ef5350";
    c.fillStyle = up ? "rgba(38,166,154,.16)" : "rgba(239,83,80,.16)";
    c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    c.strokeStyle = col;
    c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const pct = d.pts[0].p ? (dp / d.pts[0].p) * 100 : 0;
    const bars = Math.round(Math.abs(d.pts[1].t - d.pts[0].t) / resSecCur());
    const txt1 = `${up ? "+" : ""}${fmt(dp)} (${up ? "+" : ""}${pct.toFixed(2)}%)`;
    const txt2 = `${bars} bars · ${humanDur(d.pts[1].t - d.pts[0].t)}`;
    const cx = (a.x + b.x) / 2, cy = Math.min(a.y, b.y) - 24;
    c.font = "700 12px 'JetBrains Mono', monospace";
    const w = Math.max(c.measureText(txt1).width, c.measureText(txt2).width) + 16;
    c.fillStyle = col;
    c.fillRect(cx - w / 2, cy - 16, w, 34);
    c.fillStyle = "#fff";
    c.textAlign = "center";
    c.fillText(txt1, cx, cy - 2);
    c.fillText(txt2, cx, cy + 13);
    c.textAlign = "left";
    return;
  }
}

function renderDraws() {
  const W = drawCanvas.clientWidth, H = drawCanvas.clientHeight;
  if (drawCanvas.width !== W * (window.devicePixelRatio || 1)) {
    const dpr = window.devicePixelRatio || 1;
    drawCanvas.width = W * dpr;
    drawCanvas.height = H * dpr;
  }
  dctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  dctx.clearRect(0, 0, W, H);
  if (!chart || !lastCandles.length) { requestAnimationFrame(renderDraws); return; }
  if (!hideDraws) for (const d of symDraws()) drawOne(d, W, H, false);
  if (pending && dMouse) {
    const dp = dataPoint(dMouse.x, dMouse.y);
    if (dp) {
      const prev = pending.tool === "brush"
        ? pending
        : { ...pending, pts: [...pending.pts, dp] };
      drawOne(prev, W, H, true);
    }
  }
  updateCdFloat();
  requestAnimationFrame(renderDraws);
}

// ----- hit testing -----
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let k = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  k = Math.max(0, Math.min(1, k));
  return Math.hypot(px - (x1 + dx * k), py - (y1 + dy * k));
}

function hitTest(x, y) {
  const W = drawCanvas.clientWidth;
  const list = symDraws();
  // endpoints first (drag a single anchor)
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d.tool === "brush") continue;
    for (let pi = 0; pi < d.pts.length; pi++) {
      const sx = d.tool === "hline" ? x : tToX(d.pts[pi].t);
      const sy = d.tool === "vline" ? y : pToY(d.pts[pi].p);
      if (sx !== null && sy !== null && Math.hypot(x - sx, y - sy) < 9) return { d, pi };
    }
  }
  // bodies (drag the whole drawing)
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    const sp = d.pts.map(pt => ({ x: tToX(pt.t), y: pToY(pt.p) }));
    if (d.tool === "hline") { if (sp[0].y !== null && Math.abs(y - sp[0].y) < 6) return { d, pi: -1 }; continue; }
    if (d.tool === "vline") { if (sp[0].x !== null && Math.abs(x - sp[0].x) < 6) return { d, pi: -1 }; continue; }
    if (d.tool === "text") { if (sp[0].x !== null && sp[0].y !== null && x >= sp[0].x - 6 && x <= sp[0].x + 90 && Math.abs(y - sp[0].y + 5) < 12) return { d, pi: -1 }; continue; }
    if (d.tool === "brush") {
      for (let j = 1; j < sp.length; j++) {
        if (sp[j - 1].x === null || sp[j].x === null) continue;
        if (distSeg(x, y, sp[j - 1].x, sp[j - 1].y, sp[j].x, sp[j].y) < 6) return { d, pi: -1 };
      }
      continue;
    }
    if (sp.length < 2 || sp.some(p => p.x === null || p.y === null)) continue;
    const [a, b] = sp;
    if (d.tool === "trend" || d.tool === "fib") { if (distSeg(x, y, a.x, a.y, b.x, b.y) < 6) return { d, pi: -1 }; }
    if (d.tool === "ray") {
      const dx = b.x - a.x, dy = b.y - a.y;
      let ex = b.x, ey = b.y;
      if (Math.abs(dx) > 0.01) { const k = (W - a.x) / dx; if (k > 0) { ex = W; ey = a.y + dy * k; } }
      if (distSeg(x, y, a.x, a.y, ex, ey) < 6) return { d, pi: -1 };
    }
    if (d.tool === "rect" || d.tool === "measure") {
      if (x >= Math.min(a.x, b.x) - 4 && x <= Math.max(a.x, b.x) + 4 &&
          y >= Math.min(a.y, b.y) - 4 && y <= Math.max(a.y, b.y) + 4) return { d, pi: -1 };
    }
  }
  return null;
}

// ----- tool interaction -----
const TWO_PT_TOOLS = new Set(["trend", "ray", "rect", "fib", "measure"]);

function setTool(t) {
  tool = t;
  pending = null;
  document.querySelectorAll("#rail [data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  drawCanvas.classList.toggle("drawing", t !== "cursor");
}

function finishDrawing(d) {
  pushHistory();
  symDraws().push(d);
  saveDraws();
  pending = null;
  setTool("cursor");
}

function drawInit() {
  drawCanvas.addEventListener("mousemove", (e) => {
    dMouse = canvasPoint(e);
    if (pending && pending.tool === "brush" && e.buttons === 1) {
      const dp = dataPoint(dMouse.x, dMouse.y);
      const lastPt = pending.pts[pending.pts.length - 1];
      if (dp && (!lastPt || Math.abs(tToX(lastPt.t) - dMouse.x) > 3 || Math.abs(pToY(lastPt.p) - dMouse.y) > 3)) pending.pts.push(dp);
    }
  });
  drawCanvas.addEventListener("mousedown", (e) => {
    if (tool === "cursor") return;
    e.preventDefault();
    const { x, y } = canvasPoint(e);
    if (tool === "eraser") {
      const hit = hitTest(x, y);
      if (hit) {
        pushHistory();
        const list = symDraws();
        list.splice(list.indexOf(hit.d), 1);
        saveDraws();
      }
      return;
    }
    const dp = dataPoint(x, y);
    if (!dp) return;
    if (tool === "hline" || tool === "vline") { finishDrawing({ tool, pts: [dp] }); return; }
    if (tool === "text") {
      const txt = prompt("Text on chart:");
      if (txt) finishDrawing({ tool, pts: [dp], text: txt.slice(0, 80) });
      else setTool("cursor");
      return;
    }
    if (tool === "brush") { pending = { tool, pts: [dp] }; return; }
    if (TWO_PT_TOOLS.has(tool)) {
      if (!pending) pending = { tool, pts: [dp] };
      else finishDrawing({ tool, pts: [pending.pts[0], dp] });
    }
  });
  drawCanvas.addEventListener("mouseup", (e) => {
    if (pending && pending.tool === "brush") {
      if (pending.pts.length > 1) finishDrawing(pending);
      else { pending = null; setTool("cursor"); }
      return;
    }
    // drag-to-draw: a two-point tool dragged far enough from its first point finishes here
    if (pending && TWO_PT_TOOLS.has(pending.tool)) {
      const { x, y } = canvasPoint(e);
      const x0 = tToX(pending.pts[0].t), y0 = pToY(pending.pts[0].p);
      if (Math.abs(x - x0) > 6 || Math.abs(y - y0) > 6) {
        const dp = dataPoint(x, y);
        if (dp) finishDrawing({ tool: pending.tool, pts: [pending.pts[0], dp] });
      }
    }
  });

  // cursor mode: grab & drag existing drawings (capture phase so the chart doesn't pan)
  $("chart-area").addEventListener("mousedown", (e) => {
    if (tool !== "cursor" || lockOn || hideDraws || priceMode === "depth") return;
    const r = drawCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = hitTest(x, y);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    pushHistory();
    dragging = { d: hit.d, pi: hit.pi, lx: x, ly: y };
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const r = drawCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const t1 = xToT(dragging.lx), t2 = xToT(x);
    const p1 = yToP(dragging.ly), p2 = yToP(y);
    if (t1 === null || t2 === null || p1 === null || p2 === null) return;
    const dt = t2 - t1, dp = p2 - p1;
    const pts = dragging.pi >= 0 ? [dragging.d.pts[dragging.pi]] : dragging.d.pts;
    for (const pt of pts) { pt.t += dt; pt.p += dp; }
    if (dragging.pi >= 0 && magnetOn) { const pt = dragging.d.pts[dragging.pi]; pt.p = snapPrice(pt.t, pt.p); }
    dragging.lx = x; dragging.ly = y;
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { saveDraws(); dragging = null; }
  });

  requestAnimationFrame(renderDraws);
}

// ==================== WIRING (TradingView overhaul) ====================

document.querySelectorAll("#mode-tabs .mtab").forEach(b =>
  b.addEventListener("click", () => setPriceMode(b.dataset.mode)));

document.querySelectorAll(".side-tabs .stab").forEach(b =>
  b.addEventListener("click", () => setSideTab(b.dataset.side)));

document.querySelectorAll("#rail [data-tool]").forEach(b =>
  b.addEventListener("click", () => setTool(b.dataset.tool === tool ? "cursor" : b.dataset.tool)));
$("r-magnet").addEventListener("click", () => { magnetOn = !magnetOn; $("r-magnet").classList.toggle("active", magnetOn); });
$("r-lock").addEventListener("click", () => { lockOn = !lockOn; $("r-lock").classList.toggle("active", lockOn); });
$("r-eye").addEventListener("click", () => { hideDraws = !hideDraws; $("r-eye").classList.toggle("active", hideDraws); });
$("r-trash").addEventListener("click", () => {
  if (!symDraws().length) return;
  if (confirm(`Remove all ${symDraws().length} drawing(s) on ${dispSym(chartCfg.symbol)}?`)) {
    pushHistory();
    drawings[chartCfg.symbol] = [];
    saveDraws();
  }
});
$("btn-undo").addEventListener("click", undoDraw);
$("btn-redo").addEventListener("click", redoDraw);

window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redoDraw(); else undoDraw(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redoDraw(); }
  else if (e.key === "Escape") { pending = null; setTool("cursor"); }
});

$("ctype-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("ctype-menu").classList.toggle("hidden");
});
document.querySelectorAll("#ctype-menu .dd-item").forEach(d =>
  d.addEventListener("click", () => { $("ctype-menu").classList.add("hidden"); setChartType(d.dataset.ctype); }));
document.addEventListener("click", (e) => {
  if (!$("ctype-wrap").contains(e.target)) $("ctype-menu").classList.add("hidden");
});

$("cmp-btn").addEventListener("click", () => openSymbolModal("compare"));
$("btn-alert-tb").addEventListener("click", () => openModal(null));

// ---- Bar Replay controls ----
$("replay-btn").addEventListener("click", enterReplay);
$("rp-exit").addEventListener("click", exitReplay);
$("rp-back").addEventListener("click", () => { stopReplayPlay(); replayStep(-1); });
$("rp-fwd").addEventListener("click", () => { stopReplayPlay(); replayStep(1); });
$("rp-play").addEventListener("click", toggleReplayPlay);
$("rp-scrub").addEventListener("input", (e) => { stopReplayPlay(); replayIdx = Number(e.target.value); renderReplay(); });
$("rp-speed").addEventListener("change", (e) => {
  replaySpeed = Number(e.target.value);
  if (replayTimer) { stopReplayPlay(); startReplayPlay(); }
});
$("wl-add").addEventListener("click", () => openSymbolModal("watchlist"));
$("btn-contract").addEventListener("click", openContractDetails);
$("btn-open-delta").addEventListener("click", () => window.open(deltaTradeUrl(), "_blank"));

$("scale-pct").addEventListener("click", () => { scaleMode = scaleMode === "pct" ? "normal" : "pct"; applyScale(); });
$("scale-log").addEventListener("click", () => { scaleMode = scaleMode === "log" ? "normal" : "log"; applyScale(); });
$("scale-auto").addEventListener("click", () => {
  try {
    chart.priceScale("right").applyOptions({ autoScale: true });
    chart.timeScale().scrollToRealTime();
  } catch { /* not ready */ }
});

$("btn-shot").addEventListener("click", () => {
  try {
    const shot = chart.takeScreenshot();
    const out = document.createElement("canvas");
    out.width = shot.width; out.height = shot.height;
    const x = out.getContext("2d");
    x.drawImage(shot, 0, 0);
    x.drawImage(drawCanvas, 0, 0, shot.width, shot.height); // drawings on top, like TradingView
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `${chartCfg.symbol.replace(":", "-")}-${chartCfg.resolution}.png`;
    a.click();
  } catch { /* chart not ready */ }
});

$("btn-fs").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else {
    const el = document.querySelector(".center");
    if (el.requestFullscreen) el.requestFullscreen();
  }
});

$("ob-group").addEventListener("change", () => { if (lastOb) renderOrderbook(lastOb.buy, lastOb.sell); });
[["obv-both", "both"], ["obv-bids", "bids"], ["obv-asks", "asks"]].forEach(([id, v]) => {
  $(id).addEventListener("click", () => {
    obView = v;
    ["obv-both", "obv-bids", "obv-asks"].forEach(i => $(i).classList.toggle("active", i === id));
    if (lastOb) renderOrderbook(lastOb.buy, lastOb.sell);
  });
});

window.addEventListener("resize", () => renderDepth());

boot();
