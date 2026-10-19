/* NIVA — Category Manager */
(() => {
  "use strict";

  const CATEGORY_FILE = "./src/data/categories.json";

  const CategoryManager = {
    categories: [],

    async init() {
      try {
        const response = await fetch(CATEGORY_FILE);

        if (!response.ok) {
          throw new Error(`Could not load categories: ${response.status}`);
        }

        const data = await response.json();

        this.categories = (data.categories || [])
          .filter(category => category.active !== false)
          .sort((a, b) => a.sortOrder - b.sortOrder);

        console.info(
          `[NIVA] Loaded ${this.categories.length} categories.`
        );

        return this.categories;
      } catch (error) {
        console.error("[NIVA] Category loading failed:", error);
        return [];
      }
    },

    getAll() {
      return [...this.categories];
    },

    getById(id) {
      return this.categories.find(category => category.id === id) || null;
    }
  };

  window.NivaCategories = CategoryManager;
})();