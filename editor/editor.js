/* =========================================================
   NIVA UNIVERSAL GIFT EDITOR — Light Theme + Payment Gate
   - Fixed price from template (incl. Special Letter ₹39)
   - ~1 GB upload limit
   - Cloud drafts (text only) + local draft
   ========================================================= */
"use strict";

const MAX_PREVIEW_IMAGE_SIZE = 1600;
const MAX_ENVELOPE_BYTES = 1024 * 1024 * 1024;          // ~1 GB encrypted gift
const MAX_TOTAL_MEDIA_BYTES = 1000 * 1024 * 1024;       // ~1000 MB raw media
const MAX_DRAFT_BYTES = 5 * 1024 * 1024;                // 5 MB cloud draft
const DRAFT_KEY_PREFIX = "niva-draft-";
const PREVIEW_KEY_PREFIX = "niva-preview-";

// Fixed prices per template — kept in sync with server.js TEMPLATE_PRICES.
const TEMPLATE_PRICES = {
  "eternal-love": 299,
  "love-proposal": 599,
  "birthday-magic": 299,
  "special-letter": 39,
};

const TEMPLATE_PLAN_NAMES = {
  39: "Special Letter",
  99: "Essential",
  299: "Signature",
  599: "Evermore",
};

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

/* ---------- 1. CONTEXT ---------- */
const params = new URLSearchParams(window.location.search);
const context = {
  templateId: params.get("template") || "eternal-love",
  category: params.get("category") || "love",
  config: null,
  fields: {},
  user: null,
  cloudDraftId: null,
};
const DRAFT_KEY = DRAFT_KEY_PREFIX + context.templateId;
const PREVIEW_KEY = PREVIEW_KEY_PREFIX + context.templateId;

const TEMPLATE_PRICE = TEMPLATE_PRICES[context.templateId] ?? 299;

/* ---------- 2. UTILITIES ---------- */
function showToast(message, ms = 3000) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), ms);
}

function setSaveStatus(msg) {
  const el = $("#saveStatus");
  if (el) el.textContent = msg;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/* ---------- 3. AUTH GATE ---------- */
async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (data?.authenticated === true && data.user) return data.user;
    return null;
  } catch { return null; }
}

function showLoginGate() {
  const gate = $("#loginGate");
  const editorRoot = $("#editorRoot");
  if (gate) gate.hidden = false;
  if (editorRoot) editorRoot.hidden = true;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#loginEmail")?.focus(), 100);
}

function showEditor() {
  const gate = $("#loginGate");
  const editorRoot = $("#editorRoot");
  if (gate) gate.hidden = true;
  if (editorRoot) editorRoot.hidden = false;
  document.body.style.overflow = "";
}

