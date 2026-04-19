/* ============================================================
   Lumen Terminal — editorial analytics for discerning readers.
   Reads live Lumen state (catalog + user-discovered + profile +
   hidden) and renders a dense analytics surface.
   Single entry: window.LumenTerminal.render()
   ============================================================ */
(function () {
  "use strict";

  const termState = {
    sortKey: "fit",
    sortDir: "desc",
    search: "",
    subgenreFilter: null,
    toneFilter: new Set(),
    dynFilter: new Set(),
    selectedId: null
  };

  // -------------------- data adapter --------------------
  function toTerminalShape(b) {
    if (!b) return null;
    return {
      id: b.id,
      title: b.title || "(untitled)",
      author: b.author || "Unknown",
      year: parseInt(b.year, 10) || 0,
      series: b.series || null,
      subgenre: b.subgenre || b.category || "Uncategorised",
      description: b.description || b.fit_notes || b.short_summary || "",
      cover_url: b.thumbnail || b.cover_url || null,
      source_url: b.source_url || b.sourceUrl || null,
      heat:     clamp1to5(b.heat_level != null ? b.heat_level : b.heat),
      explicit: clamp1to5(b.explicitness != null ? b.explicitness : b.explicit),
      emotion:  clamp1to5(b.emotional_intensity != null ? b.emotional_intensity : b.emotion),
      consent:  clamp1to5(b.consent_clarity != null ? b.consent_clarity : b.consent),
      taboo:    clamp1to5(b.taboo_level != null ? b.taboo_level : b.taboo),
      plot:     clamp1to5(b.plot_weight != null ? b.plot_weight : b.plot),
      tone:        arr(b.tone),
      pacing:      arr(b.pacing),
      style:       arr(b.literary_style || b.style),
      dynamic:     arr(b.relationship_dynamic || b.dynamic),
      trope:       arr(b.trope_tags || b.trope),
      kink:        arr(b.kink_tags || b.kink),
      gender:      arr(b.gender_pairing || b.gender),
      orientation: arr(b.orientation_tags || b.orientation),
      warnings:    arr(b.content_warnings || b.warnings),
      _raw: b
    };
  }
  function clamp1to5(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 3;
    return Math.max(1, Math.min(5, n));
  }
  function arr(x) { return Array.isArray(x) ? x.slice() : []; }

  function currentPool() {
    const L = window.Lumen;
    if (!L || !L.listAllBooks) return [];
    const s = L.store.get();
    const hidden = s.hidden || {};
    const raw = L.listAllBooks().filter(b => !hidden[b.id]);
    const engine = window.LumenEngine;
    const ranked = engine ? engine.rankRecommendations(s.profile, s.weights, raw) : { scored: [] };
    const scoredById = new Map((ranked.scored || []).map(x => [x.book.id, x]));
    return raw.map(b => {
      const t = toTerminalShape(b);
      const sc = scoredById.get(b.id);
      t.fit = sc ? sc.fitScore : 50;
      t.confidence = sc ? sc.confidence : 50;
      t.why = sc ? sc.why : null;
      return t;
    });
  }

  function applyFilters(pool) {
    const q = termState.search.toLowerCase().trim();
    let out = pool.filter(b => {
      if (termState.subgenreFilter && b.subgenre !== termState.subgenreFilter) return false;
      if (termState.toneFilter.size && !b.tone.some(t => termState.toneFilter.has(t))) return false;
      if (termState.dynFilter.size && !b.dynamic.some(d => termState.dynFilter.has(d))) return false;
      if (q) {
        const hay = [b.title, b.author, b.subgenre, b.tone.join(" "), b.trope.join(" "), b.description].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sk = termState.sortKey, sd = termState.sortDir;
    out.sort((a, b) => {
      let av = a[sk], bv = b[sk];
      if (typeof av === "string") { av = av.toLowerCase(); bv = (bv || "").toLowerCase(); }
      if (av < bv) return sd === "asc" ? -1 : 1;
      if (av > bv) return sd === "asc" ? 1 : -1;
      return 0;
    });
    return out;
  }

  // Handy util shortcut.
  const el = (tag, attrs, children) => window.Lumen.util.el(tag, attrs, children);

  // ================= Batch 2: command bar + KPI strip + footer =================

  // Live ticker — reader-space phrasing, no fake market deltas.
  //   " ITLX · 82 · strong fit · Erotic Romance "
  function initials(s) {
    return String(s || "").split(/\s+/).map(w => w[0]).join("").replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 4) || "—";
  }
  function descriptorForFit(f) {
    if (f >= 75) return "strong fit";
    if (f >= 55) return "moderate fit";
    if (f >= 35) return "loose fit";
    return "thin fit";
  }

  function renderCommandBar(pool) {
    const bar = el("div", { class: "term-cmd" });
    const brand = el("div", { class: "term-brand" }, [
      el("span", { class: "term-brand-mark", text: "Lumen" }),
      el("span", { class: "term-brand-sub", text: "TERMINAL" }),
      el("span", { class: "term-brand-divider" }),
      el("span", { class: "term-brand-mode", text: "Editorial analytics for discerning readers" })
    ]);
    bar.appendChild(brand);

    // Ticker — rotate the top fits. No randomised deltas; fit score
    // + descriptor only. Seamless-loop trick: duplicate content.
    const tickerWrap = el("div", { class: "term-ticker-wrap", "aria-hidden": "true" });
    const top = pool.slice(0, 12).sort((a, b) => b.fit - a.fit).slice(0, 10);
    const items = top.map(b => {
      return `<span class="term-ticker-item">
        <span class="term-ticker-sym">${initials(b.title)}</span>
        <span class="term-ticker-val">${b.fit}</span>
        <span class="term-ticker-desc">${descriptorForFit(b.fit)}</span>
        <span class="term-ticker-sub">${escapeHtml(b.subgenre)}</span>
      </span>`;
    });
    const tick = el("div", { class: "term-ticker" });
    tick.innerHTML = items.length ? items.join("") + items.join("") : `<span class="term-ticker-item t-small t-subtle">Load a catalog to light the ticker.</span>`;
    tickerWrap.appendChild(tick);
    bar.appendChild(tickerWrap);

    // System status — clock + count. No theme dots (topbar already has one).
    const status = el("div", { class: "term-status" });
    status.appendChild(el("span", { class: "term-live-dot" }));
    status.appendChild(el("span", { id: "term-clock", text: clockText() }));
    status.appendChild(el("span", { style: { color: "var(--border-strong, var(--border))" }, text: "·" }));
    status.appendChild(el("span", { text: `${pool.length} ${pool.length === 1 ? "title" : "titles"}` }));
    bar.appendChild(status);
    return bar;
  }
  function clockText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  // Starts a lightweight clock tick. Cleared automatically on
  // route changes via MutationObserver detection.
  function startClock() {
    if (startClock._id) clearInterval(startClock._id);
    startClock._id = setInterval(() => {
      const n = document.getElementById("term-clock");
      if (!n) { clearInterval(startClock._id); startClock._id = null; return; }
      n.textContent = clockText();
    }, 1000);
  }

  // KPI strip — six cells, all figures computed from the live pool.
  function renderKpiStrip(pool, visible) {
    const avgFit = visible.length ? Math.round(visible.reduce((s, b) => s + b.fit, 0) / visible.length) : 0;
    const top = visible[0] ? visible.reduce((a, b) => a.fit > b.fit ? a : b, visible[0]) : null;
    const strong = visible.filter(b => b.fit >= 70).length;
    const avgHeat = visible.length ? (visible.reduce((s, b) => s + b.heat, 0) / visible.length).toFixed(1) : "0";
    const libAvg = pool.length ? Math.round(pool.reduce((s, b) => s + b.fit, 0) / pool.length) : 0;
    const cells = [
      { label: "Catalogue",      val: `<em>${pool.length}</em>`,                    sub: "titles available",               cls: "gold" },
      { label: "In view",        val: `<em>${visible.length}</em>`,                 sub: pool.length ? `${Math.round(visible.length / pool.length * 100)}% of library` : "—", cls: "" },
      { label: "Avg fit",        val: `${avgFit}<span class="unit">%</span>`,       sub: visible.length ? `${avgFit - libAvg >= 0 ? "▲" : "▼"} ${Math.abs(avgFit - libAvg)}pp vs library` : "—", cls: avgFit >= 60 ? "good" : "" },
      { label: "Top fit",        val: top ? `${top.fit}<span class="unit">%</span>` : "—", sub: top ? escapeHtml(top.title).slice(0, 24) : "no titles in view", cls: "gold" },
      { label: "Strong ≥70",     val: `<em>${strong}</em>`,                         sub: visible.length ? `${Math.round(strong / visible.length * 100)}% of view` : "—", cls: "good" },
      { label: "Avg heat",       val: `<em>${avgHeat}</em>`,                        sub: "on the 1–5 scale",                cls: "blush" }
    ];
    const strip = el("div", { class: "term-kpi-strip" });
    cells.forEach(k => {
      const cell = el("div", { class: "term-kpi-cell" + (k.cls ? " tone-" + k.cls : "") });
      cell.appendChild(el("div", { class: "term-kpi-label", text: k.label }));
      cell.appendChild(el("div", { class: "term-kpi-val", html: k.val }));
      cell.appendChild(el("div", { class: "term-kpi-sub", html: k.sub }));
      strip.appendChild(cell);
    });
    return strip;
  }

  // Subgenre distribution footer — click a tile to filter the grid.
  function renderDistribution(pool, rerender) {
    const tileSection = el("div", { class: "panel term-dist-panel" });
    tileSection.appendChild(el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: "Subgenre distribution" }),
      el("span", { class: "panel-sub", text: termState.subgenreFilter ? `filtered: ${termState.subgenreFilter}` : "click to filter" })
    ]));
    const counts = {};
    const heat = {};
    pool.forEach(b => {
      counts[b.subgenre] = (counts[b.subgenre] || 0) + 1;
      heat[b.subgenre] = (heat[b.subgenre] || 0) + (b.heat || 0);
    });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const body = el("div", { class: "term-dist-body" });
    if (!entries.length) {
      body.appendChild(el("p", { class: "t-small t-subtle", style: { padding: "var(--s-3)" }, text: "No subgenres yet — import a catalog to see the distribution." }));
    }
    entries.forEach(([name, count]) => {
      const avgHeat = (heat[name] / count).toFixed(1);
      const active = termState.subgenreFilter === name;
      const tile = el("div", { class: "term-genre-tile" + (active ? " is-active" : ""),
        role: "button", tabindex: "0", "aria-pressed": active ? "true" : "false",
        onclick: () => { termState.subgenreFilter = active ? null : name; rerender(); },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); termState.subgenreFilter = active ? null : name; rerender(); } }
      });
      tile.appendChild(el("div", { class: "term-genre-name", text: name }));
      const stats = el("div", { class: "term-genre-stats" }, [
        el("span", { class: "term-genre-count", text: String(count) }),
        el("span", { class: "term-genre-avg", text: `HEAT ${avgHeat}` })
      ]);
      tile.appendChild(stats);
      body.appendChild(tile);
    });
    tileSection.appendChild(body);
    return tileSection;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ================= main render =================
  function render() {
    const L = window.Lumen;
    if (!L || !L.util) return document.createTextNode("Terminal: Lumen core not loaded.");

    const wrap = el("div", { class: "page lumen-terminal" });

    const pool = currentPool();
    const visible = applyFilters(pool);

    // Re-render helper — used by the filter tiles. Re-renders in
    // place so chip/filter toggles don't bounce through the router.
    function rerender() {
      const fresh = render();
      wrap.replaceWith(fresh);
    }

    wrap.appendChild(renderCommandBar(pool));
    wrap.appendChild(renderKpiStrip(pool, visible));

    // Centre/left/right/bottom placeholders — Batches 3-5 fill these.
    const scaffold = el("div", { class: "card stack" });
    scaffold.appendChild(el("h3", { html: "Terminal <em>scaffold</em> · Batches 2 complete, 3–6 landing next" }));
    if (!pool.length) {
      scaffold.appendChild(el("p", { class: "t-small t-muted", text: "Your pool is empty — Terminal numbers are zeros until you import a catalog (Settings → Curated catalog) or add titles from Discovery." }));
    } else {
      scaffold.appendChild(el("p", { class: "t-small t-muted",
        text: `Live pool: ${pool.length} titles · ${visible.length} in view. Fit scores mirror the rest of the app; click a subgenre tile below to filter.` }));
    }
    wrap.appendChild(scaffold);

    wrap.appendChild(renderDistribution(pool, rerender));

    // Start the clock once the view is in the DOM.
    setTimeout(startClock, 0);
    return wrap;
  }

  window.LumenTerminal = {
    render,
    _state: termState,
    _pool: currentPool,
    _apply: applyFilters,
    _shape: toTerminalShape
  };
})();
