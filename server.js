import express from "express";
import { MASTERS, SYNTH_PROMPT } from "./prompts.js";
import { makeMarketDataFetcher } from "./marketdata.js";
import { auth, portfolio } from "./db.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const MODEL = process.env.DASHSCOPE_MODEL || "qwen-plus";
const PORT = process.env.PORT || 3000;
const fetchMarketData = makeMarketDataFetcher(process.env);

// 结果缓存：按 ticker+model 缓存 30 分钟，重复查询秒回、省百炼成本（自然支撑免费档）
const CACHE_TTL = 30 * 60 * 1000;
const analysisCache = new Map();

// ---------- 工具：稳健 JSON 解析 ----------
function parseJSON(text) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ---------- 行情抓取（Finnhub 为主 / Yahoo 兜底，见 marketdata.js） ----------

function marketContextText(md) {
  if (!md || (md.price == null && !md.stats.marketCap)) return "(行情接口暂不可用，请基于你的知识分析)";
  const lines = [];
  lines.push(`标的: ${md.symbol}`);
  if (md.price != null) lines.push(`现价: ${md.price} ${md.currency || ""}`);
  if (md.previousClose != null) lines.push(`昨收: ${md.previousClose}`);
  if (md.stats.marketCap) lines.push(`市值: ${md.stats.marketCap}`);
  if (md.stats.trailingPE) lines.push(`动态市盈率(TTM): ${md.stats.trailingPE}`);
  if (md.stats.forwardPE) lines.push(`远期市盈率: ${md.stats.forwardPE}`);
  if (md.stats.dividendYield) lines.push(`股息率: ${md.stats.dividendYield}`);
  if (md.stats.beta) lines.push(`Beta: ${md.stats.beta}`);
  if (md.stats.fiftyTwoWeekLow || md.stats.fiftyTwoWeekHigh)
    lines.push(`52周区间: ${md.stats.fiftyTwoWeekLow} ~ ${md.stats.fiftyTwoWeekHigh}`);
  if (md.profile.sector) lines.push(`行业: ${md.profile.sector} / ${md.profile.industry || ""}`);
  if (md.profile.summary) lines.push(`公司简介: ${md.profile.summary}`);
  return lines.join("\n");
}

// ---------- 调用百炼 Qwen（单大师） ----------
async function callMaster(master, ticker, marketText) {
  const user = `Company ticker: ${ticker}\n\nMarket data (best-effort, may be partial):\n${marketText}\n\nProvide your analysis as JSON per your instructions.`;
  const body = {
    model: MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: master.systemPrompt },
      { role: "user", content: user },
    ],
  };
  const res = await fetch(DASHSCOPE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseJSON(content);
  if (!parsed) {
    return { id: master.id, name: master.name, error: true, raw: content?.slice(0, 500) };
  }
  return { id: master.id, name: master.name, ...parsed };
}

async function synthesize(ticker, analyses) {
  const user = `Ticker: ${ticker}\n\nMaster analyses:\n${JSON.stringify(analyses, null, 2)}`;
  const body = {
    model: MODEL,
    temperature: 0.5,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYNTH_PROMPT },
      { role: "user", content: user },
    ],
  };
  const res = await fetch(DASHSCOPE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const parsed = parseJSON(data?.choices?.[0]?.message?.content);
  return parsed || { error: true };
}

// ---------- 路由 ----------
app.post("/api/analyze", async (req, res) => {
  const ticker = (req.body?.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return res.status(400).json({ error: "invalid ticker" });
  if (!API_KEY) return res.status(500).json({ error: "DASHSCOPE_API_KEY not set" });

  const key = `${ticker}:${MODEL}`;
  const hit = analysisCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return res.json({ ...hit.data, cached: true });
  }

  try {
    const market = await fetchMarketData(ticker);
    const marketText = marketContextText(market);
    const analyses = await Promise.all(MASTERS.map((m) => callMaster(m, ticker, marketText)));
    const synthesized = await synthesize(ticker, analyses);
    const data = { ticker, marketData: market, analyses, synthesized };
    analysisCache.set(key, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "analysis failed", detail: String(e?.message || e) });
  }
});

// ---------- Stripe 订阅桩 ----------
app.post("/api/checkout", (req, res) => {
  const { plan } = req.body || {};
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.json({
      ok: false,
      message:
        "Stripe 尚未配置。填入 STRIPE_SECRET_KEY（及 Price ID）后启用线上收款。当前套餐：Pro $19/月，Team $49/月。",
      plan,
    });
  }
  // 真实实现：用 stripe.checkout.sessions.create(...) 返回 url
  res.json({ ok: true, message: "Checkout 将跳转 Stripe。", plan });
});

// ---------- 账号 / 组合监控（SQLite） ----------
function getUserFromReq(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  return auth.getUser(token);
}

app.post("/api/auth/signup", (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json(auth.signup(email, password));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json(auth.login(email, password));
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get("/api/me", (req, res) => {
  const u = getUserFromReq(req);
  res.json({ user: u ? { email: u.email } : null });
});

app.get("/api/portfolio", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  res.json({ tickers: portfolio.list(u.id) });
});

app.post("/api/portfolio", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const ticker = (req.body?.ticker || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return res.status(400).json({ error: "invalid ticker" });
  res.json({ ticker: portfolio.add(u.id, ticker) });
});

app.delete("/api/portfolio", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const ticker = (req.body?.ticker || "").trim().toUpperCase();
  portfolio.remove(u.id, ticker);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`FourLens running at http://localhost:${PORT}`);
});