/* ---------- 4. LOGIN UI ---------- */
function initLoginUI(onSuccess) {
  const showPane = (id) => {
    ["loginPane", "registerPane", "verifyPane", "setPasswordPane", "forgotPane", "verifyResetPane", "resetPane"].forEach(p => {
      const el = $("#" + p);
      if (el) el.hidden = true;
    });
    const target = $("#" + id);
    if (target) target.hidden = false;
    $$(".login-error").forEach(el => { el.textContent = ""; el.style.color = ""; });
    setTimeout(() => target?.querySelector("input")?.focus(), 100);
  };

  $("#toRegister")?.addEventListener("click", () => showPane("registerPane"));
  $("#toLogin")?.addEventListener("click", () => showPane("loginPane"));
  $("#toForgotPassword")?.addEventListener("click", () => showPane("forgotPane"));
  $("#backToLogin")?.addEventListener("click", () => showPane("loginPane"));
  $("#backToLogin2")?.addEventListener("click", () => showPane("loginPane"));
  $("#backToLogin3")?.addEventListener("click", () => showPane("loginPane"));

  // LOGIN
  $("#loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const btn = $("#loginSubmit");
    const err = $("#loginError");
    err.textContent = "";
    if (!email || !password) { err.textContent = "Please enter your email and password."; return; }
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.needsVerification) {
        context._verifyEmail = data.email || email;
        $("#verifyEmailDisplay").textContent = context._verifyEmail;
        showPane("verifyPane");
        return;
      }
      if (res.status === 403 && data.needsPasswordSetup) {
        context._verifyEmail = data.email || email;
        showPane(data.needsVerification ? "verifyPane" : "setPasswordPane");
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.message || "Sign in failed.");
      context.user = data.user;
      onSuccess();
    } catch (err2) {
      err.textContent = err2.message || "Could not sign in.";
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });

  // REGISTER (email only)
  $("#registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#registerEmail").value.trim();
    const btn = $("#registerSubmit");
    const err = $("#registerError");
    err.textContent = "";
    if (!email) { err.textContent = "Please enter your email."; return; }
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        if (data.alreadyRegistered) {
          err.textContent = data.message || "Account exists. Please sign in.";
          return;
        }
        throw new Error(data.message || "Sign up failed.");
      }
      context._verifyEmail = email;
      $("#verifyEmailDisplay").textContent = email;
      showPane("verifyPane");
      showToast("Check your email for the verification code.");
    } catch (err2) {
      err.textContent = err2.message || "Could not create account.";
    } finally {
      btn.disabled = false; btn.textContent = "Send verification code";
    }
  });

  // VERIFY
  $("#verifyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#verifyCode").value.trim();
    const btn = $("#verifySubmit");
    const err = $("#verifyError");
    err.textContent = "";
    if (!/^\d{6}$/.test(code)) { err.textContent = "Enter the 6-digit code."; return; }
    btn.disabled = true; btn.textContent = "Verifying…";
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: context._verifyEmail, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || "Verification failed.");
      if (data.hasPassword && data.authenticated) {
        context.user = data.user;
        onSuccess();
      } else {
        showPane("setPasswordPane");
      }
    } catch (err2) {
      err.textContent = err2.message || "Could not verify.";
    } finally {
      btn.disabled = false; btn.textContent = "Verify email";
    }
  });

  $("#resendCode")?.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/resend-code", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: context._verifyEmail, purpose: "verify" }),
      });
      showToast("New code sent. Check your inbox.");
    } catch { showToast("Could not resend code."); }
  });

  // SET PASSWORD
  $("#setPasswordForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#setPassword").value;
    const pwConfirm = $("#setPasswordConfirm").value;
    const btn = $("#setPasswordSubmit");
    const err = $("#setPasswordError");
    err.textContent = "";
    if (pw.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
    if (pw.length > 128) { err.textContent = "Password must be at most 128 characters."; return; }
    if (pw !== pwConfirm) { err.textContent = "Passwords do not match."; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: context._verifyEmail, password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || "Could not set password.");
      context.user = data.user;
      onSuccess();
    } catch (err2) {
      err.textContent = err2.message || "Could not set password.";
    } finally {
      btn.disabled = false; btn.textContent = "Save password";
    }
  });

  // FORGOT — Step 1
  $("#forgotForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#forgotEmail").value.trim();
    const btn = $("#forgotSubmit");
    const err = $("#forgotError");
    err.textContent = "";
    if (!email) { err.textContent = "Please enter your email."; return; }
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || "Could not send reset code.");
      context._resetEmail = email;
      $("#resetEmailDisplay").textContent = email;
      showPane("verifyResetPane");
      showToast("Reset code sent to your email.");
    } catch (err2) {
      err.textContent = err2.message || "Could not send reset code.";
    } finally {
      btn.disabled = false; btn.textContent = "Send reset code";
    }
  });

  // FORGOT — Step 2: verify reset code
  $("#verifyResetForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#resetCode").value.trim();
    const btn = $("#verifyResetSubmit");
    const err = $("#verifyResetError");
    err.textContent = "";
    if (!/^\d{6}$/.test(code)) { err.textContent = "Enter the 6-digit code."; return; }
    btn.disabled = true; btn.textContent = "Verifying…";
    try {
      const res = await fetch("/api/auth/verify-reset-code", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: context._resetEmail, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || "Verification failed.");
      showPane("resetPane");
    } catch (err2) {
      err.textContent = err2.message || "Could not verify.";
    } finally {
      btn.disabled = false; btn.textContent = "Verify code";
    }
  });

  $("#resendResetCode")?.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/resend-code", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: context._resetEmail, purpose: "reset" }),
      });
      showToast("New reset code sent. Check your inbox.");
    } catch { showToast("Could not resend code."); }
  });

  // FORGOT — Step 3: new password
  $("#resetForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#resetPassword").value;
    const pwConfirm = $("#resetPasswordConfirm").value;
    const btn = $("#resetSubmit");
    const err = $("#resetError");
    err.textContent = "";
    if (pw.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
    if (pw.length > 128) { err.textContent = "Password must be at most 128 characters."; return; }
    if (pw !== pwConfirm) { err.textContent = "Passwords do not match."; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: context._resetEmail, password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || "Could not reset password.");
      err.textContent = "Password reset! You can now sign in.";
      err.style.color = "var(--success)";
      setTimeout(() => {
        showPane("loginPane");
        $("#loginEmail").value = context._resetEmail || "";
      }, 1500);
    } catch (err2) {
      err.textContent = err2.message || "Could not reset password.";
    } finally {
      btn.disabled = false; btn.textContent = "Save new password";
    }
  });
}

