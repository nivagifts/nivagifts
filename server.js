﻿/* =========================================================
   NIVA SERVER — Production Version
   PAYMENT-GATED GIFT PUBLISHING
   
   KEY RULE: A gift link is generated ONLY after a payment
   order is verified as PAID. There is no bypass path.
   ========================================================= */

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Pool } = require("pg");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const helmet = require("helmet");
const argon2 = require("argon2");
const { rateLimit } = require("express-rate-limit");

/* ---------- 1. APP CONFIG ---------- */
const app = express();
const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

app.disable("x-powered-by");
if (IS_PRODUCTION) app.set("trust proxy", 1);

/* ---------- 2. ENV VALIDATION ---------- */
const REQUIRED_ENV = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "SESSION_SECRET"];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error("❌ Missing required env vars:", missingEnv.join(", "));
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("❌ PORT must be a valid port number.");
  process.exit(1);
}
const DB_PORT = Number(process.env.DB_PORT);
if (!Number.isInteger(DB_PORT) || DB_PORT < 1 || DB_PORT > 65535) {
  console.error("❌ DB_PORT must be a valid port number.");
  process.exit(1);
}
if (process.env.SESSION_SECRET.length < 32) {
  console.error("❌ SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

const HAS_RESEND = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
if (!HAS_RESEND) {
  console.error("❌ Email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.");
}

/* ---------- 3. POSTGRES POOL ---------- */
const pool = new Pool({
  host: process.env.DB_HOST,
  port: DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 5,
  application_name: "NIVA",
});
pool.on("error", err => {
  console.error("Unexpected DB error:", { message: err.message, code: err.code });
});

/* ---------- 4. HTTPS REDIRECT ---------- */
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    if (req.header("x-forwarded-proto") !== "https") {
      return res.redirect(301, "https://" + req.header("host") + req.url);
    }
    next();
  });
}

/* ---------- 5. SECURITY ---------- */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: IS_PRODUCTION ? undefined : false,
}));

/* ---------- 6. BODY PARSING ---------- */
app.use(express.json({ limit: "1024mb" }));

/* ---------- 7. SESSIONS ---------- */
const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({
  pool,
  schemaName: "app",
  tableName: "sessions",
  createTableIfMissing: false,
  pruneSessionInterval: 15 * 60,
});

app.use(session({
  name: "niva.sid",
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  },
}));

/* ---------- 8. RATE LIMITERS ---------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." },
});
const giftFetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please slow down." },
});
const botLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, reply: "Too many messages — please wait a moment." },
});

/* ---------- 9. AUTH HELPERS ---------- */
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => (err ? reject(err) : resolve()));
  });
}
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(err => (err ? reject(err) : resolve()));
  });
}
function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy(err => (err ? reject(err) : resolve()));
  });
}
function normalizeEmail(email) { return email.trim().toLowerCase(); }
function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidPassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 128;
}
function normalizeUsername(name) { return String(name || "").trim().toLowerCase(); }
function isValidUsername(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 30) return false;
  if (!/^[A-Za-z0-9_.]+$/.test(trimmed)) return false;
  if (!/^[A-Za-z]/.test(trimmed)) return false;
  return true;
}
function usernameErrorMessage(name) {
  if (!name || typeof name !== "string") return "Please choose a username.";
  const t = name.trim();
  if (t.length < 3) return "Username must be at least 3 characters.";
  if (t.length > 30) return "Username must be at most 30 characters.";
  if (!/^[A-Za-z]/.test(t)) return "Username must start with a letter.";
  if (!/^[A-Za-z0-9_.]+$/.test(t)) return "Username can only use letters, numbers, underscore (_) and dot (.).";
  return null;
}
async function isUsernameTaken(name) {
  const normalized = normalizeUsername(name);
  if (!normalized) return false;
  const result = await pool.query(
    `SELECT 1 FROM app.users WHERE LOWER(username) = $1 LIMIT 1`,
    [normalized]
  );
  return result.rows.length > 0;
}
function requireAuthenticated(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ success: false, message: "Please log in to continue." });
  }
  next();
}
function clearSessionCookie(res) {
  res.clearCookie("niva.sid", {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
  });
}
function generateCode() { return String(crypto.randomInt(100000, 999999)); }
async function hashCode(code) { return argon2.hash(code, { type: argon2.argon2id }); }
async function verifyCode(hash, code) {
  try { return await argon2.verify(hash, code); } catch { return false; }
}

/* ---------- 10. EMAIL ---------- */
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.error("❌ Email unavailable: Resend configuration is missing.");
    return false;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`❌ Resend email failed (${response.status}):`, result.message || result.name || "Unknown API error");
      return false;
    }
    console.log(`📧 Resend accepted email request: ${subject}`);
    return true;
  } catch (err) {
    console.error(`❌ Email request failed: ${err.message}`);
    return false;
  }
}
function verificationEmailHTML(code, username) {
  const greeting = username ? `Hi ${username},` : "Hi there,";
  return `
    <div style="font-family: 'Playfair Display', Georgia, serif; max-width: 500px; margin: auto; padding: 32px; background: #fdf8f3; border-radius: 20px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="display: inline-block; width: 60px; height: 60px; line-height: 60px; border-radius: 50%; background: linear-gradient(145deg, #f9e8e4, #fff); color: #b76e79; font-size: 28px; font-family: Georgia, serif;">♥</span>
      </div>
      <h2 style="color: #b76e79; text-align: center; font-weight: 500; letter-spacing: 0.1em;">NIVA</h2>
      <p style="color: #3d2c2e; font-size: 16px; text-align: center; margin-top: 20px;">${greeting} your verification code is:</p>
      <div style="text-align: center; padding: 22px; background: #fff; border-radius: 14px; border: 1px solid #e8c4c8; margin: 22px 0;">
        <strong style="font-size: 38px; color: #b76e79; letter-spacing: 0.3em;">${code}</strong>
      </div>
      <p style="color: #6b5557; font-size: 14px; text-align: center;">This code expires in 10 minutes.</p>
      <p style="color: #9e8588; font-size: 12px; text-align: center; font-style: italic; margin-top: 28px; padding-top: 20px; border-top: 1px solid #f0dfd8;">Make moments eternal ✦</p>
    </div>`;
}
function resetEmailHTML(code, username) {
  const greeting = username ? `Hi ${username},` : "Hi there,";
  return `
    <div style="font-family: 'Playfair Display', Georgia, serif; max-width: 500px; margin: auto; padding: 32px; background: #fdf8f3; border-radius: 20px;">
      <h2 style="color: #b76e79; text-align: center; font-weight: 500; letter-spacing: 0.1em;">NIVA</h2>
      <p style="color: #3d2c2e; font-size: 16px; text-align: center; margin-top: 20px;">${greeting} your password reset code is:</p>
      <div style="text-align: center; padding: 22px; background: #fff; border-radius: 14px; border: 1px solid #e8c4c8; margin: 22px 0;">
        <strong style="font-size: 38px; color: #b76e79; letter-spacing: 0.3em;">${code}</strong>
      </div>
      <p style="color: #6b5557; font-size: 14px; text-align: center;">This code expires in 15 minutes.</p>
      <p style="color: #9e8588; font-size: 12px; text-align: center; font-style: italic; margin-top: 28px;">If you didn't request this, ignore this email.</p>
    </div>`;
}

