/* =========================================================
   NIVA UNIVERSAL GIFT EDITOR
   ========================================================= */
"use strict";

const MAX_PREVIEW_IMAGE_SIZE = 1400;
const MAX_ENVELOPE_BYTES = 512 * 1024 * 1024;
const DRAFT_KEY_PREFIX = "niva-draft-";
const PREVIEW_KEY_PREFIX = "niva-preview-";

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
};
const DRAFT_KEY = DRAFT_KEY_PREFIX + context.templateId;
const PREVIEW_KEY = PREVIEW_KEY_PREFIX + context.templateId;

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
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/* ---------- 3. AUTH GATE ---------- */
async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (data?.authenticated === true && data.user) {
      return data.user;
    }
    return null;
  } catch {
    return null;
  }
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

function initLoginUI(onSuccess) {
  const loginForm = $("#loginForm");
  const registerForm = $("#registerForm");
  const loginPane = $("#loginPane");
  const registerPane = $("#registerPane");
  const toRegister = $("#toRegister");
  const toLogin = $("#toLogin");
  const loginError = $("#loginError");
  const registerError = $("#registerError");

  toRegister?.addEventListener("click", () => {
    loginPane.hidden = true;
    registerPane.hidden = false;
    loginError.textContent = "";
    setTimeout(() => $("#registerEmail")?.focus(), 100);
  });

  toLogin?.addEventListener("click", () => {
    loginPane.hidden = false;
    registerPane.hidden = true;
    registerError.textContent = "";
    setTimeout(() => $("#loginEmail")?.focus(), 100);
  });

  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const submitBtn = $("#loginSubmit");

    loginError.textContent = "";

    if (!email || !password) {
      loginError.textContent = "Please enter your email and password.";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing inâ€¦";

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Sign in failed.");
      }

      context.user = data.user;
      onSuccess();
    } catch (err) {
      loginError.textContent = err.message || "Could not sign in.";
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });

  registerForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#registerEmail").value.trim();
    const pw = $("#registerPassword").value;
    const pwConfirm = $("#registerPasswordConfirm").value;
    const submitBtn = $("#registerSubmit");

    registerError.textContent = "";

    if (!email) {
      registerError.textContent = "Please enter your email.";
      return;
    }

    if (pw.length < 12) {
      registerError.textContent = "Password must be at least 12 characters.";
      return;
    }

    if (pw !== pwConfirm) {
      registerError.textContent = "Passwords do not match.";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Creating accountâ€¦";

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Sign up failed.");
      }

      context.user = data.user;
      onSuccess();
    } catch (err) {
      registerError.textContent = err.message || "Could not create account.";
      submitBtn.disabled = false;
      submitBtn.textContent = "Create account";
    }
  });
}

