/* ============================================================
   Lumen — Application (Batch 1)
   Modules: util, store, router, ui, views/*
   All state is local. No network calls.
   ============================================================ */
(function () {
  "use strict";

  const { BOOKS, VOCAB, SCENARIOS, DEFAULT_WEIGHTS, DEFAULT_PROFILE, READING_STATES, ALL_WARNINGS } = window.LumenData;
  const Engine = window.LumenEngine;

  /* -------------------- util -------------------- */
  const util = {
    id: (prefix = "id") => prefix + "_" + Math.random().toString(36).slice(2, 9),
    fmtYear: (y) => (y < 0 ? `${Math.abs(y)} BCE` : `${y}`),
    humanise: (s) => (s || "").replace(/[-_]/g, " "),
    clamp: (n, min, max) => Math.min(max, Math.max(min, n)),
    debounce: (fn, ms = 150) => {
      let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    },
    el: (tag, attrs = {}, children = []) => {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class")      node.className = v;
        else if (k === "html")  node.innerHTML = v;
        else if (k === "text")  node.textContent = v;
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "data" && typeof v === "object") {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
        }
        else node.setAttribute(k, v === true ? "" : v);
      }
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
      return node;
    }
  };

  /* -------------------- store -------------------- */
  const STORAGE_KEY = "lumen:v1";
  const SCHEMA_VERSION = 1;

  function initialState() {
    return {
      schema: SCHEMA_VERSION,
      profile: structuredClone(DEFAULT_PROFILE),
      weights: { ...DEFAULT_WEIGHTS },
      bookStates: {},
      tags: {},
      journal: [],
      vault: { pinned: [], analyses: [], notes: [], locked: false, passcodeHash: null },
      chats: { sara: [], friends: [] },
      ui: {
        theme: "light",
        discreet: false,
        onboardingDone: false,
        adultConfirmed: false,
        activeScenarioId: null
      }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return initialState();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schema !== SCHEMA_VERSION) return initialState();
      return Object.assign(initialState(), parsed);
    } catch (e) {
      return initialState();
    }
  }

  const store = (function () {
    let state = loadState();
    const subs = new Set();
    const persist = util.debounce(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
    }, 180);

    function emit() { subs.forEach(fn => fn(state)); persist(); }

    return {
      get: () => state,
      set(patch) {
        state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
        emit();
      },
      update(fn) {
        fn(state);
        emit();
      },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      reset() { state = initialState(); emit(); }
    };
  })();

  /* -------------------- ui helpers -------------------- */
  const ui = {
    toast(message, { action, onAction, duration = 2600 } = {}) {
      let host = document.getElementById("toast-host");
      if (!host) {
        host = util.el("div", { id: "toast-host", class: "toast-host", "aria-live": "polite" });
        document.body.appendChild(host);
      }
      const node = util.el("div", { class: "toast", role: "status" }, message);
      if (action) {
        const a = util.el("button", { class: "toast-action", onclick: () => { onAction && onAction(); node.remove(); } }, action);
        node.appendChild(a);
      }
      host.appendChild(node);
      requestAnimationFrame(() => node.classList.add("in"));
      setTimeout(() => { node.classList.remove("in"); setTimeout(() => node.remove(), 220); }, duration);
    },

    modal({ title, body, primary, secondary }) {
      let host = document.getElementById("modal-host");
      if (!host) {
        host = util.el("div", { id: "modal-host", class: "modal-host", role: "dialog", "aria-modal": "true" });
        document.body.appendChild(host);
      }
      host.innerHTML = "";
      const close = () => { host.classList.remove("open"); setTimeout(() => (host.innerHTML = ""), 220); };

      const modal = util.el("div", { class: "modal" });
      modal.appendChild(util.el("div", { class: "modal-head" }, [
        util.el("h3", { text: title || "" }),
        util.el("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, "×")
      ]));
      const bodyNode = util.el("div");
      if (typeof body === "string") bodyNode.innerHTML = body;
      else if (body) bodyNode.appendChild(body);
      modal.appendChild(bodyNode);

      const actions = util.el("div", { class: "modal-actions" });
      if (secondary) actions.appendChild(util.el("button", { class: "btn btn-ghost", onclick: () => { secondary.onClick?.(); close(); } }, secondary.label));
      if (primary)   actions.appendChild(util.el("button", { class: "btn btn-primary", onclick: () => { primary.onClick?.(); close(); } }, primary.label));
      if (primary || secondary) modal.appendChild(actions);

      host.appendChild(modal);
      host.classList.add("open");
      host.addEventListener("click", (e) => { if (e.target === host) close(); }, { once: true });
      return { close };
    },

    chip(label, { pressed = false, exclude = false, onToggle } = {}) {
      const btn = util.el("button", {
        class: "chip" + (exclude ? " chip-exclude" : ""),
        "aria-pressed": pressed ? "true" : "false",
        type: "button",
        onclick: () => {
          const next = btn.getAttribute("aria-pressed") !== "true";
          btn.setAttribute("aria-pressed", next ? "true" : "false");
          onToggle && onToggle(next);
        }
      }, util.humanise(label));
      return btn;
    },

    empty({ title, message, actions = [] }) {
      const node = util.el("div", { class: "empty" }, [
        util.el("h3", { text: title }),
        util.el("p", { text: message })
      ]);
      if (actions.length) {
        const group = util.el("div", { class: "empty-actions" },
          actions.map(a => util.el("button", { class: `btn ${a.variant || "btn-ghost"}`, onclick: a.onClick }, a.label))
        );
        node.appendChild(group);
      }
      return node;
    },

    skeleton({ lines = 3, block = false } = {}) {
      const wrap = util.el("div");
      if (block) wrap.appendChild(util.el("div", { class: "skeleton skeleton-block" }));
      for (let i = 0; i < lines; i++) {
        wrap.appendChild(util.el("div", {
          class: "skeleton skeleton-line" + (i === 0 ? " lg" : ""),
          style: { width: `${70 + Math.random() * 25}%` }
        }));
      }
      return wrap;
    },

    tag(label, variant) {
      const cls = "tag" + (variant ? ` tag-${variant}` : "");
      return util.el("span", { class: cls }, util.humanise(label));
    }
  };

  /* -------------------- router -------------------- */
  const ROUTES = [
    { id: "discover",     label: "Home",          short: "Home",    group: "main",    render: () => views.discover() },
    { id: "library",      label: "Library",       short: "Library", group: "main",    render: () => views.library() },
    { id: "compare",      label: "Compare",       short: "Compare", group: "main",    render: () => views.compare() },
    { id: "chat",         label: "Chat",          short: "Chat",    group: "main",    render: () => views.chat() },
    { id: "journal",      label: "Journal",       short: "Journal", group: "personal", render: () => views.journal() },
    { id: "vault",        label: "Vault",         short: "Vault",   group: "personal", render: () => views.vault() },
    { id: "profile",      label: "Profile",       short: "Profile", group: "settings", render: () => views.profile() },
    { id: "transparency", label: "Transparency",  short: "Trust",   group: "settings", render: () => views.transparency() }
  ];

  const router = {
    current() {
      const hash = location.hash.replace(/^#\/?/, "");
      return ROUTES.find(r => r.id === hash) || ROUTES[0];
    },
    go(id) { location.hash = `#/${id}`; }
  };

  /* -------------------- view helpers -------------------- */
  function bookCardMini(scored, onClick) {
    const { book, fitScore, confidence, why } = scored;
    const card = util.el("a", {
      class: "card card-raised",
      href: "#",
      style: { display: "block", textDecoration: "none", color: "inherit" },
      onclick: (e) => { e.preventDefault(); onClick && onClick(scored); }
    });
    card.appendChild(util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
      util.el("div", { style: { minWidth: 0 } }, [
        util.el("div", { class: "t-eyebrow", text: util.humanise(book.subgenre || "") }),
        util.el("h3", { class: "t-serif", text: book.title, style: { marginTop: "2px" } }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: `${book.author} · ${util.fmtYear(book.year)}` })
      ]),
      util.el("div", { style: { textAlign: "right", flexShrink: "0" } }, [
        util.el("div", { class: "t-mono", style: { fontSize: "22px", color: "var(--accent)" }, text: `${fitScore}` }),
        util.el("div", { class: "t-tiny t-subtle", text: `${confidence}% conf.` })
      ])
    ]));
    card.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-3)", display: "-webkit-box", WebkitLineClamp: "3", WebkitBoxOrient: "vertical", overflow: "hidden" }, text: book.description }));
    if (why.reasons.length) {
      card.appendChild(util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-3)" } },
        why.reasons.slice(0, 2).map(r => ui.tag(r, "accent"))
      ));
    }
    return card;
  }

  function numericSlider(key, label, help) {
    const state = store.get();
    const row = util.el("div", { class: "field" });
    row.appendChild(util.el("div", { class: "field-row" }, [
      util.el("label", { class: "field-label", for: `prof_${key}`, text: label }),
      util.el("span", { class: "slider-value", id: `prof_${key}_val`, text: String(state.profile[key]) })
    ]));
    const input = util.el("input", {
      class: "slider",
      id: `prof_${key}`,
      type: "range", min: "1", max: "5", step: "1",
      value: String(state.profile[key]),
      oninput: (e) => {
        const v = parseInt(e.target.value, 10);
        store.update(s => { s.profile[key] = v; });
        document.getElementById(`prof_${key}_val`).textContent = String(v);
        refreshProfilePreview();
      }
    });
    row.appendChild(input);
    if (help) row.appendChild(util.el("div", { class: "field-help", text: help }));
    return row;
  }

  function chipGroup(key, label, vocab, { exclude = false, help } = {}) {
    const state = store.get();
    const wrap = util.el("div", { class: "field" });
    wrap.appendChild(util.el("div", { class: "field-label", text: label }));
    const row = util.el("div", { class: "row-wrap" });
    vocab.forEach(v => {
      const pressed = state.profile[key].includes(v);
      row.appendChild(ui.chip(v, {
        pressed, exclude,
        onToggle: (on) => {
          store.update(s => {
            const list = s.profile[key];
            if (on && !list.includes(v)) list.push(v);
            else if (!on) s.profile[key] = list.filter(x => x !== v);
          });
          refreshProfilePreview();
        }
      }));
    });
    wrap.appendChild(row);
    if (help) wrap.appendChild(util.el("div", { class: "field-help", text: help }));
    return wrap;
  }

  function segmented(key, options, onChange) {
    const state = store.get();
    const current = state.profile[key];
    const wrap = util.el("div", { class: "segmented", role: "group" });
    options.forEach(opt => {
      const btn = util.el("button", {
        type: "button",
        "aria-pressed": current === opt.value ? "true" : "false",
        onclick: () => {
          store.update(s => { s.profile[key] = opt.value; });
          wrap.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.val === opt.value ? "true" : "false"));
          onChange && onChange(opt.value);
          refreshProfilePreview();
        },
        "data-val": opt.value
      }, opt.label);
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function refreshProfilePreview() {
    const host = document.getElementById("profile-preview");
    if (!host) return;
    host.innerHTML = "";
    const s = store.get();
    const result = Engine.rankRecommendations(s.profile, s.weights);
    const top = result.scored.slice(0, 3);
    host.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Live preview" }),
      util.el("span", { class: "card-sub t-subtle", text: `${result.matched} of ${result.screened} pass your filters` })
    ]));
    if (!top.length) {
      host.appendChild(ui.empty({ title: "No matches yet", message: "Loosen an exclusion or warning strictness." }));
      return;
    }
    const list = util.el("div", { class: "stack-sm" });
    top.forEach(sc => {
      list.appendChild(util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline", padding: "var(--s-3) 0", borderBottom: "1px solid var(--border)" } }, [
        util.el("div", {}, [
          util.el("div", { class: "t-serif", style: { fontSize: "15px" }, text: sc.book.title }),
          util.el("div", { class: "t-tiny t-subtle", text: sc.book.author })
        ]),
        util.el("div", { class: "t-mono", style: { color: "var(--accent)" }, text: `${sc.fitScore}` })
      ]));
    });
    host.appendChild(list);
  }

  /* -------------------- library -------------------- */
  const libState = {
    query: "",
    readingFilter: "all",
    category: "all",
    sort: "fit",
    minFit: 0
  };

  function setReadingState(bookId, state) {
    store.update(s => {
      if (state === "none") delete s.bookStates[bookId];
      else s.bookStates[bookId] = state;
    });
  }

  function getReadingState(bookId) {
    return store.get().bookStates[bookId] || "none";
  }

  function addCustomTag(bookId, tag) {
    const clean = tag.trim().toLowerCase().replace(/\s+/g, "-");
    if (!clean) return;
    store.update(s => {
      s.tags[bookId] = s.tags[bookId] || [];
      if (!s.tags[bookId].includes(clean)) s.tags[bookId].push(clean);
    });
  }

  function removeCustomTag(bookId, tag) {
    store.update(s => {
      if (!s.tags[bookId]) return;
      s.tags[bookId] = s.tags[bookId].filter(t => t !== tag);
      if (s.tags[bookId].length === 0) delete s.tags[bookId];
    });
  }

  function readingStateBadge(bookId) {
    const st = getReadingState(bookId);
    if (st === "none") return null;
    const def = READING_STATES.find(x => x.id === st);
    const variant = st === "read" ? "good" : st === "reading" ? "accent" : st === "want" ? "warn" : "danger";
    return ui.tag(def.short, variant);
  }

  function readingStateSelect(bookId) {
    const current = getReadingState(bookId);
    const wrap = util.el("div", { class: "row-wrap" });
    READING_STATES.forEach(st => {
      wrap.appendChild(ui.chip(st.label, {
        pressed: current === st.id,
        onToggle: () => { setReadingState(bookId, st.id); openBookDetail(bookId); }
      }));
    });
    return wrap;
  }

  function bookCardFull(book, scored) {
    const state = getReadingState(book.id);
    const card = util.el("div", { class: "card card-raised", style: { cursor: "pointer", display: "flex", flexDirection: "column" },
      onclick: () => openBookDetail(book.id)
    });
    const head = util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
      util.el("div", { class: "t-eyebrow", text: util.humanise(book.category) }),
      scored ? util.el("div", { class: "t-mono", style: { color: "var(--accent)", fontSize: "18px" }, text: `${scored.fitScore}` }) : null
    ].filter(Boolean));
    card.appendChild(head);
    card.appendChild(util.el("h3", { class: "t-serif", style: { marginTop: "var(--s-2)", fontSize: "18px" }, text: book.title }));
    card.appendChild(util.el("div", { class: "t-small t-subtle", style: { marginTop: "2px" }, text: `${book.author} · ${util.fmtYear(book.year)}` }));
    card.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-3)", flex: "1 1 auto" }, text: book.description.slice(0, 160) + (book.description.length > 160 ? "…" : "") }));
    const badges = util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-3)" } });
    const rsBadge = readingStateBadge(book.id);
    if (rsBadge) badges.appendChild(rsBadge);
    if (book.content_warnings.length) badges.appendChild(ui.tag(`${book.content_warnings.length} warning${book.content_warnings.length > 1 ? "s" : ""}`, "warn"));
    if (scored && scored.confidence < 60) badges.appendChild(ui.tag(`low confidence`, "danger"));
    card.appendChild(badges);
    return card;
  }

  function openBookDetail(bookId) {
    const book = BOOKS.find(b => b.id === bookId);
    if (!book) return;
    const s = store.get();
    const scored = Engine.compareBooks([bookId], s.profile, s.weights)[0];
    const userTags = s.tags[bookId] || [];

    const body = util.el("div", { class: "stack" });
    body.appendChild(util.el("div", { class: "t-eyebrow", text: util.humanise(book.category) }));
    body.appendChild(util.el("div", { class: "t-serif", style: { fontSize: "22px", marginTop: "4px" }, text: book.title }));
    body.appendChild(util.el("div", { class: "t-small t-subtle", text: `${book.author} · ${util.fmtYear(book.year)} · ${book.source}` }));

    // Score block
    if (scored) {
      const scoreBlock = util.el("div", { class: "card card-quiet", style: { marginTop: "var(--s-3)" } }, [
        util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
          util.el("div", {}, [
            util.el("div", { class: "t-eyebrow", text: "Fit for you" }),
            util.el("div", { class: "t-mono", style: { fontSize: "28px", color: "var(--accent)" }, text: `${scored.fitScore}` })
          ]),
          util.el("div", { style: { textAlign: "right" } }, [
            util.el("div", { class: "t-tiny t-subtle", text: "Confidence" }),
            util.el("div", { class: "t-mono", text: `${scored.confidence}%` })
          ])
        ])
      ]);
      if (scored.why.reasons.length) {
        const reasons = util.el("ul", { style: { marginTop: "var(--s-3)", paddingLeft: "var(--s-4)" } });
        scored.why.reasons.forEach(r => reasons.appendChild(util.el("li", { class: "t-small t-muted", text: r })));
        scoreBlock.appendChild(reasons);
      }
      body.appendChild(scoreBlock);
    }

    body.appendChild(util.el("p", { class: "t-muted", style: { marginTop: "var(--s-3)" }, text: book.description }));

    // Reading state
    body.appendChild(util.el("div", { class: "field-label", style: { marginTop: "var(--s-4)" }, text: "Reading state" }));
    body.appendChild(readingStateSelect(bookId));

    // Custom tags
    body.appendChild(util.el("div", { class: "field-label", style: { marginTop: "var(--s-4)" }, text: "Your tags" }));
    const tagRow = util.el("div", { class: "row-wrap" });
    userTags.forEach(t => {
      tagRow.appendChild(util.el("span", { class: "tag tag-outline" }, [
        t.replace(/-/g, " "),
        util.el("button", { class: "t-tiny", style: { marginLeft: "6px", color: "var(--text-subtle)" }, onclick: () => { removeCustomTag(bookId, t); openBookDetail(bookId); } }, "×")
      ]));
    });
    const input = util.el("input", { class: "input", placeholder: "Add a tag and press Enter", style: { maxWidth: "240px" }, onkeydown: (e) => {
      if (e.key === "Enter" && input.value.trim()) { addCustomTag(bookId, input.value); input.value = ""; openBookDetail(bookId); }
    } });
    tagRow.appendChild(input);
    body.appendChild(tagRow);

    // Content warnings
    if (book.content_warnings.length) {
      body.appendChild(util.el("div", { class: "field-label", style: { marginTop: "var(--s-4)" }, text: "Content warnings" }));
      const warns = util.el("div", { class: "row-wrap" });
      book.content_warnings.forEach(w => warns.appendChild(ui.tag(w, "warn")));
      body.appendChild(warns);
    }

    // Metadata pills
    const meta = util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-4)" } });
    [
      ["Heat", book.heat_level],
      ["Explicit", book.explicitness],
      ["Emotion", book.emotional_intensity],
      ["Consent", book.consent_clarity],
      ["Taboo", book.taboo_level],
      ["Plot", book.plot_weight]
    ].forEach(([l, v]) => meta.appendChild(util.el("span", { class: "tag tag-outline t-mono" }, `${l} · ${v}/5`)));
    body.appendChild(meta);

    ui.modal({
      title: "",
      body,
      primary: { label: "Compare with…", onClick: () => {
        sessionStorage.setItem("lumen:compare-seed", bookId);
        router.go("compare");
      } },
      secondary: { label: "Close" }
    });
  }

  function renderLibrary() {
    const s = store.get();
    const ranked = Engine.rankRecommendations(s.profile, s.weights);
    const scoredMap = Object.fromEntries(ranked.scored.map(x => [x.book.id, x]));

    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Library" }),
        util.el("h1", { text: "Everything in the catalogue" }),
        util.el("p", { class: "lede", text: `${BOOKS.length} titles · filter by how you want to read them, or drop anything that doesn't pass your exclusions.` })
      ])
    ]));

    // Filter bar
    const filters = util.el("div", { class: "card card-quiet", style: { padding: "var(--s-4)" } });
    const filterRow = util.el("div", { class: "row-wrap" });

    const searchInput = util.el("input", {
      class: "input", placeholder: "Search titles or authors", style: { maxWidth: "260px" },
      value: libState.query,
      oninput: (e) => { libState.query = e.target.value.toLowerCase(); updateGrid(); }
    });
    filterRow.appendChild(searchInput);

    const rfOptions = [{ id: "all", label: "All" }, ...READING_STATES.filter(r => r.id !== "none")];
    const rfSegmented = util.el("div", { class: "segmented" });
    rfOptions.forEach(opt => {
      const b = util.el("button", {
        type: "button",
        "aria-pressed": libState.readingFilter === opt.id ? "true" : "false",
        onclick: () => {
          libState.readingFilter = opt.id;
          rfSegmented.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x.dataset.v === opt.id ? "true" : "false"));
          updateGrid();
        },
        "data-v": opt.id
      }, opt.label);
      rfSegmented.appendChild(b);
    });
    filterRow.appendChild(rfSegmented);

    const categories = ["all", ...new Set(BOOKS.map(b => b.category))];
    const catSelect = util.el("select", {
      class: "select", style: { maxWidth: "260px" },
      onchange: (e) => { libState.category = e.target.value; updateGrid(); }
    });
    categories.forEach(c => {
      const o = util.el("option", { value: c, selected: libState.category === c ? "selected" : null }, c === "all" ? "All categories" : util.humanise(c));
      catSelect.appendChild(o);
    });
    filterRow.appendChild(catSelect);

    const sortSelect = util.el("select", {
      class: "select", style: { maxWidth: "180px" },
      onchange: (e) => { libState.sort = e.target.value; updateGrid(); }
    });
    [
      ["fit", "Sort: best fit"],
      ["title", "Sort: title"],
      ["year", "Sort: year"]
    ].forEach(([v, l]) => sortSelect.appendChild(util.el("option", { value: v, selected: libState.sort === v ? "selected" : null }, l)));
    filterRow.appendChild(sortSelect);

    filters.appendChild(filterRow);
    wrap.appendChild(filters);

    // Stats
    const stats = util.el("div", { class: "row-wrap t-small t-subtle", id: "lib-stats" });
    wrap.appendChild(stats);

    // Grid
    const grid = util.el("div", { id: "lib-grid", style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--s-4)" } });
    wrap.appendChild(grid);

    function updateGrid() {
      const q = libState.query;
      let filtered = BOOKS.filter(b => {
        if (q && !(b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q))) return false;
        if (libState.category !== "all" && b.category !== libState.category) return false;
        if (libState.readingFilter !== "all" && getReadingState(b.id) !== libState.readingFilter) return false;
        return true;
      });
      filtered.sort((a, b) => {
        if (libState.sort === "fit") {
          const sa = scoredMap[a.id]?.fitScore ?? -1;
          const sb = scoredMap[b.id]?.fitScore ?? -1;
          return sb - sa;
        }
        if (libState.sort === "title") return a.title.localeCompare(b.title);
        if (libState.sort === "year")  return a.year - b.year;
        return 0;
      });

      const excluded = BOOKS.length - Engine.applyHardExclusions(BOOKS, Engine.normalizeProfile(s.profile)).length;
      stats.innerHTML = "";
      stats.appendChild(util.el("span", {}, `Showing ${filtered.length} of ${BOOKS.length}`));
      if (excluded > 0) stats.appendChild(util.el("span", { class: "tag tag-warn" }, `${excluded} excluded by your filters`));

      grid.innerHTML = "";
      if (!filtered.length) {
        grid.appendChild(ui.empty({ title: "Nothing matches those filters", message: "Try clearing the search or reading-state filter." }));
        return;
      }
      filtered.forEach(b => grid.appendChild(bookCardFull(b, scoredMap[b.id])));
    }

    setTimeout(updateGrid, 0);
    return wrap;
  }

  /* -------------------- views -------------------- */
  const views = {
    discover() {
      const s = store.get();
      const greeting = s.ui.onboardingDone ? "Welcome back." : "Welcome to Lumen.";
      const result = Engine.rankRecommendations(s.profile, s.weights);
      const picks = result.scored.slice(0, 3);

      const currentReadingIds = Object.entries(s.bookStates).filter(([, v]) => v === "reading").map(([k]) => k);
      const currentReading = currentReadingIds.map(id => BOOKS.find(b => b.id === id)).filter(Boolean);

      const wrap = util.el("div", { class: "page stack-lg" });

      wrap.appendChild(util.el("div", { class: "page-head" }, [
        util.el("div", {}, [
          util.el("div", { class: "t-eyebrow", text: "Home" }),
          util.el("h1", { text: greeting }),
          util.el("p", { class: "lede", text: "A private, taste-aware reading companion. Nothing leaves your device." })
        ]),
        util.el("div", { class: "row" }, [
          util.el("button", { class: "btn", onclick: () => router.go("profile") }, "Edit profile"),
          util.el("button", { class: "btn btn-primary", onclick: () => router.go("library") }, "Browse library")
        ])
      ]));

      // Sara check-in
      wrap.appendChild(util.el("div", { class: "card card-accent" }, [
        util.el("div", { class: "t-eyebrow", text: "Sara · your guide" }),
        util.el("h3", { class: "t-serif", style: { marginTop: "4px" }, text: "What are you in the mood for today?" }),
        util.el("p", { class: "t-muted", style: { marginTop: "var(--s-2)" }, text: "I can help you narrow down by mood, compare two titles side by side, or reflect on what you just read." }),
        util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-4)" } }, [
          util.el("button", { class: "btn btn-sm", onclick: () => router.go("chat") }, "Talk with Sara"),
          util.el("button", { class: "btn btn-sm", onclick: () => router.go("compare") }, "Compare two titles"),
          util.el("button", { class: "btn btn-sm", onclick: () => router.go("journal") }, "Write a reflection")
        ])
      ]));

      // Daily picks
      const picksCard = util.el("div", { class: "card" });
      picksCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Daily picks" }),
        util.el("span", { class: "card-sub t-subtle", text: `Drawn from your profile · ${result.matched} matches` })
      ]));
      if (!picks.length) {
        picksCard.appendChild(ui.empty({
          title: "Nothing passes your filters yet",
          message: "Your exclusions or warning strictness are ruling everything out. Loosen one of them in your profile.",
          actions: [{ label: "Edit profile", variant: "btn-primary", onClick: () => router.go("profile") }]
        }));
      } else {
        const grid = util.el("div", { class: "row-wrap", style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--s-4)" } });
        picks.forEach(p => grid.appendChild(bookCardMini(p, () => ui.toast(`Opens full detail in Batch 3 · ${p.book.title}`))));
        picksCard.appendChild(grid);
      }
      wrap.appendChild(picksCard);

      // Currently reading
      if (currentReading.length) {
        const reading = util.el("div", { class: "card" });
        reading.appendChild(util.el("div", { class: "card-head" }, [
          util.el("h3", { text: "Currently reading" }),
          util.el("span", { class: "card-sub t-subtle", text: `${currentReading.length} in progress` })
        ]));
        const row = util.el("div", { class: "row-wrap" });
        currentReading.forEach(b => row.appendChild(util.el("div", { class: "tag tag-outline", style: { padding: "var(--s-2) var(--s-3)" } }, b.title)));
        reading.appendChild(row);
        wrap.appendChild(reading);
      }

      return wrap;
    },

    library() {
      return renderLibrary();
    },

    compare() {
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Compare", "Pick two titles. A VCFO-inspired scorecard shows where each one lands for you."),
        ui.empty({
          title: "Comparison engine arrives in Batch 4",
          message: "You'll get weighted category bars, a radar, tradeoff callouts, confidence, and a plain-language AI verdict."
        })
      ]);
    },

    chat() {
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Chat", "Private conversations with Sara and, optionally, with friends."),
        ui.empty({
          title: "Chat lands in Batch 5",
          message: "Sara becomes context-aware about the book you're viewing or comparing. Friend chat is strictly opt-in."
        })
      ]);
    },

    journal() {
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Journal", "Quiet space for reflection. Your entries stay on this device."),
        ui.empty({
          title: "Journal arrives in Batch 6",
          message: "Prompted or freeform entries, mood tags, links to books, searchable timeline."
        })
      ]);
    },

    vault() {
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Vault", "A discreet space for saved items, private notes, and bookmarked analyses."),
        ui.empty({
          title: "Vault arrives in Batch 7",
          message: "Optional passcode gate, pinned collections, saved comparisons, blur-on-blur."
        })
      ]);
    },

    profile() {
      const wrap = util.el("div", { class: "page" });

      wrap.appendChild(util.el("div", { class: "page-head" }, [
        util.el("div", {}, [
          util.el("div", { class: "t-eyebrow", text: "Profile" }),
          util.el("h1", { text: "Your reader profile" }),
          util.el("p", { class: "lede", text: "What you tell Lumen here shapes every recommendation. All values stay on this device." })
        ]),
        util.el("div", { class: "row" }, [
          util.el("button", { class: "btn btn-ghost", onclick: () => {
            ui.modal({
              title: "Reset profile?",
              body: "<p class=\"t-muted\">This restores every control to its default. Your saved books, journal, and vault are not touched.</p>",
              primary: { label: "Reset", onClick: () => {
                store.update(s => { s.profile = structuredClone(DEFAULT_PROFILE); });
                renderView();
                ui.toast("Profile reset");
              }},
              secondary: { label: "Cancel" }
            });
          } }, "Reset"),
          util.el("button", { class: "btn", onclick: () => launchOnboarding(true) }, "Re-run onboarding")
        ])
      ]));

      const grid = util.el("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: "var(--s-5)", alignItems: "start" } });
      const col = util.el("div", { class: "stack-lg" });

      // Numeric card
      const numericCard = util.el("div", { class: "card" });
      numericCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Intensity" }),
        util.el("span", { class: "card-sub t-subtle", text: "1 = low · 5 = high" })
      ]));
      numericCard.appendChild(util.el("div", { class: "stack" }, [
        numericSlider("heat",     "Heat level",          "How physically charged do you want the reading to feel."),
        numericSlider("explicit", "Explicitness",        "How direct the language is — from implied to graphic."),
        numericSlider("emotion",  "Emotional intensity", "Emotional weight and psychological depth."),
        numericSlider("consent",  "Consent clarity",     "How clearly consent is depicted and respected."),
        numericSlider("taboo",    "Taboo tolerance",     "Your appetite for transgressive or edge-of-taboo material."),
        numericSlider("plot",     "Plot vs scene",       "1 = scenes-driven · 5 = plot-driven")
      ]));
      col.appendChild(numericCard);

      // Strictness
      const strictCard = util.el("div", { class: "card" });
      strictCard.appendChild(util.el("h3", { text: "Warning sensitivity" }));
      strictCard.appendChild(util.el("p", { class: "t-muted t-small", style: { margin: "var(--s-2) 0 var(--s-4)" }, text: "How heavily content warnings should reduce a book's fit score." }));
      strictCard.appendChild(segmented("warnStrict", [
        { label: "Permissive", value: "permissive" },
        { label: "Moderate",   value: "moderate" },
        { label: "Strict",     value: "strict" }
      ]));
      col.appendChild(strictCard);

      // Tag groups (collapsed under a disclosure)
      const tagsCard = util.el("details", { class: "card", open: true, style: { padding: "var(--s-5)" } });
      tagsCard.appendChild(util.el("summary", { style: { cursor: "pointer", fontFamily: "var(--font-serif)", fontSize: "19px", marginBottom: "var(--s-4)" }, text: "Tastes (optional)" }));
      tagsCard.appendChild(util.el("div", { class: "stack" }, [
        chipGroup("tone",        "Tone",               VOCAB.tone),
        chipGroup("pacing",      "Pacing",             VOCAB.pacing),
        chipGroup("style",       "Literary style",     VOCAB.style),
        chipGroup("dynamic",     "Relationship dynamic", VOCAB.dynamic),
        chipGroup("trope",       "Tropes",             VOCAB.trope),
        chipGroup("kink",        "Kink tags",          VOCAB.kink),
        chipGroup("orientation", "Orientation",        VOCAB.orientation)
      ]));
      col.appendChild(tagsCard);

      // Exclusions
      const excludeCard = util.el("div", { class: "card" });
      excludeCard.appendChild(util.el("h3", { text: "Hard exclusions" }));
      excludeCard.appendChild(util.el("p", { class: "t-muted t-small", style: { margin: "var(--s-2) 0 var(--s-4)" }, text: "Any book carrying a selected warning is dropped from results. This is absolute." }));
      excludeCard.appendChild(chipGroup("exclude", "", ALL_WARNINGS, { exclude: true }));
      col.appendChild(excludeCard);

      // Scenarios
      const scenariosCard = util.el("div", { class: "card" });
      scenariosCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Quick scenarios" }),
        util.el("span", { class: "card-sub t-subtle", text: "Preset profiles — applied to the sliders above." })
      ]));
      SCENARIOS.forEach(sc => {
        const row = util.el("div", { class: "row", style: { justifyContent: "space-between", padding: "var(--s-3) 0", borderTop: "1px solid var(--border)" } }, [
          util.el("div", { style: { minWidth: 0 } }, [
            util.el("div", { class: "t-serif", style: { fontSize: "15px" }, text: sc.name }),
            util.el("div", { class: "t-small t-subtle", text: sc.desc })
          ]),
          util.el("button", { class: "btn btn-sm", onclick: () => {
            store.update(s => { s.profile = Object.assign(structuredClone(DEFAULT_PROFILE), structuredClone(sc.profile)); s.ui.activeScenarioId = sc.id; });
            ui.toast(`Applied: ${sc.name}`);
            renderView();
          } }, "Apply")
        ]);
        scenariosCard.appendChild(row);
      });
      col.appendChild(scenariosCard);

      grid.appendChild(col);

      // Preview column
      const preview = util.el("div", { class: "card", id: "profile-preview", style: { position: "sticky", top: "calc(var(--shell-topbar) + var(--s-4))" } });
      grid.appendChild(preview);

      wrap.appendChild(grid);

      setTimeout(refreshProfilePreview, 0);
      return wrap;
    },

    transparency() {
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Transparency", "How Lumen reasons about fit, and what it refuses to guess at."),
        util.el("div", { class: "card stack" }, [
          util.el("h3", { text: "What Lumen does" }),
          util.el("p", { class: "t-muted", text: "Lumen scores each title against your profile across numeric dimensions (heat, emotional intensity, consent clarity, and more) and tag overlaps (tone, pacing, style, relationship dynamic). Weights are adjustable. Hard exclusions are absolute." }),
          util.el("h3", { text: "What stays on your device" }),
          util.el("p", { class: "t-muted", text: "Your profile, reading states, journal entries, vault contents, and chat history are stored in your browser's local storage. Nothing is uploaded anywhere." }),
          util.el("h3", { text: "What Lumen will not do" }),
          util.el("p", { class: "t-muted", text: "Lumen does not gamify reading, reward streaks, nudge, or share anything by default. It treats its outputs as advisory, never authoritative." })
        ])
      ]);
    }
  };

  function pageHead(title, lede) {
    return util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: title }),
        util.el("h1", { text: title }),
        lede ? util.el("p", { class: "lede", text: lede }) : null
      ].filter(Boolean))
    ]);
  }

  /* -------------------- shell rendering -------------------- */
  function renderSidebar() {
    const current = router.current();
    const groups = {
      main:     { label: "Read" },
      personal: { label: "You" },
      settings: { label: "Settings" }
    };
    const side = document.getElementById("side-nav");
    side.innerHTML = "";
    side.appendChild(util.el("div", { class: "app-brand" }, [
      util.el("span", { class: "mark", text: "Lumen" }),
      util.el("span", { class: "tag", text: "Private" })
    ]));

    for (const [gid, g] of Object.entries(groups)) {
      const group = util.el("div", { class: "nav-group" });
      group.appendChild(util.el("div", { class: "nav-group-label", text: g.label }));
      for (const r of ROUTES.filter(r => r.group === gid)) {
        const link = util.el("a", {
          class: "nav-link",
          href: `#/${r.id}`,
          "aria-current": r.id === current.id ? "page" : null,
          "data-route": r.id
        }, [util.el("span", { text: r.short })]);
        group.appendChild(link);
      }
      side.appendChild(group);
    }
  }

  function renderTopbar() {
    const current = router.current();
    const top = document.getElementById("topbar");
    const state = store.get();
    top.innerHTML = "";

    top.appendChild(util.el("div", { class: "row grow" }, [
      util.el("span", { class: "crumb", text: current.label }),
      util.el("span", { class: "crumb-sub t-small", text: current.id === "discover" ? "your reading companion" : "" })
    ]));

    const discreetToggle = util.el("button", {
      class: "btn btn-sm",
      "aria-pressed": state.ui.discreet ? "true" : "false",
      title: "Softens titles and palette for shared-screen situations",
      onclick: () => {
        store.update(s => { s.ui.discreet = !s.ui.discreet; });
        applyUIFlags();
        ui.toast(state.ui.discreet ? "Discreet mode off" : "Discreet mode on");
      }
    }, state.ui.discreet ? "Discreet · on" : "Discreet · off");

    const themeBtn = util.el("button", {
      class: "btn btn-sm",
      onclick: () => {
        store.update(s => { s.ui.theme = s.ui.theme === "dark" ? "light" : "dark"; });
        applyUIFlags();
      }
    }, state.ui.theme === "dark" ? "Light mode" : "Dark mode");

    top.appendChild(discreetToggle);
    top.appendChild(themeBtn);
  }

  function renderView() {
    const root = document.getElementById("view-root");
    root.innerHTML = "";
    const r = router.current();
    try {
      root.appendChild(r.render());
    } catch (e) {
      console.error(e);
      root.appendChild(ui.empty({
        title: "Something went wrong rendering this view.",
        message: "Try another section, or reload the page. Your local data is untouched."
      }));
    }
    root.focus();
  }

  function applyUIFlags() {
    const s = store.get();
    document.documentElement.setAttribute("data-theme", s.ui.theme);
    document.documentElement.setAttribute("data-discreet", s.ui.discreet ? "on" : "off");
    renderTopbar();
    renderSidebar();
  }

  /* -------------------- boot -------------------- */
  /* -------------------- onboarding wizard -------------------- */
  const ONBOARD_STEPS = [
    {
      title: "Welcome to Lumen",
      body: () => util.el("div", { class: "stack" }, [
        util.el("p", { class: "t-muted", text: "Lumen is a private reading companion for adult literature. A few quick questions shape every recommendation. You can skip or change any answer later." }),
        util.el("p", { class: "t-small t-subtle", text: "Everything you enter here stays on this device." })
      ])
    },
    {
      title: "How much heat are you looking for?",
      body: () => {
        const s = store.get();
        return util.el("div", { class: "stack" }, [
          util.el("p", { class: "t-muted", text: "A 1 is barely-there sensuality; a 5 is unreserved." }),
          numericSlider("heat", "Heat level"),
          numericSlider("explicit", "Explicitness")
        ]);
      }
    },
    {
      title: "Consent and edges",
      body: () => util.el("div", { class: "stack" }, [
        util.el("p", { class: "t-muted", text: "Two firm anchors. Consent clarity is how clearly consent is shown in the text; taboo tolerance is your appetite for transgressive material." }),
        numericSlider("consent", "Consent clarity"),
        numericSlider("taboo", "Taboo tolerance")
      ])
    },
    {
      title: "Story shape",
      body: () => util.el("div", { class: "stack" }, [
        util.el("p", { class: "t-muted", text: "Do you want plot architecture, or are you here for the scenes themselves?" }),
        numericSlider("plot", "Plot vs scene"),
        numericSlider("emotion", "Emotional intensity")
      ])
    },
    {
      title: "What should never come up",
      body: () => util.el("div", { class: "stack" }, [
        util.el("p", { class: "t-muted", text: "Anything you select here is an absolute filter. Books carrying these warnings are never shown." }),
        chipGroup("exclude", "", ALL_WARNINGS, { exclude: true }),
        util.el("div", { class: "field-help", text: "Common choices: underage content, consent violations, exploitation." })
      ])
    }
  ];

  function launchOnboarding(force = false) {
    const s = store.get();
    if (!force && s.ui.onboardingDone) return;

    let step = 0;
    const render = () => {
      const def = ONBOARD_STEPS[step];
      const body = util.el("div");
      body.appendChild(def.body());

      const progress = util.el("div", { class: "t-tiny t-subtle", style: { marginBottom: "var(--s-3)" }, text: `Step ${step + 1} of ${ONBOARD_STEPS.length}` });
      body.insertBefore(progress, body.firstChild);

      const host = document.getElementById("modal-host");
      ui.modal({
        title: def.title,
        body,
        secondary: step > 0 ? { label: "Back", onClick: () => { step -= 1; setTimeout(render, 10); } } : { label: "Skip for now", onClick: () => {
          store.update(s2 => { s2.ui.onboardingDone = true; });
          ui.toast("You can rerun onboarding from your profile any time.");
        }},
        primary: step === ONBOARD_STEPS.length - 1
          ? { label: "Finish", onClick: () => {
              store.update(s2 => { s2.ui.onboardingDone = true; });
              renderView();
              ui.toast("Profile saved. Your daily picks are ready.");
            }}
          : { label: "Next", onClick: () => { step += 1; setTimeout(render, 10); } }
      });
    };
    render();
  }

  function adultGate() {
    if (store.get().ui.adultConfirmed) return;
    ui.modal({
      title: "Before you begin",
      body: `<p class="t-muted">Lumen discusses adult literature — erotic classics, sexuality texts, and works with mature themes. Please confirm you are an adult and understand the material may include historically problematic content.</p>
             <p class="t-small t-subtle" style="margin-top: var(--s-3);">Your profile and everything you save stays on this device.</p>`,
      primary: { label: "I'm an adult — continue", onClick: () => {
        store.update(s => { s.ui.adultConfirmed = true; });
        if (!store.get().ui.onboardingDone) setTimeout(() => launchOnboarding(false), 250);
      }},
      secondary: { label: "Leave", onClick: () => { location.href = "about:blank"; } }
    });
  }

  function boot() {
    applyUIFlags();
    renderView();
    window.addEventListener("hashchange", () => { renderSidebar(); renderTopbar(); renderView(); });
    adultGate();
  }

  // Expose a small surface for later batches to hook into.
  window.Lumen = { store, router, ui, util, views, ROUTES };
  document.addEventListener("DOMContentLoaded", boot);
})();
