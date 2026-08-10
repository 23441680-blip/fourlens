# AI Berkshire — 四位大师价值研究 SaaS（MVP）

一个标的，四位价值投资大师并行独立研判，输出对抗式研究报告。

> **商标声明**：AI Berkshire 是独立产品，与 Berkshire Hathaway Inc. 无任何关联、未获其授权或背书。名称仅致敬其价值投资哲学，所有分析由 AI 生成，不构成投资建议。
大师阵容（纯西方价投神坛，英语用户零认知门槛）：

| 大师 | 镜头 | 角色 |
|------|------|------|
| Warren Buffett | 生意本质 / 护城河 / 长期复利 | 复利多头 |
| Charlie Munger | 多元思维模型 / 逆向 / 心理学 |  inversion 判官 |
| Seth Klarman | 安全边际 / 风险优先 / 深度价值 | 下行 skeptic |
| Howard Marks | 周期 / 风险心理学 / 逆向时机 | 周期/情绪判官 |

底层模型：阿里百炼 Qwen（OpenAI 兼容接口），成本极低。

## 快速开始

```bash
npm install
node --env-file=.env server.js
# 打开 http://localhost:3000
```

`.env` 已含百炼 API Key。改模型用 `DASHSCOPE_MODEL`（如 `qwen-max` 提质感、`qwen-turbo` 降成本）。

## 接口

`POST /api/analyze`
```json
{ "ticker": "NVDA" }
```
返回：
```json
{
  "ticker": "NVDA",
  "marketData": { "price": null, "stats": {}, "profile": {} },
  "analyses": [ { "id":"buffett", "verdict":"Bullish", "conviction":88, "thesis":"…", "keyStrength":"…", "keyWeakness":"…", "redFlags":["…"], "whatWouldChangeMind":"…", "oneLiner":"…" }, … ],
  "synthesized": { "consensus":"…", "divergence":"…", "overallVerdict":"Hold", "overallConviction":81, "actionableTakeaway":"…" }
}
```
行情源（`marketdata.js`，多源级联，全程零 key 优先）：
- **美股**：Nasdaq 公开接口（价格/市值/PE/股息率/52 周/板块/1 年目标价，最稳）→ Yahoo v7+crumb（补强）→ SEC EDGAR 官方财报（自算 PE/市值，硬兜底）。
- **港股 / A 股（非美股）**：腾讯财经 gtimg（零 key，国内网络极稳）补价格 + 52 周 + TTM PE + 名称。已覆盖全部自有标的（腾讯 0700.HK、泡泡玛特 09992.HK、中海油 00883.HK、茅台 600519.SS 等）。
- **Finnhub（可选增强）**：填 `FINNHUB_API_KEY` 可升级为主源并补 `sector/industry/简介`；免费 key 注册即得（https://finnhub.io）。
- **模型自身知识**：所有源失败时的最后兜底，UI 标注 `source: model-knowledge`。
- 诊断端点：`GET /api/diag?q=AAPL`（或 `?q=腾讯` / `?q=0700.HK`）逐层返回 Yahoo / Nasdaq / SEC / 腾讯 各源实际结果，线上一眼定位是哪层挂了。

`makeMarketDataFetcher(env)` 统一入口；Yahoo 走 `query1/query2` 双主机 + 浏览器 UA 重试以提升成功率。

## 账号与组合监控（内置 SQLite，零额外服务）

"数据库"就是一块持久存储：存用户的邮箱+密码（哈希）、以及每个用户保存的持仓组合，刷新/换设备后还在。本产品用 Node 内置 `node:sqlite` 直接落地，**无需注册任何第三方数据库**。

- 表：`users`(邮箱+密码哈希 scrypt)、`sessions`(登录令牌)、`portfolios`(用户→ticker)
- 接口：
  - `POST /api/auth/signup` `{email,password}` → `{token,email}`
  - `POST /api/auth/login` `{email,password}` → `{token,email}`
  - `GET /api/me`（Bearer）→ 当前用户
  - `GET|POST|DELETE /api/portfolio`（Bearer）→ 组合增删查
- 前端：登录/注册弹窗；登录后"Portfolio"走服务端（跨设备同步），未登录走 localStorage 游客模式。
- 库文件：`data/fourlens.db`（已 gitignore，运行时生成）。

> 需要更强扩展（并发/多实例）时，可把 `db.js` 换成 Postgres（Supabase 免费档），接口不变。

## 收款：个人 PayPal 跨境收款（已接入）

采用**个人 PayPal 跨境收款**——无需 API key、无需海外公司，单笔 <$1,000 绑个人银行卡合规结汇（Stripe 个人大陆账户不支持，必须海外公司，故不走）。

流程：
1. 在 `.env` 填 `PAYPAL_EMAIL`（你的 PayPal 登录邮箱＝收款邮箱，如 `23441680@qq.com`）。`/api/checkout` 会自动生成 xclick 标准付款链接（`business=邮箱&amount=19/49&currency_code=USD`），**中国大陆个人账号通用，不依赖 paypal.me**（后者中国个人账号不支持）。
2. 用户点订阅 → 前端 `window.open` 打开 PayPal 付款页 → 付款后回填 PayPal 邮箱 → `POST /api/activate` 标记账号 `pro_status='active'`（MVP 信任制，人工对照 PayPal 记录复核；个体户执照办好后可升级 PayPal 企业户 / 连连 / Airwallex 做大额自动扣费）。
3. 未填 `PAYPAL_EMAIL`（及 `PAYPAL_PAYMENT_URL`）时，`/api/checkout` 返回提示文案，不报错。

