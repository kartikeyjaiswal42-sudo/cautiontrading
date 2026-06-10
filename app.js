// CautionTrading — frontend: TradingView-style chart + alert manager
/* global EventSource, LightweightCharts */

const $ = (id) => document.getElementById(id);

let META = null;
let SYMBOLS = [];
let TICKERS = new Map();   // symbol -> {close, changePct, turnover}
let ALERTS = [];
let editingId = null;

// what the chart is currently showing
const chartCfg = {
  symbol: "BTCUSD",
  resolution: "5m",
  spec: null,      // indicator spec drawn on the chart (left side of an alert)
  target: null,    // fixed-value target → dashed line
  specKey: "",     // change detector
};

// indicator groups for the searchable picker (TradingView-style menu)
const IND_GROUPS = [
  ["Price & Volume", ["price", "volume"]],
  ["Trend", ["sma", "ema", "wma", "hma", "supertrend", "psar", "ichimoku", "adx"]],
  ["Momentum", ["rsi", "macd", "stoch", "stochrsi", "cci", "willr", "mfi", "roc", "mom"]],
  ["Volatility", ["bb", "atr", "keltner", "donchian"]],
  ["Volume-based", ["obv", "vwap"]],
];

// indicators drawn ON the price chart (everything else gets its own pane below)
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

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ==================== CHART ====================

let chart, candleSeries, volumeSeries;
let indSeriesList = [];   // indicator series currently on the chart
let targetLine = null;
let lastCandles = [];

function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "#131722" },
      textColor: "#787b86",
      panes: { separatorColor: "#2a2e39", enableResize: true },
    },
    grid: {
      vertLines: { color: "rgba(42,46,57,.55)" },
      horzLines: { color: "rgba(42,46,57,.55)" },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#2a2e39" },
    timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, rightOffset: 4 },
    localization: { locale: "en-IN" },
  });

  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: "#26a69a", downColor: "#ef5350",
    wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    borderVisible: false,
  });

  volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceScaleId: "vol",
    priceFormat: { type: "volume" },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  chart.subscribeCrosshairMove(updateLegendFromCrosshair);
}

function chartSpecs() {
  // expand a multi-output indicator into one spec per drawable output
  if (!chartCfg.spec) return [];
  const def = META.indicators[chartCfg.spec.type];
  if (!def) return [];
  if (!def.outputs) return [{ ...chartCfg.spec, output: null }];
  return def.outputs
    .filter(o => o.name !== "direction")   // supertrend ±1 flag isn't chartable
    .map(o => ({ ...chartCfg.spec, output: o.name }));
}

function rebuildIndicatorSeries() {
  for (const s of indSeriesList) { try { chart.removeSeries(s.series); } catch {} }
  indSeriesList = [];
  if (targetLine) { try { candleSeries.removePriceLine(targetLine); } catch {} targetLine = null; }

  const specs = chartSpecs();
  if (!specs.length) return;

  const onPrice = OVERLAY.has(chartCfg.spec.type);
  const pane = onPrice ? 0 : 1;

  specs.forEach((sp, i) => {
    const isHist = sp.output === "hist";
    const series = isHist
      ? chart.addSeries(LightweightCharts.HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, pane)
      : chart.addSeries(LightweightCharts.LineSeries, {
          color: LINE_COLORS[i % LINE_COLORS.length],
          lineWidth: 2,
          lastValueVisible: true,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        }, pane);
    indSeriesList.push({ series, spec: sp, isHist });
  });

  try {
    const panes = chart.panes();
    if (!onPrice && panes[1] && panes[1].setHeight) panes[1].setHeight(170);
  } catch {}

  // dashed target line (like TradingView's alert line)
  if (chartCfg.target !== null && Number.isFinite(chartCfg.target)) {
    const host = onPrice || chartCfg.spec.type === "price" ? candleSeries : (indSeriesList[0] && indSeriesList[0].series);
    if (host) {
      targetLine = host.createPriceLine({
        price: chartCfg.target,
        color: "#f7a600",
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: "alert",
      });
      if (host !== candleSeries) targetLine._host = host;
    }
  }
}

let chartBusy = false;

