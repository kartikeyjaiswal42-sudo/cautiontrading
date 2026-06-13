// CautionTrading — Indian market data (NSE indices + F&O stocks) via Yahoo Finance.
// Symbols are namespaced "NSE:RELIANCE", "NSE:NIFTY".
// NSE's own API actively blocks bots (Akamai), so spot data comes from Yahoo —
// reliable and keyless. Strike-level option chains need a broker API key (phase 2).

// NOTE: Yahoo 429s a full Chrome UA coming from a non-browser client
// (UA/TLS fingerprint mismatch) but accepts a generic UA. Don't "upgrade" this.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const INDICES = [
  { sym: "NIFTY", y: "^NSEI", name: "NIFTY 50 Index" },
  { sym: "BANKNIFTY", y: "^NSEBANK", name: "NIFTY Bank Index" },
  { sym: "FINNIFTY", y: "NIFTY_FIN_SERVICE.NS", name: "NIFTY Financial Services" },
  { sym: "MIDCPNIFTY", y: "NIFTY_MID_SELECT.NS", name: "NIFTY Midcap Select" },
  { sym: "SENSEX", y: "^BSESN", name: "BSE SENSEX" },
];

// NSE F&O-listed stocks (underlyings for futures & options). Editable list —
// anything missing is still reachable through the search box (any NSE stock).
const FO_STOCKS = [
  "RELIANCE","TCS","HDFCBANK","ICICIBANK","INFY","SBIN","BHARTIARTL","ITC","KOTAKBANK","LT",
  "AXISBANK","HINDUNILVR","BAJFINANCE","MARUTI","SUNPHARMA","TITAN","ULTRACEMCO","TATAMOTORS","TATASTEEL","WIPRO",
  "HCLTECH","TECHM","POWERGRID","NTPC","ONGC","COALINDIA","ADANIENT","ADANIPORTS","ASIANPAINT","BAJAJFINSV",
  "BAJAJ-AUTO","BPCL","BRITANNIA","CIPLA","DIVISLAB","DRREDDY","EICHERMOT","GRASIM","HDFCLIFE","HEROMOTOCO",
  "HINDALCO","INDUSINDBK","JSWSTEEL","M&M","NESTLEIND","SBILIFE","SHRIRAMFIN","TATACONSUM","APOLLOHOSP","LTIM",
  "TRENT","BEL","ETERNAL","JIOFIN","ABB","ACC","ADANIGREEN","ADANIENSOL","ALKEM","AMBUJACEM",
  "APOLLOTYRE","ASHOKLEY","ASTRAL","AUBANK","AUROPHARMA","BALKRISIND","BANDHANBNK","BANKBARODA","BANKINDIA","BERGEPAINT",
  "BHARATFORG","BHEL","BIOCON","BOSCHLTD","BSOFT","CANBK","CDSL","CESC","CGPOWER","CHAMBLFERT",
  "CHOLAFIN","COFORGE","COLPAL","CONCOR","CROMPTON","CUMMINSIND","DABUR","DALBHARAT","DEEPAKNTR","DELHIVERY",
  "DIXON","DLF","DMART","EXIDEIND","FEDERALBNK","GAIL","GLENMARK","GMRAIRPORT","GODREJCP","GODREJPROP",
  "GRANULES","GUJGASLTD","HAL","HAVELLS","HDFCAMC","HFCL","HINDCOPPER","HINDPETRO","HUDCO","ICICIGI",
  "ICICIPRULI","IDEA","IDFCFIRSTB","IEX","IGL","INDHOTEL","INDIANB","INDIGO","INDUSTOWER","IOC",
  "IRCTC","IRFC","JINDALSTEL","JKCEMENT","JSWENERGY","JUBLFOOD","KALYANKJIL","KEI","KPITTECH","LAURUSLABS",
  "LICHSGFIN","LICI","LODHA","LTF","LUPIN","MANAPPURAM","MARICO","MAXHEALTH","MCX","MFSL",
  "MGL","MOTHERSON","MPHASIS","MRF","MUTHOOTFIN","NATIONALUM","NAUKRI","NAVINFLUOR","NBCC","NCC",
  "NHPC","NMDC","NYKAA","OBEROIRLTY","OFSS","OIL","PAGEIND","PAYTM","PEL","PERSISTENT",
  "PETRONET","PFC","PIDILITIND","PIIND","PNB","POLICYBZR","POLYCAB","POONAWALLA","PRESTIGE","PVRINOX",
  "RAMCOCEM","RBLBANK","RECLTD","SAIL","SBICARD","SHREECEM","SIEMENS","SJVN","SOLARINDS","SONACOMS",
  "SRF","SUPREMEIND","SYNGENE","TATACHEM","TATACOMM","TATAELXSI","TATAPOWER","TIINDIA","TORNTPHARM","TORNTPOWER",
  "TVSMOTOR","UNIONBANK","UNITDSPR","UPL","VBL","VEDL","VOLTAS","YESBANK","ZYDUSLIFE","CAMS",
  "ANGELONE","BDL","MAZDOCK","COCHINSHIP","RVNL","TITAGARH","UNOMINDA","PHOENIXLTD","KAYNES","BLUESTARCO",
  "MANKIND","UBL","OLAELEC","SWIGGY","TATATECH","BAJAJHLDNG","JSL","APLAPOLLO","MOTILALOFS","IIFL",
];

