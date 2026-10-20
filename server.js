/* =========================================================
   NIVA SERVER — Complete Production-Ready Version
   Light Theme · Email Verification · Password Reset
   Reviews · Stats · Payment Gating · Contact
   Drafts · Wishlist · 1GB uploads

   AUTH FLOW:
   - Register: email only → OTP sent → verify OTP → set password
   - Login: email + password (only after password set)
   - Reset: email → OTP sent → verify OTP → set new password

   EMAIL: Resend API (RESEND_API_KEY + RESEND_FROM_EMAIL)
   ========================================================= */

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
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
  console.error("Create a .env file with these variables. See .env.example");
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

const HAS_RESEND = Boolean(
  process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL
);

if (!HAS_RESEND) {
  console.error(
    "❌ Email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL."
  );
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

/* ---------- 4. HTTPS REDIRECT (production only) ---------- */
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    if (req.header("x-forwarded-proto") !== "https") {
      return res.redirect(301, "https://" + req.header("host") + req.url);
    }
    next();
  });
}

/* ---------- 5. SECURITY HEADERS ---------- */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: IS_PRODUCTION ? undefined : false,
}));

/* ---------- 6. BODY PARSING ---------- */
// 1 GB uploads need a big limit. Gifts are JSON envelopes (base64).
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

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Password: 8–128 characters
function isValidPassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 128;
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

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

async function hashCode(code) {
  return argon2.hash(code, { type: argon2.argon2id });
}

async function verifyCode(hash, code) {
  try {
    return await argon2.verify(hash, code);
  } catch {
    return false;
  }
}

/* ---------- 10. EMAIL SENDER (Resend API) ---------- */
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
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        `❌ Resend email failed (${response.status}):`,
        result.message || result.name || "Unknown API error"
      );
      return false;
    }

    console.log(`📧 Resend accepted email request: ${subject}`);
    return true;
  } catch (err) {
    console.error(`❌ Email request failed: ${err.message}`);
    return false;
  }
}

function verificationEmailHTML(code) {
  return `
    <div style="font-family: 'Playfair Display', Georgia, serif; max-width: 500px; margin: auto; padding: 32px; background: #fdf8f3; border-radius: 20px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="display: inline-block; width: 60px; height: 60px; line-height: 60px; border-radius: 50%; background: linear-gradient(145deg, #f9e8e4, #fff); color: #b76e79; font-size: 28px; font-family: Georgia, serif;">♥</span>
      </div>
      <h2 style="color: #b76e79; text-align: center; font-weight: 500; letter-spacing: 0.1em;">NIVA</h2>
      <p style="color: #3d2c2e; font-size: 16px; text-align: center; margin-top: 20px;">Your verification code is:</p>
      <div style="text-align: center; padding: 22px; background: #fff; border-radius: 14px; border: 1px solid #e8c4c8; margin: 22px 0;">
        <strong style="font-size: 38px; color: #b76e79; letter-spacing: 0.3em;">${code}</strong>
      </div>
      <p style="color: #6b5557; font-size: 14px; text-align: center;">This code expires in 10 minutes.</p>
      <p style="color: #9e8588; font-size: 12px; text-align: center; font-style: italic; margin-top: 28px; padding-top: 20px; border-top: 1px solid #f0dfd8;">Make moments eternal ✦</p>
    </div>
  `;
}

function resetEmailHTML(code) {
  return `
    <div style="font-family: 'Playfair Display', Georgia, serif; max-width: 500px; margin: auto; padding: 32px; background: #fdf8f3; border-radius: 20px;">
      <h2 style="color: #b76e79; text-align: center; font-weight: 500; letter-spacing: 0.1em;">NIVA</h2>
      <p style="color: #3d2c2e; font-size: 16px; text-align: center; margin-top: 20px;">Your password reset code is:</p>
      <div style="text-align: center; padding: 22px; background: #fff; border-radius: 14px; border: 1px solid #e8c4c8; margin: 22px 0;">
        <strong style="font-size: 38px; color: #b76e79; letter-spacing: 0.3em;">${code}</strong>
      </div>
      <p style="color: #6b5557; font-size: 14px; text-align: center;">This code expires in 15 minutes.</p>
      <p style="color: #9e8588; font-size: 12px; text-align: center; font-style: italic; margin-top: 28px;">If you didn't request this, ignore this email.</p>
    </div>
  `;
}

