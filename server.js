import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { MASTERS, SYNTH_PROMPT } from "./prompts.js";
import { makeMarketDataFetcher, resolveSymbol, diagnoseMarket } from "./marketdata.js";
import { auth, portfolio, billing, mailQueue, usage, reports } from "./db.js";

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
app.use(express.urlencoded({ extended: false }));

// 预览环境标识：仅当 IS_PREVIEW=true（Render preview 服务环境变量）时在首页顶部注入细横幅
const IS_PREVIEW = process.env.IS_PREVIEW === "true";
const PREVIEW_BANNER = `<div id="preview-banner" style="position:fixed;top:0;left:0;right:0;z-index:99;background:#b45309;color:#fff;text-align:center;font-size:12px;letter-spacing:.14em;padding:4px 10px;font-family:Arial,Helvetica,sans-serif;">PREVIEW · 测试环境</div>`;
app.get("/", (req, res, next) => {
  if (!IS_PREVIEW) return next();
  try {
    const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
    res.type("html").send(html.replace("<body>", "<body>" + PREVIEW_BANNER));
  } catch (e) { next(); }
});

app.use(express.static("public"));

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const MODEL = process.env.DASHSCOPE_MODEL || "qwen3.7-max";
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "fourlens-admin";
const IPN_VERIFY = process.env.IPN_VERIFY !== "off"; // 默认开启 PayPal 验证；本地测试设 IPN_VERIFY=off
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://aiberkshire.onrender.com";
const PAYPAL_IPN_VERIFY_URL = process.env.PAYPAL_IPN_SANDBOX === "1"
  ? "https://ipnpb.sandbox.paypal.com/cgi-bin/webscr"
  : "https://ipnpb.paypal.com/cgi-bin/webscr";
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
  if (md.profile?.name) lines.push(`公司名: ${md.profile.name}`);
  if (md.price != null) lines.push(`现价: ${md.price} ${md.currency || ""}`);
  if (md.previousClose != null) lines.push(`昨收: ${md.previousClose}`);
  if (md.stats.marketCap) lines.push(`市值: ${md.stats.marketCap}`);
  if (md.stats.trailingPE) lines.push(`动态市盈率(TTM): ${md.stats.trailingPE}`);
  if (md.stats.forwardPE) lines.push(`远期市盈率: ${md.stats.forwardPE}`);
  if (md.stats.pegRatio) lines.push(`PEG(未来12月): ${md.stats.pegRatio}`);
  if (md.stats.dividendYield) lines.push(`股息率: ${md.stats.dividendYield}`);
  if (md.stats.annualDividend) lines.push(`年化股息: ${md.stats.annualDividend}`);
  if (md.stats.oneYearTarget) lines.push(`分析师1年目标价: ${md.stats.oneYearTarget}`);
  if (md.stats.beta) lines.push(`Beta: ${md.stats.beta}`);
  if (md.stats.fiftyTwoWeekLow || md.stats.fiftyTwoWeekHigh)
    lines.push(`52周区间: ${md.stats.fiftyTwoWeekLow} ~ ${md.stats.fiftyTwoWeekHigh}`);
  if (md.profile.sector) lines.push(`行业: ${md.profile.sector} / ${md.profile.industry || ""}`);
  if (md.profile.summary) lines.push(`公司简介: ${md.profile.summary}`);
  return lines.join("\n");
}

// ---------- 调用百炼 Qwen（带超时 + 重试） ----------
// 关键：单点失败绝不能让整个分析 500。四个大师并发，掉一个只降级那一个。
const LLM_TIMEOUT = 90000;
const LLM_RETRIES = 2;

async function callLLM(body, label = "llm") {
  let lastErr = null;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      const res = await fetch(DASHSCOPE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        // 4xx（除 429）属于请求本身有问题，重试无意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`${label} ${res.status}: ${t.slice(0, 200)}`);
        }
        lastErr = new Error(`${label} ${res.status}: ${t.slice(0, 200)}`);
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
      if (/\d{3}:/.test(String(e.message)) && !/429/.test(String(e.message))) break;
    }
    if (attempt < LLM_RETRIES) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr || new Error(`${label} failed`);
}

