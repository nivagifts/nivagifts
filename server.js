/* =========================================================
   NIVA SERVER — Complete Production-Ready Version
   Light Theme · Email Verification · Password Reset
   Reviews · Stats · Payment Gating · Contact
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
app.use(express.json({ limit: "700mb" }));

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
  limit: 10,
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

function isValidPassword(pw) {
  return typeof pw === "string" && pw.length >= 12 && pw.length <= 128;
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

/* ---------- 10. EMAIL SENDER (Optional — Gmail or console) ---------- */
let emailTransporter = null;

try {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    const nodemailer = require("nodemailer");
    emailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    console.log("📧 Email: Gmail SMTP configured");
  } else {
    console.log("📧 Email: NOT configured — codes will print to console");
  }
} catch (err) {
  console.warn("⚠️  Nodemailer not installed. Run: npm install nodemailer");
  console.warn("   Verification codes will print to console instead.");
}

async function sendEmail({ to, subject, html, fallbackCode }) {
  if (!emailTransporter) {
    console.log(`\n═══════════════════════════════════════════`);
    console.log(`📧 EMAIL (console fallback)`);
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    if (fallbackCode) console.log(`   🔑 CODE: ${fallbackCode}`);
    console.log(`═══════════════════════════════════════════\n`);
    return false;
  }

  try {
    await emailTransporter.sendMail({
      from: `"NIVA" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`📧 Email sent: ${subject} → ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Email failed: ${err.message}`);
    if (fallbackCode) {
      console.log(`\n🔑 FALLBACK CODE for ${to}: ${fallbackCode}\n`);
    }
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
    // Ensure schema exists
    await pool.query(`CREATE SCHEMA IF NOT EXISTS app;`);

    // Users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Sessions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.sessions (
        sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_sessions_expire ON app.sessions (expire);`);

    // Gifts
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

    // Email codes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app.email_codes (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('verify', 'reset')),
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_email_codes_lookup ON app.email_codes (email, type, used);`);

    // Reviews
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

    // Payments
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

/* ---------- 13. AUTH ROUTES ---------- */

// Register
app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== "string" || !isValidEmail(email) ||
        typeof password !== "string" || !isValidPassword(password)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email and a password between 12 and 128 characters.",
      });
    }

    const normalized = normalizeEmail(email);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    let user;

    try {
      const result = await pool.query(
        `INSERT INTO app.users (email, password_hash, email_verified)
         VALUES ($1, $2, FALSE)
         RETURNING id, email, created_at`,
        [normalized, passwordHash]
      );
      user = result.rows[0];
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ success: false, message: "An account with this email already exists." });
      }
      throw err;
    }

    // Generate + store verification code
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

    // Send email
    await sendEmail({
      to: normalized,
      subject: "Your NIVA verification code",
      html: verificationEmailHTML(code),
      fallbackCode: code,
    });

    res.status(201).json({
      success: true,
      message: "Account created. Please check your email for the verification code.",
      requiresVerification: true,
      user: { id: String(user.id), email: user.email },
    });
  } catch (err) { next(err); }
});

// Verify email
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
      return res.status(400).json({ success: false, message: "Incorrect code." });
    }

    await pool.query(`UPDATE app.email_codes SET used = TRUE WHERE id = $1`, [record.id]);

    const userResult = await pool.query(
      `UPDATE app.users SET email_verified = TRUE WHERE email = $1
       RETURNING id, email, created_at`,
      [normalized]
    );

    if (!userResult.rows.length) {
      return res.status(400).json({ success: false, message: "Account not found." });
    }

    const user = userResult.rows[0];

    await regenerateSession(req);
    req.session.userId = String(user.id);
    req.session.userEmail = user.email;
    await saveSession(req);

    res.json({
      success: true,
      message: "Email verified. Welcome to NIVA.",
      user: { id: String(user.id), email: user.email, createdAt: user.created_at },
    });
  } catch (err) { next(err); }
});

// Resend code
app.post("/api/auth/resend-code", authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Invalid email." });
    }
    const normalized = normalizeEmail(email);

    const userCheck = await pool.query(
      `SELECT id, email_verified FROM app.users WHERE email = $1`,
      [normalized]
    );
    if (!userCheck.rows.length) {
      return res.status(404).json({ success: false, message: "No account with this email." });
    }
    if (userCheck.rows[0].email_verified) {
      return res.status(400).json({ success: false, message: "This email is already verified." });
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

    await sendEmail({
      to: normalized,
      subject: "Your new NIVA verification code",
      html: verificationEmailHTML(code),
      fallbackCode: code,
    });

    res.json({ success: true, message: "New code sent." });
  } catch (err) { next(err); }
});

// Login
app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== "string" || !isValidEmail(email) ||
        typeof password !== "string" || password.length === 0 || password.length > 128) {
      return res.status(400).json({ success: false, message: "Invalid email or password." });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, email_verified, created_at
       FROM app.users WHERE email = $1 LIMIT 1`,
      [normalizeEmail(email)]
    );
    const user = result.rows[0];

    let match = false;
    if (user) {
      try { match = await argon2.verify(user.password_hash, password); }
      catch { match = false; }
    }

    if (!user || !match) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
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

      await sendEmail({
        to: user.email,
        subject: "Your NIVA verification code",
        html: verificationEmailHTML(code),
        fallbackCode: code,
      });

      return res.status(403).json({
        success: false,
        message: "Please verify your email first. A new code has been sent.",
        requiresVerification: true,
        email: user.email,
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

// Me
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

// Logout
app.post("/api/auth/logout", async (req, res, next) => {
  try {
    if (req.session) await destroySession(req);
    clearSessionCookie(res);
    res.json({ success: true, message: "Logged out." });
  } catch (err) { next(err); }
});

// Forgot password
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

    await sendEmail({
      to: normalized,
      subject: "Reset your NIVA password",
      html: resetEmailHTML(code),
      fallbackCode: code,
    });

    res.json({ success: true, message: "If an account exists, a reset code has been sent." });
  } catch (err) { next(err); }
});

// Reset password
app.post("/api/auth/reset-password", authLimiter, async (req, res, next) => {
  try {
    const { email, code, password } = req.body || {};
    if (!isValidEmail(email) || !/^\d{6}$/.test(String(code || "")) || !isValidPassword(password)) {
      return res.status(400).json({ success: false, message: "Invalid input. Password must be 12+ characters." });
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
      return res.status(400).json({ success: false, message: "Incorrect code." });
    }

    const newHash = await argon2.hash(password, { type: argon2.argon2id });

    await pool.query(`UPDATE app.users SET password_hash = $1 WHERE email = $2`, [newHash, normalized]);
    await pool.query(`UPDATE app.email_codes SET used = TRUE WHERE id = $1`, [record.id]);

    res.json({ success: true, message: "Password reset successful. You can now sign in." });
  } catch (err) { next(err); }
});

// Account
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

const MAX_ENVELOPE_BYTES = 512 * 1024 * 1024;

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

// Create gift
app.post("/api/gifts", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId, envelope, amountInr } = req.body || {};

    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Unsupported gift template." });
    }

    if (!validateEncryptedEnvelope(envelope)) {
      return res.status(400).json({ success: false, message: "Invalid encrypted gift payload." });
    }

    const expectedPrice = TEMPLATE_PRICES[templateId] || 299;
    if (Number(amountInr) !== expectedPrice) {
      return res.status(402).json({
        success: false,
        message: `Payment required. This template costs ₹${expectedPrice}.`,
        amountInr: expectedPrice,
      });
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

// Fetch gift
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

// Delete gift
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

// List my gifts
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

/* ---------- 15. STATS ---------- */
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

/* ---------- 16. REVIEWS ---------- */
app.get("/api/reviews", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role, stars, text, tag, created_at
       FROM app.reviews
       ORDER BY created_at DESC
       LIMIT 30`
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

/* ---------- 17. PAYMENTS ---------- */
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

    // Mock mode
    if (!razorpay) {
      const orderId = "order_mock_" + crypto.randomBytes(8).toString("hex");
      await pool.query(
        `INSERT INTO app.payments (user_id, amount_inr, status, provider, provider_order_id)
         VALUES ($1, $2, 'pending', 'mock', $3)`,
        [req.session.userId, amount, orderId]
      );
      return res.json({
        success: true,
        orderId,
        amount,
        currency: "INR",
        templateId,
        mock: true,
      });
    }

    // Real Razorpay
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
      success: true,
      orderId: order.id,
      amount,
      currency: "INR",
      templateId,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) { next(err); }
});

// Mock payment confirmation (for testing without Razorpay)
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

// Real Razorpay verification
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

/* ---------- 18. STATIC FILES ---------- */

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

/* ---------- 19. 404 + ERROR ---------- */
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

/* ---------- 20. STARTUP ---------- */
const server = app.listen(PORT, async () => {
  await runMigrations();
  console.log("");
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   ✦ NIVA is running ✦                     ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log(`   URL:         http://localhost:${PORT}`);
  console.log(`   Environment: ${IS_PRODUCTION ? "production" : "development"}`);
  console.log(`   Email:       ${emailTransporter ? "✓ Gmail SMTP" : "✗ Console fallback"}`);
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