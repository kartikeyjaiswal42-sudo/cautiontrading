// CautionTrading — technical indicator library
// All functions take candles (ascending by time) and return arrays aligned
// with the candles (leading values are NaN until enough data exists).
// Formulas follow the standard TradingView/Wilder definitions.

// ---------- primitive helpers ----------

function src(candles, source) {
  switch (source) {
    case "open": return candles.map(c => c.open);
    case "high": return candles.map(c => c.high);
    case "low": return candles.map(c => c.low);
    case "hl2": return candles.map(c => (c.high + c.low) / 2);
    case "hlc3": return candles.map(c => (c.high + c.low + c.close) / 3);
    case "ohlc4": return candles.map(c => (c.open + c.high + c.low + c.close) / 4);
    case "close":
    default: return candles.map(c => c.close);
  }
}

function nanArray(n) { return new Array(n).fill(NaN); }

function sma(values, len) {
  // windowed (not rolling-sum) so leading NaNs don't poison later values
  const out = nanArray(values.length);
  for (let i = len - 1; i < values.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = values[i - j];
      if (Number.isNaN(v)) { ok = false; break; }
      s += v;
    }
    if (ok) out[i] = s / len;
  }
  return out;
}

function ema(values, len) {
  const out = nanArray(values.length);
  const k = 2 / (len + 1);
  let prev = NaN;
  let warm = 0, warmSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      warmSum += v; warm++;
      if (warm === len) { prev = warmSum / len; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder's smoothing (RMA) — used by RSI, ATR, ADX
function rma(values, len) {
  const out = nanArray(values.length);
  let prev = NaN;
  let warm = 0, warmSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      warmSum += v; warm++;
      if (warm === len) { prev = warmSum / len; out[i] = prev; }
    } else {
      prev = (prev * (len - 1) + v) / len;
      out[i] = prev;
    }
  }
  return out;
}

function wma(values, len) {
  const out = nanArray(values.length);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < values.length; i++) {
    let s = 0;
    for (let j = 0; j < len; j++) s += values[i - j] * (len - j);
    out[i] = s / denom;
  }
  return out;
}

function hma(values, len) {
  const half = wma(values, Math.max(1, Math.round(len / 2)));
  const full = wma(values, len);
  const diff = values.map((_, i) => 2 * half[i] - full[i]);
  return wma(diff, Math.max(1, Math.round(Math.sqrt(len))));
}

function stdev(values, len) {
  const out = nanArray(values.length);
  for (let i = len - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = 0; j < len; j++) mean += values[i - j];
    mean /= len;
    let v = 0;
    for (let j = 0; j < len; j++) v += (values[i - j] - mean) ** 2;
    out[i] = Math.sqrt(v / len);
  }
  return out;
}

function highest(values, len) {
  const out = nanArray(values.length);
  for (let i = len - 1; i < values.length; i++) {
    let h = -Infinity;
    for (let j = 0; j < len; j++) h = Math.max(h, values[i - j]);
    out[i] = h;
  }
  return out;
}

function lowest(values, len) {
  const out = nanArray(values.length);
  for (let i = len - 1; i < values.length; i++) {
    let l = Infinity;
    for (let j = 0; j < len; j++) l = Math.min(l, values[i - j]);
    out[i] = l;
  }
  return out;
}

function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

// ---------- indicators ----------

function rsi(candles, { length = 14, source = "close" }) {
  const v = src(candles, source);
  const gains = nanArray(v.length), losses = nanArray(v.length);
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gains[i] = Math.max(d, 0);
    losses[i] = Math.max(-d, 0);
  }
  const ag = rma(gains, length), al = rma(losses, length);
  return v.map((_, i) => {
    if (Number.isNaN(ag[i]) || Number.isNaN(al[i])) return NaN;
    if (al[i] === 0) return 100;
    return 100 - 100 / (1 + ag[i] / al[i]);
  });
}

function macd(candles, { fast = 12, slow = 26, signal = 9, source = "close" }) {
  const v = src(candles, source);
  const f = ema(v, fast), s = ema(v, slow);
  const line = v.map((_, i) => f[i] - s[i]);
  const sig = ema(line, signal);
  const hist = line.map((x, i) => x - sig[i]);
  return { macd: line, signal: sig, hist };
}