async function callMaster(master, ticker, marketText) {
  const user = `Company ticker: ${ticker}\n\nMarket data (live, fetched today):\n${marketText}\n\nIMPORTANT GROUND TRUTH RULES (these override your memory):\n1. Analyze EXACTLY the company identified by the ticker and company name above. Never substitute a different company with a similar ticker or name (e.g. do not confuse CRWV CoreWeave with CRWD CrowdStrike).\n2. The market data above is LIVE data fetched today. Treat it as ground truth about the company's CURRENT listing status. The corporate actions you remember (acquisitions, delistings, spin-offs, re-listings, spin-offs reversing prior acquisitions, name changes) may have happened AFTER your training cutoff, or may have been reversed. Example: SanDisk (SNDK) was acquired by Western Digital in 2016 but spun back out and re-listed as an independent public company in February 2025. If live data shows the company trading today, it is trading today — analyze it as such. Never dismiss the live data as "fabricated" or refuse to analyze because of stale memory; if your memory conflicts with the data, state the conflict briefly and proceed with the data.\n3. If the company is outside your knowledge, base your analysis strictly on the provided market data and state that explicitly.\n\nProvide your analysis as JSON per your instructions.`;
  const body = {
    model: MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: master.systemPrompt },
      { role: "user", content: user },
    ],
  };
  try {
    const data = await callLLM(body, `master:${master.id}`);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseJSON(content);
    if (!parsed) {
      return { id: master.id, name: master.name, error: true, raw: content?.slice(0, 500) };
    }
    return { id: master.id, name: master.name, ...parsed };
  } catch (e) {
    // 单个大师失败只降级自己，不拖垮整体
    return { id: master.id, name: master.name, error: true, raw: `request failed: ${String(e?.message || e).slice(0, 300)}` };
  }
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
  try {
    const data = await callLLM(body, "synthesize");
    const parsed = parseJSON(data?.choices?.[0]?.message?.content);
    return parsed || { error: true };
  } catch (e) {
    return { error: true, detail: String(e?.message || e).slice(0, 300) };
  }
}

// ---------- 路由 ----------
// 免费档：每个账号限 1 次免费四镜分析，之后必须订阅 Pro
const FREE_LIMIT = 1;
// Pro 档：每月（自然月）20 次四镜分析
const PRO_MONTH_LIMIT = 20;

// 摘要负载：两段式报告第一段（verdict/总分/四镜各一句话），完整版异步进邮箱
function summaryPayload(data) {
  const s = data.synthesized || {};
  return {
    ticker: data.ticker,
    query: data.query,
    marketData: data.marketData,
    summary: {
      overallVerdict: s.overallVerdict || null,
      overallConviction: s.overallConviction ?? null,
      consensus: s.consensus || "",
      divergence: s.divergence || "",
      actionableTakeaway: s.actionableTakeaway || "",
      lenses: (data.analyses || []).map((a) => ({
        id: a.id,
        name: a.name,
        error: !!a.error,
        verdict: a.verdict || null,
        conviction: a.conviction ?? null,
        oneLiner: a.oneLiner || (a.error ? "(analysis temporarily unavailable)" : ""),
      })),
    },
  };
}

// 完整报告后台异步：渲染 HTML → 双通道送达（先带内容入队兜底 → 尝试直发 → 成功则销队）
// 生产 Render 封 SMTP/无 HTTP 发信通道 → 直发失败保持 queued，由 Mac 中继按队列内容代发
function finalizeReportAsync(reportId, user, data) {
  setImmediate(async () => {
    try {
      const html = buildFullReportHtml(data);
      const subject = `Your AI Berkshire Four-Lens Full Report · ${data.ticker}`;
      const qid = mailQueue.add(user.email, { subject, html }); // 先入队（内容落库，中继兜底）
      const r = await sendHtmlEmail(user.email, subject, html); // 再尝试直发
      if (r.ok) {
        mailQueue.markSent([qid]);
        reports.setStatus(reportId, "sent");
        console.log("[report] full report emailed:", user.email, "id:", reportId);
      } else {
        reports.setStatus(reportId, "queued"); // 直发不可用/失败 → 队列保留，Mac 中继稍后代发
        console.log("[report] direct send unavailable, queued for relay:", user.email, "id:", reportId, "·", r.error || "");
      }
    } catch (e) {
      reports.setStatus(reportId, "failed", String(e?.message || e).slice(0, 300));
      console.error("[report] finalize error:", e);
    }
  });
}

