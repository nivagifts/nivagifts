/* =========================================================
   NIVA SERVER — Complete Fixed Version
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
  console.error("Missing required env vars:", missingEnv.join(", "));
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be a valid port number.");
  process.exit(1);
}

const DB_PORT = Number(process.env.DB_PORT);
if (!Number.isInteger(DB_PORT) || DB_PORT < 1 || DB_PORT > 65535) {
  console.error("DB_PORT must be a valid port number.");
  process.exit(1);
}

if (process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
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

/* ---------- 6. BODY PARSING — 200 MB for video/photo uploads ---------- */
app.use(express.json({ limit: "200mb" }));

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
  message: {
    success: false,
    message: "Too many authentication attempts. Please try again later.",
  },
});

const giftFetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please slow down.",
  },
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

/* ---------- 10. HEALTH CHECK ---------- */
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, service: "NIVA", database: "connected" });
  } catch (err) {
    console.error("Health check failed:", { message: err.message, code: err.code });
    res.status(503).json({ success: false, service: "NIVA", database: "unavailable" });
  }
});

/* ---------- 11. AUTH ROUTES ---------- */

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

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    let user;

    try {
      const result = await pool.query(
        `INSERT INTO app.users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at`,
        [normalizeEmail(email), passwordHash]
      );
      user = result.rows[0];
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ success: false, message: "An account with this email already exists." });
      }
      throw err;
    }

    await regenerateSession(req);
    req.session.userId = String(user.id);
    req.session.userEmail = user.email;
    await saveSession(req);

    res.status(201).json({
      success: true,
      message: "Account created.",
      user: { id: String(user.id), email: user.email, createdAt: user.created_at },
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== "string" || !isValidEmail(email) ||
        typeof password !== "string" || password.length === 0 || password.length > 128) {
      return res.status(400).json({ success: false, message: "Invalid email or password." });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, created_at
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

/* ---------- 12. GIFT STORAGE ---------- */

// ⚠️ ADDING A NEW TEMPLATE: add its ID to this set.
const ALLOWED_TEMPLATE_IDS = new Set([
  "eternal-love",
  "love-proposal",
  "birthday-magic",
]);

/* ═══ 150 MB envelope — video (100 MB) + photos (50 MB each) + overhead ═══ */
const MAX_ENVELOPE_BYTES = 150 * 1024 * 1024;

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

app.post("/api/gifts", requireAuthenticated, async (req, res, next) => {
  try {
    const { templateId, envelope } = req.body || {};

    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Unsupported gift template." });
    }

    if (!validateEncryptedEnvelope(envelope)) {
      return res.status(400).json({ success: false, message: "Invalid encrypted gift payload." });
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
         created_at, updated_at, published_at)
       VALUES ($1, $2, $3, 'published', $4, NULL, NOW(), NOW(), NOW())
       RETURNING public_id, template_id, status, created_at`,
      [req.session.userId, publicId, templateId, encryptedPayload]
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

app.get("/api/gifts/:publicId", giftFetchLimiter, async (req, res, next) => {
  try {
    const { publicId } = req.params;

    if (!isValidPublicId(publicId)) {
      return res.status(404).json({ success: false, message: "Gift not found." });
    }

    const result = await pool.query(
      `SELECT template_id, encrypted_payload
       FROM app.gifts
       WHERE public_id = $1 AND status = 'published'
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

/* ═══ DELETE OWN GIFT ═══ */
app.delete("/api/gifts/:publicId", requireAuthenticated, async (req, res, next) => {
  try {
    const { publicId } = req.params;

    if (!isValidPublicId(publicId)) {
      return res.status(404).json({ success: false, message: "Gift not found." });
    }

    const result = await pool.query(
      `DELETE FROM app.gifts
       WHERE public_id = $1 AND owner_user_id = $2
       RETURNING public_id`,
      [publicId, req.session.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Gift not found or not yours." });
    }

    res.json({ success: true, message: "Gift deleted.", publicId });
  } catch (err) { next(err); }
});

/* ═══ LIST MY GIFTS ═══ */
app.get("/api/gifts", requireAuthenticated, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT public_id, template_id, status, created_at
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
        createdAt: g.created_at,
        url: "/g/" + g.public_id,
      })),
    });
  } catch (err) { next(err); }
});

/* ---------- 13. STATIC FILES ---------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

/* ✅ FIX: Explicit route for privacy.html */
app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(ROOT, "privacy.html"));
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

/* ---------- 14. 404 + ERROR ---------- */
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "API endpoint not found." });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

app.use((err, req, res, next) => {
  console.error("NIVA server error:", { message: err.message, code: err.code });
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "An unexpected server error occurred." });
});

/* ---------- 15. STARTUP + SHUTDOWN ---------- */
const server = app.listen(PORT, () => {
  console.log(`NIVA running at http://localhost:${PORT}`);
  console.log(`Environment: ${IS_PRODUCTION ? "production" : "development"}`);
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