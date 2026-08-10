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

// ---------- Yahoo 鉴权：cookie + crumb ----------
// 2024 起 Yahoo 的 v7/quote 与 v10/quoteSummary 需要 cookie+crumb，否则一律 403。
// 这里做进程内缓存，避免每次分析都重新握手。
let _crumbCache = { cookie: null, crumb: null, ts: 0 };
const CRUMB_TTL = 30 * 60 * 1000; // 30 分钟

async function getCrumb(force = false) {
  const now = Date.now();
  if (!force && _crumbCache.crumb && now - _crumbCache.ts < CRUMB_TTL) return _crumbCache;
  // 第一步：拿 cookie（fc.yahoo.com 会 302/404，但一定下发 A1/A3 cookie）
  const cookieSources = ["https://fc.yahoo.com", "https://finance.yahoo.com"];
  let cookie = null;
  for (const url of cookieSources) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(8000) });
      const list = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const jar = list.map((s) => s.split(";")[0]).filter(Boolean);
      if (jar.length) { cookie = jar.join("; "); break; }
    } catch { /* next source */ }
  }
  if (!cookie) return { cookie: null, crumb: null, ts: 0 };
  // 第二步：用 cookie 换 crumb
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v1/test/getcrumb`, {
        headers: { "User-Agent": UA, Cookie: cookie },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const crumb = (await r.text()).trim();
      if (crumb && crumb.length < 32 && !crumb.startsWith("<")) {
        _crumbCache = { cookie, crumb, ts: Date.now() };
        return _crumbCache;
      }
    } catch { /* next host */ }
  }
  return { cookie, crumb: null, ts: 0 };
}

function pickStats(q) {
  const out = {};
  if (!q) return out;
  const pe = q.trailingPE ?? q.trailingPe;
  const fpe = q.forwardPE ?? q.forwardPe;
  if (pe != null) out.trailingPE = Number(pe).toFixed(2);
  if (fpe != null) out.forwardPE = Number(fpe).toFixed(2);
  if (q.marketCap != null) out.marketCap = fmtCap(q.marketCap);
  if (q.dividendYield != null) {
    // Yahoo 有时给 0.0044（小数），有时给 0.44（百分数），做归一化
    const dy = Number(q.dividendYield);
    out.dividendYield = `${(dy < 1 ? dy * 100 : dy).toFixed(2)}%`;
  }
  if (q.beta != null) out.beta = Number(q.beta).toFixed(2);
  if (q.epsTrailingTwelveMonths != null) out.epsTTM = Number(q.epsTrailingTwelveMonths).toFixed(2);
  if (q.fiftyTwoWeekHigh != null) out.fiftyTwoWeekHigh = String(q.fiftyTwoWeekHigh);
  if (q.fiftyTwoWeekLow != null) out.fiftyTwoWeekLow = String(q.fiftyTwoWeekLow);
  return out;
}

// A 路：v7/quote（带 crumb）
async function yahooQuoteV7(sym, auth) {
  if (!auth?.crumb) return null;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(sym)}&crumb=${encodeURIComponent(auth.crumb)}`;
      const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: auth.cookie }, signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const d = await r.json();
      const q = d?.quoteResponse?.result?.[0];
      if (q) return pickStats(q);
    } catch { /* next host */ }
  }
  return null;
}