/* ---------- 11. DATABASE MIGRATIONS ---------- */
async function runMigrations() {
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS app;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        email_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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
      END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.sessions (
        sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_sessions_expire ON app.sessions (expire);`);

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
        published BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.email_codes (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'email_codes_type_check'
        ) THEN
          ALTER TABLE app.email_codes DROP CONSTRAINT email_codes_type_check;
        END IF;
      END $$;
    `);
    try {
      await pool.query(`
        ALTER TABLE app.email_codes
        ADD CONSTRAINT email_codes_type_check
        CHECK (type IN ('verify', 'reset'));
      `);
    } catch (_) { /* already exists */ }

    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_email_codes_lookup ON app.email_codes (email, type, used);`);

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
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.payments (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        gift_id UUID REFERENCES app.gifts(id) ON DELETE CASCADE,
        amount_inr INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
        provider TEXT DEFAULT 'razorpay',
        provider_order_id TEXT,
        provider_payment_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    /* ---------- NEW: drafts ---------- */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, template_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_drafts_user ON app.drafts (user_id, updated_at DESC);`);

    /* ---------- NEW: wishlist ---------- */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.wishlist (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES app.users(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, template_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_wishlist_user ON app.wishlist (user_id, created_at DESC);`);

    console.log("✅ Database migrations complete.");
  } catch (err) {
    console.error("❌ Migration error:", err.message);
    console.error("Full error:", err);
  }
}

/* ---------- 12. HEALTH CHECK ---------- */
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

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};

    if (typeof email !== "string" || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }

    const normalized = normalizeEmail(email);

    const existing = await pool.query(
      `SELECT id, email, password_hash, email_verified FROM app.users WHERE email = $1 LIMIT 1`,
      [normalized]
    );

    if (existing.rows.length) {
      const user = existing.rows[0];

      if (user.password_hash) {
        return res.status(409).json({
          success: false,
          alreadyRegistered: true,
          message: "An account with this email already exists. Please sign in instead.",
        });
      }

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
        html: verificationEmailHTML(code),
      });

      if (!emailSent) {
        return res.status(503).json({
          success: false,
          message: "We couldn't send your verification email right now. Please try again later.",
        });
      }

      return res.status(200).json({
        success: true,
        requiresVerification: true,
        email: normalized,
        message: "A verification code has been sent to your email.",
      });
    }

    const result = await pool.query(
      `INSERT INTO app.users (email, password_hash, email_verified)
       VALUES ($1, NULL, FALSE)
       RETURNING id, email`,
      [normalized]
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
      html: verificationEmailHTML(code),
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
      requiresVerification: true,
      email: normalized,
      userId: String(result.rows[0].id),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        alreadyRegistered: true,
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
       RETURNING id, email, password_hash, created_at`,
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
      await saveSession(req);

      return res.json({
        success: true,
        verified: true,
        hasPassword: true,
        authenticated: true,
        message: "Email verified. Welcome to NIVA.",
        user: { id: String(user.id), email: user.email, createdAt: user.created_at },
      });
    }

    res.json({
      success: true,
      verified: true,
      hasPassword: false,
      authenticated: false,
      email: user.email,
      message: "Email verified. Now set your password.",
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/set-password", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Invalid email." });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must be between 8 and 128 characters.",
      });
    }

    const normalized = normalizeEmail(email);

    const result = await pool.query(
      `SELECT id, email, password_hash, email_verified FROM app.users WHERE email = $1 LIMIT 1`,
      [normalized]
    );

    if (!result.rows.length) {
      return res.status(400).json({ success: false, message: "Account not found." });
    }

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
    await saveSession(req);

    res.json({
      success: true,
      message: "Password set. Welcome to NIVA.",
      user: { id: String(user.id), email: user.email, createdAt: user.created_at },
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/resend-code", authLimiter, async (req, res, next) => {
  try {
    const { email, purpose } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Invalid email." });
    }
    const normalized = normalizeEmail(email);
    const codeType = purpose === "reset" ? "reset" : "verify";

    const userCheck = await pool.query(
      `SELECT id, email_verified, password_hash FROM app.users WHERE email = $1`,
      [normalized]
    );
    if (!userCheck.rows.length) {
      return res.status(404).json({ success: false, message: "No account with this email." });
    }

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
      html: codeType === "reset" ? resetEmailHTML(code) : verificationEmailHTML(code),
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

    if (typeof email !== "string" || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email." });
    }
    if (typeof password !== "string" || password.length === 0 || password.length > 128) {
      return res.status(400).json({ success: false, message: "Please enter your password." });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, email_verified, created_at
       FROM app.users WHERE email = $1 LIMIT 1`,
      [normalizeEmail(email)]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: "Incorrect email or password." });
    }

    if (!user.password_hash) {
      return res.status(403).json({
        success: false,
        needsPasswordSetup: true,
        needsVerification: !user.email_verified,
        email: user.email,
        message: user.email_verified
          ? "Your account has no password yet. Please set a password."
          : "Please verify your email first.",
      });
    }

    let match = false;
    try { match = await argon2.verify(user.password_hash, password); }
    catch { match = false; }

    if (!match) {
      return res.status(401).json({ success: false, message: "Incorrect email or password." });
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
        html: verificationEmailHTML(code),
      });

      if (!emailSent) {
        return res.status(503).json({
          success: false,
          message: "We couldn't send your verification email right now. Please try again later.",
        });
      }

      return res.status(403).json({
        success: false,
        needsVerification: true,
        email: user.email,
        message: "Please verify your email first. A new code has been sent.",
      });
    }

    await regenerateSession(req);
    req.session.userId = String(user.id);
    req.session.userEmail = user.email;
    await saveSession(req);

    res.json({
      success: true,
      message: "Login successful.",
      user: { id: String(user.id), email: user.email, createdAt: user.created_at },
    });
  } catch (err) { next(err); }
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session?.userId) {
    return res.json({ success: true, authenticated: false, user: null });
  }
  res.json({
    success: true,
    authenticated: true,
    user: { id: req.session.userId, email: req.session.userEmail },
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
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Invalid email." });
    }
    const normalized = normalizeEmail(email);

    const userCheck = await pool.query(`SELECT id FROM app.users WHERE email = $1`, [normalized]);
    if (!userCheck.rows.length) {
      return res.json({ success: true, message: "If an account exists, a reset code has been sent." });
    }

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
      to: normalized,
      subject: "Reset your NIVA password",
      html: resetEmailHTML(code),
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

    res.json({
      success: true,
      verified: true,
      email: normalized,
      message: "Code verified. Now set your new password.",
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/reset-password", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Invalid email." });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must be between 8 and 128 characters.",
      });
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
      `UPDATE app.users SET password_hash = $1 WHERE email = $2 RETURNING id, email`,
      [passwordHash, normalized]
    );

    if (!result.rows.length) {
      return res.status(400).json({ success: false, message: "Account not found." });
    }

    delete req.session.resetEmail;
    delete req.session.resetVerifiedAt;
    await saveSession(req);

    res.json({ success: true, message: "Password reset successful. You can now sign in." });
  } catch (err) { next(err); }
});

app.get("/api/account", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, created_at FROM app.users WHERE id = $1 LIMIT 1`,
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
      user: { id: String(user.id), email: user.email, createdAt: user.created_at },
    });
  } catch (err) { next(err); }
});