/* ---------- 5. CONFIG ---------- */
async function loadConfig() {
  const path = `/templates/${context.category}/${context.templateId}/config.json`;
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Config not found: ${path} (HTTP ${res.status})`);
  const config = await res.json();
  if (!config.id || !config.name || !config.customization) {
    throw new Error("Invalid config.json — missing id, name or customization.");
  }
  return config;
}

/* ---------- 6. FIELD ACCESS ---------- */
function getFieldValue(key) { return context.fields[key]?.value ?? ""; }
function setFieldValue(key, value) {
  const field = context.fields[key];
  if (field) field.value = value;
}

/* ---------- 7. FORM RENDERING ---------- */
function renderForm() {
  const container = $("#dynamicSections");
  if (!container) return;

  const sections = context.config.sections || [];
  const customization = context.config.customization;

  if (!sections.length) {
    container.innerHTML = `<div class="editor-error">No sections defined in config.json.</div>`;
    return;
  }

  container.innerHTML = "";
  let step = 0;

  sections.forEach(section => {
    step++;
    const block = document.createElement("section");
    block.className = "form-section";

    const header = document.createElement("div");
    header.className = "section-title";
    header.innerHTML = `
      <span class="step-number">${String(step).padStart(2, "0")}</span>
      <div>
        <h2>${escapeHtml(section.title)}</h2>
        ${section.subtitle ? `<p>${escapeHtml(section.subtitle)}</p>` : ""}
      </div>`;
    block.appendChild(header);

    (section.fields || []).forEach(key => {
      const spec = customization[key];
      if (spec) block.appendChild(renderField(key, spec));
    });

    container.appendChild(block);
  });

  const pubStep = $("[data-step-no]");
  if (pubStep) pubStep.textContent = String(step + 1).padStart(2, "0");

  bindFieldEvents();
}

function renderField(key, spec) {
  const wrap = document.createElement("div");
  wrap.dataset.fieldWrap = key;

  const id = `field-${key}`;
  const label = escapeHtml(spec.label || key);
  const required = spec.required ? "required" : "";
  const placeholder = spec.placeholder ? `placeholder="${escapeHtml(spec.placeholder)}"` : "";

  context.fields[key] = { spec, value: spec.default ?? "", files: [] };

  switch (spec.type) {
    case "text":
    case "date":
      wrap.innerHTML = `
        <label for="${id}">${label}</label>
        <input id="${id}" data-field-key="${key}" type="${spec.type}"
               value="${escapeHtml(spec.default ?? "")}"
               ${spec.maxLength ? `maxlength="${spec.maxLength}"` : ""}
               ${placeholder} ${required}>
        ${spec.maxLength ? `<div class="field-footer"><span>${label}</span><span data-counter="${key}">0 / ${spec.maxLength}</span></div>` : ""}
        ${spec.help ? `<p class="field-help">${escapeHtml(spec.help)}</p>` : ""}`;
      break;

    case "textarea":
      wrap.innerHTML = `
        <label for="${id}">${label}</label>
        <textarea id="${id}" data-field-key="${key}"
                  ${spec.maxLength ? `maxlength="${spec.maxLength}"` : ""}
                  ${placeholder} ${required}>${escapeHtml(spec.default ?? "")}</textarea>
        <div class="field-footer"><span>Make it yours.</span>
          ${spec.maxLength ? `<span data-counter="${key}">0 / ${spec.maxLength}</span>` : ""}
        </div>
        ${spec.help ? `<p class="field-help">${escapeHtml(spec.help)}</p>` : ""}`;
      break;

    case "imageGallery": {
      const mb = spec.maxSizeMB || 800;
      wrap.innerHTML = `
        <label for="${id}" class="upload-box">
          <span class="upload-icon" aria-hidden="true">＋</span>
          <strong>${escapeHtml(spec.label || "Choose photos")}</strong>
          <span>Up to ${spec.maxFiles || 40} images · ${mb} MB each</span>
          <input id="${id}" data-field-key="${key}" type="file"
                 accept="${escapeHtml(spec.accept || "image/*")}" multiple ${required}>
        </label>
        <div class="photo-grid" data-photo-grid="${key}" aria-live="polite"></div>
        ${spec.help ? `<p class="field-help">${escapeHtml(spec.help)}</p>` : ""}`;
      break;
    }

    case "textArray": {
      const text = Array.isArray(spec.default) ? spec.default.join("\n") : (spec.default || "");
      wrap.innerHTML = `
        <label for="${id}">${label}</label>
        <textarea id="${id}" data-field-key="${key}" ${placeholder} ${required}>${escapeHtml(text)}</textarea>
        <p class="field-help">${escapeHtml(spec.help || "One item per line.")}</p>`;
      break;
    }

    case "audio": {
      const mb = spec.maxSizeMB || 200;
      wrap.innerHTML = `
        <label for="${id}" class="upload-box">
          <span class="upload-icon" aria-hidden="true">♪</span>
          <strong>${escapeHtml(spec.label || "Choose audio")}</strong>
          <span>MP3, WAV or OGG · up to ${mb} MB</span>
          <input id="${id}" data-field-key="${key}" type="file"
                 accept="${escapeHtml(spec.accept || "audio/*")}" ${required}>
        </label>
        <div class="photo-grid" data-photo-grid="${key}" aria-live="polite"></div>
        ${spec.help ? `<p class="field-help">${escapeHtml(spec.help)}</p>` : ""}`;
      break;
    }

    case "video": {
      const mb = spec.maxSizeMB || 800;
      wrap.innerHTML = `
        <label for="${id}" class="upload-box">
          <span class="upload-icon" aria-hidden="true">🎬</span>
          <strong>${escapeHtml(spec.label || "Choose video")}</strong>
          <span>MP4 or WebM · up to ${mb} MB</span>
          <input id="${id}" data-field-key="${key}" type="file"
                 accept="${escapeHtml(spec.accept || "video/*")}" ${required}>
        </label>
        <div class="photo-grid" data-photo-grid="${key}" aria-live="polite"></div>
        ${spec.help ? `<p class="field-help">${escapeHtml(spec.help)}</p>` : ""}`;
      break;
    }

    case "theme": {
      const opts = spec.options || [];
      wrap.innerHTML = `
        <div class="theme-options">
          ${opts.map(opt => `
            <label class="theme-option">
              <input type="radio" name="theme-${key}" value="${escapeHtml(opt.value)}"
                     data-field-key="${key}" ${opt.value === spec.default ? "checked" : ""}>
              <span class="theme-swatch ${escapeHtml(opt.swatch || opt.value)}"></span>
              <span>${escapeHtml(opt.label)}</span>
            </label>`).join("")}
        </div>`;
      break;
    }

    default:
      wrap.innerHTML = `<p class="editor-error">Unknown field type: ${escapeHtml(spec.type)}</p>`;
  }

  return wrap;
}

/* ---------- 8. EVENT BINDING ---------- */
function bindFieldEvents() {
  $$("[data-field-key]").forEach(input => {
    const key = input.dataset.fieldKey;

    if (input.type === "file") {
      input.addEventListener("change", e => handleFileInput(key, e));
    } else if (input.type === "radio") {
      input.addEventListener("change", e => {
        if (e.target.checked) {
          setFieldValue(key, e.target.value);
          scheduleAutosave();
          updatePreview();
        }
      });
    } else {
      input.addEventListener("input", e => {
        setFieldValue(key, e.target.value);
        updateCounter(key);
        scheduleAutosave();
        updatePreview();
      });
      input.addEventListener("change", () => {
        updateCounter(key);
        updatePreview();
      });
    }
  });

  Object.keys(context.fields).forEach(updateCounter);
}

function updateCounter(key) {
  const el = $(`[data-counter="${key}"]`);
  if (!el) return;
  const field = context.fields[key];
  const max = field?.spec?.maxLength;
  if (!max) return;
  el.textContent = `${String(field.value).length} / ${max}`;
}

/* ---------- 9. FILE INPUT (with ~1 GB total cap) ---------- */
function currentTotalBytes() {
  let total = 0;
  Object.values(context.fields).forEach(f => {
    f.files?.forEach(item => { total += item.file?.size || 0; });
  });
  return total;
}

function handleFileInput(key, event) {
  const field = context.fields[key];
  if (!field) return;

  const spec = field.spec;
  const accept = (spec.accept || "").split(",").map(s => s.trim()).filter(Boolean);
  const remainingTotal = MAX_TOTAL_MEDIA_BYTES - currentTotalBytes();

  if (spec.type === "imageGallery") {
    const maxFiles = spec.maxFiles || 40;
    const maxSize = (spec.maxSizeMB || 800) * 1024 * 1024;
    const selected = Array.from(event.target.files || []);
    let added = 0;
    let runningTotal = currentTotalBytes();

    for (const file of selected) {
      if (field.files.length >= maxFiles) { showToast(`Max ${maxFiles} photos.`); break; }
      if (accept.length && !accept.includes(file.type)) { showToast(`${file.name}: unsupported type.`); continue; }
      if (file.size > maxSize) { showToast(`${file.name}: ${formatBytes(file.size)} exceeds ${formatBytes(maxSize)}.`); continue; }
      if (runningTotal + file.size > MAX_TOTAL_MEDIA_BYTES) {
        showToast(`Total upload limit reached (${formatBytes(MAX_TOTAL_MEDIA_BYTES)}).`);
        break;
      }
      field.files.push({ file, url: URL.createObjectURL(file) });
      runningTotal += file.size;
      added++;
    }

    event.target.value = "";
    renderFileGrid(key);
    updatePreview();
    scheduleAutosave();
    if (added) showToast(`${added} photo${added === 1 ? "" : "s"} added.`);
    return;
  }

  if (spec.type === "video" || spec.type === "audio") {
    const file = event.target.files?.[0];
    if (!file) return;
    const maxSize = (spec.maxSizeMB || (spec.type === "video" ? 800 : 200)) * 1024 * 1024;
    if (accept.length && !accept.includes(file.type)) {
      showToast(spec.type === "video" ? "Choose an MP4 or WebM video." : "Choose MP3, WAV or OGG.");
      event.target.value = ""; return;
    }
    if (file.size > maxSize) {
      showToast(`File is ${formatBytes(file.size)}, max ${formatBytes(maxSize)}.`);
      event.target.value = ""; return;
    }
    const oldSize = field.files.reduce((s, f) => s + (f.file?.size || 0), 0);
    if (remainingTotal + oldSize < file.size) {
      showToast(`Total upload limit reached (${formatBytes(MAX_TOTAL_MEDIA_BYTES)}).`);
      event.target.value = ""; return;
    }
    field.files.forEach(f => URL.revokeObjectURL(f.url));
    field.files = [{ file, url: URL.createObjectURL(file) }];
    showToast(`${spec.type === "video" ? "Video" : "Audio"} added: ${file.name}`);
    renderFileGrid(key);
    scheduleAutosave();
    updatePreview();
    return;
  }
}

function renderFileGrid(key) {
  const grid = $(`[data-photo-grid="${key}"]`);
  if (!grid) return;
  const field = context.fields[key];
  grid.innerHTML = "";

  field.files.forEach((item, i) => {
    const isVideo = field.spec.type === "video";
    const isAudio = field.spec.type === "audio";

    const card = document.createElement("div");
    card.style.cssText = "position:relative;aspect-ratio:1;overflow:hidden;border:1px solid var(--line-rose);border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--bg-rose);";

    if (isVideo) {
      const vid = document.createElement("video");
      vid.src = item.url;
      vid.muted = true;
      vid.style.cssText = "width:100%;height:100%;object-fit:cover;";
      card.appendChild(vid);
    } else if (isAudio) {
      const icon = document.createElement("div");
      icon.textContent = "♪";
      icon.style.cssText = "font-size:32px;color:var(--rose-deep);";
      card.appendChild(icon);
    } else {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = `Photo ${i + 1}`;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      card.appendChild(img);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${i + 1}`);
    remove.style.cssText = "position:absolute;top:4px;right:4px;width:24px;height:24px;border:0;border-radius:50%;background:rgba(61,44,46,0.8);color:#fff;cursor:pointer;font-size:14px;";
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(item.url);
      field.files.splice(i, 1);
      renderFileGrid(key);
      updatePreview();
      scheduleAutosave();
    });
    card.appendChild(remove);
    grid.appendChild(card);
  });
}

/* ---------- 10. LIVE PREVIEW ---------- */
let previewIframe = null;
let previewReady = false;
let lastPreviewData = null;
let retryTimer = null;

function initPreviewIframe() {
  previewIframe = $("#previewIframe");
  if (!previewIframe) return;

  const templatePath = context.config?.templatePath;
  if (templatePath) {
    previewIframe.src = templatePath;
  }

  previewIframe.addEventListener("load", () => {
    $("#previewFrameWrap")?.classList.add("loaded");
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "NIVA_PREVIEW_READY") {
      previewReady = true;
      clearTimeout(retryTimer);
      pushDataToPreview(lastPreviewData || collectPreviewData());
    }
  });
}

function collectPreviewData() {
  const data = {
    templateId: context.templateId,
    category: context.category,
  };

  Object.entries(context.fields).forEach(([key, field]) => {
    const spec = field.spec;
    if (spec.type === "imageGallery") { data[key] = field.files.map(f => f.url); return; }
    if (spec.type === "video" || spec.type === "audio") { data[key] = field.files[0]?.url || ""; return; }
    if (spec.type === "textArray") {
      data[key] = String(field.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      return;
    }
    data[key] = field.value;
  });

  return data;
}

function pushDataToPreview(data) {
  lastPreviewData = data;
  if (!previewIframe?.contentWindow) return;
  if (!previewReady) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!previewReady && lastPreviewData) pushDataToPreview(lastPreviewData);
    }, 150);
    return;
  }
  try {
    previewIframe.contentWindow.postMessage(
      { type: "NIVA_PREVIEW_UPDATE", data },
      window.location.origin
    );
  } catch (err) {
    console.warn("[NIVA] postMessage failed:", err);
  }
}

function updatePreview() {
  const data = collectPreviewData();
  try { sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(data)); } catch {}
  pushDataToPreview(data);
}

/* ---------- 11. GIFT DATA ---------- */
function getGiftData() {
  const data = {};
  Object.keys(context.fields).forEach(key => {
    const field = context.fields[key];
    const spec = field.spec;
    if (spec.type === "imageGallery") return;
    if (spec.type === "video" || spec.type === "audio") {
      data[key] = field.files[0]?.file ? field.files[0].file.name : "";
      return;
    }
    if (spec.type === "textArray") {
      data[key] = String(field.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      return;
    }
    data[key] = field.value;
  });
  return data;
}

function getPhotos() {
  const photos = [];
  Object.keys(context.fields).forEach(key => {
    const field = context.fields[key];
    if (!field || field.spec.type !== "imageGallery") return;
    if (!Array.isArray(field.files)) return;
    field.files.forEach(item => photos.push({ name: item.file.name, file: item.file, url: item.url }));
  });
  return photos;
}

function getMediaFiles() {
  const media = [];
  Object.keys(context.fields).forEach(key => {
    const field = context.fields[key];
    if (!field) return;
    if (field.spec.type !== "video" && field.spec.type !== "audio") return;
    const f = field.files[0];
    if (f?.file) media.push({ key, type: field.spec.type, file: f.file, name: f.file.name });
  });
  return media;
}

function getFieldRaw(key) { return context.fields[key] || null; }

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, MAX_PREVIEW_IMAGE_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
        URL.revokeObjectURL(objectUrl);
      } catch (err) { URL.revokeObjectURL(objectUrl); reject(err); }
    };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(`Could not read ${file.name}`)); };
    image.src = objectUrl;
  });
}

window.NIVAEditor = {
  get templateId() { return context.templateId; },
  get price() { return TEMPLATE_PRICE; },
  getGiftData, getPhotos, getMediaFiles, getFieldRaw, compressPhoto,
};

/* ---------- 12. DRAFT (local + cloud) ---------- */
let autosaveTimer;
let cloudSaveTimer;

function saveLocalDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      templateId: context.templateId, values: getGiftData(),
    }));
  } catch {}
}

async function saveCloudDraft({ silent = true } = {}) {
  if (!context.user) return;
  try {
    const data = getGiftData();
    // Byte-length check, not char count.
    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (bytes > MAX_DRAFT_BYTES) {
      if (!silent) showToast("Draft is too large for cloud save (max 5 MB). Saved locally only.");
      return;
    }
    const res = await fetch("/api/drafts", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: context.templateId, data }),
    });
    const result = await res.json().catch(() => ({}));
    if (res.ok && result.success) {
      context.cloudDraftId = result.draft?.id || null;
      if (!silent) showToast("Draft saved to your account ✓");
      setSaveStatus("Draft saved to your account");
    } else if (!silent) {
      showToast(result.message || "Could not save draft to account.");
    }
  } catch {
    if (!silent) showToast("Could not save draft to account.");
  }
}

function saveDraft(showMessage = true) {
  saveLocalDraft();
  setSaveStatus("Draft saved in this browser");
  if (showMessage) {
    showToast("Draft saved locally. Media files are not saved in drafts.");
    saveCloudDraft({ silent: false });
  } else {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => saveCloudDraft({ silent: true }), 2500);
  }
}

function scheduleAutosave() {
  setSaveStatus("Unsaved changes");
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveDraft(false), 650);
}

async function loadDraft() {
  // 1) try cloud draft
  if (context.user) {
    try {
      const res = await fetch(`/api/drafts/${encodeURIComponent(context.templateId)}`, {
        credentials: "same-origin", cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.draft?.data) {
        applyDraftValues(data.draft.data);
        context.cloudDraftId = data.draft.id || null;
        setSaveStatus("Draft restored from your account");
        return;
      }
    } catch {}
  }
  // 2) local fallback
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data?.values) return;
    applyDraftValues(data.values);
    setSaveStatus("Draft restored from this browser");
  } catch (err) {
    console.error("Load failed:", err);
    setSaveStatus("Could not restore draft");
  }
}

function applyDraftValues(values) {
  Object.entries(values).forEach(([key, val]) => {
    const field = context.fields[key];
    if (!field) return;
    if (field.spec.type === "imageGallery" || field.spec.type === "audio" || field.spec.type === "video") return;

    field.value = val;
    const input = $(`[data-field-key="${key}"]`);
    if (!input) return;

    if (input.type === "radio") {
      input.checked = input.value === val;
    } else if (field.spec.type === "textArray") {
      // Server may return array or string; normalise to newline-joined string.
      if (Array.isArray(val)) input.value = val.join("\n");
      else input.value = String(val ?? "");
    } else {
      input.value = val ?? "";
    }
    updateCounter(key);
  });
  updatePreview();
}

/* ---------- 13. RESET ---------- */
function resetEditor() {
  if (!confirm("Reset all fields to template defaults? Selected media will be removed.")) return;

  Object.keys(context.fields).forEach(key => {
    const field = context.fields[key];
    field.files.forEach(f => URL.revokeObjectURL(f.url));
    field.files = [];
    const spec = field.spec;
    field.value = spec.type === "textArray"
      ? (Array.isArray(spec.default) ? spec.default.join("\n") : (spec.default || ""))
      : (spec.default ?? "");

    const input = $(`[data-field-key="${key}"]`);
    if (input) {
      if (input.type === "radio") input.checked = input.value === (spec.default ?? "");
      else if (input.type === "file") input.value = "";
      else input.value = field.value;
    }
    if (spec.type === "imageGallery" || spec.type === "video" || spec.type === "audio") renderFileGrid(key);
    updateCounter(key);
  });

  try {
    localStorage.removeItem(DRAFT_KEY);
    sessionStorage.removeItem(PREVIEW_KEY);
  } catch {}

  // Delete cloud draft too
  if (context.user) {
    fetch(`/api/drafts/${encodeURIComponent(context.templateId)}`, {
      method: "DELETE", credentials: "same-origin",
    }).catch(() => {});
  }

  updatePreview();
  setSaveStatus("Template defaults restored");
  showToast("Editor reset to defaults.");
}

/* ---------- 14. STATIC EVENTS ---------- */
function bindStaticEvents() {
  $("#saveButton")?.addEventListener("click", () => saveDraft(true));
  $("#resetButton")?.addEventListener("click", resetEditor);
  $("#previewButton")?.addEventListener("click", () => {
    updatePreview();
    showToast("Preview refreshed.");
  });
}

function updatePlanSummary() {
  const nameEl = $("#planSummaryName");
  const priceEl = $("#planSummaryPrice");
  const badge = $("#priceBadge");
  if (nameEl) nameEl.textContent = TEMPLATE_PLAN_NAMES[TEMPLATE_PRICE] || "Signature";
  if (priceEl) priceEl.textContent = `₹${TEMPLATE_PRICE}`;
  if (badge) badge.textContent = `₹${TEMPLATE_PRICE}`;
}

/* ---------- 15. PUBLISH WITH FIXED PRICE + PAYMENT ---------- */
(() => {
  const button = document.getElementById("publishGiftButton");
  if (!button) return;

  const passwordInput = document.getElementById("giftPassword");
  const confirmInput = document.getElementById("giftPasswordConfirm");
  const status = document.getElementById("publishStatus");
  const result = document.getElementById("publishedGiftResult");
  const urlInput = document.getElementById("publishedGiftUrl");
  const copyButton = document.getElementById("copyGiftLinkButton");
  const progress = document.getElementById("editorProgress");
  const progressMsg = document.getElementById("progressMessage");
  const progressFill = document.getElementById("progressFill");
  const progressPct = document.getElementById("progressPercent");

  const encoder = new TextEncoder();

  function setStatus(msg, isError = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = isError ? "var(--danger)" : "inherit";
  }

  function setProgress(msg, pct) {
    if (!progress) return;
    progress.classList.add("show");
    if (progressMsg) progressMsg.textContent = msg;
    if (progressFill) progressFill.style.width = Math.min(100, pct) + "%";
    if (progressPct) progressPct.textContent = Math.round(pct) + "%";
  }

  function hideProgress() { progress?.classList.remove("show"); }

  function toBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function fileAsCompressedDataUrl(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const scale = Math.min(1, MAX_PREVIEW_IMAGE_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Unable to process image.");
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        } catch (err) { reject(err); }
        finally { URL.revokeObjectURL(objectUrl); }
      };
      image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Image could not be processed.")); };
      image.src = objectUrl;
    });
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function encryptGift(payload, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const material = await crypto.subtle.importKey(
      "raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]
    );

    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(payload))
    );

    const envelope = {
      version: 1,
      kdf: "PBKDF2-SHA-256",
      iterations: 310000,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(encrypted)),
    };

    const size = encoder.encode(JSON.stringify(envelope)).length;
    if (size > MAX_ENVELOPE_BYTES) {
      throw new Error(`Gift is ${formatBytes(size)} — exceeds ${formatBytes(MAX_ENVELOPE_BYTES)} limit.`);
    }
    return envelope;
  }

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    if (result) result.hidden = true;

    if (!window.NIVAEditor) {
      setStatus("Editor not ready. Refresh and try again.", true);
      return;
    }

    const password = passwordInput?.value || "";
    const confirmation = confirmInput?.value || "";

    if (password.length < 8 || password.length > 128) {
      setStatus("Password must be 8–128 characters.", true);
      passwordInput?.focus();
      return;
    }
    if (password !== confirmation) {
      setStatus("Passwords do not match.", true);
      confirmInput?.focus();
      return;
    }

    button.disabled = true;
    setStatus("Preparing your gift…");

    try {
      const gift = window.NIVAEditor.getGiftData();
      const photos = window.NIVAEditor.getPhotos();
      const media = window.NIVAEditor.getMediaFiles();

      const totalMediaBytes =
        photos.reduce((sum, photo) => sum + (photo.file?.size || 0), 0) +
        media.reduce((sum, item) => sum + (item.file?.size || 0), 0);

      if (totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) {
        throw new Error(
          `Your media totals ${formatBytes(totalMediaBytes)}. Max is ${formatBytes(MAX_TOTAL_MEDIA_BYTES)}.`
        );
      }

      const totalSteps = photos.length + media.length + 4;
      let step = 0;

      const photoPayload = [];
      for (const photo of photos) {
        setProgress(`Compressing photo ${step + 1}/${photos.length}…`, (step / totalSteps) * 100);
        photoPayload.push({
          name: String(photo.name || "Memory").slice(0, 120),
          dataUrl: await fileAsCompressedDataUrl(photo.file),
        });
        step++;
      }

      const mediaPayload = {};
      for (const item of media) {
        setProgress(`Reading ${item.type}…`, (step / totalSteps) * 100);
        try { mediaPayload[item.key] = await fileAsDataUrl(item.file); }
        catch { mediaPayload[item.key] = ""; }
        step++;
      }

      // Payment — fixed template price
      setProgress("Creating payment order…", 86);
      const orderRes = await fetch("/api/payments/create-order", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: window.NIVAEditor.templateId }),
      });
      const orderData = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok || !orderData.success) {
        throw new Error(orderData.message || "Could not create payment order.");
      }

      setProgress("Confirming payment…", 90);
      const confirmRes = await fetch("/api/payments/confirm", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderData.orderId, paymentId: "mock_" + Date.now() }),
      });
      const confirmData = await confirmRes.json().catch(() => ({}));
      if (!confirmRes.ok || !confirmData.success) {
        throw new Error(confirmData.message || "Payment failed.");
      }

      setProgress("Encrypting gift…", 94);
      const payload = { ...gift, ...mediaPayload, photos: photoPayload };
      const envelope = await encryptGift(payload, password);

      setProgress("Publishing…", 98);
      const response = await fetch("/api/gifts", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: window.NIVAEditor.templateId,
          envelope,
          orderId: orderData.orderId,
        }),
        cache: "no-store",
      });

      const data = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("Please log in before publishing.");
      if (response.status === 402) throw new Error(data.message || "Payment required.");
      if (response.status === 413) throw new Error("Gift too large. Use smaller files.");
      if (!response.ok || !data.success || !data.gift?.url) {
        throw new Error(data.message || "Publishing failed.");
      }

      setProgress("Done!", 100);
      if (urlInput) urlInput.value = new URL(data.gift.url, window.location.origin).href;
      if (result) result.hidden = false;
      setStatus("Your gift was published successfully!");
      if (passwordInput) passwordInput.value = "";
      if (confirmInput) confirmInput.value = "";
      setTimeout(hideProgress, 800);
    } catch (err) {
      hideProgress();
      setStatus(err.message || "Something went wrong.", true);
    } finally {
      button.disabled = false;
    }
  });

  copyButton?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      setStatus("Gift link copied!");
    } catch {
      urlInput.focus(); urlInput.select();
      setStatus("Select and copy manually.");
    }
  });
})();

/* ---------- 16. INIT ---------- */
async function initEditor() {
  try {
    context.config = await loadConfig();

    const nameEl = $("#templateName");
    const metaEl = $("#templateMeta");
    if (nameEl) nameEl.textContent = context.config.name;
    if (metaEl) {
      metaEl.textContent =
        `${(context.config.category || "").toUpperCase()} Collection · Customizable gift`;
    }
    updatePlanSummary();

    renderForm();
    await loadDraft();
    bindStaticEvents();
    initPreviewIframe();

    setSaveStatus("Your changes are local");
    console.info(`[NIVA] Editor ready: ${context.templateId}`);
  } catch (err) {
    console.error("[NIVA] Editor init failed:", err);
    setSaveStatus("Failed to load template");
    const container = $("#dynamicSections");
    if (container) {
      container.innerHTML = `
        <div class="editor-error">
          <strong>Could not load template.</strong><br>
          ${escapeHtml(err.message)}<br><br>
          Expected config at:<br>
          <code>/templates/${escapeHtml(context.category)}/${escapeHtml(context.templateId)}/config.json</code>
        </div>`;
    }
  }
}

/* ---------- 17. BOOT ---------- */
async function bootApp() {
  showEditor();
  showLoginGate();

  const user = await checkAuth();

  if (user) {
    context.user = user;
    showEditor();
    initEditor();
  } else {
    showLoginGate();
    initLoginUI(() => {
      showEditor();
      initEditor();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootApp, { once: true });
} else {
  bootApp();
}

window.addEventListener("beforeunload", () => {
  clearTimeout(autosaveTimer);
  clearTimeout(cloudSaveTimer);
  Object.values(context.fields).forEach(field => {
    field.files?.forEach(f => URL.revokeObjectURL(f.url));
  });
});