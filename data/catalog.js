/* ============================================================
   Lumen — Curated catalog (100-book corpus)
   ------------------------------------------------------------
   This file is the trusted internal source for Discover, Daily
   Picks, Compare, Library, and profile-based matching.

   HOW TO UPDATE
   -------------
   1. Maintain the master spreadsheet externally (Excel, Google
      Sheets, Numbers…). Column names must match the schema in
      data/CATALOG.md.
   2. Convert to JSON using either:
        (a) the in-app importer  —  Settings → Import catalog
            (Batch 2). Paste CSV, preview, then "Download
            catalog.js" and replace this file.
        (b) the Node converter    —  `node scripts/xlsx-to-
            json.mjs input.xlsx > data/catalog.js`  (Batch 3).
   3. Commit the new file.

   DO NOT edit by hand for more than a dozen books — use the
   importer so the schema and normalization stay consistent.
   ============================================================ */
(function () {
  "use strict";

  // The committed catalog. Empty at commit time; populated by
  // your conversion workflow. Shape documented in data/CATALOG.md.
  //
  // Each entry is the normalized book shape the Engine scores:
  //   { id, title, author, year, category, subgenre, description,
  //     source, source_url, thumbnail,
  //     heat_level, explicitness, emotional_intensity,
  //     consent_clarity, taboo_level, plot_weight,
  //     tone: [], pacing: [], literary_style: [],
  //     relationship_dynamic: [], trope_tags: [], kink_tags: [],
  //     gender_pairing: [], orientation_tags: [],
  //     content_warnings: [] }
  const CATALOG_BUILTIN = [];

  // Format version — bumped when the schema changes. Importers
  // write this into catalog.js; loaders can warn if an older
  // file is encountered.
  const CATALOG_VERSION = 1;

  // Resolution order on boot:
  //   1. localStorage.lumen:catalog-override  (in-app imports)
  //   2. CATALOG_BUILTIN                      (this file)
  //   3. []                                   (fallback)
  // This lets users iterate on the catalog without a git commit.
  function resolveCatalog() {
    try {
      const raw = localStorage.getItem("lumen:catalog-override");
      if (!raw) return CATALOG_BUILTIN;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.books)) return CATALOG_BUILTIN;
      // Override wins — the importer is responsible for normalizing.
      return parsed.books;
    } catch (e) {
      console.warn("[Lumen] catalog override unreadable, falling back to built-in:", e);
      return CATALOG_BUILTIN;
    }
  }

  // Expose on LumenData so the rest of the app can pick it up
  // without a fetch() (which wouldn't work under file://).
  window.LumenData = window.LumenData || {};
  window.LumenData.CATALOG = resolveCatalog();
  window.LumenData.CATALOG_BUILTIN = CATALOG_BUILTIN;
  window.LumenData.CATALOG_VERSION = CATALOG_VERSION;
})();