/* ---------- 14. GIFT STORAGE ---------- */

const ALLOWED_TEMPLATE_IDS = new Set([
  "eternal-love",
  "love-proposal",
  "birthday-magic",
]);

const TEMPLATE_PRICES = {
  "eternal-love": 299,
  "love-proposal": 599,
  "birthday-magic": 299,
};

// ~1 GB encrypted envelope cap.
const MAX_ENVELOPE_BYTES = 1024 * 1024 * 1024;

function isValidPublicId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,80}$/.test(value);
}

function validateEncryptedEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;

  if (envelope.version !== 1 ||
      envelope.kdf !== "PBKDF2-SHA-256" ||
      envelope.iterations !== 310000) {
    return false;
  }

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

// Create gift (payment already verified via /api/payments/confirm or /verify)
app.post("/api/gifts", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId, envelope, orderId } = req.body || {};

    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Unsupported gift template." });
    }

    if (!validateEncryptedEnvelope(envelope)) {
      return res.status(400).json({ success: false, message: "Invalid encrypted gift payload." });
    }

    const expectedPrice = TEMPLATE_PRICES[templateId] || 299;

    // Verify a paid order exists for this user + amount
    if (orderId) {
      const payCheck = await pool.query(
        `SELECT id, amount_inr FROM app.payments
         WHERE provider_order_id = $1 AND user_id = $2 AND status = 'paid' LIMIT 1`,
        [orderId, req.session.userId]
      );
      if (!payCheck.rows.length) {
        return res.status(402).json({
          success: false,
          message: "Payment not confirmed for this order.",
        });
      }
      if (Number(payCheck.rows[0].amount_inr) !== expectedPrice) {
        return res.status(402).json({
          success: false,
          message: `Paid amount does not match template price ₹${expectedPrice}.`,
        });
      }
    }

    const encryptedPayload = Buffer.from(JSON.stringify(envelope), "utf8");
    if (encryptedPayload.length > MAX_ENVELOPE_BYTES) {
      return res.status(413).json({ success: false, message: "The encrypted gift is too large." });
    }

    const publicId = crypto.randomBytes(24).toString("base64url");

    const result = await pool.query(
      `INSERT INTO app.gifts
        (owner_user_id, public_id, template_id, status,
         encrypted_payload, gift_password_hash,
         created_at, updated_at, published_at,
         paid, amount_inr, published)
       VALUES ($1, $2, $3, 'published', $4, NULL, NOW(), NOW(), NOW(),
               TRUE, $5, TRUE)
       RETURNING public_id, template_id, status, created_at`,
      [req.session.userId, publicId, templateId, encryptedPayload, expectedPrice]
    );

    const gift = result.rows[0];

    // Clean up any saved draft for this template once published
    await pool.query(
      `DELETE FROM app.drafts WHERE user_id = $1 AND template_id = $2`,
      [req.session.userId, templateId]
    );

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
  } catch (err) { next(err); }
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
    res.json({
      success: true,
      gift: { templateId: result.rows[0].template_id, envelope },
    });
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
       FROM app.gifts
       WHERE owner_user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.session.userId]
    );

    res.json({
      success: true,
      gifts: result.rows.map(g => ({
        publicId: g.public_id,
        templateId: g.template_id,
        status: g.status,
        paid: g.paid,
        createdAt: g.created_at,
        url: "/g/" + g.public_id,
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
        id: d.id,
        templateId: d.template_id,
        data: d.data,
        updatedAt: d.updated_at,
        createdAt: d.created_at,
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
    if (!result.rows.length) {
      return res.json({ success: true, draft: null });
    }
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
      wishlist: result.rows.map(w => ({
        templateId: w.template_id,
        createdAt: w.created_at,
      })),
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
      success: true,
      templates: ALLOWED_TEMPLATE_IDS.size,
      giftsSent: 0,
      happyRecipients: 0,
      uptime: 99,
    });
  }
});

