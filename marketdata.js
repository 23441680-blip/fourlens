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

// ---------- Yahoo v7 quote（补齐估值字段：PE / 市值 / 股息率 / Beta） ----------
// chart meta 经常缺失 trailingPE 等估值字段，v7/quote 稳定返回这些指标
async function yahooQuote(sym) {
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v7/finance/quote?symbols=${encodeURIComponent(sym)}`, {
        headers: { "User-Agent": UA },
      });
      if (!r.ok) continue;
      const d = await r.json();
      const q = d?.quoteResponse?.result?.[0];
      if (!q) continue;
      const out = {};
      if (q.trailingPe != null) out.trailingPE = String(q.trailingPe);
      if (q.forwardPe != null) out.forwardPE = String(q.forwardPe);
      if (q.marketCap != null) out.marketCap = fmtCap(q.marketCap);
      if (q.dividendYield != null) out.dividendYield = `${Number(q.dividendYield).toFixed(2)}%`;
      if (q.beta != null) out.beta = String(q.beta);
      return out;
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

// ---------- 名称 / 中文 → 股票代码 解析（零 key） ----------
// 常见中英别名表：保证「苹果」等一定能映射到代码，即便 Yahoo 搜索接口波动
const NAME_ALIASES = {
  "苹果": "AAPL", "apple": "AAPL",
  "英伟达": "NVDA", "nvidia": "NVDA",
  "特斯拉": "TSLA", "tesla": "TSLA",
  "微软": "MSFT", "microsoft": "MSFT",
  "谷歌": "GOOGL", "google": "GOOGL", "alphabet": "GOOGL",
  "亚马逊": "AMZN", "amazon": "AMZN",
  "脸书": "META", "meta": "META", "facebook": "META",
  "伯克希尔": "BRK-B", "berkshire": "BRK-B", "波克夏": "BRK-B",
  "腾讯": "0700.HK", "tencent": "0700.HK",
  "阿里巴巴": "BABA", "alibaba": "BABA",
  "百度": "BIDU", "baidu": "BIDU",
  "京东": "JD", "jd": "JD", "jingdong": "JD",
  "拼多多": "PDD", "pdd": "PDD",
  "可口可乐": "KO", "coca": "KO", "cocacola": "KO",
  "耐克": "NKE", "nike": "NKE",
  "星巴克": "SBUX", "starbucks": "SBUX",
  "维萨": "V", "visa": "V",
  "摩根大通": "JPM", "jpmorgan": "JPM", "jp Morgan": "JPM",
  "强生": "JNJ", "johnson": "JNJ",
  "宝洁": "PG", "pg": "PG", "procter": "PG",
  "沃尔玛": "WMT", "walmart": "WMT",
  "英特尔": "INTC", "intel": "INTC",
  "AMD": "AMD", "超威": "AMD",
  "高通": "QCOM", "qualcomm": "QCOM",
  "Netflix": "NFLX", "网飞": "NFLX",
  "Adobe": "ADBE",
  "Salesforce": "CRM",
  "甲骨文": "ORCL", "oracle": "ORCL",
  "可口可乐": "KO",
  "茅台": "600519.SS", "贵州茅台": "600519.SS",
  "比亚迪": "1211.HK", "bydd": "1211.HK", "byd": "1211.HK",
  "美团": "3690.HK", "meituan": "3690.HK",
  "小米": "1810.HK", "xiaomi": "1810.HK",
  "快手": "1024.HK", "kuaishou": "1024.HK",
};

function isTicker(s) {
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s);
}

// 把任意输入（代码 / 中文名 / 英文名）解析为标准代码；解析失败返回 null
export async function resolveSymbol(query) {
  const q = (query || "").trim();
  if (!q) return null;
  const up = q.toUpperCase();
  if (isTicker(up)) return up;
  const key = q.toLowerCase();
  if (NAME_ALIASES[key]) return NAME_ALIASES[key];
  // 兜底：Yahoo 搜索（中文/英文公司名 → 代码）
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`, {
        headers: { "User-Agent": UA },
      });
      if (!r.ok) continue;
      const d = await r.json();
      const quotes = (d && d.quotes) || [];
      const eq = quotes.find((x) => x.symbol && (x.quoteType === "EQUITY" || !x.quoteType || x.isYahooFinance));
      const sym = (eq || quotes[0])?.symbol;
      if (sym) return String(sym).toUpperCase();
    } catch {
      /* try next host */
    }
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
    // 2) 零 key 主源：Yahoo chart meta（价格 + 52周）
    const meta = await yahooFetch(sym);
    if (meta) {
      const base = mapYahooMeta(ticker, meta);
      // 2b) 用 v7/quote 补齐估值字段（PE/市值/股息率/Beta），chart meta 常缺失
      const q = await yahooQuote(sym);
      if (q) Object.assign(base.stats, q);
      base.source = "yahoo";
      return base;
    }
    // 3) 兜底：模型知识
    return empty;
  };
}