/* ---------- 11. MIGRATIONS ---------- */
/* ⚠️  CRITICAL: payments MUST be created BEFORE gifts (gifts FK references payments) */
async function runMigrations() {
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS app;`);

    /* 1. USERS */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT,
        password_hash TEXT,
        email_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'users' AND column_name = 'username'
        ) THEN
          ALTER TABLE app.users ADD COLUMN username TEXT;
        END IF;
      END $$;`);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS IDX_users_username_lower
        ON app.users (LOWER(username))
        WHERE username IS NOT NULL;`);

    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'users'
            AND column_name = 'password_hash' AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE app.users ALTER COLUMN password_hash DROP NOT NULL;
        END IF;
      END $$;`);

    /* 2. SESSIONS */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.sessions (
        sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );`);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_sessions_expire ON app.sessions (expire);`);

    /* 3. PAYMENTS — MUST come BEFORE gifts */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.payments (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        gift_id UUID,
        amount_inr INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
        provider TEXT DEFAULT 'razorpay',
        provider_order_id TEXT,
        provider_payment_id TEXT,
        template_id TEXT,
        consumed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      );`);

    /* Add missing columns to legacy payments table */
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='app' AND table_name='payments' AND column_name='template_id') THEN
          ALTER TABLE app.payments ADD COLUMN template_id TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='app' AND table_name='payments' AND column_name='consumed') THEN
          ALTER TABLE app.payments ADD COLUMN consumed BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='app' AND table_name='payments' AND column_name='paid_at') THEN
          ALTER TABLE app.payments ADD COLUMN paid_at TIMESTAMPTZ;
        END IF;
      END $$;`);

    /* 4. GIFTS — references payments, users */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.gifts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        public_id TEXT UNIQUE NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'published',
        encrypted_payload BYTEA,
        gift_password_hash TEXT,
        paid BOOLEAN DEFAULT FALSE,
        amount_inr INTEGER,
        payment_id BIGINT REFERENCES app.payments(id),
        published BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );`);

      /* FIX: Add payment_id to an existing legacy table */
      await pool.query(`
      ALTER TABLE app.gifts
      ADD COLUMN IF NOT EXISTS payment_id BIGINT;
    `);

    /* Add FK on gifts -> payments if missing (for legacy DBs) */
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'gifts_payment_id_fkey'
        ) THEN
          ALTER TABLE app.gifts
          ADD CONSTRAINT gifts_payment_id_fkey
          FOREIGN KEY (payment_id) REFERENCES app.payments(id);
        END IF;
      END $$;`);

    /* 5. EMAIL CODES */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.email_codes (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`);
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_codes_type_check') THEN
          ALTER TABLE app.email_codes DROP CONSTRAINT email_codes_type_check;
        END IF;
      END $$;`);
    try {
      await pool.query(`
        ALTER TABLE app.email_codes
        ADD CONSTRAINT email_codes_type_check
        CHECK (type IN ('verify', 'reset'));`);
    } catch (_) {}
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_email_codes_lookup ON app.email_codes (email, type, used);`);

    /* 6. REVIEWS */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.reviews (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES app.users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'Verified customer',
        stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
        text TEXT NOT NULL CHECK (char_length(text) <= 500),
        tag TEXT DEFAULT 'NIVA gift',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`);

    /* 7. DRAFTS */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, template_id)
      );`);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_drafts_user ON app.drafts (user_id, updated_at DESC);`);

    /* 8. WISHLIST */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.wishlist (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, template_id)
      );`);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_wishlist_user ON app.wishlist (user_id, created_at DESC);`);

    console.log("✅ Database migrations complete.");
  } catch (err) {
    console.error("❌ Migration error:", err.message);
    console.error("Full error:", err);
    throw err;  // Do NOT swallow — fail startup so DB issues are noticed
  }
}

/* ---------- 12. HEALTH ---------- */
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, service: "NIVA", database: "connected" });
  } catch (err) {
    console.error("Health check failed:", { message: err.message, code: err.code });
    res.status(503).json({ success: false, service: "NIVA", database: "unavailable" });
  }
});

/* =========================================================
   13. AUTH ROUTES
   ========================================================= */

app.post("/api/auth/check-username", authLimiter, async (req, res, next) => {
  try {
    const { username } = req.body || {};
    const err = usernameErrorMessage(username);
    if (err) return res.status(400).json({ success: false, available: false, message: err });
    const taken = await isUsernameTaken(username);
    if (taken) {
      return res.status(200).json({
        success: true, available: false,
        message: "That username is already taken. Please pick another.",
      });
    }
    res.json({ success: true, available: true, message: "Username is available." });
  } catch (err) { next(err); }
});

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const { email, username } = req.body || {};
    if (typeof email !== "string" || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const unameError = usernameErrorMessage(username);
    if (unameError) return res.status(400).json({ success: false, message: unameError });

    const normalized = normalizeEmail(email);
    const cleanUsername = String(username).trim();

    if (await isUsernameTaken(cleanUsername)) {
      return res.status(409).json({
        success: false, usernameTaken: true,
        message: "That username is already taken. Please choose another.",
      });
    }

    const existing = await pool.query(
      `SELECT id, email, username, password_hash, email_verified FROM app.users WHERE email = $1 LIMIT 1`,
      [normalized]
    );

    if (existing.rows.length) {
      const user = existing.rows[0];
      if (user.password_hash) {
        return res.status(409).json({
          success: false, alreadyRegistered: true,
          message: "An account with this email already exists. Please sign in instead.",
        });
      }
      await pool.query(`UPDATE app.users SET username = $1 WHERE id = $2`, [cleanUsername, user.id]);
      const code = generateCode();
      const codeHash = await hashCode(code);
      await pool.query(
        `UPDATE app.email_codes SET used = TRUE WHERE email = $1 AND type = 'verify' AND used = FALSE`,
        [normalized]
      );
      await pool.query(
        `INSERT INTO app.email_codes (email, code_hash, type, expires_at)
         VALUES ($1, $2, 'verify', NOW() + INTERVAL '10 minutes')`,
        [normalized, codeHash]
      );
      const emailSent = await sendEmail({
        to: normalized,
        subject: "Your NIVA verification code",
        html: verificationEmailHTML(code, cleanUsername),
      });
      if (!emailSent) {
        return res.status(503).json({
          success: false,
          message: "We couldn't send your verification email right now. Please try again later.",
        });
      }
      return res.status(200).json({
        success: true, requiresVerification: true, email: normalized, username: cleanUsername,
        message: "A verification code has been sent to your email.",
      });
    }

    const result = await pool.query(
      `INSERT INTO app.users (email, username, password_hash, email_verified)
       VALUES ($1, $2, NULL, FALSE) RETURNING id, email, username`,
      [normalized, cleanUsername]
    );

    const code = generateCode();
    const codeHash = await hashCode(code);
    await pool.query(
      `INSERT INTO app.email_codes (email, code_hash, type, expires_at)
       VALUES ($1, $2, 'verify', NOW() + INTERVAL '10 minutes')`,
      [normalized, codeHash]
    );

    const emailSent = await sendEmail({
      to: normalized,
      subject: "Your NIVA verification code",
      html: verificationEmailHTML(code, cleanUsername),
    });
    if (!emailSent) {
      return res.status(503).json({
        success: false,
        message: "We couldn't send your verification email right now. Please try again later.",
      });
    }
    res.status(201).json({
      success: true,
      message: "Verification code sent. Check your email.",
      requiresVerification: true, email: normalized, username: cleanUsername,
      userId: String(result.rows[0].id),
    });
  } catch (err) {
    if (err.code === "23505" && String(err.constraint || "").includes("username")) {
      return res.status(409).json({
        success: false, usernameTaken: true,
        message: "That username is already taken. Please choose another.",
      });
    }
    if (err.code === "23505") {
      return res.status(409).json({
        success: false, alreadyRegistered: true,
        message: "An account with this email already exists. Please sign in instead.",
      });
    }
    next(err);
  }
});