// Yahoo intervals: NSE charts use the natively supported set (session-aligned bars,
// so values match broker/TradingView charts). 3m/2h/4h are crypto-only.
const RES_MAP = {
  "1m": { i: "1m", range: "5d" },
  "5m": { i: "5m", range: "1mo" },
  "15m": { i: "15m", range: "1mo" },
  "30m": { i: "30m", range: "1mo" },
  "1h": { i: "60m", range: "3mo" },
  "1d": { i: "1d", range: "2y" },
};
const RESOLUTIONS = Object.keys(RES_MAP);

function isIndia(symbol) { return typeof symbol === "string" && symbol.startsWith("NSE:"); }

function yahooSym(nseSym) {
  const idx = INDICES.find(i => i.sym === nseSym);
  if (idx) return idx.y;
  return `${nseSym}.NS`;
}

// gentle global throttle — Yahoo 429s burst traffic; one request every 350ms is safe
let lastYahooCall = 0;
async function yfetch(pathAndQuery) {
  const wait = lastYahooCall + 350 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastYahooCall = Date.now();
  let lastErr;
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      const res = await fetch(`https://${host}${pathAndQuery}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.status === 429) { lastErr = new Error("Yahoo rate limit"); continue; }
      if (!res.ok) { lastErr = new Error(`Yahoo HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Yahoo unreachable");
}

const chartCache = new Map(); // key -> {at, candles, meta}
const inFlight = new Map();   // key -> Promise (dedupe concurrent fetches)

async function fetchChart(nseSym, resolution) {
  const rm = RES_MAP[resolution];
  if (!rm) throw new Error(`Interval ${resolution} not available for Indian symbols (use ${RESOLUTIONS.join("/")})`);
  const key = `${nseSym}|${resolution}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    try {
      const y = encodeURIComponent(yahooSym(nseSym));
      const d = await yfetch(`/v8/finance/chart/${y}?interval=${rm.i}&range=${rm.range}`);
      const r = d.chart && d.chart.result && d.chart.result[0];
      if (!r) throw new Error((d.chart && d.chart.error && d.chart.error.description) || "no data");
      const q = r.indicators.quote[0];
      const ts = r.timestamp || [];
      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.close[i] === null || q.close[i] === undefined) continue;
        candles.push({
          time: ts[i],
          open: q.open[i] ?? q.close[i],
          high: q.high[i] ?? q.close[i],
          low: q.low[i] ?? q.close[i],
          close: q.close[i],
          volume: q.volume ? (q.volume[i] || 0) : 0,
        });
      }
      const entry = { at: Date.now(), candles, meta: r.meta || {} };
      chartCache.set(key, entry);
      return entry;
    } catch (e) {
      // serve stale data (up to 10 min) instead of failing during rate limits
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
      throw e;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

async function getCandles(symbol, resolution, bars) {
  const nseSym = symbol.slice(4);
  const { candles } = await fetchChart(nseSym, resolution);
  return candles.slice(-Math.max(bars, 10));
}

// price / day stats for the stats strip
async function getQuote(symbol) {
  const nseSym = symbol.slice(4);
  const { candles, meta } = await fetchChart(nseSym, "1d");
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = meta.regularMarketPrice ?? (last && last.close);
  // NOTE: meta.chartPreviousClose = close before the RANGE start (2y ago here),
  // not yesterday — use the second-last daily candle for the real prev close.
  const prevClose = prev ? prev.close : null;
  return {
    price,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    high: last ? last.high : null,
    low: last ? last.low : null,
    volume: last ? last.volume : null,
    prevClose,
    currency: "INR",
  };
}

function listSymbols() {
  return [
    ...INDICES.map(i => ({ symbol: `NSE:${i.sym}`, description: i.name, type: "index", src: "nse" })),
    ...FO_STOCKS.map(s => ({ symbol: `NSE:${s}`, description: "NSE F&O stock", type: "stock", src: "nse" })),
  ];
}

// search ANY Indian stock (covers names not in the F&O list)
async function search(q) {
  const d = await yfetch(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`);
  return (d.quotes || [])
    .filter(x => x.symbol && (x.symbol.endsWith(".NS") || x.symbol.startsWith("^NSE") || x.symbol.endsWith(".BO") === false))
    .filter(x => x.symbol.endsWith(".NS"))
    .map(x => ({
      symbol: `NSE:${x.symbol.replace(/\.NS$/, "")}`,
      description: x.shortname || x.longname || "NSE",
      type: (x.quoteType || "stock").toLowerCase(),
      src: "nse",
    }));
}

module.exports = { isIndia, getCandles, getQuote, listSymbols, search, RESOLUTIONS };
