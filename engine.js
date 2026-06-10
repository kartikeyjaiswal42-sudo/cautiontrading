// CautionTrading — alert evaluation engine
// An alert looks like:
// {
//   id, symbol, resolution,                       // e.g. "BTCUSD", "5m"
//   left:  { type:"rsi", params:{length:14}, source:"close", output:null },
//   op:    "cross_up" | "cross_down" | "cross" | "gt" | "lt",
//   right: { kind:"value", value:70 }  OR  { kind:"indicator", spec:{...} },
//   trigger: "once" | "once_per_bar" | "every",   // every = max 1 fire/min
//   message, expiresAt (ms epoch or null), channels:{app,telegram},
//   enabled, status: "active"|"fired"|"expired"
// }

const { computeSeries } = require("./indicators");

const OPS = {
  cross_up: { label: "Crossing Up (above)" },
  cross_down: { label: "Crossing Down (below)" },
  cross: { label: "Crossing (any direction)" },
  gt: { label: "Greater Than" },
  lt: { label: "Less Than" },
};

const EVERY_COOLDOWN_MS = 60 * 1000;

function buildRightSeries(alert, candles, leftLen) {
  if (alert.right.kind === "value") {
    return new Array(leftLen).fill(Number(alert.right.value));
  }
  return computeSeries(alert.right.spec, candles);
}

function lastValid(series, beforeIdx) {
  for (let i = beforeIdx; i >= 0; i--) {
    if (!Number.isNaN(series[i])) return { v: series[i], i };
  }
  return null;
}

// Evaluate one alert against candles (ascending). state = mutable runtime
// state for this alert: { lastAbove, lastBarFired, lastFiredAt }.
// Returns { fired, leftValue, rightValue, barTime, reason }
function evaluateAlert(alert, candles, state, nowMs) {
  const resSec = resolutionSeconds(alert.resolution);
  let cs = candles;

  // "once per bar close" mode evaluates only fully closed candles
  if (alert.trigger === "once_per_bar") {
    const nowSec = Math.floor(nowMs / 1000);
    cs = candles.filter(c => c.time + resSec <= nowSec);
  }
  if (cs.length < 3) return { fired: false, reason: "not enough data" };

  const left = computeSeries(alert.left, cs);
  const right = buildRightSeries(alert, cs, left.length);

  const i = cs.length - 1;
  const cur = { l: left[i], r: right[i] };
  if (Number.isNaN(cur.l) || Number.isNaN(cur.r)) {
    return { fired: false, leftValue: cur.l, rightValue: cur.r, reason: "indicator warming up" };
  }

  // previous comparable pair (skip NaN)
  let prev = null;
  for (let j = i - 1; j >= 0; j--) {
    if (!Number.isNaN(left[j]) && !Number.isNaN(right[j])) { prev = { l: left[j], r: right[j] }; break; }
  }

  const above = cur.l > cur.r;
  const prevAbove = prev ? prev.l > prev.r : null;

  let conditionMet = false;
  switch (alert.op) {
    case "cross_up":
      conditionMet = prevAbove === false && above;
      break;
    case "cross_down":
      conditionMet = prevAbove === true && !above && cur.l !== cur.r;
      break;
    case "cross":
      conditionMet = prevAbove !== null && prevAbove !== above && (above || cur.l !== cur.r);
      break;
    case "gt":
      // edge-trigger: fire when it BECOMES true (state-based so it also
      // fires if it was already true when the alert was created)
      conditionMet = above && state.lastAbove !== true;
      break;
    case "lt":
      conditionMet = cur.l < cur.r && state.lastAbove !== false;
      break;
    default:
      return { fired: false, reason: `unknown operator ${alert.op}` };
  }

  // remember comparison state for gt/lt edge triggering
  if (cur.l > cur.r) state.lastAbove = true;
  else if (cur.l < cur.r) state.lastAbove = false;

  const barTime = cs[i].time;
  let fired = conditionMet;

  if (fired && alert.trigger === "once_per_bar" && state.lastBarFired === barTime) fired = false;
  if (fired && alert.trigger === "every" && state.lastFiredAt && nowMs - state.lastFiredAt < EVERY_COOLDOWN_MS) fired = false;

  if (fired) {
    state.lastBarFired = barTime;
    state.lastFiredAt = nowMs;
  }

  return { fired, leftValue: cur.l, rightValue: cur.r, barTime };
}

function resolutionSeconds(res) {
  const m = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "1d": 86400 };
  return m[res] || 300;
}

// Bars needed for the slowest indicator to warm up, with margin
function barsNeeded(alert) {
  let need = 60;
  const scan = (spec) => {
    if (!spec || !spec.params) return;
    for (const v of Object.values(spec.params)) {
      const n = Number(v);
      if (Number.isFinite(n)) need = Math.max(need, n * 5);
    }
  };
  scan(alert.left);
  if (alert.right && alert.right.kind === "indicator") scan(alert.right.spec);
  return Math.min(Math.max(need, 120), 2000);
}

module.exports = { OPS, evaluateAlert, resolutionSeconds, barsNeeded };
