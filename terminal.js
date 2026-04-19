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

  // ================= Slice A: heatmap + bars + dense grid =================

  // Panel chrome reused across centre + right columns.
  function panel(titleText, subText, body, extraClass) {
    const p = el("div", { class: "panel term-panel" + (extraClass ? " " + extraClass : "") });
    const head = el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: titleText }),
      subText ? el("span", { class: "panel-sub", text: subText }) : null
    ].filter(Boolean));
    p.appendChild(head);
    if (body) p.appendChild(body);
    return p;
  }

  // Heat × Explicitness — 5×5 grid showing how the catalogue is
  // distributed across the two intensity axes. Density is rendered
  // as accent tint; empty cells stay quiet.
  function renderHeatmap(pool) {
    const wrap = el("div", { class: "term-heatmap" });
    // grid[i][j] where i is heat row (5 → 1, top to bottom) and
    // j is explicit column (1 → 5, left to right).
    const grid = [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
    pool.forEach(b => {
      const r = 5 - b.heat;
      const c = b.explicit - 1;
      if (r >= 0 && r < 5 && c >= 0 && c < 5) grid[r][c] += 1;
    });
    const max = Math.max(1, ...grid.flat());

    // Header row.
    const header = el("div", { class: "term-heatmap-row term-heatmap-hdr" });
    header.appendChild(el("div", { text: "H ↓ / E →" }));
    [1,2,3,4,5].forEach(n => header.appendChild(el("div", { text: String(n) })));
    wrap.appendChild(header);

    for (let i = 0; i < 5; i++) {
      const heatLvl = 5 - i;
      const row = el("div", { class: "term-heatmap-row" });
      row.appendChild(el("div", { class: "term-heatmap-rowlabel", text: "H" + heatLvl }));
      for (let j = 0; j < 5; j++) {
        const v = grid[i][j];
        if (v === 0) {
          row.appendChild(el("div", { class: "term-heatmap-cell is-empty",
            title: `Heat ${heatLvl} · Explicit ${j + 1}: no titles` }));
        } else {
          const intensity = v / max;
          const alpha = (0.18 + intensity * 0.7).toFixed(2);
          const cell = el("div", { class: "term-heatmap-cell",
            title: `Heat ${heatLvl} · Explicit ${j + 1}: ${v} title${v === 1 ? "" : "s"}`,
            text: String(v)
          });
          cell.style.background = `color-mix(in srgb, var(--accent) ${(intensity * 70 + 18).toFixed(0)}%, transparent)`;
          cell.style.color = intensity > 0.55 ? "var(--accent-ink, #fff)" : "var(--text)";
          row.appendChild(cell);
        }
      }
      wrap.appendChild(row);
    }
    return panel("Heat × Explicitness matrix", "catalogue distribution", wrap);
  }

  // Top trope frequency bars. Reads trope_tags from each book.
  function renderTropeBar(pool) {
    const counts = {};
    pool.forEach(b => (b.trope || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(1, ...entries.map(e => e[1]));
    const wrap = el("div", { class: "term-bars" });
    if (!entries.length) {
      wrap.appendChild(el("p", { class: "t-small t-subtle", style: { padding: "var(--s-3)" }, text: "No trope tags in current pool." }));
      return panel("Trope frequency", "top signals", wrap);
    }
    entries.forEach(([name, n], i) => {
      const cls = i % 3 === 0 ? "" : i % 3 === 1 ? "tone-sage" : "tone-violet";
      const row = el("div", { class: "term-bar-row" });
      row.appendChild(el("div", { class: "term-bar-label", title: name, text: name.replace(/-/g, " ") }));
      const track = el("div", { class: "term-bar-track" });
      const fill = el("div", { class: "term-bar-fill " + cls });
      fill.style.width = ((n / max) * 100).toFixed(1) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div", { class: "term-bar-val", text: String(n) }));
      wrap.appendChild(row);
    });
    return panel("Trope frequency", "top signals", wrap);
  }

  // Publication era buckets.
  function renderEraBar(pool) {
    const buckets = [
      { label: "Pre-1950",  test: y => y > 0 && y < 1950 },
      { label: "1950-1999", test: y => y >= 1950 && y < 2000 },
      { label: "2000-2009", test: y => y >= 2000 && y < 2010 },
      { label: "2010-2014", test: y => y >= 2010 && y < 2015 },
      { label: "2015-2019", test: y => y >= 2015 && y < 2020 },
      { label: "2020+",     test: y => y >= 2020 }
    ];
    const data = buckets.map(b => ({ label: b.label, n: pool.filter(x => b.test(x.year)).length }));
    const max = Math.max(1, ...data.map(d => d.n));
    const wrap = el("div", { class: "term-bars" });
    data.forEach(d => {
      const row = el("div", { class: "term-bar-row" });
      row.appendChild(el("div", { class: "term-bar-label", text: d.label }));
      const track = el("div", { class: "term-bar-track" });
      const fill = el("div", { class: "term-bar-fill tone-blush" });
      fill.style.width = ((d.n / max) * 100).toFixed(1) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div", { class: "term-bar-val", text: String(d.n) }));
      wrap.appendChild(row);
    });
    return panel("Publication era", "across time", wrap);
  }

  // Dense Bloomberg-style data grid. Sortable headers, search input,
  // row click opens the existing Lumen book-detail sheet so the
  // Terminal stays consistent with every other surface.
  function rateClass(n) { return "term-rate-h" + Math.max(1, Math.min(5, n || 3)); }
  function fitClass(f) { return f >= 75 ? "is-strong" : f >= 55 ? "is-mid" : "is-low"; }

  function renderDataGrid(pool, visible, rerender) {
    const wrap = el("div", { class: "panel term-grid-panel" });
    wrap.appendChild(el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: "Catalogue grid" }),
      el("span", { class: "panel-sub", text: "every title, every signal" })
    ]));

    // Controls: search + count.
    const controls = el("div", { class: "term-grid-controls" });
    const search = el("input", {
      type: "text", class: "term-grid-search",
      placeholder: "/ search title, author, trope…",
      value: termState.search,
      oninput: (e) => { termState.search = e.target.value; rerender(); }
    });
    controls.appendChild(search);
    controls.appendChild(el("div", { class: "term-grid-count" }, [
      el("em", { text: String(visible.length) }),
      " showing"
    ]));
    wrap.appendChild(controls);

    // Scrolling table.
    const scroll = el("div", { class: "term-grid-scroll" });
    const table = el("table", { class: "term-grid" });
    const cols = [
      { key: "fit",      label: "Fit",      title: "Engine fit score" },
      { key: "title",    label: "Title" },
      { key: "author",   label: "Author" },
      { key: "year",     label: "Year" },
      { key: "subgenre", label: "Subgenre" },
      { key: "heat",     label: "H", title: "Heat" },
      { key: "explicit", label: "E", title: "Explicit" },
      { key: "emotion",  label: "M", title: "Emotion" },
      { key: "consent",  label: "C", title: "Consent" },
      { key: "taboo",    label: "T", title: "Taboo" },
      { key: "plot",     label: "P", title: "Plot weight" },
      { key: "_signals", label: "Signals", noSort: true }
    ];
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    cols.forEach(c => {
      const th = document.createElement("th");
      th.textContent = c.label;
      if (c.title) th.title = c.title;
      if (!c.noSort) {
        th.classList.add("is-sortable");
        if (termState.sortKey === c.key) {
          th.classList.add("is-sorted");
          if (termState.sortDir === "asc") th.classList.add("is-asc");
        }
        th.addEventListener("click", () => {
          if (termState.sortKey === c.key) {
            termState.sortDir = termState.sortDir === "asc" ? "desc" : "asc";
          } else {
            termState.sortKey = c.key;
            termState.sortDir = (c.key === "title" || c.key === "author" || c.key === "subgenre") ? "asc" : "desc";
          }
          rerender();
        });
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    if (!visible.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = cols.length;
      td.style.padding = "30px";
      td.style.textAlign = "center";
      td.style.fontFamily = "var(--font-serif)";
      td.style.fontStyle = "italic";
      td.style.color = "var(--text-mute)";
      td.textContent = "No titles match the current filters.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      visible.forEach(b => {
        const tr = document.createElement("tr");
        if (termState.selectedId === b.id) tr.classList.add("is-selected");
        tr.dataset.id = b.id;
        tr.addEventListener("click", () => {
          // Selection drives the right-column inline detail; the
          // double-click / explicit-action affordance opens the
          // full Lumen detail sheet.
          termState.selectedId = b.id;
          rerender();
        });
        tr.addEventListener("dblclick", () => {
          if (window.Lumen && window.Lumen.openBookDetail) window.Lumen.openBookDetail(b.id);
        });

        // Fit cell — score + mini-bar.
        const fitTd = document.createElement("td");
        fitTd.className = "term-fit-cell " + fitClass(b.fit);
        fitTd.title = `Fit ${b.fit}% · Confidence ${b.confidence}%`;
        fitTd.appendChild(el("div", { class: "term-fit-num", text: String(b.fit) }));
        const mini = el("div", { class: "term-fit-mini" });
        const miniFill = el("span");
        miniFill.style.width = b.fit + "%";
        mini.appendChild(miniFill);
        fitTd.appendChild(mini);
        tr.appendChild(fitTd);

        const titleTd = el("td", { class: "term-title-cell", title: b.title, text: b.title });
        const authorTd = el("td", { class: "term-author-cell", title: b.author, text: b.author });
        const yearTd = el("td", { class: "term-num-cell", text: b.year ? String(b.year) : "—" });
        const subTd = el("td", { class: "term-sub-cell", title: b.subgenre, text: b.subgenre });
        tr.appendChild(titleTd);
        tr.appendChild(authorTd);
        tr.appendChild(yearTd);
        tr.appendChild(subTd);

        ["heat","explicit","emotion","consent","taboo","plot"].forEach(k => {
          const td = el("td", { class: "term-num-cell" });
          const pill = el("span", { class: "term-rate-pill " + rateClass(b[k]), text: String(b[k]) });
          td.appendChild(pill);
          tr.appendChild(td);
        });

        const sig = [
          ...(b.tone || []).slice(0, 1),
          ...(b.dynamic || []).slice(0, 1),
          ...(b.trope || []).slice(0, 1)
        ].slice(0, 2).map(s => s.replace(/-/g, " ")).join(" · ") || "—";
        tr.appendChild(el("td", { class: "term-sig-cell", text: sig }));
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    return wrap;
  }

  // Centre-column layout: charts row above the data grid.
  function renderCentreColumn(pool, visible, rerender) {
    const col = el("div", { class: "term-centre stack" });
    const charts = el("div", { class: "term-charts-row" });
    charts.appendChild(renderHeatmap(pool));
    charts.appendChild(renderTropeBar(pool));
    charts.appendChild(renderEraBar(pool));
    col.appendChild(charts);
    col.appendChild(renderDataGrid(pool, visible, rerender));
    return col;
  }

  // ================= Slice B: left column (compass + sliders + chips) =================

  // Radar SVG. Six axes (heat / explicit / emotion / consent / taboo
  // / plot), each scored 1-5. Used both for the user's profile
  // compass on the left and (in Slice C) for an overlap radar
  // comparing the user's profile against the selected book.
  function renderRadar(values, opts) {
    opts = opts || {};
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "term-radar-svg" + (opts.className ? " " + opts.className : ""));
    svg.setAttribute("viewBox", "-110 -110 220 220");
    svg.setAttribute("aria-hidden", "true");

    const axes = ["heat", "explicit", "emotion", "consent", "taboo", "plot"];
    const R = 85;

    // Background rings.
    [0.25, 0.5, 0.75, 1].forEach(t => {
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("class", "term-radar-ring");
      ring.setAttribute("cx", "0"); ring.setAttribute("cy", "0");
      ring.setAttribute("r", String(R * t));
      svg.appendChild(ring);
    });

    // Axes + labels.
    axes.forEach((axis, i) => {
      const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
      const x = (Math.cos(angle) * R).toFixed(1);
      const y = (Math.sin(angle) * R).toFixed(1);
      const lx = (Math.cos(angle) * (R + 14)).toFixed(1);
      const ly = (Math.sin(angle) * (R + 14)).toFixed(1);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("class", "term-radar-axis");
      line.setAttribute("x1", "0"); line.setAttribute("y1", "0");
      line.setAttribute("x2", x);   line.setAttribute("y2", y);
      svg.appendChild(line);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "term-radar-label");
      t.setAttribute("x", lx); t.setAttribute("y", ly);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "middle");
      t.textContent = axis.toUpperCase().slice(0, 4);
      svg.appendChild(t);
    });

    // Comparison shape (e.g. focus book) drawn underneath the
    // primary so the user's profile reads on top.
    if (opts.comparison) {
      const cmpPts = axes.map((a, i) => {
        const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
        const r = (clamp1to5(opts.comparison[a]) / 5) * R;
        return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
      });
      const cmpPath = document.createElementNS(NS, "path");
      cmpPath.setAttribute("class", "term-radar-shape is-cmp");
      cmpPath.setAttribute("d", "M " + cmpPts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ") + " Z");
      svg.appendChild(cmpPath);
    }

    // Primary shape + points.
    const pts = axes.map((axis, i) => {
      const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
      const r = (clamp1to5(values[axis]) / 5) * R;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "term-radar-shape");
    path.setAttribute("d", "M " + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ") + " Z");
    svg.appendChild(path);
    pts.forEach(p => {
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("class", "term-radar-point");
      dot.setAttribute("cx", p.x.toFixed(1));
      dot.setAttribute("cy", p.y.toFixed(1));
      dot.setAttribute("r", "2.6");
      svg.appendChild(dot);
    });
    return svg;
  }

  // Six 1-5 sliders. Writes go through Lumen.store so changes
  // here propagate to Profile, Daily Picks, Compare, and Sara on
  // the next turn — no parallel profile.
  function renderProfileSliders(rerender) {
    const L = window.Lumen;
    const profile = L.store.get().profile;
    const wrap = el("div", { class: "term-sliders" });
    const fields = [
      { key: "heat",     label: "Heat" },
      { key: "explicit", label: "Explicit" },
      { key: "emotion",  label: "Emotion" },
      { key: "consent",  label: "Consent ≥" },
      { key: "taboo",    label: "Taboo" },
      { key: "plot",     label: "Plot" }
    ];
    fields.forEach(f => {
      const row = el("div", { class: "term-slider-row" });
      row.appendChild(el("div", { class: "term-slider-label", text: f.label }));
      const input = el("input", {
        type: "range", min: "1", max: "5", step: "1",
        value: String(profile[f.key]),
        "aria-label": f.label,
        oninput: (e) => {
          const v = parseInt(e.target.value, 10);
          // Live readout updates without a re-render so the slider
          // feels responsive; re-render on `change` once the user
          // releases to refresh the dependent KPIs / heatmap / grid.
          val.textContent = String(v);
          L.store.update(s => { s.profile[f.key] = v; });
        },
        onchange: () => rerender()
      });
      const val = el("div", { class: "term-slider-val", text: String(profile[f.key]) });
      row.appendChild(input);
      row.appendChild(val);
      wrap.appendChild(row);
    });
    return wrap;
  }

  // Tone + dynamic chip filters — local to termState only. Toggling
  // a chip never writes to the user's profile.tone / profile.dynamic;
  // these are view-side filters that narrow what the grid + heatmap
  // + bars show, not edits to her actual taste settings.
  const TONE_OPTIONS = [
    "dark", "intense", "obsessive", "sensual", "tender", "lyrical",
    "wry", "reflective", "transgressive", "playful"
  ];
  const DYN_OPTIONS = [
    "dominance-submission", "power-exchange", "forbidden",
    "enemies-to-lovers", "marriage", "reverse-harem", "fated-mates",
    "second-chance", "courtship", "mutual-longing"
  ];

  function renderChipFilter(label, options, filterSet, rerender) {
    const section = el("div", { class: "term-chip-section" });
    section.appendChild(el("div", { class: "term-chip-section-label", text: label }));
    const row = el("div", { class: "term-chip-row" });
    options.forEach(opt => {
      const active = filterSet.has(opt);
      const chip = el("button", {
        type: "button",
        class: "term-chip" + (active ? " is-active" : ""),
        "aria-pressed": active ? "true" : "false",
        title: opt.replace(/-/g, " "),
        onclick: () => {
          if (filterSet.has(opt)) filterSet.delete(opt);
          else filterSet.add(opt);
          rerender();
        }
      });
      chip.textContent = opt.replace(/-/g, " ");
      row.appendChild(chip);
    });
    section.appendChild(row);
    return section;
  }

  // Compose the full left column: compass head + radar + sliders +
  // tone chips + dynamic chips, all inside one panel for visual
  // calm.
  function renderLeftColumn(rerender) {
    const L = window.Lumen;
    const profile = L.store.get().profile;
    const col = el("aside", { class: "term-left" });
    const wrap = el("div", { class: "term-panel" });
    wrap.appendChild(el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: "Your compass" }),
      el("span", { class: "panel-sub", text: "her taste" })
    ]));
    const body = el("div", { class: "panel-body term-left-body" });
    body.appendChild(el("div", { class: "term-compass-label", text: "Profile radar" }));
    const radarHost = el("div", { class: "term-compass-host" });
    radarHost.appendChild(renderRadar(profile));
    body.appendChild(radarHost);
    body.appendChild(renderProfileSliders(rerender));
    body.appendChild(renderChipFilter("Tone filter", TONE_OPTIONS, termState.toneFilter, rerender));
    body.appendChild(renderChipFilter("Dynamic filter", DYN_OPTIONS, termState.dynFilter, rerender));
    // Reset filters affordance — only show when something is active.
    const anyFilter = termState.toneFilter.size || termState.dynFilter.size || termState.subgenreFilter || termState.search;
    if (anyFilter) {
      const reset = el("button", {
        type: "button",
        class: "term-reset-filters",
        onclick: () => {
          termState.toneFilter.clear();
          termState.dynFilter.clear();
          termState.subgenreFilter = null;
          termState.search = "";
          rerender();
        }
      });
      reset.textContent = "Clear all view filters";
      body.appendChild(reset);
    }
    wrap.appendChild(body);
    col.appendChild(wrap);
    return col;
  }

  // ================= Slice C: right column (detail + similar + brief) =================

  // Resolve the currently selected book (or fall back to the top
  // of the pool so the right column is never empty when there's
  // anything to look at).
  function pickSelected(pool) {
    if (!pool.length) return null;
    if (termState.selectedId) {
      const found = pool.find(b => b.id === termState.selectedId);
      if (found) return found;
    }
    return pool[0];
  }

  // Inline book detail — cover, title, fit + confidence rings,
  // user-vs-book overlap radar, summary, KV pairs, signal tags,
  // advisory warnings. Reuses the radar from Slice B with the
  // book passed as the comparison shape.
  function renderBookDetail(book) {
    const wrap = el("div", { class: "term-panel term-detail-panel" });
    wrap.appendChild(el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: "Selected title" }),
      el("span", { class: "panel-sub", text: "in detail" })
    ]));

    if (!book) {
      const empty = el("div", { class: "panel-body" });
      empty.appendChild(el("p", { class: "t-small t-subtle",
        text: "Click a row in the grid to mark a selection. Anything in your catalogue can be inspected here." }));
      wrap.appendChild(empty);
      return wrap;
    }

    // Cover header — image with a quiet linear-gradient fallback,
    // title + author overlaid bottom-left.
    const cover = el("div", { class: "term-detail-cover" });
    if (book.cover_url) {
      const img = el("img", {
        src: String(book.cover_url).replace(/^http:/, "https:"),
        alt: `Cover of ${book.title}`,
        loading: "lazy",
        onerror: function () { this.remove(); }
      });
      cover.appendChild(img);
    }
    cover.appendChild(el("div", { class: "term-detail-cover-meta" }, [
      el("div", { class: "term-detail-title", text: book.title }),
      el("div", { class: "term-detail-author",
        text: `${book.author}${book.year ? " · " + book.year : ""}` })
    ]));
    wrap.appendChild(cover);

    const body = el("div", { class: "term-detail-content" });

    // Fit + confidence pair.
    const fitClsName = book.fit >= 70 ? "is-sage" : book.fit >= 50 ? "" : "is-warn";
    const confClsName = book.confidence >= 70 ? "is-sage" : book.confidence >= 45 ? "" : "is-warn";
    const fitStrip = el("div", { class: "term-detail-fit-strip" });
    fitStrip.appendChild(el("div", { class: "term-detail-fit-cell" }, [
      el("div", { class: "term-detail-fit-label", text: "Fit for her" }),
      el("div", { class: "term-detail-fit-val " + fitClsName, text: book.fit + "%" })
    ]));
    fitStrip.appendChild(el("div", { class: "term-detail-fit-cell" }, [
      el("div", { class: "term-detail-fit-label", text: "Confidence" }),
      el("div", { class: "term-detail-fit-val " + confClsName, text: book.confidence + "%" })
    ]));
    body.appendChild(fitStrip);

    // Overlap radar — user profile filled, book overlaid in dashed gold.
    const profile = window.Lumen.store.get().profile;
    const overlapWrap = el("div", { class: "term-detail-radar-wrap" });
    overlapWrap.appendChild(el("div", { class: "term-detail-radar-title", text: "Overlap" }));
    overlapWrap.appendChild(el("div", { class: "term-detail-radar-sub", text: "her profile vs this title" }));
    const overlapHost = el("div", { class: "term-detail-radar-host" });
    overlapHost.appendChild(renderRadar(profile, { comparison: book, className: "is-detail" }));
    overlapWrap.appendChild(overlapHost);
    body.appendChild(overlapWrap);

    // Editorial summary.
    body.appendChild(el("div", { class: "term-detail-summary",
      text: book.description || "No editorial summary on file for this title yet." }));

    // KV table — subgenre, series, year, pairing.
    const kv = el("dl", { class: "term-detail-kv" });
    const kvPairs = [
      ["Subgenre",   book.subgenre || "—"],
      ["Series",     book.series || "standalone"],
      ["Published",  book.year ? String(book.year) : "—"],
      ["Pairing",    (book.orientation || []).map(o => o.replace(/-/g, " ")).join(", ") || "—"]
    ];
    kvPairs.forEach(([k, v]) => {
      kv.appendChild(el("dt", { text: k }));
      kv.appendChild(el("dd", { text: v }));
    });
    body.appendChild(kv);

    // Signal tags + advisory warnings, two clearly separate strips.
    body.appendChild(el("div", { class: "term-chip-section-label", style: { marginBottom: "6px" }, text: "Signals" }));
    const sigStrip = el("div", { class: "term-detail-tags" });
    const sigList = [
      ...(book.tone || []).map(t => ({ text: t, cls: "" })),
      ...(book.dynamic || []).map(t => ({ text: t, cls: "is-gold" })),
      ...(book.trope || []).map(t => ({ text: t, cls: "" })),
      ...(book.kink || []).map(t => ({ text: t, cls: "" }))
    ];
    if (sigList.length) {
      sigList.slice(0, 18).forEach(t => {
        sigStrip.appendChild(el("span", { class: "term-detail-tag " + t.cls, text: t.text.replace(/-/g, " ") }));
      });
    } else {
      sigStrip.appendChild(el("span", { class: "t-small t-subtle", style: { fontStyle: "italic" }, text: "no tagged signals" }));
    }
    body.appendChild(sigStrip);

    body.appendChild(el("div", { class: "term-chip-section-label",
      style: { marginTop: "10px", marginBottom: "6px" }, text: "Advisory flags" }));
    const warnStrip = el("div", { class: "term-detail-tags" });
    if ((book.warnings || []).length) {
      book.warnings.forEach(w => warnStrip.appendChild(
        el("span", { class: "term-detail-tag is-warn", text: w })
      ));
    } else {
      warnStrip.appendChild(el("span", { class: "t-small t-subtle", style: { fontStyle: "italic", color: "var(--t-sage)" },
        text: "no warnings flagged" }));
    }
    body.appendChild(warnStrip);

    // Quick actions — Open detail sheet, Pin to Sara.
    const actions = el("div", { class: "term-detail-actions" });
    actions.appendChild(el("button", {
      type: "button", class: "term-action-btn is-primary",
      onclick: () => { if (window.Lumen && window.Lumen.openBookDetail) window.Lumen.openBookDetail(book.id); }
    }, "Open full detail"));
    actions.appendChild(el("button", {
      type: "button", class: "term-action-btn",
      onclick: () => {
        const Sara = window.LumenSara;
        if (Sara && Sara.pinBook) Sara.pinBook(book.id);
      }
    }, "Pin to Sara"));
    body.appendChild(actions);

    wrap.appendChild(body);
    return wrap;
  }

  // Similar-by-signal-overlap. Lightweight scoring against the
  // selected book using tone / dynamic / trope / kink overlaps
  // plus subgenre match minus heat & plot deltas. Top 5.
  function renderSimilar(book, pool, rerender) {
    const wrap = el("div", { class: "term-panel" });
    wrap.appendChild(el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: "Similar to this" }),
      el("span", { class: "panel-sub", text: "by signal overlap" })
    ]));
    const body = el("div", { class: "panel-body term-similar-list" });
    if (!book) {
      body.appendChild(el("p", { class: "t-small t-subtle", style: { fontStyle: "italic", textAlign: "center" },
        text: "select a title above" }));
      wrap.appendChild(body);
      return wrap;
    }
    const overlapOf = (other) => {
      let s = 0;
      const inter = (a, b) => (a || []).filter(x => (b || []).includes(x)).length;
      s += inter(book.tone, other.tone) * 3;
      s += inter(book.dynamic, other.dynamic) * 4;
      s += inter(book.trope, other.trope) * 5;
      s += inter(book.kink, other.kink) * 2;
      if (book.subgenre === other.subgenre) s += 4;
      s -= Math.abs((book.heat || 0) - (other.heat || 0));
      s -= Math.abs((book.plot || 0) - (other.plot || 0));
      return s;
    };
    const ranked = pool.filter(b => b.id !== book.id)
      .map(b => ({ b, s: overlapOf(b) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, 5);
    if (!ranked.length) {
      body.appendChild(el("p", { class: "t-small t-subtle", style: { fontStyle: "italic", textAlign: "center" },
        text: "no other titles in the current view" }));
      wrap.appendChild(body);
      return wrap;
    }
    ranked.forEach(({ b, s }) => {
      const pct = Math.max(30, Math.min(95, 40 + s * 4));
      const item = el("div", {
        class: "term-similar-item",
        role: "button", tabindex: "0",
        onclick: () => { termState.selectedId = b.id; rerender(); },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); termState.selectedId = b.id; rerender(); } }
      });
      const cover = el("div", { class: "term-similar-cover" });
      if (b.cover_url) {
        const img = el("img", { src: String(b.cover_url).replace(/^http:/, "https:"), alt: "",
          onerror: function () { this.style.display = "none"; } });
        cover.appendChild(img);
      }
      item.appendChild(cover);
      const meta = el("div", { class: "term-similar-meta" });
      meta.appendChild(el("div", { class: "term-similar-title", text: b.title }));
      meta.appendChild(el("div", { class: "term-similar-author", text: b.author }));
      item.appendChild(meta);
      item.appendChild(el("div", { class: "term-similar-score", text: pct + "%" }));
      body.appendChild(item);
    });
    wrap.appendChild(body);
    return wrap;
  }

  // Editor's brief — dynamic prose grounded in the current view.
  // Ends with a Sara CTA so the Terminal feeds into the chat
  // surface rather than ending in a dead-end card.
  function renderEditorsBrief(pool, visible, selected) {
    const wrap = el("div", { class: "term-panel term-brief" });
    wrap.appendChild(el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: "Editor's brief" }),
      el("span", { class: "panel-sub", text: "what the data is saying" })
    ]));
    const body = el("div", { class: "panel-body" });

    let headline, prose;
    if (!pool.length) {
      headline = `An <em>empty</em> shelf.`;
      prose = "There is nothing to read on the data yet — import your curated catalogue from Settings, or pull a few titles from Discovery, and the brief lights up.";
    } else {
      const strong = visible.filter(b => b.fit >= 70).length;
      const sums = {};
      visible.filter(b => b.fit >= 60).forEach(b => { sums[b.subgenre] = (sums[b.subgenre] || 0) + 1; });
      const topGenre = Object.entries(sums).sort((a, b) => b[1] - a[1])[0];
      const tone = [...termState.toneFilter][0];
      if (strong >= 20) {
        headline = `Her compass is <em>richly served</em>.`;
        prose = `${strong} titles clear 70% — the catalogue runs deep in her territory. Lean into ${topGenre ? topGenre[0] : "her top subgenre"} for the highest-fit reads.`;
      } else if (strong >= 8) {
        headline = `A <em>specialist's</em> taste.`;
        prose = `${strong} titles meet her threshold. She's looking for specific signals${tone ? ` — the ${tone} tone reads particularly well` : ""}${topGenre ? `, anchored in ${topGenre[0]}` : ""}.`;
      } else if (strong > 0) {
        headline = `A <em>particular</em> reader.`;
        prose = `Only ${strong} titles clear 70%. Try widening the tone filter or softening the consent floor by one step to expand the eligible pool.`;
      } else {
        headline = `An <em>unmet</em> signature.`;
        prose = `Nothing in view clears 70% right now. Relax taboo tolerance, drop a chip filter, or import more catalogue — the engine is honest, not pessimistic.`;
      }
    }

    body.appendChild(el("div", { class: "term-brief-headline", html: headline }));
    body.appendChild(el("p", { class: "term-brief-body", text: prose }));

    // Sara CTA — primary path off the Terminal into a conversation.
    const cta = el("div", { class: "term-brief-cta" });
    const askBtn = el("button", { type: "button", class: "term-action-btn is-primary",
      onclick: () => {
        const Sara = window.LumenSara;
        if (!Sara) return;
        if (selected && Sara.pinBook) Sara.pinBook(selected.id);
        if (Sara.open) Sara.open();
      }
    }, selected ? `Ask Sara about ${selected.title.slice(0, 24)}${selected.title.length > 24 ? "…" : ""}` : "Ask Sara about this view");
    cta.appendChild(askBtn);
    body.appendChild(cta);

    wrap.appendChild(body);
    return wrap;
  }

  // Right column composition.
  function renderRightColumn(pool, visible, rerender) {
    const col = el("aside", { class: "term-right" });
    const selected = pickSelected(visible.length ? visible : pool);
    col.appendChild(renderBookDetail(selected));
    col.appendChild(renderSimilar(selected, visible.length ? visible : pool, rerender));
    col.appendChild(renderEditorsBrief(pool, visible, selected));
    return col;
  }

  // ================= main render =================
  function render() {
    const L = window.Lumen;
    if (!L || !L.util) return document.createTextNode("Terminal: Lumen core not loaded.");

    const wrap = el("div", { class: "page lumen-terminal" });

    const pool = currentPool();
    const visible = applyFilters(pool);

    function rerender() {
      const fresh = render();
      wrap.replaceWith(fresh);
    }

    wrap.appendChild(renderCommandBar(pool));
    wrap.appendChild(renderKpiStrip(pool, visible));

    const dash = el("div", { class: "term-dashboard" });
    dash.appendChild(renderLeftColumn(rerender));
    dash.appendChild(renderCentreColumn(pool, visible, rerender));
    dash.appendChild(renderRightColumn(pool, visible, rerender));

    wrap.appendChild(dash);
    wrap.appendChild(renderDistribution(pool, rerender));

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
