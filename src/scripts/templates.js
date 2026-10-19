/* =========================================================
   NIVA TEMPLATE REGISTRY
   =========================================================
   HOW TO ADD A NEW TEMPLATE
   ──────────────────────────
   1. Create folder: templates/<category>/<id>/
      ├── config.json     (fields, sections, preview config)
      ├── template.html   (with NIVA preview bridge at bottom)
      └── preview.jpg     (1200×900 thumbnail)

   2. Add ONE line to TEMPLATE_REGISTRY below:
      { id: "<id>", configPath: "/templates/<category>/<id>/config.json" }

   3. Add ONE line to server.js → ALLOWED_TEMPLATE_IDS

   4. Add ONE entry to index.html → categories.<category>.templates[]

   That's it. Editor auto-loads via config.json.
   ========================================================= */

const NivaTemplates = (() => {
  "use strict";

  const TEMPLATE_REGISTRY = [
    {
      id: "eternal-love",
      configPath: "/templates/love/eternal-love/config.json",
    },
    {
      id: "love-proposal",
      configPath: "/templates/love/love-proposal/config.json",
    },
    {
      id: "birthday-magic",
      configPath: "/templates/birthday/birthday-magic/config.json",
    },
    // ▼▼▼ ADD NEW TEMPLATES BELOW ▼▼▼
    // {
    //   id: "your-new-template",
    //   configPath: "/templates/your-category/your-new-template/config.json",
    // },
  ];

  let templates = [];
  let initialized = false;

  async function loadTemplate(registryItem) {
    try {
      const response = await fetch(registryItem.configPath, { cache: "no-cache" });
      if (!response.ok) {
        throw new Error(`Unable to load ${registryItem.configPath}: ${response.status}`);
      }
      const config = await response.json();
      if (!config.id || !config.name || !config.category) {
        throw new Error(`Invalid config: ${registryItem.configPath}`);
      }
      return { ...config, configPath: registryItem.configPath };
    } catch (error) {
      console.error(`[NIVA] Failed to load "${registryItem.id}":`, error);
      return null;
    }
  }

  async function initialize() {
    if (initialized) return getAll();
    const results = await Promise.all(TEMPLATE_REGISTRY.map(loadTemplate));
    templates = results.filter(Boolean);
    initialized = true;
    console.info(`[NIVA] Loaded ${templates.length} template(s).`);
    return getAll();
  }

  function getAll() {
    return templates.filter(t => t.active === true);
  }

  function getById(templateId) {
    if (!templateId) return null;
    return getAll().find(t => t.id === templateId) || null;
  }

  function getByCategory(categoryId) {
    if (!categoryId) return [];
    const norm = String(categoryId).trim().toLowerCase();
    return getAll().filter(t => String(t.category).toLowerCase() === norm);
  }

  function getTemplatePath(templateId) {
    const t = getById(templateId);
    return t ? t.templatePath : null;
  }

  function getPreviewImage(templateId) {
    const t = getById(templateId);
    return t ? t.previewImage : null;
  }

  function getCategoriesWithTemplates() {
    return [...new Set(getAll().map(t => t.category))];
  }

  function register(templateConfig) {
    if (!templateConfig?.id || !templateConfig?.name || !templateConfig?.category) {
      throw new Error("[NIVA] Template needs id, name, category.");
    }
    const i = templates.findIndex(t => t.id === templateConfig.id);
    if (i !== -1) templates[i] = { ...templateConfig };
    else templates.push({ ...templateConfig });
    return getById(templateConfig.id);
  }

  async function reload() {
    initialized = false;
    templates = [];
    return initialize();
  }

  return Object.freeze({
    initialize,
    getAll,
    getById,
    getByCategory,
    getTemplatePath,
    getPreviewImage,
    getCategoriesWithTemplates,
    register,
    reload,
  });
})();

window.NivaTemplates = NivaTemplates;