app.post("/api/analyze", async (req, res) => {
  const rawInput = (req.body?.ticker || "").trim();
  if (!rawInput) return res.status(400).json({ error: "ticker required" });
  // 免费档门禁：必须登录
  const user = auth.getUser((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  if (!user) return res.status(401).json({ error: "Sign up / log in to run an analysis", needLogin: true });
  const isPro = user.pro_status === "active";
  if (!API_KEY) return res.status(500).json({ error: "Analysis engine not configured" });

  // Pro 月度配额门禁：当月 ≥ 20 次 → 403 quotaExceeded
  if (isPro && usage.countMonth(user.id) >= PRO_MONTH_LIMIT) {
    return res.status(403).json({
      code: "quotaExceeded",
      error: "Monthly limit reached — your 20 analyses refresh on the 1st of next month",
    });
  }

  // 名称 / 中文 → 代码（零 key：别名表 + Yahoo 搜索兜底）
  const resolved = await resolveSymbol(rawInput);
  if (!resolved) {
    return res.status(400).json({ error: "无法识别该名称，请尝试输入股票代码（如 AAPL / BRK.B）" });
  }
  const ticker = resolved;

  // 免费额度门禁：非 Pro 且免费次数已用完 → 引导付费
  if (!isPro && (user.free_used || 0) >= FREE_LIMIT) {
    return res.status(403).json({ code: "freeUsedUp", error: "Your free analysis has been used. Upgrade to Pro for 20 reports per month.", needPro: true });
  }

  const key = `${ticker}:${MODEL}`;
  const hit = analysisCache.get(key);
  const reportId = reports.create(user.id, ticker, rawInput);

  // 缓存命中：摘要秒回，完整报告直接走异步发信
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    reports.attach(reportId, hit.data);
    finalizeReportAsync(reportId, user, hit.data);
    return res.json({ ...summaryPayload(hit.data), reportId, cached: true });
  }

  try {
    const market = await fetchMarketData(ticker);
    const marketText = marketContextText(market);
    const analyses = await Promise.all(MASTERS.map((m) => callMaster(m, ticker, marketText)));
    const synthesized = await synthesize(ticker, analyses);
    const data = { ticker, query: rawInput, marketData: market, analyses, synthesized };
    analysisCache.set(key, { ts: Date.now(), data });
    usage.log(user.id, ticker); // 全量记录用量（Pro 月度配额核算依据）
    if (!isPro) auth.consumeFree(user.id); // 成功生成才扣免费额度
    reports.attach(reportId, data);
    finalizeReportAsync(reportId, user, data); // 完整版后台异步 + 邮件，不阻塞摘要返回
    res.json({ ...summaryPayload(data), reportId });
  } catch (e) {
    reports.setStatus(reportId, "failed", String(e?.message || e).slice(0, 300));
    res.status(500).json({ error: "analysis failed", detail: String(e?.message || e) });
  }
});

// 报告状态轮询（摘要返回后前端每 3s 查一次，最多 3 分钟）
app.get("/api/report-status", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const id = Number(req.query.id);
  const r = Number.isFinite(id) && id > 0 ? reports.get(id) : null;
  if (!r || r.user_id !== u.id) return res.status(404).json({ error: "report not found" });
  res.json({
    id: r.id,
    ticker: r.ticker,
    status: r.status, // generating | sent | queued | failed
    email: u.email,
    emailConfigured: !!(mailer || BREVO_API_KEY || SENDGRID_API_KEY),
    error: r.error || null,
  });
});

// 页面内查看完整报告（邮件未配置/发送失败时的降级入口）
app.get("/api/report", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const id = Number(req.query.id);
  const r = Number.isFinite(id) && id > 0 ? reports.get(id) : null;
  if (!r || r.user_id !== u.id || !r.data) return res.status(404).json({ error: "report not found" });
  try {
    res.json(JSON.parse(r.data));
  } catch {
    res.status(500).json({ error: "report data corrupted" });
  }
});