async function refreshChart() {
  if (chartBusy || !chart) return;
  chartBusy = true;
  try {
    const specs = chartSpecs();
    const d = await api("/api/series", {
      method: "POST",
      body: JSON.stringify({ symbol: chartCfg.symbol, resolution: chartCfg.resolution, bars: 300, specs: specs.map(s => ({ type: s.type, params: s.params, source: s.source, output: s.output })) }),
    });
    if (!d.ok) { setLegend(`⚠ ${d.error}`); return; }
    lastCandles = d.candles;

    candleSeries.setData(d.candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.setData(d.candles.map(c => ({
      time: c.time, value: c.volume,
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
          ? { time: d.candles[j].time, value: v, color: v >= 0 ? "rgba(38,166,154,.55)" : "rgba(239,83,80,.55)" }
          : { time: d.candles[j].time, value: v });
      }
      holder.series.setData(pts);
    });

    updateQuote();
    setLegendDefault();
  } catch (e) {
    setLegend(`⚠ chart: ${e.message}`);
  } finally {
    chartBusy = false;
  }
}

function setChart(symbol, resolution, spec, target) {
  const newKey = JSON.stringify([symbol, resolution, spec, target]);
  const symbolChanged = symbol !== chartCfg.symbol || resolution !== chartCfg.resolution;
  if (newKey === chartCfg.specKey) return;
  chartCfg.symbol = symbol;
  chartCfg.resolution = resolution;
  chartCfg.spec = spec || null;
  chartCfg.target = (target === undefined || target === null) ? null : Number(target);
  chartCfg.specKey = newKey;

  $("sb-name").textContent = symbol;
  document.querySelectorAll("#interval-pills .pill").forEach(p =>
    p.classList.toggle("active", p.dataset.res === resolution));

  rebuildIndicatorSeries();
  refreshChart().then(() => { if (symbolChanged) chart.timeScale().scrollToRealTime(); });
}

// legend (top-left overlay, TradingView style)
function setLegend(html) { $("legend").innerHTML = html; }

function describeOperandUI(operand) {
  if (!operand) return "?";
  if (operand.kind === "value") return fmt(Number(operand.value));
  const spec = operand.kind === "indicator" ? operand.spec : operand;
  const def = META.indicators[spec.type];
  if (!def) return spec.type;
  const base = def.label.split(" (")[0];
  const params = def.params.map(p => (spec.params && spec.params[p.name]) ?? p.def).join(",");
  const out = spec.output && def.outputs ? ` ${spec.output}` : "";
  return params ? `${base}(${params})${out}` : `${base}${out}`;
}

function setLegendDefault() {
  const last = lastCandles[lastCandles.length - 1];
  if (!last) return;
  let html = `<b>${esc(chartCfg.symbol)}</b> · ${chartCfg.resolution} ` +
    `<span class="lg-dim">O</span> ${fmt(last.open)} <span class="lg-dim">H</span> ${fmt(last.high)} ` +
    `<span class="lg-dim">L</span> ${fmt(last.low)} <span class="lg-dim">C</span> <b class="${last.close >= last.open ? "up" : "down"}">${fmt(last.close)}</b>`;
  if (chartCfg.spec) {
    html += `<br><span class="lg-ind">${esc(describeOperandUI(chartCfg.spec))}</span>`;
    if (chartCfg.target !== null) html += ` <span class="lg-dim">· alert at ${fmt(chartCfg.target)}</span>`;
  }
  setLegend(html);
}

function updateLegendFromCrosshair(param) {
  if (!param || !param.time || !param.seriesData) { setLegendDefault(); return; }
  const c = param.seriesData.get(candleSeries);
  if (!c) { setLegendDefault(); return; }
  let html = `<b>${esc(chartCfg.symbol)}</b> · ${chartCfg.resolution} ` +
    `<span class="lg-dim">O</span> ${fmt(c.open)} <span class="lg-dim">H</span> ${fmt(c.high)} ` +
    `<span class="lg-dim">L</span> ${fmt(c.low)} <span class="lg-dim">C</span> <b class="${c.close >= c.open ? "up" : "down"}">${fmt(c.close)}</b>`;
  if (chartCfg.spec && indSeriesList.length) {
    const vals = indSeriesList.map((h, i) => {
      const v = param.seriesData.get(h.series);
      return v && v.value !== undefined ? fmt(v.value) : null;
    }).filter(Boolean);
    if (vals.length) html += `<br><span class="lg-ind">${esc(describeOperandUI(chartCfg.spec))}: ${vals.join(" · ")}</span>`;
  }
  setLegend(html);
}

function updateQuote() {
  const t = TICKERS.get(chartCfg.symbol);
  const last = lastCandles[lastCandles.length - 1];
  const price = last ? last.close : (t ? t.close : null);
  $("q-price").textContent = fmt(price);
  $("q-price").className = "q-price";
  if (t && t.changePct !== null) {
    const up = t.changePct >= 0;
    $("q-chg").textContent = `${up ? "+" : ""}${t.changePct.toFixed(2)}%`;
    $("q-chg").className = `q-chg ${up ? "up" : "down"}`;
    $("q-price").classList.add(up ? "up" : "down");
  } else {
    $("q-chg").textContent = "";
  }
}

// ==================== SYMBOL BROWSER ====================

let symCat = "perp";
let symTarget = "chart"; // "chart" | "dialog"

function catOf(type) {
  if (type.includes("perpetual")) return "perp";
  if (type.includes("option")) return "opt";
  if (type.includes("future")) return "fut";
  return "other";
}

function openSymbolModal(target) {
  symTarget = target;
  $("symbol-modal").classList.remove("hidden");
  $("sym-search").value = "";
  renderSymbolList();
  setTimeout(() => $("sym-search").focus(), 50);
}

function renderSymbolList() {
  const q = $("sym-search").value.trim().toUpperCase();
  let list = SYMBOLS;
  if (symCat !== "all") list = list.filter(s => catOf(s.type) === symCat);
  if (q) list = SYMBOLS.filter(s => s.symbol.toUpperCase().includes(q) || (s.description || "").toUpperCase().includes(q));

  // most-traded first
  list = [...list].sort((a, b) => {
    const ta = TICKERS.get(a.symbol), tb = TICKERS.get(b.symbol);
    return ((tb && tb.turnover) || 0) - ((ta && ta.turnover) || 0);
  });

  const total = list.length;
  const shown = list.slice(0, 250);
  const box = $("sym-list");
  if (!shown.length) { box.innerHTML = `<div class="empty">No symbols match "${esc(q)}"</div>`; return; }
  box.innerHTML = shown.map(s => {
    const t = TICKERS.get(s.symbol);
    const chg = t && t.changePct !== null && t.changePct !== undefined ? t.changePct : null;
    return `<div class="sym-row" data-sym="${esc(s.symbol)}">
      <span class="s">${esc(s.symbol)}</span>
      <span class="d">${esc(s.description || s.type)}</span>
      <span class="p r">${t && t.close ? fmt(t.close) : "—"}</span>
      <span class="c r ${chg === null ? "" : chg >= 0 ? "up" : "down"}">${chg === null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</span>
    </div>`;
  }).join("") + (total > 250 ? `<div class="sym-more">${total - 250} more — type to narrow down</div>` : "");

  box.querySelectorAll(".sym-row").forEach(el => {
    el.addEventListener("click", () => {
      const sym = el.dataset.sym;
      $("symbol-modal").classList.add("hidden");
      if (symTarget === "dialog") {
        dlgSymbol = sym;
        $("f-symbol-btn").textContent = sym;
        schedulePreview();
        updateChartFromForm();
      } else {
        // keep the plotted indicator when switching symbols (like TradingView)
        setChart(sym, chartCfg.resolution, chartCfg.spec, chartCfg.target);
      }
    });
  });
}

$("sym-search").addEventListener("input", renderSymbolList);
document.querySelectorAll("#sym-tabs .pill").forEach(p => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#sym-tabs .pill").forEach(x => x.classList.remove("active"));
    p.classList.add("active");
    symCat = p.dataset.cat;
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

  function labelOf(k) { return META.indicators[k] ? META.indicators[k].label : k; }
  function renderBtn() { btn.textContent = labelOf(value); }

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
  return {
    get: () => value,
    set: (v) => { value = v; renderBtn(); },
  };
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

// while the dialog is open, the chart live-previews the condition being built
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
    $("f-resolution").value = chartCfg.resolution;
    $("f-message").value = "";
    $("f-expires").value = "";
    $("f-right-value").value = "70";
    $("f-right-kind").value = "value";
  }
  $("f-symbol-btn").textContent = dlgSymbol;
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

// ==================== ALERTS LIST ====================

const OP_TXT = { cross_up: "crossing ↑", cross_down: "crossing ↓", cross: "crossing", gt: ">", lt: "<" };

async function refreshAlerts() {
  try {
    const d = await api("/api/alerts");
    if (!d.ok) return;
    ALERTS = d.alerts;
    renderAlerts();
  } catch { /* conn indicator covers it */ }
}

function renderAlerts() {
  const box = $("alerts-list");
  const watching = ALERTS.filter(a => a.enabled && a.status === "active").length;
  $("alert-count").textContent = ALERTS.length ? `(${watching})` : "";
  if (!ALERTS.length) {
    box.innerHTML = `<div class="empty">No alerts yet.<br>Click <b>+ Alert</b> to create the first one.</div>`;
    return;
  }
  box.innerHTML = ALERTS.map(a => {
    const rt = a.runtime || {};
    const badge = !a.enabled ? ["off", "OFF"]
      : a.status === "fired" ? ["fired", "FIRED"]
      : a.status === "expired" ? ["expired", "EXPIRED"]
      : ["active", "ACTIVE"];
    const live = rt.lastError
      ? `<span class="err">⚠ ${esc(rt.lastError)}</span>`
      : rt.leftValue !== undefined
        ? `<span class="lv">${esc(describeOperandUI(a.left))} = ${fmt(rt.leftValue)}</span>
           <span class="pr">target ${fmt(rt.rightValue)}</span>
           <span class="pr">px ${fmt(rt.lastPrice)}</span>`
        : `<span class="pr">waiting for first check…</span>`;
    return `<div class="acard" data-id="${a.id}" title="Click to show on chart">
      <div class="acard-top">
        <div class="acard-cond"><span class="sym">${esc(a.symbol)}</span> ${esc(a.resolution)} · ${esc(describeOperandUI(a.left))} ${OP_TXT[a.op] || a.op} ${esc(describeOperandUI(a.right))}</div>
        <span class="badge badge-${badge[0]}">${badge[1]}</span>
      </div>
      ${a.message ? `<div class="acard-msg">“${esc(a.message)}”</div>` : ""}
      <div class="acard-live">${live}</div>
      <div class="acard-foot">
        <span class="acard-meta">${a.trigger === "once" ? "fires once" : a.trigger === "once_per_bar" ? "once per bar" : "every time"}${a.channels && a.channels.telegram ? " · 📱" : ""}</span>
        <div class="acard-actions">
          <label class="toggle" title="On / Off"><input type="checkbox" ${a.enabled ? "checked" : ""} data-act="toggle"><span class="tr"></span></label>
          <button class="icon-btn" data-act="edit" title="Edit">✎</button>
          <button class="icon-btn" data-act="del" title="Delete">🗑</button>
        </div>
      </div>
    </div>`;
  }).join("");

  box.querySelectorAll(".acard").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]") || e.target.closest(".toggle")) return;
      const a = ALERTS.find(x => x.id === card.dataset.id);
      if (!a) return;
      const target = a.right.kind === "value" ? Number(a.right.value) : null;
      setChart(a.symbol, a.resolution, a.left, target);
    });
  });
  box.querySelectorAll("[data-act]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = e.target.closest(".acard").dataset.id;
      const alert = ALERTS.find(a => a.id === id);
      const act = el.dataset.act;
      if (act === "toggle") {
        await api(`/api/alerts/${id}/toggle`, { method: "POST", body: "{}" });
        refreshAlerts();
      } else if (act === "edit") {
        openModal(alert);
      } else if (act === "del") {
        if (confirm(`Delete alert on ${alert.symbol}?`)) {
          await api(`/api/alerts/${id}`, { method: "DELETE" });
          refreshAlerts();
        }
      }
    });
  });
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
  document.title = "CautionTrading — Charts & Alerts";
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
      updateQuote();
      if (!$("symbol-modal").classList.contains("hidden")) renderSymbolList();
    }
  } catch { /* ignore */ }
}