// B 路：v10/quoteSummary（带 crumb），字段更全（含 PE/EPS/股息率）
async function yahooQuoteSummary(sym, auth) {
  const modules = "summaryDetail,defaultKeyStatistics,price";
  for (const host of YAHOO_HOSTS) {
    try {
      const qs = auth?.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}${qs}`;
      const r = await fetch(url, {
        headers: { "User-Agent": UA, ...(auth?.cookie ? { Cookie: auth.cookie } : {}) },
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const res = d?.quoteSummary?.result?.[0];
      if (!res) continue;
      const sd = res.summaryDetail || {};
      const ks = res.defaultKeyStatistics || {};
      const pr = res.price || {};
      const raw = (x) => (x && typeof x === "object" ? x.raw : x);
      const merged = {
        trailingPE: raw(sd.trailingPE),
        forwardPE: raw(sd.forwardPE) ?? raw(ks.forwardPE),
        marketCap: raw(sd.marketCap) ?? raw(pr.marketCap),
        dividendYield: raw(sd.dividendYield),
        beta: raw(sd.beta) ?? raw(ks.beta),
        epsTrailingTwelveMonths: raw(ks.trailingEps),
        fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: raw(sd.fiftyTwoWeekLow),
      };
      const stats = pickStats(merged);
      if (Object.keys(stats).length) return stats;
    } catch { /* next host */ }
  }
  return null;
}

// C 路：Nasdaq 公开接口（零 key，完全独立于 Yahoo 鉴权体系）
// 2026-08-10 实测：三个端点均 200，字段以实际返回为准（此前按猜测写的字段名全都不存在）
//   /api/quote/{S}/info      → 价格 / 涨跌 / 成交量 / 52周 / 公司名
//   /api/quote/{S}/summary   → 市值 / 前收 / 股息率 / 年化股息 / 1年目标价 / 板块行业
//   /api/analyst/{S}/peg-ratio → P/E（含历史实际与未来预估）+ PEG
const NASDAQ_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};

// 2026-08-10 实测：Nasdaq 用 "BRK.B"（点号）。上游为适配 Yahoo 已把 . 转成 -，这里要还原。
// 非美股（港股/A股/日股/英股）Nasdaq 不覆盖，直接放弃。
function toNasdaqSym(sym) {
  if (!sym) return null;
  const s = String(sym).toUpperCase();
  if (/[.\-](HK|SS|SZ|T|L|TO|AX|SI|KS)$/.test(s)) return null;
  if (/^\d/.test(s)) return null; // 纯数字开头（港股 0700 等）
  return s.replace(/-/g, ".");
}

function numOf(v) {
  if (v == null) return null;
  const t = String(v).replace(/[$,%\s]/g, "").replace(/,/g, "");
  const n = Number(t);
  return isFinite(n) ? n : null;
}

async function nasdaqJson(url) {
  try {
    const r = await fetch(url, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.data || null;
  } catch {
    return null;
  }
}

// Nasdaq 报价（价格兜底，Yahoo chart 被限流/失败时使用）
async function nasdaqQuote(sym) {
  const s = toNasdaqSym(sym);
  if (!s) return null;
  const d = await nasdaqJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(s)}/info?assetclass=stocks`);
  const p = d?.primaryData;
  if (!p) return null;
  const price = numOf(p.lastSalePrice);
  if (price == null) return null;
  const out = { price, companyName: d.companyName || null, stats: {} };
  const range = d?.keyStats?.fiftyTwoWeekHighLow?.value; // "216.58 - 344.57"
  if (range && range.includes("-")) {
    const [lo, hi] = range.split("-").map((x) => numOf(x));
    if (lo != null) out.stats.fiftyTwoWeekLow = String(lo);
    if (hi != null) out.stats.fiftyTwoWeekHigh = String(hi);
  }
  return out;
}

