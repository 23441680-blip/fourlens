// marketdata.js — 真实行情源
// 默认主源：Yahoo Finance chart meta（零 key，含价格+市值+PE+股息率+Beta+52周高低）
// 可选增强：Finnhub（需免费 key，补 sector/industry/description，且更稳定）
// 兜底：模型自身知识（由 server.js 标注）
// 输出结构对齐 server.js 的 marketContextText，前端无需改动。

const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

function fmtCap(n) {
  if (n == null) return null;
  const v = Number(n);
  if (!isFinite(v)) return null;
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}

// ---------- Yahoo chart meta（零 key） ----------
export function mapYahooMeta(ticker, meta) {
  const out = { symbol: ticker, source: "yahoo", price: null, currency: null, previousClose: null, stats: {}, profile: {} };
  if (!meta) return out;
  out.price = meta.regularMarketPrice ?? null;
  out.currency = meta.currency ?? null;
  out.previousClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
  if (meta.marketCap != null) out.stats.marketCap = fmtCap(meta.marketCap);
  if (meta.trailingPe != null) out.stats.trailingPE = String(meta.trailingPe);
  if (meta.forwardPe != null) out.stats.forwardPE = String(meta.forwardPe);
  if (meta.dividendYield != null) out.stats.dividendYield = `${Number(meta.dividendYield).toFixed(2)}%`;
  if (meta.beta != null) out.stats.beta = String(meta.beta);
  if (meta.fiftyTwoWeekHigh != null) out.stats.fiftyTwoWeekHigh = String(meta.fiftyTwoWeekHigh);
  if (meta.fiftyTwoWeekLow != null) out.stats.fiftyTwoWeekLow = String(meta.fiftyTwoWeekLow);
  return out;
}

async function yahooFetch(sym) {
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`, {
        headers: { "User-Agent": UA },
      });
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice != null) return meta;
    } catch {
      /* try next host */
    }
  }
  return null;
}

// ---------- Finnhub（可选增强） ----------
export function mapFinnhub(ticker, { quote, profile, metric }) {
  const out = { symbol: ticker, source: "finnhub", price: null, currency: null, previousClose: null, stats: {}, profile: {} };
  if (quote && quote.c != null) {
    out.price = quote.c;
    out.previousClose = quote.pc ?? null;
  }
  if (profile) {
    out.currency = profile.currency || "USD";
    out.profile.sector = profile.sector || null;
    out.profile.industry = profile.industry || null;
    out.profile.summary = (profile.description || "").slice(0, 500);
    out.stats.marketCap = fmtCap(profile.marketCapitalization * 1e6);
  }
  const m = metric?.metric || {};
  if (m.peTTM != null) out.stats.trailingPE = String(m.peTTM);
  if (m.peForward != null) out.stats.forwardPE = String(m.peForward);
  if (m.dividendYieldIndicatedAnnual != null) out.stats.dividendYield = `${Number(m.dividendYieldIndicatedAnnual).toFixed(2)}%`;
  if (m.beta != null) out.stats.beta = String(m.beta);
  if (m["52WeekHigh"] != null) out.stats.fiftyTwoWeekHigh = String(m["52WeekHigh"]);
  if (m["52WeekLow"] != null) out.stats.fiftyTwoWeekLow = String(m["52WeekLow"]);
  return out;
}

async function finnhub(path, key) {
  const r = await fetch(`${FINNHUB_BASE}${path}`, { headers: { "X-Finnhub-Token": key } });
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  return r.json();
}

async function finnhubFetch(sym, key) {
  try {
    const [q, p, mt] = await Promise.allSettled([
      finnhub(`/quote?symbol=${sym}`, key),
      finnhub(`/stock/profile2?symbol=${sym}`, key),
      finnhub(`/stock/metric?symbol=${sym}&metric=all`, key),
    ]);
    const quote = q.status === "fulfilled" ? q.value : null;
    const profile = p.status === "fulfilled" ? p.value : null;
    const metric = mt.status === "fulfilled" ? mt.value : null;
    if (quote?.c != null) return mapFinnhub(sym, { quote, profile, metric });
  } catch {
    /* fall through to Yahoo */
  }
  return null;
}

// ---------- 统一入口 ----------
export function makeMarketDataFetcher(env = process.env) {
  const fhKey = (env.FINNHUB_API_KEY || "").trim();
  return async function fetchMarketData(ticker) {
    const sym = ticker.replace(/\./g, "-").toUpperCase();
    const empty = { symbol: ticker, source: "model-knowledge", price: null, currency: null, previousClose: null, stats: {}, profile: {} };

    // 1) 有 Finnhub key → 用它（更全更稳）
    if (fhKey && fhKey !== "demo") {
      const f = await finnhubFetch(sym, fhKey);
      if (f && f.price != null) return f;
    }
    // 2) 零 key 主源：Yahoo chart meta
    const meta = await yahooFetch(sym);
    if (meta) return mapYahooMeta(ticker, meta);
    // 3) 兜底：模型知识
    return empty;
  };
}