function bollinger(candles, { length = 20, mult = 2, source = "close" }) {
  const v = src(candles, source);
  const basis = sma(v, length);
  const dev = stdev(v, length);
  return {
    basis,
    upper: basis.map((b, i) => b + mult * dev[i]),
    lower: basis.map((b, i) => b - mult * dev[i]),
  };
}

function stochastic(candles, { kLength = 14, kSmooth = 3, dSmooth = 3 }) {
  const hh = highest(candles.map(c => c.high), kLength);
  const ll = lowest(candles.map(c => c.low), kLength);
  const raw = candles.map((c, i) => {
    const range = hh[i] - ll[i];
    return range === 0 ? 50 : ((c.close - ll[i]) / range) * 100;
  });
  const k = sma(raw, kSmooth);
  const d = sma(k, dSmooth);
  return { k, d };
}

function stochRsi(candles, { rsiLength = 14, stochLength = 14, kSmooth = 3, dSmooth = 3, source = "close" }) {
  const r = rsi(candles, { length: rsiLength, source });
  const hh = highest(r, stochLength), ll = lowest(r, stochLength);
  const raw = r.map((x, i) => {
    const range = hh[i] - ll[i];
    if (Number.isNaN(range)) return NaN;
    return range === 0 ? 50 : ((x - ll[i]) / range) * 100;
  });
  const k = sma(raw, kSmooth);
  const d = sma(k, dSmooth);
  return { k, d };
}

function atr(candles, { length = 14 }) {
  return rma(trueRange(candles), length);
}

function adx(candles, { length = 14 }) {
  const n = candles.length;
  const plusDM = nanArray(n), minusDM = nanArray(n);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = rma(trueRange(candles), length);
  const pdi = rma(plusDM, length).map((x, i) => tr[i] ? (100 * x) / tr[i] : NaN);
  const mdi = rma(minusDM, length).map((x, i) => tr[i] ? (100 * x) / tr[i] : NaN);
  const dx = pdi.map((p, i) => {
    const m = mdi[i];
    if (Number.isNaN(p) || Number.isNaN(m) || p + m === 0) return NaN;
    return (100 * Math.abs(p - m)) / (p + m);
  });
  return { adx: rma(dx, length), plusDI: pdi, minusDI: mdi };
}

function cci(candles, { length = 20 }) {
  const tp = src(candles, "hlc3");
  const ma = sma(tp, length);
  const out = nanArray(tp.length);
  for (let i = length - 1; i < tp.length; i++) {
    let md = 0;
    for (let j = 0; j < length; j++) md += Math.abs(tp[i - j] - ma[i]);
    md /= length;
    out[i] = md === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * md);
  }
  return out;
}

function williamsR(candles, { length = 14 }) {
  const hh = highest(candles.map(c => c.high), length);
  const ll = lowest(candles.map(c => c.low), length);
  return candles.map((c, i) => {
    const range = hh[i] - ll[i];
    if (Number.isNaN(range)) return NaN;
    return range === 0 ? -50 : ((hh[i] - c.close) / range) * -100;
  });
}

function mfi(candles, { length = 14 }) {
  const tp = src(candles, "hlc3");
  const n = candles.length;
  const pos = nanArray(n), neg = nanArray(n);
  for (let i = 1; i < n; i++) {
    const flow = tp[i] * candles[i].volume;
    pos[i] = tp[i] > tp[i - 1] ? flow : 0;
    neg[i] = tp[i] < tp[i - 1] ? flow : 0;
  }
  const out = nanArray(n);
  let ps = 0, ns = 0;
  for (let i = 1; i < n; i++) {
    ps += pos[i]; ns += neg[i];
    if (i > length) { ps -= pos[i - length]; ns -= neg[i - length]; }
    if (i >= length) out[i] = ns === 0 ? 100 : 100 - 100 / (1 + ps / ns);
  }
  return out;
}

function roc(candles, { length = 9, source = "close" }) {
  const v = src(candles, source);
  return v.map((x, i) => (i < length ? NaN : ((x - v[i - length]) / v[i - length]) * 100));
}

