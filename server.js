import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MASTERS, SYNTH_PROMPT } from "./prompts.js";
import { makeMarketDataFetcher } from "./marketdata.js";
import { auth, portfolio, billing } from "./db.js";

// 零依赖加载 .env（Node 不自动加载，这里手写；已存在的环境变量不被覆盖）
try {
  const envText = readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

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

// ---------- PayPal 个人跨境收款（无需 API key） ----------
// 两种配置任选其一：
//   1) PAYPAL_EMAIL=你的收款邮箱   → 用 xclick 标准付款链接（中国大陆个人账号通用，推荐）
//   2) PAYPAL_PAYMENT_URL=https://paypal.me/你的账号 → 旧式拼接金额
const PAYPAL_EMAIL = (process.env.PAYPAL_EMAIL || "").trim();
const PAYPAL_BASE = (process.env.PAYPAL_PAYMENT_URL || "").replace(/\/$/, "");
const PLAN_PRICE = { pro: 19, team: 49 };
const PLAN_NAME = { pro: "AI Berkshire Pro", team: "AI Berkshire Team" };
app.post("/api/checkout", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const plan = req.body?.plan === "team" ? "team" : "pro";
  const price = PLAN_PRICE[plan];
  if (!PAYPAL_EMAIL && !PAYPAL_BASE) {
    return res.json({ ok: false, message: `PayPal 收款未配置（在 .env 填 PAYPAL_EMAIL=你的收款邮箱）。套餐：${price} USD/月。` });
  }
  // 邮箱优先：生成 xclick 标准付款链接（中国个人账号通用）
  let payUrl;
  if (PAYPAL_EMAIL) {
    const q = new URLSearchParams({
      cmd: "_xclick",
      business: PAYPAL_EMAIL,
      item_name: PLAN_NAME[plan],
      amount: String(price),
      currency_code: "USD",
      no_note: "1",
      no_shipping: "1",
    });
    payUrl = `https://www.paypal.com/cgi-bin/webscr?${q.toString()}`;
  } else {
    payUrl = `${PAYPAL_BASE}/${price}`;
  }
  const orderId = randomUUID();
  billing.createOrder(u.id, plan, orderId);
  res.json({ ok: true, payUrl, orderId, plan, price });
});

// 用户付款后回填 PayPal 邮箱 → 标记 Pro（MVP 信任制，人工对照 PayPal 记录复核）
app.post("/api/activate", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const { paypalEmail } = req.body || {};
  billing.activate(u.id, paypalEmail);
  res.json({ ok: true, pro: true });
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
  res.json({ user: u ? { email: u.email, pro: u.pro_status === "active" } : null });
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
  console.log(`AI Berkshire running at http://localhost:${PORT}`);
});