// 行情诊断端点：线上排查用（/api/diag?q=苹果）
// 返回每一层数据源的实际结果，可一眼看出是 crumb 挂了还是被墙
app.get("/api/diag", async (req, res) => {
  const q = (req.query?.q || "AAPL").toString().trim();
  try {
    const resolved = await resolveSymbol(q);
    if (!resolved) return res.json({ query: q, resolved: null, note: "name not resolved" });
    const sym = resolved.replace(/\./g, "-").toUpperCase();
    const diag = await diagnoseMarket(sym);
    const merged = await fetchMarketData(resolved);
    res.json({ query: q, resolved, diag, merged });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- PayPal 个人跨境收款（无需 API key） ----------
// 两种配置任选其一：
//   1) PAYPAL_EMAIL=你的收款邮箱   → 用 xclick 标准付款链接（中国大陆个人账号通用，推荐）
//   2) PAYPAL_PAYMENT_URL=https://paypal.me/你的账号 → 旧式拼接金额
const PAYPAL_EMAIL = (process.env.PAYPAL_EMAIL || "").trim();
const PAYPAL_BASE = (process.env.PAYPAL_PAYMENT_URL || "").replace(/\/$/, "");
const PLAN_PRICE = { pro: 19 };
const PLAN_NAME = { pro: "AI Berkshire Pro" };
app.post("/api/checkout", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const plan = "pro";
  const price = PLAN_PRICE[plan];
  if (!PAYPAL_EMAIL && !PAYPAL_BASE) {
    return res.json({ ok: false, message: `PayPal 收款未配置（在 .env 填 PAYPAL_EMAIL=你的收款邮箱）。套餐：${price} USD/月。` });
  }
  // 邮箱优先：生成 xclick 标准付款链接（中国个人账号通用）
  const orderId = randomUUID();
  let payUrl;
  if (PAYPAL_EMAIL) {
    const q = new URLSearchParams({
      cmd: "_xclick",
      business: PAYPAL_EMAIL,
      item_name: PLAN_NAME[plan],
      item_number: plan,
      amount: String(price),
      currency_code: "USD",
      no_note: "1",
      no_shipping: "1",
      custom: orderId,
      notify_url: `${PUBLIC_BASE_URL}/api/paypal-ipn`,
      return: `${PUBLIC_BASE_URL}/pro-thanks`,
    });
    payUrl = `https://www.paypal.com/cgi-bin/webscr?${q.toString()}`;
  } else {
    payUrl = `${PAYPAL_BASE}/${price}`;
  }
  billing.createOrder(u.id, plan, orderId);
  res.json({ ok: true, payUrl, orderId, plan, price });
});

// 用户付款后回填 PayPal 邮箱 → 标记 Pro（MVP 信任制，人工对照 PayPal 记录复核）
app.post("/api/activate", async (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const { paypalEmail } = req.body || {};
  billing.activate(u.id, paypalEmail);
  mailQueue.add(u.email); // 先排队（Mac中继兵底），能直发就直发并销队
  const mail = await sendPicksEmail(u.email);
  if (mail.ok) mailQueue.markSent([mailQueue.add(u.email)]);
  res.json({ ok: true, pro: true, emailed: mail.ok, emailError: mail.error || null });
});

// PayPal IPN：客户付款后 PayPal 主动 POST 通知 → 标记订单已付 + 自动激活 Pro
// （不再靠信任制手动回填；这是哥老官"监测客户付款路径"的核心闭环）
app.post("/api/paypal-ipn", (req, res) => {
  const body = req.body || {};
  res.sendStatus(200); // 必须先回 200，否则 PayPal 会重试
  const orderId = body.custom || body.item_number;
  const payerEmail = body.payer_email || null;
  const paymentStatus = body.payment_status;
  const txnId = body.txn_id;
  const finish = (verified) => {
    if (!verified) { console.warn("[IPN] unverified, ignored", txnId); return; }
    if (paymentStatus !== "Completed") { console.log("[IPN] status != Completed:", paymentStatus, txnId); return; }
    if (!orderId) { console.warn("[IPN] missing orderId", txnId); return; }
    const o = billing.markPaid(orderId, payerEmail);
    console.log("[IPN] markPaid", orderId, o ? "OK" : "ORDER_NOT_FOUND");
    if (o) {
      const bu = auth.getUserById(o.user_id);
      if (bu) {
        mailQueue.add(bu.email); // PayPal自动激活：先排队Mac中继，能直发就直发
        sendPicksEmail(bu.email).then((mail) => {
          if (mail.ok) mailQueue.markSent([mailQueue.add(bu.email)]);
        });
      }
    }
  };
  if (!IPN_VERIFY) { finish(true); return; } // 本地测试跳过真 PayPal 验证
  // 真实验证：原样回 POST PayPal + cmd=_notify-validate
  const params = new URLSearchParams({ ...body, cmd: "_notify-validate" });
  fetch(PAYPAL_IPN_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })
    .then((r) => r.text())
    .then((text) => finish(text.trim() === "VERIFIED"))
    .catch((e) => console.error("[IPN] verify fetch failed", e));
});

// 管理员付款看板（ADMIN_TOKEN 保护，供巡检/对账）
app.get("/api/admin/payments", (req, res) => {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (tok !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  res.json({ orders: billing.listOrders() });
});

// 发信中继（Plan C）：Render免费实例SMTP被封，哥老官的Mac每10分钟来取待发邮件，用QQ邮箱代发
const checkAdmin = (req) => {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : (req.query.token || null);
  return tok === ADMIN_TOKEN;
};
app.get("/api/admin/mail-pending", (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const items = mailQueue.pending(); // 每项自带 subject/html（新版完整报告）或为 null（旧式picks项）
  // 端点级 subject/html 为旧式无内容项的 picks 兜底内容（向后兼容，勿动每月picks推送）
  res.json({
    from: MAIL_FROM_EMAIL || SMTP_USER || "23441680@qq.com",
    subject: "Your AI Berkshire Pro Picks — Top 3 Undervalued Companies",
    html: buildPicksReportHtml(),
    items,
  });
});
app.post("/api/admin/mail-sent", (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const ids = (req.body && req.body.ids) || [];
  mailQueue.markSent(ids);
  res.json({ ok: true, marked: ids.length });
});

// 邮件列表沉淀（EDM导出用）：返回所有注册用户 [{email, created_at, pro}]
app.get("/api/admin/subscribers", (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  res.json(auth.listSubscribers());
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
  if (!u) return res.json({ user: null });
  const isPro = u.pro_status === "active";
  res.json({
    user: {
      email: u.email,
      pro: isPro,
      free_remaining: isPro ? null : Math.max(0, FREE_LIMIT - (u.free_used || 0)),
      pro_used: isPro ? usage.countMonth(u.id) : null,
      pro_limit: PRO_MONTH_LIMIT,
    },
  });
});

// ---------- Pro Picks（付费钩子：每月低估值筛选，源自上游AI Berkshire晨星护城河筛选） ----------
const PRO_PICKS = {
  updatedAt: "2026-06-07",
  source: "Morningstar moat screen: fair value / price > 1.5, moat ≥ Narrow, ★★★★★ rated",
  picks: [
    { ticker: "ADNT", name: "Adient", hint: "Auto seating leader", upside: "+208%", fairValue: "$69", price: "$22.42", note: "World's largest auto-seat supplier; FY2026 guidance raised while the market overprices short-term industry pressure." },
    { ticker: "GNTX", name: "Gentex", hint: "Hidden monopoly · 80% global share", upside: "+128%", fairValue: "$57", price: "$24.95", note: "~80% of the global auto-dimming mirror market; 2,600+ patents, some valid through 2050." },
    { ticker: "ADBE", name: "Adobe", hint: "Undervalued AI stock", upside: "+124%", fairValue: "$560", price: "$250.38", note: "Deep workflow lock-in; revenue +10.5%, ARR +11.5%; Morningstar calls it an undervalued AI stock." }
  ],
  teaser: [
    { hint: "Auto seating leader", upside: "+208%" },
    { hint: "Hidden monopoly · 80% global share", upside: "+128%" },
    { hint: "Undervalued AI stock", upside: "+124%" }
  ]
};
app.get("/api/picks", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "Sign up / log in to view", needLogin: true });
  if (u.pro_status === "active") return res.json({ locked: false, updatedAt: PRO_PICKS.updatedAt, source: PRO_PICKS.source, picks: PRO_PICKS.picks });
  return res.json({ locked: true, updatedAt: PRO_PICKS.updatedAt, teaser: PRO_PICKS.teaser });
});

