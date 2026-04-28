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
    },
    // Detect Google Books' "Image not available" placeholder. That
    // response is a 200 OK image (~60×90 px) so <img> onerror never
    // fires; real book covers at zoom=1 are ≥128 wide. Call this in
    // img.onload to decide whether to keep the cover or swap in an
    // initials fallback.
    isLikelyNoCover: (img) => !!img && img.naturalWidth > 0 && img.naturalWidth < 128
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
      // User-flagged favourites — keyed by bookId → timestamp. Used
      // by the Library "Favorites" filter and by Daily Picks
      // reweighting (a taste signal layered on top of the engine
      // score).
      favorites: {},
      discovered: [],
      journal: [],
      vault: { pinned: [], analyses: [], notes: [], locked: false, passcodeHash: null },
      chats: { bianca: [], biancaPinned: [], friends: [] },
      // Daily Picks the user has rejected via "Not for me". These are
      // excluded from the Home top-3 but stay in the Library — a
      // pick-only signal, not a dismissal. { [bookId]: { rejectedAt } }.
      dailyPicksRejected: {},
      // Editorial AI feature (replaces Daily Picks in the Today tab).
      // currentPick is the last-generated piece; history keeps the
      // last 10 for recall. generationsToday is a rolling list of
      // ISO timestamps used for the 5-per-24h rate limit. lastError
      // tracks the most recent failure so the Today view can
      // surface a recoverable state without wiping currentPick.
      editorial: {
        currentPick: null,
        history: [],
        generationsToday: [],
        lastError: null
      },
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
      const merged = Object.assign(initialState(), parsed);
      // Back-fill persona/preference keys added after first release so
      // older states pick up the defaults instead of rendering as
      // undefined. Applied to profile only — everything else is
      // already handled by the shallow Object.assign above.
      merged.profile = Object.assign({}, DEFAULT_PROFILE, merged.profile || {});
      // Migration v2: old DEFAULT_PROFILE had consent:5 and taboo:2 which
      // compressed most scores below 65%. Reset to neutral 3 on first load
      // after this release so existing users see meaningful score signal.
      if (!merged._profileMigrated_v2) {
        if (merged.profile.consent === 5) merged.profile.consent = 3;
        if (merged.profile.taboo   === 2) merged.profile.taboo   = 3;
        merged._profileMigrated_v2 = true;
      }
      // Same for the chats submap so newer arrays (biancaPinned,
      // dailyPicksRejected) exist on upgrade.
      // Migration: rename legacy sara/saraPinned keys to bianca/biancaPinned.
      if (merged.chats && merged.chats.sara !== undefined) {
        if (!merged.chats.bianca || !merged.chats.bianca.length) merged.chats.bianca = merged.chats.sara;
        delete merged.chats.sara;
      }
      if (merged.chats && merged.chats.saraPinned !== undefined) {
        if (!merged.chats.biancaPinned || !merged.chats.biancaPinned.length) merged.chats.biancaPinned = merged.chats.saraPinned;
        delete merged.chats.saraPinned;
      }
      merged.chats = Object.assign({ bianca: [], biancaPinned: [], friends: [] }, merged.chats || {});
      if (!merged.dailyPicksRejected) merged.dailyPicksRejected = {};
      // Editorial feature state — back-fill the shape on older stores
      // so rendering code can read merged.editorial.currentPick etc.
      // without null-checking the parent.
      merged.editorial = Object.assign(
        { currentPick: null, history: [], generationsToday: [], lastError: null },
        merged.editorial || {}
      );
      return merged;
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

    // Reusable premium detail sheet — wider, sticky chrome, three-
    // slot header (cover · meta · aside), scrollable middle. Used for
    // book detail, vault entry detail, and anywhere the old 520px
    // modal was too narrow for a real reading surface.
    detailSheet({ eyebrow, title, subtitle, cover, headerAside, sections = [], actions = [] }) {
      let host = document.getElementById("modal-host");
      if (!host) {
        host = util.el("div", { id: "modal-host", class: "modal-host", role: "dialog", "aria-modal": "true" });
        document.body.appendChild(host);
      }
      host.innerHTML = "";
      const close = () => {
        host.classList.remove("open");
        setTimeout(() => (host.innerHTML = ""), 220);
        // Clear Bianca's focus-on-book so the head status line stops
        // saying "Reading <title> with you" once the sheet is gone.
        try {
          if (typeof libState !== "undefined" && libState) libState.focusBookId = null;
          if (window.LumenBianca && window.LumenBianca.setContext) {
            const r = router.current();
            window.LumenBianca.setContext(computeBiancaContext(r.id));
          }
        } catch (e) { /* ignore */ }
      };

      const sheet = util.el("div", { class: "detail-sheet" });

      // Sticky header — cover + meta + aside (e.g. fit/confidence rings).
      const head = util.el("div", { class: "detail-sheet-head" });
      if (cover) {
        const coverWrap = util.el("div", { class: "detail-sheet-cover" }, [cover]);
        head.appendChild(coverWrap);
      }
      const meta = util.el("div", { class: "detail-sheet-meta" });
      if (eyebrow) meta.appendChild(util.el("div", { class: "detail-sheet-eyebrow", text: eyebrow }));
      if (title)   meta.appendChild(util.el("h2", { class: "detail-sheet-title", text: title }));
      if (subtitle) meta.appendChild(util.el("div", { class: "detail-sheet-subtitle", text: subtitle }));
      head.appendChild(meta);
      if (headerAside) {
        const aside = util.el("div", { class: "detail-sheet-aside" }, [headerAside]);
        head.appendChild(aside);
      }
      // Close button pinned to the top-right; doesn't push content.
      head.appendChild(util.el("button", {
        class: "detail-sheet-close", "aria-label": "Close", onclick: close
      }, "×"));
      sheet.appendChild(head);

      // Scrollable body — each section is title + content block.
      const bodyScroll = util.el("div", { class: "detail-sheet-scroll" });
      sections.forEach(sec => {
        if (!sec) return;
        const block = util.el("section", { class: "detail-sheet-section" + (sec.tone ? ` tone-${sec.tone}` : "") });
        if (sec.label) block.appendChild(util.el("div", { class: "detail-sheet-section-label", text: sec.label }));
        if (sec.content instanceof Node) block.appendChild(sec.content);
        else if (typeof sec.content === "string") block.appendChild(util.el("p", { class: "detail-sheet-prose", text: sec.content }));
        bodyScroll.appendChild(block);
      });
      sheet.appendChild(bodyScroll);

      // Sticky footer — primary/secondary actions stay in view while
      // the body scrolls.
      if (actions.length) {
        const foot = util.el("div", { class: "detail-sheet-foot" });
        actions.forEach(a => {
          if (!a) return;
          if (a.href) {
            foot.appendChild(util.el("a", {
              class: "btn btn-sm" + (a.variant ? ` ${a.variant}` : " btn-ghost"),
              href: a.href, target: a.target || "_blank", rel: "noopener noreferrer"
            }, a.label));
          } else {
            foot.appendChild(util.el("button", {
              class: "btn btn-sm" + (a.variant ? ` ${a.variant}` : ""),
              onclick: () => { a.onClick && a.onClick(); if (a.closeOnClick !== false) close(); }
            }, a.label));
          }
        });
        sheet.appendChild(foot);
      }

      host.appendChild(sheet);
      host.classList.add("open");
      host.addEventListener("click", (e) => { if (e.target === host) close(); }, { once: true });
      // Escape key closes.
      const esc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
      document.addEventListener("keydown", esc);
      return { close };
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
    { id: "discover",     label: "Today",         short: "Today",    group: "main",     render: () => views.discover() },
    { id: "terminal",     label: "Signals",       short: "Signals",  group: "main",     render: () => views.terminal() },
    { id: "discovery",    label: "Discovery",     short: "Discover", group: "main",     render: () => views.discovery() },
    { id: "library",      label: "Library",       short: "Library",  group: "main",     render: () => views.library() },
    { id: "compare",      label: "Compare",       short: "Compare",  group: "main",     render: () => views.compare() },
    { id: "chat",         label: "Connections",   short: "Connect",  group: "main",     render: () => views.chat() },
    { id: "journal",      label: "Journal",       short: "Journal",  group: "personal", render: () => views.journal() },
    { id: "vault",        label: "Vault",         short: "Vault",    group: "personal", render: () => views.vault() },
    { id: "profile",      label: "Profile",       short: "Profile",  group: "settings", render: () => views.profile() },
    { id: "settings",     label: "Settings",      short: "Settings", group: "hidden",   render: () => views.settings() },
    { id: "transparency", label: "Transparency",  short: "Trust",    group: "settings", render: () => views.transparency() }
  ];

  const router = {
    current() {
      const hash = location.hash.replace(/^#\/?/, "");
      return ROUTES.find(r => r.id === hash) || ROUTES.find(r => r.id === "discovery") || ROUTES[0];
    },
    go(id) { location.hash = `#/${id}`; }
  };

  // Discovery Phase: on a bare load (no hash) redirect to the
  // Discovery view so testers land on the search experience, not
  // the empty Today editorial tab.
  (function setDiscoveryDefault() {
    if (!location.hash || location.hash === "#" || location.hash === "#/") {
      location.replace("#/discovery");
    }
  })();

  /* -------------------- view helpers -------------------- */
  // Bookmark / share-with-Bianca button used on every book-card surface.
  // Toggling it opens Bianca, drops the book into the chat as a rich
  // shared-card message, and adds it to the pinned tray. Tapping again
  // unpins. Stops event propagation so the card's own onclick (open
  // detail) doesn't also fire.
  function pinShareBtn(bookId, opts = {}) {
    const Bianca = window.LumenBianca;
    const pinned = !!(Bianca && Bianca.isPinned && Bianca.isPinned(bookId));
    const btn = util.el("button", {
      class: "card-pin" + (pinned ? " is-pinned" : "") + (opts.size === "lg" ? " card-pin-lg" : ""),
      "aria-label": pinned ? "Unpin from Bianca" : "Pin to Bianca — share in chat",
      "aria-pressed": pinned ? "true" : "false",
      title: pinned ? "Unpin from Bianca" : "Pin to Bianca",
      onclick: (e) => {
        e.stopPropagation();
        if (!Bianca) return;
        if (Bianca.isPinned(bookId)) Bianca.unpinBook(bookId);
        else Bianca.pinBook(bookId);
        // Re-render the host view so other pin icons in the same view
        // also reflect the new pinned state.
        try { renderView(); } catch (e2) { /* ignore */ }
      }
    });
    // Bookmark glyph — solid when pinned, outline otherwise.
    btn.innerHTML = pinned
      ? '<span aria-hidden="true">❦</span>'
      : '<span aria-hidden="true">⚐</span>';
    return btn;
  }

  // Cover block shared by Daily Picks + detail modal. Google Books
  // thumbnails upgraded to https; a two-letter initials block falls in
  // if the URL 404s or the book has no thumbnail at all. The optional
  // heat bar pinned to the bottom matches the existing library card.
  function buildCoverBlock(book, { size = "md", showHeat = true } = {}) {
    const cover = util.el("div", { class: `book-cover book-cover-${size}` });
    const showInitialsFallback = () => {
      if (!cover.querySelector(".cover-fallback")) {
        cover.appendChild(util.el("div", { class: "cover-fallback", text: (book.title || "??").slice(0, 2).toUpperCase() }));
      }
    };
    if (book.thumbnail) {
      const url = book.thumbnail.replace(/^http:/, "https:");
      const img = util.el("img", {
        src: url, alt: `Cover of ${book.title}`, loading: "lazy",
        onerror: function () { this.remove(); showInitialsFallback(); },
        onload:  function () { if (util.isLikelyNoCover(this)) { this.remove(); showInitialsFallback(); } }
      });
      cover.appendChild(img);
    } else {
      cover.appendChild(util.el("div", { class: "cover-fallback", text: (book.title || "??").slice(0, 2).toUpperCase() }));
    }
    if (showHeat && book.heat_level != null) {
      cover.appendChild(util.el("div", { class: "steam-indicator " + steamClass(book.heat_level) }));
    }
    return cover;
  }

  function bookCardMini(scored, onClick) {
    const { book, fitScore, confidence, why } = scored;
    const card = util.el("div", {
      class: "book-card",
      role: "button",
      tabindex: "0",
      "aria-label": `Open ${book.title}`,
      onclick: () => { onClick && onClick(scored); },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick && onClick(scored); }
      }
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

  // Build a label block: uppercase label on the left, optional italic
  // serif ornament word on the right. Matches the editorial field-label
  // pattern from the mockup (e.g. "DESIRED HEAT LEVEL … temperature").
  function buildFieldLabel(labelText, ornament) {
    const nodes = [util.el("span", { text: labelText })];
    if (ornament) nodes.push(util.el("span", { class: "field-ornament", text: ornament }));
    return util.el("div", { class: "field-label" }, nodes);
  }

  function numericSlider(key, label, help, ornament) {
    const state = store.get();
    const row = util.el("div", { class: "field slider-field" });
    row.appendChild(buildFieldLabel(label, ornament));
    const input = util.el("input", {
      class: "slider",
      id: `prof_${key}`,
      type: "range", min: "1", max: "5", step: "1",
      value: String(state.profile[key]),
      oninput: (e) => {
        const v = parseInt(e.target.value, 10);
        store.update(s => { s.profile[key] = v; });
        const disp = document.getElementById(`prof_${key}_val`);
        if (disp) disp.textContent = String(v);
        refreshProfilePreview();
      }
    });
    const sliderRow = util.el("div", { class: "slider-field-row" }, [
      input,
      util.el("span", { class: "slider-value", id: `prof_${key}_val`, text: String(state.profile[key]) })
    ]);
    row.appendChild(sliderRow);
    if (help) row.appendChild(util.el("div", { class: "field-help", text: help }));
    return row;
  }

  function chipGroup(key, label, vocab, { exclude = false, help, ornament } = {}) {
    const state = store.get();
    const wrap = util.el("div", { class: "field" });
    if (label || ornament) wrap.appendChild(buildFieldLabel(label || "", ornament));
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

  // Descriptors for the italic word under the numeric on each KPI card.
  // Kept concise so the card reads like the attached fit-score reference.
  function kpiDescriptorFive(value) {
    if (value >= 5) return "Maxed";
    if (value >= 4) return "High";
    if (value >= 3) return "Moderate";
    if (value >= 2) return "Low";
    return "Minimal";
  }
  function kpiDescriptorConsent(value) {
    if (value >= 5) return "On-page only";
    if (value >= 4) return "Clear";
    if (value >= 3) return "Moderate";
    return "Period-tolerant";
  }
  function kpiDescriptorTaboo(value) {
    if (value >= 5) return "Open";
    if (value >= 4) return "Permissive";
    if (value >= 3) return "Selective";
    if (value >= 2) return "Cautious";
    return "Safe-first";
  }
  function kpiDescriptorFit(value) { return Engine.fitLabel(value); }

  // Small radial ring used by each KPI card. Takes a 0..1 fill and a
  // short inner text. Styled via .kpi-ring in CSS — stroke colour shifts
  // with .low / .mid / .high tone classes. 54×54 matches the attached
  // fit-score card proportions. The circles live inside a rotated group
  // so the arc starts at 12 o'clock while the centre label stays upright.
  function kpiRing(fill, innerText, tone) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const R = 22;
    const CIRC = 2 * Math.PI * R;
    const safeFill = Math.max(0, Math.min(1, Number(fill) || 0));
    const offset = CIRC * (1 - safeFill);
    svg.setAttribute("class", "kpi-ring-svg " + (tone || ""));
    svg.setAttribute("viewBox", "0 0 54 54");
    svg.setAttribute("width", "54"); svg.setAttribute("height", "54");
    svg.setAttribute("aria-hidden", "true");

    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", "rotate(-90 27 27)");

    const track = document.createElementNS(NS, "circle");
    track.setAttribute("class", "track");
    track.setAttribute("cx", "27"); track.setAttribute("cy", "27"); track.setAttribute("r", String(R));
    g.appendChild(track);

    const fillRing = document.createElementNS(NS, "circle");
    fillRing.setAttribute("class", "fill");
    fillRing.setAttribute("cx", "27"); fillRing.setAttribute("cy", "27"); fillRing.setAttribute("r", String(R));
    fillRing.setAttribute("stroke-dasharray", CIRC.toFixed(3));
    fillRing.setAttribute("stroke-dashoffset", offset.toFixed(3));
    g.appendChild(fillRing);

    svg.appendChild(g);

    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", "27"); t.setAttribute("y", "27");
    t.textContent = innerText;
    svg.appendChild(t);
    return svg;
  }

  function kpiToneFromFraction(fill) {
    if (fill >= 0.7) return "high";
    if (fill >= 0.4) return "mid";
    return "low";
  }

  // One KPI card. Mirrors the attached fit-score reference: ring on the
  // left, uppercase label + italic descriptor stacked on the right.
  // The numeric value lives INSIDE the ring only — we deliberately drop
  // the extra "3/5" line below the label because it duplicated the
  // ring's inner number. Title-attribute carries the full "3/5" /
  // "56/100" string so hover/assistive tech still see the exact scale.
  function buildKpiCard({ label, tooltip, fill, innerText, tone, descriptor, title }) {
    const card = util.el("div", { class: "kpi-card", title: tooltip || title || label });
    const ring = util.el("div", { class: "kpi-ring" }, [kpiRing(fill, innerText, tone)]);
    card.appendChild(ring);
    const body = util.el("div", { class: "kpi-body" });
    body.appendChild(util.el("div", { class: "kpi-label", text: label }));
    body.appendChild(util.el("div", { class: "kpi-sub", text: descriptor }));
    card.appendChild(body);
    return card;
  }

  // Compute the single Fit Score KPI — the mean fit across the current
  // user library for the active profile. Falls back to a neutral 50 when
  // there is nothing in the library yet so the card still has something
  // to render.
  function computeProfileFitScore(s) {
    const pool = listAllBooks().filter(b => !(s.hidden || {})[b.id]);
    if (!pool.length) return { value: 50, hasData: false };
    const ranked = Engine.rankRecommendations(s.profile, s.weights, pool);
    const scored = ranked.scored || [];
    if (!scored.length) return { value: 50, hasData: false };
    const mean = Math.round(scored.reduce((acc, x) => acc + x.fitScore, 0) / scored.length);
    return { value: Math.max(0, Math.min(100, mean)), hasData: true };
  }

  // Build the full KPI strip (8 cards). Caller places it in the DOM.
  function buildProfileKpiStrip() {
    const s = store.get();
    const p = s.profile;
    const tagKeys = ["tone", "pacing", "style", "dynamic", "trope", "kink", "orientation"];
    const tagsSelected = tagKeys.reduce((acc, k) => acc + ((p[k] || []).length), 0);
    const fit = computeProfileFitScore(s);

    const strip = util.el("div", { class: "kpi-strip" });

    const fiveCard = (label, value, descriptorFn = kpiDescriptorFive, prefix = "") => {
      const fill = Math.max(0, Math.min(1, value / 5));
      return buildKpiCard({
        label, fill,
        innerText: `${prefix}${value}`,
        tone: kpiToneFromFraction(fill),
        tooltip: `${label}: ${prefix}${value}/5 · ${descriptorFn(value)}`,
        descriptor: descriptorFn(value)
      });
    };

    strip.appendChild(fiveCard("Heat",     p.heat));
    strip.appendChild(fiveCard("Explicit", p.explicit));
    strip.appendChild(fiveCard("Emotion",  p.emotion));
    strip.appendChild(fiveCard("Consent floor", p.consent, kpiDescriptorConsent, "≥"));
    strip.appendChild(fiveCard("Taboo tolerance", p.taboo, kpiDescriptorTaboo));
    strip.appendChild(fiveCard("Plot weight", p.plot));

    // Tags selected — no ceiling, so the ring fills proportionally up to
    // a soft cap of 20 (anything above reads as "extensive").
    const tagFill = Math.max(0, Math.min(1, tagsSelected / 20));
    const tagsDescriptor = tagsSelected === 0 ? "None yet" : tagsSelected >= 10 ? "Extensive" : tagsSelected >= 4 ? "Shaped" : "Sparse";
    strip.appendChild(buildKpiCard({
      label: "Tags selected",
      fill: tagFill,
      innerText: String(tagsSelected),
      tone: kpiToneFromFraction(tagFill),
      tooltip: `Tags selected: ${tagsSelected} · ${tagsDescriptor}`,
      descriptor: tagsDescriptor
    }));

    // Fit score — the premium card that mirrors the attached reference.
    const fitFill = fit.value / 100;
    const fitDescriptor = fit.hasData ? kpiDescriptorFit(fit.value) : "No library yet";
    strip.appendChild(buildKpiCard({
      label: "Fit score",
      fill: fitFill,
      innerText: String(fit.value),
      tone: kpiToneFromFraction(fitFill),
      tooltip: `Fit score: ${fit.value}/100 · ${fitDescriptor}`,
      descriptor: fitDescriptor
    }));

    return strip;
  }

  // Re-renders the live KPI strip in place. Called from slider/chip/
  // segmented updates so values animate with every tweak. Name kept
  // (refreshProfilePreview) so existing callsites continue to work.
  function refreshProfilePreview() {
    const host = document.getElementById("profile-kpi-strip");
    if (!host) return;
    host.innerHTML = "";
    host.appendChild(buildProfileKpiStrip());
  }

  /* -------------------- library -------------------- */
  const libState = {
    query: "",
    readingFilter: "all",
    category: "all",
    sort: "fit",
    minFit: 0,
    // Session-only — not persisted to localStorage. Default is
    // Exact is always the default — it works without any API key and
    // is the expected starting point for most searches. Semantic is
    // opt-in once a Voyage key is configured.
    searchMode: "exact"
  };

  // Closure for the semantic-search async flow. Reset on reload
  // implicitly because libState itself isn't persisted. The seq
  // counter discards stale embed responses when the user keeps
  // typing.
  const semanticState = {
    lastQueryText: "",
    lastQueryVec: null,
    loading: false,
    seq: 0,
    debounceTimer: null,
    // Last embed error. We keep Semantic selected on failure and
    // surface this in the stats bar so the user understands why
    // the ordering hasn't changed — flipping them back to Exact
    // silently made the button feel "broken".
    lastError: null
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

  // Favourites are orthogonal to reading state — a user can
  // "favourite" something they've never read and something
  // they've read multiple times. Stored as { [bookId]: timestamp }
  // so Daily Picks can later weight recent favourites higher.
  function isFavorite(bookId) {
    return !!(store.get().favorites || {})[bookId];
  }
  function toggleFavorite(bookId) {
    if (!bookId) return;
    store.update(s => {
      s.favorites = s.favorites || {};
      if (s.favorites[bookId]) delete s.favorites[bookId];
      else s.favorites[bookId] = Date.now();
    });
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
      explicitness: 3,
      emotional_intensity: 3,
      consent_clarity: 3,
      taboo_level: 3,
      plot_weight: 3,
      tone: [], pacing: [], literary_style: [],
      relationship_dynamic: [], trope_tags: d.tropes || [],
      kink_tags: [], gender_pairing: [], orientation_tags: [],
      content_warnings: [],
      source: d.source || "Google Books",
      source_url: d.sourceUrl || null,
      thumbnail: d.thumbnail || null,
      aiInsight: d.aiInsight || null,
      _discovered: true,
      _isPartial: true
    };
  }
  // Normalize an entry from the curated catalog (data/catalog.js).
  // Catalog entries already arrive in the rich-seed shape, but we
  // defensively fill in array defaults and stamp `_catalog` so the
  // UI can render a "Curated" badge and treat the row as read-only.
  function catalogAsBook(c) {
    return Object.assign({
      tone: [], pacing: [], literary_style: [],
      relationship_dynamic: [], trope_tags: [], kink_tags: [],
      gender_pairing: [], orientation_tags: [],
      content_warnings: []
    }, c, {
      source: c.source || "Curated",
      _catalog: true
    });
  }

  // Curated catalog — loaded via data/catalog.js at boot. Empty
  // array when the catalog hasn't been generated yet.
  function getCatalog() {
    const raw = (window.LumenData && Array.isArray(window.LumenData.CATALOG))
      ? window.LumenData.CATALOG : [];
    return raw.map(catalogAsBook);
  }

  function findBook(bookId) {
    const d = (store.get().discovered || []).find(x => x.id === bookId);
    if (d) return discoveredAsBook(d);
    const c = getCatalog().find(x => x.id === bookId);
    return c || null;
  }

  // Combined pool: curated catalog first, then user-discovered
  // entries. De-duplicated by id so a discovery-search re-add of a
  // catalog title doesn't produce two rows.
  function listAllBooks() {
    const catalog = getCatalog();
    const discovered = (store.get().discovered || []).map(discoveredAsBook);
    const seen = new Set(catalog.map(b => b.id));
    const merged = catalog.slice();
    discovered.forEach(b => { if (!seen.has(b.id)) { merged.push(b); seen.add(b.id); } });
    return merged.filter(b => b.thumbnail);
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
    // Queue each fresh seed book for silent embedding. The queue
    // paces requests at 250ms to stay under Voyage rate limits.
    fresh.forEach(b => {
      const saved = (store.get().discovered || []).find(d => d.id === b.id);
      if (saved) queueEmbedding(saved);
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

  // Restore a previously rejected Daily Pick. The reject-from-card
  // path is gone with the new Today view, but the Admin list still
  // shows legacy rejections and offers per-row restore.
  function restoreDailyPick(bookId) {
    if (!bookId) return;
    store.update(st => {
      st.dailyPicksRejected = st.dailyPicksRejected || {};
      delete st.dailyPicksRejected[bookId];
    });
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
    const card = util.el("div", { class: "book-card has-dismiss has-cover has-pin",
      onclick: () => openBookDetail(book.id)
    });
    card.appendChild(pinShareBtn(book.id));
    // Favourite toggle — star in the top-left. Filled when favourited.
    // Click toggles; rerender redraws the filter chip count if we're
    // looking at the Favorites filter.
    const favBtn = util.el("button", {
      class: "card-favorite",
      "aria-pressed": isFavorite(book.id) ? "true" : "false",
      "aria-label": (isFavorite(book.id) ? "Unfavorite " : "Favorite ") + book.title,
      title: isFavorite(book.id) ? "Remove from favorites" : "Mark as favorite",
      onclick: (e) => {
        e.stopPropagation();
        toggleFavorite(book.id);
        renderView();
      }
    }, isFavorite(book.id) ? "★" : "☆");
    card.appendChild(favBtn);
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

    // Cover frame — image if the entry carries a Google Books thumbnail,
    // a two-letter initials block otherwise. Steam Engine bar is
    // anchored along the bottom of the cover.
    const cover = util.el("div", { class: "lib-card-cover" });
    const showInitialsFallback = () => {
      if (!cover.querySelector(".cover-fallback")) {
        cover.appendChild(util.el("div", { class: "cover-fallback", text: (book.title || "??").slice(0, 2).toUpperCase() }));
      }
    };
    if (book.thumbnail) {
      const url = book.thumbnail.replace(/^http:/, "https:");
      const img = util.el("img", {
        src: url, alt: `Cover of ${book.title}`, loading: "lazy",
        onerror: function () { this.remove(); showInitialsFallback(); },
        // Google Books' "image not available" placeholder is a 200 OK
        // image (~60×90), so onerror never fires. Swap to initials if
        // the loaded cover is too small to be real.
        onload: function () { if (util.isLikelyNoCover(this)) { this.remove(); showInitialsFallback(); } }
      });
      cover.appendChild(img);
    } else {
      showInitialsFallback();
    }
    cover.appendChild(util.el("div", { class: "steam-indicator " + steamClass(book.heat_level) }));
    card.appendChild(cover);

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
    if (book._catalog)    badges.appendChild(ui.tag("curated", "accent"));
    if (book._discovered) badges.appendChild(ui.tag("from discovery", "accent"));
    if ((book.content_warnings || []).length) badges.appendChild(ui.tag(`${book.content_warnings.length} warning${book.content_warnings.length > 1 ? "s" : ""}`, "warn"));
    if (scored && scored.confidence < 60) badges.appendChild(ui.tag(`low confidence`, "danger"));
    card.appendChild(badges);
    return card;
  }

  function openBookDetail(bookId) {
    const book = findBook(bookId);
    if (!book) return;
    // Signal focus to Bianca so the panel's head reads "Reading <title>
    // with you" while the sheet is open. libState.focusBookId is
    // consumed by buildBiancaContext; the direct setContext push is a
    // fast path so Bianca updates immediately without waiting for the
    // store-subscription round trip.
    try {
      if (typeof libState !== "undefined" && libState) libState.focusBookId = bookId;
      if (window.LumenBianca && window.LumenBianca.setContext) {
        const r = router.current();
        window.LumenBianca.setContext(computeBiancaContext(r.id));
      }
    } catch (e) { /* ignore */ }
    const s = store.get();
    const pool = listAllBooks();
    const scored = pool.some(b => b.id === bookId)
      ? Engine.compareBooks([bookId], s.profile, s.weights, pool)[0]
      : null;
    const userTags = s.tags[bookId] || [];

    // Header aside — fit + confidence rings stacked, premium feel.
    let headerAside = null;
    if (scored) {
      const aside = util.el("div", { class: "detail-rings" });
      const fitFill = Math.max(0, Math.min(1, scored.fitScore / 100));
      const confFill = Math.max(0, Math.min(1, scored.confidence / 100));
      const fitCell = util.el("div", { class: "detail-ring-cell" });
      fitCell.appendChild(util.el("div", { class: "detail-ring" }, [kpiRing(fitFill, String(scored.fitScore), kpiToneFromFraction(fitFill))]));
      fitCell.appendChild(util.el("div", { class: "detail-ring-label", text: "Fit" }));
      fitCell.appendChild(util.el("div", { class: "detail-ring-sub", text: kpiDescriptorFit(scored.fitScore) }));
      aside.appendChild(fitCell);
      const confCell = util.el("div", { class: "detail-ring-cell" });
      confCell.appendChild(util.el("div", { class: "detail-ring" }, [kpiRing(confFill, `${scored.confidence}%`, kpiToneFromFraction(confFill))]));
      confCell.appendChild(util.el("div", { class: "detail-ring-label", text: "Confidence" }));
      confCell.appendChild(util.el("div", { class: "detail-ring-sub", text: Engine.confLabel(scored.confidence) }));
      aside.appendChild(confCell);
      headerAside = aside;
    }

    const sections = [];

    // Meta pill strip — heat/explicit/emotion/consent/taboo/plot.
    // Shown once at the top of the body so the numeric profile-fit
    // signal sits with the narrative instead of being dumped at the
    // bottom like before.
    const pills = util.el("div", { class: "detail-pills" });
    [
      ["Heat", book.heat_level],
      ["Explicit", book.explicitness],
      ["Emotion", book.emotional_intensity],
      ["Consent", book.consent_clarity],
      ["Taboo", book.taboo_level],
      ["Plot", book.plot_weight]
    ].forEach(([l, v]) => {
      pills.appendChild(util.el("span", { class: "detail-pill" }, [
        util.el("span", { class: "detail-pill-k", text: l }),
        util.el("span", { class: "detail-pill-v", text: `${v}/5` })
      ]));
    });
    sections.push({ content: pills });

    // Summary — unconstrained width, generous line-height.
    sections.push({
      label: "Summary",
      content: util.el("p", {
        class: "detail-sheet-prose detail-sheet-prose-hero",
        style: { whiteSpace: "pre-wrap" },
        text: book.description || "No description available for this title."
      })
    });

    // Why this fits — strong reasons on the left, partials/penalties
    // on the right at ≥720px. Removes the narrow-bubble treatment.
    if (scored && (scored.why.reasons.length || (scored.why.partials || []).length || (scored.why.penalties || []).length)) {
      const grid = util.el("div", { class: "detail-reasons-grid" });
      const strongCol = util.el("div", { class: "detail-reasons-col" });
      strongCol.appendChild(util.el("div", { class: "detail-reasons-col-title", text: "Strong matches" }));
      const strongUl = util.el("ul", { class: "detail-reasons-list tone-strong" });
      if (scored.why.reasons.length) {
        scored.why.reasons.forEach(r => strongUl.appendChild(util.el("li", { text: r })));
      } else {
        strongUl.appendChild(util.el("li", { class: "is-empty", text: "No dimension scored as a strong match." }));
      }
      strongCol.appendChild(strongUl);
      grid.appendChild(strongCol);

      const otherCol = util.el("div", { class: "detail-reasons-col" });
      otherCol.appendChild(util.el("div", { class: "detail-reasons-col-title", text: "Partial · caveats" }));
      const otherUl = util.el("ul", { class: "detail-reasons-list tone-partial" });
      const partials = scored.why.partials || [];
      const penalties = scored.why.penalties || [];
      if (partials.length || penalties.length) {
        partials.forEach(r => otherUl.appendChild(util.el("li", { class: "tone-partial", text: r })));
        penalties.forEach(r => otherUl.appendChild(util.el("li", { class: "tone-penalty", text: r })));
      } else {
        otherUl.appendChild(util.el("li", { class: "is-empty", text: "No caveats." }));
      }
      otherCol.appendChild(otherUl);
      grid.appendChild(otherCol);

      sections.push({ label: "Why this fits", content: grid });
    }

    // Your notes — single section combining reading-state, custom
    // tags, and warnings. Drops three redundant field-label banners.
    const notes = util.el("div", { class: "detail-notes-grid" });

    const noteState = util.el("div", { class: "detail-note" });
    noteState.appendChild(util.el("div", { class: "detail-note-label", text: "Reading state" }));
    noteState.appendChild(readingStateSelect(bookId));
    notes.appendChild(noteState);

    const noteTags = util.el("div", { class: "detail-note" });
    noteTags.appendChild(util.el("div", { class: "detail-note-label", text: "Your tags" }));
    const tagRow = util.el("div", { class: "row-wrap detail-note-tags" });
    userTags.forEach(t => {
      tagRow.appendChild(util.el("span", { class: "tag tag-outline" }, [
        t.replace(/-/g, " "),
        util.el("button", { class: "t-tiny", style: { marginLeft: "6px", color: "var(--text-subtle)" }, onclick: () => { removeCustomTag(bookId, t); openBookDetail(bookId); } }, "×")
      ]));
    });
    const input = util.el("input", { class: "input detail-note-input", placeholder: "Add a tag and press Enter", onkeydown: (e) => {
      if (e.key === "Enter" && input.value.trim()) { addCustomTag(bookId, input.value); input.value = ""; openBookDetail(bookId); }
    } });
    tagRow.appendChild(input);
    noteTags.appendChild(tagRow);
    notes.appendChild(noteTags);

    if ((book.content_warnings || []).length) {
      const noteWarn = util.el("div", { class: "detail-note" });
      noteWarn.appendChild(util.el("div", { class: "detail-note-label", text: "Content warnings" }));
      const warns = util.el("div", { class: "row-wrap" });
      book.content_warnings.forEach(w => warns.appendChild(ui.tag(w, "warn")));
      noteWarn.appendChild(warns);
      notes.appendChild(noteWarn);
    }

    sections.push({ label: "Your notes", content: notes });

    // Actions — consolidated into the sticky footer of the detail sheet.
    const Bianca = window.LumenBianca;
    const biancaPinned = !!(Bianca && Bianca.isPinned && Bianca.isPinned(bookId));
    const actions = [
      {
        label: "Pin to Vault",
        onClick: () => { pinBook(bookId); openBookDetail(bookId); },
        variant: "btn-ghost",
        closeOnClick: false
      },
      {
        label: biancaPinned ? "Unpin from Bianca" : "Share with Bianca",
        onClick: () => {
          if (!Bianca) return;
          if (Bianca.isPinned(bookId)) Bianca.unpinBook(bookId); else Bianca.pinBook(bookId);
          openBookDetail(bookId);
        },
        variant: biancaPinned ? "btn-primary" : "btn-ghost",
        closeOnClick: false
      },
      book.source_url ? { label: "View source", href: book.source_url } : null,
      {
        label: "Compare with…",
        variant: "btn-primary",
        onClick: () => {
          sessionStorage.setItem("lumen:compare-seed", bookId);
          router.go("compare");
        }
      }
    ].filter(Boolean);

    ui.detailSheet({
      eyebrow: util.humanise(book.category || "").toUpperCase(),
      title: book.title,
      subtitle: `${book.author || ""}${book.year ? " · " + util.fmtYear(book.year) : ""}${book.source ? " · " + book.source : ""}`,
      cover: buildCoverBlock(book, { size: "lg", showHeat: true }),
      headerAside,
      sections,
      actions
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
      oninput: (e) => {
        libState.query = e.target.value.toLowerCase();
        if (libState.searchMode === "semantic") triggerSemanticEmbed();
        else updateGrid();
      }
    });
    filterRow.appendChild(searchInput);

    // Search-mode segmented control — Exact (default) vs Semantic.
    // Semantic is disabled when there's no Voyage key; tooltip
    // points the user at Settings. Session-only: resets on reload.
    const hasVoyageKey = !!(window.LumenEmbeddings && window.LumenEmbeddings.getApiKey && window.LumenEmbeddings.getApiKey());
    const modeSeg = util.el("div", { class: "segmented", "aria-label": "Search mode" });
    const modeOptions = [
      { id: "exact",    label: "Exact" },
      { id: "semantic", label: "Semantic" }
    ];
    modeOptions.forEach(opt => {
      const b = util.el("button", Object.assign({
        type: "button",
        "aria-pressed": libState.searchMode === opt.id ? "true" : "false",
        "data-v": opt.id,
        onclick: () => {
          if (opt.id === "semantic" && !hasVoyageKey) return;
          libState.searchMode = opt.id;
          setModeButton(opt.id);
          if (opt.id === "semantic" && libState.query) triggerSemanticEmbed();
          else updateGrid();
        }
      }, (opt.id === "semantic" && !hasVoyageKey) ? {
        disabled: true,
        title: "Add a Voyage API key in Settings → Voyage API key to enable semantic search"
      } : {}), opt.label);
      modeSeg.appendChild(b);
    });
    filterRow.appendChild(modeSeg);
    function setModeButton(id) {
      modeSeg.querySelectorAll("button").forEach(x =>
        x.setAttribute("aria-pressed", x.dataset.v === id ? "true" : "false"));
    }

    // "Favorites" appears right after the last reading state ("already
    // read") so the filter reads All → want → reading → read → Favorites.
    // It's a distinct filter (books flagged via the star on each card),
    // not a reading state.
    const rfOptions = [
      { id: "all", label: "All" },
      ...READING_STATES.filter(r => r.id !== "none"),
      { id: "favorites", label: "Favorites" }
    ];
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

    function normalSort(list) {
      list.sort((a, b) => {
        if (libState.sort === "fit") {
          const sa = scoredMap[a.id]?.fitScore ?? -1;
          const sb = scoredMap[b.id]?.fitScore ?? -1;
          return sb - sa;
        }
        if (libState.sort === "title") return a.title.localeCompare(b.title);
        if (libState.sort === "year")  return (a.year || 0) - (b.year || 0);
        return 0;
      });
      return list;
    }

    function updateGrid() {
      const q = libState.query;
      // Base pool always applies category + readingFilter. Text match
      // and ordering are branched below by searchMode.
      const basePool = allBooks.filter(b => {
        if (libState.category !== "all" && b.category !== libState.category) return false;
        if (libState.readingFilter === "favorites") {
          if (!isFavorite(b.id)) return false;
        } else if (libState.readingFilter !== "all" && getReadingState(b.id) !== libState.readingFilter) {
          return false;
        }
        return true;
      });

      const isSemantic = libState.searchMode === "semantic" && !!q;
      const usableSemantic = isSemantic
        && semanticState.lastQueryText === q
        && Array.isArray(semanticState.lastQueryVec);

      let filtered;
      const indexingIds = new Set();
      // Per-book similarity for the semantic top-30, used to paint
      // the "X% match" badge + hover tooltip (Batch 5).
      const simById = new Map();

      if (isSemantic && usableSemantic) {
        // Rank by cosine similarity. Top 30 of books that have an
        // embedding; books without one go to the bottom in normal
        // sort order with an "indexing…" badge.
        const sim = window.LumenEmbeddings.similarity;
        const qVec = semanticState.lastQueryVec;
        const withE = [];
        const withoutE = [];
        basePool.forEach(b => {
          if (Array.isArray(b._embedding)) withE.push({ b, s: sim(qVec, b._embedding) });
          else withoutE.push(b);
        });
        withE.sort((a, b) => b.s - a.s);
        const top = withE.slice(0, 30);
        top.forEach(x => simById.set(x.b.id, x.s));
        normalSort(withoutE).forEach(b => indexingIds.add(b.id));
        filtered = top.map(x => x.b).concat(withoutE);
      } else if (isSemantic) {
        // Semantic mode, query present, but vector not ready (still
        // debouncing / embedding). Show the base pool in normal
        // sort; mark books missing an embedding as indexing.
        filtered = normalSort(basePool.slice());
        filtered.forEach(b => { if (!Array.isArray(b._embedding)) indexingIds.add(b.id); });
      } else {
        // Exact mode — original behavior (title/author substring).
        filtered = basePool.filter(b =>
          !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
        normalSort(filtered);
      }

      const excluded = allBooks.length - Engine.applyHardExclusions(allBooks, Engine.normalizeProfile(s.profile)).length;
      const hiddenCount = Object.keys(hidden).length;
      stats.innerHTML = "";
      stats.appendChild(util.el("span", {}, `Showing ${filtered.length} of ${allBooks.length}`));
      if (isSemantic && semanticState.loading) {
        stats.appendChild(util.el("span", { class: "tag" }, "semantic · embedding query…"));
      } else if (isSemantic && usableSemantic) {
        stats.appendChild(util.el("span", { class: "tag tag-accent" }, "semantic · top 30 by meaning"));
      } else if (isSemantic && semanticState.lastError) {
        const msg = semanticState.lastError === "quota"   ? "semantic · Voyage quota hit"
                 : semanticState.lastError === "network" ? "semantic · network error — check connection"
                 : semanticState.lastError === "no-key"  ? "semantic · no Voyage key — add one in Admin"
                 :                                         "semantic · embed failed — see console";
        stats.appendChild(util.el("span", { class: "tag tag-warn", title: "Semantic mode stays selected; re-edit the query to retry." }, msg));
      }
      if (excluded > 0)   stats.appendChild(util.el("span", { class: "tag tag-warn" }, `${excluded} excluded by your filters`));
      if (hiddenCount)    stats.appendChild(util.el("a", { class: "tag tag-accent", href: "#/settings", style: { textDecoration: "none" } }, `${hiddenCount} dismissed — restore in Settings`));

      grid.innerHTML = "";
      if (!filtered.length) {
        if (allBooks.length === 0) {
          grid.appendChild(ui.empty({
            title: "Your library is empty",
            message: "Lumen has nothing saved yet. Search the web from Discovery to add titles, or load the starter library of historical classics from Admin.",
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
      filtered.forEach(b => {
        const card = bookCardFull(b, scoredMap[b.id]);
        if (indexingIds.has(b.id)) {
          card.style.position = card.style.position || "relative";
          card.appendChild(util.el("span", {
            class: "tag",
            style: {
              position: "absolute", top: "10px", right: "10px",
              fontSize: "10px", opacity: "0.75", pointerEvents: "none"
            }
          }, "indexing…"));
        } else if (simById.has(b.id)) {
          // Batch 5: "X% match" badge + "why this matched" tooltip.
          const pct = Math.max(0, Math.round(simById.get(b.id) * 100));
          const matches = matchExplanation(libState.query, b);
          const tipText = matches && matches.length
            ? "Matched on: " + matches.join(" · ")
            : "Matched on description";
          card.style.position = card.style.position || "relative";
          card.appendChild(util.el("span", {
            class: "tag tag-accent",
            title: tipText,
            tabindex: "0",
            "aria-label": `${pct} percent match. ${tipText}`,
            style: {
              position: "absolute", top: "10px", right: "10px",
              fontSize: "10px", fontWeight: "600", cursor: "help"
            }
          }, `${pct}% match`));
        }
        grid.appendChild(card);
      });
    }

    // "Why this matched" — cheap approximation per spec: tokenize
    // the query, tokenize each of the book's tone/trope/kink/dynamic
    // tags, and return up to three tags that share a token with the
    // query. Returns null if none overlap (caller shows "matched on
    // description" instead).
    function matchExplanation(queryText, book) {
      const qTokens = new Set(
        String(queryText || "").toLowerCase()
          .split(/[^a-z0-9]+/).filter(t => t.length > 2)
      );
      if (!qTokens.size || !book) return null;
      const tags = []
        .concat(book.tone || [])
        .concat(book.tropes || book.trope_tags || book.trope || [])
        .concat(book.dynamic || book.relationship_dynamic || [])
        .concat(book.kink || book.kink_tags || []);
      const out = [];
      const seen = new Set();
      for (const raw of tags) {
        if (!raw || typeof raw !== "string") continue;
        const norm = raw.toLowerCase();
        if (seen.has(norm)) continue;
        const tagTokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
        if (tagTokens.some(t => qTokens.has(t))) {
          out.push(raw.replace(/-/g, " "));
          seen.add(norm);
          if (out.length >= 3) break;
        }
      }
      return out.length ? out : null;
    }

    // Debounced semantic search. Kicks a 300ms timer; when it fires
    // we embed the current query, bump a seq counter so stale
    // responses are dropped, and re-render. A failure flips the
    // mode back to Exact silently and surfaces a non-blocking toast.
    function triggerSemanticEmbed() {
      if (!window.LumenEmbeddings || !window.LumenEmbeddings.getApiKey()) {
        // Key actually gone (user cleared it mid-session). Only in
        // this case do we revert mode — Semantic is impossible
        // without a key.
        libState.searchMode = "exact";
        setModeButton("exact");
        updateGrid();
        return;
      }
      if (semanticState.debounceTimer) clearTimeout(semanticState.debounceTimer);
      const thisSeq = ++semanticState.seq;
      semanticState.loading = true;
      semanticState.lastError = null;
      updateGrid(); // paint the loading tag while waiting
      semanticState.debounceTimer = setTimeout(async () => {
        semanticState.debounceTimer = null;
        const q = libState.query;
        if (!q) {
          semanticState.loading = false;
          semanticState.lastQueryText = "";
          semanticState.lastQueryVec = null;
          if (thisSeq === semanticState.seq) updateGrid();
          return;
        }
        try {
          const vec = await window.LumenEmbeddings.embedText(q);
          if (thisSeq !== semanticState.seq) return; // stale
          semanticState.lastQueryText = q;
          semanticState.lastQueryVec = vec;
          semanticState.loading = false;
          semanticState.lastError = null;
          updateGrid();
        } catch (err) {
          if (thisSeq !== semanticState.seq) return;
          semanticState.loading = false;
          semanticState.lastError = err && err.code ? err.code : "unknown";
          // Log full error to console for debugging but keep
          // Semantic selected so the button "sticks" as expected.
          try { console.warn("[Lumen] Semantic search failed:", err); } catch (_) { /* ignore */ }
          updateGrid();
        }
      }, 300);
    }

    setTimeout(updateGrid, 0);
    return wrap;
  }

  /* -------------------- discovery -------------------- */
  const discoveryState = {
    lastQuery: "",
    raw: []   // Google Books results in insertion order
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
        util.el("h1", { html: "Search the shelf. <em>Ask</em> the engine." }),
        util.el("p", { class: "lede", text: "Type a book title to find that exact book plus five similar reads." })
      ])
    ]));

    // Hero search — full-width, no sidebar
    const hero = util.el("div", { class: "disco-hero" });
    const searchInput = util.el("input", {
      class: "disco-hero-input",
      placeholder: "Search titles, authors, or themes…",
      value: discoveryState.lastQuery,
      onkeydown: (e) => { if (e.key === "Enter") runSearch(); }
    });
    const searchBtn = util.el("button", { class: "btn btn-primary btn-lg", onclick: () => runSearch() }, "Search");

    hero.appendChild(util.el("div", { class: "disco-hero-row" }, [
      searchInput,
      searchBtn
    ]));

    const hint = util.el("div", { class: "disco-hero-hint" });
    hint.appendChild(util.el("span", { text: "Your book + 5 similar reads from Google Books." }));
    hero.appendChild(hint);
    wrap.appendChild(hero);

    // Results grid — full width
    const resultsHead = util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } });
    const resultsLabel = util.el("div", { class: "t-small t-subtle", id: "disco-count", text: "No search yet" });
    resultsHead.appendChild(resultsLabel);
    if (discoveryState.raw.length) {
      resultsHead.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
        discoveryState.raw = [];
        discoveryState.lastQuery = "";
        renderView();
      }}, "Clear results"));
    }
    wrap.appendChild(resultsHead);

    const grid = util.el("div", { class: "discovery-grid", id: "disco-grid" });
    wrap.appendChild(grid);

    // Initial paint from cached results (if any)
    if (discoveryState.raw.length) paintGrid();
    else {
      const catalogSuggestions = (window.LumenData && window.LumenData.CATALOG || []).slice(0, 3);
      const emptyChildren = [
        util.el("h3", { class: "t-serif", style: { fontSize: "18px", color: "var(--accent)" }, text: "What are you in the mood for?" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: "Search a book title to find it and five similar reads." })
      ];
      if (catalogSuggestions.length) {
        const chips = util.el("div", { class: "row", style: { flexWrap: "wrap", gap: "var(--s-2)", marginTop: "var(--s-3)" } });
        catalogSuggestions.forEach(b => {
          chips.appendChild(util.el("button", {
            class: "chip",
            type: "button",
            onclick: () => { searchInput.value = b.title; runSearch(); }
          }, b.title));
        });
        emptyChildren.push(chips);
      }
      grid.appendChild(util.el("div", { class: "discovery-empty" }, emptyChildren));
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
      if (!q) { ui.toast("Enter a book title to search"); return; }

      discoveryState.lastQuery = q;
      discoveryState.raw = [];
      grid.innerHTML = "";
      resultsLabel.textContent = `Searching for "${q}"…`;

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
          util.el("h3", { class: "t-serif", style: { fontSize: "18px", color: "var(--accent)" }, text: "Nothing matched that query" }),
          util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" }, text: "Try a different title, author, or topic." })
        ]));
        return;
      }

      discoveryState.raw = items;
      paintGrid();
    }

    function renderDiscoCard(book) {
      const card = util.el("div", {
        class: "disco-card has-dismiss is-clickable",
        "data-disco-id": book.id,
        role: "button",
        tabindex: "0",
        "aria-label": `Open full detail for ${book.title}`,
        onclick: (e) => {
          // Ignore clicks on interactive children (buttons, links).
          if (e.target.closest("button, a")) return;
          openDiscoveryDetail(book);
        },
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            if (e.target.closest("button, a")) return;
            e.preventDefault();
            openDiscoveryDetail(book);
          }
        }
      });

      // Pin / share with Bianca — sits next to the dismiss control.
      card.appendChild(pinShareBtn(book.id));

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
      const showInitialsFallback = () => {
        if (!cover.querySelector(".cover-fallback")) {
          cover.appendChild(util.el("div", { class: "cover-fallback", text: (book.title || "??").slice(0, 2).toUpperCase() }));
        }
      };
      if (book.thumbnail) {
        const url = book.thumbnail.replace(/^http:/, "https:");
        const img = util.el("img", {
          src: url, alt: `Cover of ${book.title}`, loading: "lazy",
          onerror: function () { this.remove(); showInitialsFallback(); },
          onload:  function () { if (util.isLikelyNoCover(this)) { this.remove(); showInitialsFallback(); } }
        });
        cover.appendChild(img);
      } else {
        showInitialsFallback();
      }
      card.appendChild(cover);

      // Body — compact row layout. Title, author, 2-line blurb, then
      // a thin metadata row (heat dot + up to 3 tropes). The full AI
      // insight lives in the detail sheet opened on click, so the
      // card itself stays short and dense.
      const body = util.el("div", { class: "disco-card-body" });

      const head = util.el("div", { class: "disco-card-head" });
      head.appendChild(util.el("h4", { class: "disco-card-title", text: book.title }));

      body.appendChild(head);

      body.appendChild(util.el("div", { class: "disco-card-author",
        text: book.author + (book.year ? ` · ${book.year}` : "") }));
      body.appendChild(util.el("p", { class: "disco-card-blurb", text: book.description }));


      // Icon-only action row — primary is "Add to your library", source
      // link tucked behind a second icon. Labels exposed via tooltips
      // so the card stays visually quiet at rest.
      const actions = util.el("div", { class: "disco-card-actions" });
      actions.appendChild(util.el("button", {
        class: "disco-card-iconbtn disco-card-iconbtn-primary",
        title: "Add to your library", "aria-label": "Add to your library",
        onclick: (e) => { e.stopPropagation(); addDiscoveryToLibrary(book); }
      }, "+"));
      if (book.sourceUrl) {
        actions.appendChild(util.el("a", {
          class: "disco-card-iconbtn",
          title: "View source", "aria-label": "View source",
          href: book.sourceUrl, target: "_blank", rel: "noopener noreferrer",
          onclick: (e) => e.stopPropagation()
        }, "↗"));
      }
      body.appendChild(actions);
      card.appendChild(body);

      return card;
    }

    return wrap;
  }

  function openDiscoveryDetail(book) {
    const inLibrary = (store.get().discovered || []).some(d => d.id === book.id);
    const cover = buildCoverBlock(book, { size: "lg", showHeat: false });

    const sections = [
      {
        label: "Description",
        content: util.el("p", {
          class: "detail-sheet-prose detail-sheet-prose-hero",
          style: { whiteSpace: "pre-wrap" },
          text: book.description || "No description available for this title."
        })
      }
    ];

    const actions = [
      book.sourceUrl ? { label: "View source", href: book.sourceUrl } : null,
      inLibrary
        ? { label: "Open in Library", variant: "btn-primary", onClick: () => router.go("library") }
        : { label: "Add to your library", variant: "btn-primary", onClick: () => addDiscoveryToLibrary(book) }
    ].filter(Boolean);

    ui.detailSheet({
      eyebrow: (book.source || "Google Books").toUpperCase() + (book.year ? " · " + book.year : ""),
      title: book.title,
      subtitle: book.author || "Unknown author",
      cover,
      sections,
      actions
    });
  }

  /* ==================================================================
     Embedding storage (Batch 3)
     When a book enters the library via any of the three add-paths
     (addDiscoveryToLibrary, loadStarterLibrary, applyCatalogOverride)
     we fire a Voyage call in the background and write the vector
     onto the book. The UI is never blocked and success is silent.

     Book vectors live where the book itself lives:
       · Discovered / seed books → state.discovered[i]._embedding
       · Catalog books           → the override at lumen:catalog-override
     The backfill pass on boot catches anything left behind, capped
     at 20 per session to stay kind to the user's Voyage quota.
     ================================================================== */
  const embedQueue = [];
  let embedTimer = null;
  // Skip a book for this long after a failure before retrying on
  // a subsequent backfill. Long enough to survive a transient quota
  // bump, short enough to self-heal within a day.
  const EMBED_RETRY_MS = 6 * 60 * 60 * 1000;

  function composeEmbedText(b) {
    if (!b) return "";
    const title = b.title || "";
    const desc  = b.description || b.short_summary || b.fit_notes || "";
    const tags  = []
      .concat(b.tropes || [])
      .concat(b.trope_tags || b.trope || [])
      .concat(b.tone || [])
      .concat(b.relationship_dynamic || b.dynamic || [])
      .concat(b.kink_tags || b.kink || [])
      .concat(b.pacing || [])
      .concat(b.literary_style || []);
    return (title + "\n\n" + desc + "\n\n" + tags.join(" ")).trim();
  }

  // Find and mutate a single book wherever it lives. Returns true if
  // it was touched, so the caller can persist the catalog override if
  // the book wasn't in the main store.
  function mutateBookEmbedding(bookId, mutator) {
    let touched = false;
    store.update(st => {
      if (st.discovered) {
        const d = st.discovered.find(x => x.id === bookId);
        if (d) { mutator(d); touched = true; }
      }
    });
    if (touched) return;
    try {
      const raw = localStorage.getItem("lumen:catalog-override");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.books)) return;
      const b = parsed.books.find(x => x.id === bookId);
      if (!b) return;
      mutator(b);
      localStorage.setItem("lumen:catalog-override", JSON.stringify(parsed));
    } catch (e) { /* storage issues are non-fatal here */ }
  }

  function scheduleEmbedQueue() {
    if (embedTimer || !embedQueue.length) return;
    embedTimer = setTimeout(processEmbedQueue, 250);
  }

  async function processEmbedQueue() {
    embedTimer = null;
    const job = embedQueue.shift();
    if (!job) return;
    // Silent skip if the key disappeared mid-queue.
    if (!window.LumenEmbeddings || !window.LumenEmbeddings.getApiKey()) {
      embedQueue.length = 0;
      return;
    }
    const { id, text } = job;
    try {
      const vec = await window.LumenEmbeddings.embedText(text);
      mutateBookEmbedding(id, b => {
        b._embedding = vec;
        b._embeddedAt = Date.now();
        delete b._embeddingError;
      });
    } catch (err) {
      const code = (err && err.code) || "unknown";
      mutateBookEmbedding(id, b => { b._embeddingError = { code, at: Date.now() }; });
      // Stop the queue on "no-key" — retrying would just fail again.
      if (code === "no-key") { embedQueue.length = 0; return; }
    }
    if (embedQueue.length) scheduleEmbedQueue();
  }

  function queueEmbedding(book) {
    if (!window.LumenEmbeddings || !window.LumenEmbeddings.getApiKey()) return;
    if (!book || !book.id) return;
    // Skip if we already have an embedding and it's still fresh.
    if (book._embedding) return;
    // De-dupe — if the same id is already in the queue, skip it.
    if (embedQueue.some(j => j.id === book.id)) return;
    embedQueue.push({ id: book.id, text: composeEmbedText(book) });
    scheduleEmbedQueue();
  }

  // Boot-time backfill: queue up to 20 books per session that are
  // missing _embedding (and aren't in a recent-error cooldown).
  // Silent if no Voyage key is set.
  function backfillEmbeddings() {
    if (!window.LumenEmbeddings || !window.LumenEmbeddings.getApiKey()) return;
    let queued = 0;
    const CAP = 20;
    const now = Date.now();
    for (const b of listAllBooks()) {
      if (queued >= CAP) break;
      if (!b || !b.id) continue;
      if (b._embedding) continue;
      if (b._embeddingError && (now - (b._embeddingError.at || 0)) < EMBED_RETRY_MS) continue;
      queueEmbedding(b);
      queued += 1;
    }
  }

  function addDiscoveryToLibrary(book) {
    const s = store.get();
    const existing = (s.discovered || []).find(d => d.id === book.id);
    if (existing) {
      // If the saved entry was previously dismissed, the book is still in
      // state.discovered but hidden[id] is true — so Library silently drops
      // it. Clear the hidden flag so re-adding actually surfaces it.
      const wasHidden = !!(s.hidden && s.hidden[book.id]);
      if (wasHidden) {
        store.update(st => { delete st.hidden[book.id]; st.bookStates[book.id] = st.bookStates[book.id] || "want"; });
        renderView();
        ui.toast(`Restored ${book.title} to your library`, {
          action: "Open library",
          onAction: () => router.go("library"),
          duration: 4200
        });
        return;
      }
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
        addedAt: Date.now()
      });
      st.bookStates[book.id] = "want";
      // A previous dismiss of the same id (via Library's × or starter-library
      // unload) leaves hidden[id]=true, which would make the freshly-saved
      // book invisible in Library. Clear it so the save is actually visible.
      if (st.hidden) delete st.hidden[book.id];
    });
    // Force a re-render so if the user is already on Discovery the card's
    // button flips to "Open in Library", and if they navigate to Library
    // via the toast action the grid shows the new entry immediately.
    renderView();
    // Silent background embedding (Batch 3). No toast on success; on
    // failure the error tag stays on the book for the backfill to see.
    const savedRecord = (store.get().discovered || []).find(d => d.id === book.id);
    queueEmbedding(savedRecord || book);
    ui.toast(`Added ${book.title} to your library as "want to read"`, {
      action: "Open library",
      onAction: () => router.go("library"),
      duration: 4200
    });
  }

  /* -------------------- transparency -------------------- */
  /* -------------------- settings -------------------- */
  /* ==================================================================
     Curated catalog importer — Settings card.

     Three input modes:
       1. "Titles list"  — one `Title — Author` per line. Claude fills
          every field.
       2. "CSV sparse"   — columns: title, author [, description].
          Claude fills the rest.
       3. "CSV full"     — full 26-column schema from data/CATALOG.md.
          Used as-is with normalization.

     Preview shows accepted / rejected rows and lets the user tweak
     the 6 numeric fields inline before committing. Commit options:
       • Apply to this device  — localStorage override picked up on
         next boot by data/catalog.js.
       • Download catalog.js   — a drop-in replacement for the repo
         file so the curated catalog lives in version control.
     ================================================================== */
  const catalogImport = {
    mode: "titles",          // "titles" | "csv"
    raw: "",                  // paste buffer
    parsed: [],               // [{ input, status, book?, _source?, error? }]
    enriching: false,
    done: false
  };

  // Tiny CSV / TSV parser with quoted-field support. Auto-detects
  // delimiter as the most common of `,`, `\t`, or `;` in the header
  // line. Returns [headerRow, ...dataRows] with each row as an array
  // of trimmed strings.
  function parseDelimited(text) {
    const clean = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!clean) return [];
    // Determine delimiter from the first line.
    const firstLine = clean.split("\n", 1)[0];
    const counts = { ",": (firstLine.match(/,/g) || []).length,
                     "\t": (firstLine.match(/\t/g) || []).length,
                     ";": (firstLine.match(/;/g) || []).length };
    const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inQ) {
        if (ch === '"') {
          if (clean[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === delim) { row.push(field); field = ""; }
        else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else field += ch;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.map(r => r.map(x => String(x || "").trim()));
  }

  // Stable id generator for auto-filled rows.
  function slugifyId(title, author) {
    const s = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    // Short hash of the author so two books with same title dedupe
    // correctly when they actually are different works.
    let h = 0; const a = String(author || "");
    for (let i = 0; i < a.length; i++) { h = ((h << 5) - h + a.charCodeAt(i)) | 0; }
    const tag = ("00" + (h >>> 0).toString(36)).slice(-4);
    return s ? `${s}-${tag}` : `book-${tag}`;
  }

  // Column-name normalization (spaces/case-insensitive matching).
  const CATALOG_COLS = [
    "id", "title", "author", "year", "category", "subgenre", "description",
    "source", "source_url", "thumbnail",
    "heat_level", "explicitness", "emotional_intensity",
    "consent_clarity", "taboo_level", "plot_weight",
    "tone", "pacing", "literary_style", "relationship_dynamic",
    "trope_tags", "kink_tags", "gender_pairing", "orientation_tags",
    "content_warnings"
  ];
  const LIST_COLS = new Set([
    "tone", "pacing", "literary_style", "relationship_dynamic",
    "trope_tags", "kink_tags", "gender_pairing", "orientation_tags",
    "content_warnings"
  ]);
  const NUM_COLS = ["heat_level", "explicitness", "emotional_intensity",
    "consent_clarity", "taboo_level", "plot_weight"];
  const NUM_COLS_SET = new Set(NUM_COLS);

  function normColumnName(s) {
    return String(s || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  }

  function splitListCell(v) {
    if (!v) return [];
    const parts = String(v).split(/[;|]+/);
    const out = []; const seen = new Set();
    for (const p of parts) {
      const t = p.trim().toLowerCase().replace(/\s+/g, "-");
      if (!t || seen.has(t)) continue;
      seen.add(t); out.push(t);
    }
    return out;
  }

  function parseFullCsvRow(obj) {
    const missing = [];
    const requiredText = ["title", "author", "description"];
    requiredText.forEach(k => { if (!obj[k]) missing.push(k); });
    const book = {
      id: obj.id || "",
      title: obj.title || "",
      author: obj.author || "",
      year: obj.year ? (parseInt(obj.year, 10) || 0) : 0,
      category: obj.category || "erotica-fiction",
      subgenre: obj.subgenre || "",
      description: obj.description || "",
      source: obj.source || "Curated",
      source_url: obj.source_url || null,
      thumbnail: obj.thumbnail || null,
      tone: splitListCell(obj.tone),
      pacing: splitListCell(obj.pacing),
      literary_style: splitListCell(obj.literary_style),
      relationship_dynamic: splitListCell(obj.relationship_dynamic),
      trope_tags: splitListCell(obj.trope_tags),
      kink_tags: splitListCell(obj.kink_tags),
      gender_pairing: splitListCell(obj.gender_pairing),
      orientation_tags: splitListCell(obj.orientation_tags),
      content_warnings: splitListCell(obj.content_warnings)
    };
    NUM_COLS.forEach(k => {
      const v = Number(obj[k]);
      if (!Number.isFinite(v)) missing.push(k);
      else book[k] = Math.max(1, Math.min(5, Math.round(v)));
    });
    if (!book.id) book.id = slugifyId(book.title, book.author);
    return { book, missing };
  }

  // Parse the raw buffer into an array of pending rows according to
  // the chosen input mode. Shape: { input, status, book?, _source?,
  // confidence?, error? }.
  function parseImportBuffer() {
    const mode = catalogImport.mode;
    const text = String(catalogImport.raw || "").trim();
    if (!text) { catalogImport.parsed = []; return; }

    if (mode === "titles") {
      const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
      catalogImport.parsed = lines.map((line, i) => {
        // Separator can be em-dash, en-dash, hyphen, or " by ".
        const m = line.match(/^(.+?)\s+(?:—|–|-|by)\s+(.+)$/i);
        if (!m) return { input: { title: line, author: "" }, status: "pending", row: i + 1 };
        return { input: { title: m[1].trim(), author: m[2].trim() }, status: "pending", row: i + 1 };
      });
      return;
    }

    // Unified CSV path — auto-detects per row.
    //   - title or author missing       → error (can't enrich without them).
    //   - every required field present  → ready  (use as-is, fields marked "human").
    //   - otherwise                     → pending (queue for Claude; any
    //                                     human-provided fields are kept and
    //                                     override the AI fill-in at merge).
    const rows = parseDelimited(text);
    if (!rows.length) { catalogImport.parsed = []; return; }
    const header = rows[0].map(normColumnName);
    const records = rows.slice(1).filter(r => r.some(c => c && c.length));
    if (header.indexOf("title") < 0 || header.indexOf("author") < 0) {
      catalogImport.parsed = [{ status: "error", error: "CSV header must include at least 'title' and 'author' columns.", row: 0, input: {} }];
      return;
    }
    catalogImport.parsed = records.map((r, i) => {
      const obj = {}; header.forEach((h, idx) => { if (h) obj[h] = r[idx] || ""; });
      const title = obj.title || "";
      const author = obj.author || "";
      if (!title || !author) {
        return { input: { title, author }, status: "error",
                 error: "missing title or author", row: i + 2 };
      }
      const { book, missing } = parseFullCsvRow(obj);
      if (!missing.length) {
        // All required fields present — goes straight to ready.
        const _source = {}; Object.keys(book).forEach(k => { _source[k] = "human"; });
        return { input: { title, author, description: obj.description || "" },
                 status: "ready", book, _source, row: i + 2 };
      }
      // Partial row — anything the user did provide is kept and marked
      // "human"; the remaining required fields will be filled by Claude
      // at enrichment time.
      const partial = {};
      const partialSource = {};
      ["id", "title", "author", "year", "category", "subgenre", "description",
       "source", "source_url", "thumbnail"].forEach(k => {
        if (obj[k] && String(obj[k]).trim()) {
          partial[k] = (k === "year") ? (parseInt(obj[k], 10) || 0) : obj[k];
          partialSource[k] = "human";
        }
      });
      ["tone","pacing","literary_style","relationship_dynamic","trope_tags",
       "kink_tags","gender_pairing","orientation_tags","content_warnings"].forEach(k => {
        const lst = splitListCell(obj[k]);
        if (lst.length) { partial[k] = lst; partialSource[k] = "human"; }
      });
      NUM_COLS.forEach(k => {
        const v = Number(obj[k]);
        if (Number.isFinite(v)) {
          partial[k] = Math.max(1, Math.min(5, Math.round(v)));
          partialSource[k] = "human";
        }
      });
      return {
        input: { title, author, description: obj.description || "" },
        status: "pending",
        partial, partialSource,
        missing,
        row: i + 2
      };
    });
  }

  async function enrichPending() {
    const Disco = window.LumenDiscovery;
    if (!Disco || !Disco.hasKey()) {
      ui.toast("Add your Claude API key in Settings → Claude API key to enable enrichment");
      return;
    }
    catalogImport.enriching = true;
    renderView();
    const pending = catalogImport.parsed.filter(p => p.status === "pending");
    for (const row of pending) {
      try {
        const { book, _source, confidence } = await Disco.enrichCatalogEntry(row.input);
        // Merge: any human-provided fields from the partial CSV row
        // win over Claude's fill-in, and their _source stays "human"
        // so future re-enrichments won't clobber them.
        const partial = row.partial || {};
        const partialSource = row.partialSource || {};
        Object.keys(partial).forEach(k => {
          book[k] = partial[k];
          _source[k] = partialSource[k] || "human";
        });
        book.id = book.id || partial.id || slugifyId(book.title, book.author);
        row.book = book;
        row._source = _source;
        row.confidence = confidence;
        row.status = "ready";
        row.missing = null;
        row.partial = null;
        row.partialSource = null;
      } catch (err) {
        row.status = "error";
        row.error = (err && err.code === "not-fiction") ? "Claude flagged this as non-fiction"
                  : (err && err.message) || "enrichment failed";
      }
      repaintImporter();
    }
    catalogImport.enriching = false;
    catalogImport.done = true;
    renderView();
  }

  function repaintImporter() {
    const host = document.getElementById("catalog-importer-rows");
    if (!host) return;
    host.innerHTML = "";
    host.appendChild(buildImporterPreview());
  }

  function buildImporterPreview() {
    const wrap = util.el("div", { class: "stack-sm" });
    const rows = catalogImport.parsed;
    if (!rows.length) {
      wrap.appendChild(util.el("p", { class: "t-small t-subtle", text: "Nothing parsed yet. Paste your input and press Parse." }));
      return wrap;
    }
    const counts = { ready: 0, pending: 0, error: 0 };
    rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const summary = util.el("div", { class: "row-wrap t-small t-subtle" }, [
      util.el("span", {}, `${rows.length} row${rows.length === 1 ? "" : "s"}`),
      counts.ready   ? util.el("span", { class: "tag tag-good" },   `${counts.ready} ready`) : null,
      counts.pending ? util.el("span", { class: "tag tag-accent" }, `${counts.pending} awaiting Claude`) : null,
      counts.error   ? util.el("span", { class: "tag tag-warn" },   `${counts.error} error`) : null
    ].filter(Boolean));
    wrap.appendChild(summary);

    rows.forEach((row, idx) => {
      const line = util.el("div", { class: "catalog-import-row status-" + row.status });
      const head = util.el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } }, [
        util.el("div", { style: { minWidth: 0 } }, [
          util.el("div", { class: "t-serif", style: { fontSize: "15px" }, text: (row.book && row.book.title) || row.input.title || "(no title)" }),
          util.el("div", { class: "t-tiny t-subtle", text: ((row.book && row.book.author) || row.input.author || "unknown") + (row.confidence != null ? ` · AI conf ${row.confidence}` : "") })
        ]),
        util.el("span", { class: "t-tiny", style: { color: row.status === "error" ? "var(--danger)" : row.status === "ready" ? "var(--accent-deep)" : "var(--text-subtle)" }, text: row.status })
      ]);
      line.appendChild(head);
      if (row.status === "error") {
        line.appendChild(util.el("div", { class: "t-tiny", style: { color: "var(--danger)", marginTop: "4px" }, text: row.error || "error" }));
      } else if (row.status === "pending") {
        const gaps = (row.missing || []).join(", ");
        line.appendChild(util.el("div", { class: "t-tiny t-subtle", style: { marginTop: "4px" },
          text: gaps ? `Claude will fill: ${gaps}` : "Awaiting Claude enrichment" }));
      } else if (row.status === "ready" && row.book) {
        const nums = util.el("div", { class: "catalog-import-nums" });
        NUM_COLS.forEach(k => {
          const cell = util.el("label", { class: "catalog-import-num" }, [
            util.el("span", { class: "t-eyebrow", style: { fontSize: "9px" }, text: k.replace(/_/g, " ") }),
            util.el("input", {
              type: "number", min: "1", max: "5", step: "1",
              value: String(row.book[k]),
              oninput: (e) => {
                const v = Math.max(1, Math.min(5, Math.round(Number(e.target.value) || row.book[k])));
                row.book[k] = v;
                if (row._source) row._source[k] = "human";
                e.target.value = String(v);
              }
            })
          ]);
          nums.appendChild(cell);
        });
        line.appendChild(nums);
        const tagLine = util.el("div", { class: "t-tiny t-subtle catalog-import-tags" }, [
          (row.book.tone || []).length ? `tone: ${row.book.tone.join(", ")}` : null,
          (row.book.trope_tags || []).length ? `tropes: ${row.book.trope_tags.join(", ")}` : null,
          (row.book.content_warnings || []).length ? `warnings: ${row.book.content_warnings.join(", ")}` : null
        ].filter(Boolean).map(t => util.el("div", { text: t })));
        line.appendChild(tagLine);
      }
      wrap.appendChild(line);
    });
    return wrap;
  }

  function readyBooks() {
    return catalogImport.parsed
      .filter(r => r.status === "ready" && r.book)
      .map(r => {
        if (!r.book.id) r.book.id = slugifyId(r.book.title, r.book.author);
        return Object.assign({}, r.book, { _source: r._source || null });
      });
  }

  // Walk the currently-loaded catalog, look up any books that are
  // missing a thumbnail on Google Books, and persist the result back
  // to localStorage so the Library shows covers on next render.
  async function refreshCatalogCovers() {
    const Disco = window.LumenDiscovery;
    if (!Disco || typeof Disco.lookupBookMetadata !== "function") {
      ui.toast("Discovery module unavailable");
      return;
    }
    const catalog = (window.LumenData && window.LumenData.CATALOG) || [];
    if (!catalog.length) { ui.toast("No catalog loaded to refresh"); return; }
    const missing = catalog.filter(b => !b.thumbnail);
    if (!missing.length) { ui.toast("Every book already has a cover"); return; }

    ui.toast(`Fetching ${missing.length} cover${missing.length === 1 ? "" : "s"} from Google Books…`, { duration: 2200 });
    let hits = 0, fails = 0;
    for (const b of missing) {
      try {
        const gb = await Disco.lookupBookMetadata({ title: b.title, author: b.author });
        if (gb && gb.thumbnail) {
          b.thumbnail = gb.thumbnail;
          if (gb.year && (!b.year || b.year === 0)) b.year = gb.year;
          b._source = b._source || {};
          b._source.thumbnail = "google-books";
          if (gb.year && (!b._source.year || b._source.year === "ai")) b._source.year = "google-books";
          hits += 1;
        } else {
          fails += 1;
        }
      } catch (e) { fails += 1; }
    }

    // Persist to localStorage for this device session.
    try {
      const payload = { version: (window.LumenData && window.LumenData.CATALOG_VERSION) || 1, books: catalog };
      localStorage.setItem("lumen:catalog-override", JSON.stringify(payload));
    } catch (e) { /* quota — user must rely on the downloaded catalog.js */ }

    if (hits > 0) {
      // Auto-download updated catalog.js so covers become permanent on all devices after one commit.
      downloadCatalogJS(catalog);
    }

    ui.toast(`Added ${hits} cover${hits === 1 ? "" : "s"}${fails ? ` · ${fails} not found` : ""}. catalog.js downloaded — commit it to make covers permanent.`, {
      duration: 8000
    });
  }

  function applyCatalogOverride() {
    const books = readyBooks();
    if (!books.length) { ui.toast("Nothing ready to apply yet"); return; }
    try {
      localStorage.setItem("lumen:catalog-override",
        JSON.stringify({ version: (window.LumenData && window.LumenData.CATALOG_VERSION) || 1, books }));
      // Silent background embedding of each committed catalog book
      // (Batch 3). Queue is paced at 250ms to stay under Voyage rate
      // limits; vectors are written back into the override.
      books.forEach(b => queueEmbedding(b));
      ui.toast(`Applied ${books.length} curated book${books.length === 1 ? "" : "s"} — reload to see them everywhere`, {
        action: "Reload now",
        onAction: () => location.reload(),
        duration: 6000
      });
    } catch (e) {
      ui.toast("Couldn't save to this device — storage full or blocked?");
    }
  }

  function downloadCatalogJS(prebuiltBooks) {
    // Accept a prebuilt array (e.g. from refreshCatalogCovers), otherwise
    // prefer the live importer session, then fall back to the active override.
    let books = prebuiltBooks || null;
    if (!books) {
      books = readyBooks();
      if (!books.length) {
        const raw = localStorage.getItem("lumen:catalog-override");
        if (!raw) { ui.toast("No scored books to download — enrich your catalog first"); return; }
        try {
          const parsed = JSON.parse(raw);
          books = (parsed && Array.isArray(parsed.books)) ? parsed.books : [];
        } catch (e) {}
      }
    }
    if (!books || !books.length) { ui.toast("No scored books to download — enrich your catalog first"); return; }

    // Generate a drop-in replacement for data/catalog.js, preserving
    // all helper functions so the file is fully compatible.
    const ts = new Date().toISOString().slice(0, 10);
    const out = [
      "/* ============================================================",
      "   Lumen — Curated catalog",
      "   Generated " + ts + " via Settings → Admin → Curated catalog → Download catalog.js",
      "   Drop this file into data/catalog.js and commit.",
      "   Schema: data/CATALOG.md",
      "   ============================================================ */",
      "(function () {",
      "  \"use strict\";",
      "",
      "  const CATALOG_BUILTIN = " + JSON.stringify(books, null, 2) + ";",
      "",
      "  const CATALOG_VERSION = 1;",
      "",
      "  function resolveCatalog() {",
      "    try {",
      "      const raw = localStorage.getItem(\"lumen:catalog-override\");",
      "      if (!raw) return CATALOG_BUILTIN;",
      "      const parsed = JSON.parse(raw);",
      "      if (!parsed || !Array.isArray(parsed.books)) return CATALOG_BUILTIN;",
      "      return parsed.books;",
      "    } catch (e) {",
      "      return CATALOG_BUILTIN;",
      "    }",
      "  }",
      "",
      "  function getCatalogPage(catalog, page, pageSize) {",
      "    const size  = (typeof pageSize === \"number\" && pageSize > 0) ? pageSize : 50;",
      "    const start = Math.max(0, (page || 0)) * size;",
      "    return catalog.slice(start, start + size);",
      "  }",
      "",
      "  function searchCatalog(catalog, query) {",
      "    if (!query || !query.trim()) return catalog.slice(0, 50);",
      "    const q = query.trim().toLowerCase();",
      "    return catalog.filter(b => {",
      "      const title  = (b.title  || \"\").toLowerCase();",
      "      const author = (b.author || \"\").toLowerCase();",
      "      const tags   = [",
      "        ...(b.trope_tags || []),",
      "        ...(b.kink_tags  || []),",
      "        ...(b.tone       || [])",
      "      ].join(\" \").toLowerCase();",
      "      return title.includes(q) || author.includes(q) || tags.includes(q);",
      "    });",
      "  }",
      "",
      "  window.LumenData = window.LumenData || {};",
      "  window.LumenData.CATALOG         = resolveCatalog();",
      "  window.LumenData.CATALOG_BUILTIN = CATALOG_BUILTIN;",
      "  window.LumenData.CATALOG_VERSION = CATALOG_VERSION;",
      "  window.LumenData.getCatalogPage  = getCatalogPage;",
      "  window.LumenData.searchCatalog   = searchCatalog;",
      "})();",
      ""
    ].join("\n");

    const blob = new Blob([out], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "catalog.js";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
    ui.toast("Downloaded — replace data/catalog.js with this file and deploy once");
  }

  function downloadScoredJson() {
    const ready = readyBooks();
    let payload;
    if (ready.length) {
      payload = { version: (window.LumenData && window.LumenData.CATALOG_VERSION) || 1, books: ready };
    } else {
      const raw = localStorage.getItem("lumen:catalog-override");
      if (!raw) { ui.toast("No scored books to download — enrich your catalog first"); return; }
      try { payload = JSON.parse(raw); } catch (e) { ui.toast("Couldn't read stored catalog"); return; }
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "lumen-scores.json";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  function renderCatalogImporter() {
    const Disco = window.LumenDiscovery;
    const overrideActive = !!localStorage.getItem("lumen:catalog-override");
    const currentCount = (window.LumenData && window.LumenData.CATALOG || []).length;

    const card = util.el("div", { class: "card settings-card stack" });
    card.appendChild(util.el("div", { class: "settings-card-head" }, [
      util.el("div", {}, [
        util.el("h3", { text: "Curated catalog" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: `Import your catalog${currentCount ? ` (${currentCount} books currently loaded)` : ""}. Paste a title list or a CSV with any subset of the schema — the only required columns are title and author. Claude fills every other field on Enrich; anything you did provide is kept and marked human-sourced. See data/CATALOG.md for the full column list.` })
      ]),
      util.el("span", {
        class: "settings-badge " + (currentCount ? "settings-badge-ok" : "settings-badge-missing"),
        text: currentCount ? `${currentCount} loaded${overrideActive ? " · override" : ""}` : "Empty"
      })
    ]));

    // Mode switcher — two paths.
    //  - Titles list: one 'Title — Author' per line. Claude fills
    //    every field.
    //  - CSV: any columns from the schema (see data/CATALOG.md). Only
    //    'title' and 'author' are required; missing columns are queued
    //    for Claude on Enrich. Rows with all columns filled are used
    //    as-is and marked "human"-sourced so a later re-enrich won't
    //    overwrite them.
    const modes = [
      { id: "titles", label: "Titles list", hint: "One 'Title — Author' per line. Claude fills every field on Enrich." },
      { id: "csv",    label: "CSV",         hint: "Any columns from the schema work. Only title + author are required — Claude fills any gaps on Enrich; fields you did provide are kept and marked human-sourced." }
    ];
    const modeBar = util.el("div", { class: "segmented", role: "group", "aria-label": "Input mode" });
    modes.forEach(m => {
      modeBar.appendChild(util.el("button", {
        type: "button",
        "aria-pressed": catalogImport.mode === m.id ? "true" : "false",
        "data-mode": m.id,
        onclick: () => { catalogImport.mode = m.id; catalogImport.parsed = []; catalogImport.done = false; renderView(); }
      }, m.label));
    });
    card.appendChild(modeBar);
    const activeMode = modes.find(m => m.id === catalogImport.mode) || modes[0];
    card.appendChild(util.el("p", { class: "t-tiny t-subtle", text: activeMode.hint }));

    // Input area — file upload + paste textarea
    const fileInput = util.el("input", { type: "file", accept: ".csv,.tsv,.txt", onchange: (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { catalogImport.raw = String(reader.result || ""); ta.value = catalogImport.raw; };
      reader.readAsText(f);
    }});
    const ta = util.el("textarea", {
      class: "textarea",
      rows: "8",
      placeholder: catalogImport.mode === "titles"
        ? "Memoirs of a Woman of Pleasure — John Cleland\nVenus in Furs — Leopold von Sacher-Masoch\n…"
        : "title,author,description\n…",
      oninput: (e) => { catalogImport.raw = e.target.value; }
    });
    ta.value = catalogImport.raw;
    card.appendChild(util.el("div", { class: "row", style: { gap: "var(--s-2)", alignItems: "center" } }, [
      fileInput,
      util.el("span", { class: "t-tiny t-subtle", text: "or paste below" })
    ]));
    card.appendChild(ta);

    const btnRow = util.el("div", { class: "row", style: { gap: "var(--s-2)", flexWrap: "wrap" } });
    btnRow.appendChild(util.el("button", {
      class: "btn btn-sm",
      onclick: () => { parseImportBuffer(); renderView(); }
    }, "Parse"));
    btnRow.appendChild(util.el("button", {
      class: "btn btn-sm btn-primary",
      disabled: (catalogImport.parsed.every(r => r.status !== "pending") || catalogImport.enriching) ? "disabled" : null,
      onclick: () => enrichPending()
    }, catalogImport.enriching ? "Enriching…" : "Enrich with Claude"));
    btnRow.appendChild(util.el("button", {
      class: "btn btn-sm",
      disabled: !catalogImport.parsed.some(r => r.status === "ready") ? "disabled" : null,
      onclick: () => applyCatalogOverride()
    }, "Apply to this device"));
    btnRow.appendChild(util.el("button", {
      class: "btn btn-sm",
      disabled: !catalogImport.parsed.some(r => r.status === "ready") ? "disabled" : null,
      onclick: () => downloadCatalogJS()
    }, "Download catalog.js"));
    btnRow.appendChild(util.el("button", {
      class: "btn btn-sm",
      disabled: (!catalogImport.parsed.some(r => r.status === "ready") && !localStorage.getItem("lumen:catalog-override")) ? "disabled" : null,
      onclick: () => downloadScoredJson()
    }, "Download scored JSON"));
    const uploadLabel = util.el("label", { class: "btn btn-sm", style: { cursor: "pointer" }, title: "Upload a previously downloaded lumen-scores.json to restore scores without re-enriching" });
    uploadLabel.appendChild(document.createTextNode("Upload scored JSON"));
    const uploadInput = util.el("input", {
      type: "file", accept: ".json,application/json",
      style: { display: "none" },
      onchange: (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const parsed = JSON.parse(ev.target.result);
            if (!parsed || !Array.isArray(parsed.books) || !parsed.books.length) {
              ui.toast("Invalid file — expected a Lumen scores JSON"); return;
            }
            localStorage.setItem("lumen:catalog-override", JSON.stringify(parsed));
            ui.toast(`Loaded ${parsed.books.length} scored book${parsed.books.length === 1 ? "" : "s"} — reload to apply`, {
              action: "Reload now", onAction: () => location.reload(), duration: 6000
            });
          } catch (_) {
            ui.toast("Couldn't parse the file — is this a Lumen scores JSON?");
          }
        };
        reader.readAsText(file);
        e.target.value = "";
      }
    });
    uploadLabel.appendChild(uploadInput);
    btnRow.appendChild(uploadLabel);
    // "Refresh covers" — for catalogs that were imported before
    // the Google Books lookup was wired in (or whose thumbnails
    // 404'd). Hits Google Books for every book in the currently-
    // loaded catalog that is missing a thumbnail, and re-saves.
    btnRow.appendChild(util.el("button", {
      class: "btn btn-sm btn-ghost",
      disabled: !((window.LumenData && window.LumenData.CATALOG || []).length) ? "disabled" : null,
      onclick: () => refreshCatalogCovers()
    }, "Refresh covers from Google Books"));

    if (overrideActive) {
      btnRow.appendChild(util.el("button", {
        class: "btn btn-sm btn-ghost",
        onclick: () => {
          localStorage.removeItem("lumen:catalog-override");
          ui.toast("Reverted to the committed catalog — reload to refresh", {
            action: "Reload", onAction: () => location.reload(), duration: 5000
          });
        }
      }, "Reset to committed catalog"));
    }
    card.appendChild(btnRow);

    const status = window.LumenDiscovery ? window.LumenDiscovery.message : "";
    if (catalogImport.enriching && status) {
      card.appendChild(util.el("p", { class: "t-small t-accent", style: { marginTop: "var(--s-2)" }, text: status }));
    }

    const preview = util.el("div", { id: "catalog-importer-rows", class: "stack-sm" });
    preview.appendChild(buildImporterPreview());
    card.appendChild(preview);

    const hasAnyKey = Disco && (Disco.hasKey && Disco.hasKey());
    if (!hasAnyKey) {
      card.appendChild(util.el("p", { class: "t-tiny t-subtle", text: "Heads up — Claude enrichment needs an API key configured. CSV-full imports work without it." }));
    }
    return card;
  }

  function renderSettings() {
    const Disco = window.LumenDiscovery;
    const wrap = util.el("div", { class: "page settings-page" });

    // ── Header ──────────────────────────────────────────────────────────
    wrap.appendChild(util.el("div", { class: "page-head settings-page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Admin" }),
        util.el("h1", { html: "<em>Admin</em>" }),
        util.el("p", { class: "lede", text: "Keys and configuration. Everything here is stored locally on this device." })
      ])
    ]));

    // ── Operator controls ────────────────────────────────────────────────
    const hasMasterKey = !!(Disco && Disco.getMasterKey && Disco.getMasterKey());
    const demoOn       = !!(Disco && Disco.getDemoMode  && Disco.getDemoMode());
    const currentCap   = (Disco && Disco.getSessionCap)    ? Disco.getSessionCap()    : 10;
    const remaining    = (Disco && Disco.throttleRemaining) ? Disco.throttleRemaining() : "—";

    const opCard = util.el("div", { class: "card settings-op-card stack" });
    opCard.appendChild(util.el("div", { class: "settings-op-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Operator" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "2px" },
          text: "Discovery Phase settings — only visible via the trapdoor." })
      ]),
      util.el("span", {
        class: "settings-badge " + (hasMasterKey ? "settings-badge-ok" : "settings-badge-missing"),
        text: hasMasterKey ? (demoOn ? "Demo on" : "Key set") : "No key"
      })
    ]));

    const opBody = util.el("div", { class: "settings-op-body" });

    // Left: master key input
    const keyCol = util.el("div", { class: "settings-op-col" });
    keyCol.appendChild(util.el("div", { class: "settings-field-label", text: "Master Claude API key" }));
    const masterInput = util.el("input", {
      type: "password", class: "input", placeholder: "sk-ant-…",
      value: (Disco && Disco.getMasterKey) ? Disco.getMasterKey() : "",
      autocomplete: "off", spellcheck: "false"
    });
    keyCol.appendChild(masterInput);
    const masterRevealLabel = util.el("label", { class: "toggle settings-reveal-toggle" });
    const masterRevealCb = util.el("input", { type: "checkbox",
      onchange: e => masterInput.setAttribute("type", e.target.checked ? "text" : "password") });
    masterRevealLabel.appendChild(masterRevealCb);
    masterRevealLabel.appendChild(util.el("span", { class: "toggle-track" }));
    masterRevealLabel.appendChild(util.el("span", { class: "toggle-label", text: "Reveal" }));
    keyCol.appendChild(masterRevealLabel);
    opBody.appendChild(keyCol);

    // Right: demo mode + session cap
    const ctrlCol = util.el("div", { class: "settings-op-col" });

    const demoCtrlRow = util.el("div", { class: "settings-op-control-row" });
    demoCtrlRow.appendChild(util.el("div", {}, [
      util.el("div", { class: "t-small", text: "Demo Mode" }),
      util.el("div", { class: "t-tiny t-subtle", text: "Bianca works for every visitor — no key prompt." })
    ]));
    const demoLabel = util.el("label", { class: "toggle" });
    const demoCb    = util.el("input", { type: "checkbox" });
    demoCb.checked  = demoOn;
    demoLabel.appendChild(demoCb);
    demoLabel.appendChild(util.el("span", { class: "toggle-track" }));
    demoCtrlRow.appendChild(demoLabel);
    ctrlCol.appendChild(demoCtrlRow);

    const capCtrlRow = util.el("div", { class: "settings-op-control-row" });
    capCtrlRow.appendChild(util.el("div", {}, [
      util.el("div", { class: "t-small", text: "AI calls / hour" }),
      util.el("div", { class: "t-tiny t-subtle", text: `${remaining} remaining this session` })
    ]));
    const capInput = util.el("input", {
      type: "number", class: "input", min: "1", max: "100", value: String(currentCap),
      style: { width: "64px", textAlign: "center" }
    });
    capCtrlRow.appendChild(capInput);
    ctrlCol.appendChild(capCtrlRow);

    opBody.appendChild(ctrlCol);
    opCard.appendChild(opBody);

    const opActions = util.el("div", { class: "settings-op-actions" });
    opActions.appendChild(util.el("button", { class: "btn btn-primary btn-sm", onclick: () => {
      const keyVal = masterInput.value.trim();
      const capVal = parseInt(capInput.value, 10);
      if (Disco.setMasterKey)  Disco.setMasterKey(keyVal);
      if (Disco.setDemoMode)   Disco.setDemoMode(demoCb.checked);
      if (Disco.setSessionCap && Number.isFinite(capVal) && capVal > 0) Disco.setSessionCap(capVal);
      if (keyVal && demoCb.checked) {
        store.update(s => { s.ui.adultConfirmed = true; });
        ui.toast("Demo Mode ON · Bianca is live for all visitors");
      } else if (keyVal) {
        ui.toast("Master key saved");
      } else {
        ui.toast("Master key cleared");
      }
      renderView();
    }}, "Save changes"));
    if (hasMasterKey) {
      opActions.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", onclick: () => {
        if (Disco.clearMasterKey) Disco.clearMasterKey();
        if (Disco.setDemoMode)    Disco.setDemoMode(false);
        ui.toast("Master key cleared · Demo Mode off");
        renderView();
      }}, "Clear key"));
    }
    opCard.appendChild(opActions);
    wrap.appendChild(opCard);

    // ── API Keys (collapsible) ──────────────────────────────────────────
    const Embed = window.LumenEmbeddings;
    const hasVoyage = () => !!(Embed && Embed.getApiKey && Embed.getApiKey());
    const keyStatusParts = [
      Disco.getApiKey()  ? "Claude" : "",
      hasVoyage()        ? "Voyage" : "",
      Disco.getGoogleKey() ? "Google" : ""
    ].filter(Boolean);
    const keySummaryText = keyStatusParts.length
      ? keyStatusParts.join(" · ") + " configured"
      : "None configured";

    const devDetails = document.createElement("details");
    devDetails.className = "settings-advanced-section";
    devDetails.appendChild(util.el("summary", { class: "settings-advanced-summary" }, [
      util.el("span", { class: "t-eyebrow", text: "API Keys" }),
      util.el("span", { class: "t-small t-subtle", style: { marginLeft: "var(--s-2)" }, text: keySummaryText })
    ]));
    if (Disco.getApiKey() || hasVoyage()) {
      devDetails.open = true;
    }

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
    devDetails.appendChild(keyCard);

    // --- Voyage API key (for semantic search) ----------------------------
    // Styled identically to the Claude card above. setApiKey("") in
    // embeddings.js doubles as "clear" (removes the localStorage entry),
    // so there's no separate clearApiKey() to call.
    const voyageCard = util.el("div", { class: "card settings-card stack" });
    voyageCard.appendChild(util.el("div", { class: "settings-card-head" }, [
      util.el("div", {}, [
        util.el("h3", { text: "Voyage API key (for semantic search)" }),
        util.el("p", { class: "t-small t-muted", style: { marginTop: "4px" }, text: "Required for meaning-based search in your Library. Stored locally, never sent anywhere but Voyage AI." })
      ]),
      util.el("span", {
        class: "settings-badge " + (hasVoyage() ? "settings-badge-ok" : "settings-badge-missing"),
        text: hasVoyage() ? "Key saved" : "Not set"
      })
    ]));

    const voyageInput = util.el("input", {
      type: "password",
      class: "input",
      placeholder: "pa-…",
      value: hasVoyage() ? Embed.getApiKey() : "",
      autocomplete: "off",
      spellcheck: "false"
    });
    voyageCard.appendChild(voyageInput);

    const voyageReveal = util.el("label", { class: "toggle", style: { fontSize: "12px", color: "var(--text-muted)" } });
    const voyageRevealInput = util.el("input", { type: "checkbox", onchange: (e) => {
      voyageInput.setAttribute("type", e.target.checked ? "text" : "password");
    }});
    voyageReveal.appendChild(voyageRevealInput);
    voyageReveal.appendChild(util.el("span", { class: "toggle-track" }));
    voyageReveal.appendChild(util.el("span", { class: "toggle-label", text: "Show key" }));
    voyageCard.appendChild(voyageReveal);

    const voyageActions = util.el("div", { class: "row", style: { gap: "var(--s-2)" } });
    voyageActions.appendChild(util.el("button", { class: "btn btn-primary btn-sm", onclick: () => {
      if (!Embed || !Embed.setApiKey) { ui.toast("Embeddings module not loaded"); return; }
      const val = voyageInput.value.trim();
      if (!val) {
        Embed.setApiKey("");
        ui.toast("Voyage key cleared");
        renderView();
        return;
      }
      Embed.setApiKey(val);
      ui.toast("Voyage key saved locally");
      renderView();
    }}, hasVoyage() ? "Update" : "Save"));
    voyageActions.appendChild(util.el("button", { class: "btn btn-ghost btn-sm", disabled: !hasVoyage() || null, onclick: () => {
      ui.modal({
        title: "Clear Voyage API key?",
        body: "<p class=\"t-muted\">Removes the key from this device. You can paste it back in any time.</p>",
        primary: { label: "Clear", onClick: () => {
          if (Embed && Embed.setApiKey) Embed.setApiKey("");
          voyageInput.value = "";
          ui.toast("Voyage key cleared");
          renderView();
        }},
        secondary: { label: "Cancel" }
      });
    }}, "Clear"));
    voyageCard.appendChild(voyageActions);

    voyageCard.appendChild(util.el("div", { class: "disclosure-note" }, [
      util.el("div", {}, [
        util.el("strong", { text: "Heads up · " }),
        "Calling Voyage from the browser exposes this key to any script loaded on this page. Use a personal key, set a spend limit in the Voyage console, and don't paste a team key here. Full detail in ",
        util.el("a", { href: "#/transparency", style: { color: "var(--accent)", textDecoration: "underline" } }, "Transparency"),
        "."
      ])
    ]));
    devDetails.appendChild(voyageCard);

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
    devDetails.appendChild(gbCard);
    wrap.appendChild(devDetails);

    // ── Library management (single card, three rows) ──────────────────
    const starterLoaded   = hasStarterLibraryLoaded();
    const starterCount    = (SEED_BOOKS || []).length;
    const loadedCount     = (store.get().discovered || []).filter(d => d.source === "seed").length;
    const hiddenIds       = Object.keys(store.get().hidden || {});
    const rejectedPickIds = Object.keys(store.get().dailyPicksRejected || {});

    const libCard = util.el("div", { class: "card settings-mgmt-card stack" });
    libCard.appendChild(util.el("h3", { class: "settings-mgmt-title", text: "Library" }));

    function mgmtRow(label, description, badgeEl, actionEls, expandEl) {
      const row = util.el("div", { class: "settings-mgmt-row" });
      row.appendChild(util.el("div", { class: "settings-mgmt-row-info" }, [
        util.el("div", { class: "t-small", text: label }),
        util.el("div", { class: "t-tiny t-subtle", text: description })
      ]));
      const actions = util.el("div", { class: "settings-mgmt-row-actions" });
      if (badgeEl) actions.appendChild(badgeEl);
      actionEls.forEach(el => actions.appendChild(el));
      row.appendChild(actions);
      if (expandEl) row.appendChild(expandEl);
      return row;
    }

    // Row 1 — Starter library
    libCard.appendChild(mgmtRow(
      "Starter library",
      `${starterCount} historical and classical titles — Fanny Hill, Kama Sutra, Venus in Furs, The Decameron, and more.`,
      util.el("span", {
        class: "settings-badge " + (starterLoaded ? "settings-badge-ok" : "settings-badge-missing"),
        text: starterLoaded ? `${loadedCount} loaded` : "Not loaded"
      }),
      [
        util.el("button", {
          class: "btn btn-sm btn-primary",
          disabled: (starterLoaded && loadedCount === starterCount) ? "disabled" : null,
          onclick: () => {
            const added = loadStarterLibrary();
            ui.toast(added ? `Loaded ${added} title${added === 1 ? "" : "s"}` : "Already fully loaded");
            renderView();
          }
        }, starterLoaded ? "Top up" : "Load"),
        starterLoaded ? util.el("button", {
          class: "btn btn-sm btn-ghost",
          onclick: () => ui.modal({
            title: "Remove the starter library?",
            body: "<p class=\"t-muted\">Every starter title is removed along with any reading state or tags you attached. Discovery adds are untouched.</p>",
            primary: { label: "Remove", onClick: () => {
              ui.toast(`Removed ${unloadStarterLibrary()} starter titles`);
              renderView();
            }},
            secondary: { label: "Cancel" }
          })
        }, "Remove") : null
      ].filter(Boolean)
    ));

    // Row 2 — Hidden books (with inline expand if any)
    const hiddenExpand = hiddenIds.length ? (() => {
      const d = util.el("div", { class: "settings-mgmt-expand" });
      hiddenIds.slice(0, 8).forEach(id => {
        const book = findBook(id);
        const r = util.el("div", { class: "settings-mgmt-expand-row" });
        r.appendChild(util.el("div", {}, [
          util.el("div", { class: "t-small t-serif", text: book ? book.title : "Untracked title" }),
          util.el("div", { class: "t-tiny t-subtle", text: book ? book.author : `id: ${id}` })
        ]));
        r.appendChild(util.el("button", { class: "btn btn-xs btn-primary", onclick: () => {
          if (book) { unhideBook(id); ui.toast(`Restored ${book.title}`); }
          else store.update(s => { delete s.hidden[id]; });
          renderView();
        }}, "Restore"));
        d.appendChild(r);
      });
      if (hiddenIds.length > 8) {
        d.appendChild(util.el("p", { class: "t-tiny t-subtle", style: { paddingTop: "var(--s-2)" },
          text: `+ ${hiddenIds.length - 8} more` }));
      }
      if (hiddenIds.length > 1) {
        d.appendChild(util.el("button", { class: "btn btn-xs btn-ghost", style: { marginTop: "var(--s-2)" },
          onclick: () => ui.modal({
            title: "Restore all hidden books?",
            body: "<p class=\"t-muted\">Brings every dismissed title back into your library.</p>",
            primary: { label: "Restore all", onClick: () => {
              store.update(st => { st.hidden = {}; });
              ui.toast("All hidden books restored");
              renderView();
            }},
            secondary: { label: "Cancel" }
          })
        }, "Restore all"));
      }
      return d;
    })() : null;

    libCard.appendChild(mgmtRow(
      "Hidden books",
      hiddenIds.length
        ? `${hiddenIds.length} title${hiddenIds.length === 1 ? "" : "s"} dismissed from your library.`
        : "None dismissed. Dismiss a card from the Library to send it here.",
      util.el("span", {
        class: "settings-badge " + (hiddenIds.length ? "settings-badge-missing" : "settings-badge-ok"),
        text: hiddenIds.length ? `${hiddenIds.length} hidden` : "None"
      }),
      [],
      hiddenExpand
    ));

    // Row 3 — Rejected Daily Picks (with inline expand if any)
    const rejectedExpand = rejectedPickIds.length ? (() => {
      const d = util.el("div", { class: "settings-mgmt-expand" });
      rejectedPickIds.slice(0, 8).forEach(id => {
        const book = findBook(id);
        const r = util.el("div", { class: "settings-mgmt-expand-row" });
        r.appendChild(util.el("div", {}, [
          util.el("div", { class: "t-small t-serif", text: book ? book.title : "Untracked title" }),
          util.el("div", { class: "t-tiny t-subtle", text: book
            ? (book.author + (book._catalog ? " \u00b7 curated" : book._discovered ? " \u00b7 Discovery" : ""))
            : `id: ${id}` })
        ]));
        r.appendChild(util.el("button", { class: "btn btn-xs btn-primary", onclick: () => {
          restoreDailyPick(id);
          ui.toast(book ? `${book.title} is eligible for picks again` : "Restored");
          renderView();
        }}, "Restore"));
        d.appendChild(r);
      });
      if (rejectedPickIds.length > 8) {
        d.appendChild(util.el("p", { class: "t-tiny t-subtle", style: { paddingTop: "var(--s-2)" },
          text: `+ ${rejectedPickIds.length - 8} more` }));
      }
      if (rejectedPickIds.length > 1) {
        d.appendChild(util.el("button", { class: "btn btn-xs btn-ghost", style: { marginTop: "var(--s-2)" },
          onclick: () => {
            store.update(st => { st.dailyPicksRejected = {}; });
            ui.toast("All rejected picks restored");
            renderView();
          }
        }, "Restore all"));
      }
      return d;
    })() : null;

    libCard.appendChild(mgmtRow(
      "Rejected Daily Picks",
      rejectedPickIds.length
        ? `${rejectedPickIds.length} title${rejectedPickIds.length === 1 ? "" : "s"} hidden from Home picks.`
        : "None rejected. Use the \u00d7 on any Home Pick card to send it here.",
      util.el("span", {
        class: "settings-badge " + (rejectedPickIds.length ? "settings-badge-missing" : "settings-badge-ok"),
        text: rejectedPickIds.length ? `${rejectedPickIds.length} rejected` : "None"
      }),
      [],
      rejectedExpand
    ));

    wrap.appendChild(libCard);

    // ── Curated catalog importer ────────────────────────────────────────
    wrap.appendChild(renderCatalogImporter());

    // ── Navigation links (no card) ──────────────────────────────────────
    wrap.appendChild(util.el("div", { class: "settings-footer-nav" }, [
      util.el("span", { class: "t-tiny t-subtle", text: "Also:" }),
      util.el("a", { class: "btn btn-sm btn-ghost", href: "#/profile" }, "Reader profile"),
      util.el("a", { class: "btn btn-sm btn-ghost", href: "#/vault" }, "Privacy & Vault"),
      util.el("a", { class: "btn btn-sm btn-ghost", href: "#/transparency" }, "Transparency")
    ]));

    // ── Danger zone (no card, red accent border) ────────────────────────
    const dangerZone = util.el("div", { class: "settings-danger-zone" });
    dangerZone.appendChild(util.el("div", { class: "settings-danger-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-small", style: { color: "var(--danger, #ef4444)", fontWeight: "600" },
          text: "Delete entire library" }),
        util.el("div", { class: "t-tiny t-subtle", style: { marginTop: "2px" },
          text: "Wipes every book \u2014 Discovery saves, seed library, and curated catalogue \u2014 along with reading statuses, tags, and cached embeddings. Profile, API keys, journal, and vault stay intact." })
      ]),
      util.el("button", {
        class: "btn btn-sm",
        style: { color: "var(--danger, #ef4444)", borderColor: "var(--danger, #ef4444)", flexShrink: "0" },
        onclick: () => ui.modal({
          title: "Delete the entire library?",
          body: "<p class=\"t-muted\">Removes every book on this device and clears their states, tags, hidden flags, rejected picks, and embeddings. Profile, API keys, journal, and vault are untouched. This cannot be undone.</p>",
          primary: { label: "Delete everything", onClick: () => {
            store.update(st => {
              st.discovered = []; st.bookStates = {}; st.tags = {};
              st.hidden = {}; st.dailyPicksRejected = {};
            });
            try { localStorage.removeItem("lumen:catalog-override"); } catch (_) {}
            ui.toast("Library deleted \u2014 reloading\u2026");
            setTimeout(() => location.reload(), 500);
          }},
          secondary: { label: "Cancel" }
        })
      }, "Delete entire library")
    ]));
    wrap.appendChild(dangerZone);

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
      util.el("p", { class: "t-muted", text: "Your profile, reading states, custom tags, journal entries, vault contents, Bianca conversation, and friend chat — all of it lives in localStorage on this device. There is no server. There is no account. There is no telemetry. Clearing browser data clears Lumen entirely." }),
      util.el("h3", { text: "What the vault passcode does and does not do" }),
      util.el("p", { class: "t-muted", text: "The vault passcode gates the Vault tab re-entry within this app. It is a simple hash check, not encryption. Anyone with access to this device (or your browser's dev tools) could inspect the localStorage directly. Treat it as a courtesy against over-the-shoulder glances, not as real security. Use your operating-system account password and device encryption for actual protection." }),
      util.el("h3", { text: "About Discovery and Bianca — calling Claude from your browser" }),
      util.el("p", { class: "t-muted", text: "The Discovery tab and Bianca (the AI reading assistant) call the Anthropic Messages API directly from this page using an opt-in header ('anthropic-dangerous-direct-browser-access'). That convenience carries a real tradeoff: your API key sits inside your browser's localStorage, and any script loaded on this page — including any browser extension — can read it. The key is also sent with every request, so any network intermediary could observe it." }),
      util.el("p", { class: "t-muted", text: "Use a key dedicated to personal experimentation, set a low monthly spend limit in the Anthropic console, and never paste a team or production key here. If you want real safety, run a small server-side proxy and point Lumen at that instead. Google Books calls also go directly from your browser, but that API does not require authentication." }),
      util.el("h3", { text: "The Master Key and Demo Mode" }),
      util.el("p", { class: "t-muted", text: "During the Discovery Phase, an operator can configure a Master Key via the admin panel (accessible via the 5-click logo trapdoor). The Master Key is a single Claude API key stored in the browser on the operator's device. When Demo Mode is on, Bianca and Discovery work for every visitor automatically — no visitor needs to supply their own key. The session cap (default: 10 calls/hour) limits how many AI calls any one visitor can make, protecting against runaway spend. The Master Key never leaves the operator's browser." })
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
        shortcutRow("Toggle Bianca",        "S")
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
        const tileTop = util.el("div", { style: { display: "flex", gap: "var(--s-3)", alignItems: "flex-start" } });
        tileTop.appendChild(buildCoverBlock(book, { size: "sm", showHeat: false }));
        const tileMeta = util.el("div", { style: { minWidth: 0, flex: "1" } });
        tileMeta.appendChild(util.el("div", { class: "t-eyebrow", text: util.humanise(book.category) }));
        tileMeta.appendChild(util.el("div", { class: "t-serif", style: { fontSize: "16px", marginTop: "4px" }, text: book.title }));
        tileMeta.appendChild(util.el("div", { class: "t-small t-subtle", text: book.author }));
        tileTop.appendChild(tileMeta);
        tile.appendChild(tileTop);
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

      // Linked book — at the top so it frames the entry context immediately
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

      const saveRow = util.el("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "var(--s-3)" } });
      const saveBtn = util.el("button", { class: "btn btn-primary", onclick: () => {
        store.update(s => {
          const it = s.journal.find(x => x.id === entry.id);
          if (!it) return;
          it.title = titleInput.value;
          it.body = bodyArea.value;
        });
        saveBtn.textContent = "Saved";
        saveBtn.disabled = true;
        setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 1500);
      } }, "Save");
      saveRow.appendChild(saveBtn);
      card.appendChild(saveRow);

      editorSide.appendChild(card);
    }

    setTimeout(() => { paintList(); paintEditor(); }, 0);
    return wrap;
  }

  /* -------------------- chat (Bianca + Friends) -------------------- */
  const chatState = { active: "bianca", friendId: null };

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

  // ============================================================
  // Bianca context model — single source of truth for what Bianca
  // knows about the app. Rebuilt on renderView() and on every
  // store update, then pushed to LumenBianca.setContext(). Shape
  // is documented in the batch plan; intent handlers below
  // depend on these fields being stable.
  // ============================================================
  function buildBiancaContext(routeId) {
    const s = store.get();
    const hidden = s.hidden || {};
    const rejectedPicks = s.dailyPicksRejected || {};
    const catalogBooks = (window.LumenData && window.LumenData.CATALOG) || [];
    const pool = listAllBooks();
    const visible = pool.filter(b => !hidden[b.id]);
    const ranked = Engine.rankRecommendations(s.profile, s.weights, visible);

    // Daily picks = top 3 of ranked-and-not-rejected (mirror of
    // views.discover()'s logic so Bianca sees the same list).
    const eligible = ranked.scored.filter(x => !rejectedPicks[x.book.id]);
    const picks = eligible.slice(0, 3).map(x => ({
      id: x.book.id, title: x.book.title, author: x.book.author,
      fitScore: x.fitScore, confidence: x.confidence,
      reasons: (x.why && x.why.reasons) || [],
      warnings: x.book.content_warnings || [],
      heat: x.book.heat_level
    }));

    const dismissedPicksDetail = Object.keys(rejectedPicks).map(id => {
      const b = pool.find(x => x.id === id);
      return { id, title: b ? b.title : id, rejectedAt: rejectedPicks[id].rejectedAt };
    });

    const byCategory = {};
    visible.forEach(b => {
      const k = b.category || "uncategorised";
      byCategory[k] = (byCategory[k] || 0) + 1;
    });
    const scoredVisible = ranked.scored;
    const avgFit = scoredVisible.length
      ? Math.round(scoredVisible.reduce((a, x) => a + x.fitScore, 0) / scoredVisible.length)
      : 0;

    const focus = { book: null, journalEntryId: null, vaultPinId: null };
    if (libState && libState.focusBookId) {
      const b = findBook(libState.focusBookId);
      if (b) {
        const scored = ranked.scored.find(x => x.book.id === b.id);
        focus.book = {
          id: b.id, title: b.title, author: b.author,
          fitScore: scored ? scored.fitScore : null,
          readingState: (s.bookStates || {})[b.id] || "none",
          heat: b.heat_level,
          warnings: b.content_warnings || [],
          tags: (s.tags || {})[b.id] || [],
          isInLibrary: !hidden[b.id]
        };
      }
    }
    if (typeof journalState !== "undefined" && journalState && journalState.selectedId) {
      focus.journalEntryId = journalState.selectedId;
    }

    const compareSlotsDetail = (cmpState && cmpState.slots ? cmpState.slots : [])
      .map(id => {
        if (!id) return null;
        const b = findBook(id);
        if (!b) return null;
        const scored = Engine.compareBooks([id], s.profile, s.weights, pool)[0];
        return {
          id: b.id, title: b.title,
          fit: scored ? scored.fitScore : null,
          confidence: scored ? scored.confidence : null
        };
      });

    const biancaPinnedDetail = ((s.chats && s.chats.biancaPinned) || [])
      .map(p => { const b = findBook(p.bookId); return b ? { id: b.id, title: b.title } : null; })
      .filter(Boolean);

    return {
      route: routeId,
      user: {
        profile: { ...s.profile },
        weights: { ...s.weights },
        theme: (s.ui && s.ui.theme) || "rose",
        discreet: !!(s.ui && s.ui.discreet),
        adultConfirmed: !!(s.ui && s.ui.adultConfirmed)
      },
      library: {
        total: pool.length,
        visibleTotal: visible.length,
        curatedCount: catalogBooks.length,
        discoveredCount: (s.discovered || []).filter(d => d.source !== "seed").length,
        seedCount: (s.discovered || []).filter(d => d.source === "seed").length,
        hiddenCount: Object.keys(hidden).length,
        byCategory,
        averageFit: avgFit,
        topThreeIds: picks.map(p => p.id)
      },
      dailyPicks: picks,
      dailyPicksRejected: dismissedPicksDetail,
      discovery: {
        lastQuery: (typeof discoveryState !== "undefined" && discoveryState && discoveryState.lastQuery) || "",
        mode: (typeof discoveryState !== "undefined" && discoveryState && discoveryState.mode) || null,
        resultCount: (typeof discoveryState !== "undefined" && discoveryState && (discoveryState.raw || []).length) || 0,
        hasApiKey: !!(window.LumenDiscovery && window.LumenDiscovery.hasKey && window.LumenDiscovery.hasKey())
      },
      compare: {
        slots: compareSlotsDetail,
        hasDeepAnalysis: !!(cmpState && cmpState.lastDeepAnalysis)
      },
      focus,
      biancaPinned: biancaPinnedDetail,
      vault: {
        pinnedCount: ((s.vault || {}).pinned || []).length,
        analysesCount: ((s.vault || {}).analyses || []).length,
        locked: !!(s.vault && s.vault.locked)
      },
      journal: {
        entriesCount: (s.journal || []).length,
        lastTitle: (s.journal && s.journal[0] && s.journal[0].title) || ""
      },
      catalog: {
        loaded: catalogBooks.length > 0,
        count: catalogBooks.length,
        overrideActive: !!localStorage.getItem("lumen:catalog-override"),
        version: (window.LumenData && window.LumenData.CATALOG_VERSION) || 1
      },
      contentControls: {
        warnStrict: s.profile.warnStrict,
        exclusionsCount: (s.profile.exclude || []).length,
        hardExclusions: (s.profile.exclude || []).slice()
      }
    };
  }

  // Back-compat — old callers of computeBiancaContext(routeId) get
  // the same shape, but we discard everything except route/chips.
  // The richer data lives on the context object now.
  // ============================================================
  // Bianca system context — flattens buildBiancaContext() into the
  // prompt-ready string that's appended to the persona in
  // chatWithBianca(). Format is readable JSON-ish plain text so the
  // model can cite fields back verbatim. Kept short — hard
  // constraints land loud, soft constraints read as hints, big
  // lists are truncated.
  // ============================================================
  function buildBiancaSystemContext(routeId) {
    const ctx = buildBiancaContext(routeId);
    const s = store.get();
    const now = new Date();

    // Collect last 5 rated books. bookStates has "want" / "reading"
    // / "read" / "skip". Treat "read" as rated. If no ratings exist,
    // fall back to the most recently-added library entries.
    const allRated = Object.entries(s.bookStates || {})
      .filter(([, v]) => v === "read")
      .map(([id]) => findBook(id))
      .filter(Boolean)
      .slice(0, 5);
    const wantToRead = Object.entries(s.bookStates || {})
      .filter(([, v]) => v === "want")
      .map(([id]) => findBook(id))
      .filter(Boolean)
      .slice(0, 8);

    // Truncate the library roster to the 12 highest-fit books so
    // the model has usable ids to emit in ENHANCED_BOOK_CARD markers
    // without bloating the prompt.
    const topLibrary = (ctx.dailyPicks || []).concat(
      ctx.biancaPinned.map(p => ({ id: p.id, title: p.title, author: "", fitScore: null }))
    );
    const rosterIds = new Set(topLibrary.map(b => b.id));
    for (const b of listAllBooks().slice(0, 12)) {
      if (rosterIds.size >= 14) break;
      if (!rosterIds.has(b.id) && !(s.hidden || {})[b.id]) {
        topLibrary.push({ id: b.id, title: b.title, author: b.author, fitScore: null });
        rosterIds.add(b.id);
      }
    }

    const profile = ctx.user.profile;
    const pushLine = (arr, k, v) => { if (v !== "" && v !== null && v !== undefined) arr.push(`${k}: ${v}`); };
    const personaLines = [];
    pushLine(personaLines, "readingLevel",     profile.readingLevel || "casual");
    pushLine(personaLines, "formatPreference", profile.formatPreference || "any");
    pushLine(personaLines, "spoilersEnabled",  !!profile.spoilersEnabled);
    pushLine(personaLines, "warnStrict",       profile.warnStrict);
    pushLine(personaLines, "heat",    `${profile.heat}/5`);
    pushLine(personaLines, "explicit", `${profile.explicit}/5`);
    pushLine(personaLines, "consent floor", `>=${profile.consent}/5`);
    pushLine(personaLines, "taboo tolerance", `${profile.taboo}/5`);
    pushLine(personaLines, "plot weight", `${profile.plot}/5`);
    if ((profile.tone || []).length)   personaLines.push(`tone preferences: ${profile.tone.join(", ")}`);
    if ((profile.trope || []).length)  personaLines.push(`tropes drawn to: ${profile.trope.join(", ")}`);
    if ((profile.kink || []).length)   personaLines.push(`kink tags: ${profile.kink.join(", ")}`);
    if ((profile.exclude || []).length)
      personaLines.push(`HARD exclusions (never recommend books carrying these): ${profile.exclude.join(", ")}`);

    const focusLines = [];
    if (ctx.focus && ctx.focus.book) {
      const f = ctx.focus.book;
      focusLines.push(`activeBook: ${f.title} (id=${f.id})`);
      focusLines.push(`activeBookFitScore: ${f.fitScore || "n/a"}`);
      focusLines.push(`activeBookHeat: ${f.heat || "n/a"}/5`);
      focusLines.push(`activeBookReadingState: ${f.readingState}`);
      if ((f.warnings || []).length) focusLines.push(`activeBookWarnings: ${f.warnings.slice(0, 5).join(", ")}`);
    } else {
      focusLines.push("activeBook: (none — user is browsing)");
    }

    const lib = ctx.library;
    const libLines = [
      `visibleTotal: ${lib.visibleTotal}`,
      `curatedCount: ${lib.curatedCount}`,
      `discoveredCount: ${lib.discoveredCount}`,
      `averageFit: ${lib.averageFit}`
    ];

    const pickLines = (ctx.dailyPicks || []).map((p, i) =>
      `${i + 1}. ${p.title} by ${p.author} (id=${p.id}, fit=${p.fitScore}${p.warnings.length ? ", warnings=" + p.warnings.length : ""})`);
    const rejectedPickLines = (ctx.dailyPicksRejected || []).slice(0, 6).map(r => `- ${r.title} (id=${r.id})`);

    const ratedLines = allRated.length
      ? allRated.map(b => `- ${b.title} by ${b.author} (id=${b.id})`)
      : ["(none yet)"];
    const wantLines = wantToRead.length
      ? wantToRead.map(b => `- ${b.title} by ${b.author} (id=${b.id})`)
      : ["(nothing saved to want-to-read)"];
    const rosterLines = topLibrary.slice(0, 14).map(b =>
      `- ${b.title}${b.author ? " by " + b.author : ""} (id=${b.id})`);

    const pinnedLines = (ctx.biancaPinned || []).map(p => `- ${p.title} (id=${p.id})`);
    const compareLines = (ctx.compare.slots || []).filter(Boolean).map(c => `- ${c.title} (id=${c.id}, fit=${c.fit})`);

    return [
      `sessionAt: ${now.toISOString()}`,
      `route: ${ctx.route}`,
      ``,
      `--- persona & hard constraints ---`,
      ...personaLines,
      ``,
      `--- environmental focus ---`,
      ...focusLines,
      ``,
      `--- library history (last 5 rated / "read") ---`,
      ...ratedLines,
      ``,
      `--- want to read (up to 8) ---`,
      ...wantLines,
      ``,
      `--- library roster (for ENHANCED_BOOK_CARD ids) ---`,
      ...rosterLines,
      ``,
      `--- daily picks on screen ---`,
      ...(pickLines.length ? pickLines : ["(none)"]),
      ``,
      `--- pinned to Bianca ---`,
      ...(pinnedLines.length ? pinnedLines : ["(none)"]),
      ``,
      `--- rejected (never recommend as a daily pick) ---`,
      ...(rejectedPickLines.length ? rejectedPickLines : ["(none)"]),
      ``,
      `--- compare slots ---`,
      ...(compareLines.length ? compareLines : ["(none)"]),
      ``,
      `--- library stats ---`,
      ...libLines,
      ``,
      `--- terminal view ---`,
      ...terminalContextLines()
    ].join("\n");
  }

  // Snapshot the Lumen Terminal's local view filters + selection so
  // Bianca can answer questions like "what am I filtering?" and "why
  // is this title in front of me?" without re-querying the engine.
  // Returns `(none)` lines when the Terminal module hasn't booted.
  function terminalContextLines() {
    const T = window.LumenTerminal;
    if (!T || !T._state) return ["(terminal not initialised)"];
    const st = T._state;
    const lines = [];
    lines.push(`sortKey: ${st.sortKey} ${st.sortDir}`);
    if (st.search) lines.push(`search: "${st.search}"`);
    if (st.subgenreFilter) lines.push(`subgenre filter: ${st.subgenreFilter}`);
    if (st.toneFilter && st.toneFilter.size) lines.push(`tone filter: ${[...st.toneFilter].join(", ")}`);
    if (st.dynFilter && st.dynFilter.size)   lines.push(`dynamic filter: ${[...st.dynFilter].join(", ")}`);
    if (st.selectedId) {
      try {
        const b = findBook(st.selectedId);
        if (b) lines.push(`selected: ${b.title} (id=${b.id})`);
      } catch (e) { /* ignore */ }
    }
    if (lines.length === 1 && !st.selectedId) lines.push("(no view filters active)");
    return lines;
  }

  function computeBiancaContext(routeId) {
    const ctx = buildBiancaContext(routeId);
    // Chips preserved for the top strip.
    const chips = [];
    const routeLabel = {
      discover: "Today", library: "Library", discovery: "Discovery",
      compare: "Compare", chat: "Connections", journal: "Journal",
      vault: "Vault", profile: "Profile", settings: "Admin",
      transparency: "Transparency"
    }[routeId] || routeId;
    chips.push({ label: routeLabel });
    if (ctx.focus.book) chips.push({ label: ctx.focus.book.title });
    if (ctx.discovery.lastQuery) chips.push({ label: `Search: "${ctx.discovery.lastQuery}"` });
    if (routeId === "profile") {
      chips.push({ label: `Heat ${ctx.user.profile.heat}/5` });
      chips.push({ label: `Consent ${ctx.user.profile.consent}/5` });
    }
    if (routeId === "compare" && ctx.compare.slots.some(Boolean)) {
      ctx.compare.slots.filter(Boolean).forEach(s2 => chips.push({ label: s2.title }));
    }
    ctx.chips = chips;
    // Legacy fields preserved.
    ctx.book = ctx.focus.book ? ctx.focus.book.id : null;
    ctx.compareSlots = ctx.compare.slots.filter(Boolean).map(x => x.title);
    ctx.journalEntryId = ctx.focus.journalEntryId;
    return ctx;
  }

  // ============================================================
  // Bianca intent registry — replaces the old regex-chain
  // responder. Each intent has a match predicate and a handler
  // that composes a reply from the structured context. The
  // first intent that wants the message handles it; a default
  // fallback is always last.
  // ============================================================
  const SARA_INTENTS = [
    {
      id: "greeting",
      match: (t) => /^\s*(hi|hello|hey|good\s*(morning|evening|afternoon))\b/i.test(t),
      handler: () => `Hi. I'm here — ask what to read tonight, why a book landed where it did, or how to compare three titles.`
    },
    {
      id: "library-count",
      match: (t) => /how many (books|titles|things)/i.test(t) || /\b(size of|count of) (my )?library\b/i.test(t),
      handler: (ctx) => {
        const { library } = ctx;
        const parts = [`You have **${library.visibleTotal}** book${library.visibleTotal === 1 ? "" : "s"} in your Library.`];
        if (library.curatedCount) parts.push(`${library.curatedCount} come from the curated catalog`);
        if (library.discoveredCount) parts.push(`${library.discoveredCount} you added from Discovery`);
        if (library.seedCount) parts.push(`${library.seedCount} are from the starter library`);
        if (library.hiddenCount) parts.push(`${library.hiddenCount} are currently hidden`);
        return parts.join(library.visibleTotal ? " · " : "") + ".";
      }
    },
    {
      id: "daily-picks-explain",
      match: (t) => /\b(daily pick|picks? for today|top 3|top three|why.*picked?|why.*recommended)\b/i.test(t),
      handler: (ctx) => {
        const picks = ctx.dailyPicks || [];
        if (!picks.length) return `There's nothing to pick from — your filters are excluding everything, or the library is empty. Load a catalog or loosen your exclusions in Profile.`;
        const list = picks.map((p, i) => `${i + 1}. **${p.title}** by ${p.author} · fit ${p.fitScore}${p.confidence ? ` · ${p.confidence}% conf` : ""}${p.warnings.length ? ` · ${p.warnings.length} warning${p.warnings.length === 1 ? "" : "s"}` : ""}`).join("\n");
        const rejected = ctx.dailyPicksRejected || [];
        const footer = rejected.length ? `\n\n(${rejected.length} pick${rejected.length === 1 ? "" : "s"} hidden because you said "not for me" — manage those in Settings.)` : "";
        return `Your current picks:\n\n${list}\n\nThey're the top three eligible matches against your profile, in descending fit order.${footer}`;
      }
    },
    {
      id: "swap-pick",
      match: (t) => /\b(swap|replace|another)\b.*(pick|one|book)|\bnext eligible\b/i.test(t),
      handler: (ctx) => {
        if (!ctx.dailyPicks.length) return `No picks to swap — nothing matches right now.`;
        const target = ctx.focus.book && ctx.dailyPicks.find(p => p.id === ctx.focus.book.id);
        const hint = target ? target.title : ctx.dailyPicks[ctx.dailyPicks.length - 1].title;
        return `Hit **Not for me** on the card you want gone — I'll swap in the next best eligible book and remember not to show *${hint}* again unless you restore it from Settings.`;
      }
    },
    {
      id: "why-focus-book",
      match: (t, ctx) => ctx.focus.book && /\bwhy (this|that|it)|fit|score\b/i.test(t),
      handler: (ctx) => {
        const f = ctx.focus.book;
        return `**${f.title}** lands at fit ${f.fitScore}. Heat ${f.heat}/5, reading state: ${f.readingState}. ${f.warnings.length ? `Flagged with: ${f.warnings.slice(0, 3).map(w => w.replace(/-/g, " ")).join(", ")}.` : "No content warnings."}`;
      }
    },
    {
      id: "recommend",
      match: (t) => /\b(recommend|suggest|what should|mood|tonight|pick something)\b/i.test(t),
      handler: (ctx) => {
        const picks = ctx.dailyPicks || [];
        if (!picks.length) return `I can't recommend against an empty pool — loosen exclusions or load the catalog.`;
        const top = picks[0];
        return `Tonight I'd reach for **${top.title}** — fit ${top.fitScore}${top.confidence ? `, ${top.confidence}% confidence` : ""}${(top.reasons[0] ? `. ${top.reasons[0]}` : "")}. Tell me your mood and I'll narrow further.`;
      }
    },
    {
      id: "compare",
      match: (t) => /\b(compare|difference|differs|versus|vs\.?|tradeoff)\b/i.test(t),
      handler: (ctx) => {
        const filled = (ctx.compare.slots || []).filter(Boolean);
        if (filled.length >= 2) return `You have ${filled.length} title${filled.length === 1 ? "" : "s"} in Compare: ${filled.map(x => `**${x.title}** (fit ${x.fit})`).join(" · ")}. Hit **Run analysis** for the full tradeoff matrix.`;
        return `Open Compare and pick two or three titles — I'll lay out scores, category bars, and a plain-language verdict.`;
      }
    },
    {
      id: "warnings",
      match: (t) => /\b(warning|trigger|content|safe|safety)\b/i.test(t),
      handler: (ctx) => {
        const cc = ctx.contentControls;
        const parts = [`Warning strictness is set to **${cc.warnStrict}** on your profile.`];
        if (cc.exclusionsCount) parts.push(`${cc.exclusionsCount} hard exclusion${cc.exclusionsCount === 1 ? "" : "s"} are active: ${cc.hardExclusions.slice(0, 4).map(w => w.replace(/-/g, " ")).join(", ")}${cc.exclusionsCount > 4 ? "…" : ""}`);
        parts.push(`Books carrying your hard-excluded warnings are removed from every ranking — absolute, not weighted.`);
        return parts.join(" ");
      }
    },
    {
      id: "profile-explain",
      match: (t) => /\bmy (profile|settings|sliders|preferences)\b/i.test(t),
      handler: (ctx) => {
        const p = ctx.user.profile;
        return `Your profile: heat **${p.heat}/5**, explicit **${p.explicit}/5**, emotion **${p.emotion}/5**, consent floor **${p.consent}/5**, taboo **${p.taboo}/5**, plot weight **${p.plot}/5**. Strictness: **${ctx.contentControls.warnStrict}**. Catalog has ${ctx.library.curatedCount} curated titles + ${ctx.library.discoveredCount} you added, for ${ctx.library.visibleTotal} visible in total. Average fit across your library: ${ctx.library.averageFit}.`;
      }
    },
    {
      id: "catalog-state",
      match: (t) => /\b(catalog|corpus|import|100 books?)\b/i.test(t),
      handler: (ctx) => {
        const c = ctx.catalog;
        if (!c.loaded) return `No catalog is loaded yet. Settings → Curated catalog has the importer — paste a title list, or upload a CSV, and Claude fills the rest.`;
        return `Catalog: **${c.count}** book${c.count === 1 ? "" : "s"} loaded${c.overrideActive ? " (device-local override active)" : " from the committed file"}. Schema version ${c.version}.`;
      }
    },
    {
      id: "save-focus",
      match: (t, ctx) => ctx.focus.book && /\b(save|add|want|pin)\b/i.test(t),
      handler: (ctx) => `**${ctx.focus.book.title}** is already in your library. Use **Pin to Vault** on the detail sheet to keep it for quick access, or **Share with Bianca** to pin it here.`
    },
    {
      id: "dismiss-focus",
      match: (t, ctx) => ctx.focus.book && /\b(dismiss|not for me|hide|remove)\b/i.test(t),
      handler: (ctx) => `Use **× Not for me** on a Daily Pick to skip it just from picks, or the × on a Library card to dismiss the book entirely. Either is reversible from Settings.`
    },
    {
      id: "vault",
      match: (t) => /\b(vault|pinned|pins?)\b/i.test(t),
      handler: (ctx) => `Vault has **${ctx.vault.pinnedCount}** pinned book${ctx.vault.pinnedCount === 1 ? "" : "s"} and **${ctx.vault.analysesCount}** saved analys${ctx.vault.analysesCount === 1 ? "is" : "es"}. ${ctx.vault.locked ? "It's currently locked by passcode." : "It's unlocked."}`
    },
    {
      id: "privacy",
      match: (t) => /\b(private|privacy|leave|server|cloud|sync)\b/i.test(t),
      handler: () => `Nothing you enter leaves this device. No server, no account, no telemetry. Discreet mode in the top bar blurs covers and titles if someone might be watching.`
    },
    {
      id: "how-scored",
      match: (t) => /\b(how .* score|why .* score|explain .* score|scoring|algorithm)\b/i.test(t),
      handler: () => `Each book is scored across six numeric dimensions (heat, explicit, emotion, consent, taboo, plot) and seven tag overlaps (tone, pacing, style, dynamic, tropes, kink, orientation), each with an adjustable weight. Result is 0–100 fit plus a confidence score based on metadata coverage.`
    },
    {
      id: "journal",
      match: (t) => /\b(journal|reflect|prompt|entry)\b/i.test(t),
      handler: (ctx) => ctx.journal.entriesCount
        ? `You have ${ctx.journal.entriesCount} journal ${ctx.journal.entriesCount === 1 ? "entry" : "entries"}${ctx.journal.lastTitle ? `, most recent "${ctx.journal.lastTitle}"` : ""}. Want a reflection prompt for tonight's read?`
        : `No journal entries yet. Open Journal and I can suggest a reflection prompt for whatever you're reading.`
    },
    {
      id: "navigate",
      match: (t) => /\b(open|go to|take me to|show me) (library|discover|discovery|compare|journal|vault|profile|settings|transparency)\b/i.test(t),
      handler: (ctx, text) => {
        const m = text.match(/(library|discover|discovery|compare|journal|vault|profile|settings|transparency)/i);
        if (m) {
          const route = m[1].toLowerCase();
          setTimeout(() => router.go(route), 200);
          return `Heading to ${route}.`;
        }
        return "";
      }
    }
  ];

  function saraRespond(userText, biancaCtx) {
    const text = String(userText || "");
    const ctx = biancaCtx && biancaCtx.library ? biancaCtx : buildBiancaContext(biancaCtx && biancaCtx.route);
    for (const intent of SARA_INTENTS) {
      try {
        const hit = intent.match(text, ctx);
        if (hit) {
          const reply = intent.handler(ctx, text);
          if (reply && reply.length) return reply;
        }
      } catch (e) { /* intent errors should not break the chain */ }
    }
    // Fallback — supportive, offers routes into the real capabilities.
    const top = (ctx.dailyPicks || [])[0];
    const lines = [];
    if (top) lines.push(`Tonight's top pick is **${top.title}** (fit ${top.fitScore}) — shall I tell you why?`);
    else     lines.push(`I'm here. Ask for a recommendation, a comparison, or how something was scored.`);
    return lines.join(" ");
  }

  function appendChatMessage(threadKey, friendId, role, text) {
    store.update(s => {
      if (threadKey === "bianca") {
        s.chats.bianca.push({ id: util.id("m"), role, text, ts: Date.now() });
      } else {
        const f = s.chats.friends.find(x => x.id === friendId);
        if (f) f.messages.push({ id: util.id("m"), role, text, ts: Date.now() });
      }
    });
  }

  function ensureSeedBianca() {
    const s = store.get();
    if (s.chats.bianca.length === 0) {
      appendChatMessage("bianca", null, "bianca",
        `Hi — I'm Bianca. I'm a reading companion, not a recommender. Ask me what to read tonight, to compare three titles, or to help you journal a reaction. Everything here is private.`);
    }
  }

  function renderChat() {
    ensureSeedBianca();
    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Connections" }),
        util.el("h1", { html: "Your private <em>social</em> layer" }),
        util.el("p", { class: "lede", text: "Bianca lives in the floating panel across every tab — this page is the place to review history and manage friends you share titles with. Everything is local." })
      ])
    ]));

    // Bianca summary card
    const biancaMsgs = store.get().chats.bianca || [];
    const lastMsg = biancaMsgs[biancaMsgs.length - 1];
    const saraCard = util.el("div", { class: "card" });
    saraCard.appendChild(util.el("div", { class: "card-head" }, [
      util.el("h3", { text: "Bianca · conversation history" }),
      util.el("div", { class: "row" }, [
        util.el("button", { class: "btn btn-sm btn-primary", onclick: () => window.LumenBianca && window.LumenBianca.open() }, "Open Bianca"),
        util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => {
          ui.modal({
            title: "Clear Bianca's memory?",
            body: "<p class=\"t-muted\">Deletes every message between you and Bianca on this device. A fresh greeting will replace it.</p>",
            primary: { label: "Clear", onClick: () => {
              store.update(s => { s.chats.bianca = []; });
              ensureSeedBianca();
              ui.toast("Bianca's memory cleared");
              renderView();
            }},
            secondary: { label: "Cancel" }
          });
        }}, "Clear history")
      ])
    ]));
    saraCard.appendChild(util.el("div", { class: "t-small t-muted", style: { marginTop: "var(--s-2)" },
      text: `${biancaMsgs.length} message${biancaMsgs.length === 1 ? "" : "s"} stored locally${lastMsg ? " · last: " + new Date(lastMsg.ts).toLocaleString() : ""}` }));

    if (biancaMsgs.length > 1) {
      const transcript = util.el("div", { class: "stack-sm", style: { marginTop: "var(--s-4)", maxHeight: "320px", overflowY: "auto", padding: "var(--s-3)", background: "var(--bg-sunken)", borderRadius: "var(--r-2)", border: "1px solid var(--border)" } });
      biancaMsgs.slice(-10).forEach(m => {
        transcript.appendChild(util.el("div", { style: { padding: "6px 0", borderBottom: "1px dashed var(--border)" } }, [
          util.el("div", { class: "t-tiny t-subtle", text: `${m.role === "user" ? "You" : "Bianca"} · ${new Date(m.ts).toLocaleTimeString()}` }),
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
              chatState.active = "bianca"; chatState.friendId = null;
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
    const saved = listSavedBooks();
    const used = cmpState.slots.filter(Boolean);
    const body = util.el("div", { class: "stack" });

    if (!saved.length) {
      body.appendChild(util.el("p", { class: "t-muted t-small", text: "Compare only works on titles you've saved to your Library. Nothing is saved yet — add books from Discovery or load the starter library in Settings." }));
      ui.modal({
        title: `Slot ${slotIdx + 1}`,
        body,
        primary:   { label: "Open Discovery", onClick: () => router.go("discovery") },
        secondary: { label: "Open Settings",   onClick: () => router.go("settings") }
      });
      return;
    }

    const availableCount = saved.filter(b => !used.includes(b.id)).length;
    body.appendChild(util.el("p", { class: "t-muted t-small", text: availableCount
      ? `Pick any title saved in your Library. ${availableCount} available, ${saved.length} saved in total.`
      : "You've already placed every saved title into a slot. Remove one, or save more from Discovery." }));

    const search = util.el("input", { class: "input", placeholder: "Search your library…", autofocus: true });
    body.appendChild(search);
    const list = util.el("div", { class: "stack-sm", style: { maxHeight: "320px", overflowY: "auto", marginTop: "var(--s-2)" } });
    body.appendChild(list);

    const handle = ui.modal({ title: `Add a saved title to slot ${slotIdx + 1}`, body, secondary: { label: "Cancel" } });

    function paint() {
      const q = (search.value || "").toLowerCase();
      list.innerHTML = "";
      const candidates = saved
        .filter(b => !used.includes(b.id))
        .filter(b => !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));

      if (!candidates.length) {
        list.appendChild(util.el("p", { class: "t-small t-subtle", style: { padding: "var(--s-3)" }, text: q ? "No saved titles match that search." : "No saved titles left to place. Remove a slot, or save more titles from Discovery." }));
        return;
      }
      candidates.forEach(b => {
        const row = util.el("button", { class: "btn btn-ghost", style: { justifyContent: "flex-start", textAlign: "left", width: "100%", padding: "10px 12px" },
          onclick: () => {
            cmpState.slots[slotIdx] = b.id;
            cmpState.lastDeepAnalysis = null;
            handle.close();
            renderView();
          }
        }, [
          util.el("div", {}, [
            util.el("div", { class: "t-serif", style: { fontSize: "14px" }, text: b.title }),
            util.el("div", { class: "t-tiny t-subtle", text: `${b.author}${b.year ? " · " + util.fmtYear(b.year) : ""}${b._catalog ? " · curated" : b._seed ? " · from starter library" : b._discovered ? " · from Discovery" : ""}` })
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
    const savedIds = new Set(listSavedBooks().map(b => b.id));

    // Reconcile: any slot pointing at a book that's no longer saved
    // (book dismissed from Library, starter library removed, etc.) is
    // cleared and a stale deep analysis is invalidated with it.
    let reconciled = false;
    cmpState.slots = cmpState.slots.map(id => {
      if (id && !savedIds.has(id)) { reconciled = true; return null; }
      return id;
    });
    if (reconciled) cmpState.lastDeepAnalysis = null;

    // Seed from Library deep-link (only accept if the book is actually saved)
    const seed = sessionStorage.getItem("lumen:compare-seed");
    if (seed && savedIds.has(seed)) {
      if (!cmpState.slots.includes(seed)) {
        const emptyIdx = cmpState.slots.findIndex(x => !x);
        if (emptyIdx !== -1) cmpState.slots[emptyIdx] = seed;
        else cmpState.slots[0] = seed;
      }
    }
    if (seed) sessionStorage.removeItem("lumen:compare-seed");

    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Compare · from your library" }),
        util.el("h1", { html: "<em>Lineup</em>" }),
        util.el("p", { class: "lede", text: savedIds.size
          ? `Compare up to three titles you've saved. Only books in your Library can be placed in slots — ${savedIds.size} available. Adjust your profile to change the scores.`
          : "Compare works from titles you've saved to your Library. Add books from Discovery, or load the starter library in Settings, then come back." })
      ])
    ]));

    // Slot row
    const slotsCard = util.el("div", { class: "card", style: { padding: "var(--s-4)" } });
    const slots = util.el("div", { class: "cmp-slots" });
    cmpState.slots.forEach((id, idx) => {
      const b = id ? findBook(id) : null;
      if (b) {
        const filled = util.el("div", { class: "cmp-slot filled" });

        // Cover column. Mirror the Library tile's approach (see
        // bookCardFull's .lib-card-cover block): render b.thumbnail
        // directly, fall back to an initials block on load error or
        // when the loaded image is Google's "Image not available"
        // placeholder. No on-the-fly Google lookup here — that path
        // kept caching the placeholder URL and re-rendering it.
        const initials = (b.title || "??").slice(0, 2).toUpperCase();
        const placeholder = util.el("div", {
          class: "cmp-slot-cover cmp-slot-cover-fallback"
        }, initials);
        const showFallback = () => {
          if (!filled.querySelector(".cmp-slot-cover")) {
            filled.insertBefore(placeholder, filled.firstChild);
          }
        };
        if (b.thumbnail) {
          const url = b.thumbnail.replace(/^http:/, "https:");
          const cover = util.el("img", {
            class: "cmp-slot-cover", src: url, alt: "", loading: "lazy",
            onerror: function () { this.remove(); showFallback(); },
            onload:  function () { if (util.isLikelyNoCover(this)) { this.remove(); showFallback(); } }
          });
          filled.appendChild(cover);
        } else {
          showFallback();
        }
        const body = util.el("div", { class: "cmp-slot-body" });
        body.appendChild(util.el("div", { class: "cmp-slot-idx", text: `Slot ${idx + 1}` }));
        body.appendChild(util.el("div", { class: "cmp-slot-title", text: b.title }));
        body.appendChild(util.el("div", { class: "cmp-slot-author", text: `${b.author} · ${util.fmtYear(b.year)}` }));
        body.appendChild(util.el("div", { class: "row", style: { marginTop: "var(--s-2)" } }, [
          util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => openSlotPicker(idx) }, "Replace"),
          util.el("button", { class: "btn btn-sm btn-ghost", onclick: () => { cmpState.slots[idx] = null; cmpState.lastDeepAnalysis = null; renderView(); } }, "Remove")
        ]));
        filled.appendChild(body);
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
      if (!savedIds.size) {
        body.appendChild(ui.empty({
          title: "Nothing saved to compare yet",
          message: "Compare draws exclusively from books saved in your Library. Add titles from Discovery or load the starter library in Settings, then come back here.",
          actions: [
            { label: "Open Discovery", variant: "btn-primary", onClick: () => router.go("discovery") },
            { label: "Open Settings",  variant: "btn",         onClick: () => router.go("settings") }
          ]
        }));
        return;
      }
      if (savedIds.size === 1) {
        body.appendChild(ui.empty({
          title: "You need at least two saved titles",
          message: "Compare puts saved titles side by side. Save one more from Discovery and your lineup will unlock.",
          actions: [
            { label: "Open Discovery", variant: "btn-primary", onClick: () => router.go("discovery") }
          ]
        }));
        return;
      }
      if (filled.length === 0) {
        body.appendChild(ui.empty({
          title: "Pick up to three titles from your library",
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
          action: "Open in Bianca",
          onAction: () => openInBianca(cmpState.lastDeepAnalysis),
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
        util.el("button", { class: "btn btn-sm", onclick: () => openInBianca(payload) }, "Open in Bianca"),
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

    // Category winners — compact 2-column grid with inline tier dots.
    // A summary chip up top replaces the two-line descriptive intro.
    // A segmented filter (All / Decisive / Numeric / Tags) collapses
    // the 13-row data dump into the rows that actually matter.
    const winSection = util.el("div", { class: "deep-winners" });
    const winHead = util.el("div", { class: "deep-winners-head" });
    winHead.appendChild(util.el("div", { class: "deep-section-title", text: "Category winners" }));

    // Group categories by tier + by type (numeric vs tag).
    // `deep-win-row` keeps the same data shape the analysis module
    // emits: { category, winner, tier, group? }. We classify group
    // here based on the known CMP_CATEGORIES table.
    const numericKeys = new Set(CMP_CATEGORIES.filter(c => c.group === "numeric").map(c => c.label));
    const rowsWithGroup = payload.categoryWinners.map(w => ({
      ...w,
      group: numericKeys.has(w.category) ? "numeric" : "tag"
    }));
    const decisiveCount = rowsWithGroup.filter(r => r.tier === "decisive").length;
    const clearCount = rowsWithGroup.filter(r => r.tier === "clear").length;
    const tightCount = rowsWithGroup.filter(r => r.tier === "tight").length;

    // Summary chip — one sentence beats two lines of explanatory copy.
    winHead.appendChild(util.el("span", { class: "deep-winners-summary" }, [
      util.el("strong", { text: `${decisiveCount}` }),
      util.el("span", { text: " decisive · " }),
      util.el("strong", { text: `${clearCount}` }),
      util.el("span", { text: " clear · " }),
      util.el("strong", { text: `${tightCount}` }),
      util.el("span", { text: " close" })
    ]));
    winSection.appendChild(winHead);

    // Segmented filter — defaults to "All" but user can isolate
    // numeric-only or tag-only wins, or focus on decisive ones.
    const winFilter = { mode: "all" };
    const FILTERS = [
      { id: "all",      label: "All" },
      { id: "decisive", label: "Decisive" },
      { id: "numeric",  label: "Numeric" },
      { id: "tag",      label: "Tags" }
    ];
    const filterEl = util.el("div", { class: "segmented deep-winners-filter", role: "group", "aria-label": "Filter category winners" });
    FILTERS.forEach(f => {
      const btn = util.el("button", {
        type: "button",
        "aria-pressed": winFilter.mode === f.id ? "true" : "false",
        "data-filter": f.id,
        onclick: () => {
          winFilter.mode = f.id;
          filterEl.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.filter === f.id ? "true" : "false"));
          repaintWinners();
        }
      }, f.label);
      filterEl.appendChild(btn);
    });
    winSection.appendChild(filterEl);

    const winGrid = util.el("div", { class: "deep-winners-grid" });
    winSection.appendChild(winGrid);

    function repaintWinners() {
      winGrid.innerHTML = "";
      const rows = rowsWithGroup.filter(r => {
        if (winFilter.mode === "decisive") return r.tier === "decisive";
        if (winFilter.mode === "numeric")  return r.group === "numeric";
        if (winFilter.mode === "tag")      return r.group === "tag";
        return true;
      });
      if (!rows.length) {
        winGrid.appendChild(util.el("div", { class: "deep-winners-empty t-small t-subtle", text: "No categories match this filter." }));
        return;
      }
      rows.forEach(r => {
        const tierLabel = r.tier === "decisive" ? "Decisive win" : r.tier === "clear" ? "Clear lead" : "Close call";
        winGrid.appendChild(util.el("div", { class: `deep-win-pill tier-${r.tier}`, title: tierLabel }, [
          util.el("span", { class: "deep-win-pill-tier", "aria-label": tierLabel }),
          util.el("span", { class: "deep-win-pill-cat", text: r.category }),
          util.el("span", { class: "deep-win-pill-winner", text: r.winner })
        ]));
      });
    }
    repaintWinners();

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

  function openInBianca(payload) {
    if (!window.LumenBianca) return;
    const titles = payload.titles.join(" · ");
    window.LumenBianca.post(`I just ran a deep analysis on **${titles}**. Here's the headline:\n\n${payload.headline}\n\nAsk me for any part of it — tradeoffs, moods, confidence, or reading order.`);
    window.LumenBianca.setContext({
      route: "compare",
      chips: [{ label: "Deep analysis active" }, ...payload.titles.map(t => ({ label: t }))]
    });
    window.LumenBianca.open();
  }

  /* ==================================================================
     Editorial feature — Batch 4: Today view + generation flow.
     Public entry from the router: renderEditorial(). The old
     renderLegacyHome body below is kept commented for the duration
     of batch 4 so nothing is lost if we need to revert; batch 5
     deletes it outright.
     ================================================================== */
  let editorialLoading = false;

  function editorialRateLimit() {
    const st = store.get();
    const now = Date.now();
    const recent = ((st.editorial && st.editorial.generationsToday) || [])
      .filter(ts => typeof ts === "number" && now - ts < 24 * 60 * 60 * 1000);
    return { count: recent.length, list: recent, allowed: recent.length < 5, unlockAt: recent.length >= 5 ? new Date(recent[0] + 24 * 60 * 60 * 1000) : null };
  }

  function editorialBooksFor(pick) {
    const byId = new Map((pick.books || []).map(p => [p.bookId, p.summary]));
    const books = [];
    byId.forEach((_summary, id) => { const b = findBook(id); if (b) books.push(b); });
    return { books, byId };
  }

  function editorialFavorites() {
    const st = store.get();
    const favs = st.favorites || {};
    return Object.entries(favs)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .map(([id]) => findBook(id)).filter(Boolean).slice(0, 8);
  }

  function editorialRecentReads() {
    const st = store.get();
    const states = st.bookStates || {};
    // Heuristic: books currently marked "reading" or most recently added.
    const reading = Object.entries(states).filter(([, v]) => v === "reading" || v === "read").map(([id]) => id);
    const recent = (st.discovered || []).slice(0, 10).map(d => d.id);
    const seen = new Set();
    const merged = reading.concat(recent).filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
    return merged.map(id => findBook(id)).filter(Boolean).slice(0, 5);
  }

  async function generateEditorialPick() {
    const rl = editorialRateLimit();
    if (!rl.allowed) {
      store.update(s => { s.editorial.lastError = { at: Date.now(), code: "rate-limit",
        message: `Regeneration unlocks at ${rl.unlockAt.toLocaleTimeString()}` }; });
      renderView();
      return;
    }
    if (!window.LumenEditorial || typeof window.LumenEditorial.generate !== "function") {
      store.update(s => { s.editorial.lastError = { at: Date.now(), code: "unknown", message: "Editorial module missing" }; });
      renderView();
      return;
    }
    const st = store.get();
    const hidden = st.hidden || {};
    const pool = listAllBooks().filter(b => !hidden[b.id]);
    const coldStart = pool.length < 5;
    const candidates = selectEditorialCandidates(st.profile, pool, { pickCount: 3, topN: 20 });
    const angle = chooseEditorialAngle();
    const favorites = editorialFavorites();
    const recentReads = editorialRecentReads();

    editorialLoading = true;
    // Clear any previous error so the skeleton view isn't shadowed by it.
    store.update(s => { s.editorial.lastError = null; });
    renderView();

    try {
      const out = await window.LumenEditorial.generate({
        profile: st.profile, candidates, angle, favorites, recentReads, coldStart
      });
      const pick = {
        id: "ed_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        generatedAt: Date.now(),
        angle, anglePrompt: angle.label,
        books: out.picks.map(p => ({ bookId: p.bookId, summary: p.summary })),
        angleStatement: out.angleStatement
      };
      store.update(s => {
        s.editorial = s.editorial || {};
        if (s.editorial.currentPick) {
          s.editorial.history = [s.editorial.currentPick].concat(s.editorial.history || []).slice(0, 10);
        }
        s.editorial.currentPick = pick;
        s.editorial.generationsToday = ((s.editorial.generationsToday || []).concat(Date.now()))
          .filter(ts => Date.now() - ts < 24 * 60 * 60 * 1000);
        s.editorial.lastError = null;
      });
    } catch (e) {
      // Failure does NOT consume the rate limit (per spec).
      store.update(s => { s.editorial.lastError = { at: Date.now(), code: (e && e.code) || "unknown",
        message: (e && e.message) || "Generation failed" }; });
    } finally {
      editorialLoading = false;
      renderView();
    }
  }

  function editorialHumanAgo(ts) {
    const d = Math.max(0, Date.now() - ts);
    const mins = Math.round(d / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
    const days = Math.round(hrs / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function editorialBookBlock(book, summary, pick) {
    const card = util.el("div", { class: "card editorial-block" });
    const row = util.el("div", { class: "editorial-block-row" });
    const coverWrap = util.el("div", { class: "editorial-block-cover", onclick: () => openBookDetail(book.id) });
    coverWrap.appendChild(buildCoverBlock(book, { size: "lg", showHeat: true }));
    row.appendChild(coverWrap);

    const body = util.el("div", { class: "editorial-block-body" });
    body.appendChild(util.el("div", { class: "t-eyebrow", text: util.humanise(book.subgenre || book.category || "book") }));
    body.appendChild(util.el("h3", { class: "editorial-block-title", onclick: () => openBookDetail(book.id), text: book.title }));
    body.appendChild(util.el("div", { class: "editorial-block-meta", text: `${book.author} · ${util.fmtYear(book.year)}` }));
    body.appendChild(util.el("p", { class: "editorial-block-summary", text: summary }));

    // Up to 4 tags — subgenre first, then top tropes.
    const tags = [];
    if (book.subgenre) tags.push(book.subgenre);
    (book.trope_tags || book.trope || []).slice(0, 4 - tags.length).forEach(t => tags.push(t));
    if (tags.length) {
      const tagRow = util.el("div", { class: "row-wrap editorial-block-tags" });
      tags.slice(0, 4).forEach(t => tagRow.appendChild(ui.tag(t)));
      body.appendChild(tagRow);
    }

    // Action row — reading state tells us whether it's "in" or "add".
    const rs = getReadingState(book.id);
    const inLibrary = rs && rs !== "none";
    const actions = util.el("div", { class: "row", style: { gap: "var(--s-2)", marginTop: "var(--s-3)" } });
    if (inLibrary) {
      actions.appendChild(util.el("button", { class: "btn btn-sm", onclick: () => openBookDetail(book.id) }, "Open"));
    } else {
      actions.appendChild(util.el("button", { class: "btn btn-sm btn-primary", onclick: () => { setReadingState(book.id, "want"); renderView(); } }, "Add to your library"));
    }
    body.appendChild(actions);

    row.appendChild(body);
    card.appendChild(row);
    return card;
  }

  function renderEditorial() {
    const s = store.get();
    const ed = s.editorial || {};
    const wrap = util.el("div", { class: "page stack-lg" });
    wrap.appendChild(util.el("div", { class: "page-head" }, [
      util.el("div", {}, [
        util.el("div", { class: "t-eyebrow", text: "Today" }),
        util.el("h1", { html: ed.currentPick && ed.currentPick.angleStatement
          ? `<em>${String(ed.currentPick.angleStatement).replace(/[<>]/g, "")}</em>`
          : "Three books, chosen and <em>written</em> for you." })
      ])
    ]));

    // --- Loading state --------------------------------------------------
    if (editorialLoading) {
      const wait = util.el("div", { class: "card", style: { textAlign: "center", padding: "var(--s-6)" } });
      wait.appendChild(util.el("div", { class: "t-serif", style: { fontStyle: "italic", fontSize: "18px" }, text: "Writing your editorial…" }));
      wait.appendChild(util.el("p", { class: "t-muted", style: { marginTop: "var(--s-3)" }, text: "This usually takes 15–25 seconds." }));
      wrap.appendChild(wait);
      for (let i = 0; i < 3; i++) {
        wrap.appendChild(util.el("div", { class: "card editorial-block editorial-skeleton" }, [
          util.el("div", { class: "editorial-block-row" }, [
            util.el("div", { class: "editorial-block-cover skel-box" }),
            util.el("div", { class: "editorial-block-body" }, [
              util.el("div", { class: "skel-line skel-line-sm" }),
              util.el("div", { class: "skel-line skel-line-lg" }),
              util.el("div", { class: "skel-line" }),
              util.el("div", { class: "skel-line" }),
              util.el("div", { class: "skel-line" }),
              util.el("div", { class: "skel-line skel-line-sm" })
            ])
          ])
        ]));
      }
      return wrap;
    }

    // --- Empty state ----------------------------------------------------
    if (!ed.currentPick) {
      const empty = util.el("div", { class: "card", style: { textAlign: "center", padding: "var(--s-7) var(--s-5)" } });
      empty.appendChild(util.el("p", { class: "lede", style: { marginBottom: "var(--s-5)" }, text: "Three books, chosen and written for you. Different every time." }));
      empty.appendChild(util.el("button", {
        class: "btn btn-primary", style: { fontSize: "16px", padding: "var(--s-3) var(--s-5)" },
        onclick: () => generateEditorialPick()
      }, "Generate"));
      empty.appendChild(util.el("p", { class: "t-small t-muted", style: { marginTop: "var(--s-4)" }, text: "Uses your profile, your library, and what you've been reading." }));
      const showErr = ed.lastError && !(ed.lastError.code === "no-key");
      if (showErr) {
        empty.appendChild(util.el("p", { class: "t-small", style: { color: "var(--danger)", marginTop: "var(--s-3)" }, text: ed.lastError.message || "Claude didn't respond — try again?" }));
      }
      wrap.appendChild(empty);
      return wrap;
    }

    // --- Loaded state ---------------------------------------------------
    const pick = ed.currentPick;
    const sub = util.el("div", { class: "row-wrap t-small t-subtle", style: { marginTop: "var(--s-2)" } });
    sub.appendChild(util.el("span", { text: `Generated ${editorialHumanAgo(pick.generatedAt)}` }));
    sub.appendChild(util.el("span", { class: "tag tag-accent", text: (pick.angle && pick.angle.id) || "editorial" }));
    wrap.appendChild(sub);

    const { byId } = editorialBooksFor(pick);
    pick.books.forEach(p => {
      const b = findBook(p.bookId);
      if (!b) return;
      wrap.appendChild(editorialBookBlock(b, byId.get(p.bookId) || p.summary, pick));
    });

    // Footer: Regenerate + transparency note.
    const librarySize = listAllBooks().filter(b => !(s.hidden || {})[b.id]).length;
    const rl = editorialRateLimit();
    const footer = util.el("div", { class: "row-wrap", style: { justifyContent: "space-between", alignItems: "center", marginTop: "var(--s-5)" } });
    const regenBtn = util.el("button", {
      class: "btn btn-primary",
      disabled: rl.allowed ? null : true,
      title: rl.allowed ? "" : `Regeneration unlocks at ${rl.unlockAt.toLocaleTimeString()}`,
      onclick: () => generateEditorialPick()
    }, "Regenerate");
    footer.appendChild(regenBtn);
    footer.appendChild(util.el("p", { class: "t-small t-muted", style: { margin: 0 }, text: `Based on your ${librarySize} saved book${librarySize === 1 ? "" : "s"}, your profile, and your recent favorites.` }));
    wrap.appendChild(footer);

    if (ed.lastError && !(ed.lastError.code === "no-key")) {
      wrap.appendChild(util.el("p", { class: "t-small", style: { color: "var(--danger)", marginTop: "var(--s-3)" }, text: ed.lastError.message || "Claude didn't respond — try again?" }));
    }
    return wrap;
  }

  /* -------------------- views -------------------- */
  const views = {
    discover() {
      return renderEditorial();
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
      const wrap = util.el("div", { class: "page profile-page stack-lg" });

      // Compact inline strictness control — small segmented pill that
      // sits in the page-head alongside Re-run onboarding. Replaces the
      // full-width Content Controls bar that previously spanned the
      // page.
      const strictControl = util.el("div", { class: "profile-strict-inline" });
      strictControl.appendChild(util.el("span", { class: "profile-strict-label", text: "Strictness" }));
      strictControl.appendChild(segmented("warnStrict", [
        { label: "Lenient",  value: "permissive" },
        { label: "Moderate", value: "moderate" },
        { label: "Strict",   value: "strict" }
      ]));

      wrap.appendChild(util.el("div", { class: "page-head" }, [
        util.el("div", {}, [
          util.el("h1", { html: "Tell us how <em>you</em> read." }),
          util.el("p", { class: "lede", text: "Every field feeds the weighted fit score. Leave any at default if you have no preference — the engine will treat it neutrally. Changes apply instantly across the dashboard." })
        ]),
        util.el("div", { class: "row profile-head-actions" }, [
          strictControl,
          util.el("button", { class: "btn btn-small", onclick: () => launchOnboarding(true) }, "Re-run onboarding")
        ])
      ]));

      const col = util.el("div", { class: "stack-lg" });

      // --- Sliders (two-column pairing matching the mockup) ---------------
      const slidersCard = util.el("div", { class: "card profile-sliders" });
      const slidersGrid = util.el("div", { class: "profile-slider-grid" });

      const leftCol = util.el("div", { class: "stack-lg" }, [
        numericSlider("heat",    "Desired heat level",  "1 = implied, 5 = intense throughout",                        "temperature"),
        numericSlider("emotion", "Emotional intensity", "From playful & light to intense & consuming",                 "weight of feeling"),
        numericSlider("taboo",   "Taboo tolerance",     "Willingness to engage with transgressive themes",             "transgression"),
        chipGroup("tone", "Preferred tone", VOCAB.tone, { ornament: "voice" })
      ]);
      const rightCol = util.el("div", { class: "stack-lg" }, [
        numericSlider("explicit", "Explicitness preference", "How direct vs. veiled the prose should be",                              "directness"),
        numericSlider("consent",  "Consent clarity floor",   "5 = on-page, unambiguous; lower tolerates period-typical framing",       "non-negotiable"),
        numericSlider("plot",     "Plot vs scene weighting", "1 = scene-heavy, 5 = strong narrative architecture",                     "architecture"),
        chipGroup("pacing", "Preferred pacing", VOCAB.pacing, { ornament: "rhythm" })
      ]);
      slidersGrid.appendChild(leftCol);
      slidersGrid.appendChild(rightCol);
      slidersCard.appendChild(slidersGrid);
      col.appendChild(slidersCard);

      // --- Tastes (literary style + relationship dynamics + tropes + themes) ---
      const tastesCard = util.el("div", { class: "card stack-lg" });
      tastesCard.appendChild(util.el("div", { class: "profile-two-col" }, [
        chipGroup("style",   "Literary style",      VOCAB.style),
        chipGroup("dynamic", "Relationship dynamics", VOCAB.dynamic)
      ]));
      tastesCard.appendChild(chipGroup("trope", "Tropes of interest", VOCAB.trope, { ornament: "tap to choose" }));
      tastesCard.appendChild(chipGroup("kink",  "Themes & kink tags", VOCAB.kink));
      tastesCard.appendChild(chipGroup("orientation", "Gender pairing / orientation", VOCAB.orientation));
      col.appendChild(tastesCard);

      // --- Hard exclusions ------------------------------------------------
      const excludeCard = util.el("div", { class: "card" });
      excludeCard.appendChild(buildFieldLabel("Hard exclusions — never show", "firm boundaries"));
      excludeCard.appendChild(util.el("div", { class: "row-wrap", style: { marginTop: "var(--s-3)" } },
        ALL_WARNINGS.map(w => ui.chip(w, {
          pressed: store.get().profile.exclude.includes(w),
          exclude: true,
          onToggle: (on) => {
            store.update(s2 => {
              const list = s2.profile.exclude;
              if (on && !list.includes(w)) list.push(w);
              else if (!on) s2.profile.exclude = list.filter(x => x !== w);
            });
            refreshProfilePreview();
          }
        }))
      ));
      excludeCard.appendChild(util.el("p", { class: "field-help", style: { marginTop: "var(--s-3)" }, text: "Any book tagged with these is removed entirely" }));
      col.appendChild(excludeCard);

      // --- Companion preferences (Bianca) ------------------------------------
      // How Bianca tailors her tone and what she filters out of her
      // replies. Hard constraint: spoilers. Soft constraints:
      // reading level, format preference.
      const companionCard = util.el("div", { class: "card stack" });
      companionCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { html: "Companion <em>preferences</em>" }),
        util.el("span", { class: "card-sub t-subtle", text: "Bianca reads these on every turn" })
      ]));

      companionCard.appendChild(buildFieldLabel("Reading level", "register"));
      companionCard.appendChild(segmented("readingLevel", [
        { label: "Casual",   value: "casual" },
        { label: "Literary", value: "literary" },
        { label: "Academic", value: "academic" }
      ]));
      companionCard.appendChild(util.el("p", { class: "field-help", text: "Guides Bianca's vocabulary and sentence rhythm. Casual = a friend over coffee; Academic = a seminar aside." }));

      companionCard.appendChild(buildFieldLabel("Format preference", "medium"));
      companionCard.appendChild(segmented("formatPreference", [
        { label: "Any",       value: "any" },
        { label: "Audiobook", value: "audiobook" },
        { label: "Ebook",     value: "ebook" },
        { label: "Hardcover", value: "hardcover" },
        { label: "Paperback", value: "paperback" }
      ]));
      companionCard.appendChild(util.el("p", { class: "field-help", text: "If you pick Audiobook, Bianca leads with narrator quality when she names a book." }));

      const spoilersToggle = util.el("label", { class: "toggle", style: { marginTop: "var(--s-3)" } });
      const spoilerInput = util.el("input", {
        type: "checkbox",
        checked: store.get().profile.spoilersEnabled ? "checked" : null,
        onchange: (e) => {
          const on = !!e.target.checked;
          store.update(s2 => { s2.profile.spoilersEnabled = on; });
          refreshProfilePreview();
        }
      });
      spoilersToggle.appendChild(spoilerInput);
      spoilersToggle.appendChild(util.el("span", { class: "toggle-track" }));
      spoilersToggle.appendChild(util.el("span", { class: "toggle-label", text: "Allow plot spoilers" }));
      companionCard.appendChild(spoilersToggle);
      companionCard.appendChild(util.el("p", { class: "field-help", text: "Off by default — Bianca will name themes and beats but not twists. Flip on if you prefer a full read-out." }));

      col.appendChild(companionCard);

      // --- Quick scenarios ------------------------------------------------
      const scenariosCard = util.el("div", { class: "card" });
      scenariosCard.appendChild(util.el("div", { class: "card-head" }, [
        util.el("h3", { html: "Quick <em>scenarios</em>" }),
        util.el("span", { class: "card-sub t-subtle", text: "Preset profiles — applied to the controls above." })
      ]));
      SCENARIOS.forEach(sc => {
        const row = util.el("div", { class: "row", style: { justifyContent: "space-between", padding: "var(--s-3) 0", borderTop: "1px solid var(--border)", gap: "var(--s-3)" } }, [
          util.el("div", { style: { minWidth: 0 } }, [
            util.el("div", { class: "t-serif", style: { fontSize: "15px" }, text: sc.name }),
            util.el("div", { class: "t-small t-subtle", text: sc.desc })
          ]),
          util.el("button", { class: "btn btn-small", onclick: () => {
            store.update(s => { s.profile = Object.assign(structuredClone(DEFAULT_PROFILE), structuredClone(sc.profile)); s.ui.activeScenarioId = sc.id; });
            ui.toast(`Applied: ${sc.name}`);
            renderView();
          } }, "Apply")
        ]);
        scenariosCard.appendChild(row);
      });
      col.appendChild(scenariosCard);

      wrap.appendChild(col);

      setTimeout(refreshProfilePreview, 0);
      return wrap;
    },

    settings() {
      return renderSettings();
    },

    terminal() {
      // Terminal view lives in terminal.js so the analytics surface
      // can evolve independently. Fall back to a notice if the
      // module didn't load for any reason.
      if (window.LumenTerminal && typeof window.LumenTerminal.render === "function") {
        try { return window.LumenTerminal.render(); }
        catch (e) { console.error("[Lumen Terminal] render failed:", e); }
      }
      const wrap = util.el("div", { class: "page stack-lg" });
      wrap.appendChild(ui.empty({
        title: "Terminal module unavailable",
        message: "The Terminal view didn't load. Reload the page; if the problem persists, the terminal.js script may have failed to parse."
      }));
      return wrap;
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
    const card = util.el("div", {
      class: "rank-card",
      role: "button",
      tabindex: "0",
      "aria-label": `Open ${book.title}`,
      onclick: () => { onClick && onClick(scored); },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick && onClick(scored); }
      }
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
      util.el("div", { class: "donut-note", text: Engine.fitLabel(fitScore).toLowerCase() })
    ]));
    aside.appendChild(fitRow);

    const confRow = util.el("div", { class: "donut-row" });
    confRow.appendChild(donutSVG(confidence, "Confidence"));
    confRow.appendChild(util.el("div", { class: "donut-meta" }, [
      "Confidence",
      util.el("div", { class: "donut-note", text: Engine.confLabel(confidence).toLowerCase() })
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
  // Secret admin dashboard — opened by clicking the Lumen logo 5 times.
  // Never linked from the UI. All operator controls live here only.
  function renderSidebar() {
    const current = router.current();
    const groups = {
      main:     { label: "Read" },
      personal: { label: "You" },
      settings: { label: "More" }
    };
    const side = document.getElementById("side-nav");
    side.innerHTML = "";

    // Clean up any previously rendered mobile drawer/scrim
    document.querySelector(".nav-more-drawer")?.remove();
    document.querySelector(".nav-more-scrim")?.remove();
    document.body.classList.remove("nav-more-open");

    // Secret admin trapdoor: click the "Lumen" mark 5 times within 2 s.
    let _adminClickCount = 0, _adminClickTimer = null;
    const brand = util.el("div", { class: "app-brand", onclick: () => {
      _adminClickCount++;
      clearTimeout(_adminClickTimer);
      if (_adminClickCount >= 5) {
        _adminClickCount = 0;
        router.go("settings");
        return;
      }
      _adminClickTimer = setTimeout(() => { _adminClickCount = 0; }, 2000);
    }}, [
      util.el("span", { class: "mark", text: "Lumen" }),
      util.el("span", { class: "tag", text: "Private" })
    ]);
    side.appendChild(brand);

    const secondaryGroups = ["personal", "settings"];
    const currentIsSecondary = secondaryGroups.some(g =>
      ROUTES.filter(r => r.group === g).some(r => r.id === current.id)
    );

    for (const [gid, g] of Object.entries(groups)) {
      const group = util.el("div", { class: "nav-group", "data-group": gid });
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

    // "More" button — visible only on mobile (CSS hides it on desktop).
    // Opens a slide-up drawer with personal + settings routes.
    const moreBtn = util.el("button", {
      class: "nav-more-btn" + (currentIsSecondary ? " has-active-child" : ""),
      "aria-label": "More pages"
    });
    moreBtn.appendChild(util.el("span", { class: "nav-more-dots", text: "···" }));
    moreBtn.appendChild(util.el("span", { text: "More" }));
    side.appendChild(moreBtn);

    // Scrim (appended to body so it covers the full viewport)
    const scrim = util.el("div", { class: "nav-more-scrim" });
    document.body.appendChild(scrim);

    // Slide-up drawer with personal + settings links
    const drawer = util.el("div", { class: "nav-more-drawer", "aria-label": "More navigation" });
    drawer.appendChild(util.el("div", { class: "nav-more-drawer-handle" }));

    for (const [gid, g] of Object.entries(groups)) {
      if (!secondaryGroups.includes(gid)) continue;
      const section = util.el("div", { class: "nav-more-drawer-section" });
      section.appendChild(util.el("div", { class: "nav-more-drawer-label", text: g.label }));
      for (const r of ROUTES.filter(r => r.group === gid)) {
        section.appendChild(util.el("a", {
          class: "nav-link",
          href: `#/${r.id}`,
          "aria-current": r.id === current.id ? "page" : null,
          "data-route": r.id
        }, [util.el("span", { text: r.label })]));
      }
      drawer.appendChild(section);
    }
    document.body.appendChild(drawer);

    function openMore() {
      document.body.classList.add("nav-more-open");
      moreBtn.classList.add("is-active");
    }
    function closeMore() {
      document.body.classList.remove("nav-more-open");
      moreBtn.classList.remove("is-active");
    }

    moreBtn.addEventListener("click", e => {
      e.stopPropagation();
      document.body.classList.contains("nav-more-open") ? closeMore() : openMore();
    });
    scrim.addEventListener("click", closeMore);
    drawer.querySelectorAll(".nav-link").forEach(l => l.addEventListener("click", closeMore));
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
      class: "bianca-launcher",
      "aria-label": "Open Bianca",
      title: "Open Bianca (your reading companion)",
      onclick: () => window.LumenBianca && window.LumenBianca.toggle()
    }, [
      util.el("span", { class: "dot" }),
      util.el("span", { text: "Ask Bianca" })
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
    if (window.LumenBianca) {
      window.LumenBianca.setContext(computeBiancaContext(r.id));
    }
    // Auto-collapse the left nav when on the Terminal — the
    // dashboard needs every pixel to breathe. A pull-tab on the
    // left edge slides the nav back in as an overlay so the user
    // can route away without losing the dashboard width.
    applySidenavMode(r.id);
  }

  // Three states for the left nav: "normal" (default, grid
  // column visible), "hidden" (Terminal mode — column collapsed
  // to 0, sidebar translated off-screen, pull-tab visible),
  // "overlay" (sidebar slid back in on top of the Terminal via
  // fixed positioning with a scrim). Toggling handled by the
  // pull-tab; routing out of the Terminal resets to normal.
  function applySidenavMode(routeId) {
    // Terminal: collapse the sidebar so the dashboard gets every pixel.
    // A pull-tab (chevron) docks at the left edge so the user can
    // re-open the nav at any time. Routing away clears the state.
    const b = document.body;
    if (routeId === "terminal") {
      if (b.dataset.sidenav !== "overlay") b.dataset.sidenav = "hidden";
      mountSidenavPullTab();
    } else {
      delete b.dataset.sidenav;
    }
  }

  function mountSidenavPullTab() {
    if (document.getElementById("sidenav-pulltab")) return;
    const tab = document.createElement("button");
    tab.id = "sidenav-pulltab";
    tab.className = "sidenav-pulltab";
    tab.type = "button";
    tab.setAttribute("aria-label", "Show navigation");
    tab.title = "Show navigation";
    tab.innerHTML = '<span aria-hidden="true">›</span>';
    tab.addEventListener("click", () => {
      document.body.dataset.sidenav = document.body.dataset.sidenav === "overlay" ? "hidden" : "overlay";
    });
    document.body.appendChild(tab);
    // Click-outside on a scrim also collapses back to hidden.
    const scrim = document.createElement("div");
    scrim.id = "sidenav-scrim";
    scrim.className = "sidenav-scrim";
    scrim.addEventListener("click", () => {
      if (document.body.dataset.sidenav === "overlay") document.body.dataset.sidenav = "hidden";
    });
    document.body.appendChild(scrim);
    // Any nav-link click also collapses the overlay — routing
    // already removes the attribute but snapping it back on the
    // same frame avoids a flash of the sidebar on top of the new
    // view.
    document.addEventListener("click", (e) => {
      if (document.body.dataset.sidenav !== "overlay") return;
      const link = e.target.closest(".nav-link, .app-side a[href^='#']");
      if (link) document.body.dataset.sidenav = "hidden";
    }, true);
  }

  // computeBiancaContext is now defined alongside buildBiancaContext
  // above — this second definition was the legacy regex-driven
  // version and has been removed. Keeping the comment so future
  // greps find the old symbol.

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
    // Discovery Phase: operator has pre-vouched for the environment
    // when an admin key is configured — skip the gate so testers
    // land directly on the app without any blocking prompt.
    const Disco = window.LumenDiscovery;
    if (Disco && Disco.getAdminKey && Disco.getAdminKey()) {
      store.update(s => { s.ui.adultConfirmed = true; });
      return;
    }
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
      { label: "Open Bianca",        hint: "S", run: () => window.LumenBianca && window.LumenBianca.open() },
      { label: "Close Bianca",       hint: "",  run: () => window.LumenBianca && window.LumenBianca.close() }
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
        if (window.LumenBianca) window.LumenBianca.toggle();
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

    // Mount Bianca (persistent floating assistant) once at shell level.
    if (window.LumenBianca) {
      window.LumenBianca.boot();
      // Keep Bianca's context in sync with every state change —
      // slider tweaks, chip toggles, imports, rejections all push
      // a fresh structured context object without needing a
      // renderView() bounce through the hash router.
      store.subscribe(() => {
        try {
          const r = router.current();
          window.LumenBianca.setContext(computeBiancaContext(r.id));
        } catch (e) { /* ignore */ }
      });
    }

    adultGate();

    // Boot-time embedding backfill (Batch 3). Silent if no Voyage
    // key; capped at 20 books per session so a huge library doesn't
    // burn quota on one visit.
    backfillEmbeddings();
  }

  /* ==================================================================
     Editorial feature — Batch 2: selection helpers only.

     selectEditorialCandidates(profile, pool, options)
       Ranks the pool via LumenEngine, keeps the top `topN` (default
       20), then draws `pickCount` (default 3) via weighted-random
       sampling without replacement. Weight = fitScore^2 — squaring
       biases toward higher-fit titles without being deterministic
       across generations. If the pool has fewer than pickCount
       eligible items, returns what's available (no fabrication).
       Each returned entry is { book, fitScore, confidence,
       contributions }. contributions falls back to the engine's
       `why` field when available, else null.

     chooseEditorialAngle()
       Returns one of six fixed editorial angles at random, avoiding
       whatever angle the most recent history entry used. Shape:
       { id, label }.
     ================================================================== */
  const EDITORIAL_ANGLES = [
    { id: "deepen",     label: "Three books that would deepen what you're already drawn to" },
    { id: "stretch",    label: "Three books that would stretch you somewhere new" },
    { id: "comfort",    label: "Three books for when you want something familiar and easy" },
    { id: "mood",       label: "Three books that share a mood your library keeps returning to" },
    { id: "overlook",   label: "Three books you might have overlooked" },
    { id: "complement", label: "Three books that pair with what you've been reading lately" }
  ];

  function selectEditorialCandidates(profile, pool, options) {
    const opts = options || {};
    const topN = typeof opts.topN === "number" ? opts.topN : 20;
    const pickCount = typeof opts.pickCount === "number" ? opts.pickCount : 3;
    if (!Array.isArray(pool) || !pool.length) return [];
    const Engine = window.LumenEngine;
    if (!Engine || typeof Engine.rankRecommendations !== "function") return [];
    const st = store.get() || {};
    const weights = st.weights || {};
    const ranked = Engine.rankRecommendations(profile, weights, pool) || {};
    const scored = Array.isArray(ranked.scored) ? ranked.scored : [];
    const shape = (s) => ({
      book: s.book,
      fitScore: typeof s.fitScore === "number" ? s.fitScore : 0,
      confidence: typeof s.confidence === "number" ? s.confidence : 0,
      contributions: s.contributions || s.why || null
    });
    const top = scored.slice(0, topN);
    if (top.length <= pickCount) return top.map(shape);

    // Weighted-random without replacement. Weight = fitScore^2.
    // Falls back to uniform when every weight collapses to zero.
    const remaining = top.slice();
    const picks = [];
    while (picks.length < pickCount && remaining.length) {
      const ws = remaining.map(s => {
        const f = Math.max(0, typeof s.fitScore === "number" ? s.fitScore : 0);
        return f * f;
      });
      const total = ws.reduce((a, b) => a + b, 0);
      let idx;
      if (total <= 0) {
        idx = Math.floor(Math.random() * remaining.length);
      } else {
        let r = Math.random() * total;
        idx = 0;
        for (; idx < ws.length; idx++) {
          r -= ws[idx];
          if (r <= 0) break;
        }
        if (idx >= remaining.length) idx = remaining.length - 1;
      }
      picks.push(remaining.splice(idx, 1)[0]);
    }
    return picks.map(shape);
  }

  function chooseEditorialAngle() {
    const st = store.get() || {};
    const history = (st.editorial && st.editorial.history) || [];
    const lastAngleId = history[0] && history[0].angle && history[0].angle.id;
    const pool = EDITORIAL_ANGLES.filter(a => a.id !== lastAngleId);
    const list = pool.length ? pool : EDITORIAL_ANGLES; // defensive
    return list[Math.floor(Math.random() * list.length)];
  }

  // Public surface for bianca.js — keep this list small and intentional.
  window.Lumen = {
    store, router, ui, util, views, ROUTES, saraRespond,
    findBook, listAllBooks, openBookDetail,
    buildBiancaSystemContext
  };
  document.addEventListener("DOMContentLoaded", boot);
})();
