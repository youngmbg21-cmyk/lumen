/* ============================================================
   LUMEN TERMINAL — verbatim port of lumen_terminal.html
   Successor to terminal.js. Built incrementally; will replace
   the existing renderer once all chunks are present.

   This is the FIRST 100-line chunk: state, data adapter, and a
   placeholder render() so the Terminal tab degrades gracefully
   while subsequent chunks are added.
   ============================================================ */
(function () {
  "use strict";

  // ============================================================
  // STATE — mirrors the reference's `profile` + view controls.
  // tone/dynamic are Sets so chip toggles affect scoreBook (not
  // a hard filter), exactly like the reference.
  // ============================================================
  const termState = {
    profile: {
      heat: 3, explicit: 3, emotion: 4, consent: 4, taboo: 3, plot: 4,
      tone:    new Set(),
      dynamic: new Set()
    },
    subgenreFilter: null,
    search: "",
    sortKey: "fit",
    sortDir: "desc",
    selectedId: null,
    _seededFromLumen: false
  };

  // ============================================================
  // DATA ADAPTER — flatten Lumen's catalog books into the shape
  // the reference's renderers + scoreBook expect. Field aliases
  // accommodate both the older Lumen catalog schema and the
  // reference's lean shape.
  // ============================================================
  function clamp1to5(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 3;
    return Math.max(1, Math.min(5, n));
  }
  function arr(x) { return Array.isArray(x) ? x.slice() : []; }

  function toTerminalShape(b) {
    if (!b) return null;
    return {
      id:           b.id,
      title:        b.title  || "(untitled)",
      author:       b.author || "Unknown",
      year:         parseInt(b.year, 10) || 0,
      series:       b.series || null,
      subgenre:     b.subgenre || b.category || "Uncategorised",
      short_summary: b.short_summary || b.description || b.fit_notes || "",
      fit_notes:    b.fit_notes || "",
      cover_url:    b.thumbnail || b.cover_url || null,
      source_url:   b.source_url || b.sourceUrl || null,
      heat:         clamp1to5(b.heat_level         != null ? b.heat_level         : b.heat),
      explicit:     clamp1to5(b.explicitness       != null ? b.explicitness       : b.explicit),
      emotion:      clamp1to5(b.emotional_intensity!= null ? b.emotional_intensity: b.emotion),
      consent:      clamp1to5(b.consent_clarity    != null ? b.consent_clarity    : b.consent),
      taboo:        clamp1to5(b.taboo_level        != null ? b.taboo_level        : b.taboo),
      plot:         clamp1to5(b.plot_weight        != null ? b.plot_weight        : b.plot),
      tone:         arr(b.tone),
      pacing:       arr(b.pacing),
      style:        arr(b.literary_style    || b.style),
      dynamic:      arr(b.relationship_dynamic || b.dynamic),
      trope:        arr(b.trope_tags        || b.trope),
      kink:         arr(b.kink_tags         || b.kink),
      gender:       arr(b.gender_pairing    || b.gender),
      orientation:  arr(b.orientation_tags  || b.orientation),
      warnings:     arr(b.content_warnings  || b.warnings),
      _raw:         b
    };
  }

  // Pulls the live catalog from Lumen, drops hidden titles, and
  // shapes each one. Score is added later by scoreBook() so the
  // reference's profile-driven fit calculation is the source of
  // truth (consistent with the standalone reference).
  function rawBooks() {
    const L = window.Lumen;
    if (!L || !L.listAllBooks) return [];
    const hidden = (L.store && L.store.get && L.store.get().hidden) || {};
    return L.listAllBooks().filter(b => !hidden[b.id]).map(toTerminalShape);
  }

  // ============================================================
  // PLACEHOLDER render() — keeps the tab alive while subsequent
  // chunks (scoring, helpers, populators, command bar, dashboard,
  // event wiring) are written. Replaced in the final chunk.
  // ============================================================
  function render() {
    const wrap = document.createElement("div");
    wrap.className = "page lumen-terminal";
    wrap.innerHTML = `<div class="wrap" style="padding:40px;text-align:center;">
      <div class="brand-mark">Lumen</div>
      <div class="brand-sub" style="margin-top:8px;">Terminal · porting in progress</div>
      <p style="margin-top:14px;font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--text-mute);">
        ${rawBooks().length} titles loaded from the catalogue.
      </p>
    </div>`;
    return wrap;
  }

  window.LumenTerminalNext = { render, _state: termState, _shape: toTerminalShape, _raw: rawBooks };
})();