function momentum(candles, { length = 10, source = "close" }) {
  const v = src(candles, source);
  return v.map((x, i) => (i < length ? NaN : x - v[i - length]));
}

function obv(candles) {
  const out = nanArray(candles.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) acc += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) acc -= candles[i].volume;
    out[i] = acc;
  }
  return out;
}

// VWAP anchored to each UTC day (session VWAP, like TradingView's default)
function vwap(candles) {
  const out = nanArray(candles.length);
  let cumPV = 0, cumV = 0, day = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.time / 86400);
    if (d !== day) { day = d; cumPV = 0; cumV = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
    out[i] = cumV === 0 ? tp : cumPV / cumV;
  }
  return out;
}

function supertrend(candles, { length = 10, mult = 3 }) {
  const a = atr(candles, { length });
  const n = candles.length;
  const line = nanArray(n);       // the supertrend line itself
  const direction = nanArray(n);  // +1 bullish (line below price), -1 bearish
  let prevUpper = NaN, prevLower = NaN, prevDir = 1, prevLine = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    let upper = mid + mult * a[i];
    let lower = mid - mult * a[i];
    const pc = i > 0 ? candles[i - 1].close : candles[i].close;
    if (!Number.isNaN(prevUpper)) {
      upper = upper < prevUpper || pc > prevUpper ? upper : prevUpper;
      lower = lower > prevLower || pc < prevLower ? lower : prevLower;
    }
    let dir = prevDir;
    if (Number.isNaN(prevLine)) dir = 1;
    else if (prevLine === prevUpper) dir = candles[i].close > upper ? 1 : -1;
    else dir = candles[i].close < lower ? -1 : 1;
    line[i] = dir === 1 ? lower : upper;
    direction[i] = dir;
    prevUpper = upper; prevLower = lower; prevDir = dir; prevLine = line[i];
  }
  return { line, direction };
}

function psar(candles, { start = 0.02, increment = 0.02, max = 0.2 }) {
  const n = candles.length;
  const out = nanArray(n);
  if (n < 2) return out;
  let bull = candles[1].close >= candles[0].close;
  let af = start;
  let ep = bull ? candles[0].high : candles[0].low;
  let sar = bull ? candles[0].low : candles[0].high;
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (bull) {
      sar = Math.min(sar, candles[i - 1].low, i >= 2 ? candles[i - 2].low : candles[i - 1].low);
      if (candles[i].high > ep) { ep = candles[i].high; af = Math.min(af + increment, max); }
      if (candles[i].low < sar) { bull = false; sar = ep; ep = candles[i].low; af = start; }
    } else {
      sar = Math.max(sar, candles[i - 1].high, i >= 2 ? candles[i - 2].high : candles[i - 1].high);
      if (candles[i].low < ep) { ep = candles[i].low; af = Math.min(af + increment, max); }
      if (candles[i].high > sar) { bull = true; sar = ep; ep = candles[i].high; af = start; }
    }
    out[i] = sar;
  }
  return out;
}

function ichimoku(candles, { conversion = 9, base = 26, spanB = 52 }) {
  const mid = (len) => {
    const hh = highest(candles.map(c => c.high), len);
    const ll = lowest(candles.map(c => c.low), len);
    return hh.map((h, i) => (h + ll[i]) / 2);
  };
  const conv = mid(conversion);
  const baseL = mid(base);
  const rawA = conv.map((c, i) => (c + baseL[i]) / 2);
  const rawB = mid(spanB);
  // spans are plotted `base` bars ahead → the cloud value AT bar i was computed `base` bars ago
  const shift = (arr) => arr.map((_, i) => (i >= base ? arr[i - base] : NaN));
  return { conversion: conv, base: baseL, spanA: shift(rawA), spanB: shift(rawB) };
}

function keltner(candles, { length = 20, mult = 2, source = "close" }) {
  const basis = ema(src(candles, source), length);
  const a = atr(candles, { length });
  return {
    basis,
    upper: basis.map((b, i) => b + mult * a[i]),
    lower: basis.map((b, i) => b - mult * a[i]),
  };
}