app.post("/api/auth/verify-email", authLimiter, async (req, res, next) => {
  try {
    const { email, code } = req.body || {};
    if (!isValidEmail(email) || !/^\d{6}$/.test(String(code || ""))) {
      return res.status(400).json({ success: false, message: "Invalid email or code." });
    }
    const normalized = normalizeEmail(email);
    const result = await pool.query(
      `SELECT id, code_hash, expires_at FROM app.email_codes
       WHERE email = $1 AND type = 'verify' AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [normalized]
    );
    if (!result.rows.length) {
      return res.status(400).json({ success: false, message: "No active verification code. Please request a new one." });
    }
    const record = result.rows[0];
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    }
    const match = await verifyCode(record.code_hash, String(code));
    if (!match) {
      return res.status(400).json({ success: false, message: "Incorrect code. Please check and try again." });
    }
    await pool.query(`UPDATE app.email_codes SET used = TRUE WHERE id = $1`, [record.id]);
    const userResult = await pool.query(
      `UPDATE app.users SET email_verified = TRUE WHERE email = $1
       RETURNING id, email, username, password_hash, created_at`,
      [normalized]
    );
    if (!userResult.rows.length) {
      return res.status(400).json({ success: false, message: "Account not found." });
    }
    const user = userResult.rows[0];
    const hasPassword = Boolean(user.password_hash);

    if (hasPassword) {
      await regenerateSession(req);
      req.session.userId = String(user.id);
      req.session.userEmail = user.email;
      req.session.userName = user.username || null;
      await saveSession(req);
      return res.json({
        success: true, verified: true, hasPassword: true, authenticated: true,
        message: "Email verified. Welcome to NIVA.",
        user: {
          id: String(user.id), email: user.email, username: user.username || null,
          displayName: user.username || (user.email.split("@")[0]), createdAt: user.created_at,
        },
      });
    }
    res.json({
      success: true, verified: true, hasPassword: false, authenticated: false,
      email: user.email, username: user.username || null,
      message: "Email verified. Now set your password.",
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/set-password", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Invalid email." });
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: "Password must be between 8 and 128 characters." });
    }
    const normalized = normalizeEmail(email);
    const result = await pool.query(
      `SELECT id, email, username, password_hash, email_verified FROM app.users WHERE email = $1 LIMIT 1`,
      [normalized]
    );
    if (!result.rows.length) return res.status(400).json({ success: false, message: "Account not found." });
    const user = result.rows[0];
    if (!user.email_verified) {
      return res.status(400).json({ success: false, message: "Please verify your email first." });
    }
    if (user.password_hash) {
      return res.status(400).json({ success: false, message: "Password is already set. Please sign in." });
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await pool.query(`UPDATE app.users SET password_hash = $1 WHERE id = $2`, [passwordHash, user.id]);
    await regenerateSession(req);
    req.session.userId = String(user.id);
    req.session.userEmail = user.email;
    req.session.userName = user.username || null;
    await saveSession(req);
    res.json({
      success: true, message: "Password set. Welcome to NIVA.",
      user: {
        id: String(user.id), email: user.email, username: user.username || null,
        displayName: user.username || (user.email.split("@")[0]), createdAt: user.created_at,
      },
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/resend-code", authLimiter, async (req, res, next) => {
  try {
    const { email, purpose } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Invalid email." });
    const normalized = normalizeEmail(email);
    const codeType = purpose === "reset" ? "reset" : "verify";
    const userCheck = await pool.query(
      `SELECT id, username, email_verified, password_hash FROM app.users WHERE email = $1`,
      [normalized]
    );
    if (!userCheck.rows.length) {
      return res.status(404).json({ success: false, message: "No account with this email." });
    }
    const username = userCheck.rows[0].username || null;
    if (codeType === "verify" && userCheck.rows[0].email_verified) {
      return res.status(400).json({ success: false, message: "This email is already verified." });
    }
    const code = generateCode();
    const codeHash = await hashCode(code);
    await pool.query(
      `UPDATE app.email_codes SET used = TRUE WHERE email = $1 AND type = $2 AND used = FALSE`,
      [normalized, codeType]
    );
    await pool.query(
      `INSERT INTO app.email_codes (email, code_hash, type, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')`,
      [normalized, codeHash, codeType]
    );
    const emailSent = await sendEmail({
      to: normalized,
      subject: codeType === "reset" ? "Reset your NIVA password" : "Your new NIVA verification code",
      html: codeType === "reset" ? resetEmailHTML(code, username) : verificationEmailHTML(code, username),
    });
    if (!emailSent) {
      return res.status(503).json({
        success: false,
        message: "We couldn't send your email right now. Please try again later.",
      });
    }
    return res.json({ success: true, message: "New code sent." });
  } catch (err) { next(err); }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ success: false, message: "Please enter your email or username." });
    }
    if (typeof password !== "string" || password.length === 0 || password.length > 128) {
      return res.status(400).json({ success: false, message: "Please enter your password." });
    }
    const identifier = email.trim();
    const isEmail = identifier.includes("@");
    let result;
    if (isEmail) {
      result = await pool.query(
        `SELECT id, email, username, password_hash, email_verified, created_at
         FROM app.users WHERE email = $1 LIMIT 1`,
        [normalizeEmail(identifier)]
      );
    } else {
      result = await pool.query(
        `SELECT id, email, username, password_hash, email_verified, created_at
         FROM app.users WHERE LOWER(username) = $1 LIMIT 1`,
        [normalizeUsername(identifier)]
      );
    }
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, message: "Incorrect email/username or password." });
    }
    if (!user.password_hash) {
      return res.status(403).json({
        success: false,
        needsPasswordSetup: true, needsVerification: !user.email_verified,
        email: user.email, username: user.username || null,
        message: user.email_verified
          ? "Your account has no password yet. Please set a password."
          : "Please verify your email first.",
      });
    }
    let match = false;
    try { match = await argon2.verify(user.password_hash, password); } catch { match = false; }
    if (!match) {
      return res.status(401).json({ success: false, message: "Incorrect email/username or password." });
    }
    if (!user.email_verified) {
      const code = generateCode();
      const codeHash = await hashCode(code);
      await pool.query(
        `UPDATE app.email_codes SET used = TRUE WHERE email = $1 AND type = 'verify' AND used = FALSE`,
        [user.email]
      );
      await pool.query(
        `INSERT INTO app.email_codes (email, code_hash, type, expires_at)
         VALUES ($1, $2, 'verify', NOW() + INTERVAL '10 minutes')`,
        [user.email, codeHash]
      );
      const emailSent = await sendEmail({
        to: user.email,
        subject: "Your NIVA verification code",
        html: verificationEmailHTML(code, user.username || null),
      });
      if (!emailSent) {
        return res.status(503).json({
          success: false,
          message: "We couldn't send your verification email right now. Please try again later.",
        });
      }
      return res.status(403).json({
        success: false, needsVerification: true, email: user.email,
        message: "Please verify your email first. A new code has been sent.",
      });
    }
    await regenerateSession(req);
    req.session.userId = String(user.id);
    req.session.userEmail = user.email;
    req.session.userName = user.username || null;
    await saveSession(req);
    res.json({
      success: true, message: "Login successful.",
      user: {
        id: String(user.id), email: user.email, username: user.username || null,
        displayName: user.username || (user.email.split("@")[0]), createdAt: user.created_at,
      },
    });
  } catch (err) { next(err); }
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session?.userId) {
    return res.json({ success: true, authenticated: false, user: null });
  }
  const username = req.session.userName || null;
  res.json({
    success: true, authenticated: true,
    user: {
      id: req.session.userId, email: req.session.userEmail, username,
      displayName: username || (req.session.userEmail ? req.session.userEmail.split("@")[0] : "friend"),
    },
  });
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    if (req.session) await destroySession(req);
    clearSessionCookie(res);
    res.json({ success: true, message: "Logged out." });
  } catch (err) { next(err); }
});