// ==================== BOOT ====================

async function boot() {
  META = await api("/api/meta");

  // interval pills
  $("interval-pills").innerHTML = META.resolutions
    .map(r => `<button class="pill ${r === chartCfg.resolution ? "active" : ""}" data-res="${r}">${r}</button>`).join("");
  document.querySelectorAll("#interval-pills .pill").forEach(p => {
    p.addEventListener("click", () => setChart(chartCfg.symbol, p.dataset.res, chartCfg.spec, chartCfg.target));
  });

  // form selects
  $("f-resolution").innerHTML = META.resolutions.map(r => `<option value="${r}">${r}</option>`).join("");
  $("f-resolution").value = "5m";
  $("f-op").innerHTML = Object.entries(META.ops).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

  const indCount = Object.keys(META.indicators).length;
  $("ind-count").textContent = `· ${indCount} indicators available`;

  // pickers
  leftPicker = makeIndicatorPicker("ip-left", "rsi", () => { renderParams("left"); schedulePreview(); updateChartFromForm(); });
  rightPicker = makeIndicatorPicker("ip-right", "ema", () => { renderParams("right"); schedulePreview(); });
  renderParams("left");
  renderParams("right");

  initChart();
  refreshChart();
  loadSymbols();
  loadTickers();
  refreshAlerts();
  refreshFired();
  loadSettings();
  connectStream();

  setInterval(refreshChart, 2000);
  setInterval(refreshAlerts, 3000);
  setInterval(refreshFired, 10000);
  setInterval(loadTickers, 15000);
}

// ==================== WIRING ====================

$("symbol-btn").addEventListener("click", () => openSymbolModal("chart"));
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

document.querySelectorAll(".stab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".stab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("alerts-list").classList.toggle("hidden", t.dataset.tab !== "alerts");
    $("fired-list").classList.toggle("hidden", t.dataset.tab !== "log");
  });
});

$("f-right-kind").addEventListener("change", () => { syncRightKind(); schedulePreview(); updateChartFromForm(); });
["f-resolution", "f-op", "f-right-value"].forEach(id => $(id).addEventListener("change", () => { schedulePreview(); updateChartFromForm(); }));
$("f-right-value").addEventListener("input", () => { schedulePreview(); });

boot();