// ---------- Picks报告页 + 邮件送达 ----------
// 发信三通道：①BREVO_API_KEY（HTTP API，免费300封/天，首选）②SENDGRID_API_KEY ③SMTP备用（Render免费实例SMTP端口被封，仅作本地/其他环境备用）
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.qq.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `AI Berkshire <${SMTP_USER}>` : "");
const MAIL_FROM_EMAIL = (BREVO_API_KEY || SENDGRID_API_KEY) ? (process.env.MAIL_FROM_EMAIL || SMTP_USER || "23441680@qq.com") : SMTP_USER;
let mailer = null;
if (BREVO_API_KEY) {
  console.log("[email] Brevo HTTP mode enabled, from:", MAIL_FROM_EMAIL);
} else if (SENDGRID_API_KEY) {
  console.log("[email] SendGrid HTTP mode enabled, from:", MAIL_FROM_EMAIL);
} else if (SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, connectionTimeout: 10000, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  console.log("[email] SMTP configured:", SMTP_HOST, SMTP_USER);
} else {
  console.warn("[email] No email channel (set BREVO_API_KEY / SENDGRID_API_KEY / SMTP) — report emails disabled");
}

function buildPicksReportHtml() {
  const rows = PRO_PICKS.picks.map((p, i) => `
    <tr>
      <td style="padding:16px 12px;border-bottom:1px solid #e5e5e5;vertical-align:top"><b style="font-size:16px">${i + 1}. ${p.ticker}</b><br><span style="color:#666;font-size:13px">${p.name}</span></td>
      <td style="padding:16px 12px;border-bottom:1px solid #e5e5e5;color:#1a7f37;font-weight:700;white-space:nowrap;font-size:15px;vertical-align:top">${p.upside}</td>
      <td style="padding:16px 12px;border-bottom:1px solid #e5e5e5;font-size:14px;line-height:1.5">${p.note}<br><span style="color:#666;font-size:12.5px">Fair value ${p.fairValue} vs ${p.price} at screen date · ${p.hint}</span></td>
    </tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Berkshire · Pro Picks Report</title></head>
<body style="margin:0;background:#faf9f6;font-family:Georgia,'Times New Roman',serif;color:#111">
<div style="max-width:760px;margin:0 auto;padding:36px 20px">
  <div style="border:2px solid #111;background:#fff;padding:30px 28px">
    <div style="font-size:12px;letter-spacing:.3em;color:#666">AI BERKSHIRE · PRO REPORT</div>
    <h1 style="font-size:26px;margin:10px 0 4px">This Month's Top 3 Undervalued Companies</h1>
    <div style="color:#666;font-size:13.5px;margin-bottom:22px">${PRO_PICKS.source} · Screened ${PRO_PICKS.updatedAt}</div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="font-size:12px;color:#888;margin-top:18px">Prices as of the screen date (${PRO_PICKS.updatedAt}) and may have moved since — verify current quotes before acting. For research purposes only; not investment advice.</p>
    <p style="margin-top:22px;font-size:14px"><a href="https://aiberkshire.onrender.com" style="color:#111;font-weight:700">Run your own four-lens analysis → aiberkshire.onrender.com</a></p>
  </div>
</div>
</body></html>`;
}

// Pro专属报告页（网页端查看入口）
app.get("/picks-report", (req, res) => {
  const u = getUserFromReq(req);
  if (!u || u.pro_status !== "active") return res.redirect("/");
  res.type("html").send(buildPicksReportHtml());
});

async function sendPicksEmail(email) {
  return sendHtmlEmail(email, "Your AI Berkshire Pro Picks — Top 3 Undervalued Companies", buildPicksReportHtml());
}

// 通用发信：Brevo HTTP → SendGrid HTTP → SMTP（本地 465 SSL）
async function sendHtmlEmail(email, subject, html) {
  // 通道①：Brevo HTTP API（免费300封/天，首选）
  if (BREVO_API_KEY) {
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          sender: { name: "AI Berkshire", email: MAIL_FROM_EMAIL },
          to: [{ email }],
          subject,
          htmlContent: html,
        }),
      });
      if (r.status >= 200 && r.status < 300) { console.log("[email] Brevo sent:", email); return { ok: true }; }
      const errTxt = await r.text().catch(() => "");
      console.error("[email] Brevo failed:", r.status, errTxt.slice(0, 200));
      return { ok: false, error: `Brevo HTTP ${r.status}: ${errTxt.slice(0, 150)}` };
    } catch (e) { console.error("[email] Brevo error:", e.message); return { ok: false, error: e.message }; }
  }
  // 通道②：SendGrid HTTP API
  if (SENDGRID_API_KEY) {
    try {
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: MAIL_FROM_EMAIL, name: "AI Berkshire" },
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });
      if (r.status >= 200 && r.status < 300) { console.log("[email] SendGrid sent:", email); return { ok: true }; }
      const errTxt = await r.text().catch(() => "");
      console.error("[email] SendGrid failed:", r.status, errTxt.slice(0, 200));
      return { ok: false, error: `SendGrid HTTP ${r.status}: ${errTxt.slice(0, 150)}` };
    } catch (e) { console.error("[email] SendGrid error:", e.message); return { ok: false, error: e.message }; }
  }
  // 通道③：SMTP（本地 QQ 邮箱 465 SSL；Render 免费实例端口被封时走上面的中继队列）
  if (!mailer) { console.warn("[email] no channel, skipped for:", email); return { ok: false, error: "No email channel configured" }; }
  try {
    await mailer.sendMail({ from: SMTP_FROM, to: email, subject, html });
    console.log("[email] sent:", email, "·", subject);
    return { ok: true };
  } catch (e) { console.error("[email] send failed:", email, e.message); return { ok: false, error: e.message }; }
}