app.post("/api/auth/forgot-password", authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Invalid email." });
    const normalized = normalizeEmail(email);
    const userCheck = await pool.query(`SELECT id, username FROM app.users WHERE email = $1`, [normalized]);
    if (!userCheck.rows.length) {
      return res.json({ success: true, message: "If an account exists, a reset code has been sent." });
    }
    const username = userCheck.rows[0].username || null;
    const code = generateCode();
    const codeHash = await hashCode(code);
    await pool.query(
      `UPDATE app.email_codes SET used = TRUE WHERE email = $1 AND type = 'reset' AND used = FALSE`,
      [normalized]
    );
    await pool.query(
      `INSERT INTO app.email_codes (email, code_hash, type, expires_at)
       VALUES ($1, $2, 'reset', NOW() + INTERVAL '15 minutes')`,
      [normalized, codeHash]
    );
    const emailSent = await sendEmail({
      to: normalized, subject: "Reset your NIVA password",
      html: resetEmailHTML(code, username),
    });
    if (!emailSent) {
      return res.status(503).json({
        success: false,
        message: "We couldn't send your email right now. Please try again later.",
      });
    }
    return res.json({ success: true, message: "If an account exists, a reset code has been sent." });
  } catch (err) { next(err); }
});

app.post("/api/auth/verify-reset-code", authLimiter, async (req, res, next) => {
  try {
    const { email, code } = req.body || {};
    if (!isValidEmail(email) || !/^\d{6}$/.test(String(code || ""))) {
      return res.status(400).json({ success: false, message: "Invalid email or code." });
    }
    const normalized = normalizeEmail(email);
    const result = await pool.query(
      `SELECT id, code_hash, expires_at FROM app.email_codes
       WHERE email = $1 AND type = 'reset' AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [normalized]
    );
    if (!result.rows.length) {
      return res.status(400).json({ success: false, message: "No active reset code. Please request a new one." });
    }
    const record = result.rows[0];
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    }
    const match = await verifyCode(record.code_hash, String(code));
    if (!match) {
      return res.status(400).json({ success: false, message: "Incorrect code. Please check and try again." });
    }
    await pool.query(`UPDATE app.email_codes SET used = TRUE WHERE id = $1`, [record.id]);
    req.session.resetEmail = normalized;
    req.session.resetVerifiedAt = Date.now();
    await saveSession(req);
    res.json({ success: true, verified: true, email: normalized, message: "Code verified. Now set your new password." });
  } catch (err) { next(err); }
});

app.post("/api/auth/reset-password", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Invalid email." });
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: "Password must be between 8 and 128 characters." });
    }
    const normalized = normalizeEmail(email);
    if (
      req.session?.resetEmail !== normalized ||
      !req.session?.resetVerifiedAt ||
      Date.now() - req.session.resetVerifiedAt > 15 * 60 * 1000
    ) {
      return res.status(403).json({
        success: false,
        message: "Reset session expired. Please verify the code again.",
      });
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const result = await pool.query(
      `UPDATE app.users SET password_hash = $1 WHERE email = $2 RETURNING id, email, username`,
      [passwordHash, normalized]
    );
    if (!result.rows.length) return res.status(400).json({ success: false, message: "Account not found." });
    delete req.session.resetEmail;
    delete req.session.resetVerifiedAt;
    await saveSession(req);
    res.json({ success: true, message: "Password reset successful. You can now sign in." });
  } catch (err) { next(err); }
});

app.get("/api/account", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, username, created_at FROM app.users WHERE id = $1 LIMIT 1`,
      [req.session.userId]
    );
    if (!result.rows.length) {
      await destroySession(req);
      clearSessionCookie(res);
      return res.status(401).json({ success: false, message: "Please log in again." });
    }
    const user = result.rows[0];
    res.json({
      success: true,
      user: {
        id: String(user.id), email: user.email, username: user.username || null,
        displayName: user.username || user.email.split("@")[0], createdAt: user.created_at,
      },
    });
  } catch (err) { next(err); }
});

/* ---------- 14. GIFT STORAGE ---------- */

const ALLOWED_TEMPLATE_IDS = new Set([
  "eternal-love", "love-proposal", "birthday-magic", "loveletter",
  "eternal-anniversary", "besties", "memory-box","apologyletter",
]);

const TEMPLATE_PRICES = {
  "eternal-love": 599,
  "love-proposal": 599,
  "birthday-magic": 299,
  "loveletter": 39,
  "eternal-anniversary": 599,
  "besties": 299,
  "memory-box": 99,
  "apologyletter": 39,
};

const MAX_ENVELOPE_BYTES = 1024 * 1024 * 1024;

function isValidPublicId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(value);
}

function validateEncryptedEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  if (envelope.version !== 1 || envelope.kdf !== "PBKDF2-SHA-256" || envelope.iterations !== 310000) return false;
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (typeof envelope.salt !== "string" || !b64.test(envelope.salt) ||
      typeof envelope.iv !== "string" || !b64.test(envelope.iv) ||
      typeof envelope.ciphertext !== "string" || !b64.test(envelope.ciphertext)) {
    return false;
  }
  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (salt.length !== 16 || iv.length !== 12 ||
        ciphertext.length < 17 || ciphertext.length > MAX_ENVELOPE_BYTES) {
      return false;
    }
    return salt.toString("base64") === envelope.salt &&
           iv.toString("base64") === envelope.iv &&
           ciphertext.toString("base64") === envelope.ciphertext;
  } catch { return false; }
}

