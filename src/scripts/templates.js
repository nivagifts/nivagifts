/* =========================================================
   NIVA TEMPLATE REGISTRY  (single source of truth)
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
    {
      id: "loveletter",
      configPath: "/templates/letters/loveletter/config.json",   // FIXED
    },
    {
      id: "eternal-anniversary",
      configPath: "/templates/anniversary/eternal-anniversary/config.json",   // FIXED
    },
    {
      id: "besties",
      configPath: "/templates/friedship/besties/config.json",
    },
    {
      id: "apologyletter",
      configPath: "/templates/letters/apologyletter/config.json",
    },
    {
      id: "memory-box",
      configPath: "/templates/friedship/memory-box/config.json",
    },
    {
      id: "date-invite",
      configPath: "/templates/love/date-invite/config.json",
    },
    {
      id: "date-invite",
      configPath: "/templates/love/date-invite/config.json",
    },
    {
      id: "constellation-proposal",
      configPath: "/templates/love/constellation-proposal/config.json",
    },
    {
      id: "birthday-special",
      configPath: "/templates/birthday/birthday-special/config.json",
    },
    // ▼▼▼ ADD NEW TEMPLATES BELOW ▼▼▼
  ];

  function categoryFromPath(configPath) {
    const m = /^\/templates\/([^/]+)\//.exec(configPath || "");
    return m ? m[1].toLowerCase() : null;
  }

  let templates = [];
  let initialized = false;
  let initPromise = null;

  async function loadTemplate(registryItem) {
    try {
      const response = await fetch(registryItem.configPath, { cache: "no-cache" });
      if (!response.ok) {
        throw new Error(`Unable to load ${registryItem.configPath}: ${response.status}`);
      }
      const config = await response.json();
      if (!config.id || !config.name) {
        throw new Error(`Invalid config: ${registryItem.configPath}`);
      }
      const category = (config.category || categoryFromPath(registryItem.configPath) || "love").toLowerCase();
      const templatePath =
        config.templatePath ||
        `/templates/${category}/${config.id}/template.html`;

      return {
        ...config,
        category,
        templatePath,
        previewImage:
          config.previewImage ||
          `/templates/${category}/${config.id}/preview.jpg`,
        configPath: registryItem.configPath,
        active: config.active !== false,
      };
    } catch (error) {
      console.error(`[NIVA] Failed to load "${registryItem.id}":`, error);
      return null;
    }
  }

  function initialize() {
    if (initialized) return Promise.resolve(getAll());
    if (initPromise) return initPromise;
    initPromise = Promise.all(TEMPLATE_REGISTRY.map(loadTemplate)).then(results => {
      templates = results.filter(Boolean);
      initialized = true;
      console.info(`[NIVA] Loaded ${templates.length} template(s).`);
      return getAll();
    });
    return initPromise;
  }

  function getAll() { return templates.filter(t => t.active === true); }

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

  function getCategory(templateId) {
    const t = getById(templateId);
    return t ? t.category : null;
  }

  function getPreviewImage(templateId) {
    const t = getById(templateId);
    return t ? t.previewImage : null;
  }

  function getCategoriesWithTemplates() {
    return [...new Set(getAll().map(t => t.category))];
  }

  function register(templateConfig) {
    if (!templateConfig?.id || !templateConfig?.name) {
      throw new Error("[NIVA] Template needs id and name.");
    }
    const i = templates.findIndex(t => t.id === templateConfig.id);
    if (i !== -1) templates[i] = { ...templates[i], ...templateConfig };
    else templates.push({ ...templateConfig });
    return getById(templateConfig.id);
  }

  async function reload() {
    initialized = false;
    initPromise = null;
    templates = [];
    return initialize();
  }

  return Object.freeze({
    initialize, getAll, getById, getByCategory,
    getTemplatePath, getCategory, getPreviewImage,
    getCategoriesWithTemplates, register, reload,
  });
})();

window.NivaTemplates = NivaTemplates;