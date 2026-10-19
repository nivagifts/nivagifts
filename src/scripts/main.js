/* NIVA — Main Application */
(() => {
  "use strict";

  async function init() {
    console.info("[NIVA] Initializing website...");

    if (window.NivaCategories) {
      await window.NivaCategories.init();
    }

    if (window.NivaTemplates) {
      await window.NivaTemplates.initialize();
    }

    if (window.NivaNavigation) {
      window.NivaNavigation.init();
    }

    console.info("[NIVA] Initialization completed.");
  }

  window.NivaApp = Object.freeze({ init });

  document.addEventListener("DOMContentLoaded", init, { once: true });
})();