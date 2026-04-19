/* ============================================================
   LUMEN TERMINAL — verbatim port of lumen_terminal.html
   Single entry: window.LumenTerminal.render()

   Renders the editorial-analytics dashboard inside the Lumen app
   shell. The DOM, class names, scoring, and behaviour mirror the
   standalone lumen_terminal.html reference; data is sourced from
   Lumen.listAllBooks and slider edits mirror to Lumen.store so the
   user's profile stays in sync across tabs.
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
    tropeFilter: new Set(),
    eraFilter:   new Set(),
    search: "",
    sortKey: "fit",
    sortDir: "desc",
    selectedId: null,
    _seededFromLumen: false
  };

  // Publication-era buckets shared by renderEraBar + filteredBooks.
  const ERA_BUCKETS = [
    { label: "Pre-1950",  test: y => y > 0 && y < 1950 },
    { label: "1950-1999", test: y => y >= 1950 && y < 2000 },
    { label: "2000-2009", test: y => y >= 2000 && y < 2010 },
    { label: "2010-2014", test: y => y >= 2010 && y < 2015 },
    { label: "2015-2019", test: y => y >= 2015 && y < 2020 },
    { label: "2020+",     test: y => y >= 2020 }
  ];

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
    const tropeF = termState.tropeFilter;
    const eraF   = termState.eraFilter;
    const activeEras = eraF.size ? ERA_BUCKETS.filter(e => eraF.has(e.label)) : null;
    let list = rawBooks().filter(b => {
      if (termState.subgenreFilter && b.subgenre !== termState.subgenreFilter) return false;
      // Trope + era use OR within each dimension and AND across dimensions.
      if (tropeF.size && !(b.trope || []).some(t => tropeF.has(t))) return false;
      if (activeEras && !(b.year && activeEras.some(e => e.test(b.year)))) return false;
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
  // POPULATORS — each function reads from filteredBooks() / state
  // and writes innerHTML into a specific container in the wrap.
  // Verbatim parity with lumen_terminal.html; element ids match
  // the reference so the markup template can be lifted unchanged
  // in a later chunk.
  // ============================================================

  // ---------- KPI strip — six cells, sparklines anchored R/B ----------
  function renderKPIs(root) {
    const list  = filteredBooks();
    const total = rawBooks().length;
    const avgFit = list.length ? Math.round(list.reduce((s, b) => s + b.fit, 0) / list.length) : 0;
    const top    = list[0]?.fit || 0;
    const strong = list.filter(b => b.fit >= 70).length;
    const avgHeat = list.length ? (list.reduce((s, b) => s + b.heat, 0) / list.length).toFixed(1) : "0";
    const cells = [
      { label: "CATALOGUE", val: `<em>${total}</em>`, sub: "curated titles", cls: "gold",
        spark: [80, 85, 90, 95, 100, 100] },
      { label: "IN VIEW", val: `<em>${list.length}</em>`,
        sub: `${total ? Math.round(list.length / total * 100) : 0}% of library`, cls: "",
        spark: [60, 75, 65, 80, 90, list.length] },
      { label: "AVG FIT", val: `${avgFit}<span class="unit">%</span>`,
        sub: `<span class="kpi-delta up">▲ ${Math.max(0, avgFit - 55)}pp vs library</span>`, cls: "",
        spark: [45, 50, 55, 58, 65, avgFit] },
      { label: "TOP FIT", val: `${top}<span class="unit">%</span>`,
        sub: list[0] ? escapeHtml(list[0].title.slice(0, 18)) : "—", cls: "gold",
        spark: [70, 75, 80, 82, 85, top] },
      { label: "STRONG ≥70", val: `<em>${strong}</em>`,
        sub: `${list.length ? Math.round(strong / list.length * 100) : 0}% of view`, cls: "good",
        spark: [5, 8, 12, 18, 22, strong] },
      { label: "AVG HEAT", val: `<em>${avgHeat}</em>`, sub: "on 1-5 scale", cls: "blush",
        spark: [3.5, 3.8, 4.0, 4.1, 4.2, parseFloat(avgHeat)] }
    ];
    $(root, "#kpiStrip").innerHTML = cells.map(k => `
      <div class="kpi-cell ${k.cls}">
        <div class="kpi-cell-label">${k.label}</div>
        <div class="kpi-cell-val">${k.val}</div>
        <div class="kpi-cell-sub">${k.sub}</div>
        ${sparklineSVG(k.spark)}
      </div>`).join("");
  }

  // ---------- Heat × Explicit matrix ----------
  function renderHeatmap(root) {
    const list = filteredBooks();
    const grid = [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
    list.forEach(b => { grid[5 - b.heat][b.explicit - 1]++; });
    const max = Math.max(1, ...grid.flat());
    const rows = [];
    rows.push(`<div class="heatmap-row hdr"><div>H ↓ / E →</div>${[1,2,3,4,5].map(n => `<div>${n}</div>`).join("")}</div>`);
    for (let i = 0; i < 5; i++) {
      const heatLvl = 5 - i;
      const cells = [`<div class="heatmap-row-label">H${heatLvl}</div>`];
      for (let j = 0; j < 5; j++) {
        const v = grid[i][j];
        if (v === 0) {
          cells.push(`<div class="heatmap-cell empty" title="Heat ${heatLvl} · Explicit ${j+1}: no titles"></div>`);
        } else {
          const intensity = v / max;
          const alpha = 0.18 + intensity * 0.7;
          const color = `rgba(184,74,98,${alpha.toFixed(2)})`;
          const textColor = intensity > 0.55 ? "#fff" : "var(--text)";
          cells.push(`<div class="heatmap-cell" style="background:${color};color:${textColor};" title="Heat ${heatLvl} · Explicit ${j+1}: ${v} titles">${v}</div>`);
        }
      }
      rows.push(`<div class="heatmap-row">${cells.join("")}</div>`);
    }
    $(root, "#heatmap").innerHTML = rows.join("");
  }

  // ---------- Trope frequency bars ----------
  function renderTropeBar(root, rerender) {
    // Bars are drawn from the full catalog so rows stay clickable even
    // when a trope filter is already active. Counts reflect the
    // catalogue totals, not the filtered pool.
    const all = rawBooks();
    const counts = {};
    all.forEach(b => (b.trope || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(1, ...entries.map(e => e[1]));
    const el = $(root, "#tropeBar");
    el.innerHTML = entries.map(([name, n], i) => {
      const cls = i % 3 === 0 ? "" : i % 3 === 1 ? "sage" : "violet";
      const sel = termState.tropeFilter.has(name) ? " selected" : "";
      return `<div class="bar-row interactive${sel}" data-trope="${escapeHtml(name)}">
        <div class="bar-label" title="${escapeHtml(name)}">${escapeHtml(name.replace(/-/g, " "))}</div>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(n/max)*100}%"></div></div>
        <div class="bar-val">${n}</div>
      </div>`;
    }).join("") ||
      `<div style="font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--text-mute);font-size:12px;text-align:center;padding:10px;">No tropes in catalogue</div>`;
    el.querySelectorAll(".bar-row[data-trope]").forEach(row => {
      row.addEventListener("click", () => {
        const t = row.dataset.trope;
        if (termState.tropeFilter.has(t)) termState.tropeFilter.delete(t);
        else termState.tropeFilter.add(t);
        rerender();
      });
    });
  }

  // ---------- Publication-era bars (interactive filters) ----------
  function renderEraBar(root, rerender) {
    const all = rawBooks();
    const data = ERA_BUCKETS.map(b => ({
      label: b.label,
      n: all.filter(x => x.year && b.test(x.year)).length
    }));
    const max = Math.max(1, ...data.map(d => d.n));
    const el = $(root, "#eraBar");
    el.innerHTML = data.map(d => {
      const sel = termState.eraFilter.has(d.label) ? " selected" : "";
      return `<div class="bar-row interactive${sel}" data-era="${escapeHtml(d.label)}">
        <div class="bar-label">${escapeHtml(d.label)}</div>
        <div class="bar-track"><div class="bar-fill blush" style="width:${(d.n/max)*100}%"></div></div>
        <div class="bar-val">${d.n}</div>
      </div>`;
    }).join("");
    el.querySelectorAll(".bar-row[data-era]").forEach(row => {
      row.addEventListener("click", () => {
        const e = row.dataset.era;
        if (termState.eraFilter.has(e)) termState.eraFilter.delete(e);
        else termState.eraFilter.add(e);
        rerender();
      });
    });
  }

  // ---------- Radar SVG (compass + overlap) — verbatim ----------
  function renderRadar(svgEl, values, comparisonValues) {
    const axes = ["heat", "explicit", "emotion", "consent", "taboo", "plot"];
    const R = 85;
    const pts = axes.map((a, i) => {
      const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
      const r = (values[a] / 5) * R;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    });
    const axisLines = axes.map((a, i) => {
      const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
      const x = Math.cos(angle) * R, y = Math.sin(angle) * R;
      const lx = Math.cos(angle) * (R + 14), ly = Math.sin(angle) * (R + 14);
      return `<line class="compass-axis" x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>
              <text class="compass-label-text" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${a.toUpperCase().slice(0, 4)}</text>`;
    }).join("");
    const rings = [0.25, 0.5, 0.75, 1].map(r =>
      `<circle class="compass-ring" cx="0" cy="0" r="${r * R}"/>`).join("");
    const shape = `M ${pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")} Z`;
    let cmpShape = "";
    if (comparisonValues) {
      const cmpPts = axes.map((a, i) => {
        const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
        const r = (comparisonValues[a] / 5) * R;
        return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
      });
      const cmp = `M ${cmpPts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")} Z`;
      cmpShape = `<path d="${cmp}" fill="var(--gold-soft)" stroke="var(--gold)" stroke-width="1.2" stroke-dasharray="3 2" stroke-linejoin="round"/>`;
    }
    const points = pts.map(p =>
      `<circle class="compass-point" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5"/>`).join("");
    svgEl.innerHTML = rings + axisLines + cmpShape +
      `<path d="${shape}" class="compass-shape"/>` + points;
  }

  // ---------- Ticker — top fits, seamless loop via duplication ----------
  function renderTicker(root) {
    const list = filteredBooks();
    const top = list.slice(0, 12);
    const items = top.map(b => {
      const delta = Math.floor(Math.random() * 12 - 3);
      const sign = delta >= 0 ? "+" : "";
      const cls  = delta >= 0 ? "" : "neg";
      return `<span class="ticker-item">
        <span class="ticker-symbol">${initials(b.title) + initials(b.author)}</span>
        <span class="ticker-val">${b.fit}%</span>
        <span class="ticker-delta ${cls}">${sign}${delta}</span>
      </span>`;
    });
    const tickEl = $(root, "#ticker");
    if (!items.length) {
      tickEl.innerHTML = `<span class="ticker-item">Load a catalogue to light the ticker.</span>`;
      return;
    }
    tickEl.innerHTML = items.join("") + items.join("");
  }

  // ---------- Subgenre distribution footer ----------
  function renderDistribution(root, rerender) {
    const counts = {}, heatTotals = {};
    rawBooks().forEach(b => {
      counts[b.subgenre]    = (counts[b.subgenre] || 0) + 1;
      heatTotals[b.subgenre] = (heatTotals[b.subgenre] || 0) + b.heat;
    });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const body = $(root, "#distributionBody");
    body.innerHTML = entries.map(([name, count]) => {
      const avgHeat = (heatTotals[name] / count).toFixed(1);
      const active = termState.subgenreFilter === name;
      return `<div class="genre-tile ${active ? "filter-active" : ""}" data-genre="${escapeHtml(name)}">
        <div class="genre-tile-name">${escapeHtml(name)}</div>
        <div class="genre-tile-stats">
          <div class="genre-tile-count">${count}</div>
          <div class="genre-tile-avg">HEAT ${avgHeat}</div>
        </div>
      </div>`;
    }).join("");
    body.querySelectorAll(".genre-tile").forEach(t => {
      t.addEventListener("click", () => {
        const g = t.dataset.genre;
        termState.subgenreFilter = (termState.subgenreFilter === g) ? null : g;
        const sub = $(root, "#distSub");
        if (sub) sub.textContent = termState.subgenreFilter ? `filtered: ${termState.subgenreFilter}` : "click to filter";
        rerender();
      });
    });
  }

  // ---------- Catalogue grid — sortable, dense, click-to-select ----------
  function renderGrid(root, rerender) {
    const list = filteredBooks();
    const body = $(root, "#gridBody");
    body.innerHTML = list.map(b => {
      const fitCls = b.fit >= 75 ? "strong" : b.fit >= 55 ? "mid" : "low";
      const subg = b.subgenre || "—";
      const sig = [...(b.tone || []).slice(0, 1), ...(b.dynamic || []).slice(0, 1),
                   ...(b.trope || []).slice(0, 1)].slice(0, 2).map(s => s.replace(/-/g, " ")).join(" · ");
      return `<tr data-id="${escapeHtml(b.id)}" class="${termState.selectedId === b.id ? "selected" : ""}">
        <td class="fit-col ${fitCls}" title="Fit: ${b.fit}% · Confidence: ${b.confidence}%">
          ${b.fit}
          <div class="mini-bar" style="margin-top:2px;"><div class="mini-bar-fill" style="width:${b.fit}%"></div></div>
        </td>
        <td class="title-col"  title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</td>
        <td class="author-col" title="${escapeHtml(b.author)}">${escapeHtml(b.author)}</td>
        <td class="num-col">${b.year || "—"}</td>
        <td class="sub-col" title="${escapeHtml(subg)}">${escapeHtml(subg)}</td>
        <td class="num-col"><span class="rate-pill ${rateClass(b.heat)}">${b.heat}</span></td>
        <td class="num-col"><span class="rate-pill ${rateClass(b.explicit)}">${b.explicit}</span></td>
        <td class="num-col"><span class="rate-pill ${rateClass(b.emotion)}">${b.emotion}</span></td>
        <td class="num-col"><span class="rate-pill ${rateClass(b.consent)}">${b.consent}</span></td>
        <td class="num-col"><span class="rate-pill ${rateClass(b.taboo)}">${b.taboo}</span></td>
        <td class="num-col"><span class="rate-pill ${rateClass(b.plot)}">${b.plot}</span></td>
        <td class="sub-col" style="color:var(--accent-deep);font-style:italic;font-family:'Cormorant Garamond',serif;font-size:12px;">${escapeHtml(sig) || "—"}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="12" style="padding:30px;text-align:center;color:var(--text-mute);font-family:'Cormorant Garamond',serif;font-style:italic;">No titles match current filters</td></tr>`;

    body.querySelectorAll("tr[data-id]").forEach(row => {
      row.addEventListener("click", () => {
        termState.selectedId = row.dataset.id;
        rerender();
      });
    });

    const countEl = $(root, "#gridCount");
    if (countEl) countEl.textContent = list.length;
    root.querySelectorAll("#dataGrid thead th").forEach(th => {
      th.classList.remove("sorted", "asc");
      if (th.dataset.sort === termState.sortKey) {
        th.classList.add("sorted");
        if (termState.sortDir === "asc") th.classList.add("asc");
      }
    });
  }

  // ---------- Detail panel — selected book ----------
  function renderDetail(root) {
    const all = rawBooks();
    const book = all.find(b => b.id === termState.selectedId) || all[0];
    if (!book) return;
    termState.selectedId = book.id;
    const scored = Object.assign({}, book, scoreBook(book));

    $(root, "#detailTitle").textContent  = book.title;
    $(root, "#detailAuthor").textContent = `${book.author} · ${book.year || "n.d."}`;
    const coverEl = $(root, "#detailCover");
    coverEl.querySelectorAll("img").forEach(i => i.remove());
    if (book.cover_url) {
      const img = document.createElement("img");
      img.src = book.cover_url;
      img.onerror = () => img.remove();
      coverEl.insertBefore(img, coverEl.firstChild);
    }
    const fitEl = $(root, "#detFit");
    fitEl.textContent = scored.fit + "%";
    fitEl.className = "detail-fit-val " + (scored.fit >= 70 ? "sage" : scored.fit >= 50 ? "" : "warn");
    $(root, "#detConf").textContent = scored.confidence + "%";
    $(root, "#detailSummary").textContent = book.short_summary || book.fit_notes || "";

    $(root, "#detailKV").innerHTML = `
      <dt>Subgenre</dt><dd>${escapeHtml(book.subgenre || "—")}</dd>
      <dt>Series</dt><dd>${book.series ? escapeHtml(book.series) : `<span style="font-style:italic;color:var(--text-mute);">standalone</span>`}</dd>
      <dt>Published</dt><dd>${book.year || "—"}</dd>
      <dt>Pairing</dt><dd>${(book.orientation || []).map(o => escapeHtml(o.replace(/-/g, " "))).join(", ") || "—"}</dd>
    `;

    renderRadar($(root, "#detailRadar"), termState.profile, book);

    const sigTags = [
      ...(book.tone    || []).map(t => ({ text: t, cls: "" })),
      ...(book.dynamic || []).map(t => ({ text: t, cls: "gold" })),
      ...(book.trope   || []).map(t => ({ text: t, cls: "" })),
      ...(book.kink    || []).map(t => ({ text: t, cls: "" }))
    ];
    $(root, "#detailTags").innerHTML = sigTags.length
      ? sigTags.map(t => `<span class="detail-tag ${t.cls}">${escapeHtml(t.text.replace(/-/g, " "))}</span>`).join("")
      : `<span style="font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--text-mute);">no tagged signals</span>`;

    const warnings = book.warnings || [];
    $(root, "#detailWarnings").innerHTML = warnings.length
      ? warnings.map(w => `<span class="detail-tag warn">${escapeHtml(w)}</span>`).join("")
      : `<span style="font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--sage);font-size:11px;">no warnings flagged</span>`;
  }

  // ---------- Similar — top-5 by signal overlap with selected ----------
  function renderSimilar(root, rerender) {
    const all = rawBooks();
    const base = all.find(b => b.id === termState.selectedId);
    const list = $(root, "#similarList");
    if (!base) {
      list.innerHTML = `<div style="font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--text-mute);text-align:center;padding:14px 0;font-size:12px;">select a title above</div>`;
      return;
    }
    const scored = all.filter(b => b.id !== base.id).map(b => {
      let overlap = 0;
      overlap += new Set(base.tone).size    && b.tone    ? b.tone.filter(x => base.tone.includes(x)).length    * 3 : 0;
      overlap += new Set(base.dynamic).size && b.dynamic ? b.dynamic.filter(x => base.dynamic.includes(x)).length * 4 : 0;
      overlap += new Set(base.trope).size   && b.trope   ? b.trope.filter(x => base.trope.includes(x)).length   * 5 : 0;
      overlap += new Set(base.kink).size    && b.kink    ? b.kink.filter(x => base.kink.includes(x)).length    * 2 : 0;
      if (b.subgenre === base.subgenre) overlap += 4;
      overlap -= Math.abs(b.heat - base.heat) + Math.abs(b.plot - base.plot);
      return { b, overlap };
    }).sort((x, y) => y.overlap - x.overlap).slice(0, 5);

    list.innerHTML = scored.map(({ b, overlap }) => {
      const pct = Math.max(30, Math.min(95, 40 + overlap * 4));
      return `<div class="similar-item" data-id="${escapeHtml(b.id)}">
        ${b.cover_url ? `<img class="similar-item-cover" src="${escapeHtml(b.cover_url)}" onerror="this.style.display='none'"/>` : `<div class="similar-item-cover"></div>`}
        <div style="min-width:0;">
          <div class="similar-item-title">${escapeHtml(b.title)}</div>
          <div class="similar-item-author">${escapeHtml(b.author)}</div>
        </div>
        <div class="similar-item-score">${pct}%</div>
      </div>`;
    }).join("");
    list.querySelectorAll(".similar-item").forEach(el => {
      el.addEventListener("click", () => {
        termState.selectedId = el.dataset.id;
        rerender();
      });
    });
  }

  // ---------- Editor's brief — 4-tier insight by strong-fit count ----------
  function renderInsight(root) {
    const list = filteredBooks();
    const strong = list.filter(b => b.fit >= 70).length;
    const topGenre = (() => {
      const sums = {};
      list.filter(b => b.fit >= 60).forEach(b => { sums[b.subgenre] = (sums[b.subgenre] || 0) + 1; });
      return Object.entries(sums).sort((a, b) => b[1] - a[1])[0]?.[0] || "Erotic Romance";
    })();
    const mainTone = [...termState.profile.tone][0] || "balanced";
    let headline, body;
    if (strong >= 20) {
      headline = `Her compass is <em>richly served</em>.`;
      body = `${strong} titles score above 70% — the library has strong depth in her preferred territory. Top subgenre for her: ${escapeHtml(topGenre)}.`;
    } else if (strong >= 8) {
      headline = `A <em>specialist's</em> taste.`;
      body = `${strong} titles meet her threshold. She's looking for specific signals — lean into ${escapeHtml(topGenre)} and the ${escapeHtml(mainTone)} tone range.`;
    } else if (strong > 0) {
      headline = `A <em>particular</em> reader.`;
      body = `Only ${strong} titles score above 70%. Suggest widening tone filters or softening the consent floor by one step to expand the pool.`;
    } else {
      headline = `An <em>unmet</em> signature.`;
      body = `No titles currently clear 70% fit. Try relaxing taboo tolerance or clearing tone filters — the catalogue is rich but narrow on her exact compass.`;
    }
    $(root, "#insightTitle").innerHTML = headline;
    $(root, "#insightBody").textContent = body;
  }

  // ---------- Chip filters (tone + dynamic) ----------
  const TONE_OPTIONS = ["dark", "intense", "obsessive", "sensual", "tender", "lyrical", "wry", "reflective", "transgressive", "playful"];
  const DYN_OPTIONS  = ["dominance-submission", "power-exchange", "forbidden", "enemies-to-lovers", "marriage", "reverse-harem", "fated-mates", "second-chance", "courtship", "mutual-longing"];

  function renderChips(root, rerender) {
    const renderOne = (containerId, options, key) => {
      const c = $(root, "#" + containerId);
      c.innerHTML = options.map(o => {
        const active = termState.profile[key].has(o);
        return `<span class="chip ${active ? "active" : ""}" data-tag="${escapeHtml(o)}" data-key="${key}">${escapeHtml(o.replace(/-/g, " "))}</span>`;
      }).join("");
      c.querySelectorAll(".chip").forEach(chip => {
        chip.addEventListener("click", () => {
          const tag = chip.dataset.tag, k = chip.dataset.key;
          if (termState.profile[k].has(tag)) termState.profile[k].delete(tag);
          else termState.profile[k].add(tag);
          rerender();
        });
      });
    };
    renderOne("toneChips",    TONE_OPTIONS, "tone");
    renderOne("dynamicChips", DYN_OPTIONS,  "dynamic");
  }

  // ---------- Toast + system clock ----------
  function showToast(root, msg) {
    const t = $(root, "#toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove("show"), 1800);
  }
  function clockText() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function startClock(root) {
    if (startClock._id) clearInterval(startClock._id);
    startClock._id = setInterval(() => {
      const n = $(root, "#sysTime");
      if (!n || !document.body.contains(n)) { clearInterval(startClock._id); startClock._id = null; return; }
      n.textContent = clockText();
    }, 1000);
  }

  // ---------- Catalogue grid ↔ Selected Title height sync ----------
  // Pegs the grid-scroll's bottom to the detail panel's bottom so
  // the two cards align visually. The grid's scroll area grows or
  // shrinks to whatever space is between its own top and the detail
  // card's bottom. Tears down when the terminal wrap leaves the DOM.
  function syncGridToDetail(root) {
    const detail = $(root, ".detail-panel");
    const scroll = $(root, ".grid-scroll");
    if (!detail || !scroll) return;
    if (syncGridToDetail._ro) syncGridToDetail._ro.disconnect();
    if (syncGridToDetail._onResize) window.removeEventListener("resize", syncGridToDetail._onResize);
    const sync = () => {
      if (!document.body.contains(scroll)) {
        if (syncGridToDetail._ro) { syncGridToDetail._ro.disconnect(); syncGridToDetail._ro = null; }
        if (syncGridToDetail._onResize) { window.removeEventListener("resize", syncGridToDetail._onResize); syncGridToDetail._onResize = null; }
        return;
      }
      const detailBottom = detail.getBoundingClientRect().bottom;
      const scrollTop = scroll.getBoundingClientRect().top;
      const available = Math.max(0, Math.round(detailBottom - scrollTop));
      scroll.style.maxHeight = available + "px";
    };
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(sync);
      ro.observe(detail);
      syncGridToDetail._ro = ro;
    }
    syncGridToDetail._onResize = sync;
    window.addEventListener("resize", sync);
  }

  // ---------- Init: seed termState.profile from Lumen on first mount ----------
  function initFromLumen() {
    if (termState._seededFromLumen) return;
    const L = window.Lumen;
    const lp = L && L.store && L.store.get && L.store.get().profile;
    if (lp) {
      ["heat", "explicit", "emotion", "consent", "taboo", "plot"].forEach(k => {
        if (typeof lp[k] === "number") termState.profile[k] = clamp1to5(lp[k]);
      });
    }
    termState._seededFromLumen = true;
  }

  // ============================================================
  // DASHBOARD MARKUP — mirrors lumen_terminal.html one-for-one.
  // Empty containers receive innerHTML from the populators.
  // ============================================================
  function dashboardHTML() {
    const sliders = ["heat", "explicit", "emotion", "consent", "taboo", "plot"];
    const sliderRows = sliders.map(k => `
      <div class="slider-mini">
        <div class="slider-mini-label">${k === "consent" ? "Consent ≥" : k.charAt(0).toUpperCase() + k.slice(1)}</div>
        <input type="range" id="s_${k}" min="1" max="5" value="${termState.profile[k]}">
        <div class="slider-mini-val" id="v_${k}">${termState.profile[k]}</div>
      </div>`).join("");
    return `
<div class="wrap">
  <header class="command-bar">
    <div class="brand">
      <div class="brand-mark">Lumen</div>
      <div class="brand-sub">TERMINAL</div>
      <div class="brand-divider"></div>
      <div class="brand-mode">Editorial analytics for discerning readers</div>
    </div>
    <div class="ticker-wrap"><div class="ticker" id="ticker"></div></div>
    <div class="theme-switcher" id="themeSwitcher">
      <div class="theme-dot" data-theme="rose"      title="Rose Atelier"></div>
      <div class="theme-dot" data-theme="plum"      title="Midnight Plum"></div>
      <div class="theme-dot" data-theme="pearl"     title="Pearl &amp; Gold"></div>
      <div class="theme-dot" data-theme="botanical" title="Botanical Dusk"></div>
    </div>
    <div class="sys-status">
      <span class="live-dot"></span>
      <span id="sysTime">—</span>
      <span style="color:var(--border-strong);">·</span>
      <span id="sysCount">${rawBooks().length} titles</span>
    </div>
  </header>

  <div class="dashboard">
    <aside class="left-col">
      <div class="panel profile-panel">
        <div class="panel-head"><span class="panel-title">Your Compass</span><span class="panel-sub">her taste</span></div>
        <div class="panel-body">
          <div class="taste-compass">
            <div class="compass-label">Profile radar</div>
            <svg class="compass-svg" id="userRadar" viewBox="-110 -110 220 220"></svg>
          </div>
          ${sliderRows}
          <div class="filter-section">
            <div class="filter-section-label">Tone filter</div>
            <div class="chip-row" id="toneChips"></div>
          </div>
          <div class="filter-section">
            <div class="filter-section-label">Dynamic filter</div>
            <div class="chip-row" id="dynamicChips"></div>
          </div>
        </div>
      </div>
    </aside>

    <main class="centre-col">
      <div class="kpi-strip" id="kpiStrip"></div>
      <div class="charts-row charts-row-2col">
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Trope frequency</span><span class="panel-sub">top signals</span></div>
          <div class="barchart" id="tropeBar"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Publication era</span><span class="panel-sub">across time</span></div>
          <div class="barchart" id="eraBar"></div>
        </div>
      </div>
      <div class="panel grid-panel">
        <div class="panel-head"><span class="panel-title">Catalogue Grid</span><span class="panel-sub">every title, every signal</span></div>
        <div class="grid-controls">
          <input type="text" class="search-input" id="searchInput" placeholder="/ search title, author, trope…" value="${escapeHtml(termState.search)}" />
          <div class="grid-count"><em id="gridCount">0</em> SHOWING</div>
        </div>
        <div class="grid-scroll">
          <table class="data-grid" id="dataGrid">
            <thead><tr>
              <th data-sort="fit"      class="sorted">Fit</th>
              <th data-sort="title">Title</th>
              <th data-sort="author">Author</th>
              <th data-sort="year">Year</th>
              <th data-sort="subgenre">Subgenre</th>
              <th data-sort="heat"     title="Heat">H</th>
              <th data-sort="explicit" title="Explicit">E</th>
              <th data-sort="emotion"  title="Emotion">M</th>
              <th data-sort="consent"  title="Consent">C</th>
              <th data-sort="taboo"    title="Taboo">T</th>
              <th data-sort="plot"     title="Plot">P</th>
              <th>Signals</th>
            </tr></thead>
            <tbody id="gridBody"></tbody>
          </table>
        </div>
      </div>
    </main>

    <aside class="right-col">
      <div class="panel detail-panel">
        <div class="panel-body flush">
          <div class="detail-cover" id="detailCover">
            <div class="detail-cover-meta">
              <div class="detail-title" id="detailTitle">Select a title</div>
              <div class="detail-author" id="detailAuthor">from the grid</div>
            </div>
          </div>
          <div class="detail-content" id="detailContent">
            <div class="detail-fit-strip">
              <div class="detail-fit-cell"><div class="detail-fit-label">Fit for her</div><div class="detail-fit-val" id="detFit">—</div></div>
              <div class="detail-fit-cell"><div class="detail-fit-label">Confidence</div><div class="detail-fit-val sage" id="detConf">—</div></div>
            </div>
            <div class="detail-radar-wrap">
              <div class="detail-radar-title">Overlap</div>
              <div class="detail-radar-sub">her profile vs this title</div>
              <svg class="compass-svg" id="detailRadar" viewBox="-95 -95 190 190" style="height:160px;"></svg>
            </div>
            <div class="detail-summary" id="detailSummary">Choose a title from the grid to see its profile, signal overlap with yours, and editorial notes.</div>
            <dl class="detail-kv" id="detailKV"></dl>
            <div class="filter-section-label" style="margin-bottom:6px;">Signals</div>
            <div class="detail-tags" id="detailTags"></div>
            <div class="filter-section-label" style="margin-bottom:6px;">Advisory flags</div>
            <div class="detail-tags" id="detailWarnings"></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><span class="panel-title">Similar to this</span><span class="panel-sub">by signal overlap</span></div>
        <div class="panel-body compact" id="similarList">
          <div style="font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--text-mute);text-align:center;padding:14px 0;font-size:12px;">select a title above</div>
        </div>
      </div>

      <div class="insight">
        <div class="insight-label">Editor's brief</div>
        <div class="insight-title" id="insightTitle">Your <em>signature</em> lands here.</div>
        <div class="insight-body" id="insightBody">Your current compass favours emotionally-weighted narratives with moderate heat.</div>
      </div>
    </aside>
  </div>

  <div class="footer-strip">
    <div class="distribution-panel">
      <div class="distribution-head">
        <span class="panel-title">Subgenre distribution</span>
        <span class="panel-sub" id="distSub">${termState.subgenreFilter ? `filtered: ${escapeHtml(termState.subgenreFilter)}` : "click to filter"}</span>
      </div>
      <div class="distribution-body" id="distributionBody"></div>
    </div>
  </div>

  <div id="toast"></div>
</div>`;
  }

  // ============================================================
  // RENDER — build the dashboard, run all populators, wire events.
  // ============================================================
  function render() {
    initFromLumen();
    const wrap = document.createElement("div");
    wrap.className = "page lumen-terminal";
    wrap.innerHTML = dashboardHTML();

    function rerender() {
      const fresh = render();
      wrap.replaceWith(fresh);
    }

    // Mark active theme dot from the live body class
    const bodyTheme = (document.body.className.match(/theme-(\w+)/) || [])[1] || "rose";
    wrap.querySelectorAll(".theme-dot").forEach(d =>
      d.classList.toggle("active", d.dataset.theme === bodyTheme));

    // Run populators
    renderRadar($(wrap, "#userRadar"), termState.profile);
    renderKPIs(wrap);
    renderTropeBar(wrap, rerender);
    renderEraBar(wrap, rerender);
    renderTicker(wrap);
    renderChips(wrap, rerender);
    renderGrid(wrap, rerender);
    renderDistribution(wrap, rerender);
    renderDetail(wrap);
    renderSimilar(wrap, rerender);
    renderInsight(wrap);

    // Sliders — live readout, re-render on release; mirror to Lumen.store.
    ["heat", "explicit", "emotion", "consent", "taboo", "plot"].forEach(k => {
      const s = $(wrap, "#s_" + k), v = $(wrap, "#v_" + k);
      s.addEventListener("input", () => {
        const n = parseInt(s.value, 10);
        v.textContent = String(n);
        termState.profile[k] = n;
        const L = window.Lumen;
        if (L && L.store && L.store.update) L.store.update(st => { if (st.profile) st.profile[k] = n; });
      });
      s.addEventListener("change", rerender);
    });

    // Search input — re-render dependent panels only.
    $(wrap, "#searchInput").addEventListener("input", e => {
      termState.search = e.target.value;
      renderKPIs(wrap); renderGrid(wrap, rerender); renderInsight(wrap);
      renderTropeBar(wrap, rerender); renderEraBar(wrap, rerender);
    });

    // Sortable headers
    wrap.querySelectorAll("#dataGrid thead th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (termState.sortKey === k) termState.sortDir = termState.sortDir === "asc" ? "desc" : "asc";
        else { termState.sortKey = k; termState.sortDir = (k === "title" || k === "author" || k === "subgenre") ? "asc" : "desc"; }
        renderGrid(wrap, rerender);
      });
    });

    // Theme dots — mutate body theme class + toast.
    wrap.querySelectorAll(".theme-dot").forEach(d => {
      d.addEventListener("click", () => {
        const t = d.dataset.theme;
        document.body.className = document.body.className.replace(/\btheme-\w+/g, "").trim() + " theme-" + t;
        wrap.querySelectorAll(".theme-dot").forEach(x => x.classList.toggle("active", x === d));
        showToast(wrap, `Theme: ${t.charAt(0).toUpperCase() + t.slice(1)}`);
      });
    });

    // Clock — start once the wrap is in the document.
    setTimeout(() => { startClock(wrap); $(wrap, "#sysTime").textContent = clockText(); }, 0);

    // Peg the Catalogue Grid's bottom to the Selected Title card's
    // bottom so the two cards align. Run after the wrap is in the
    // DOM, observe the detail panel for resize, and re-run on viewport
    // resize. Self-cleans when the wrap leaves the document.
    setTimeout(() => syncGridToDetail(wrap), 0);

    return wrap;
  }

  window.LumenTerminal = {
    render,
    _state:    termState,
    _shape:    toTerminalShape,
    _raw:      rawBooks,
    _filtered: filteredBooks,
    _score:    scoreBook,
    _populators: {
      kpis: renderKPIs, heatmap: renderHeatmap, tropes: renderTropeBar,
      era:  renderEraBar, radar: renderRadar, ticker: renderTicker,
      distribution: renderDistribution, grid: renderGrid
    }
  };
})();