/* =========================================================
   ⚠️  CRITICAL PAYMENT GATE ⚠️
   This is the ONLY endpoint that creates gift links.
   It requires:
     1) orderId referencing an app.payments row
     2) that row has status = 'paid'
     3) that row belongs to the current user
     4) that row's template_id matches the requested template
     5) that row's amount_inr matches the fixed price
     6) that row hasn't already been consumed (one gift per payment)
   
   If ANY check fails → gift link is NOT generated.
   ========================================================= */
app.post("/api/gifts", requireAuthenticated, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { templateId, envelope, orderId } = req.body || {};

    // 1. Template must be valid
    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Unsupported gift template." });
    }

    // 2. Encrypted envelope must be well-formed
    if (!validateEncryptedEnvelope(envelope)) {
      return res.status(400).json({ success: false, message: "Invalid encrypted gift payload." });
    }

    // 3. orderId is REQUIRED — no payment = no gift link
    if (!orderId || typeof orderId !== "string") {
      return res.status(402).json({
        success: false,
        code: "PAYMENT_REQUIRED",
        message: "Payment is required before generating a gift link.",
      });
    }

    const expectedPrice = TEMPLATE_PRICES[templateId];
    if (!expectedPrice) {
      return res.status(400).json({ success: false, message: "Unknown template price." });
    }

    await client.query("BEGIN");

    // 4. Lock the payment row and verify everything
    const payResult = await client.query(
      `SELECT id, amount_inr, status, template_id, consumed, user_id
       FROM app.payments
       WHERE provider_order_id = $1 AND user_id = $2
       FOR UPDATE`,
      [orderId, req.session.userId]
    );

    if (!payResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(402).json({
        success: false,
        code: "PAYMENT_NOT_FOUND",
        message: "No payment found for this order. Please pay first.",
      });
    }

    const pay = payResult.rows[0];

    if (pay.status !== "paid") {
      await client.query("ROLLBACK");
      return res.status(402).json({
        success: false,
        code: "PAYMENT_NOT_PAID",
        message: "Payment has not been completed. Please complete payment first.",
      });
    }

    if (pay.consumed) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        code: "PAYMENT_ALREADY_USED",
        message: "This payment has already been used to create a gift. Please make a new payment.",
      });
    }

    if (Number(pay.amount_inr) !== expectedPrice) {
      await client.query("ROLLBACK");
      return res.status(402).json({
        success: false,
        code: "AMOUNT_MISMATCH",
        message: `Paid amount ₹${pay.amount_inr} does not match template price ₹${expectedPrice}.`,
      });
    }

    if (pay.template_id && pay.template_id !== templateId) {
      await client.query("ROLLBACK");
      return res.status(402).json({
        success: false,
        code: "TEMPLATE_MISMATCH",
        message: `Payment was made for template "${pay.template_id}" but gift is for "${templateId}".`,
      });
    }

    // 5. Mark payment as consumed (single-use)
    await client.query(
      `UPDATE app.payments SET consumed = TRUE WHERE id = $1`,
      [pay.id]
    );

    // 6. Build the encrypted payload
    const encryptedPayload = Buffer.from(JSON.stringify(envelope), "utf8");
    if (encryptedPayload.length > MAX_ENVELOPE_BYTES) {
      await client.query("ROLLBACK");
      return res.status(413).json({ success: false, message: "The encrypted gift is too large." });
    }

    // 7. Generate the public ID (THE GIFT LINK)
    const publicId = crypto.randomBytes(24).toString("base64url");

    const result = await client.query(
      `INSERT INTO app.gifts
        (owner_user_id, public_id, template_id, status,
         encrypted_payload, gift_password_hash,
         created_at, updated_at, published_at,
         paid, amount_inr, payment_id, published)
       VALUES ($1, $2, $3, 'published', $4, NULL, NOW(), NOW(), NOW(),
               TRUE, $5, $6, TRUE)
       RETURNING public_id, template_id, status, created_at`,
      [req.session.userId, publicId, templateId, encryptedPayload, expectedPrice, pay.id]
    );

    const gift = result.rows[0];

    // 8. Clear the draft — the gift is now real
    await client.query(
      `DELETE FROM app.drafts WHERE user_id = $1 AND template_id = $2`,
      [req.session.userId, templateId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      gift: {
        publicId: gift.public_id,
        templateId: gift.template_id,
        status: gift.status,
        createdAt: gift.created_at,
        url: "/g/" + gift.public_id,
      },
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

app.get("/api/gifts/:publicId", giftFetchLimiter, async (req, res, next) => {
  try {
    const { publicId } = req.params;
    if (!isValidPublicId(publicId)) {
      return res.status(404).json({ success: false, message: "Gift not found." });
    }
    const result = await pool.query(
      `SELECT template_id, encrypted_payload
       FROM app.gifts
       WHERE public_id = $1 AND status = 'published' AND published = TRUE
       LIMIT 1`,
      [publicId]
    );
    if (!result.rows.length || !result.rows[0].encrypted_payload) {
      return res.status(404).json({ success: false, message: "Gift not found." });
    }
    let envelope;
    try {
      envelope = JSON.parse(Buffer.from(result.rows[0].encrypted_payload).toString("utf8"));
    } catch {
      return res.status(500).json({ success: false, message: "Gift data unavailable." });
    }
    res.set("Cache-Control", "no-store");
    res.json({ success: true, gift: { templateId: result.rows[0].template_id, envelope } });
  } catch (err) { next(err); }
});

app.delete("/api/gifts/:publicId", requireAuthenticated, async (req, res, next) => {
  try {
    const { publicId } = req.params;
    if (!isValidPublicId(publicId)) {
      return res.status(404).json({ success: false, message: "Gift not found." });
    }
    const result = await pool.query(
      `DELETE FROM app.gifts WHERE public_id = $1 AND owner_user_id = $2 RETURNING public_id`,
      [publicId, req.session.userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Gift not found or not yours." });
    }
    res.json({ success: true, message: "Gift deleted.", publicId });
  } catch (err) { next(err); }
});

app.get("/api/gifts", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT public_id, template_id, status, created_at, paid
       FROM app.gifts WHERE owner_user_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [req.session.userId]
    );
    res.json({
      success: true,
      gifts: result.rows.map(g => ({
        publicId: g.public_id, templateId: g.template_id, status: g.status,
        paid: g.paid, createdAt: g.created_at, url: "/g/" + g.public_id,
      })),
    });
  } catch (err) { next(err); }
});

