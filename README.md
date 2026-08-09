# FOURLENS — 四位大师价值研究 SaaS（MVP）

一个标的，四位价值投资大师并行独立研判，输出对抗式研究报告。
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
行情源（`marketdata.js`，三级回退）：
1. **Yahoo Finance chart `meta`（默认主源，零 key）**——返回实时价 + 市值 + TTM/远期 PE + 股息率 + Beta + 52 周高低，覆盖研报所需核心基本面。
2. **Finnhub（可选增强，填 `FINNHUB_API_KEY`）**——更稳定，并补 `sector / industry / 公司简介`；免费 key 注册即得（https://finnhub.io）。
3. **模型自身知识**——若部署环境出网受限，自动回退，UI 标注 `source: model-knowledge`。

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
1. 在 `.env` 填 `PAYPAL_PAYMENT_URL`（你的 PayPal.Me 链接，如 `https://paypal.me/你的账号`）。`/api/checkout` 会自动拼金额：`pro → /19`、`team → /49`。
2. 用户点订阅 → 前端 `window.open` 打开 PayPal 付款页 → 付款后回填 PayPal 邮箱 → `POST /api/activate` 标记账号 `pro_status='active'`（MVP 信任制，人工对照 PayPal 记录复核；个体户执照办好后可升级 PayPal 企业户 / 连连 / Airwallex 做大额自动扣费）。
3. 未填 `PAYPAL_PAYMENT_URL` 时，`/api/checkout` 返回提示文案，不报错。

## 部署

**前置**：先注册 GitHub（存代码）+ 一个部署平台账号（Vercel / Render / Railway，均免费档够用）。本项目已 `git init` 就绪，代码推到 GitHub 后，在部署平台"Import Repository"即可。

Node 项目，`npm start` 启动（`server.js` 同时托管静态前端与 API）。在平台环境变量配置 `DASHSCOPE_API_KEY`、`DASHSCOPE_MODEL`（可选 `FINNHUB_API_KEY`、`PAYPAL_PAYMENT_URL`）。

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

- 成本：qwen-plus ≈ 几分钱/次，百炼新用户有免费额度，边际成本近乎为零。
- 真实行情：默认走 Yahoo（零 key）；若个别区域 Yahoo 不稳，填免费 `FINNHUB_API_KEY` 即自动升级为主源。

## 已知限制 / 下一步

- 行情已零 key 用 Yahoo chart meta（价格+市值+PE+股息率+Beta+52周），够研报所需；若要更稳定或补行业/简介，填免费 Finnhub key 即可自动升级为主源。
- 加入：用户账号、历史报告存档、持仓组合监控、PDF 导出、邮件早报（复用现有 Edge TTS 管线）。
- 合规：输出为方法论/框架演示，非投资建议——前端已带免责声明，上线前请复核当地金融监管要求。

## 目录结构

```
ai-value-saas/
├─ server.js        # Express：/api/analyze 多 Agent 引擎 + /api/checkout(PayPal) + /api/activate
├─ marketdata.js    # 真实行情源（Yahoo meta 零 key 主源 / Finnhub 可选增强）
├─ prompts.js       # 四位大师 system prompt + 综合编辑 prompt
├─ public/index.html# 纯黑墨极简前端（四镜卡片 + 综合结论 + 定价）
├─ .env             # 百炼 Key / 模型 / 端口 / Finnhub(可选) / PayPal 链接（已 gitignore）
└─ package.json
```