/* ---------- 18. REVIEWS ---------- */
app.get("/api/reviews", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role, stars, text, tag, created_at
       FROM app.reviews ORDER BY created_at DESC LIMIT 30`
    );

    res.json({
      success: true,
      reviews: result.rows.map((r, i) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        stars: r.stars,
        text: r.text,
        tag: r.tag,
        avatarNum: (i % 6) + 1,
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
      `SELECT email FROM app.users WHERE id = $1 LIMIT 1`,
      [req.session.userId]
    );
    const email = userResult.rows[0]?.email || "Anonymous";
    const displayName = email.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    await pool.query(
      `INSERT INTO app.reviews (user_id, name, role, stars, text, tag)
       VALUES ($1, $2, 'Verified customer', $3, $4, 'NIVA gift')`,
      [req.session.userId, displayName || "A NIVA user", stars, text.trim()]
    );

    res.status(201).json({ success: true, message: "Review posted. Thank you!" });
  } catch (err) { next(err); }
});

/* ---------- 19. PAYMENTS ---------- */
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

    const amount = TEMPLATE_PRICES[templateId] || 299;

    if (!razorpay) {
      const orderId = "order_mock_" + crypto.randomBytes(8).toString("hex");
      await pool.query(
        `INSERT INTO app.payments (user_id, amount_inr, status, provider, provider_order_id)
         VALUES ($1, $2, 'pending', 'mock', $3)`,
        [req.session.userId, amount, orderId]
      );
      return res.json({
        success: true, orderId, amount, currency: "INR", templateId, mock: true,
      });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: "niva_" + crypto.randomBytes(8).toString("hex"),
      notes: { templateId, userId: String(req.session.userId) },
    });

    await pool.query(
      `INSERT INTO app.payments (user_id, amount_inr, status, provider, provider_order_id)
       VALUES ($1, $2, 'pending', 'razorpay', $3)`,
      [req.session.userId, amount, order.id]
    );

    res.json({
      success: true, orderId: order.id, amount, currency: "INR",
      templateId, keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) { next(err); }
});

app.post("/api/payments/confirm", requireAuthenticated, async (req, res, next) => {
  try {
    const { orderId, paymentId } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Missing order ID." });
    }

    const result = await pool.query(
      `UPDATE app.payments
       SET status = 'paid', provider_payment_id = $1
       WHERE provider_order_id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING id, amount_inr`,
      [paymentId || "mock_" + Date.now(), orderId, req.session.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Order not found or already paid." });
    }

    res.json({ success: true, message: "Payment confirmed.", amount: result.rows[0].amount_inr });
  } catch (err) { next(err); }
});

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
       SET status = 'paid', provider_payment_id = $1
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

/* ---------- 20. STATIC FILES ---------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(ROOT, "privacy.html"));
});

app.get("/my-gifts.html", requireAuthenticated, (req, res) => {
  res.sendFile(path.join(ROOT, "my-gifts.html"));
});

app.get("/g/:publicId", (req, res) => {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("X-Content-Type-Options", "nosniff");

  if (!isValidPublicId(req.params.publicId)) {
    return res.status(404).send("Gift not found.");
  }

  res.sendFile(path.join(ROOT, "public", "recipient.html"));
});

app.use("/editor", express.static(path.join(ROOT, "editor"), {
  dotfiles: "deny",
  index: "editor.html",
}));

app.use("/templates", express.static(path.join(ROOT, "templates"), {
  dotfiles: "deny",
  index: false,
}));

app.use("/public", express.static(path.join(ROOT, "public"), {
  dotfiles: "deny",
  index: false,
}));

app.use("/src", express.static(path.join(ROOT, "src"), {
  dotfiles: "deny",
  index: false,
}));

/* ---------- 21. 404 + ERROR ---------- */
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "API endpoint not found." });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

app.use((err, req, res, next) => {
  console.error("NIVA server error:", { message: err.message, code: err.code, stack: err.stack });
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "An unexpected server error occurred." });
});

/* ---------- 22. STARTUP ---------- */
const server = app.listen(PORT, async () => {
  await runMigrations();
  console.log("");
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   ✦ NIVA is running ✦                     ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log(`   URL:         http://localhost:${PORT}`);
  console.log(`   Environment: ${IS_PRODUCTION ? "production" : "development"}`);
  console.log(`   Email:       ${HAS_RESEND ? "✓ Resend API" : "✗ Not configured"}`);
  console.log(`   Payments:    ${razorpay ? "✓ Razorpay" : "✗ Mock mode"}`);
  console.log("");
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("\nShutting down…");

  const timeout = setTimeout(() => {
    console.error("Shutdown timed out.");
    process.exit(1);
  }, 10000);
  timeout.unref();

  server.close(async () => {
    try {
      await new Promise((resolve, reject) => {
        sessionStore.close(err => (err ? reject(err) : resolve()));
      });
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