// db.js — 存储层：优先 Turso 云数据库（libsql），无凭据时回退本地 SQLite，零数据丢失风险
import Database from "libsql";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;
if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
  // 生产：Turso 云数据库（Render 免费实例重启不丢数据）
  db = new Database(process.env.TURSO_URL, { authToken: process.env.TURSO_TOKEN });
} else {
  // 本地开发回退
  const DB_PATH = process.env.DB_PATH || join(__dirname, "data", "fourlens.db");
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, ticker)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    paypal_email TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mail_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    subject TEXT,
    html TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS analysis_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    query TEXT,
    status TEXT NOT NULL DEFAULT 'generating',
    email_sent_at TEXT,
    error TEXT,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );
`);

// 迁移：老库补列（pro_status / paypal_email / orders.paid_at），重复执行忽略错误
try { db.exec("ALTER TABLE users ADD COLUMN pro_status TEXT NOT NULL DEFAULT 'none'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN paypal_email TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN free_used INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN paid_at TEXT"); } catch {}

// 幂等补列：PRAGMA table_info 检查，缺列才 ALTER（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列；
// 本地 SQLite 与生产 Turso/libsql 均支持 PRAGMA table_info）
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
// 两段式完整报告需要把邮件内容落库（Render 无发信通道时由 Mac 中继按内容代发）
ensureColumn("mail_queue", "subject", "TEXT");
ensureColumn("mail_queue", "html", "TEXT");

function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const h = scryptSync(pw, salt, 64).toString("hex");
  return h.length === hash.length && timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}
function newSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)").run(token, userId, expires);
  return token;
}

export const auth = {
  getUserById(id) { return db.prepare("SELECT * FROM users WHERE id=?").get(id) || null; },
  signup(email, pw) {
    email = (email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("invalid email");
    if (!pw || pw.length < 6) throw new Error("password must be at least 6 characters");
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) throw new Error("email already registered");
    const info = db.prepare("INSERT INTO users(email, password_hash) VALUES (?,?)").run(email, hashPassword(pw));
    return { token: newSession(info.lastInsertRowid), email };
  },
  login(email, pw) {
    email = (email || "").trim().toLowerCase();
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (!u || !verifyPassword(pw, u.password_hash)) throw new Error("invalid credentials");
    return { token: newSession(u.id), email: u.email };
  },
  getUser(token) {
    if (!token) return null;
    const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
    if (!s) return null;
    if (new Date(s.expires_at) < new Date()) {
      db.prepare("DELETE FROM sessions WHERE token=?").run(token);
      return null;
    }
    return db.prepare("SELECT id, email, pro_status, paypal_email, free_used FROM users WHERE id=?").get(s.user_id) || null;
  },
  consumeFree(userId) {
    db.prepare("UPDATE users SET free_used = free_used + 1 WHERE id=?").run(userId);
  },
};

export const portfolio = {
  list(userId) {
    return db.prepare("SELECT ticker FROM portfolios WHERE user_id=? ORDER BY created_at DESC").all(userId).map((r) => r.ticker);
  },
  add(userId, ticker) {
    const t = ticker.replace(/\./g, "-").toUpperCase();
    db.prepare("INSERT OR IGNORE INTO portfolios(user_id, ticker) VALUES (?,?)").run(userId, t);
    return t;
  },
  remove(userId, ticker) {
    const t = ticker.replace(/\./g, "-").toUpperCase();
    db.prepare("DELETE FROM portfolios WHERE user_id=? AND ticker=?").run(userId, t);
  },
};

// 个人 PayPal 收款：订单记录 + Pro 状态
export const billing = {
  createOrder(userId, plan, orderId) {
    db.prepare("INSERT OR IGNORE INTO orders(order_id, user_id, plan) VALUES (?,?,?)").run(orderId, userId, plan);
  },
  // IPN 回传后标记付款完成 + 自动激活 Pro（不再靠信任制手动回填）
  markPaid(orderId, payerEmail) {
    const o = db.prepare("SELECT * FROM orders WHERE order_id=?").get(orderId);
    if (!o) return null;
    db.prepare("UPDATE orders SET status='paid', paypal_email=?, paid_at=datetime('now') WHERE order_id=?").run(payerEmail || null, orderId);
    db.prepare("UPDATE users SET pro_status='active', paypal_email=? WHERE id=?").run(payerEmail || null, o.user_id);
    return o;
  },
  activate(userId, paypalEmail) {
    db.prepare("UPDATE users SET pro_status='active', paypal_email=? WHERE id=?").run(paypalEmail || null, userId);
  },
  // 管理员看板：所有订单 + 用户邮箱（巡检/对账用）
  listOrders() {
    return db.prepare(
      "SELECT o.order_id, o.user_id, o.plan, o.status, o.paypal_email AS order_paypal, o.created_at, o.paid_at, u.email AS user_email, u.pro_status FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC"
    ).all();
  },
};

// 分析用量：Pro 每月（自然月）配额核算的依据
export const usage = {
  log(userId, ticker) {
    db.prepare("INSERT INTO analysis_log(user_id, ticker) VALUES (?,?)").run(userId, ticker || "");
  },
  countMonth(userId) {
    const r = db.prepare(
      "SELECT COUNT(*) AS n FROM analysis_log WHERE user_id=? AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')"
    ).get(userId);
    return r ? Number(r.n) : 0;
  },
};

// 两段式报告：摘要秒回 → 完整报告异步落库 + 邮件送达
export const reports = {
  create(userId, ticker, query) {
    const r = db.prepare("INSERT INTO reports(user_id, ticker, query) VALUES (?,?,?)").run(userId, ticker, query || null);
    return Number(r.lastInsertRowid);
  },
  attach(id, data) {
    db.prepare("UPDATE reports SET data=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(data), id);
  },
  setStatus(id, status, error = null) {
    if (status === "sent") {
      db.prepare("UPDATE reports SET status=?, error=?, email_sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(status, error, id);
    } else {
      db.prepare("UPDATE reports SET status=?, error=?, updated_at=datetime('now') WHERE id=?").run(status, error, id);
    }
  },
  get(id) {
    return db.prepare("SELECT * FROM reports WHERE id=?").get(id) || null;
  },
};

// 发信队列：Render免费实例SMTP被封，排队由哥老官Mac的QQ邮箱中继代发（Plan C）
// 队列项可自带 subject/html（两段式完整报告）；不带内容的旧式项由中继用 picks 固定内容兜底
export const mailQueue = {
  add(email, opts = {}) {
    const subject = opts.subject || null;
    const html = opts.html || null;
    if (!subject && !html) {
      // 旧式无内容项：同邮箱已有未发任务则复用（保持 picks 双通道"先排队、直发成功即销队"语义）
      const pending = db.prepare("SELECT id FROM mail_queue WHERE email=? AND sent_at IS NULL").get(email);
      if (pending) return pending.id;
    }
    // 带内容项是独立的一封邮件，始终新建行
    const r = db.prepare("INSERT INTO mail_queue(email, subject, html) VALUES (?,?,?)").run(email, subject, html);
    return Number(r.lastInsertRowid);
  },
  pending(limit = 50) {
    return db.prepare("SELECT id, email, subject, html, created_at FROM mail_queue WHERE sent_at IS NULL ORDER BY id LIMIT ?").all(limit);
  },
  markSent(ids) {
    const stmt = db.prepare("UPDATE mail_queue SET sent_at=datetime('now') WHERE id=?");
    for (const id of ids) stmt.run(id);
  },
};
