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

    // Extra actions row
    body.appendChild(util.el("div", { class: "row", style: { marginTop: "var(--s-4)" } }, [
      util.el("button", { class: "btn btn-sm", onclick: () => {
        pinBook(bookId);
        openBookDetail(bookId);
      } }, "Pin to Vault")
    ]));

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

  /* -------------------- vault -------------------- */
  function hashPasscode(pw) {
    // Prototype-only: a simple deterministic hash.
    // This is NOT real security — see the transparency tab.
    let h = 0;
    for (let i = 0; i < pw.length; i++) h = (h * 31 + pw.charCodeAt(i)) | 0;
    return "h" + (h >>> 0).toString(36);
  }

  let vaultUnlocked = false;

  function pinBook(bookId, note = "") {
    store.update(s => {
      if (s.vault.pinned.find(p => p.bookId === bookId)) return;
      s.vault.pinned.push({ id: util.id("p"), bookId, note, ts: Date.now() });
    });
    ui.toast("Pinned to Vault");
  }

  function unpinBook(pinId) {
    store.update(s => { s.vault.pinned = s.vault.pinned.filter(p => p.id !== pinId); });
  }

  function saveAnalysis(analysisPayload) {
    store.update(s => {
      s.vault.analyses.unshift({ id: util.id("a"), ts: Date.now(), ...analysisPayload });
    });
    ui.toast("Analysis saved to Vault");
  }

  function addVaultNote(text) {
    if (!text.trim()) return;
    store.update(s => { s.vault.notes.unshift({ id: util.id("n"), text, ts: Date.now() }); });
  }

  function renderVault() {
    const s = store.get();
    const hasPasscode = !!s.vault.passcodeHash;

    if (hasPasscode && !vaultUnlocked) {
      const wrap = util.el("div", { class: "page" });
      const gate = util.el("div", { class: "vault-gate stack" });
      gate.appendChild(util.el("div", { class: "t-eyebrow", text: "Vault" }));
      gate.appendChild(util.el("h2", { text: "Locked" }));
      gate.appendChild(util.el("p", { class: "t-muted t-small", text: "Enter your passcode to unlock. Prototype-only — see Transparency for what this protects against (and what it doesn't)." }));
      const input = util.el("input", {
        class: "input",
        type: "password",
        placeholder: "Passcode",
        style: { textAlign: "center" },
        onkeydown: (e) => { if (e.key === "Enter") tryUnlock(); }
      });
      gate.appendChild(input);
      gate.appendChild(util.el("div", { class: "row", style: { justifyContent: "center" } }, [
        util.el("button", { class: "btn btn-primary", onclick: tryUnlock }, "Unlock"),
        util.el("button", { class: "btn btn-ghost", onclick: () => {
          ui.modal({
            title: "Remove passcode?",
            body: "<p class=\"t-muted\">This clears the passcode and unlocks your vault. You can set a new one later.</p>",
            primary: { label: "Remove", onClick: () => {
              store.update(s2 => { s2.vault.passcodeHash = null; });
              vaultUnlocked = true;
              renderView();
            }},
            secondary: { label: "Cancel" }
          });
        }}, "Forgot passcode")
      ]));
      wrap.appendChild(gate);

      function tryUnlock() {
        if (hashPasscode(input.value) === store.get().vault.passcodeHash) {
          vaultUnlocked = true;
          ui.toast("Vault unlocked");
          renderView();
        } else {
          input.value = "";
          ui.toast("Incorrect passcode");
        }
      }
      return wrap;
    }

    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Vault" }),
        util.el("h1", { text: "Your private space" }),
        util.el("p", { class: "lede", text: "Pinned books, saved comparisons, private notes. All local. Optional passcode gates re-entry." })
      ]),
      util.el("div", { class: "row" }, [
        hasPasscode
          ? util.el("button", { class: "btn", onclick: () => {
              ui.modal({
                title: "Remove passcode?",
                body: "<p class=\"t-muted\">The vault will be unlocked by default.</p>",
                primary: { label: "Remove", onClick: () => {
                  store.update(s2 => { s2.vault.passcodeHash = null; });
                  ui.toast("Passcode removed");
                }},
                secondary: { label: "Cancel" }
              });
            }}, "Remove passcode")
          : util.el("button", { class: "btn", onclick: () => promptPasscode() }, "Set passcode"),
        util.el("button", { class: "btn btn-ghost", onclick: () => { vaultUnlocked = false; renderView(); }, disabled: !hasPasscode || null }, "Lock")
      ])
    ]));

    // Pinned books
    const pinned = s.vault.pinned;
    const pinnedCard = util.el("div", { class: "card vault-section" });
    pinnedCard.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Pinned books" }),
      util.el("span", { class: "card-sub t-subtle", text: `${pinned.length} pinned` })
    ]));
    if (!pinned.length) {
      pinnedCard.appendChild(ui.empty({
        title: "Nothing pinned yet",
        message: "Open a book from the Library and use 'Pin to Vault' to save it here."
      }));
    } else {
      const grid = util.el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "var(--s-3)" } });
      pinned.forEach(p => {
        const book = BOOKS.find(b => b.id === p.bookId);
        if (!book) return;
        const tile = util.el("div", { class: "vault-tile" });
        tile.appendChild(util.el("div", { class: "t-eyebrow", text: util.humanise(book.category) }));
        tile.appendChild(util.el("div", { class: "t-serif", style: { fontSize: "16px", marginTop: "4px" }, text: book.title }));
        tile.appendChild(util.el("div", { class: "t-small t-subtle", text: book.author }));
        if (p.note) tile.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: p.note }));
        tile.appendChild(util.el("div", { class: "row", style: { marginTop: "var(--s-3)", justifyContent: "space-between" } }, [
          util.el("button", { class: "btn btn-sm", onclick: () => openBookDetail(book.id) }, "Open"),
          util.el("button", { class: "btn btn-sm btn-danger", onclick: () => { unpinBook(p.id); renderView(); } }, "Unpin")
        ]));
        grid.appendChild(tile);
      });
      pinnedCard.appendChild(grid);
    }
    wrap.appendChild(pinnedCard);

    // Saved analyses
    const analyses = s.vault.analyses;
    const analysesCard = util.el("div", { class: "card vault-section" });
    analysesCard.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Saved analyses" }),
      util.el("span", { class: "card-sub t-subtle", text: `${analyses.length} saved` })
    ]));
    if (!analyses.length) {
      analysesCard.appendChild(ui.empty({
        title: "No analyses saved",
        message: "When you compare two books, use 'Save analysis' to keep the verdict here."
      }));
    } else {
      analyses.slice(0, 10).forEach(a => {
        const tile = util.el("div", { class: "vault-tile" });
        tile.appendChild(util.el("div", { class: "t-tiny t-subtle", text: formatDate(a.ts) }));
        tile.appendChild(util.el("div", { class: "t-serif", style: { fontSize: "16px", marginTop: "4px" }, text: `${a.titleA} vs ${a.titleB}` }));
        tile.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: a.verdict }));
        tile.appendChild(util.el("div", { class: "row", style: { marginTop: "var(--s-3)", justifyContent: "flex-end" } }, [
          util.el("button", { class: "btn btn-sm btn-danger", onclick: () => {
            store.update(s2 => { s2.vault.analyses = s2.vault.analyses.filter(x => x.id !== a.id); });
            renderView();
          }}, "Remove")
        ]));
        analysesCard.appendChild(tile);
      });
    }
    wrap.appendChild(analysesCard);

    // Private notes
    const notesCard = util.el("div", { class: "card vault-section" });
    notesCard.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Private notes" }),
      util.el("span", { class: "card-sub t-subtle", text: `${s.vault.notes.length} notes` })
    ]));
    const noteInput = util.el("textarea", { class: "textarea", placeholder: "A private note — nothing leaves this device." });
    notesCard.appendChild(noteInput);
    notesCard.appendChild(util.el("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "var(--s-2)" } }, [
      util.el("button", { class: "btn btn-primary btn-sm", onclick: () => {
        addVaultNote(noteInput.value);
        noteInput.value = "";
        renderView();
      }}, "Save note")
    ]));
    if (s.vault.notes.length) {
      const stack = util.el("div", { class: "stack-sm", style: { marginTop: "var(--s-4)" } });
      s.vault.notes.forEach(n => {
        const tile = util.el("div", { class: "vault-tile" }, [
          util.el("div", { class: "t-tiny t-subtle", text: formatDate(n.ts) }),
          util.el("p", { class: "t-muted t-small", style: { marginTop: "var(--s-2)", whiteSpace: "pre-wrap" }, text: n.text }),
          util.el("div", { class: "row", style: { marginTop: "var(--s-2)", justifyContent: "flex-end" } }, [
            util.el("button", { class: "btn btn-sm btn-danger", onclick: () => {
              store.update(s2 => { s2.vault.notes = s2.vault.notes.filter(x => x.id !== n.id); });
              renderView();
            }}, "Delete")
          ])
        ]);
        stack.appendChild(tile);
      });
      notesCard.appendChild(stack);
    }
    wrap.appendChild(notesCard);

    // Privacy tools
    const privCard = util.el("div", { class: "card vault-section" });
    privCard.appendChild(util.el("div", { class: "card-head" }, [ util.el("h3", { text: "Privacy tools" }) ]));
    privCard.appendChild(util.el("div", { class: "stack" }, [
      privacyToggleRow("Blur on blur", "Blur the screen when this window loses focus.", "privacyBlur"),
      privacyToggleRow("Discreet mode", "Soften titles and imagery for shared-screen situations.", "discreet")
    ]));
    wrap.appendChild(privCard);

    return wrap;
  }

  function privacyToggleRow(label, help, key) {
    const row = util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } });
    row.appendChild(util.el("div", {}, [
      util.el("div", { class: "t-small", style: { fontWeight: "600" }, text: label }),
      util.el("div", { class: "t-small t-subtle", text: help })
    ]));
    const s = store.get();
    const current = key === "privacyBlur" ? !!s.ui.privacyBlur : !!s.ui.discreet;
    const toggle = util.el("label", { class: "toggle" });
    const input = util.el("input", { type: "checkbox", checked: current ? "checked" : null, onchange: (e) => {
      store.update(st => {
        if (key === "privacyBlur") st.ui.privacyBlur = e.target.checked;
        else st.ui.discreet = e.target.checked;
      });
      applyUIFlags();
    }});
    toggle.appendChild(input);
    toggle.appendChild(util.el("span", { class: "toggle-track" }));
    row.appendChild(toggle);
    return row;
  }

  function promptPasscode() {
    const body = util.el("div", { class: "stack" });
    body.appendChild(util.el("p", { class: "t-muted t-small", text: "A passcode gates re-entry to the Vault on this device. Prototype-only — see Transparency for what this does and does not protect." }));
    const input = util.el("input", { class: "input", type: "password", placeholder: "Choose a passcode" });
    body.appendChild(input);
    ui.modal({
      title: "Set a passcode",
      body,
      primary: { label: "Save", onClick: () => {
        const pw = input.value;
        if (!pw) return;
        store.update(s => { s.vault.passcodeHash = hashPasscode(pw); });
        ui.toast("Passcode set");
        renderView();
      }},
      secondary: { label: "Cancel" }
    });
  }

  /* -------------------- journal -------------------- */
  const JOURNAL_PROMPTS = [
    "What's one passage that stopped you, and why?",
    "How did this piece make your body feel — literally?",
    "What lingered after you closed the book?",
    "What did this title do for you that you didn't expect?",
    "If you could ask the author one question, what would it be?",
    "Where did the book lose you, if anywhere?",
    "What did you want more of?",
    "What would younger-you have made of this?"
  ];
  const MOOD_TAGS = ["tender","charged","unsettled","curious","reflective","distracted","ravished","reverent","amused","uncomfortable","satisfied","wanting more"];

  const journalState = { selectedId: null, search: "", moodFilter: "all" };

  function newEntryDraft(prompt = null, bookId = null) {
    return {
      id: util.id("j"),
      ts: Date.now(),
      title: "",
      body: "",
      mood: [],
      bookId,
      prompt
    };
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function exportEntryMarkdown(entry) {
    const book = entry.bookId ? BOOKS.find(b => b.id === entry.bookId) : null;
    const lines = [];
    lines.push(`# ${entry.title || "(untitled)"}`);
    lines.push("");
    lines.push(`*${formatDate(entry.ts)}*  ${entry.mood.length ? "· " + entry.mood.join(", ") : ""}`);
    if (book) lines.push(`**On:** ${book.title} — ${book.author}`);
    if (entry.prompt) lines.push(`> ${entry.prompt}`);
    lines.push("");
    lines.push(entry.body || "");
    return lines.join("\n");
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = util.el("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function renderJournal() {
    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Journal" }),
        util.el("h1", { text: "Private reflections" }),
        util.el("p", { class: "lede", text: "A quiet place for reading thoughts. Freeform, prompted, or tied to a specific book. Never shared." })
      ]),
      util.el("div", { class: "row" }, [
        util.el("button", { class: "btn", onclick: () => {
          const prompt = JOURNAL_PROMPTS[Math.floor(Math.random() * JOURNAL_PROMPTS.length)];
          const draft = newEntryDraft(prompt);
          store.update(s => { s.journal.unshift(draft); });
          journalState.selectedId = draft.id;
          renderView();
        } }, "Prompted entry"),
        util.el("button", { class: "btn btn-primary", onclick: () => {
          const draft = newEntryDraft();
          store.update(s => { s.journal.unshift(draft); });
          journalState.selectedId = draft.id;
          renderView();
        } }, "New entry")
      ])
    ]));

    const shell = util.el("div", { class: "journal-shell" });
    const listSide = util.el("div", { class: "stack" });
    const editorSide = util.el("div", {});

    // Filter bar
    const filterBar = util.el("div", { class: "card card-quiet", style: { padding: "var(--s-3)" } });
    const filterRow = util.el("div", { class: "row-wrap" });
    filterRow.appendChild(util.el("input", {
      class: "input", placeholder: "Search entries", value: journalState.search,
      oninput: (e) => { journalState.search = e.target.value.toLowerCase(); paintList(); },
      style: { maxWidth: "200px" }
    }));
    const moodSel = util.el("select", { class: "select", style: { maxWidth: "160px" }, onchange: (e) => { journalState.moodFilter = e.target.value; paintList(); } });
    moodSel.appendChild(util.el("option", { value: "all" }, "All moods"));
    MOOD_TAGS.forEach(m => moodSel.appendChild(util.el("option", { value: m, selected: journalState.moodFilter === m ? "selected" : null }, m)));
    filterRow.appendChild(moodSel);
    filterBar.appendChild(filterRow);
    listSide.appendChild(filterBar);

    const list = util.el("div", { class: "stack-sm" });
    listSide.appendChild(list);

    shell.appendChild(listSide);
    shell.appendChild(editorSide);
    wrap.appendChild(shell);

    function entryMatches(e) {
      if (journalState.search) {
        const q = journalState.search;
        if (!((e.title || "").toLowerCase().includes(q) || (e.body || "").toLowerCase().includes(q))) return false;
      }
      if (journalState.moodFilter !== "all" && !e.mood.includes(journalState.moodFilter)) return false;
      return true;
    }

    function paintList() {
      const entries = store.get().journal.filter(entryMatches);
      list.innerHTML = "";
      if (!entries.length) {
        list.appendChild(ui.empty({
          title: "No entries yet",
          message: "Write your first reflection. The Journal is private and stays on your device.",
          actions: [{ label: "Start with a prompt", variant: "btn-primary", onClick: () => {
            const prompt = JOURNAL_PROMPTS[Math.floor(Math.random() * JOURNAL_PROMPTS.length)];
            const draft = newEntryDraft(prompt);
            store.update(s => { s.journal.unshift(draft); });
            journalState.selectedId = draft.id;
            renderView();
          }}]
        }));
        return;
      }
      entries.forEach(e => {
        const entry = util.el("div", {
          class: "journal-entry",
          "aria-current": journalState.selectedId === e.id ? "true" : null,
          onclick: () => { journalState.selectedId = e.id; paintEditor(); }
        }, [
          util.el("div", { class: "journal-entry-date", text: formatDate(e.ts) }),
          util.el("div", { class: "journal-entry-title", text: e.title || "(untitled)" }),
          util.el("div", { class: "journal-entry-preview", text: e.body || "No body yet." }),
          e.mood.length ? util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-2)" } }, e.mood.slice(0, 3).map(m => ui.tag(m))) : null
        ].filter(Boolean));
        list.appendChild(entry);
      });
    }

    function paintEditor() {
      const entry = store.get().journal.find(e => e.id === journalState.selectedId);
      editorSide.innerHTML = "";
      if (!entry) {
        editorSide.appendChild(ui.empty({
          title: "Pick an entry, or write a new one",
          message: "Your journal is for you. Prompt-guided or freeform — both work."
        }));
        return;
      }

      const card = util.el("div", { class: "card journal-editor stack" });
      card.appendChild(util.el("div", { class: "row", style: { justifyContent: "space-between" } }, [
        util.el("div", { class: "t-tiny t-subtle", text: formatDate(entry.ts) }),
        util.el("div", { class: "row" }, [
          util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => {
            downloadText(`lumen-entry-${entry.id}.md`, exportEntryMarkdown(entry));
            ui.toast("Entry exported as Markdown");
          }}, "Export"),
          util.el("button", { class: "btn btn-sm btn-danger", onclick: () => {
            const deleted = { ...entry };
            store.update(s => { s.journal = s.journal.filter(e => e.id !== entry.id); });
            journalState.selectedId = null;
            renderView();
            ui.toast("Entry removed", {
              action: "Undo",
              onAction: () => {
                store.update(s => { s.journal.unshift(deleted); });
                journalState.selectedId = deleted.id;
                renderView();
              },
              duration: 5000
            });
          }}, "Delete")
        ])
      ]));

      if (entry.prompt) {
        card.appendChild(util.el("div", { class: "journal-prompt" }, entry.prompt));
      }

      const titleInput = util.el("input", {
        class: "input", placeholder: "Title (optional)", value: entry.title,
        oninput: util.debounce((e) => {
          store.update(s => {
            const it = s.journal.find(x => x.id === entry.id);
            if (it) it.title = e.target.value;
          });
        }, 120)
      });
      card.appendChild(titleInput);

      const bodyArea = util.el("textarea", {
        class: "textarea journal-body",
        placeholder: "Write whatever needs to come out. Nothing leaves this device.",
        value: entry.body,
        oninput: util.debounce((e) => {
          store.update(s => {
            const it = s.journal.find(x => x.id === entry.id);
            if (it) it.body = e.target.value;
          });
        }, 140)
      });
      bodyArea.value = entry.body;
      card.appendChild(bodyArea);

      // Mood chips
      card.appendChild(util.el("div", { class: "field-label", text: "Mood tags" }));
      const moodRow = util.el("div", { class: "row-wrap" });
      MOOD_TAGS.forEach(m => moodRow.appendChild(ui.chip(m, {
        pressed: entry.mood.includes(m),
        onToggle: (on) => {
          store.update(s => {
            const it = s.journal.find(x => x.id === entry.id);
            if (!it) return;
            if (on && !it.mood.includes(m)) it.mood.push(m);
            else if (!on) it.mood = it.mood.filter(x => x !== m);
          });
          paintList();
        }
      })));
      card.appendChild(moodRow);

      // Linked book
      card.appendChild(util.el("div", { class: "field-label", text: "Linked book" }));
      const bookSel = util.el("select", { class: "select", style: { maxWidth: "360px" }, onchange: (e) => {
        store.update(s => {
          const it = s.journal.find(x => x.id === entry.id);
          if (it) it.bookId = e.target.value || null;
        });
        paintList();
      }});
      bookSel.appendChild(util.el("option", { value: "" }, "— none —"));
      BOOKS.forEach(b => bookSel.appendChild(util.el("option", { value: b.id, selected: entry.bookId === b.id ? "selected" : null }, b.title)));
      card.appendChild(bookSel);

      editorSide.appendChild(card);
    }

    setTimeout(() => { paintList(); paintEditor(); }, 0);
    return wrap;
  }

  /* -------------------- chat (Sara + Friends) -------------------- */
  const chatState = { active: "sara", friendId: null };

  function saraContextSummary() {
    const s = store.get();
    const profile = s.profile;
    const readingIds = Object.entries(s.bookStates).filter(([, v]) => v === "reading").map(([k]) => k);
    const wantIds    = Object.entries(s.bookStates).filter(([, v]) => v === "want").map(([k]) => k);
    return {
      profile,
      strictness: profile.warnStrict,
      topTags: ["tone", "kink", "dynamic", "trope"].flatMap(k => profile[k].slice(0, 2)),
      currentReading: readingIds.map(id => BOOKS.find(b => b.id === id)).filter(Boolean),
      wantToRead: wantIds.map(id => BOOKS.find(b => b.id === id)).filter(Boolean),
      excludes: profile.exclude
    };
  }

  function saraRespond(userText) {
    const text = userText.toLowerCase();
    const ctx = saraContextSummary();
    const s = store.get();
    const ranked = Engine.rankRecommendations(s.profile, s.weights);

    const bookMentioned = BOOKS.find(b =>
      text.includes(b.title.toLowerCase()) ||
      text.includes(b.title.toLowerCase().split(" ").slice(0, 2).join(" ").toLowerCase())
    );

    const replies = [];

    if (/\b(hi|hello|hey|good (morning|evening))\b/.test(text)) {
      replies.push(`Hi. I'm here whenever. No pressure to share anything you don't want to.`);
    }

    if (/\b(recommend|suggest|what should|pick|mood|tonight)\b/.test(text)) {
      const top = ranked.scored.slice(0, 3);
      if (top.length) {
        replies.push(`Based on your profile, my top three right now are: ${top.map(x => `**${x.book.title}** (${x.fitScore})`).join(", ")}.`);
        replies.push(`Tell me more about your mood — reflective? charged? just want something to hold your attention? — and I can narrow further.`);
      } else {
        replies.push(`Your current filters exclude everything in the catalogue. Want me to walk you through loosening one?`);
      }
    }

    if (/\bcompare\b/.test(text)) {
      replies.push(`I can do that. Open the Compare tab and pick two titles — I'll lay out scores, a radar, and a plain-language verdict.`);
    }

    if (/\b(reflect|journal|feel|felt|thought)\b/.test(text)) {
      replies.push(`The Journal is the right place for that — freeform or prompted entries, all private. Want me to suggest a reflection prompt?`);
    }

    if (/\b(safe|private|who|see|share|upload)\b/.test(text)) {
      replies.push(`Nothing you enter leaves this device. No server, no account, no tracking. If you're on a shared screen, toggle Discreet mode in the top bar.`);
    }

    if (bookMentioned) {
      const scored = Engine.compareBooks([bookMentioned.id], s.profile, s.weights)[0];
      replies.push(`**${bookMentioned.title}** lands at ${scored.fitScore} for you with ${scored.confidence}% confidence. ${scored.why.reasons[0] || "It matches your baseline without strong conflicts."}`);
      if (bookMentioned.content_warnings.length) {
        replies.push(`Worth flagging: it carries ${bookMentioned.content_warnings.length} content warning${bookMentioned.content_warnings.length > 1 ? "s" : ""} — ${bookMentioned.content_warnings.slice(0, 2).map(w => w.replace(/-/g, " ")).join(", ")}.`);
      }
    }

    if (/\b(why|how do you|explain|scor)/.test(text)) {
      replies.push(`Every score comes from your profile: numeric sliders (heat, consent, and so on) and tag overlaps (tone, kink, style). Weights are adjustable in your profile. Hard exclusions are absolute. Full explanation in the Transparency tab.`);
    }

    if (replies.length === 0) {
      // Generic supportive fallback
      const openers = [
        `I hear you. Tell me more about what you're looking for.`,
        `That's a lot to sit with. Do you want a recommendation, a reflection, or just to think out loud?`,
        `Noted. What would help most right now — picking something to read, comparing two titles, or logging a thought?`
      ];
      replies.push(openers[Math.floor(Math.random() * openers.length)]);
      if (ctx.currentReading.length) {
        replies.push(`You've got **${ctx.currentReading[0].title}** in progress. Want me to bring it back up, or set it aside for something new?`);
      }
    }

    return replies.join("\n\n");
  }

  function appendChatMessage(threadKey, friendId, role, text) {
    store.update(s => {
      if (threadKey === "sara") {
        s.chats.sara.push({ id: util.id("m"), role, text, ts: Date.now() });
      } else {
        const f = s.chats.friends.find(x => x.id === friendId);
        if (f) f.messages.push({ id: util.id("m"), role, text, ts: Date.now() });
      }
    });
  }

  function ensureSeedSara() {
    const s = store.get();
    if (s.chats.sara.length === 0) {
      appendChatMessage("sara", null, "sara",
        `Hi — I'm Sara. I'm a reading companion, not a recommender. Ask me what to read tonight, to compare two titles, or to help you journal a reaction. Everything here is private.`);
    }
  }

  function renderChat() {
    ensureSeedSara();
    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Chat" }),
        util.el("h1", { text: "Private conversations" }),
        util.el("p", { class: "lede", text: "Sara is your reading companion. Friends is an optional local-only space for sharing titles — nothing leaves this device." })
      ])
    ]));

    const shell = util.el("div", { class: "chat-shell" });
    const threads = util.el("div", { class: "chat-threads" });
    shell.appendChild(threads);

    const saraThread = util.el("div", { class: "chat-thread", "aria-current": chatState.active === "sara" ? "true" : null,
      onclick: () => { chatState.active = "sara"; chatState.friendId = null; paint(); }
    }, [
      util.el("div", { class: "chat-thread-name", text: "Sara" }),
      util.el("div", { class: "chat-thread-sub", text: "Your reading companion" })
    ]);
    threads.appendChild(saraThread);

    threads.appendChild(util.el("div", { class: "t-eyebrow", style: { padding: "var(--s-3) var(--s-2) var(--s-2)" }, text: "Friends" }));

    const friends = store.get().chats.friends;
    friends.forEach(f => {
      threads.appendChild(util.el("div", { class: "chat-thread",
        "aria-current": chatState.active === "friend" && chatState.friendId === f.id ? "true" : null,
        onclick: () => { chatState.active = "friend"; chatState.friendId = f.id; paint(); }
      }, [
        util.el("div", { class: "chat-thread-name", text: f.name }),
        util.el("div", { class: "chat-thread-sub", text: f.messages.length ? `${f.messages.length} message${f.messages.length > 1 ? "s" : ""}` : "New" })
      ]));
    });

    threads.appendChild(util.el("button", { class: "btn btn-sm btn-ghost", style: { marginTop: "var(--s-2)" },
      onclick: () => {
        ui.modal({
          title: "Add a friend",
          body: (() => {
            const div = util.el("div", { class: "stack" });
            div.appendChild(util.el("p", { class: "t-muted t-small", text: "Friends are local only — this is a private, single-device prototype of a social layer. No accounts, no syncing." }));
            const input = util.el("input", { class: "input", placeholder: "Display name", id: "friend-name-input" });
            div.appendChild(input);
            return div;
          })(),
          primary: { label: "Add", onClick: () => {
            const name = document.getElementById("friend-name-input")?.value.trim();
            if (!name) return;
            store.update(s => { s.chats.friends.push({ id: util.id("f"), name, messages: [] }); });
            ui.toast("Friend added locally");
            renderView();
          }},
          secondary: { label: "Cancel" }
        });
      }
    }, "+ Add friend"));

    const panel = util.el("div", { class: "chat-panel" });
    shell.appendChild(panel);
    wrap.appendChild(shell);

    function paint() {
      threads.querySelectorAll(".chat-thread").forEach(t => t.removeAttribute("aria-current"));
      if (chatState.active === "sara") saraThread.setAttribute("aria-current", "true");

      panel.innerHTML = "";
      if (chatState.active === "sara") paintSara(panel);
      else paintFriend(panel, chatState.friendId);
    }

    function paintSara(host) {
      const ctx = saraContextSummary();
      host.appendChild(util.el("div", { class: "chat-head" }, [
        util.el("div", {}, [
          util.el("div", { class: "t-serif", style: { fontSize: "17px" }, text: "Sara" }),
          util.el("div", { class: "t-small t-subtle", text: `Knows: warning strictness ${ctx.strictness}, ${ctx.topTags.length} tag preferences, ${ctx.currentReading.length} book${ctx.currentReading.length === 1 ? "" : "s"} in progress` })
        ]),
        util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => {
          store.update(s => { s.chats.sara = []; });
          ensureSeedSara();
          paintSara(host);
        } }, "Reset conversation")
      ]));

      const body = util.el("div", { class: "chat-body" });
      const msgs = store.get().chats.sara;
      msgs.forEach(m => body.appendChild(util.el("div", {
        class: "chat-msg " + (m.role === "user" ? "from-me" : "from-them"),
        html: m.text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      })));
      host.appendChild(body);

      const suggestions = util.el("div", { class: "chat-suggestions" });
      ["What should I read tonight?", "Compare two titles for me", "Why does Lumen score that way?", "How private is this?"].forEach(q => {
        suggestions.appendChild(util.el("button", { class: "chip", onclick: () => send(q) }, q));
      });
      host.appendChild(suggestions);

      const compose = util.el("form", { class: "chat-compose", onsubmit: (e) => { e.preventDefault(); const t = ta.value.trim(); if (t) send(t); } });
      const ta = util.el("textarea", { placeholder: "Message Sara…", onkeydown: (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const t = ta.value.trim(); if (t) send(t); }
      }});
      compose.appendChild(ta);
      compose.appendChild(util.el("button", { class: "btn btn-primary", type: "submit" }, "Send"));
      host.appendChild(compose);

      setTimeout(() => body.scrollTop = body.scrollHeight, 20);

      function send(text) {
        appendChatMessage("sara", null, "user", text);
        setTimeout(() => {
          appendChatMessage("sara", null, "sara", saraRespond(text));
          paintSara(host);
        }, 280);
        paintSara(host);
        ta.value = "";
      }
    }

    function paintFriend(host, friendId) {
      const f = store.get().chats.friends.find(x => x.id === friendId);
      if (!f) {
        host.appendChild(ui.empty({ title: "Pick or add a friend", message: "Conversations here stay on this device. There is no server." }));
        return;
      }
      host.appendChild(util.el("div", { class: "chat-head" }, [
        util.el("div", {}, [
          util.el("div", { class: "t-serif", style: { fontSize: "17px" }, text: f.name }),
          util.el("div", { class: "t-small t-subtle", text: "Local-only — nothing is sent." })
        ]),
        util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => {
          ui.modal({
            title: `Remove ${f.name}?`,
            body: "<p class=\"t-muted\">The conversation is deleted from this device.</p>",
            primary: { label: "Remove", onClick: () => {
              store.update(s => { s.chats.friends = s.chats.friends.filter(x => x.id !== f.id); });
              chatState.active = "sara"; chatState.friendId = null;
              renderView();
            }},
            secondary: { label: "Cancel" }
          });
        }}, "Remove")
      ]));

      const body = util.el("div", { class: "chat-body" });
      if (!f.messages.length) body.appendChild(util.el("div", { class: "t-small t-subtle", style: { textAlign: "center", padding: "var(--s-5)" }, text: "No messages yet. Start a conversation." }));
      f.messages.forEach(m => {
        if (m.role === "share" && m.bookId) {
          const book = BOOKS.find(b => b.id === m.bookId);
          if (book) {
            body.appendChild(util.el("div", { class: "book-share" }, [
              util.el("div", { class: "t-eyebrow", text: "Shared a title" }),
              util.el("div", { class: "t-serif", style: { fontSize: "15px", marginTop: "2px" }, text: book.title }),
              util.el("div", { class: "t-tiny t-subtle", text: book.author }),
              m.text ? util.el("div", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: m.text }) : null
            ].filter(Boolean)));
            return;
          }
        }
        body.appendChild(util.el("div", { class: "chat-msg " + (m.role === "user" ? "from-me" : "from-them"), text: m.text }));
      });
      host.appendChild(body);

      const tools = util.el("div", { class: "chat-suggestions" });
      tools.appendChild(util.el("button", { class: "chip", onclick: () => {
        ui.modal({
          title: `Share a title with ${f.name}`,
          body: (() => {
            const d = util.el("div", { class: "stack" });
            const sel = util.el("select", { class: "select", id: "share-book" });
            BOOKS.forEach(b => sel.appendChild(util.el("option", { value: b.id }, b.title)));
            const note = util.el("textarea", { class: "textarea", id: "share-note", placeholder: "Optional note…" });
            d.appendChild(sel); d.appendChild(note);
            return d;
          })(),
          primary: { label: "Share", onClick: () => {
            const bookId = document.getElementById("share-book").value;
            const text = document.getElementById("share-note").value;
            store.update(s => {
              const friend = s.chats.friends.find(x => x.id === f.id);
              friend.messages.push({ id: util.id("m"), role: "share", bookId, text, ts: Date.now() });
            });
            renderView();
          }},
          secondary: { label: "Cancel" }
        });
      }}, "Share a title"));

      host.appendChild(tools);

      const compose = util.el("form", { class: "chat-compose", onsubmit: (e) => {
        e.preventDefault();
        const t = ta.value.trim();
        if (!t) return;
        appendChatMessage("friend", f.id, "user", t);
        paintFriend(host, f.id);
        ta.value = "";
      }});
      const ta = util.el("textarea", { placeholder: `Message ${f.name}…` });
      compose.appendChild(ta);
      compose.appendChild(util.el("button", { class: "btn btn-primary", type: "submit" }, "Send"));
      host.appendChild(compose);

      setTimeout(() => body.scrollTop = body.scrollHeight, 20);
    }

    setTimeout(paint, 0);
    return wrap;
  }

  /* -------------------- compare -------------------- */
  const CMP_CATEGORIES = [
    { key: "heat",     label: "Heat",        group: "numeric" },
    { key: "explicit", label: "Explicit",    group: "numeric" },
    { key: "emotion",  label: "Emotion",     group: "numeric" },
    { key: "consent",  label: "Consent",     group: "numeric" },
    { key: "taboo",    label: "Taboo fit",   group: "numeric" },
    { key: "plot",     label: "Plot/scene",  group: "numeric" },
    { key: "tone",     label: "Tone",        group: "tag" },
    { key: "pacing",   label: "Pacing",      group: "tag" },
    { key: "style",    label: "Style",       group: "tag" },
    { key: "dynamic",  label: "Dynamic",     group: "tag" },
    { key: "trope",    label: "Tropes",      group: "tag" },
    { key: "kink",     label: "Kinks",       group: "tag" },
    { key: "orientation", label: "Orientation", group: "tag" }
  ];

  const cmpState = { a: null, b: null };

  function pickerSelect(side, value, onChange) {
    const sel = util.el("select", { class: "select", style: { minWidth: "260px" }, onchange: (e) => onChange(e.target.value || null) });
    sel.appendChild(util.el("option", { value: "" }, `Pick ${side === "a" ? "a first" : "a second"} title…`));
    BOOKS.forEach(b => sel.appendChild(util.el("option", { value: b.id, selected: value === b.id ? "selected" : null }, `${b.title} — ${b.author}`)));
    return sel;
  }

  function categoryBars(scored, side) {
    const wrap = util.el("div");
    CMP_CATEGORIES.forEach(cat => {
      const c = scored.contributions[cat.key];
      const pct = Math.round((c?.score ?? 0) * 100);
      const variant = pct >= 75 ? "good" : pct >= 40 ? "" : "warn";
      wrap.appendChild(util.el("div", { class: "cat-row" }, [
        util.el("div", { class: "cat-label", text: cat.label }),
        util.el("div", { class: "bar" + (variant ? ` ${variant}` : "") }, [
          util.el("span", { style: { width: `${pct}%` } })
        ]),
        util.el("div", { class: "cat-val", text: `${pct}` })
      ]));
    });
    return wrap;
  }

  function radarSVG(scoredA, scoredB, size = 320) {
    const cats = CMP_CATEGORIES;
    const cx = size / 2, cy = size / 2;
    const r = size / 2 - 28;
    const N = cats.length;
    const angle = (i) => (-Math.PI / 2) + (i / N) * (Math.PI * 2);
    const pt = (i, v) => [cx + Math.cos(angle(i)) * r * v, cy + Math.sin(angle(i)) * r * v];

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "auto");
    svg.style.maxWidth = `${size}px`;

    // Web rings
    [0.25, 0.5, 0.75, 1].forEach(ring => {
      const pts = cats.map((_, i) => pt(i, ring).join(",")).join(" ");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts);
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "var(--border)");
      poly.setAttribute("stroke-width", "1");
      svg.appendChild(poly);
    });
    // Axis lines + labels
    cats.forEach((cat, i) => {
      const [x, y] = pt(i, 1);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", cx); line.setAttribute("y1", cy);
      line.setAttribute("x2", x);  line.setAttribute("y2", y);
      line.setAttribute("stroke", "var(--border)");
      line.setAttribute("stroke-width", "1");
      svg.appendChild(line);
      const [lx, ly] = pt(i, 1.12);
      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", lx); txt.setAttribute("y", ly);
      txt.setAttribute("fill", "var(--text-subtle)");
      txt.setAttribute("font-size", "10");
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("dominant-baseline", "middle");
      txt.textContent = cat.label;
      svg.appendChild(txt);
    });

    function plot(scored, color, fillOpacity) {
      const pts = cats.map((c, i) => pt(i, scored.contributions[c.key]?.score ?? 0).join(",")).join(" ");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts);
      poly.setAttribute("fill", color);
      poly.setAttribute("fill-opacity", String(fillOpacity));
      poly.setAttribute("stroke", color);
      poly.setAttribute("stroke-width", "1.5");
      svg.appendChild(poly);
    }
    if (scoredA) plot(scoredA, "var(--accent)", 0.22);
    if (scoredB) plot(scoredB, "var(--info)",   0.22);

    return svg;
  }

  function aiAnalysis(a, b, profile) {
    if (!a || !b) return null;
    const diff = (k) => ((a.contributions[k]?.score || 0) - (b.contributions[k]?.score || 0));

    const stronger = a.fitScore === b.fitScore
      ? null
      : (a.fitScore > b.fitScore ? a : b);
    const weaker = stronger === a ? b : (stronger === b ? a : null);
    const gap = Math.abs(a.fitScore - b.fitScore);

    const verdict = (() => {
      if (!stronger) return `Both titles land at ${a.fitScore}. On raw fit, they're indistinguishable — so the choice becomes about what you're in the mood for.`;
      if (gap <= 5)  return `Close call. ${stronger.book.title} edges ahead by ${gap} points, but either is defensible.`;
      if (gap <= 15) return `${stronger.book.title} is a clearer fit (${stronger.fitScore} vs ${weaker.fitScore}). ${weaker.book.title} is still viable if its particular texture appeals.`;
      return `${stronger.book.title} is the stronger match by a wide margin (${stronger.fitScore} vs ${weaker.fitScore}). ${weaker.book.title} would be a substantial deviation from your stated profile.`;
    })();

    const differences = [];
    const pushDiff = (key, label, formatA, formatB) => {
      const sa = a.contributions[key]?.score || 0;
      const sb = b.contributions[key]?.score || 0;
      if (Math.abs(sa - sb) < 0.25) return;
      const leader = sa > sb ? a : b;
      const lag    = sa > sb ? b : a;
      differences.push(`${leader.book.title} fits ${label} better — ${formatA(leader.book)} vs ${formatB(lag.book)}.`);
    };
    pushDiff("heat",    "on heat",        (x) => `${x.heat_level}/5`,      (x) => `${x.heat_level}/5`);
    pushDiff("emotion", "on emotional intensity", (x) => `${x.emotional_intensity}/5`, (x) => `${x.emotional_intensity}/5`);
    pushDiff("consent", "on consent clarity", (x) => `clarity ${x.consent_clarity}/5`, (x) => `clarity ${x.consent_clarity}/5`);
    pushDiff("plot",    "on story architecture", (x) => `plot weight ${x.plot_weight}/5`, (x) => `plot weight ${x.plot_weight}/5`);

    const tradeoffs = [];
    if (a.criticallyWarned || b.criticallyWarned) {
      const flagged = a.criticallyWarned ? a.book.title : b.book.title;
      tradeoffs.push(`${flagged} carries a critical warning. Treat this as an informed choice, not a recommendation.`);
    }
    if (a.warnPenalty > 1 || b.warnPenalty > 1) {
      tradeoffs.push(`Warning strictness (${profile.warnStrict}) is depressing at least one score; loosening it in your profile would change this comparison.`);
    }
    if (a.confidence < 60 || b.confidence < 60) {
      const low = a.confidence < b.confidence ? a : b;
      tradeoffs.push(`Confidence on ${low.book.title} is ${low.confidence}%. Metadata may be thin, or your taste profile doesn't give it many signals to match against.`);
    }

    const bestFor = (scored) => {
      const top = Object.entries(scored.contributions)
        .filter(([, v]) => v.score >= 0.75)
        .sort((x, y) => y[1].contrib - x[1].contrib)
        .slice(0, 3)
        .map(([k]) => CMP_CATEGORIES.find(c => c.key === k)?.label || k);
      if (top.length === 0) return `a gentle middle-of-the-road choice across your preferences`;
      return `readers who want ${top.join(", ").toLowerCase()}`;
    };

    const ifYouLiked = stronger
      ? `If ${stronger.book.title} lands for you, ${weaker.book.title} may feel like a softer or sharper echo depending on which dimensions you weigh most.`
      : `Since these two are tied on raw fit, think about which one better matches tonight's mood.`;

    const thinMetadata = (a.confidence + b.confidence) / 2 < 55;

    return {
      verdict,
      differences: differences.slice(0, 4),
      tradeoffs,
      bestForA: bestFor(a),
      bestForB: bestFor(b),
      ifYouLiked,
      thinMetadata
    };
  }

  function cmpCard(scored) {
    const book = scored.book;
    const card = util.el("div", { class: "card card-raised stack" });
    card.appendChild(util.el("div", { class: "t-eyebrow", text: util.humanise(book.category) }));
    card.appendChild(util.el("h3", { class: "t-serif", text: book.title }));
    card.appendChild(util.el("div", { class: "t-small t-subtle", text: `${book.author} · ${util.fmtYear(book.year)}` }));
    card.appendChild(util.el("div", { class: "cmp-head", style: { marginTop: "var(--s-4)" } }, [
      util.el("div", {}, [
        util.el("div", { class: "cmp-score-sub", text: "Fit score" }),
        util.el("div", { class: "cmp-score", text: `${scored.fitScore}` })
      ]),
      util.el("div", { style: { textAlign: "right" } }, [
        util.el("div", { class: "cmp-score-sub", text: "Confidence" }),
        util.el("div", { class: "t-mono", style: { fontSize: "20px" }, text: `${scored.confidence}%` })
      ])
    ]));
    card.appendChild(util.el("div", { class: "bar", style: { marginTop: "var(--s-3)" } }, [
      util.el("span", { style: { width: `${scored.confidence}%` } })
    ]));
    card.appendChild(util.el("div", { class: "field-label", style: { marginTop: "var(--s-4)" }, text: "Category breakdown" }));
    card.appendChild(categoryBars(scored));
    return card;
  }

  function renderCompare() {
    const s = store.get();
    // Seed from Library deep-link
    const seed = sessionStorage.getItem("lumen:compare-seed");
    if (seed) { cmpState.a = cmpState.a || seed; sessionStorage.removeItem("lumen:compare-seed"); }

    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Compare" }),
        util.el("h1", { text: "Side by side" }),
        util.el("p", { class: "lede", text: "Pick two titles. You'll get weighted scores, category-by-category bars, a radar shape, and a plain-language verdict — all against your profile." })
      ])
    ]));

    const pickers = util.el("div", { class: "card", style: { padding: "var(--s-4)" } });
    const pickerRow = util.el("div", { class: "row-wrap" });
    pickerRow.appendChild(pickerSelect("a", cmpState.a, (v) => { cmpState.a = v; paint(); }));
    pickerRow.appendChild(pickerSelect("b", cmpState.b, (v) => { cmpState.b = v; paint(); }));
    pickerRow.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", onclick: () => { cmpState.a = null; cmpState.b = null; paint(); } }, "Clear"));
    pickers.appendChild(pickerRow);
    wrap.appendChild(pickers);

    const body = util.el("div", { id: "cmp-body", class: "stack-lg" });
    wrap.appendChild(body);

    function paint() {
      body.innerHTML = "";
      if (!cmpState.a && !cmpState.b) {
        body.appendChild(ui.empty({
          title: "Choose two titles to compare",
          message: "Scores are evaluated against your current profile. Change your profile and the picture changes."
        }));
        return;
      }

      const scoredList = Engine.compareBooks([cmpState.a, cmpState.b].filter(Boolean), s.profile, s.weights);
      const scoredA = scoredList.find(x => x.book.id === cmpState.a);
      const scoredB = scoredList.find(x => x.book.id === cmpState.b);

      if (!scoredA || !scoredB) {
        body.appendChild(ui.empty({
          title: "One more to go",
          message: `${scoredA ? scoredB ? "" : "Pick a second title." : "Pick a first title."}`
        }));
        if (scoredA || scoredB) body.appendChild(cmpCard(scoredA || scoredB));
        return;
      }

      // Scorecards side by side
      const grid = util.el("div", { class: "cmp-grid" });
      grid.appendChild(cmpCard(scoredA));
      grid.appendChild(cmpCard(scoredB));
      body.appendChild(grid);

      // Radar + legend
      const radarCard = util.el("div", { class: "card" });
      radarCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Shape of the fit" }),
        util.el("span", { class: "card-sub t-subtle", text: "Each axis is one scored dimension" })
      ]));
      const radarBox = util.el("div", { class: "radar-wrap" });
      radarBox.appendChild(radarSVG(scoredA, scoredB, 340));
      radarCard.appendChild(radarBox);
      radarCard.appendChild(util.el("div", { class: "radar-legend" }, [
        util.el("span", {}, [util.el("span", { class: "swatch", style: { background: "var(--accent)" } }), scoredA.book.title]),
        util.el("span", {}, [util.el("span", { class: "swatch", style: { background: "var(--info)" } }),  scoredB.book.title])
      ]));
      body.appendChild(radarCard);

      // AI Analysis
      const ai = aiAnalysis(scoredA, scoredB, s.profile);
      const aiCard = util.el("div", { class: "card stack" });
      aiCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Analysis" }),
        util.el("div", { class: "row" }, [
          util.el("span", { class: "card-sub t-subtle", text: "Advisory, not authoritative" }),
          util.el("button", { class: "btn btn-sm", onclick: () => {
            saveAnalysis({
              titleA: scoredA.book.title,
              titleB: scoredB.book.title,
              fitA: scoredA.fitScore,
              fitB: scoredB.fitScore,
              verdict: ai.verdict
            });
          }}, "Save to Vault")
        ])
      ]));
      aiCard.appendChild(util.el("div", { class: "verdict" }, [
        util.el("div", { class: "t-eyebrow", text: "Verdict" }),
        util.el("p", { style: { marginTop: "var(--s-2)", fontSize: "15px", lineHeight: "1.55" }, text: ai.verdict })
      ]));

      if (ai.differences.length) {
        aiCard.appendChild(util.el("div", {}, [
          util.el("div", { class: "field-label", text: "Where they diverge" }),
          util.el("ul", { style: { paddingLeft: "var(--s-4)" } }, ai.differences.map(d => util.el("li", { class: "t-muted t-small", style: { marginTop: "4px" }, text: d })))
        ]));
      }

      const bestForGrid = util.el("div", { class: "cmp-grid" });
      bestForGrid.appendChild(util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: `${scoredA.book.title} · best for` }),
        util.el("p", { class: "t-muted", style: { marginTop: "var(--s-2)" }, text: ai.bestForA })
      ]));
      bestForGrid.appendChild(util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: `${scoredB.book.title} · best for` }),
        util.el("p", { class: "t-muted", style: { marginTop: "var(--s-2)" }, text: ai.bestForB })
      ]));
      aiCard.appendChild(bestForGrid);

      if (ai.tradeoffs.length) {
        ai.tradeoffs.forEach(t => aiCard.appendChild(util.el("div", { class: t.startsWith("critical") || t.includes("critical") ? "caution" : "tradeoff" }, t)));
      }
      aiCard.appendChild(util.el("p", { class: "t-muted t-small", text: ai.ifYouLiked }));
      if (ai.thinMetadata) {
        aiCard.appendChild(util.el("div", { class: "tradeoff" }, "Confidence is moderate on both — metadata is thin or your profile has few expressed tastes. Take the verdict with a grain of salt."));
      }

      body.appendChild(aiCard);
    }

    setTimeout(paint, 0);
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
      return renderCompare();
    },

    chat() {
      return renderChat();
    },

    journal() {
      return renderJournal();
    },

    vault() {
      return renderVault();
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

    // Blur-on-blur privacy: user-opt-in via Vault > Privacy tools
    window.addEventListener("blur", () => {
      if (store.get().ui.privacyBlur) document.body.setAttribute("data-privacy-blur", "on");
    });
    window.addEventListener("focus", () => {
      document.body.removeAttribute("data-privacy-blur");
    });
    document.addEventListener("click", (e) => {
      if (document.body.getAttribute("data-privacy-blur") === "on") {
        e.preventDefault();
        document.body.removeAttribute("data-privacy-blur");
      }
    }, true);

    adultGate();
  }

  // Expose a small surface for later batches to hook into.
  window.Lumen = { store, router, ui, util, views, ROUTES };
  document.addEventListener("DOMContentLoaded", boot);
})();