function donchian(candles, { length = 20 }) {
  const upper = highest(candles.map(c => c.high), length);
  const lower = lowest(candles.map(c => c.low), length);
  return { upper, lower, mid: upper.map((u, i) => (u + lower[i]) / 2) };
}

// ---------- registry (drives both the engine and the UI form) ----------

const SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

const INDICATORS = {
  price: {
    label: "Price",
    params: [],
    source: true,
    outputs: null,
    compute: (c, p) => src(c, p.source || "close"),
  },
  volume: {
    label: "Volume",
    params: [],
    outputs: null,
    compute: (c) => c.map(x => x.volume),
  },
  rsi: {
    label: "RSI (Relative Strength Index)",
    params: [{ name: "length", label: "Length", def: 14 }],
    source: true,
    outputs: null,
    compute: rsi,
  },
  sma: {
    label: "SMA (Simple Moving Average)",
    params: [{ name: "length", label: "Length", def: 20 }],
    source: true,
    outputs: null,
    compute: (c, p) => sma(src(c, p.source || "close"), p.length),
  },
  ema: {
    label: "EMA (Exponential Moving Average)",
    params: [{ name: "length", label: "Length", def: 20 }],
    source: true,
    outputs: null,
    compute: (c, p) => ema(src(c, p.source || "close"), p.length),
  },
  wma: {
    label: "WMA (Weighted Moving Average)",
    params: [{ name: "length", label: "Length", def: 20 }],
    source: true,
    outputs: null,
    compute: (c, p) => wma(src(c, p.source || "close"), p.length),
  },
  hma: {
    label: "HMA (Hull Moving Average)",
    params: [{ name: "length", label: "Length", def: 20 }],
    source: true,
    outputs: null,
    compute: (c, p) => hma(src(c, p.source || "close"), p.length),
  },
  vwap: {
    label: "VWAP (Volume Weighted Avg Price)",
    params: [],
    outputs: null,
    compute: vwap,
  },
  macd: {
    label: "MACD",
    params: [
      { name: "fast", label: "Fast length", def: 12 },
      { name: "slow", label: "Slow length", def: 26 },
      { name: "signal", label: "Signal length", def: 9 },
    ],
    source: true,
    outputs: [
      { name: "macd", label: "MACD line" },
      { name: "signal", label: "Signal line" },
      { name: "hist", label: "Histogram" },
    ],
    compute: macd,
  },
  bb: {
    label: "Bollinger Bands",
    params: [
      { name: "length", label: "Length", def: 20 },
      { name: "mult", label: "StdDev mult", def: 2, step: 0.1 },
    ],
    source: true,
    outputs: [
      { name: "upper", label: "Upper band" },
      { name: "basis", label: "Basis (middle)" },
      { name: "lower", label: "Lower band" },
    ],
    compute: bollinger,
  },
  stoch: {
    label: "Stochastic",
    params: [
      { name: "kLength", label: "%K length", def: 14 },
      { name: "kSmooth", label: "%K smoothing", def: 3 },
      { name: "dSmooth", label: "%D smoothing", def: 3 },
    ],
    outputs: [
      { name: "k", label: "%K" },
      { name: "d", label: "%D" },
    ],
    compute: stochastic,
  },
  stochrsi: {
    label: "Stochastic RSI",
    params: [
      { name: "rsiLength", label: "RSI length", def: 14 },
      { name: "stochLength", label: "Stoch length", def: 14 },
      { name: "kSmooth", label: "%K smoothing", def: 3 },
      { name: "dSmooth", label: "%D smoothing", def: 3 },
    ],
    source: true,
    outputs: [
      { name: "k", label: "%K" },
      { name: "d", label: "%D" },
    ],
    compute: stochRsi,
  },
  atr: {
    label: "ATR (Average True Range)",
    params: [{ name: "length", label: "Length", def: 14 }],
    outputs: null,
    compute: atr,
  },
  adx: {
    label: "ADX / DMI",
    params: [{ name: "length", label: "Length", def: 14 }],
    outputs: [
      { name: "adx", label: "ADX" },
      { name: "plusDI", label: "+DI" },
      { name: "minusDI", label: "−DI" },
    ],
    compute: adx,
  },
  cci: {
    label: "CCI (Commodity Channel Index)",
    params: [{ name: "length", label: "Length", def: 20 }],
    outputs: null,
    compute: cci,
  },
  willr: {
    label: "Williams %R",
    params: [{ name: "length", label: "Length", def: 14 }],
    outputs: null,
    compute: williamsR,
  },
  mfi: {
    label: "MFI (Money Flow Index)",
    params: [{ name: "length", label: "Length", def: 14 }],
    outputs: null,
    compute: mfi,
  },
  roc: {
    label: "ROC (Rate of Change %)",
    params: [{ name: "length", label: "Length", def: 9 }],
    source: true,
    outputs: null,
    compute: roc,
  },
  mom: {
    label: "Momentum",
    params: [{ name: "length", label: "Length", def: 10 }],
    source: true,
    outputs: null,
    compute: momentum,
  },
  obv: {
    label: "OBV (On Balance Volume)",
    params: [],
    outputs: null,
    compute: obv,
  },
  supertrend: {
    label: "Supertrend",
    params: [
      { name: "length", label: "ATR length", def: 10 },
      { name: "mult", label: "Multiplier", def: 3, step: 0.1 },
    ],
    outputs: [
      { name: "line", label: "Supertrend line" },
      { name: "direction", label: "Direction (+1 / −1)" },
    ],
    compute: supertrend,
  },
  psar: {
    label: "Parabolic SAR",
    params: [
      { name: "start", label: "Start", def: 0.02, step: 0.01 },
      { name: "increment", label: "Increment", def: 0.02, step: 0.01 },
      { name: "max", label: "Max", def: 0.2, step: 0.01 },
    ],
    outputs: null,
    compute: psar,
  },
  ichimoku: {
    label: "Ichimoku Cloud",
    params: [
      { name: "conversion", label: "Conversion", def: 9 },
      { name: "base", label: "Base", def: 26 },
      { name: "spanB", label: "Span B", def: 52 },
    ],
    outputs: [
      { name: "conversion", label: "Conversion (Tenkan)" },
      { name: "base", label: "Base (Kijun)" },
      { name: "spanA", label: "Leading Span A" },
      { name: "spanB", label: "Leading Span B" },
    ],
    compute: ichimoku,
  },
  keltner: {
    label: "Keltner Channels",
    params: [
      { name: "length", label: "Length", def: 20 },
      { name: "mult", label: "ATR mult", def: 2, step: 0.1 },
    ],
    source: true,
    outputs: [
      { name: "upper", label: "Upper" },
      { name: "basis", label: "Basis" },
      { name: "lower", label: "Lower" },
    ],
    compute: keltner,
  },
  donchian: {
    label: "Donchian Channels",
    params: [{ name: "length", label: "Length", def: 20 }],
    outputs: [
      { name: "upper", label: "Upper" },
      { name: "mid", label: "Middle" },
      { name: "lower", label: "Lower" },
    ],
    compute: donchian,
  },
};

// Compute one operand spec → series array.
// spec = { type, params: {…}, source, output }
function computeSeries(spec, candles) {
  const def = INDICATORS[spec.type];
  if (!def) throw new Error(`Unknown indicator: ${spec.type}`);
  const params = {};
  for (const p of def.params) {
    const raw = spec.params ? spec.params[p.name] : undefined;
    const v = Number(raw);
    params[p.name] = Number.isFinite(v) && v > 0 ? v : p.def;
  }
  if (def.source) params.source = SOURCES.includes(spec.source) ? spec.source : "close";
  const res = def.compute(candles, params);
  if (Array.isArray(res)) return res;
  // multi-output indicator → pick requested output (default = first)
  const key = spec.output && res[spec.output] ? spec.output : def.outputs[0].name;
  return res[key];
}

// Serializable indicator metadata for the UI
function indicatorMeta() {
  const out = {};
  for (const [key, def] of Object.entries(INDICATORS)) {
    out[key] = {
      label: def.label,
      params: def.params,
      source: !!def.source,
      outputs: def.outputs,
    };
  }
  return out;
}

module.exports = { INDICATORS, SOURCES, computeSeries, indicatorMeta };