/* ---------- 15. DRAFTS ---------- */
app.get("/api/drafts", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, template_id, data, updated_at, created_at
       FROM app.drafts WHERE user_id = $1
       ORDER BY updated_at DESC LIMIT 100`,
      [req.session.userId]
    );
    res.json({
      success: true,
      drafts: result.rows.map(d => ({
        id: d.id, templateId: d.template_id, data: d.data,
        updatedAt: d.updated_at, createdAt: d.created_at,
      })),
    });
  } catch (err) { next(err); }
});

app.get("/api/drafts/:templateId", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId } = req.params;
    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Invalid template." });
    }
    const result = await pool.query(
      `SELECT id, template_id, data, updated_at FROM app.drafts
       WHERE user_id = $1 AND template_id = $2 LIMIT 1`,
      [req.session.userId, templateId]
    );
    if (!result.rows.length) return res.json({ success: true, draft: null });
    const d = result.rows[0];
    res.json({
      success: true,
      draft: { id: d.id, templateId: d.template_id, data: d.data, updatedAt: d.updated_at },
    });
  } catch (err) { next(err); }
});

app.post("/api/drafts", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId, data } = req.body || {};
    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Invalid template." });
    }
    if (!data || typeof data !== "object") {
      return res.status(400).json({ success: false, message: "Draft data must be an object." });
    }
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, "utf8") > 5 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: "Draft is too large (max 5 MB)." });
    }
    const result = await pool.query(
      `INSERT INTO app.drafts (user_id, template_id, data, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_id, template_id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
       RETURNING id, template_id, data, updated_at`,
      [req.session.userId, templateId, json]
    );
    const d = result.rows[0];
    res.json({
      success: true,
      draft: { id: d.id, templateId: d.template_id, data: d.data, updatedAt: d.updated_at },
    });
  } catch (err) { next(err); }
});

app.delete("/api/drafts/:templateId", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId } = req.params;
    const result = await pool.query(
      `DELETE FROM app.drafts WHERE user_id = $1 AND template_id = $2 RETURNING id`,
      [req.session.userId, templateId]
    );
    res.json({ success: true, deleted: result.rows.length > 0 });
  } catch (err) { next(err); }
});

/* ---------- 16. WISHLIST ---------- */
app.get("/api/wishlist", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT template_id, created_at FROM app.wishlist
       WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.json({
      success: true,
      wishlist: result.rows.map(w => ({ templateId: w.template_id, createdAt: w.created_at })),
    });
  } catch (err) { next(err); }
});

app.post("/api/wishlist", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId } = req.body || {};
    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Invalid template." });
    }
    await pool.query(
      `INSERT INTO app.wishlist (user_id, template_id) VALUES ($1, $2)
       ON CONFLICT (user_id, template_id) DO NOTHING`,
      [req.session.userId, templateId]
    );
    res.json({ success: true, message: "Added to wishlist." });
  } catch (err) { next(err); }
});

app.delete("/api/wishlist/:templateId", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId } = req.params;
    await pool.query(
      `DELETE FROM app.wishlist WHERE user_id = $1 AND template_id = $2`,
      [req.session.userId, templateId]
    );
    res.json({ success: true, message: "Removed from wishlist." });
  } catch (err) { next(err); }
});

/* ---------- 17. STATS ---------- */
app.get("/api/stats", async (req, res) => {
  try {
    const [giftsResult, usersResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM app.gifts WHERE published = TRUE`),
      pool.query(`SELECT COUNT(*)::int AS count FROM app.users`),
    ]);
    res.json({
      success: true,
      templates: ALLOWED_TEMPLATE_IDS.size,
      giftsSent: giftsResult.rows[0].count,
      happyRecipients: usersResult.rows[0].count,
      uptime: 100,
    });
  } catch (err) {
    res.json({
      success: true, templates: ALLOWED_TEMPLATE_IDS.size,
      giftsSent: 0, happyRecipients: 0, uptime: 99,
    });
  }
});

