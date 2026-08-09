// db.js — 内置 SQLite（node:sqlite），零额外服务，账号 + 组合监控
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data", "fourlens.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 迁移：老库补列（pro_status / paypal_email），重复执行忽略错误
try { db.exec("ALTER TABLE users ADD COLUMN pro_status TEXT NOT NULL DEFAULT 'none'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN paypal_email TEXT"); } catch {}

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
    return db.prepare("SELECT id, email, pro_status, paypal_email FROM users WHERE id=?").get(s.user_id) || null;
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
  activate(userId, paypalEmail) {
    db.prepare("UPDATE users SET pro_status='active', paypal_email=? WHERE id=?").run(paypalEmail || null, userId);
  },
};
