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
  // SCORING — verbatim from lumen_terminal.html. Drives the fit
  // value used in KPIs, ticker, grid, detail panel, similar list,
  // and editor's brief. Reads termState.profile (sliders + tone/
  // dynamic Sets) so chip toggles immediately influence ranking.
  // ============================================================
  function numMatch(u, b) {
    const d = Math.abs(u - b);
    if (d === 0) return 1;
    if (d === 1) return 0.6;
    if (d === 2) return 0.25;
    return 0;
  }

  function setOverlap(userSet, bookArr) {
    if (!userSet.size) return { credit: 0.5, matched: [] };
    if (!bookArr || !bookArr.length) return { credit: 0, matched: [] };
    const matched = bookArr.filter(t => userSet.has(t));
    return { credit: matched.length / userSet.size, matched };
  }

  function scoreBook(b) {
    const W = { heat: 1.0, explicit: 1.0, emotion: 1.0, consent: 1.5, taboo: 1.2, plot: 0.8, tone: 1.0, dynamic: 1.1 };
    const p = termState.profile;
    let raw = 0, max = 0;
    const contributions = {};
    for (const k of ["heat", "explicit", "emotion", "plot"]) {
      const s = numMatch(p[k], b[k]);
      raw += s * W[k]; max += W[k];
      contributions[k] = s;
    }
    // Consent: floor (book ≥ user → full credit)
    const consentScore = b.consent >= p.consent ? 1 : numMatch(p.consent, b.consent);
    raw += consentScore * W.consent; max += W.consent;
    contributions.consent = consentScore;
    // Taboo: ceiling (book ≤ user → full credit)
    const tabooScore = b.taboo <= p.taboo ? 1 : numMatch(p.taboo, b.taboo);
    raw += tabooScore * W.taboo; max += W.taboo;
    contributions.taboo = tabooScore;
    const toneO = setOverlap(p.tone,    b.tone);
    raw += toneO.credit * W.tone; max += W.tone;
    const dynO  = setOverlap(p.dynamic, b.dynamic);
    raw += dynO.credit  * W.dynamic; max += W.dynamic;
    const fit = Math.round((raw / max) * 100);
    const tagSignals = (b.tone?.length || 0) + (b.dynamic?.length || 0) + (b.trope?.length || 0) + (b.kink?.length || 0);
    const confidence = Math.min(100, 30 + Math.round(tagSignals * 7));
    return { fit, confidence, contributions, toneMatched: toneO.matched, dynMatched: dynO.matched };
  }

  // Apply subgenre + search filter, score every survivor, then sort.
  function filteredBooks() {
    const q = termState.search.toLowerCase().trim();
    let list = rawBooks().filter(b => {
      if (termState.subgenreFilter && b.subgenre !== termState.subgenreFilter) return false;
      if (q) {
        const hay = [b.title, b.author, b.subgenre, (b.trope || []).join(" "),
                     (b.tone || []).join(" "), b.short_summary || ""].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = list.map(b => Object.assign({}, b, scoreBook(b)));
    const sk = termState.sortKey, sd = termState.sortDir;
    list.sort((a, b) => {
      let av = a[sk], bv = b[sk];
      if (typeof av === "string") { av = av.toLowerCase(); bv = (bv || "").toLowerCase(); }
      if (av < bv) return sd === "asc" ? -1 : 1;
      if (av > bv) return sd === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }

  // ============================================================
  // SMALL HELPERS
  // ============================================================
  function $(root, sel) { return root.querySelector(sel); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function initials(s) {
    return String(s || "").split(/\s+/).map(w => w[0] || "").join("")
      .replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4) || "—";
  }
  function descriptorForFit(f) {
    if (f >= 75) return "strong fit";
    if (f >= 55) return "moderate fit";
    if (f >= 35) return "loose fit";
    return "thin fit";
  }
  function rateClass(n) { return "rate-h" + Math.max(1, Math.min(5, n || 3)); }

  // Sparkline SVG for KPI cells. Verbatim from reference.
  function sparklineSVG(data) {
    const w = 44, h = 18;
    const min = Math.min(...data), max = Math.max(...data);
    const range = Math.max(1, max - min);
    const step = w / (data.length - 1);
    const pts = data.map((v, i) =>
      `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(" ");
    return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // ============================================================
  // PLACEHOLDER render() — keeps the tab alive while subsequent
  // chunks (populators, command bar, dashboard, event wiring) are
  // written. Replaced in the final chunk.
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

  window.LumenTerminalNext = {
    render,
    _state:    termState,
    _shape:    toTerminalShape,
    _raw:      rawBooks,
    _filtered: filteredBooks,
    _score:    scoreBook
  };
})();
