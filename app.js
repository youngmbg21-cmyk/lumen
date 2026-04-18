/* ============================================================
   Lumen — Application (Batch 1)
   Modules: util, store, router, ui, views/*
   All state is local. No network calls.
   ============================================================ */
(function () {
  "use strict";

  const { BOOKS, VOCAB, SCENARIOS, DEFAULT_WEIGHTS, DEFAULT_PROFILE, READING_STATES, ALL_WARNINGS } = window.LumenData;

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

  /* -------------------- views (Batch 1 stubs) -------------------- */
  const views = {
    discover() {
      const s = store.get();
      const greeting = s.ui.onboardingDone ? "Welcome back." : "Welcome to Lumen.";
      return util.el("div", { class: "page stack-lg" }, [
        util.el("div", { class: "page-head" }, [
          util.el("div", {}, [
            util.el("div", { class: "t-eyebrow", text: "Home" }),
            util.el("h1", { text: greeting }),
            util.el("p", { class: "lede", text: "A private, taste-aware reading companion. Nothing leaves your device." })
          ]),
          util.el("div", { class: "row" }, [
            util.el("button", { class: "btn", onclick: () => router.go("profile") }, "Edit profile"),
            util.el("button", { class: "btn btn-primary", onclick: () => router.go("library") }, "Browse library")
          ])
        ]),
        util.el("div", { class: "card card-accent" }, [
          util.el("div", { class: "t-eyebrow", text: "Sara · your guide" }),
          util.el("h3", { class: "t-serif", text: "What are you in the mood for today?" }),
          util.el("p", { class: "t-muted", text: "I can help you narrow down by mood, compare two titles side by side, or reflect on what you just read. Pick one to begin." }),
          util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-4)" } }, [
            util.el("button", { class: "btn btn-sm", onclick: () => router.go("chat") }, "Talk with Sara"),
            util.el("button", { class: "btn btn-sm", onclick: () => router.go("compare") }, "Compare two titles"),
            util.el("button", { class: "btn btn-sm", onclick: () => router.go("journal") }, "Write a reflection")
          ])
        ]),
        util.el("div", { class: "card" }, [
          util.el("div", { class: "card-head" }, [
            util.el("h3", { text: "Daily picks" }),
            util.el("span", { class: "card-sub t-subtle", text: "Batch 2 will render these from your profile." })
          ]),
          ui.skeleton({ lines: 3, block: true })
        ])
      ]);
    },

    library() {
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Library", "Everything available to explore, with your reading state visible at a glance."),
        ui.empty({
          title: "The library renders next",
          message: "Batch 3 wires up the catalog grid, reading-state filters (Want to read, Currently reading, Already read, Not for me), and custom tags.",
          actions: [
            { label: "Preview via Compare", variant: "btn-ghost", onClick: () => router.go("compare") }
          ]
        })
      ]);
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
      return util.el("div", { class: "page stack-lg" }, [
        pageHead("Profile", "Your reader profile and fit-engine weights. All values are local."),
        util.el("div", { class: "card" }, [
          util.el("h3", { text: "Current profile (preview)" }),
          util.el("p", { class: "t-muted t-small", style: { marginTop: "var(--s-2)" }, text: "Batch 2 replaces this with grouped controls, live previews, and an onboarding wizard." }),
          util.el("pre", { class: "t-mono t-tiny", style: {
            marginTop: "var(--s-4)",
            padding: "var(--s-4)",
            background: "var(--bg-sunken)",
            borderRadius: "var(--r-2)",
            overflow: "auto",
            border: "1px solid var(--border)"
          }, text: JSON.stringify(store.get().profile, null, 2) })
        ])
      ]);
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
  function adultGate() {
    if (store.get().ui.adultConfirmed) return;
    ui.modal({
      title: "Before you begin",
      body: `<p class="t-muted">Lumen discusses adult literature — erotic classics, sexuality texts, and works with mature themes. Please confirm you are an adult and understand the material may include historically problematic content.</p>
             <p class="t-small t-subtle" style="margin-top: var(--s-3);">Your profile and everything you save stays on this device.</p>`,
      primary: { label: "I'm an adult — continue", onClick: () => {
        store.update(s => { s.ui.adultConfirmed = true; });
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
