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
  function renderTropeBar(root) {
    const list = filteredBooks();
    const counts = {};
    list.forEach(b => (b.trope || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(1, ...entries.map(e => e[1]));
    const html = entries.map(([name, n], i) => {
      const cls = i % 3 === 0 ? "" : i % 3 === 1 ? "sage" : "violet";
      return `<div class="bar-row">
        <div class="bar-label" title="${escapeHtml(name)}">${escapeHtml(name.replace(/-/g, " "))}</div>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(n/max)*100}%"></div></div>
        <div class="bar-val">${n}</div>
      </div>`;
    }).join("");
    $(root, "#tropeBar").innerHTML = html ||
      `<div style="font-family:'Cormorant Garamond',serif;font-style:italic;color:var(--text-mute);font-size:12px;text-align:center;padding:10px;">No data in current filter</div>`;
  }

  // ---------- Publication-era bars ----------
  function renderEraBar(root) {
    const list = filteredBooks();
    const buckets = [
      { label: "Pre-1950",  test: y => y > 0 && y < 1950 },
      { label: "1950-1999", test: y => y >= 1950 && y < 2000 },
      { label: "2000-2009", test: y => y >= 2000 && y < 2010 },
      { label: "2010-2014", test: y => y >= 2010 && y < 2015 },
      { label: "2015-2019", test: y => y >= 2015 && y < 2020 },
      { label: "2020+",     test: y => y >= 2020 }
    ];
    const data = buckets.map(b => ({ label: b.label, n: list.filter(x => x.year && b.test(x.year)).length }));
    const max = Math.max(1, ...data.map(d => d.n));
    $(root, "#eraBar").innerHTML = data.map(d => `<div class="bar-row">
      <div class="bar-label">${escapeHtml(d.label)}</div>
      <div class="bar-track"><div class="bar-fill blush" style="width:${(d.n/max)*100}%"></div></div>
      <div class="bar-val">${d.n}</div>
    </div>`).join("");
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

  // ============================================================
  // PLACEHOLDER render() — keeps the tab alive while subsequent
  // chunks (command bar template, dashboard scaffold, event
  // wiring, detail/similar/insight) are written.
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
    _score:    scoreBook,
    _populators: {
      kpis: renderKPIs, heatmap: renderHeatmap, tropes: renderTropeBar,
      era:  renderEraBar, radar: renderRadar, ticker: renderTicker,
      distribution: renderDistribution, grid: renderGrid
    }
  };
})();