// Nasdaq 估值摘要（市值 / 股息率 / 前收 / 52周 / 板块行业 / 目标价）
async function nasdaqSummary(sym) {
  const s = toNasdaqSym(sym);
  if (!s) return null;
  const d = await nasdaqJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(s)}/summary?assetclass=stocks`);
  const sd = d?.summaryData;
  if (!sd) return null;
  const out = {};
  const mc = numOf(sd.MarketCap?.value);
  if (mc != null && mc > 0) out.marketCap = fmtCap(mc);
  const yld = numOf(sd.Yield?.value);
  if (yld != null && yld > 0) out.dividendYield = `${yld.toFixed(2)}%`;
  const tgt = numOf(sd.OneYrTarget?.value);
  if (tgt != null && tgt > 0) out.oneYearTarget = `$${tgt.toFixed(2)}`;
  const div = numOf(sd.AnnualizedDividend?.value);
  if (div != null && div > 0) out.annualDividend = `$${div.toFixed(2)}`;
  const hl = sd.FiftTwoWeekHighLow?.value; // "$344.5699/$216.58"
  if (hl && hl.includes("/")) {
    const [hi, lo] = hl.split("/").map((x) => numOf(x));
    if (hi != null) out.fiftyTwoWeekHigh = hi.toFixed(2);
    if (lo != null) out.fiftyTwoWeekLow = lo.toFixed(2);
  }
  const sector = sd.Sector?.value;
  const industry = sd.Industry?.value;
  const prev = numOf(sd.PreviousClose?.value);
  return { stats: out, sector: sector || null, industry: industry || null, previousClose: prev };
}

// Nasdaq P/E（trailing 取最近的 "Actual"，forward 取最近的 "Estimates"）
async function nasdaqPE(sym) {
  const s = toNasdaqSym(sym);
  if (!s) return null;
  const d = await nasdaqJson(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(s)}/peg-ratio`);
  const chart = d?.per?.peRatioChart;
  const out = {};
  const sanePE = (v) => {
    const n = Number(v);
    return isFinite(n) && n >= 1 && n <= 500 ? n.toFixed(2) : null;
  };
  if (Array.isArray(chart) && chart.length) {
    const actual = chart.filter((p) => /actual/i.test(String(p.x || "")) && p.y != null);
    const est = chart.filter((p) => /estimate/i.test(String(p.x || "")) && p.y != null);
    const tp = sanePE(actual[actual.length - 1]?.y);
    const fp = sanePE(est[0]?.y);
    if (tp) out.trailingPE = tp;
    if (fp) out.forwardPE = fp;
  }
  const peg = d?.pegr?.pegValue;
  if (peg != null && isFinite(Number(peg))) out.pegRatio = Number(peg).toFixed(2);
  return Object.keys(out).length ? out : null;
}

// 合并 Nasdaq 全部估值字段
async function nasdaqValuation(sym) {
  const [sum, pe] = await Promise.all([nasdaqSummary(sym), nasdaqPE(sym)]);
  if (!sum && !pe) return null;
  const stats = { ...(sum?.stats || {}), ...(pe || {}) };
  return Object.keys(stats).length
    ? { stats, sector: sum?.sector || null, industry: sum?.industry || null, previousClose: sum?.previousClose ?? null }
    : null;
}

// D 路：SEC EDGAR（美国证监会官方，零 key，不依赖 Yahoo 鉴权，最稳的硬兜底）
// 用官方财报数据拿 摊薄EPS(TTM) 与 流通股本，再结合价格自算 PE / 市值。
const SEC_UA = "AI-Berkshire/1.0 (contact: 23441680@qq.com)";
let _cikMap = null;
let _cikTs = 0;
const CIK_TTL = 24 * 60 * 60 * 1000;

async function getCikMap() {
  if (_cikMap && Date.now() - _cikTs < CIK_TTL) return _cikMap;
  try {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const map = {};
    for (const k of Object.keys(d)) {
      const row = d[k];
      if (row?.ticker) map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, "0");
    }
    _cikMap = map;
    _cikTs = Date.now();
    return map;
  } catch {
    return null;
  }
}