/* ---------- 4. CONFIG ---------- */
async function loadConfig() {
  const path = `/templates/${context.category}/${context.templateId}/config.json`;
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Config not found: ${path} (HTTP ${res.status})`);
  const config = await res.json();
  if (!config.id || !config.name || !config.customization) {
    throw new Error("Invalid config.json â€” missing id, name or customization.");
  }
  return config;
}

/* ---------- 5. FIELD ACCESS ---------- */
function getFieldValue(key) { return context.fields[key]?.value ?? ""; }
function setFieldValue(key, value) {
  const field = context.fields[key];
  if (field) field.value = value;
}

/* ---------- 6. FORM RENDERING ---------- */
function renderForm() {
  const container = $("#dynamicSections");
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
      const mb = spec.maxSizeMB || 50;
      wrap.innerHTML = `
        <label for="${id}" class="upload-box">
          <span class="upload-icon" aria-hidden="true">ï¼‹</span>
          <strong>${escapeHtml(spec.label || "Choose photos")}</strong>
          <span>Up to ${spec.maxFiles || 20} images Â· ${mb} MB each</span>
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
      const mb = spec.maxSizeMB || 20;
      wrap.innerHTML = `
        <label for="${id}" class="upload-box">
          <span class="upload-icon" aria-hidden="true">â™«</span>
          <strong>${escapeHtml(spec.label || "Choose audio")}</strong>
          <span>MP3, WAV or OGG Â· up to ${mb} MB</span>
          <input id="${id}" data-field-key="${key}" type="file"
                 accept="${escapeHtml(spec.accept || "audio/*")}" ${required}>
        </label>
        <div class="photo-grid" data-photo-grid="${key}" aria-live="polite"></div>
        ${spec.help ? `<p class="field-help">${escapeHtml(spec.help)}</p>` : ""}`;
      break;
    }

    case "video": {
      const mb = spec.maxSizeMB || 100;
      wrap.innerHTML = `
        <label for="${id}" class="upload-box">
          <span class="upload-icon" aria-hidden="true">ðŸŽ¬</span>
          <strong>${escapeHtml(spec.label || "Choose video")}</strong>
          <span>MP4 or WebM Â· up to ${mb} MB</span>
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

/* ---------- 7. EVENT BINDING ---------- */
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

/* ---------- 8. FILE INPUT ---------- */
function handleFileInput(key, event) {
  const field = context.fields[key];
  if (!field) return;

  const spec = field.spec;
  const accept = (spec.accept || "").split(",").map(s => s.trim()).filter(Boolean);

  if (spec.type === "imageGallery") {
    const maxFiles = spec.maxFiles || 20;
    const maxSize = (spec.maxSizeMB || 50) * 1024 * 1024;
    const selected = Array.from(event.target.files || []);
    let added = 0;

    for (const file of selected) {
      if (field.files.length >= maxFiles) { showToast(`Max ${maxFiles} photos.`); break; }
      if (accept.length && !accept.includes(file.type)) { showToast(`${file.name}: unsupported type.`); continue; }
      if (file.size > maxSize) { showToast(`${file.name}: ${formatBytes(file.size)} exceeds ${spec.maxSizeMB || 50} MB.`); continue; }
      field.files.push({ file, url: URL.createObjectURL(file) });
      added++;
    }

    event.target.value = "";
    renderFileGrid(key);
    updatePreview();
    scheduleAutosave();
    if (added) showToast(`${added} photo${added === 1 ? "" : "s"} added.`);
    return;
  }

  if (spec.type === "video") {
    const file = event.target.files?.[0];
    if (!file) return;
    const maxSize = (spec.maxSizeMB || 100) * 1024 * 1024;
    if (accept.length && !accept.includes(file.type)) {
      showToast("Choose an MP4 or WebM video."); event.target.value = ""; return;
    }
    if (file.size > maxSize) {
      showToast(`Video is ${formatBytes(file.size)}, max ${spec.maxSizeMB || 100} MB.`); event.target.value = ""; return;
    }
    field.files.forEach(f => URL.revokeObjectURL(f.url));
    field.files = [{ file, url: URL.createObjectURL(file) }];
    showToast(`Video added: ${file.name}`);
    renderFileGrid(key);
    scheduleAutosave();
    updatePreview();
    return;
  }

  if (spec.type === "audio") {
    const file = event.target.files?.[0];
    if (!file) return;
    const maxSize = (spec.maxSizeMB || 20) * 1024 * 1024;
    if (accept.length && !accept.includes(file.type)) {
      showToast("Choose MP3, WAV or OGG."); event.target.value = ""; return;
    }
    if (file.size > maxSize) {
      showToast(`Audio is ${formatBytes(file.size)}, max ${spec.maxSizeMB || 20} MB.`); event.target.value = ""; return;
    }
    field.files.forEach(f => URL.revokeObjectURL(f.url));
    field.files = [{ file, url: URL.createObjectURL(file) }];
    showToast(`Audio added: ${file.name}`);
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
    card.style.cssText = "position:relative;aspect-ratio:1;overflow:hidden;border:1px solid #49334f;border-radius:10px;display:flex;align-items:center;justify-content:center;background:#0c0812;";

    if (isVideo) {
      const vid = document.createElement("video");
      vid.src = item.url;
      vid.muted = true;
      vid.style.cssText = "width:100%;height:100%;object-fit:cover;";
      card.appendChild(vid);
    } else if (isAudio) {
      const icon = document.createElement("div");
      icon.textContent = "â™«";
      icon.style.cssText = "font-size:32px;color:#ff9ab8;";
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
    remove.textContent = "Ã—";
    remove.setAttribute("aria-label", `Remove ${i + 1}`);
    remove.style.cssText = "position:absolute;top:4px;right:4px;width:24px;height:24px;border:0;border-radius:50%;background:rgba(9,8,14,.9);color:#fff;cursor:pointer;";
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

/* ---------- 9. LIVE PREVIEW ---------- */
let previewIframe = null;
let previewReady = false;
let lastPreviewData = null;
let retryTimer = null;

function initPreviewIframe() {
  previewIframe = $("#previewIframe");
  if (!previewIframe) return;

  previewIframe.src = context.config.templatePath;

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

/* ---------- 10. GIFT DATA ---------- */
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
    if (field.spec.type !== "imageGallery") return;
    field.files.forEach(item => photos.push({
      name: item.file.name, file: item.file, url: item.url,
    }));
  });
  return photos;
}

function getMediaFiles() {
  const media = [];
  Object.keys(context.fields).forEach(key => {
    const field = context.fields[key];
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
  getGiftData, getPhotos, getMediaFiles, getFieldRaw, compressPhoto,
};

/* ---------- 11. DRAFT ---------- */
let autosaveTimer;

function saveDraft(showMessage = true) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      templateId: context.templateId, values: getGiftData(),
    }));
    setSaveStatus("Draft saved in this browser");
    if (showMessage) showToast("Draft saved. Media files are not saved.");
  } catch (err) {
    console.error("Save failed:", err);
    setSaveStatus("Could not save draft");
    showToast("Could not save. Browser storage may be unavailable.");
  }
}

function scheduleAutosave() {
  setSaveStatus("Unsaved changes");
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveDraft(false), 650);
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data?.values) return;

    Object.entries(data.values).forEach(([key, val]) => {
      const field = context.fields[key];
      if (!field) return;
      if (field.spec.type === "imageGallery" || field.spec.type === "audio" || field.spec.type === "video") return;

      field.value = val;
      const input = $(`[data-field-key="${key}"]`);
      if (!input) return;

      if (input.type === "radio") input.checked = input.value === val;
      else if (field.spec.type === "textArray" && Array.isArray(val)) input.value = val.join("\n");
      else input.value = val;
    });

    setSaveStatus("Draft restored from this browser");
  } catch (err) {
    console.error("Load failed:", err);
    setSaveStatus("Could not restore draft");
  }
}

/* ---------- 12. RESET ---------- */
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
    if (spec.type === "imageGallery" || spec.type === "video" || spec.type === "audio") {
      renderFileGrid(key);
    }
    updateCounter(key);
  });

  try {
    localStorage.removeItem(DRAFT_KEY);
    sessionStorage.removeItem(PREVIEW_KEY);
  } catch {}

  updatePreview();
  setSaveStatus("Template defaults restored");
  showToast("Editor reset to defaults.");
}

/* ---------- 13. STATIC EVENTS ---------- */
function bindStaticEvents() {
  $("#saveButton")?.addEventListener("click", () => saveDraft(true));
  $("#resetButton")?.addEventListener("click", resetEditor);
  $("#previewButton")?.addEventListener("click", () => {
    updatePreview();
    showToast("Preview refreshed.");
  });
}

/* ---------- 14. PUBLISH ---------- */
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
    status.textContent = msg;
    status.style.color = isError ? "#e8919e" : "inherit";
  }

  function setProgress(msg, pct) {
    if (!progress) return;
    progress.classList.add("show");
    progressMsg.textContent = msg;
    progressFill.style.width = Math.min(100, pct) + "%";
    progressPct.textContent = Math.round(pct) + "%";
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
          resolve(canvas.toDataURL("image/jpeg", 0.78));
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
      throw new Error(`Gift is ${(size / 1048576).toFixed(1)} MB â€” exceeds 300 MB limit.`);
    }
    return envelope;
  }

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    result.hidden = true;

    if (!window.NIVAEditor) {
      setStatus("Editor not ready. Refresh and try again.", true);
      return;
    }

    const password = passwordInput.value;
    const confirmation = confirmInput.value;

    if (password.length < 8 || password.length > 128) {
      setStatus("Password must be 8â€“128 characters.", true);
      passwordInput.focus();
      return;
    }
    if (password !== confirmation) {
      setStatus("Passwords do not match.", true);
      confirmInput.focus();
      return;
    }

    button.disabled = true;
    setStatus("Preparing your giftâ€¦");

    try {
      const gift = window.NIVAEditor.getGiftData();
      const photos = window.NIVAEditor.getPhotos();
      const media = window.NIVAEditor.getMediaFiles();
      const totalSteps = photos.length + media.length + 2;
      let step = 0;

      const photoPayload = [];
      for (const photo of photos) {
        setProgress(`Compressing photo ${step + 1}/${photos.length}â€¦`, (step / totalSteps) * 100);
        photoPayload.push({
          name: String(photo.name || "Memory").slice(0, 120),
          dataUrl: await fileAsCompressedDataUrl(photo.file),
        });
        step++;
      }

      const mediaPayload = {};
      for (const item of media) {
        setProgress(`Reading ${item.type}â€¦`, (step / totalSteps) * 100);
        try { mediaPayload[item.key] = await fileAsDataUrl(item.file); }
        catch (err) { mediaPayload[item.key] = ""; }
        step++;
      }

      setProgress("Encrypting giftâ€¦", 90);
      const payload = { ...gift, ...mediaPayload, photos: photoPayload };
      const envelope = await encryptGift(payload, password);

      setProgress("Uploadingâ€¦", 95);
      const response = await fetch("/api/gifts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: window.NIVAEditor.templateId,
          envelope,
        }),
        cache: "no-store",
      });

      const data = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("Please log in before publishing.");
      if (response.status === 413) throw new Error("Gift too large. Use smaller files.");
      if (!response.ok || !data.success || !data.gift?.url) {
        throw new Error(data.message || "Publishing failed.");
      }

      setProgress("Done!", 100);
      urlInput.value = new URL(data.gift.url, window.location.origin).href;
      result.hidden = false;
      setStatus("Your gift was published successfully!");
      passwordInput.value = "";
      confirmInput.value = "";
      setTimeout(hideProgress, 800);
    } catch (err) {
      hideProgress();
      setStatus(err.message || "Something went wrong.", true);
    } finally {
      button.disabled = false;
    }
  });

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      setStatus("Gift link copied!");
    } catch {
      urlInput.focus(); urlInput.select();
      setStatus("Select and copy manually.");
    }
  });
})();

/* ---------- 15. EDITOR INIT ---------- */
async function initEditor() {
  try {
    context.config = await loadConfig();

    $("#templateName").textContent = context.config.name;
    $("#templateMeta").textContent =
      `${(context.config.category || "").toUpperCase()} Collection Â· Customizable gift`;

    renderForm();
    loadDraft();
    bindStaticEvents();
    initPreviewIframe();

    setSaveStatus("Your changes are local");
    console.info(`[NIVA] Editor ready: ${context.templateId}`);
  } catch (err) {
    console.error("[NIVA] Editor init failed:", err);
    setSaveStatus("Failed to load template");
    $("#dynamicSections").innerHTML = `
      <div class="editor-error">
        <strong>Could not load template.</strong><br>
        ${escapeHtml(err.message)}<br><br>
        Expected config at:<br>
        <code>/templates/${escapeHtml(context.category)}/${escapeHtml(context.templateId)}/config.json</code>
      </div>`;
  }
}

/* ---------- 16. BOOT WITH AUTH GATE ---------- */
async function bootApp() {
  showEditor(); // briefly show so DOM is ready
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
  Object.values(context.fields).forEach(field => {
    field.files?.forEach(f => URL.revokeObjectURL(f.url));
  });
});
