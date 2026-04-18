/* ============================================================
   Lumen — Application (Batch 1)
   Modules: util, store, router, ui, views/*
   All state is local. No network calls.
   ============================================================ */
(function () {
  "use strict";

  // Catalogue is no longer hard-coded. BOOKS is kept in the destructure
  // but resolves to an empty array from data.js; every surface now reads
  // from user state via listAllBooks() / findBook(). SEED_BOOKS is the
  // opt-in starter library, loaded explicitly from Settings.
  const { BOOKS, SEED_BOOKS, VOCAB, SCENARIOS, DEFAULT_WEIGHTS, DEFAULT_PROFILE, READING_STATES, ALL_WARNINGS } = window.LumenData;
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
      hidden: {},
      discovered: [],
      journal: [],
      vault: { pinned: [], analyses: [], notes: [], locked: false, passcodeHash: null },
      chats: { sara: [], friends: [] },
      ui: {
        theme: "rose",
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
    { id: "discover",     label: "Home",          short: "Home",     group: "main",     render: () => views.discover() },
    { id: "discovery",    label: "Discovery",     short: "Discover", group: "main",     render: () => views.discovery() },
    { id: "library",      label: "Library",       short: "Library",  group: "main",     render: () => views.library() },
    { id: "compare",      label: "Compare",       short: "Compare",  group: "main",     render: () => views.compare() },
    { id: "chat",         label: "Connections",   short: "Connect",  group: "main",     render: () => views.chat() },
    { id: "journal",      label: "Journal",       short: "Journal",  group: "personal", render: () => views.journal() },
    { id: "vault",        label: "Vault",         short: "Vault",    group: "personal", render: () => views.vault() },
    { id: "profile",      label: "Profile",       short: "Profile",  group: "settings", render: () => views.profile() },
    { id: "settings",     label: "Settings",      short: "Settings", group: "settings", render: () => views.settings() },
    { id: "transparency", label: "Transparency",  short: "Trust",    group: "settings", render: () => views.transparency() }
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
      class: "book-card",
      href: "#",
      style: { textDecoration: "none", color: "inherit" },
      onclick: (e) => { e.preventDefault(); onClick && onClick(scored); }
    });
    // Steam Engine
    card.appendChild(util.el("div", { class: "steam-indicator " + steamClass(book.heat_level) }));
    card.appendChild(util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
      util.el("div", { style: { minWidth: 0 } }, [
        util.el("div", { class: "t-eyebrow", text: util.humanise(book.subgenre || "") }),
        util.el("h4", { text: book.title, style: { marginTop: "2px" } }),
        util.el("div", { class: "author", text: `${book.author} · ${util.fmtYear(book.year)}` })
      ]),
      util.el("div", { style: { textAlign: "right", flexShrink: "0" } }, [
        util.el("div", { class: "t-mono", style: { fontSize: "22px", color: "var(--accent)" }, text: `${fitScore}` }),
        util.el("div", { class: "t-tiny t-subtle", text: `${confidence}% conf.` })
      ])
    ]));
    card.appendChild(util.el("p", { class: "blurb", text: book.description }));
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
    const pool = listAllBooks();
    host.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Live preview" }),
      util.el("span", { class: "card-sub t-subtle", text: pool.length ? `${pool.length} saved title${pool.length === 1 ? "" : "s"}` : "no saved titles yet" })
    ]));
    if (!pool.length) {
      host.appendChild(ui.empty({
        title: "Your library is empty",
        message: "Add books from Discovery or load the starter library in Settings to see how your profile ranks them.",
        actions: [
          { label: "Open Discovery", variant: "btn-primary", onClick: () => router.go("discovery") },
          { label: "Open Settings",  variant: "btn",         onClick: () => router.go("settings") }
        ]
      }));
      return;
    }
    const result = Engine.rankRecommendations(s.profile, s.weights, pool);
    const top = result.scored.slice(0, 3);
    const matchLine = util.el("div", { class: "t-small t-subtle", style: { marginTop: "var(--s-1)" }, text: `${result.matched} of ${result.screened} pass your filters` });
    host.appendChild(matchLine);
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

  // User-state-backed book model. Two possible shapes are stored in
  // s.discovered: (a) rich seed entries that came from Settings →
  // "Load starter library" and carry full engine-scoring metadata, and
  // (b) lightweight entries from a Discovery web search with the
  // Claude-analyzed fields. discoveredAsBook normalises either into a
  // book-like object the rest of the app can reason about.
  function discoveredAsBook(d) {
    const isRichSeed = d && Array.isArray(d.content_warnings) && d.heat_level != null && Array.isArray(d.tone);
    if (isRichSeed) {
      return Object.assign({}, d, {
        _seed: d.source === "seed",
        _discovered: d.source !== "seed"
      });
    }
    return {
      id: d.id,
      title: d.title,
      author: d.author,
      year: parseInt(d.year, 10) || 0,
      description: d.description || "",
      category: "web-discovered",
      subgenre: "",
      heat_level: d.heat || 3,
      explicitness: d.heat || 3,
      emotional_intensity: 3,
      consent_clarity: 3,
      taboo_level: 2,
      plot_weight: 3,
      tone: [], pacing: [], literary_style: [],
      relationship_dynamic: [], trope_tags: d.tropes || [],
      kink_tags: [], gender_pairing: [], orientation_tags: [],
      content_warnings: [],
      source: d.source || "Google Books",
      source_url: d.sourceUrl || null,
      thumbnail: d.thumbnail || null,
      aiInsight: d.aiInsight || null,
      _discovered: true
    };
  }
  function findBook(bookId) {
    const d = (store.get().discovered || []).find(x => x.id === bookId);
    return d ? discoveredAsBook(d) : null;
  }
  function listAllBooks() {
    return (store.get().discovered || []).map(discoveredAsBook);
  }
  // Books the user has explicitly saved — currently the same as
  // listAllBooks() minus hidden. Compare will restrict to this set.
  function listSavedBooks() {
    const hidden = store.get().hidden || {};
    return listAllBooks().filter(b => !hidden[b.id]);
  }
  function isHidden(bookId) {
    return !!store.get().hidden[bookId];
  }

  // Seed-loading. Pulls the starter library out of SEED_BOOKS and
  // appends any titles the user doesn't already have in state.
  function loadStarterLibrary() {
    const state = store.get();
    const haveIds = new Set((state.discovered || []).map(d => d.id));
    const fresh = (SEED_BOOKS || []).filter(b => !haveIds.has(b.id));
    if (!fresh.length) return 0;
    store.update(st => {
      st.discovered = st.discovered || [];
      fresh.forEach(b => {
        st.discovered.push(Object.assign({}, b, { source: "seed", addedAt: Date.now() }));
      });
    });
    return fresh.length;
  }
  function unloadStarterLibrary() {
    const state = store.get();
    const seedIds = new Set((state.discovered || []).filter(d => d.source === "seed").map(d => d.id));
    if (!seedIds.size) return 0;
    store.update(st => {
      st.discovered = (st.discovered || []).filter(d => d.source !== "seed");
      seedIds.forEach(id => {
        delete st.bookStates[id];
        delete st.tags[id];
        delete st.hidden[id];
      });
    });
    return seedIds.size;
  }
  function hasStarterLibraryLoaded() {
    return (store.get().discovered || []).some(d => d.source === "seed");
  }

  function dismissFromLibrary(bookId) {
    const s = store.get();
    const isDiscovered = (s.discovered || []).some(d => d.id === bookId);
    const snapshot = {
      discovered: isDiscovered ? s.discovered.find(d => d.id === bookId) : null,
      bookState: s.bookStates[bookId],
      tags: s.tags[bookId] ? [...s.tags[bookId]] : null,
      hidden: !!s.hidden[bookId]
    };
    store.update(st => {
      if (isDiscovered) {
        st.discovered = (st.discovered || []).filter(d => d.id !== bookId);
      }
      st.hidden[bookId] = true;
      delete st.bookStates[bookId];
      delete st.tags[bookId];
    });
    return snapshot;
  }

  function restoreDismissed(bookId, snapshot) {
    store.update(st => {
      delete st.hidden[bookId];
      if (snapshot) {
        if (snapshot.discovered) {
          st.discovered = st.discovered || [];
          if (!st.discovered.some(d => d.id === bookId)) st.discovered.unshift(snapshot.discovered);
        }
        if (snapshot.bookState) st.bookStates[bookId] = snapshot.bookState;
        if (snapshot.tags && snapshot.tags.length) st.tags[bookId] = snapshot.tags;
      }
    });
  }

  function unhideBook(bookId) {
    store.update(st => { delete st.hidden[bookId]; });
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
    const card = util.el("div", { class: "book-card has-dismiss",
      onclick: () => openBookDetail(book.id)
    });
    // Dismiss control — top-right. Confirmation is handled inline via undo toast.
    card.appendChild(util.el("button", {
      class: "card-dismiss",
      "aria-label": `Dismiss ${book.title}`,
      title: "Dismiss from library",
      onclick: (e) => {
        e.stopPropagation();
        const snapshot = dismissFromLibrary(book.id);
        ui.toast(`Dismissed ${book.title}`, {
          action: "Undo",
          onAction: () => { restoreDismissed(book.id, snapshot); renderView(); },
          duration: 5000
        });
        renderView();
      }
    }, "×"));
    // Steam Engine — heat-level indicator bar
    card.appendChild(util.el("div", { class: "steam-indicator " + steamClass(book.heat_level) }));
    const head = util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
      util.el("div", { class: "t-eyebrow", text: util.humanise(book.category) }),
      scored ? util.el("div", { class: "t-mono", style: { color: "var(--accent)", fontSize: "18px" }, text: `${scored.fitScore}` }) : null
    ].filter(Boolean));
    card.appendChild(head);
    card.appendChild(util.el("h4", { text: book.title }));
    card.appendChild(util.el("div", { class: "author", text: `${book.author} · ${util.fmtYear(book.year)}` }));
    card.appendChild(util.el("p", { class: "blurb", text: (book.description || "").slice(0, 160) + ((book.description || "").length > 160 ? "…" : "") }));
    const badges = util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-3)" } });
    const rsBadge = readingStateBadge(book.id);
    if (rsBadge) badges.appendChild(rsBadge);
    if (book._discovered) badges.appendChild(ui.tag("from discovery", "accent"));
    if ((book.content_warnings || []).length) badges.appendChild(ui.tag(`${book.content_warnings.length} warning${book.content_warnings.length > 1 ? "s" : ""}`, "warn"));
    if (scored && scored.confidence < 60) badges.appendChild(ui.tag(`low confidence`, "danger"));
    card.appendChild(badges);
    return card;
  }

  function openBookDetail(bookId) {
    const book = findBook(bookId);
    if (!book) return;
    const s = store.get();
    // Score the book against the user's profile, pulling book data
    // exclusively from user state (no hard-coded catalogue).
    const pool = listAllBooks();
    const scored = pool.some(b => b.id === bookId)
      ? Engine.compareBooks([bookId], s.profile, s.weights, pool)[0]
      : null;
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
    const hidden = s.hidden || {};
    const allBooks = listAllBooks().filter(b => !hidden[b.id]);
    const totalVisible = allBooks.length;
    const discoveredCount = (s.discovered || []).filter(d => !hidden[d.id]).length;
    const ranked = Engine.rankRecommendations(s.profile, s.weights, allBooks);
    const scoredMap = Object.fromEntries(ranked.scored.map(x => [x.book.id, x]));

    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Library" }),
        util.el("h1", { html: "Your saved <em>collection</em>" }),
        util.el("p", { class: "lede", text: totalVisible
          ? `${totalVisible} title${totalVisible === 1 ? "" : "s"}${discoveredCount ? ` · ${discoveredCount} from Discovery` : ""} · dismiss anything that doesn't belong`
          : "Nothing saved yet — add titles from Discovery or load the starter library from Settings." })
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

    const categories = ["all", ...new Set(allBooks.map(b => b.category))];
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
      let filtered = allBooks.filter(b => {
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
        if (libState.sort === "year")  return (a.year || 0) - (b.year || 0);
        return 0;
      });

      const excluded = allBooks.length - Engine.applyHardExclusions(allBooks, Engine.normalizeProfile(s.profile)).length;
      const hiddenCount = Object.keys(hidden).length;
      stats.innerHTML = "";
      stats.appendChild(util.el("span", {}, `Showing ${filtered.length} of ${allBooks.length}`));
      if (excluded > 0)   stats.appendChild(util.el("span", { class: "tag tag-warn" }, `${excluded} excluded by your filters`));
      if (hiddenCount)    stats.appendChild(util.el("a", { class: "tag tag-accent", href: "#/settings", style: { textDecoration: "none" } }, `${hiddenCount} dismissed — restore in Settings`));

      grid.innerHTML = "";
      if (!filtered.length) {
        if (allBooks.length === 0) {
          grid.appendChild(ui.empty({
            title: "Your library is empty",
            message: "Lumen has nothing saved yet. Search the web from Discovery to add titles, or load the starter library of historical classics from Settings.",
            actions: [
              { label: "Open Discovery", variant: "btn-primary", onClick: () => router.go("discovery") },
              { label: "Open Settings",  variant: "btn",         onClick: () => router.go("settings") }
            ]
          }));
        } else {
          grid.appendChild(ui.empty({ title: "Nothing matches those filters", message: "Try clearing the search or reading-state filter." }));
        }
        return;
      }
      filtered.forEach(b => grid.appendChild(bookCardFull(b, scoredMap[b.id])));
    }

    setTimeout(updateGrid, 0);
    return wrap;
  }

  /* -------------------- discovery (web search + Claude) -------------------- */
  const discoveryState = {
    lastQuery: "",
    raw: [],        // Google Books results in insertion order
    enrichments: {} // id -> { heat, tropes, insight } | { error: true, message }
  };

  function steamClass(heat) {
    if (heat >= 4) return "steam-high";
    if (heat >= 3) return "steam-med";
    return "steam-low";
  }

  function renderDiscovery() {
    const Disco = window.LumenDiscovery;
    const wrap = util.el("div", { class: "page stack-lg" });

    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Discovery" }),
        util.el("h1", { html: "Search the web. <em>Ask</em> the engine." }),
        util.el("p", { class: "lede", text: "Pull real titles from Google Books, have Claude read each blurb, and drop what resonates straight into your library." })
      ])
    ]));

    // Hero search — full-width, no sidebar
    const hero = util.el("div", { class: "disco-hero" });
    const searchInput = util.el("input", {
      class: "disco-hero-input",
      placeholder: "Search titles, authors, or topics…",
      value: discoveryState.lastQuery,
      onkeydown: (e) => { if (e.key === "Enter") runSearch(); }
    });
    const searchBtn = util.el("button", { class: "btn btn-primary btn-lg", onclick: () => runSearch() }, "Search & analyze");
    const statusBadge = util.el("div", { id: "api-status", class: "api-status status-idle", text: Disco.message });

    hero.appendChild(util.el("div", { class: "disco-hero-row" }, [
      searchInput,
      searchBtn,
      statusBadge
    ]));

    const hint = util.el("div", { class: "disco-hero-hint" });
    if (!Disco.getApiKey()) {
      hint.appendChild(util.el("span", { text: "Heads up —" }));
      hint.appendChild(util.el("a", { href: "#/settings" }, "add your Claude key in Settings"));
      hint.appendChild(util.el("span", { text: "to enable AI analysis." }));
    } else {
      hint.appendChild(util.el("span", { text: "Returns up to six books from Google Books · Claude analyzes each for heat, tropes, and one calm insight." }));
    }
    hero.appendChild(hint);
    wrap.appendChild(hero);

    // Results grid — full width
    const resultsHead = util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } });
    const resultsLabel = util.el("div", { class: "t-small t-subtle", id: "disco-count", text: "No search yet" });
    resultsHead.appendChild(resultsLabel);
    if (discoveryState.raw.length) {
      resultsHead.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
        discoveryState.raw = [];
        discoveryState.enrichments = {};
        discoveryState.lastQuery = "";
        renderView();
      }}, "Clear results"));
    }
    wrap.appendChild(resultsHead);

    const grid = util.el("div", { class: "discovery-grid", id: "disco-grid" });
    wrap.appendChild(grid);

    // Status updates
    const unsub = Disco.onStatus((s) => {
      statusBadge.className = `api-status status-${s.status}`;
      statusBadge.textContent = s.lastMessage;
    });
    // Re-render will drop the old node; we detach on a router change via a best-effort weak cleanup
    setTimeout(() => {
      if (!document.body.contains(statusBadge)) unsub();
    }, 60_000);

    // Initial paint from cached results (if any)
    if (discoveryState.raw.length) paintGrid();
    else {
      grid.appendChild(util.el("div", { class: "discovery-empty" }, [
        util.el("h3", { class: "t-serif", style: { fontSize: "18px", color: "var(--accent)" }, text: "Discovery waits for your query" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: "Search the sidebar and Claude will analyze each blurb as it arrives. Set your API key in Settings first." })
      ]));
    }

    function paintGrid() {
      grid.innerHTML = "";
      if (!discoveryState.raw.length) {
        grid.appendChild(util.el("div", { class: "discovery-empty" }, [
          util.el("h3", { class: "t-serif", style: { fontSize: "18px", color: "var(--accent)" }, text: "No results" }),
          util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: "Try a different title, author, or keyword." })
        ]));
        return;
      }
      discoveryState.raw.forEach(book => grid.appendChild(renderDiscoCard(book)));
      resultsLabel.textContent = `${discoveryState.raw.length} result${discoveryState.raw.length === 1 ? "" : "s"} for "${discoveryState.lastQuery}"`;
    }

    async function runSearch() {
      const q = searchInput.value.trim();
      if (!q) { ui.toast("Enter a title, author, or topic"); return; }
      if (!Disco.getApiKey()) {
        ui.toast("Add your Claude API key in Settings first", {
          action: "Open Settings",
          onAction: () => router.go("settings"),
          duration: 4500
        });
        return;
      }

      discoveryState.lastQuery = q;
      discoveryState.raw = [];
      discoveryState.enrichments = {};
      grid.innerHTML = "";
      resultsLabel.textContent = `Searching Google Books for "${q}"…`;

      let items;
      try {
        items = await Disco.searchBooks(q);
      } catch (err) {
        const message = (err && err.message) || "Search failed";
        const isQuota = err && err.code === "quota";
        console.error("[Lumen Discovery] Search failed:", err);
        resultsLabel.textContent = `Search failed for "${q}"`;
        grid.innerHTML = "";
        const emptyNode = util.el("div", { class: "discovery-empty" }, [
          util.el("h3", { class: "t-serif", style: { fontSize: "18px", color: "var(--accent)" },
            text: isQuota ? "Google Books is rate-limiting this network" : "Couldn't reach Google Books" }),
          util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)", maxWidth: "52ch", marginLeft: "auto", marginRight: "auto" }, text: message })
        ]);
        if (isQuota) {
          emptyNode.appendChild(util.el("p", { class: "t-tiny t-subtle", style: { marginTop: "var(--s-3)", maxWidth: "52ch", marginLeft: "auto", marginRight: "auto" },
            text: "Anonymous Google Books usage caps at roughly 1,000 searches per day, shared across everyone on the same IP. Paste a free Google Books API key in Settings and you'll get your own quota (~100,000/day)." }));
          emptyNode.appendChild(util.el("div", { class: "row", style: { justifyContent: "center", gap: "var(--s-2)", marginTop: "var(--s-3)" } }, [
            util.el("button", { class: "btn btn-primary btn-sm", onclick: () => router.go("settings") }, "Open Settings"),
            util.el("button", { class: "btn btn-ghost btn-sm", onclick: () => runSearch() }, "Try again")
          ]));
        } else {
          emptyNode.appendChild(util.el("p", { class: "t-tiny t-subtle", style: { marginTop: "var(--s-3)" }, text: "Most often this is a network hiccup or a browser extension blocking googleapis.com. The full error is in your console." }));
          emptyNode.appendChild(util.el("button", { class: "btn btn-primary btn-sm", style: { marginTop: "var(--s-3)" }, onclick: () => runSearch() }, "Try again"));
        }
        grid.appendChild(emptyNode);
        return;
      }

      if (!items.length) {
        resultsLabel.textContent = `No results for "${q}"`;
        grid.appendChild(util.el("div", { class: "discovery-empty" }, [
          util.el("h3", { class: "t-serif", style: { fontSize: "18px", color: "var(--accent)" }, text: "Nothing turned up" }),
          util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: "Try a different keyword, an author surname, or a more specific title." })
        ]));
        return;
      }

      discoveryState.raw = items;
      paintGrid();

      // Analyse sequentially so the status badge narrates progress
      for (const book of items) {
        try {
          const result = await Disco.analyzeWithClaude(book);
          discoveryState.enrichments[book.id] = result;
        } catch (err) {
          discoveryState.enrichments[book.id] = { error: true, message: err.message || "failed" };
        }
        const node = document.querySelector(`[data-disco-id="${book.id}"]`);
        if (node) node.replaceWith(renderDiscoCard(book));
      }
    }

    function renderDiscoCard(book) {
      const enrich = discoveryState.enrichments[book.id];
      const heat = enrich && !enrich.error ? enrich.heat : null;
      const card = util.el("div", { class: "disco-card has-dismiss", "data-disco-id": book.id });

      // Dismiss — drops this card from the current results feed
      card.appendChild(util.el("button", {
        class: "card-dismiss",
        "aria-label": `Dismiss ${book.title}`,
        title: "Dismiss from results",
        onclick: (e) => {
          e.stopPropagation();
          const idx = discoveryState.raw.findIndex(b => b.id === book.id);
          if (idx === -1) return;
          const removed = discoveryState.raw.splice(idx, 1)[0];
          delete discoveryState.enrichments[book.id];
          const node = document.querySelector(`[data-disco-id="${book.id}"]`);
          if (node) node.remove();
          const countEl = document.getElementById("disco-count");
          if (countEl) {
            countEl.textContent = discoveryState.raw.length
              ? `${discoveryState.raw.length} result${discoveryState.raw.length === 1 ? "" : "s"} for "${discoveryState.lastQuery}"`
              : `All results dismissed — try a new search`;
          }
          ui.toast(`Dismissed ${book.title}`, {
            action: "Undo",
            onAction: () => {
              discoveryState.raw.splice(idx, 0, removed);
              renderView();
            },
            duration: 4000
          });
        }
      }, "×"));

      // Cover frame — image if available, initials fallback otherwise
      const cover = util.el("div", { class: "disco-card-cover" });
      if (book.thumbnail) {
        const url = book.thumbnail.replace(/^http:/, "https:");
        const img = util.el("img", {
          src: url, alt: `Cover of ${book.title}`, loading: "lazy",
          onerror: function () {
            this.remove();
            if (!cover.querySelector(".cover-fallback")) {
              cover.appendChild(util.el("div", { class: "cover-fallback", text: (book.title || "??").slice(0, 2).toUpperCase() }));
            }
          }
        });
        cover.appendChild(img);
      } else {
        cover.appendChild(util.el("div", { class: "cover-fallback", text: (book.title || "??").slice(0, 2).toUpperCase() }));
      }
      // Steam Engine bar at the bottom of the cover (reveals once analyzed)
      cover.appendChild(util.el("div", {
        class: "steam-indicator" + (heat ? " " + steamClass(heat) : ""),
        style: heat ? null : { background: "var(--bg-sunken)", opacity: "0.6" }
      }));
      card.appendChild(cover);

      // Body
      const body = util.el("div", { class: "disco-card-body" });
      body.appendChild(util.el("h4", { text: book.title }));
      body.appendChild(util.el("div", { class: "author", text: book.author + (book.year ? ` · ${book.year}` : "") }));
      body.appendChild(util.el("p", { class: "blurb", text: book.description }));

      if (enrich && !enrich.error) {
        if (enrich.tropes && enrich.tropes.length) {
          const tr = util.el("div", { class: "tropes" });
          enrich.tropes.forEach(t => tr.appendChild(util.el("span", { class: "tag" }, t)));
          body.appendChild(tr);
        }
        body.appendChild(util.el("div", { class: "insight" }, [
          util.el("strong", { text: `AI Insight · heat ${enrich.heat}/5` }),
          util.el("div", { text: enrich.insight || "No insight returned." })
        ]));
      } else if (enrich && enrich.error) {
        body.appendChild(util.el("div", { class: "insight", style: { background: "var(--primary-soft)", borderLeftColor: "var(--accent)" } }, [
          util.el("strong", { text: "Analysis failed" }),
          util.el("div", { text: "Claude couldn't be reached for this title. The rest of the result stands." })
        ]));
      } else {
        body.appendChild(util.el("div", { class: "insight", style: { opacity: 0.7 } }, [
          util.el("strong", { text: "Claude is reading…" }),
          util.el("div", { text: "Analysis will appear here in a moment." })
        ]));
      }

      const actions = util.el("div", { class: "card-actions" });
      actions.appendChild(util.el("button", { class: "btn btn-sm btn-primary", onclick: (e) => {
        e.stopPropagation();
        addDiscoveryToLibrary(book, enrich);
      }}, "Add to library"));
      if (book.sourceUrl) {
        actions.appendChild(util.el("a", {
          class: "btn btn-sm btn-ghost",
          href: book.sourceUrl, target: "_blank", rel: "noopener noreferrer"
        }, "View source"));
      }
      body.appendChild(actions);
      card.appendChild(body);

      return card;
    }

    return wrap;
  }

  function addDiscoveryToLibrary(book, enrich) {
    const s = store.get();
    const existing = (s.discovered || []).find(d => d.id === book.id);
    if (existing) {
      ui.toast(`${book.title} is already in your library`);
      return;
    }
    store.update(st => {
      st.discovered = st.discovered || [];
      st.discovered.unshift({
        id: book.id,
        title: book.title,
        author: book.author,
        year: book.year,
        description: book.description,
        thumbnail: book.thumbnail || null,
        source: "Google Books",
        sourceUrl: book.sourceUrl || null,
        heat: enrich && !enrich.error ? enrich.heat : null,
        tropes: enrich && !enrich.error ? (enrich.tropes || []) : [],
        aiInsight: enrich && !enrich.error ? enrich.insight : null,
        addedAt: Date.now()
      });
      st.bookStates[book.id] = "want";
    });
    ui.toast(`Added ${book.title} to your library as "want to read"`, {
      action: "Open library",
      onAction: () => router.go("library"),
      duration: 4200
    });
  }

  /* -------------------- transparency -------------------- */
  /* -------------------- settings -------------------- */
  function renderSettings() {
    const Disco = window.LumenDiscovery;
    const wrap = util.el("div", { class: "page stack-lg" });

    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Settings" }),
        util.el("h1", { html: "<em>Settings</em>" }),
        util.el("p", { class: "lede", text: "Keys and configuration. Everything here is stored locally on this device." })
      ])
    ]));

    // --- Claude API key ---------------------------------------------------
    const keyCard = util.el("div", { class: "card settings-card stack" });
    keyCard.appendChild(util.el("div", { class: "settings-card-head" }, [
      util.el("div", {}, [
        util.el("h3", { text: "Claude API key" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: "Required for AI analysis on Discovery search results. Stored locally, never sent anywhere but Anthropic." })
      ]),
      util.el("span", {
        class: "settings-badge " + (Disco.getApiKey() ? "settings-badge-ok" : "settings-badge-missing"),
        text: Disco.getApiKey() ? "Key saved" : "Not set"
      })
    ]));

    const keyInput = util.el("input", {
      type: "password",
      class: "input",
      placeholder: "sk-ant-…",
      value: Disco.getApiKey(),
      autocomplete: "off",
      spellcheck: "false"
    });
    keyCard.appendChild(keyInput);

    const revealRow = util.el("label", { class: "toggle", style: { fontSize: "12px", color: "var(--text-muted)" } });
    const revealInput = util.el("input", { type: "checkbox", onchange: (e) => {
      keyInput.setAttribute("type", e.target.checked ? "text" : "password");
    }});
    revealRow.appendChild(revealInput);
    revealRow.appendChild(util.el("span", { class: "toggle-track" }));
    revealRow.appendChild(util.el("span", { class: "toggle-label", text: "Show key" }));
    keyCard.appendChild(revealRow);

    const keyActions = util.el("div", { class: "row", style: { gap: "var(--s-2)" } });
    keyActions.appendChild(util.el("button", { class: "btn btn-primary btn-sm", onclick: () => {
      const val = keyInput.value.trim();
      if (!val) {
        Disco.clearApiKey();
        ui.toast("API key cleared");
        renderView();
        return;
      }
      Disco.setApiKey(val);
      ui.toast("API key saved locally");
      renderView();
    }}, Disco.getApiKey() ? "Update" : "Save"));
    keyActions.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", disabled: !Disco.getApiKey() || null, onclick: () => {
      ui.modal({
        title: "Clear Claude API key?",
        body: "<p class=\"t-muted\">Removes the key from this device. You can paste it back in any time.</p>",
        primary: { label: "Clear", onClick: () => {
          Disco.clearApiKey();
          keyInput.value = "";
          ui.toast("API key cleared");
          renderView();
        }},
        secondary: { label: "Cancel" }
      });
    }}, "Clear"));
    keyCard.appendChild(keyActions);

    keyCard.appendChild(util.el("div", { class: "disclosure-note" }, [
      util.el("div", {}, [
        util.el("strong", { text: "Heads up · " }),
        "Calling Claude from the browser exposes this key to any script loaded on this page. Use a personal key, set a spend limit in the Anthropic console, and don't paste a team key here. Full detail in ",
        util.el("a", { href: "#/transparency", style: { color: "var(--accent)", textDecoration: "underline" } }, "Transparency"),
        "."
      ])
    ]));
    wrap.appendChild(keyCard);

    // --- Google Books API key (optional) ---------------------------------
    const gbCard = util.el("div", { class: "card settings-card stack" });
    gbCard.appendChild(util.el("div", { class: "settings-card-head" }, [
      util.el("div", {}, [
        util.el("h3", { text: "Google Books API key (optional)" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: "Anonymous requests share a ~1,000/day quota across everyone on your network. A free personal key lifts that to ~100,000/day." })
      ]),
      util.el("span", {
        class: "settings-badge " + (Disco.getGoogleKey() ? "settings-badge-ok" : "settings-badge-missing"),
        text: Disco.getGoogleKey() ? "Key saved" : "Anonymous"
      })
    ]));

    const gbInput = util.el("input", {
      type: "password",
      class: "input",
      placeholder: "AIza…",
      value: Disco.getGoogleKey(),
      autocomplete: "off",
      spellcheck: "false"
    });
    gbCard.appendChild(gbInput);

    const gbReveal = util.el("label", { class: "toggle", style: { fontSize: "12px", color: "var(--text-muted)" } });
    const gbRevealInput = util.el("input", { type: "checkbox", onchange: (e) => {
      gbInput.setAttribute("type", e.target.checked ? "text" : "password");
    }});
    gbReveal.appendChild(gbRevealInput);
    gbReveal.appendChild(util.el("span", { class: "toggle-track" }));
    gbReveal.appendChild(util.el("span", { class: "toggle-label", text: "Show key" }));
    gbCard.appendChild(gbReveal);

    const gbActions = util.el("div", { class: "row", style: { gap: "var(--s-2)" } });
    gbActions.appendChild(util.el("button", { class: "btn btn-primary btn-sm", onclick: () => {
      const val = gbInput.value.trim();
      Disco.setGoogleKey(val);
      ui.toast(val ? "Google Books key saved" : "Google Books key cleared");
      renderView();
    }}, Disco.getGoogleKey() ? "Update" : "Save"));
    gbActions.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", disabled: !Disco.getGoogleKey() || null, onclick: () => {
      Disco.clearGoogleKey();
      gbInput.value = "";
      ui.toast("Google Books key cleared");
      renderView();
    }}, "Clear"));
    gbCard.appendChild(gbActions);

    gbCard.appendChild(util.el("div", { class: "disclosure-note" }, [
      util.el("div", {}, [
        util.el("strong", { text: "How to get a key · " }),
        "Google Cloud console → APIs & Services → Enable \"Books API\" → Credentials → Create API key. The Books API is free. Restrict the key to HTTP referrers if you want belt-and-braces safety."
      ])
    ]));
    wrap.appendChild(gbCard);

    // --- Starter library -------------------------------------------------
    const starterLoaded = hasStarterLibraryLoaded();
    const starterCount = (SEED_BOOKS || []).length;
    const loadedCount = (store.get().discovered || []).filter(d => d.source === "seed").length;
    const starterCard = util.el("div", { class: "card settings-card stack" });
    starterCard.appendChild(util.el("div", { class: "settings-card-head" }, [
      util.el("div", {}, [
        util.el("h3", { text: "Starter library" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: `An optional bundle of ${starterCount} historical and classical titles (Fanny Hill, Kama Sutra, Venus in Furs, The Decameron, and more). Loading it populates your library so Home, Compare, and your profile preview have something to rank.` })
      ]),
      util.el("span", {
        class: "settings-badge " + (starterLoaded ? "settings-badge-ok" : "settings-badge-missing"),
        text: starterLoaded ? `${loadedCount} loaded` : "Not loaded"
      })
    ]));
    starterCard.appendChild(util.el("div", { class: "row", style: { gap: "var(--s-2)" } }, [
      util.el("button", {
        class: "btn btn-primary btn-sm",
        disabled: starterLoaded && loadedCount === starterCount ? "disabled" : null,
        onclick: () => {
          const added = loadStarterLibrary();
          if (added) ui.toast(`Loaded ${added} title${added === 1 ? "" : "s"} into your library`);
          else ui.toast("Starter library is already fully loaded");
          renderView();
        }
      }, starterLoaded ? "Top up" : "Load starter library"),
      util.el("button", {
        class: "btn btn-sm",
        disabled: !starterLoaded || null,
        onclick: () => {
          ui.modal({
            title: "Remove the starter library?",
            body: "<p class=\"t-muted\">Every starter title is removed from your library along with any reading state or tags you attached to them. Books you added from Discovery are untouched.</p>",
            primary: { label: "Remove", onClick: () => {
              const removed = unloadStarterLibrary();
              ui.toast(`Removed ${removed} starter title${removed === 1 ? "" : "s"}`);
              renderView();
            } },
            secondary: { label: "Cancel" }
          });
        }
      }, "Remove starter titles")
    ]));
    starterCard.appendChild(util.el("p", { class: "t-tiny t-subtle", text: "Starter titles are tagged internally as seed data and live alongside anything you add from Discovery. You can dismiss individual titles from the Library at any time." }));
    wrap.appendChild(starterCard);

    // --- Hidden books -----------------------------------------------------
    const hiddenIds = Object.keys(store.get().hidden || {});
    const hiddenCard = util.el("div", { class: "card settings-card stack" });
    hiddenCard.appendChild(util.el("div", { class: "settings-card-head" }, [
      util.el("div", {}, [
        util.el("h3", { text: "Hidden books" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: "Titles you've dismissed from your library. Restore any of them here." })
      ]),
      util.el("span", { class: "settings-badge " + (hiddenIds.length ? "settings-badge-missing" : "settings-badge-ok"), text: hiddenIds.length ? `${hiddenIds.length} hidden` : "None" })
    ]));
    if (!hiddenIds.length) {
      hiddenCard.appendChild(util.el("p", { class: "t-small t-subtle", text: "Nothing is hidden right now. Dismiss a card from the Library to send it here." }));
    } else {
      const list = util.el("div", { class: "stack-sm" });
      hiddenIds.forEach(id => {
        const book = findBook(id);
        if (!book) {
          // Orphaned id (discovered item fully removed). Show a minimal row.
          list.appendChild(util.el("div", { class: "settings-hidden-row" }, [
            util.el("div", {}, [
              util.el("div", { class: "t-small t-muted", text: "Untracked title" }),
              util.el("div", { class: "t-tiny t-subtle", text: `id: ${id}` })
            ]),
            util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => { unhideBook(id); renderView(); } }, "Forget")
          ]));
          return;
        }
        list.appendChild(util.el("div", { class: "settings-hidden-row" }, [
          util.el("div", {}, [
            util.el("div", { class: "t-serif", style: { fontSize: "14px" }, text: book.title }),
            util.el("div", { class: "t-tiny t-subtle", text: `${book.author}${book._discovered ? " · from Discovery" : ""}` })
          ]),
          util.el("button", { class: "btn btn-sm btn-primary", onclick: () => {
            unhideBook(id);
            ui.toast(`Restored ${book.title}`);
            renderView();
          } }, "Restore")
        ]));
      });
      hiddenCard.appendChild(list);
      if (hiddenIds.length > 1) {
        hiddenCard.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", style: { alignSelf: "flex-start" }, onclick: () => {
          ui.modal({
            title: "Restore all hidden books?",
            body: "<p class=\"t-muted\">Brings every dismissed title back into your library.</p>",
            primary: { label: "Restore all", onClick: () => {
              store.update(st => { st.hidden = {}; });
              ui.toast("All hidden books restored");
              renderView();
            }},
            secondary: { label: "Cancel" }
          });
        }}, "Restore all"));
      }
    }
    wrap.appendChild(hiddenCard);

    // --- Quick links ------------------------------------------------------
    const links = util.el("div", { class: "card settings-card stack" });
    links.appendChild(util.el("h3", { text: "Other settings" }));
    links.appendChild(util.el("p", { class: "t-small t-muted", text: "Your reader profile, data export, and full privacy controls live in their own sections." }));
    links.appendChild(util.el("div", { class: "row-wrap" }, [
      util.el("a", { class: "btn btn-sm", href: "#/profile" }, "Reader profile"),
      util.el("a", { class: "btn btn-sm", href: "#/vault" }, "Privacy & Vault"),
      util.el("a", { class: "btn btn-sm", href: "#/transparency" }, "Transparency & data")
    ]));
    wrap.appendChild(links);

    return wrap;
  }

  function renderTransparency() {
    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Transparency" }),
        util.el("h1", { html: "How Lumen <em>reasons</em> — and what it refuses to guess at" }),
        util.el("p", { class: "lede", text: "Everything below is honest, including the limits. If the app can't be trusted in a sensitive subject area, it doesn't deserve to exist." })
      ])
    ]));

    // Scoring explainer
    const scoring = util.el("div", { class: "card stack" }, [
      util.el("h3", { text: "How recommendations are scored" }),
      util.el("p", { class: "t-muted", text: "Each book is evaluated against your profile across six numeric dimensions (heat, explicitness, emotional intensity, consent clarity, taboo tolerance, plot weight) and seven tag overlaps (tone, pacing, literary style, relationship dynamic, tropes, kink tags, orientation). Each dimension has a weight — adjustable in your profile. A score between 0 and 100 represents how well the book matches, weighted across all 13 dimensions." }),
      util.el("h3", { text: "Confidence vs fit" }),
      util.el("p", { class: "t-muted", text: "Fit says how well a title matches. Confidence says how much data Lumen had to evaluate — if your profile is thin or a book's metadata is sparse, confidence drops, even if the fit number looks high. A high-fit, low-confidence match is a guess. The app will tell you when that's the case." }),
      util.el("h3", { text: "Hard exclusions are absolute" }),
      util.el("p", { class: "t-muted", text: "Warnings you mark as hard exclusions always drop the matching book — regardless of score, regardless of confidence. A 'strict' warning strictness also applies a penalty proportional to the number of warnings, and drops scores heavily for critical warnings (underage content, consent violations, exploitation)." }),
      util.el("h3", { text: "The Compare analysis is rule-based" }),
      util.el("p", { class: "t-muted", text: "Plain-language verdicts come from templated reasoning over the score data — not from a live language model. This is honest by design: no hallucination, no made-up metadata, no unpredictable output. The trade-off is that the prose is less fluent than a generative model would produce." })
    ]);
    wrap.appendChild(scoring);

    // Privacy
    const privacy = util.el("div", { class: "card stack" }, [
      util.el("h3", { text: "What stays on your device" }),
      util.el("p", { class: "t-muted", text: "Your profile, reading states, custom tags, journal entries, vault contents, Sara conversation, and friend chat — all of it lives in localStorage on this device. There is no server. There is no account. There is no telemetry. Clearing browser data clears Lumen entirely." }),
      util.el("h3", { text: "What the vault passcode does and does not do" }),
      util.el("p", { class: "t-muted", text: "The vault passcode gates the Vault tab re-entry within this app. It is a simple hash check, not encryption. Anyone with access to this device (or your browser's dev tools) could inspect the localStorage directly. Treat it as a courtesy against over-the-shoulder glances, not as real security. Use your operating-system account password and device encryption for actual protection." }),
      util.el("h3", { text: "About the Discovery tab — calling Claude from your browser" }),
      util.el("p", { class: "t-muted", text: "The Discovery tab calls the Anthropic Messages API directly from this page using an opt-in header ('anthropic-dangerous-direct-browser-access'). That convenience carries a real tradeoff: your API key sits inside your browser's localStorage, and any script loaded on this page — including any browser extension — can read it. The key is also sent with every request, so any network intermediary could observe it." }),
      util.el("p", { class: "t-muted", text: "Use a key dedicated to personal experimentation, set a low monthly spend limit in the Anthropic console, and never paste a team or production key here. If you want real safety, run a small server-side proxy and point Lumen at that instead. Google Books calls also go directly from your browser, but that API does not require authentication." })
    ]);
    wrap.appendChild(privacy);

    // What Lumen won't do
    const wont = util.el("div", { class: "card stack" }, [
      util.el("h3", { text: "What Lumen will not do" }),
      util.el("ul", { style: { paddingLeft: "var(--s-5)", color: "var(--text-muted)", lineHeight: "1.8" } }, [
        util.el("li", { text: "Nudge, gamify, streak, or otherwise encourage compulsive use." }),
        util.el("li", { text: "Share anything — with you, a service, or a friend — without you explicitly asking." }),
        util.el("li", { text: "Pretend to know more than it does. Confidence is always visible, and analyses name their own uncertainty." }),
        util.el("li", { text: "Recommend books carrying your hard-excluded warnings. Ever." }),
        util.el("li", { text: "Make aesthetic choices that override safety. If a historical text has period-typical problematic content, that's flagged even when the UI is calm." })
      ])
    ]);
    wrap.appendChild(wont);

    // Data controls
    const data = util.el("div", { class: "card stack" }, [
      util.el("h3", { text: "Data controls" }),
      util.el("p", { class: "t-muted", text: "Export a snapshot of everything Lumen has stored for you, or import a prior snapshot to restore." }),
      util.el("div", { class: "row-wrap" }, [
        util.el("button", { class: "btn", onclick: () => {
          downloadText(`lumen-export-${Date.now()}.json`, JSON.stringify(store.get(), null, 2));
          ui.toast("Snapshot exported");
        }}, "Export snapshot"),
        util.el("label", { class: "btn" }, [
          "Import snapshot",
          util.el("input", { type: "file", accept: "application/json", style: { display: "none" }, onchange: (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const data = JSON.parse(reader.result);
                if (!data || data.schema !== 1) throw new Error("Unsupported snapshot version");
                store.set(data);
                ui.toast("Snapshot imported");
                renderView();
              } catch (err) {
                ui.toast("Could not import — file may be corrupt");
              }
            };
            reader.readAsText(file);
          }})
        ]),
        util.el("button", { class: "btn btn-danger", onclick: () => {
          ui.modal({
            title: "Wipe everything?",
            body: "<p class=\"t-muted\">This clears your profile, reading states, journal, vault, and chats on this device. It cannot be undone.</p>",
            primary: { label: "Wipe", onClick: () => {
              store.reset();
              vaultUnlocked = false;
              localStorage.removeItem("lumen:v1");
              ui.toast("Local data wiped");
              renderView();
            }},
            secondary: { label: "Cancel" }
          });
        }}, "Wipe local data")
      ])
    ]);
    wrap.appendChild(data);

    // Keyboard shortcuts
    const keys = util.el("div", { class: "card stack" }, [
      util.el("h3", { text: "Keyboard shortcuts" }),
      util.el("div", { class: "stack-sm", style: { marginTop: "var(--s-3)" } }, [
        shortcutRow("Open command palette", "⌘K / Ctrl+K"),
        shortcutRow("Go to Home",           "G then H"),
        shortcutRow("Go to Library",        "G then L"),
        shortcutRow("Go to Compare",        "G then C"),
        shortcutRow("Go to Chat",           "G then M"),
        shortcutRow("Go to Journal",        "G then J"),
        shortcutRow("Go to Vault",          "G then V"),
        shortcutRow("Go to Profile",        "G then P"),
        shortcutRow("Toggle theme",         "T"),
        shortcutRow("Toggle discreet",      "D"),
        shortcutRow("Toggle Sara",          "S")
      ])
    ]);
    wrap.appendChild(keys);

    return wrap;
  }

  function shortcutRow(label, keys) {
    return util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center" } }, [
      util.el("span", { class: "t-small t-muted", text: label }),
      util.el("span", { class: "kbd-inline", text: keys })
    ]);
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
        util.el("h1", { html: "Your <em>private</em> space" }),
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
        const book = findBook(p.bookId);
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
    const book = entry.bookId ? findBook(entry.bookId) : null;
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
        util.el("h1", { html: "Private <em>reflections</em>" }),
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
      listAllBooks().forEach(b => bookSel.appendChild(util.el("option", { value: b.id, selected: entry.bookId === b.id ? "selected" : null }, b.title)));
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
      currentReading: readingIds.map(id => findBook(id)).filter(Boolean),
      wantToRead: wantIds.map(id => findBook(id)).filter(Boolean),
      excludes: profile.exclude
    };
  }

  function saraRespond(userText, saraCtx) {
    const text = userText.toLowerCase();
    const ctx = saraContextSummary();
    const s = store.get();
    const pool = listAllBooks();
    const ranked = Engine.rankRecommendations(s.profile, s.weights, pool);
    saraCtx = saraCtx || (window.LumenSara && window.LumenSara.context) || {};

    // Resolve referential phrases via live context
    let bookMentioned = pool.find(b =>
      text.includes(b.title.toLowerCase()) ||
      text.includes(b.title.toLowerCase().split(" ").slice(0, 2).join(" ").toLowerCase())
    );
    const referential = /\b(this book|this title|it|that one)\b/.test(text);
    if (!bookMentioned && referential) {
      if (saraCtx.route === "compare" && (saraCtx.compareSlots || []).length) {
        bookMentioned = pool.find(b => saraCtx.compareSlots.includes(b.title));
      } else if (saraCtx.route === "journal" && saraCtx.journalEntryId) {
        const entry = s.journal.find(e => e.id === saraCtx.journalEntryId);
        if (entry && entry.bookId) bookMentioned = findBook(entry.bookId);
      }
    }

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

    if (/\bcompare\b/.test(text) || /\b(difference|differ|versus|vs)\b/.test(text)) {
      if (saraCtx.route === "compare" && (saraCtx.compareSlots || []).length >= 2) {
        const titles = saraCtx.compareSlots;
        replies.push(`Looking at your current lineup (${titles.join(", ")}): the sharpest differences usually show on heat, emotional intensity, and consent clarity. Hit **Run analysis** for the full tradeoff matrix.`);
      } else {
        replies.push(`Open the Compare tab and pick up to three titles — I'll lay out scores, a radar, category bars, and a plain-language verdict.`);
      }
    }

    if (/\b(summari[sz]e|summary|lineup|pick one)\b/.test(text) && saraCtx.route === "compare" && (saraCtx.compareSlots || []).length) {
      replies.push(`Your comparison has ${saraCtx.compareSlots.length} title${saraCtx.compareSlots.length === 1 ? "" : "s"}: ${saraCtx.compareSlots.join(", ")}. Want me to call out the biggest tradeoff, or a safest choice?`);
    }

    // Deep-analysis aware replies
    if (cmpState && cmpState.lastDeepAnalysis) {
      const deep = cmpState.lastDeepAnalysis;
      if (/\b(tradeoff|tradeoffs|difference|differs|versus|vs)\b/.test(text)) {
        const best = deep.tradeoffs[0];
        if (best) replies.push(`The sharpest tradeoff I see: **${best.a} vs ${best.b}** — ${best.differences.map(d => `${d.leader} wins ${d.category.toLowerCase()} (+${d.magnitude})`).join("; ") || "no dimension separates them by much."}`);
      }
      if (/\b(mood|tonight|feel|right for)\b/.test(text)) {
        const sample = deep.moods[0];
        if (sample) replies.push(`Mood map: for **${sample.mood.toLowerCase()}**, I'd lean to ${sample.winner}. Ask about other moods if that isn't what you're after.`);
      }
      if (/\b(order|sequence|first|start)\b/.test(text) && deep.readingOrder) {
        replies.push(`Reading order I'd suggest: ${deep.readingOrder.order.map((t, i) => `${i + 1}. ${t}`).join(" — ")}. ${deep.readingOrder.note}`);
      }
      if (/\b(confiden|trust|how sure)\b/.test(text)) {
        replies.push(`Confidence across the lineup: ${deep.confidence.entries.map(e => `${e.title} ${e.confidence}%`).join(", ")}. ${deep.confidence.flags[0] || ""}`.trim());
      }
    }

    if (/\b(reflect|journal|feel|felt|thought|prompt)\b/.test(text)) {
      if (saraCtx.route === "journal" && saraCtx.journalEntryId) {
        const entry = s.journal.find(e => e.id === saraCtx.journalEntryId);
        const book = entry && entry.bookId ? findBook(entry.bookId) : null;
        if (book) replies.push(`For your entry on **${book.title}**, try: "Where in the book did you lose your footing, and what caught you there?"`);
        else       replies.push(`A prompt for this entry: "What did you want more of, and what was on the page already?"`);
      } else {
        replies.push(`The Journal is the right place for that — freeform or prompted entries, all private. Want me to suggest a reflection prompt?`);
      }
    }

    if (/\b(safe|private|who|see|share|upload)\b/.test(text)) {
      replies.push(`Nothing you enter leaves this device. No server, no account, no tracking. If you're on a shared screen, toggle Discreet mode in the top bar.`);
    }

    if (bookMentioned) {
      const scored = Engine.compareBooks([bookMentioned.id], s.profile, s.weights, pool)[0];
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
        util.el("div", { class: "t-eyebrow", text: "Connections" }),
        util.el("h1", { html: "Your private <em>social</em> layer" }),
        util.el("p", { class: "lede", text: "Sara lives in the floating panel across every tab — this page is the place to review history and manage friends you share titles with. Everything is local." })
      ])
    ]));

    // Sara summary card
    const saraMsgs = store.get().chats.sara || [];
    const lastMsg = saraMsgs[saraMsgs.length - 1];
    const saraCard = util.el("div", { class: "card" });
    saraCard.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Sara · conversation history" }),
      util.el("div", { class: "row" }, [
        util.el("button", { class: "btn btn-sm btn-primary", onclick: () => window.LumenSara && window.LumenSara.open() }, "Open Sara"),
        util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => {
          ui.modal({
            title: "Clear Sara's memory?",
            body: "<p class=\"t-muted\">Deletes every message between you and Sara on this device. A fresh greeting will replace it.</p>",
            primary: { label: "Clear", onClick: () => {
              store.update(s => { s.chats.sara = []; });
              ensureSeedSara();
              ui.toast("Sara's memory cleared");
              renderView();
            }},
            secondary: { label: "Cancel" }
          });
        }}, "Clear history")
      ])
    ]));
    saraCard.appendChild(util.el("div", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" },
      text: `${saraMsgs.length} message${saraMsgs.length === 1 ? "" : "s"} stored locally${lastMsg ? " · last: " + new Date(lastMsg.ts).toLocaleString() : ""}` }));

    if (saraMsgs.length > 1) {
      const transcript = util.el("div", { class: "stack-sm", style: { marginTop: "var(--s-4)", maxHeight: "320px", overflowY: "auto", padding: "var(--s-3)", background: "var(--bg-sunken)", borderRadius: "var(--r-2)", border: "1px solid var(--border)" } });
      saraMsgs.slice(-10).forEach(m => {
        transcript.appendChild(util.el("div", { style: { padding: "6px 0", borderBottom: "1px dashed var(--border)" } }, [
          util.el("div", { class: "t-tiny t-subtle", text: `${m.role === "user" ? "You" : "Sara"} · ${new Date(m.ts).toLocaleTimeString()}` }),
          util.el("div", { class: "t-small", style: { marginTop: "2px" }, text: (m.text || "").replace(/\*\*(.+?)\*\*/g, "$1") })
        ]));
      });
      saraCard.appendChild(transcript);
    }
    wrap.appendChild(saraCard);

    // Friends layer
    const friendsCard = util.el("div", { class: "card" });
    friendsCard.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Friends · local-only" }),
      util.el("button", { class: "btn btn-sm", onclick: () => {
        ui.modal({
          title: "Add a friend",
          body: (() => {
            const div = util.el("div", { class: "stack" });
            div.appendChild(util.el("p", { class: "t-muted t-small", text: "Friends are local only — a private, single-device prototype of a social layer. No accounts, no syncing." }));
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
      }}, "+ Add friend")
    ]));

    const friends = store.get().chats.friends;
    if (!friends.length) {
      friendsCard.appendChild(ui.empty({
        title: "No friends yet",
        message: "Add a local-only friend to share titles and exchange notes. Nothing syncs to any server."
      }));
    } else {
      const shell = util.el("div", { class: "chat-shell" });
      const threads = util.el("div", { class: "chat-threads" });
      friends.forEach(f => {
        threads.appendChild(util.el("div", { class: "chat-thread",
          "aria-current": chatState.friendId === f.id ? "true" : null,
          onclick: () => { chatState.friendId = f.id; paintFriend(panel, f.id); threads.querySelectorAll(".chat-thread").forEach(el => el.removeAttribute("aria-current")); threads.lastChild.previousSibling; }
        }, [
          util.el("div", { class: "chat-thread-name", text: f.name }),
          util.el("div", { class: "chat-thread-sub", text: f.messages.length ? `${f.messages.length} message${f.messages.length > 1 ? "s" : ""}` : "New" })
        ]));
      });
      shell.appendChild(threads);
      const panel = util.el("div", { class: "chat-panel" });
      shell.appendChild(panel);
      friendsCard.appendChild(shell);
      if (!chatState.friendId && friends.length) chatState.friendId = friends[0].id;
      setTimeout(() => paintFriend(panel, chatState.friendId), 0);
    }
    wrap.appendChild(friendsCard);

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
          const book = findBook(m.bookId);
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
            const saved = listSavedBooks();
            if (!saved.length) {
              sel.appendChild(util.el("option", { value: "", disabled: "disabled", selected: "selected" }, "No saved books to share yet"));
            } else {
              saved.forEach(b => sel.appendChild(util.el("option", { value: b.id }, b.title)));
            }
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

  const cmpState = { slots: [null, null, null], lastDeepAnalysis: null };

  function openSlotPicker(slotIdx) {
    const used = cmpState.slots.filter(Boolean);
    const body = util.el("div", { class: "stack" });
    body.appendChild(util.el("p", { class: "t-muted t-small", text: "Pick a title for this slot. You can have up to three." }));
    const search = util.el("input", { class: "input", placeholder: "Search titles or authors…", autofocus: true });
    body.appendChild(search);
    const list = util.el("div", { class: "stack-sm", style: { maxHeight: "320px", overflowY: "auto", marginTop: "var(--s-2)" } });
    body.appendChild(list);

    const handle = ui.modal({ title: `Add title to slot ${slotIdx + 1}`, body, secondary: { label: "Cancel" } });

    function paint() {
      const q = (search.value || "").toLowerCase();
      list.innerHTML = "";
      const candidates = BOOKS
        .filter(b => !used.includes(b.id))
        .filter(b => !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));

      if (!candidates.length) {
        list.appendChild(util.el("p", { class: "t-small t-subtle", style: { padding: "var(--s-3)" }, text: "No titles match. Try a different search, or remove an existing slot to free one up." }));
        return;
      }
      candidates.forEach(b => {
        const row = util.el("button", { class: "btn btn-ghost", style: { justifyContent: "flex-start", textAlign: "left", width: "100%", padding: "10px 12px" },
          onclick: () => {
            cmpState.slots[slotIdx] = b.id;
            cmpState.lastDeepAnalysis = null;  // invalidate stale analysis
            handle.close();
            renderView();
          }
        }, [
          util.el("div", {}, [
            util.el("div", { class: "t-serif", style: { fontSize: "14px" }, text: b.title }),
            util.el("div", { class: "t-tiny t-subtle", text: `${b.author} · ${util.fmtYear(b.year)}` })
          ])
        ]);
        list.appendChild(row);
      });
    }
    search.addEventListener("input", paint);
    setTimeout(paint, 0);
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

  function categoryBarsMulti(scoredList) {
    // Shows each dimension with one horizontal bar per book, colored by series
    const wrap = util.el("div");
    CMP_CATEGORIES.forEach(cat => {
      const bars = util.el("div", { class: "cat-bars" });
      scoredList.forEach((sc, i) => {
        const pct = Math.round((sc.contributions[cat.key]?.score ?? 0) * 100);
        const seriesClass = `series-${i + 1}`;
        bars.appendChild(util.el("div", { class: "cat-bar-line" }, [
          util.el("div", { class: "cat-series", text: sc.book.title }),
          util.el("div", { class: `bar ${seriesClass}` }, [util.el("span", { style: { width: `${pct}%` } })]),
          util.el("div", { class: "cat-bar-val", text: `${pct}` })
        ]));
      });
      wrap.appendChild(util.el("div", { class: "cat-row-3" }, [
        util.el("div", { class: "cat-label", text: cat.label }),
        bars,
        util.el("div")
      ]));
    });
    return wrap;
  }

  function radarSVG(scoredList, size = 340) {
    const list = Array.isArray(scoredList) ? scoredList.filter(Boolean) : [scoredList].filter(Boolean);
    const cats = CMP_CATEGORIES;
    const cx = size / 2, cy = size / 2;
    const r = size / 2 - 30;
    const N = cats.length;
    const angle = (i) => (-Math.PI / 2) + (i / N) * (Math.PI * 2);
    const pt = (i, v) => [cx + Math.cos(angle(i)) * r * v, cy + Math.sin(angle(i)) * r * v];

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "auto");
    svg.style.maxWidth = `${size}px`;

    [0.25, 0.5, 0.75, 1].forEach(ring => {
      const pts = cats.map((_, i) => pt(i, ring).join(",")).join(" ");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts);
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "var(--border)");
      poly.setAttribute("stroke-width", "1");
      svg.appendChild(poly);
    });
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

    const palette = ["var(--accent)", "var(--info)", "var(--good)"];
    list.forEach((scored, i) => {
      const color = palette[i] || "var(--warn)";
      const pts = cats.map((c, k) => pt(k, scored.contributions[c.key]?.score ?? 0).join(",")).join(" ");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts);
      poly.setAttribute("fill", color);
      poly.setAttribute("fill-opacity", "0.18");
      poly.setAttribute("stroke", color);
      poly.setAttribute("stroke-width", "1.5");
      svg.appendChild(poly);
    });

    return svg;
  }

  function quickAnalysis(scoredList, profile) {
    if (!scoredList || scoredList.length < 2) return null;

    const sorted = [...scoredList].sort((a, b) => b.fitScore - a.fitScore);
    const best = sorted[0];
    const rest = sorted.slice(1);
    const gap = best.fitScore - (rest[0]?.fitScore ?? best.fitScore);
    const tiedBest = scoredList.filter(x => x.fitScore === best.fitScore);

    const verdict = (() => {
      if (tiedBest.length === scoredList.length) return `All ${scoredList.length} titles land at ${best.fitScore}. The decision becomes about what you're in the mood for, not which fits.`;
      if (gap <= 5)  return `Close race. ${best.book.title} edges ahead at ${best.fitScore} — but any of these is defensible.`;
      if (gap <= 15) return `${best.book.title} is the clearer fit (${best.fitScore} vs ${rest.map(r => r.fitScore).join(" / ")}).`;
      return `${best.book.title} is the strong favourite (${best.fitScore}). The others are substantial deviations from your current profile.`;
    })();

    const differences = [];
    const pairs = [];
    for (let i = 0; i < scoredList.length; i++)
      for (let j = i + 1; j < scoredList.length; j++)
        pairs.push([scoredList[i], scoredList[j]]);

    const pickDiff = (a, b, key, label) => {
      const sa = a.contributions[key]?.score || 0;
      const sb = b.contributions[key]?.score || 0;
      if (Math.abs(sa - sb) < 0.25) return null;
      const leader = sa > sb ? a : b;
      return `${leader.book.title} wins on ${label}`;
    };
    pairs.forEach(([a, b]) => {
      ["heat", "emotion", "consent", "plot"].forEach(key => {
        const label = CMP_CATEGORIES.find(c => c.key === key).label.toLowerCase();
        const d = pickDiff(a, b, key, label);
        if (d) differences.push(d);
      });
    });

    const tradeoffs = [];
    scoredList.forEach(sc => {
      if (sc.criticallyWarned) tradeoffs.push(`${sc.book.title} carries a critical warning — treat as an informed choice.`);
    });
    if (scoredList.some(s => s.warnPenalty > 1)) {
      tradeoffs.push(`Warning strictness (${profile.warnStrict}) is depressing at least one score; loosening it would change the picture.`);
    }
    const lowConf = scoredList.filter(s => s.confidence < 60);
    if (lowConf.length) {
      tradeoffs.push(`Confidence is low on ${lowConf.map(s => s.book.title).join(", ")} — metadata is thin, or your taste profile has few signals to match against.`);
    }

    const bestFor = (scored) => {
      const top = Object.entries(scored.contributions)
        .filter(([, v]) => v.score >= 0.75)
        .sort((x, y) => y[1].contrib - x[1].contrib)
        .slice(0, 3)
        .map(([k]) => CMP_CATEGORIES.find(c => c.key === k)?.label || k);
      if (!top.length) return "a middle-of-the-road choice across your preferences";
      return `readers who want ${top.join(", ").toLowerCase()}`;
    };

    const bestForMap = scoredList.map(sc => ({ title: sc.book.title, text: bestFor(sc) }));

    const ifYouLiked = tiedBest.length < scoredList.length
      ? `If ${best.book.title} lands for you, the others may feel like softer or sharper echoes depending on which dimensions you weigh most.`
      : `These are tied on raw fit — think about tonight's mood, not this week's score.`;

    const thinMetadata = (scoredList.reduce((a, s) => a + s.confidence, 0) / scoredList.length) < 55;

    return {
      verdict,
      differences: [...new Set(differences)].slice(0, 6),
      tradeoffs,
      bestForMap,
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
    if (seed) {
      if (!cmpState.slots.includes(seed)) {
        const emptyIdx = cmpState.slots.findIndex(x => !x);
        if (emptyIdx !== -1) cmpState.slots[emptyIdx] = seed;
        else cmpState.slots[0] = seed;
      }
      sessionStorage.removeItem("lumen:compare-seed");
    }

    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Compare" }),
        util.el("h1", { html: "<em>Lineup</em>" }),
        util.el("p", { class: "lede", text: "Place up to three titles side by side. You'll get per-book scores, category-by-category bars, a radar shape, and a quick verdict — all against your profile. Hit Run analysis for the deeper pass." })
      ])
    ]));

    // Slot row
    const slotsCard = util.el("div", { class: "card", style: { padding: "var(--s-4)" } });
    const slots = util.el("div", { class: "cmp-slots" });
    cmpState.slots.forEach((id, idx) => {
      const b = id ? findBook(id) : null;
      if (b) {
        const filled = util.el("div", { class: "cmp-slot" });
        filled.appendChild(util.el("div", { class: "cmp-slot-idx", text: `Slot ${idx + 1}` }));
        filled.appendChild(util.el("div", { class: "cmp-slot-title", text: b.title }));
        filled.appendChild(util.el("div", { class: "cmp-slot-author", text: `${b.author} · ${util.fmtYear(b.year)}` }));
        filled.appendChild(util.el("div", { class: "row", style: { marginTop: "var(--s-2)" } }, [
          util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => openSlotPicker(idx) }, "Replace"),
          util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => { cmpState.slots[idx] = null; cmpState.lastDeepAnalysis = null; renderView(); } }, "Remove")
        ]));
        slots.appendChild(filled);
      } else {
        slots.appendChild(util.el("div", { class: "cmp-slot empty", onclick: () => openSlotPicker(idx) }, [
          util.el("div", { class: "cmp-slot-idx", text: `Slot ${idx + 1}` }),
          util.el("div", { class: "t-small", text: "+ Add title" })
        ]));
      }
    });
    slotsCard.appendChild(slots);

    const actionsRow = util.el("div", { class: "row", style: { marginTop: "var(--s-3)", justifyContent: "space-between" } });
    const filledCount = cmpState.slots.filter(Boolean).length;
    actionsRow.appendChild(util.el("div", { class: "t-small t-subtle", text: `${filledCount} of 3 slots filled` }));
    actionsRow.appendChild(util.el("div", { class: "row" }, [
      util.el("button", { class: "btn btn-ghost btn-sm", disabled: filledCount === 0 || null, onclick: () => { cmpState.slots = [null, null, null]; cmpState.lastDeepAnalysis = null; renderView(); } }, "Clear all"),
      util.el("button", { class: "btn btn-primary", disabled: filledCount < 2 || null, onclick: () => runDeepAnalysis() }, "Run analysis")
    ]));
    slotsCard.appendChild(actionsRow);

    wrap.appendChild(slotsCard);

    const body = util.el("div", { id: "cmp-body", class: "stack-lg" });
    wrap.appendChild(body);

    function paint() {
      body.innerHTML = "";
      const filled = cmpState.slots.filter(Boolean);
      if (!listAllBooks().length) {
        body.appendChild(ui.empty({
          title: "Nothing saved to compare yet",
          message: "Compare draws from books in your Library. Add titles from Discovery or load the starter library in Settings, then come back here.",
          actions: [
            { label: "Open Discovery", variant: "btn-primary", onClick: () => router.go("discovery") },
            { label: "Open Settings",  variant: "btn",         onClick: () => router.go("settings") }
          ]
        }));
        return;
      }
      if (filled.length === 0) {
        body.appendChild(ui.empty({
          title: "Pick up to three titles",
          message: "Scores are evaluated against your current profile. Change your profile and the picture changes."
        }));
        return;
      }
      if (filled.length === 1) {
        const scored = Engine.compareBooks(filled, s.profile, s.weights, listAllBooks())[0];
        body.appendChild(ui.empty({
          title: "Add at least one more",
          message: "Comparison needs two titles minimum. Below is your first slot, scored against your profile."
        }));
        body.appendChild(cmpCard(scored));
        return;
      }

      const scoredList = Engine.compareBooks(filled, s.profile, s.weights, listAllBooks());

      // Scorecards
      const grid = util.el("div", { class: "cmp-grid cmp-" + filled.length });
      scoredList.forEach(sc => grid.appendChild(cmpCard(sc)));
      body.appendChild(grid);

      // Radar + legend
      const radarCard = util.el("div", { class: "card" });
      radarCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Shape of the fit" }),
        util.el("span", { class: "card-sub t-subtle", text: "Each axis is one scored dimension" })
      ]));
      const radarBox = util.el("div", { class: "radar-wrap" });
      radarBox.appendChild(radarSVG(scoredList, 340));
      radarCard.appendChild(radarBox);
      const legend = util.el("div", { class: "radar-legend" });
      scoredList.forEach((sc, i) => {
        legend.appendChild(util.el("span", {}, [
          util.el("span", { class: `swatch s${i + 1}` }),
          sc.book.title
        ]));
      });
      radarCard.appendChild(legend);
      body.appendChild(radarCard);

      // Quick analysis
      const ai = quickAnalysis(scoredList, s.profile);
      const aiCard = util.el("div", { class: "card stack" });
      aiCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { text: "Quick analysis" }),
        util.el("div", { class: "row" }, [
          util.el("span", { class: "card-sub t-subtle", text: "Auto · rule-based" }),
          util.el("button", { class: "btn btn-sm", onclick: () => {
            saveAnalysis({
              titleA: scoredList[0].book.title,
              titleB: scoredList.slice(1).map(s => s.book.title).join(" & "),
              fitA: scoredList[0].fitScore,
              fitB: scoredList[1]?.fitScore ?? 0,
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

      const bestForGrid = util.el("div", { class: `cmp-grid cmp-${filled.length}` });
      ai.bestForMap.forEach(m => bestForGrid.appendChild(util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: `${m.title} · best for` }),
        util.el("p", { class: "t-muted t-small", style: { marginTop: "var(--s-2)" }, text: m.text })
      ])));
      aiCard.appendChild(bestForGrid);

      if (ai.tradeoffs.length) {
        ai.tradeoffs.forEach(t => aiCard.appendChild(util.el("div", { class: t.includes("critical") ? "caution" : "tradeoff" }, t)));
      }
      aiCard.appendChild(util.el("p", { class: "t-muted t-small", text: ai.ifYouLiked }));
      if (ai.thinMetadata) {
        aiCard.appendChild(util.el("div", { class: "tradeoff" }, "Confidence is moderate across the lineup — metadata is thin or your profile has few expressed tastes. Take the verdict with a grain of salt."));
      }

      body.appendChild(aiCard);

      // Deep analysis (if run) — Batch 4 will populate this; Batch 3 leaves the scaffold
      if (cmpState.lastDeepAnalysis) {
        body.appendChild(renderDeepAnalysis(cmpState.lastDeepAnalysis));
      }
    }

    function runDeepAnalysis() {
      const filled = cmpState.slots.filter(Boolean);
      if (filled.length < 2) return;
      const fresh = store.get();
      const scoredList = Engine.compareBooks(filled, fresh.profile, fresh.weights, listAllBooks());
      if (window.LumenAnalysis && window.LumenAnalysis.deepAnalysis) {
        cmpState.lastDeepAnalysis = window.LumenAnalysis.deepAnalysis(scoredList, fresh.profile);
        ui.toast("Deep analysis ready · scroll down to read it", {
          action: "Open in Sara",
          onAction: () => openInSara(cmpState.lastDeepAnalysis),
          duration: 5000
        });
        renderView();
        // Scroll the new section into view shortly after re-render
        setTimeout(() => {
          const root = document.getElementById("view-root");
          root && root.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
        }, 220);
      } else {
        ui.toast("Deep analysis module not yet loaded");
      }
    }

    // Expose so Batch 4's Run button can call externally
    renderCompare._runDeep = runDeepAnalysis;

    setTimeout(paint, 0);
    return wrap;
  }

  function renderDeepAnalysis(payload) {
    if (!payload) {
      const empty = util.el("div", { class: "card" });
      empty.appendChild(ui.empty({
        title: "No analysis yet",
        message: "Pick two or three titles and hit Run analysis to get a deeper read."
      }));
      return empty;
    }

    const card = util.el("div", { class: "card stack-lg" });

    // Header
    card.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Deep analysis" }),
      util.el("div", { class: "row" }, [
        util.el("span", { class: "card-sub t-subtle", text: new Date(payload.timestamp).toLocaleString() }),
        util.el("button", { class: "btn btn-sm", onclick: () => openInSara(payload) }, "Open in Sara"),
        util.el("button", { class: "btn btn-sm", onclick: () => {
          saveAnalysis({
            titleA: payload.titles[0],
            titleB: payload.titles.slice(1).join(" & "),
            fitA: payload.summaries[0]?.fit ?? 0,
            fitB: payload.summaries[1]?.fit ?? 0,
            verdict: payload.headline,
            deep: payload
          });
        }}, "Save to Vault")
      ])
    ]));

    // Headline
    card.appendChild(util.el("div", { class: "deep-head" }, [
      util.el("div", { class: "t-eyebrow", text: "Headline" }),
      util.el("h3", { text: payload.headline })
    ]));

    // Executive summaries
    const summSection = util.el("div");
    summSection.appendChild(util.el("div", { class: "deep-section-title", text: "Executive summaries" }));
    const summGrid = util.el("div", { class: "deep-grid" });
    payload.summaries.forEach(s => {
      const tile = util.el("div", { class: "deep-tile" });
      tile.appendChild(util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
        util.el("div", { class: "t-serif", style: { fontSize: "15px" }, text: s.title }),
        util.el("div", { class: "t-mono", style: { color: "var(--accent)" }, text: `${s.fit}` })
      ]));
      tile.appendChild(util.el("div", { class: "t-tiny t-subtle", text: `Confidence ${s.confidence}%` }));
      tile.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: s.summary }));
      summGrid.appendChild(tile);
    });
    summSection.appendChild(summGrid);
    card.appendChild(summSection);

    // Category winners
    const winSection = util.el("div");
    winSection.appendChild(util.el("div", { class: "deep-section-title", text: "Category winners" }));
    winSection.appendChild(util.el("p", { class: "t-small t-subtle", style: { marginBottom: "var(--s-3)" }, text: "Who leads each scored dimension, and by how much. Decisive wins shape the overall fit most." }));
    const winTable = util.el("div");
    payload.categoryWinners.forEach(w => {
      winTable.appendChild(util.el("div", { class: "deep-win-row" }, [
        util.el("div", { class: "t-small t-muted", text: w.category }),
        util.el("div", { class: "t-small", text: w.winner }),
        util.el("div", { class: `tier ${w.tier}`, text: w.tier })
      ]));
    });
    winSection.appendChild(winTable);
    card.appendChild(winSection);

    // Thematic takeaway
    card.appendChild(util.el("div", { class: "deep-tile" }, [
      util.el("div", { class: "t-eyebrow", text: "Thematic takeaway" }),
      util.el("p", { class: "t-muted t-small", style: { marginTop: "var(--s-2)" }, text: payload.thematic })
    ]));

    // Tradeoff matrix
    if (payload.tradeoffs.length) {
      const matrix = util.el("div");
      matrix.appendChild(util.el("div", { class: "deep-section-title", text: "Pairwise tradeoffs" }));
      matrix.appendChild(util.el("div", { class: "stack-sm" }, payload.tradeoffs.map(p => {
        const diffsText = p.differences.length
          ? p.differences.map(d => `${d.leader} wins ${d.category.toLowerCase()} (+${d.magnitude})`).join(" · ")
          : "No dimension separates them by more than 25 points.";
        return util.el("div", { class: "deep-pair" }, [
          util.el("div", { class: "t-eyebrow", text: `${p.a}  vs  ${p.b}` }),
          util.el("div", { class: "t-small t-muted", text: diffsText })
        ]);
      })));
      card.appendChild(matrix);
    }

    // Mood mapping
    const moodSection = util.el("div");
    moodSection.appendChild(util.el("div", { class: "deep-section-title", text: "Mood mapping" }));
    moodSection.appendChild(util.el("p", { class: "t-small t-subtle", style: { marginBottom: "var(--s-3)" }, text: "Tonight, depending on what you're after." }));
    payload.moods.forEach(m => {
      moodSection.appendChild(util.el("div", { class: "deep-mood-row" }, [
        util.el("div", { class: "t-small t-muted", text: m.mood }),
        util.el("div", { class: "t-serif", style: { fontSize: "14px" }, text: m.winner }),
        util.el("div", { class: "tight-flag", text: m.tight ? "close call" : "" })
      ]));
    });
    card.appendChild(moodSection);

    // Reading order
    if (payload.readingOrder) {
      const orderSection = util.el("div");
      orderSection.appendChild(util.el("div", { class: "deep-section-title", text: "Suggested reading order" }));
      const chips = util.el("div", { class: "row-wrap", style: { gap: "var(--s-2)" } });
      payload.readingOrder.order.forEach((t, i) => {
        if (i > 0) chips.appendChild(util.el("span", { class: "reading-order-sep", text: "→" }));
        chips.appendChild(util.el("span", { class: "reading-order-chip" }, [
          util.el("span", { class: "num", text: String(i + 1) }),
          util.el("span", { text: t })
        ]));
      });
      orderSection.appendChild(chips);
      orderSection.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: payload.readingOrder.note }));
      card.appendChild(orderSection);
    }

    // Confidence & uncertainty
    const confSection = util.el("div");
    confSection.appendChild(util.el("div", { class: "deep-section-title", text: "Confidence & uncertainty" }));
    const confGrid = util.el("div", { class: "deep-grid" });
    payload.confidence.entries.forEach(e => {
      confGrid.appendChild(util.el("div", { class: "deep-tile" }, [
        util.el("div", { class: "t-serif", style: { fontSize: "14px" }, text: e.title }),
        util.el("div", { class: "t-tiny t-subtle", text: `Fit ${e.fit} · Confidence ${e.confidence}%` }),
        util.el("div", { class: "bar", style: { marginTop: "var(--s-2)" } }, [util.el("span", { style: { width: `${e.confidence}%` } })]),
        e.critical ? util.el("div", { class: "tag tag-danger", style: { marginTop: "var(--s-2)" } }, "critical warning") : null,
        (e.warnCount > 0 && !e.critical) ? util.el("div", { class: "tag tag-warn", style: { marginTop: "var(--s-2)" } }, `${e.warnCount} warnings`) : null
      ].filter(Boolean)));
    });
    confSection.appendChild(confGrid);
    payload.confidence.flags.forEach(f => {
      confSection.appendChild(util.el("div", { class: f.toLowerCase().includes("critical") ? "caution" : "tradeoff", style: { marginTop: "var(--s-3)" } }, f));
    });
    card.appendChild(confSection);

    return card;
  }

  function openInSara(payload) {
    if (!window.LumenSara) return;
    const titles = payload.titles.join(" · ");
    window.LumenSara.post(`I just ran a deep analysis on **${titles}**. Here's the headline:\n\n${payload.headline}\n\nAsk me for any part of it — tradeoffs, moods, confidence, or reading order.`);
    window.LumenSara.setContext({
      route: "compare",
      chips: [{ label: "Deep analysis active" }, ...payload.titles.map(t => ({ label: t }))]
    });
    window.LumenSara.open();
  }

  /* -------------------- views -------------------- */
  const views = {
    discover() {
      const s = store.get();
      const greeting = s.ui.onboardingDone ? "Welcome back." : "Welcome to Lumen.";
      const pool = listAllBooks();
      const result = Engine.rankRecommendations(s.profile, s.weights, pool);
      const picks = result.scored.slice(0, 3);

      const currentReadingIds = Object.entries(s.bookStates).filter(([, v]) => v === "reading").map(([k]) => k);
      const currentReading = currentReadingIds.map(id => findBook(id)).filter(Boolean);

      const wrap = util.el("div", { class: "page stack-lg" });

      wrap.appendChild(util.el("div", { class: "page-head" }, [
        util.el("div", {}, [
          util.el("div", { class: "t-eyebrow", text: "Home" }),
          util.el("h1", { html: greeting.replace(/Lumen/, "<em>Lumen</em>").replace(/back/, "<em>back</em>") }),
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
        util.el("span", { class: "card-sub t-subtle", text: pool.length ? `Drawn from your profile · ${result.matched} matches` : "your library is the source" })
      ]));
      if (!pool.length) {
        picksCard.appendChild(ui.empty({
          title: "Your library is empty",
          message: "Lumen has no titles to rank yet. Search the web from Discovery, or load the starter library of historical classics from Settings.",
          actions: [
            { label: "Open Discovery", variant: "btn-primary", onClick: () => router.go("discovery") },
            { label: "Open Settings",  variant: "btn",         onClick: () => router.go("settings") }
          ]
        }));
      } else if (!picks.length) {
        picksCard.appendChild(ui.empty({
          title: "Nothing passes your filters yet",
          message: "Your exclusions or warning strictness are ruling everything out. Loosen one of them in your profile.",
          actions: [{ label: "Edit profile", variant: "btn-primary", onClick: () => router.go("profile") }]
        }));
      } else {
        const grid = util.el("div", { class: "row-wrap", style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--s-4)" } });
        picks.forEach(p => grid.appendChild(bookCardMini(p, (sc) => openBookDetail(sc.book.id))));
        picksCard.appendChild(grid);
      }
      wrap.appendChild(picksCard);

      // Weekly insight — a quiet recap of your week
      const entriesThisWeek = s.journal.filter(e => Date.now() - e.ts < 1000 * 60 * 60 * 24 * 7).length;
      const pinnedCount = s.vault.pinned.length;
      const readingStateCount = Object.keys(s.bookStates).length;
      if (entriesThisWeek || pinnedCount || readingStateCount) {
        const insightsCard = util.el("div", { class: "card" });
        insightsCard.appendChild(util.el("div", { class: "card-head" }, [
          util.el("h3", { text: "This week" }),
          util.el("span", { class: "card-sub t-subtle", text: "A quiet summary" })
        ]));
        const row = util.el("div", { class: "row-wrap", style: { gap: "var(--s-5)" } });
        if (entriesThisWeek)     row.appendChild(kpiBlock(entriesThisWeek, entriesThisWeek === 1 ? "journal entry" : "journal entries"));
        if (pinnedCount)         row.appendChild(kpiBlock(pinnedCount,     pinnedCount === 1 ? "book pinned" : "books pinned"));
        if (readingStateCount)   row.appendChild(kpiBlock(readingStateCount, "books tracked"));
        insightsCard.appendChild(row);
        wrap.appendChild(insightsCard);
      }

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

    discovery() {
      return renderDiscovery();
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
          util.el("h1", { html: "Your <em>reader</em> profile" }),
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

    settings() {
      return renderSettings();
    },

    transparency() {
      return renderTransparency();
    }
  };

  function kpiBlock(value, label) {
    return util.el("div", {}, [
      util.el("div", { class: "t-mono", style: { fontSize: "24px", color: "var(--accent)" }, text: String(value) }),
      util.el("div", { class: "t-tiny t-subtle", text: label })
    ]);
  }

  /* ---------- Rank card (ranked-list, donut charts) ---------- */
  function donutSVG(value, label) {
    const V = Math.max(0, Math.min(100, Math.round(value || 0)));
    const CIRC = 2 * Math.PI * 22;            // radius 22 → circumference
    const offset = CIRC * (1 - V / 100);
    const toneClass = V >= 70 ? "good" : V >= 45 ? "warn" : "danger";
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "donut " + toneClass);
    svg.setAttribute("viewBox", "0 0 54 54");
    svg.setAttribute("width", "54"); svg.setAttribute("height", "54");
    svg.setAttribute("aria-label", `${label}: ${V}%`);
    svg.setAttribute("role", "img");

    const track = document.createElementNS(NS, "circle");
    track.setAttribute("class", "track");
    track.setAttribute("cx", "27"); track.setAttribute("cy", "27"); track.setAttribute("r", "22");
    svg.appendChild(track);

    const fill = document.createElementNS(NS, "circle");
    fill.setAttribute("class", "fill");
    fill.setAttribute("cx", "27"); fill.setAttribute("cy", "27"); fill.setAttribute("r", "22");
    fill.setAttribute("stroke-dasharray", CIRC.toFixed(3));
    fill.setAttribute("stroke-dashoffset", offset.toFixed(3));
    svg.appendChild(fill);

    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", "27"); text.setAttribute("y", "27");
    text.textContent = String(V);
    svg.appendChild(text);
    return svg;
  }

  function toRoman(n) {
    const map = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let out = "", r = n;
    for (const [v, s] of map) while (r >= v) { out += s; r -= v; }
    return out || "I";
  }

  function rankCardBig(scored, rank, onClick) {
    const { book, fitScore, confidence, why } = scored;
    const card = util.el("a", {
      class: "rank-card",
      href: "#",
      onclick: (e) => { e.preventDefault(); onClick && onClick(scored); }
    });

    card.appendChild(util.el("div", { class: "rank-numeral", text: toRoman(rank) }));

    const body = util.el("div", { class: "rank-body" });
    body.appendChild(util.el("div", { class: "rank-eyebrow", text: util.humanise(book.subgenre || book.category || "") }));
    body.appendChild(util.el("h4", { text: book.title }));
    body.appendChild(util.el("div", { class: "rank-meta", text: `${book.author} · ${util.fmtYear(book.year)}` }));
    body.appendChild(util.el("p", { class: "rank-blurb", text: book.description }));

    const reasons = [];
    (why.reasons || []).forEach(r => reasons.push({ cls: "", text: r }));
    (why.partials || []).forEach(r => reasons.push({ cls: "partial", text: r }));
    (why.penalties || []).forEach(r => reasons.push({ cls: "penalty", text: r }));
    if (reasons.length) {
      const whyBlock = util.el("div", { class: "why-block" });
      const list = util.el("ul", { class: "why-list" });
      reasons.slice(0, 4).forEach(r => list.appendChild(util.el("li", { class: r.cls, text: r.text })));
      whyBlock.appendChild(list);
      body.appendChild(whyBlock);
    }
    card.appendChild(body);

    const aside = util.el("div", { class: "rank-aside" });
    const fitRow = util.el("div", { class: "donut-row" });
    fitRow.appendChild(donutSVG(fitScore, "Fit"));
    fitRow.appendChild(util.el("div", { class: "donut-meta" }, [
      "Fit",
      util.el("div", { class: "donut-note", text: fitScore >= 70 ? "strong match" : fitScore >= 45 ? "moderate fit" : "loose fit" })
    ]));
    aside.appendChild(fitRow);

    const confRow = util.el("div", { class: "donut-row" });
    confRow.appendChild(donutSVG(confidence, "Confidence"));
    confRow.appendChild(util.el("div", { class: "donut-meta" }, [
      "Confidence",
      util.el("div", { class: "donut-note", text: confidence >= 70 ? "signal-rich" : confidence >= 45 ? "moderate signal" : "thin data" })
    ]));
    aside.appendChild(confRow);

    if (book.content_warnings && book.content_warnings.length) {
      const warns = util.el("div", { class: "warnings-block" });
      warns.appendChild(util.el("div", { class: "warnings-head", text: `Content warnings · ${book.content_warnings.length}` }));
      const ul = util.el("ul");
      book.content_warnings.slice(0, 4).forEach(w => ul.appendChild(util.el("li", { text: w.replace(/-/g, " ") })));
      warns.appendChild(ul);
      aside.appendChild(warns);
    }
    card.appendChild(aside);

    return card;
  }

  /* ---------- Home KPI composition ---------- */
  function buildHomeKpis(s, result) {
    const allBooks = listAllBooks ? listAllBooks().filter(b => !(s.hidden || {})[b.id]) : BOOKS;
    const matched = result.matched;
    const screened = result.screened;
    const excluded = result.excluded;
    const scored = result.scored || [];
    const avgFit = scored.length ? Math.round(scored.reduce((a, x) => a + x.fitScore, 0) / scored.length) : 0;
    const topFit = scored[0] ? scored[0].fitScore : 0;
    const topTitle = scored[0] ? scored[0].book.title : "—";
    const highConf = scored.filter(x => x.confidence >= 70).length;
    const cleanCount = allBooks.filter(b => (b.content_warnings || []).length === 0).length;

    recordKpiHistory({ avgFit, topFit, matched, highConf });
    const dAvg = deltaText(avgFit, kpiHistory.avgFit);
    const dTop = deltaText(topFit, kpiHistory.topFit);
    const dMat = deltaText(matched, kpiHistory.matched);
    const dHi  = deltaText(highConf, kpiHistory.highConf);

    const pctOfCat = screened > 0 ? Math.round((matched / screened) * 100) : 0;

    return buildKpiGrid([
      {
        label: "Titles in catalogue",
        value: screened,
        sub: `${allBooks.length} visible to you`,
        tone: "default"
      },
      {
        label: "Passed your filters",
        value: matched,
        unit: "",
        sub: `${pctOfCat}% of catalogue`,
        delta: dMat.delta, deltaDir: dMat.dir,
        tone: "good",
        spark: [...kpiHistory.matched]
      },
      {
        label: "Average fit",
        value: avgFit,
        unit: "%",
        sub: "across matches",
        delta: dAvg.delta, deltaDir: dAvg.dir,
        tone: "default",
        spark: [...kpiHistory.avgFit]
      },
      {
        label: "Your top match",
        value: topFit,
        unit: "%",
        sub: topTitle.length > 22 ? topTitle.slice(0, 22) + "…" : topTitle,
        delta: dTop.delta, deltaDir: dTop.dir,
        tone: "gold",
        spark: [...kpiHistory.topFit]
      },
      {
        label: "High confidence",
        value: highConf,
        sub: "≥ 70% signal density",
        delta: dHi.delta, deltaDir: dHi.dir,
        tone: "good",
        spark: [...kpiHistory.highConf]
      },
      {
        label: "Clean titles",
        value: cleanCount,
        sub: "no content warnings",
        tone: excluded > 0 ? "warn" : "default"
      }
    ]);
  }

  /* ---------- KPI scorecard helpers (supply-chain style) ---------- */
  // Each item: { label, value, unit?, sub?, delta?, deltaDir? "up"|"down"|"flat",
  //              tone?: "default"|"good"|"warn"|"gold"|"danger",
  //              spark?: number[] (0-100 scale) }
  function buildKpiGrid(items) {
    const grid = util.el("div", { class: "kpi-grid" });
    items.forEach(item => {
      const card = util.el("div", { class: "kpi-card" + (item.tone && item.tone !== "default" ? " kpi-" + item.tone : "") });
      card.appendChild(util.el("div", { class: "kpi-label", text: item.label }));
      const valNode = util.el("div", { class: "kpi-value" });
      const numSpan = util.el("em", { text: String(item.value) });
      valNode.appendChild(numSpan);
      if (item.unit) valNode.appendChild(util.el("span", { class: "unit", text: item.unit }));
      card.appendChild(valNode);
      if (item.sub || item.delta) {
        const sub = util.el("div", { class: "kpi-sub" });
        if (item.delta) {
          const dir = item.deltaDir || "flat";
          sub.appendChild(util.el("span", { class: "delta " + dir, text: item.delta }));
        }
        if (item.sub) sub.appendChild(util.el("span", { text: item.sub }));
        card.appendChild(sub);
      }
      if (item.spark && item.spark.length >= 2) {
        card.appendChild(buildSparkline(item.spark));
      }
      grid.appendChild(card);
    });
    return grid;
  }

  function buildSparkline(values) {
    const W = 46, H = 18;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = (max - min) || 1;
    const step = values.length > 1 ? W / (values.length - 1) : W;
    const points = values.map((v, i) => {
      const x = i * step;
      const y = H - ((v - min) / range) * (H - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const d = "M" + points.join(" L");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "kpi-spark");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }

  /* Maintain rolling sparkline history of recent fit-score states so the
     KPI cards feel live. Scoped to this session only — not persisted. */
  const kpiHistory = { avgFit: [], topFit: [], matched: [], highConf: [] };
  function recordKpiHistory(sample) {
    for (const [k, v] of Object.entries(sample)) {
      const arr = kpiHistory[k] = (kpiHistory[k] || []);
      arr.push(v);
      if (arr.length > 6) arr.shift();
    }
  }
  function deltaText(current, history) {
    if (!history || history.length < 2) return { delta: "—", dir: "flat" };
    const prev = history[history.length - 2];
    const diff = Math.round(current - prev);
    if (diff === 0) return { delta: "±0", dir: "flat" };
    if (diff > 0)  return { delta: "▲ " + diff,  dir: "up" };
    return { delta: "▼ " + Math.abs(diff), dir: "down" };
  }

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

    const themeBtn = buildThemeSwitcher(state.ui.theme);

    const ageBadge = util.el("span", { class: "badge-pill", title: "Adults only" }, "18 · adults only");

    const saraLauncher = util.el("button", {
      class: "sara-launcher",
      "aria-label": "Open Sara",
      title: "Open Sara (your reading companion)",
      onclick: () => window.LumenSara && window.LumenSara.toggle()
    }, [
      util.el("span", { class: "dot" }),
      util.el("span", { text: "Ask Sara" })
    ]);

    top.appendChild(saraLauncher);
    top.appendChild(discreetToggle);
    top.appendChild(themeBtn);
    top.appendChild(ageBadge);
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
    if (window.LumenSara) {
      window.LumenSara.setContext(computeSaraContext(r.id));
    }
  }

  function computeSaraContext(routeId) {
    const s = store.get();
    const chips = [];
    const ctx = { route: routeId, chips, book: null, compareSlots: [], journalEntryId: null };
    const readingCount = Object.entries(s.bookStates).filter(([, v]) => v === "reading").length;
    const wantCount    = Object.entries(s.bookStates).filter(([, v]) => v === "want").length;

    if (routeId === "discover") {
      chips.push({ label: "Home" });
      chips.push({ label: `Strictness: ${s.profile.warnStrict}` });
      if (readingCount) chips.push({ label: `Reading ${readingCount}` });
    } else if (routeId === "library") {
      chips.push({ label: "Library" });
      if (libState && libState.query) chips.push({ label: `Search: "${libState.query}"` });
      if (libState && libState.readingFilter !== "all") chips.push({ label: `Filter: ${libState.readingFilter}` });
    } else if (routeId === "compare") {
      chips.push({ label: "Compare" });
      const titles = (cmpState.slots || [cmpState.a, cmpState.b])
        .filter(Boolean)
        .map(id => findBook(id)?.title)
        .filter(Boolean);
      titles.forEach(t => chips.push({ label: t }));
      ctx.compareSlots = titles;
    } else if (routeId === "journal") {
      chips.push({ label: "Journal" });
      const entry = s.journal.find(e => e.id === journalState.selectedId);
      if (entry) {
        chips.push({ label: entry.title ? `Entry: ${entry.title}` : "Untitled entry" });
        if (entry.bookId) {
          const b = findBook(entry.bookId);
          if (b) chips.push({ label: `On: ${b.title}` });
        }
        ctx.journalEntryId = entry.id;
      }
    } else if (routeId === "vault") {
      chips.push({ label: "Vault" });
      if (s.vault.pinned.length)   chips.push({ label: `${s.vault.pinned.length} pinned` });
      if (s.vault.analyses.length) chips.push({ label: `${s.vault.analyses.length} saved analyses` });
    } else if (routeId === "profile") {
      chips.push({ label: "Profile" });
      chips.push({ label: `Heat ${s.profile.heat}/5` });
      chips.push({ label: `Consent ${s.profile.consent}/5` });
      chips.push({ label: `Strictness: ${s.profile.warnStrict}` });
    } else if (routeId === "chat") {
      chips.push({ label: "Connections" });
      chips.push({ label: `${s.chats.friends.length} friend${s.chats.friends.length === 1 ? "" : "s"}` });
    } else if (routeId === "discovery") {
      chips.push({ label: "Discovery" });
      if (discoveryState && discoveryState.lastQuery) chips.push({ label: `Search: "${discoveryState.lastQuery}"` });
      const discoveredCount = (s.discovered || []).length;
      if (discoveredCount) chips.push({ label: `${discoveredCount} discovered` });
    } else if (routeId === "settings") {
      chips.push({ label: "Settings" });
    } else if (routeId === "transparency") {
      chips.push({ label: "Transparency" });
    }
    return ctx;
  }

  const THEMES = [
    { id: "rose",      label: "Rose Atelier",  preview: "linear-gradient(135deg, #f9f0ec, #b84a62, #8e2e44)" },
    { id: "plum",      label: "Midnight Plum", preview: "linear-gradient(135deg, #3a2340, #28182c, #160c19)" },
    { id: "pearl",     label: "Pearl & Gold",  preview: "linear-gradient(135deg, #faf6ef, #c9a050, #7a5c28)" },
    { id: "botanical", label: "Botanical Dusk", preview: "linear-gradient(135deg, #e6ddc8, #a86670, #6a7e5a)" }
  ];
  function normalizeTheme(t) {
    if (THEMES.some(x => x.id === t)) return t;
    if (t === "dark") return "plum";
    return "rose";
  }
  function buildThemeSwitcher(currentRaw) {
    const current = normalizeTheme(currentRaw);
    const pill = util.el("div", { class: "theme-switcher", role: "group", "aria-label": "Theme" });
    THEMES.forEach(t => {
      const dot = util.el("button", {
        type: "button",
        class: "theme-dot" + (t.id === current ? " is-active" : ""),
        "aria-label": t.label,
        "aria-pressed": t.id === current ? "true" : "false",
        title: t.label,
        style: { background: t.preview },
        onclick: () => {
          store.update(s => { s.ui.theme = t.id; });
          applyUIFlags();
        }
      });
      pill.appendChild(dot);
    });
    return pill;
  }

  function applyUIFlags() {
    const s = store.get();
    const theme = normalizeTheme(s.ui.theme);
    // Body-class migration for the new four-theme system.
    document.body.classList.remove("theme-rose", "theme-plum", "theme-pearl", "theme-botanical");
    document.body.classList.add("theme-" + theme);
    // Legacy attributes kept so existing CSS rules / scripts don't break.
    document.documentElement.setAttribute("data-theme", theme);
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

  /* -------------------- command palette + keyboard -------------------- */
  function openPalette() {
    const commands = [
      ...ROUTES.map(r => ({ label: `Go to ${r.label}`, hint: r.id, run: () => router.go(r.id) })),
      { label: "Toggle theme", hint: "T", run: () => { store.update(s => {
          const order = ["rose", "plum", "pearl", "botanical"];
          const cur = order.indexOf(normalizeTheme(s.ui.theme));
          s.ui.theme = order[(cur + 1) % order.length];
        }); applyUIFlags(); } },
      { label: "Toggle discreet mode", hint: "D", run: () => { store.update(s => { s.ui.discreet = !s.ui.discreet; }); applyUIFlags(); } },
      { label: "New journal entry", hint: "", run: () => {
        const draft = newEntryDraft();
        store.update(s => { s.journal.unshift(draft); });
        journalState.selectedId = draft.id;
        router.go("journal");
      } },
      { label: "Export snapshot", hint: "", run: () => {
        downloadText(`lumen-export-${Date.now()}.json`, JSON.stringify(store.get(), null, 2));
        ui.toast("Snapshot exported");
      } },
      { label: "Open Transparency", hint: "", run: () => router.go("transparency") },
      { label: "Open Settings",     hint: "", run: () => router.go("settings") },
      { label: "Open Sara",          hint: "S", run: () => window.LumenSara && window.LumenSara.open() },
      { label: "Close Sara",         hint: "",  run: () => window.LumenSara && window.LumenSara.close() }
    ];

    if (cmpState.slots && cmpState.slots.filter(Boolean).length >= 2) {
      commands.push({ label: "Compare: run deep analysis", hint: "", run: () => { router.go("compare"); setTimeout(() => renderCompare._runDeep && renderCompare._runDeep(), 80); } });
    }
    if (cmpState.slots && cmpState.slots.some(Boolean)) {
      commands.push({ label: "Compare: clear all slots", hint: "", run: () => { cmpState.slots = [null, null, null]; cmpState.lastDeepAnalysis = null; renderView(); } });
    }

    let host = document.getElementById("palette-host");
    if (!host) {
      host = util.el("div", { id: "palette-host", class: "modal-host", role: "dialog", "aria-modal": "true" });
      document.body.appendChild(host);
    }
    host.innerHTML = "";
    const close = () => { host.classList.remove("open"); setTimeout(() => host.innerHTML = "", 220); };

    const palette = util.el("div", { class: "palette" });
    const input = util.el("input", { class: "palette-input", placeholder: "Jump to…", autofocus: true });
    palette.appendChild(input);
    const list = util.el("div", { class: "palette-list" });
    palette.appendChild(list);

    let filtered = commands;
    let idx = 0;
    function paint() {
      list.innerHTML = "";
      filtered.forEach((c, i) => {
        const item = util.el("div", { class: "palette-item", "aria-selected": i === idx ? "true" : "false",
          onclick: () => { c.run(); close(); }
        }, [
          util.el("span", { text: c.label }),
          c.hint ? util.el("span", { class: "kbd" }, c.hint) : null
        ].filter(Boolean));
        list.appendChild(item);
      });
    }
    paint();

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase().trim();
      filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;
      idx = 0; paint();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(idx + 1, filtered.length - 1); paint(); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); idx = Math.max(idx - 1, 0); paint(); }
      else if (e.key === "Enter")     { e.preventDefault(); const c = filtered[idx]; if (c) { c.run(); close(); } }
    });

    host.appendChild(palette);
    host.classList.add("open");
    host.addEventListener("click", (e) => { if (e.target === host) close(); }, { once: true });
    setTimeout(() => input.focus(), 20);
  }

  function setupKeyboard() {
    let gTimer = null;
    let gPending = false;
    document.addEventListener("keydown", (e) => {
      // Skip when typing in inputs
      const tag = e.target.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable;

      // Cmd/Ctrl-K palette — always available
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
        return;
      }

      if (typing) return;

      if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey) {
        gPending = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(() => { gPending = false; }, 900);
        return;
      }

      if (gPending) {
        const map = { h: "discover", l: "library", c: "compare", m: "chat", j: "journal", v: "vault", p: "profile", t: "transparency" };
        const k = e.key.toLowerCase();
        if (map[k]) { e.preventDefault(); router.go(map[k]); gPending = false; clearTimeout(gTimer); }
        return;
      }

      if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) {
        store.update(s => {
          const order = ["rose", "plum", "pearl", "botanical"];
          const cur = order.indexOf(normalizeTheme(s.ui.theme));
          s.ui.theme = order[(cur + 1) % order.length];
        });
        applyUIFlags();
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        store.update(s => { s.ui.discreet = !s.ui.discreet; });
        applyUIFlags();
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) {
        if (window.LumenSara) window.LumenSara.toggle();
      }
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

    setupKeyboard();

    // Mount Sara (persistent floating assistant) once at shell level.
    if (window.LumenSara) window.LumenSara.boot();

    adultGate();
  }

  // Expose a small surface for later batches to hook into.
  window.Lumen = { store, router, ui, util, views, ROUTES, saraRespond };
  document.addEventListener("DOMContentLoaded", boot);
})();