## 部署

**前置**：先注册 GitHub（存代码）+ 一个部署平台账号（Vercel / Render / Railway，均免费档够用）。本项目已 `git init` 就绪，代码推到 GitHub 后，在部署平台"Import Repository"即可。

Node 项目，`npm start` 启动（`server.js` 同时托管静态前端与 API）。在平台环境变量配置 `DASHSCOPE_API_KEY`、`DASHSCOPE_MODEL`（可选 `FINNHUB_API_KEY`、`PAYPAL_EMAIL`）。

> SQLite 持久化提示：用户账号/组合存在 `data/fourlens.db`。**Railway 与 Render（已带 `render.yaml` 挂持久盘）文件会保留**；**Vercel serverless 文件系统是临时的，重启即清空**（仅丢历史组合，不影响分析）。要 Vercel 也持久，把 `db.js` 换成 Supabase Postgres 即可。

### Vercel（零配置，已带 `vercel.json`）
```bash
npm i -g vercel
vercel            # 按提示登录并部署；环境变量在 Vercel 控制台 → Settings → Environment Variables 添加
vercel --prod
```
> 注：Vercel 以 serverless function 运行，内存缓存仅在同一 warm 实例内有效（不影响功能，仅跨实例不共享缓存）。

### Render（最省心，原生跑 Node 服务）
1. 在 Render 新建 Web Service，关联本仓库。
2. Build: `npm install`；Start: `npm start`。
3. 在 Environment 添加上述变量，选节点区域即可。

### Railway
同理：新建 Project → Deploy Node 服务，Start `npm start`，填环境变量。

### 逐字段部署指引（Step by Step）

**① GitHub（存代码，部署平台要从这里拉仓库）**
1. 打开注册页 → 填 Username / Email / Password → 验证邮箱。
2. 右上角 **New repository**：
   - Repository name：`fourlens`
   - 选 **Public**（私有也行，但部署平台需授权访问）
   - **不要**勾 Initialize with README / .gitignore（本地已有）
   - 点 **Create repository**
3. 本地推代码（终端执行）：
   ```bash
   cd ai-value-saas
   git branch -M main
   git remote add origin https://github.com/<你的GitHub用户名>/fourlens.git
   git push -u origin main
   ```

**② 选一个部署平台（Vercel 最省事 / Render 最稳）**

- **Vercel**：注册页用 **Continue with GitHub** 登录 → **Add New → Project** → Import `fourlens` → Framework Preset 选 **Other** → **Deploy**。
  部署后在 **Settings → Environment Variables** 逐条添加（Key / Value）：
  | Key | Value |
  |---|---|
  | `DASHSCOPE_API_KEY` | `sk-b2cfaae3b7634d16bcaadde0ce1270d3` |
  | `DASHSCOPE_MODEL` | `qwen-plus` |
  | `PAYPAL_EMAIL` | `23441680@qq.com` |
  | `PORT` | `3000` |
  | `FINNHUB_API_KEY` | （留空，可选） |
  加完 Variables 后回到 Deployments 重新 **Redeploy**。

- **Render**：注册页 → **New → Web Service** → 连 GitHub 选 `fourlens`：
  - Name：`fourlens`
  - Branch：`main`
  - Build Command：`npm install`
  - Start Command：`npm start`
  - 地区：选离用户近的（如 Singapore）
  - 展开 **Environment**，加上面同样的变量（Key/Value 逐条）
  - 点 **Create Web Service**（约 1–2 分钟起好，给一个 `.onrender.com` 域名）。

**③ 验证真收款**
部署完拿到线上 URL → 浏览器打开 → 注册账号 → 点 **Subscribe Pro** → 确认跳转 PayPal 付款页（链接含 `business=23441680@qq.com&amount=19`）→ 付款后在站内填 PayPal 邮箱点激活 → 账号显示 **PRO**。

- 成本：qwen-plus ≈ 几分钱/次，百炼新用户有免费额度，边际成本近乎为零。
- 真实行情：默认走 Yahoo（零 key）；若个别区域 Yahoo 不稳，填免费 `FINNHUB_API_KEY` 即自动升级为主源。

## 已知限制 / 下一步

- 行情零 key 多源已落地：美股 Nasdaq→Yahoo→SEC 级联；港股/A 股腾讯 gtimg 兜底（覆盖全部自有标的）。Yahoo 在部分网络环境会被限流/403，已自动降级到 Nasdaq/SEC/腾讯，不影响分析。若要补 `sector/industry/简介` 或更稳，填免费 Finnhub key 即升主源。
- 加入：用户账号、历史报告存档、持仓组合监控、PDF 导出、邮件早报（复用现有 Edge TTS 管线）。
- 合规：输出为方法论/框架演示，非投资建议——前端已带免责声明，上线前请复核当地金融监管要求。

## 目录结构

```
ai-value-saas/
├─ server.js        # Express：/api/analyze 多 Agent 引擎 + /api/checkout(PayPal) + /api/activate
├─ marketdata.js    # 真实行情源（Yahoo meta 零 key 主源 / Finnhub 可选增强）
├─ prompts.js       # 四位大师 system prompt + 综合编辑 prompt
├─ public/index.html# 纯黑墨极简前端（四镜卡片 + 综合结论 + 定价）
├─ .env             # 百炼 Key / 模型 / 端口 / Finnhub(可选) / PayPal 邮箱（已 gitignore）
└─ package.json
```