async function secConcept(cik, taxonomy, tag) {
  try {
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// 取最近 4 个季度的摊薄 EPS 求和（TTM）
function ttmEpsFromConcept(json) {
  const units = json?.units?.["USD/shares"];
  if (!Array.isArray(units)) return null;
  // 只取季报口径（约 90 天）的记录，按结束日排序
  const q = units
    .filter((u) => u.start && u.end && u.val != null)
    .map((u) => ({ ...u, days: (new Date(u.end) - new Date(u.start)) / 86400000 }))
    .filter((u) => u.days >= 80 && u.days <= 100)
    .sort((a, b) => new Date(b.end) - new Date(a.end));
  // 同一 end 去重（不同 form 会重复报送）
  const seen = new Set();
  const uniq = [];
  for (const u of q) {
    if (seen.has(u.end)) continue;
    seen.add(u.end);
    uniq.push(u);
    if (uniq.length === 4) break;
  }
  if (uniq.length < 4) return null;
  return uniq.reduce((s, u) => s + Number(u.val), 0);
}

async function secFundamentals(sym, price) {
  // SEC company_tickers.json 用 "BRK-B" 这种横杠写法（实测），把点号统一成横杠
  const s = String(sym || "").toUpperCase().replace(/\./g, "-");
  if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(s)) return null; // SEC 只覆盖美股
  const map = await getCikMap();
  const cik = map?.[s];
  if (!cik) return null;
  const out = {};

  // EPS(TTM) → 自算 PE
  // ⚠️ 陷阱：双重股权公司（如伯克希尔 BRK-A/BRK-B）SEC 只按 A 股口径报 EPS，
  //    拿 B 股价格去除会得到荒谬的 PE（实测 BRK.B 得 0.04）。故必须做合理性校验。
  const epsJson =
    (await secConcept(cik, "us-gaap", "EarningsPerShareDiluted")) ||
    (await secConcept(cik, "us-gaap", "EarningsPerShareBasic"));
  const eps = ttmEpsFromConcept(epsJson);
  if (eps != null && isFinite(eps) && price) {
    const pe = Number(price) / eps;
    // 只接受落在合理区间的 PE；亏损股（eps<=0）与异常值一律丢弃，宁可留空也不给错数
    if (eps > 0 && pe >= 1 && pe <= 500) {
      out.epsTTM = eps.toFixed(2);
      out.trailingPE = pe.toFixed(2);
    }
  }

  // 流通股本 → 自算市值
  // 同样的双重股权陷阱：这里拿到的可能只是单一类别股本，故仅作最后兜底
  const shJson = await secConcept(cik, "dei", "EntityCommonStockSharesOutstanding");
  const shUnits = shJson?.units?.shares;
  if (Array.isArray(shUnits) && shUnits.length && price) {
    const latest = shUnits
      .filter((u) => u.val != null && u.end)
      .sort((a, b) => new Date(b.end) - new Date(a.end))[0];
    const cap = latest?.val ? Number(latest.val) * Number(price) : null;
    if (cap && isFinite(cap) && cap > 1e6) out.marketCap = fmtCap(cap);
  }

  return Object.keys(out).length ? out : null;
}

// 统一：补齐估值字段（PE / 市值 / 股息率 / Beta / EPS）
// 级联顺序按「稳定性」排：Nasdaq（零鉴权，实测最稳）→ Yahoo（需 crumb，易 403/429）→ SEC（官方硬兜底）
// 返回 { stats, via, sector, industry, previousClose } 便于诊断与补全
// 逐层「累加补缺」而非「首个成功即返回」：
// 某一层可能只给部分字段（如 Nasdaq 对 BRK.B 有市值无 PE），继续向下层补齐缺失项。
async function getValuation(sym, price = null) {
  const merged = {};
  const used = [];
  let sector = null;
  let industry = null;
  let previousClose = null;

  const absorb = (stats, label) => {
    if (!stats) return;
    let added = 0;
    for (const [k, v] of Object.entries(stats)) {
      if (v != null && v !== "" && (merged[k] == null || merged[k] === "")) {
        merged[k] = v;
        added++;
      }
    }
    if (added) used.push(label);
  };

  // 核心字段齐了就不用再往下探（省时间、少打外部接口）
  const enough = () => merged.trailingPE && merged.marketCap;

  // 1) Nasdaq：零鉴权，最稳
  const nd = await nasdaqValuation(sym);
  if (nd) {
    absorb(nd.stats, "nasdaq");
    sector = nd.sector;
    industry = nd.industry;
    previousClose = nd.previousClose;
  }

  // 2) Yahoo：需 cookie+crumb，可能 403/429
  if (!enough()) {
    const auth = await getCrumb();
    absorb(await yahooQuoteV7(sym, auth), "v7+crumb");
    if (!enough()) absorb(await yahooQuoteSummary(sym, auth), "quoteSummary");
  }

  // 3) SEC EDGAR 官方财报（零 key，用 EPS/股本自算 PE 与市值）
  if (!enough()) absorb(await secFundamentals(sym, price), "sec-edgar");

  return {
    stats: Object.keys(merged).length ? merged : null,
    via: used.length ? used.join("+") : "all-failed",
    sector,
    industry,
    previousClose,
  };
}

// 供诊断端点使用：逐层探测，线上一次请求即可定位是哪一层挂了
export async function diagnoseMarket(sym) {
  const out = { symbol: sym };
  const meta = await yahooFetch(sym);
  out.yahooChart = meta ? { price: meta.regularMarketPrice, currency: meta.currency } : null;
  out.nasdaqQuote = await nasdaqQuote(sym);
  out.nasdaqSummary = await nasdaqSummary(sym);
  out.nasdaqPE = await nasdaqPE(sym);
  const auth = await getCrumb(true);
  out.yahooAuth = { cookie: auth.cookie ? `${auth.cookie.slice(0, 24)}…` : null, crumb: auth.crumb || null };
  out.yahooV7 = await yahooQuoteV7(sym, auth);
  out.gtimg = await gtimgFetch(sym.replace(/-/g, "."));
  out.sec = await secFundamentals(sym, meta?.regularMarketPrice ?? out.nasdaqQuote?.price ?? null);
  return out;
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

// ---------- 腾讯财经 gtimg（零 key，覆盖港股/A股/英股/美股，国内网络极稳） ----------
// 实测：qt.gtimg.cn 返回 GBK 编码的 ~ 分隔文本，字段顺序港股/A股/美股通用。
// 仅用于非美股（港股 .HK / A股 .SS/.SZ）；美股优先 Nasdaq（美国环境最佳）。
function toGtimgSym(ticker) {
  if (!ticker) return null;
  const s = String(ticker).toUpperCase();
  let m = s.match(/^(\d{4,5})\.HK$/);
  if (m) return "hk" + m[1].padStart(5, "0");
  m = s.match(/^(\d{6})\.SS$/);
  if (m) return "sh" + m[1];
  m = s.match(/^(\d{6})\.SZ$/);
  if (m) return "sz" + m[1];
  // 英股 .L / 日股 .T 等腾讯覆盖有限，暂不强映射（后续可扩展）
  return null;
}

function fmtCapLocal(n, cur) {
  if (n == null) return null;
  const v = Number(n);
  if (!isFinite(v)) return null;
  const prefix = cur === "HKD" ? "HK$" : cur === "CNY" ? "CN¥" : cur === "USD" ? "$" : "";
  if (v >= 1e12) return `${prefix}${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${prefix}${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${prefix}${(v / 1e6).toFixed(2)}M`;
  return `${prefix}${v.toFixed(0)}`;
}

// 解析腾讯 gtimg 的 ~ 分隔字段。
// 实测字段索引（不同市场顺序不同，故按市场分支）：
//   通用可靠: f[3]现价 f[4]昨收  | 港股/美股 f[48]52周高 f[49]52周低
//   PE: 港股 f[51] / 美股 f[41] / A股 f[53]（均加 0<pe<1000 校验，防错数误导判断）
//   名称: f[1]中文名 或 f[46]英文名
//   市值索引跨市场混乱且单位不一，故不取，宁可留空也不给错数。
function parseGtimg(f, gsym) {
  if (!Array.isArray(f) || f.length < 50) return null;
  const price = numOf(f[3]);
  if (price == null) return null;
  const isHk = gsym.startsWith("hk");
  const isUs = gsym.startsWith("us");
  const out = {
    source: "tencent-gtimg",
    price,
    previousClose: numOf(f[4]),
    stats: {},
    profile: { name: f[1] || f[46] || null },
    priceVia: "tencent-gtimg",
    valuationVia: "tencent-gtimg",
  };
  if (isHk || isUs) {
    const hi = numOf(f[48]), lo = numOf(f[49]);
    if (hi != null && (lo == null || hi >= lo)) out.stats.fiftyTwoWeekHigh = String(hi);
    if (lo != null && (hi == null || hi >= lo)) out.stats.fiftyTwoWeekLow = String(lo);
  }
  const peIdx = isHk ? 51 : isUs ? 41 : 53; // sh/sz 用 53
  const pe = numOf(f[peIdx]);
  if (pe != null && pe > 0 && pe < 1000) out.stats.trailingPE = pe.toFixed(2);
  return out;
}

async function gtimgFetch(ticker) {
  const gsym = toGtimgSym(ticker);
  if (!gsym) return null;
  const cur = gsym.startsWith("hk") ? "HKD" : gsym.startsWith("sh") || gsym.startsWith("sz") ? "CNY" : "USD";
  try {
    const r = await fetch(`https://qt.gtimg.cn/q=${gsym}`, {
      headers: { "User-Agent": UA, Referer: "https://finance.qq.com/" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const text = new TextDecoder("gbk").decode(buf);
    const mm = text.match(/="([^"]*)"/);
    if (!mm) return null;
    const parsed = parseGtimg(mm[1].split("~"), gsym);
    if (!parsed) return null;
    parsed.symbol = ticker;
    parsed.currency = cur;
    return parsed;
  } catch {
    return null;
  }
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

// 接受：美股字母开头 / 港股(A) 数字+ .HK / A股 6位+ .SS|.SZ / 伦敦 .L / 东京 .T
function isTicker(s) {
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return true;
  if (/^\d{4,5}\.(HK|L|T)$/.test(s)) return true;
  if (/^\d{6}\.(SS|SZ)$/.test(s)) return true;
  return false;
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
    // 1b) 非美股（港股/A股）：腾讯财经 gtimg 零 key 兜底（Nasdaq/SEC 只覆盖美股）
    const gSym = toGtimgSym(ticker);
    if (gSym) {
      const g = await gtimgFetch(ticker);
      if (g && g.price != null) return g;
    }

    // 2) 零 key 价格源：Yahoo chart meta 优先，失败（403/429/超时）则用 Nasdaq info
    let base = null;
    let priceVia = null;
    const meta = await yahooFetch(sym);
    if (meta) {
      base = mapYahooMeta(ticker, meta);
      priceVia = "yahoo-chart";
    } else {
      const nq = await nasdaqQuote(sym);
      if (nq) {
        base = {
          symbol: ticker,
          source: "nasdaq",
          price: nq.price,
          currency: "USD",
          previousClose: null,
          stats: { ...nq.stats },
          profile: nq.companyName ? { name: nq.companyName } : {},
        };
        priceVia = "nasdaq-info";
      }
    }
    if (!base) return empty; // 3) 全部失败 → 交给模型知识

    // 2b) 补齐估值字段（PE/市值/股息率/52周/板块）：Nasdaq → Yahoo(crumb) → SEC
    const val = await getValuation(sym, base.price);
    if (val.stats) {
      // 已有的价格源字段优先保留，只填补空缺
      for (const [k, v] of Object.entries(val.stats)) {
        if (base.stats[k] == null || base.stats[k] === "") base.stats[k] = v;
      }
    }
    if (val.sector && !base.profile.sector) base.profile.sector = val.sector;
    if (val.industry && !base.profile.industry) base.profile.industry = val.industry;
    if (base.previousClose == null && val.previousClose != null) base.previousClose = val.previousClose;

    // 2c) 若仍无 PE 但有价格与 EPS，自己算
    if (!base.stats.trailingPE && base.price && base.stats.epsTTM) {
      const eps = Number(base.stats.epsTTM);
      if (isFinite(eps) && eps > 0) base.stats.trailingPE = (base.price / eps).toFixed(2);
    }
    base.priceVia = priceVia;
    base.valuationVia = val.via;
    return base;
  };
}