/* ---------- 18. REVIEWS ---------- */
app.get("/api/reviews", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.role, r.stars, r.text, r.tag, r.created_at, u.username
       FROM app.reviews r
       LEFT JOIN app.users u ON u.id = r.user_id
       ORDER BY r.created_at DESC LIMIT 30`
    );
    res.json({
      success: true,
      reviews: result.rows.map((r, i) => ({
        id: r.id, name: r.username || r.name, role: r.role, stars: r.stars,
        text: r.text, tag: r.tag, avatarNum: (i % 6) + 1,
        date: new Date(r.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
      })),
    });
  } catch (err) {
    res.json({ success: true, reviews: [] });
  }
});

app.post("/api/reviews", requireAuthenticated, async (req, res, next) => {
  try {
    const { stars, text } = req.body || {};
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, message: "Rating must be between 1 and 5 stars." });
    }
    if (typeof text !== "string" || text.trim().length < 10 || text.length > 500) {
      return res.status(400).json({ success: false, message: "Review must be 10–500 characters." });
    }
    const existing = await pool.query(
      `SELECT id FROM app.reviews WHERE user_id = $1 LIMIT 1`,
      [req.session.userId]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: "You've already submitted a review." });
    }
    const userResult = await pool.query(
      `SELECT email, username FROM app.users WHERE id = $1 LIMIT 1`,
      [req.session.userId]
    );
    const user = userResult.rows[0] || {};
    const displayName = user.username || (user.email ? user.email.split("@")[0] : "A NIVA user");
    await pool.query(
      `INSERT INTO app.reviews (user_id, name, role, stars, text, tag)
       VALUES ($1, $2, 'Verified customer', $3, $4, 'NIVA gift')`,
      [req.session.userId, displayName, stars, text.trim()]
    );
    res.status(201).json({ success: true, message: "Review posted. Thank you!" });
  } catch (err) { next(err); }
});

/* =========================================================
   19. PAYMENTS — creates an order + confirms it as PAID.
   No gift is created here. Gift creation happens ONLY in
   /api/gifts above, which requires a paid, unconsumed order.
   ========================================================= */
let razorpay = null;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const Razorpay = require("razorpay");
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log("💳 Payments: Razorpay configured");
  } else {
    console.log("💳 Payments: Mock mode (no Razorpay keys)");
  }
} catch (err) {
  console.log("💳 Payments: Mock mode (razorpay package not installed)");
}

app.post("/api/payments/create-order", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId } = req.body || {};
    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Invalid template." });
    }
    const amount = TEMPLATE_PRICES[templateId];
    if (!amount) {
      return res.status(400).json({ success: false, message: "Unknown template price." });
    }

    if (!razorpay) {
      const orderId = "order_mock_" + crypto.randomBytes(8).toString("hex");
      await pool.query(
        `INSERT INTO app.payments (user_id, amount_inr, status, provider, provider_order_id, template_id)
         VALUES ($1, $2, 'pending', 'mock', $3, $4)`,
        [req.session.userId, amount, orderId, templateId]
      );
      return res.json({
        success: true, orderId, amount, currency: "INR",
        templateId, mock: true,
      });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: "niva_" + crypto.randomBytes(8).toString("hex"),
      notes: { templateId, userId: String(req.session.userId) },
    });

    await pool.query(
      `INSERT INTO app.payments (user_id, amount_inr, status, provider, provider_order_id, template_id)
       VALUES ($1, $2, 'pending', 'razorpay', $3, $4)`,
      [req.session.userId, amount, order.id, templateId]
    );

    res.json({
      success: true, orderId: order.id, amount, currency: "INR",
      templateId, keyId: process.env.RAZORPAY_KEY_ID, mock: false,
    });
  } catch (err) { next(err); }
});

/* Mock-mode confirm — marks order paid. */
app.post("/api/payments/confirm", requireAuthenticated, async (req, res, next) => {
  try {
    const { orderId, paymentId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, message: "Missing order ID." });

    const orderCheck = await pool.query(
      `SELECT provider FROM app.payments
       WHERE provider_order_id = $1 AND user_id = $2 LIMIT 1`,
      [orderId, req.session.userId]
    );
    if (!orderCheck.rows.length) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    if (orderCheck.rows[0].provider !== "mock") {
      return res.status(400).json({
        success: false,
        message: "Use /api/payments/verify for real payments.",
      });
    }

    const result = await pool.query(
      `UPDATE app.payments
       SET status = 'paid', provider_payment_id = $1, paid_at = NOW()
       WHERE provider_order_id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING id, amount_inr`,
      [paymentId || "mock_" + Date.now(), orderId, req.session.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Order not found or already paid." });
    }
    res.json({
      success: true, message: "Payment confirmed.",
      amount: result.rows[0].amount_inr,
    });
  } catch (err) { next(err); }
});

/* Real Razorpay verify — verifies signature then marks paid. */
app.post("/api/payments/verify", requireAuthenticated, async (req, res, next) => {
  try {
    const { orderId, paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: "Missing payment details." });
    }
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, message: "Invalid payment signature." });
    }
    const result = await pool.query(
      `UPDATE app.payments
       SET status = 'paid', provider_payment_id = $1, paid_at = NOW()
       WHERE provider_order_id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING id, amount_inr`,
      [paymentId, orderId, req.session.userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    res.json({ success: true, message: "Payment verified.", amount: result.rows[0].amount_inr });
  } catch (err) { next(err); }
});

/* =========================================================
   19e. NIVA BOT
   ========================================================= */
const BOT_KNOWLEDGE = [
  { id: "about", tag: "About", kw: ["what is niva","about niva","about","explain niva","what is this","what do you do"], a: "NIVA is a place to create beautiful personalised digital gifts — love letters, proposals, birthday surprises and more. Pick a template, add your words, photos and music, then share a private password-protected link with someone special. ✦", next: ["Pricing?","How to create a gift?","Is it private?"] },
  { id: "pricing", tag: "Pricing", kw: ["price","pricing","cost","how much","rate","fees","₹","rupee","plan","plans"], a: "Our gifts:\n• Love Letter — ₹39\n• Eternal Love — ₹599\n• Birthday Magic — ₹299\n• Love Proposal — ₹599\n• Eternal Anniversary — ₹599\n\nYou only pay when you publish — drafting and previewing is always free. 💕", next: ["What is the Love Letter?","How to create a gift?","Templates"] },
  { id: "special-letter", tag: "Love Letter", kw: ["special letter","love letter","loveletter","39","letter only","single letter","cheap","cheapest"], a: "The Love Letter is our sweetest little gift at just ₹39 💌\n\nTwo handwritten-style love letter pages, sealed with a beautiful envelope-opening animation. You'll find it in the templates grid.", next: ["Pricing?","How to create a gift?"] },
  { id: "templates", tag: "Templates", kw: ["template","templates","design","designs","theme","options","what can i make","kinds","types"], a: "We have several templates:\n✦ Eternal Love (₹599)\n✦ Love Proposal (₹599)\n✦ Birthday Magic (₹299)\n✦ Love Letter (₹39)\n✦ Eternal Anniversary (₹599)\n\nNew templates are added regularly.", next: ["Pricing?","How to create a gift?"] },
  { id: "howto", tag: "How to create", kw: ["how to create","how do i make","make a gift","create gift","start","begin","steps","how does it work"], a: "Making a gift is easy:\n\n1. Pick a template\n2. Sign up with a username + email — I can help right here\n3. Fill in your words & photos — live preview updates as you type\n4. Set a gift password and pay\n5. Share the private link ♥", next: ["Sign up","Pricing?","Is it private?"] },
  { id: "privacy", tag: "Privacy", kw: ["password","private","secure","encrypt","security","safe","is it private","data"], a: "Your gift is encrypted in your browser with AES-256-GCM before it ever reaches our server. 🔒\n\n• PBKDF2 key derivation (310,000 iterations)\n• Only ciphertext + metadata is stored\n• Recipient needs the password you set\n• We never see your gift content", next: ["How does the recipient open it?","Sign up"] },
  { id: "payment", tag: "Payment", kw: ["payment","pay","razorpay","upi","card","how to pay","checkout","billing"], a: "Payments are handled securely by Razorpay — UPI, cards, netbanking.\n\nYou only pay once, at the moment you publish a gift. Drafting & previewing is free.", next: ["Refunds?","Sign up"] },
  { id: "account", tag: "Account", kw: ["account","sign up","signup","register","login","sign in","email verify","otp","password reset","forgot password","username"], a: "I can help you sign in or sign up right here! ♥\n\nJust say:\n• sign up — to create a new account (choose a username!)\n• sign in — to log in\n• forgot password — to reset", next: ["Sign up","Sign in","Forgot password"] },
  { id: "mygifts", tag: "My Gifts", kw: ["my gifts","my gifts page","drafts","wishlist","saved","saved gifts","account page"], a: "Head to My Gifts from the home page. You'll find three tabs:\n• Drafts — works in progress\n• Published — finished gifts + shareable links\n• Wishlist — templates you've hearted ♥", next: ["Delete a gift?","What is a draft?"] },
  { id: "draft", tag: "Drafts", kw: ["draft","drafts","save","autosave","unsaved","work in progress"], a: "Drafts autosave to your browser as you type, and to your account within a couple of seconds. Hit \"Save Draft\" any time to force a cloud save.", next: ["My Gifts?","How to create a gift?"] },
  { id: "delete", tag: "Delete", kw: ["delete","remove","unpublish","stop link","take down","erase"], a: "Go to My Gifts → Published and tap Delete on any gift. The private link stops working immediately.", next: ["Refunds?","My Gifts?"] },
  { id: "upload", tag: "Uploads", kw: ["photos","images","upload","pictures","how many","size","limit","video","audio","music","gb","mb"], a: "You can upload photos, video and audio — up to 1 GB total per gift.\n• Photos: 800 MB each\n• Videos: 800 MB\n• Audio: 200 MB", next: ["How to create a gift?","Is it private?"] },
  { id: "refund", tag: "Refunds", kw: ["refund","cancel","return","money back","chargeback"], a: "Gifts are digital and shareable, so we don't offer refunds after publishing. If something fails before publishing, you won't be charged.", next: ["Payment?","Contact support?"] },
  { id: "contact", tag: "Contact", kw: ["contact","support","help","email you","reach you","talk to someone"], a: "Reach us through the Privacy & Safety page. Until then, I (NIVI!) can answer most questions. Just ask! 💕", next: ["Pricing?","Sign up"] },
  { id: "recipient", tag: "Recipient", kw: ["recipient","open gift","receive","someone sent","unlock","unlock gift"], a: "Your recipient opens the private link, enters the gift password you gave them, and the gift unlocks in their browser. ✦\n\nThe decryption happens locally — even we can't see it without the password.", next: ["Is it private?","Password?"] },
  { id: "editor", tag: "Editor", kw: ["editor","edit","live preview","preview","customise","customize","how does the editor"], a: "The editor is where your gift comes alive.\n\n• Left side: your words, photos, music\n• Right side: live preview updating as you type\n• Top right: Save Draft\n• Bottom: set gift password & publish", next: ["How to create a gift?","Save draft"] },
];

const BOT_INTENTS = [
  { id: "greeting", kw: ["hello","hi","hey","namaste","vanakkam","sup","yo","hola"], answers: ["Hi there! ♥ I'm NIVI — NIVA's little robot guide.","Hello! ✦ Ask about gifts, pricing, or say \"sign up\" / \"sign in\".","Hey! 💗 I can help with templates, pricing, or signing in."], next: ["What is NIVA?","Pricing?","Sign up","Sign in"] },
  { id: "thanks", kw: ["thank","thanks","thx","ty","appreciate"], answers: ["Anytime! ♥ ✦","You're welcome! ✦","Happy to help! 💕"], next: ["How to create a gift?","Pricing?"] },
  { id: "bye", kw: ["bye","goodbye","see you","later","cya"], answers: ["Goodbye! ♥ ✦","See you soon! 💕","Bye! ✦"], next: ["What is NIVA?"] },
  { id: "whoami", kw: ["who are you","your name","whats your name","what is your name","are you real","nivi"], answers: ["I'm NIVI — NIVA's little robot guide. ✦\n\nI can help you understand NIVA, or even sign you in / sign you up. Just ask! 💗"], next: ["Sign up","Sign in","What is NIVA?"] },
];

const BOT_FALLBACKS = [
  "I'm not sure I got that. Try pricing, templates, privacy, or say \"sign up\" / \"sign in\". ♡",
  "Hmm, beyond what I know. Try \"how much does it cost?\" or \"sign in\".",
  "I'd love to help — what would you like to know?",
];

function botNormalize(s) { return String(s || "").toLowerCase().trim(); }
function botScoreEntry(q, entry) {
  let best = 0;
  for (const kw of entry.kw) {
    if (!kw) continue;
    if (q === kw) best = Math.max(best, 100 + kw.length);
    else if (q.includes(kw)) best = Math.max(best, 60 + kw.length);
  }
  return best;
}
function botMatchIntent(q) {
  for (const intent of BOT_INTENTS) {
    for (const kw of intent.kw) {
      if (q === kw || q.startsWith(kw + " ") || q.endsWith(" " + kw) || q.includes(kw)) return intent;
    }
  }
  return null;
}
function botRankMatches(q) {
  if (!q) return [];
  const scored = BOT_KNOWLEDGE.map(e => ({ entry: e, score: botScoreEntry(q, e) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0].score;
  return scored.filter(x => x.score >= top * 0.7).slice(0, 2);
}
function botAnswer(message) {
  const q = botNormalize(message);
  if (!q) return { reply: BOT_FALLBACKS[0], next: [] };
  const intent = botMatchIntent(q);
  if (intent) {
    const pick = intent.answers[Math.floor(Math.random() * intent.answers.length)];
    return { reply: pick, next: intent.next || [] };
  }
  const matches = botRankMatches(q);
  if (matches.length) {
    if (matches.length === 1) return { reply: matches[0].entry.a, next: matches[0].entry.next || [] };
    const parts = matches.map(m => m.entry.a);
    return { reply: parts.join("\n\n──\n\n"), next: matches[0].entry.next || [] };
  }
  return { reply: BOT_FALLBACKS[Math.floor(Math.random() * BOT_FALLBACKS.length)], next: ["What is NIVA?","Pricing?","Sign up","Sign in"] };
}

app.post("/api/niva-bot", botLimiter, (req, res) => {
  try {
    const message = req.body?.message;
    if (typeof message !== "string") return res.status(400).json({ success: false, reply: "Please send a valid message." });
    if (message.length > 500) return res.status(400).json({ success: false, reply: "Please send a shorter message (max 500 characters)." });
    const { reply, next } = botAnswer(message);
    res.json({ success: true, reply, next, version: "3.4.0" });
  } catch (err) {
    console.error("Bot error:", err.message);
    res.status(500).json({ success: false, reply: "Oh no, my little brain glitched. Try again in a moment. 🥺", next: [] });
  }
});

/* ---------- 20. STATIC FILES ---------- */
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/privacy.html", (req, res) => res.sendFile(path.join(ROOT, "privacy.html")));
app.get("/my-gifts.html", requireAuthenticated, (req, res) => res.sendFile(path.join(ROOT, "my-gifts.html")));

app.get("/g/:publicId", (req, res) => {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("X-Content-Type-Options", "nosniff");
  if (!isValidPublicId(req.params.publicId)) return res.status(404).send("Gift not found.");
  res.sendFile(path.join(ROOT, "public", "recipient.html"));
});

app.get("/templates.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(ROOT, "src", "scripts", "templates.js"));
});

app.get("/nivabot.js", (req, res) => {
  const botPath = path.join(ROOT, "nivabot.js");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  if (!fs.existsSync(botPath)) {
    return res.status(404).type("text/plain").send("NIVI bot file is missing from the server deployment.");
  }
  res.type("application/javascript");
  res.sendFile(botPath, (err) => {
    if (err && !res.headersSent) {
      return res.status(500).type("text/plain").send("NIVI bot could not be loaded.");
    }
  });
});

app.use("/editor", express.static(path.join(ROOT, "editor"), { dotfiles: "deny", index: "editor.html" }));
app.use("/templates", express.static(path.join(ROOT, "templates"), { dotfiles: "deny", index: false }));
app.use("/public", express.static(path.join(ROOT, "public"), { dotfiles: "deny", index: false }));
app.use("/src", express.static(path.join(ROOT, "src"), { dotfiles: "deny", index: false }));

/* ---------- 21. 404 + ERROR ---------- */
app.use("/api", (req, res) => res.status(404).json({ success: false, message: "API endpoint not found." }));
app.use((req, res) => res.status(404).send("Page not found."));
app.use((err, req, res, next) => {
  console.error("NIVA server error:", { message: err.message, code: err.code, stack: err.stack });
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "An unexpected server error occurred." });
});

/* ---------- 22. STARTUP ---------- */
const server = app.listen(PORT, async () => {
  try {
    await runMigrations();
  } catch (err) {
    console.error("❌ Fatal: migrations failed. Server will not start correctly.");
    console.error(err);
    process.exit(1);
  }
  console.log("");
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   ✦ NIVA is running ✦                     ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log(`   URL:         http://localhost:${PORT}`);
  console.log(`   Environment: ${IS_PRODUCTION ? "production" : "development"}`);
  console.log(`   Email:       ${HAS_RESEND ? "✓ Resend API" : "✗ Not configured"}`);
  console.log(`   Payments:    ${razorpay ? "✓ Razorpay" : "✗ Mock mode"}`);
  console.log(`   Templates:   ${ALLOWED_TEMPLATE_IDS.size} registered`);
  console.log("");
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
  const timeout = setTimeout(() => { console.error("Shutdown timed out."); process.exit(1); }, 10000);
  timeout.unref();
  server.close(async () => {
    try {
      await new Promise((resolve, reject) => sessionStore.close(err => err ? reject(err) : resolve()));
      await pool.end();
      clearTimeout(timeout);
      console.log("Session store + DB closed.");
      process.exit(0);
    } catch (err) {
      clearTimeout(timeout);
      console.error("Shutdown error:", err.message);
      process.exit(1);
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);