// ---------- 完整四镜报告邮件（两段式第二段：各镜详细全文 + 红旗追踪） ----------
function buildFullReportHtml(data) {
  const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const s = data.synthesized || {};
  const md = data.marketData || {};
  const st = md.stats || {};
  const vc = { Bullish: "#c0392b", Bearish: "#27ae60", Neutral: "#7f8c8d", Hold: "#7f8c8d" };
  const marketRows = [
    ["Price", md.price != null ? `${md.price} ${md.currency || ""}`.trim() : "—"],
    ["Market Cap", st.marketCap || "—"],
    ["P/E (TTM)", st.trailingPE || "—"],
    ["Fwd P/E", st.forwardPE || "—"],
    ["PEG", st.pegRatio || "—"],
    ["Div Yield", st.dividendYield || "—"],
    ["52W Range", st.fiftyTwoWeekLow && st.fiftyTwoWeekHigh ? `${st.fiftyTwoWeekLow} ~ ${st.fiftyTwoWeekHigh}` : "—"],
    ["1Y Target", st.oneYearTarget || "—"],
    ["Sector", md.profile?.sector || "—"],
  ].map(([k, v]) => `<td style="padding:7px 12px 7px 0;font-size:13px;vertical-align:top"><span style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.08em;display:block">${esc(k)}</span><b style="font-size:14px">${esc(v)}</b></td>`).join("");

  const masterCards = (data.analyses || []).map((a) => {
    const color = vc[a.verdict] || "#7f8c8d";
    if (a.error) {
      return `<div style="border:2px solid #111;background:#fff;padding:20px;margin-top:16px">
        <div style="font-size:17px;font-weight:700">${esc(a.name || "")}</div>
        <div style="color:#666;font-size:12px;margin:4px 0 10px;border-bottom:1px solid #ddd;padding-bottom:8px">analysis temporarily unavailable</div>
      </div>`;
    }
    const flags = (a.redFlags || []).map((f) => `<li style="margin:3px 0;font-size:13.5px">${esc(f)}</li>`).join("") || "<li style='font-size:13.5px'>—</li>";
    return `<div style="border:2px solid #111;background:#fff;padding:22px;margin-top:16px">
      <table style="width:100%"><tr>
        <td style="font-size:17px;font-weight:700;padding:0">${esc(a.name || "")}</td>
        <td style="text-align:right;padding:0"><span style="border:1px solid ${color};color:${color};font-size:11px;font-weight:700;padding:3px 10px;letter-spacing:.06em">${esc(a.verdict || "")}</span></td>
      </tr></table>
      <div style="font-size:12px;color:#666;margin:6px 0 12px;border-bottom:1px solid #ddd;padding-bottom:8px">Conviction ${esc(a.conviction ?? "—")}/100</div>
      <div style="font-size:14px;line-height:1.55"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666;display:block;margin-bottom:2px">Thesis</b>${esc(a.thesis || "")}</div>
      <div style="font-size:14px;line-height:1.55;margin-top:10px"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666;display:block;margin-bottom:2px">Strongest point</b>${esc(a.keyStrength || "")}</div>
      <div style="font-size:14px;line-height:1.55;margin-top:10px"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666;display:block;margin-bottom:2px">Biggest weakness</b>${esc(a.keyWeakness || "")}</div>
      <div style="margin-top:10px"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666;display:block;margin-bottom:2px">Red flags</b><ul style="margin:2px 0 0;padding-left:18px">${flags}</ul></div>
      <div style="font-size:14px;line-height:1.55;margin-top:10px"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666;display:block;margin-bottom:2px">What would change my mind</b>${esc(a.whatWouldChangeMind || "")}</div>
      <div style="margin-top:12px;padding:10px 12px;background:#f3f3f3;border-left:3px solid #111;font-style:italic;font-size:13.5px">“${esc(a.oneLiner || "")}”</div>
    </div>`;
  }).join("");

  const sc = vc[s.overallVerdict] || "#7f8c8d";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Berkshire · Four-Lens Full Report · ${esc(data.ticker)}</title></head>
<body style="margin:0;background:#fafafa;font-family:Georgia,'Times New Roman',serif;color:#111">
<div style="max-width:780px;margin:0 auto;padding:36px 20px">
  <div style="border-bottom:2px solid #111;padding-bottom:14px">
    <div style="font-size:22px;font-weight:700;letter-spacing:.16em">AI BERKSHIRE</div>
    <div style="color:#666;font-size:13px;margin-top:4px">Four-Lens Full Report · Buffett · Munger · Klarman · Marks</div>
  </div>
  <div style="border:2px solid #111;background:#fff;padding:24px;margin-top:20px">
    <span style="display:inline-block;border:2px solid #111;padding:4px 18px;font-weight:700;letter-spacing:.14em;font-size:15px">${esc(s.overallVerdict || "—")}</span>
    <span style="color:#666;font-size:13px">&nbsp;&nbsp;Composite score</span>
    <div style="font-size:34px;font-weight:700;margin:8px 0 2px">${esc(s.overallConviction ?? "—")}<span style="font-size:16px;color:#666"> / 100</span></div>
    <div style="font-size:15px;color:#333;margin-top:6px;font-style:italic">“${esc(s.actionableTakeaway || "")}”</div>
    <div style="font-size:13.5px;margin-top:12px;color:#333"><b>Consensus:</b> ${esc(s.consensus || "—")}</div>
    <div style="font-size:13.5px;margin-top:6px;color:#333"><b>Divergence / key risk:</b> ${esc(s.divergence || "—")}</div>
    <div style="margin-top:14px;border-top:1px solid #ddd;padding-top:12px"><table style="border-collapse:collapse"><tr>${marketRows}</tr></table></div>
  </div>
  <h2 style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;margin:30px 0 0;color:#111">The Four Masters · Full Analyses</h2>
  ${masterCards}
  <div style="margin-top:26px;border:2px solid #111;background:#111;color:#fff;padding:24px">
    <h3 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#bbb;margin:0 0 12px">Editor's Synthesis · Overall: <span style="color:${sc}">${esc(s.overallVerdict || "—")}</span> (${esc(s.overallConviction ?? "—")}/100)</h3>
    <p style="margin:0 0 12px;font-size:15px"><b>Consensus:</b> ${esc(s.consensus || "")}</p>
    <p style="margin:0 0 12px;font-size:15px"><b>Divergence / key risk:</b> ${esc(s.divergence || "")}</p>
    <div style="background:#fff;color:#111;padding:14px;border-left:3px solid #c0392b;font-style:italic;font-size:14.5px">Actionable takeaway: ${esc(s.actionableTakeaway || "")}</div>
  </div>
  <div style="margin-top:30px;border-top:1px solid #ccc;padding-top:16px;color:#666;font-size:11.5px;line-height:1.6">
    Disclaimer: AI BERKSHIRE output is a demonstration of investment methodology and a research framework — not investment advice or a solicitation. Investing involves risk; do your own research and decisions.<br/>
    AI BERKSHIRE is an independent research tool and is not affiliated with, endorsed by, or connected to Berkshire Hathaway Inc.
  </div>
</div>
</body></html>`;
}

app.get("/api/portfolio", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  res.json({ tickers: portfolio.list(u.id) });
});

app.post("/api/portfolio", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const ticker = (req.body?.ticker || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$|^\d{4,5}\.(HK|L|T)$|^\d{6}\.(SS|SZ)$/.test(ticker)) return res.status(400).json({ error: "invalid ticker" });
  res.json({ ticker: portfolio.add(u.id, ticker) });
});

app.delete("/api/portfolio", (req, res) => {
  const u = getUserFromReq(req);
  if (!u) return res.status(401).json({ error: "not authenticated" });
  const ticker = (req.body?.ticker || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$|^\d{4,5}\.(HK|L|T)$|^\d{6}\.(SS|SZ)$/.test(ticker)) return res.status(400).json({ error: "invalid ticker" });
  portfolio.remove(u.id, ticker);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`AI Berkshire running at http://localhost:${PORT}`);
});
