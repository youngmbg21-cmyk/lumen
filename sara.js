/* ============================================================
   Lumen — Sara (persistent floating assistant)
   Batch 1: launcher, docked panel, thread, context bus stub.
   Reuses the rule-based responder exposed by app.js.
   Mounted once at shell level, survives route changes.
   Exposes: window.LumenSara { open, close, toggle, setContext, post }
   ============================================================ */
(function () {
  "use strict";

  const ctxState = {
    route: "discover",
    chips: [],
    book: null,
    compareSlots: [],
    journalEntryId: null
  };
  const ctxSubs = new Set();

  let panel, body, composeTA, ctxBar, fab, pinnedTray, moodRow;
  let opened = false;
  // Width state machine: "dock" (380) → "wide" (560) → "focus" (≈50vw, 760 cap).
  // Focus also reflows the main page content so it isn't obscured.
  const WIDTHS = ["dock", "wide", "focus"];
  let width = "dock";
  let lastFocus = null;

  // Persisted after first pin — stops the "tip" bubble from reappearing.
  const NUDGE_KEY = "lumen:sara-pin-nudge-seen";

  function mount() {
    if (panel) return;

    panel = document.createElement("div");
    panel.className = "sara-panel";
    panel.dataset.width = width;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", "Sara, your reading companion");

    const head = document.createElement("div");
    head.className = "sara-head";
    const title = document.createElement("div");
    title.className = "sara-head-title";
    title.innerHTML =
      '<div class="sara-title"><span class="sara-title-serif">Sara</span> <span class="sara-title-sub">whispers</span></div>' +
      '<div class="sara-sub">Your reading companion <span class="sara-privacy-pill" title="Nothing leaves this device">Local</span></div>';
    const actions = document.createElement("div");
    actions.className = "sara-head-actions";
    // Discreet-mode toggle — blurs covers and titles in the chat only.
    const discreetBtn = iconBtn("Discreet mode (blur covers in chat)", () => {
      panel.classList.toggle("discreet");
      discreetBtn.setAttribute("aria-pressed", panel.classList.contains("discreet") ? "true" : "false");
    }, "◉");
    discreetBtn.setAttribute("aria-pressed", "false");
    // Width cycle — dock → wide → focus → dock. Matches the icons
    // progressively: single bar → two bars → expanded bracket.
    const widthBtn = iconBtn("Panel width", () => cycleWidth(), widthIcon());
    widthBtn.classList.add("sara-width-btn");
    const resetBtn = iconBtn("Reset conversation", () => {
      if (!confirm("Clear this conversation?")) return;
      store().update(s => { s.chats.sara = []; s.chats.saraPinned = []; });
      ensureSeed();
      renderMessages();
      renderPinnedTray();
    }, "↺");
    const closeBtn = iconBtn("Close", () => close(), "×");
    actions.appendChild(discreetBtn);
    actions.appendChild(widthBtn);
    actions.appendChild(resetBtn);
    actions.appendChild(closeBtn);
    head.appendChild(title);
    head.appendChild(actions);
    panel.appendChild(head);

    ctxBar = document.createElement("div");
    ctxBar.className = "sara-context";
    panel.appendChild(ctxBar);

    // Pinned-books tray — lives between context and messages. Stays
    // horizontally scrollable on narrow widths so it never eats the
    // conversation height.
    pinnedTray = document.createElement("div");
    pinnedTray.className = "sara-pinned-tray";
    panel.appendChild(pinnedTray);

    body = document.createElement("div");
    body.className = "sara-body";
    body.setAttribute("role", "log");
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-label", "Conversation with Sara");
    panel.appendChild(body);

    // Mood chips — first-person, audience-appropriate primary entry
    // points. Sends "Show me something <mood> tonight" when tapped.
    moodRow = document.createElement("div");
    moodRow.className = "sara-moods";
    moodRow.id = "sara-moods";
    panel.appendChild(moodRow);

    const compose = document.createElement("form");
    compose.className = "sara-compose";
    composeTA = document.createElement("textarea");
    composeTA.placeholder = "Message Sara… try /compare, /why, /heat, /save, /journal";
    composeTA.rows = 1;
    // Auto-grow up to 5 rows so longer messages don't feel cramped.
    composeTA.addEventListener("input", autosizeCompose);
    composeTA.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = composeTA.value.trim();
        if (text) send(text);
      }
    });
    const sendBtn = document.createElement("button");
    sendBtn.className = "btn btn-primary btn-sm";
    sendBtn.type = "submit";
    sendBtn.textContent = "Send";
    compose.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = composeTA.value.trim();
      if (text) send(text);
    });
    compose.appendChild(composeTA);
    compose.appendChild(sendBtn);
    panel.appendChild(compose);

    document.body.appendChild(panel);

    fab = document.createElement("button");
    fab.className = "sara-fab";
    fab.setAttribute("aria-label", "Open Sara");
    // Open-book glyph — softer than a generic "S" for the audience.
    fab.innerHTML = '<span aria-hidden="true">❦</span>';
    fab.addEventListener("click", toggle);
    document.body.appendChild(fab);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && opened) close();
      // Cmd/Ctrl + / summons Sara from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        toggle();
      }
    });
  }

  function widthIcon() {
    if (width === "focus") return "◨◨";
    if (width === "wide") return "◨";
    return "◧";
  }
  function cycleWidth() {
    const idx = WIDTHS.indexOf(width);
    width = WIDTHS[(idx + 1) % WIDTHS.length];
    applyWidth();
  }
  function applyWidth() {
    if (!panel) return;
    panel.dataset.width = width;
    // Body attribute so the app shell can reflow (padding on .app-main
    // in focus mode on desktop) without Sara reaching into app.js.
    if (opened && width === "focus") document.body.setAttribute("data-sara-width", "focus");
    else document.body.removeAttribute("data-sara-width");
    const btns = panel.querySelectorAll(".sara-width-btn");
    btns.forEach(b => { b.textContent = widthIcon(); });
  }

  function autosizeCompose() {
    if (!composeTA) return;
    composeTA.style.height = "auto";
    const max = 140; // ≈ 5 rows of compose text
    composeTA.style.height = Math.min(composeTA.scrollHeight, max) + "px";
  }

  function iconBtn(label, onClick, char) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.textContent = char;
    b.addEventListener("click", onClick);
    return b;
  }

  function ensureSeed() {
    const st = store();
    if (!st) return;
    const s = st.get();
    // Guarantee both arrays exist — older states may have just `sara`.
    if (!Array.isArray(s.chats.saraPinned)) {
      st.update(s2 => { s2.chats.saraPinned = s2.chats.saraPinned || []; });
    }
    if (!s.chats.sara || s.chats.sara.length === 0) {
      st.update(s2 => {
        s2.chats.sara = s2.chats.sara || [];
        s2.chats.sara.push({
          id: "s_" + Math.random().toString(36).slice(2, 8),
          role: "sara",
          ts: Date.now(),
          text: "Hi — I'm Sara. Tap a bookmark on any book card to share it with me, or tell me your mood below. Everything stays on your device."
        });
      });
    }
  }

  // Minimal markdown: **bold**, _italic_, and `- ` bullet lists. HTML
  // entities are escaped first so the stored text can't inject markup.
  function renderMarkdown(raw) {
    const esc = (raw || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let withInline = esc
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
    // Convert "- item" lines into a single <ul>. Kept simple — nested
    // lists / ordered lists are out of scope for a chat bubble.
    const lines = withInline.split(/\n/);
    const out = [];
    let inList = false;
    for (const line of lines) {
      const m = line.match(/^\s*-\s+(.*)$/);
      if (m) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + m[1] + "</li>");
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(line);
      }
    }
    if (inList) out.push("</ul>");
    return out.join("\n").replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  }

  function renderMessages() {
    const st = store();
    if (!st || !body) return;
    const msgs = st.get().chats.sara || [];
    body.innerHTML = "";
    msgs.forEach(m => {
      if (m.role === "book-card" && m.bookId) {
        const card = renderBookCardMessage(m);
        if (card) body.appendChild(card);
        return;
      }
      const node = document.createElement("div");
      node.className = "chat-msg " + (m.role === "user" ? "from-me" : "from-them");
      node.innerHTML = renderMarkdown(m.text || "");
      body.appendChild(node);
    });
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 10);
  }

  // Resolve a shared book from app.js. Defensive: if Lumen hasn't
  // finished booting, render a stub that says so instead of crashing.
  function resolveBook(bookId) {
    const L = window.Lumen;
    if (L && typeof L.findBook === "function") {
      try { return L.findBook(bookId); } catch (e) { return null; }
    }
    return null;
  }

  function renderBookCardMessage(m) {
    const book = resolveBook(m.bookId);
    const wrap = document.createElement("div");
    wrap.className = "sara-share-card chat-msg from-me";
    wrap.dataset.bookId = m.bookId;

    const cover = document.createElement("div");
    cover.className = "sara-share-cover";
    if (book && book.thumbnail) {
      const img = document.createElement("img");
      img.src = String(book.thumbnail).replace(/^http:/, "https:");
      img.alt = `Cover of ${book.title}`;
      img.loading = "lazy";
      img.onerror = function () {
        this.remove();
        const fb = document.createElement("div");
        fb.className = "cover-fallback";
        fb.textContent = (book.title || "??").slice(0, 2).toUpperCase();
        cover.appendChild(fb);
      };
      cover.appendChild(img);
    } else {
      const fb = document.createElement("div");
      fb.className = "cover-fallback";
      fb.textContent = ((book && book.title) || "??").slice(0, 2).toUpperCase();
      cover.appendChild(fb);
    }
    wrap.appendChild(cover);

    const meta = document.createElement("div");
    meta.className = "sara-share-meta";
    if (book) {
      const title = document.createElement("div");
      title.className = "sara-share-title";
      title.textContent = book.title;
      meta.appendChild(title);
      const author = document.createElement("div");
      author.className = "sara-share-author";
      author.textContent = `${book.author || ""}${book.year ? " · " + book.year : ""}`;
      meta.appendChild(author);
      if (Array.isArray(book.content_warnings) && book.content_warnings.length) {
        const warns = document.createElement("div");
        warns.className = "sara-share-warns";
        warns.textContent = `${book.content_warnings.length} content warning${book.content_warnings.length === 1 ? "" : "s"}`;
        meta.appendChild(warns);
      }
      const actions = document.createElement("div");
      actions.className = "sara-share-actions";
      const openBtn = document.createElement("button");
      openBtn.className = "btn btn-sm";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () => {
        const L = window.Lumen;
        if (L && L.openBookDetail) L.openBookDetail(book.id);
      });
      actions.appendChild(openBtn);
      const unpinBtn = document.createElement("button");
      unpinBtn.className = "btn btn-sm btn-ghost";
      unpinBtn.textContent = "Unpin";
      unpinBtn.addEventListener("click", () => unpinBook(book.id));
      actions.appendChild(unpinBtn);
      meta.appendChild(actions);
    } else {
      meta.appendChild(document.createTextNode("Book no longer available."));
    }
    wrap.appendChild(meta);
    return wrap;
  }

  function renderPinnedTray() {
    if (!pinnedTray) return;
    const st = store();
    const pinned = (st && st.get().chats.saraPinned) || [];
    pinnedTray.innerHTML = "";
    if (!pinned.length) {
      pinnedTray.classList.add("is-empty");
      const empty = document.createElement("div");
      empty.className = "sara-pinned-empty";
      empty.textContent = "Bookmark a book card from any page and I'll keep it here.";
      pinnedTray.appendChild(empty);
      return;
    }
    pinnedTray.classList.remove("is-empty");
    pinned.forEach(entry => {
      const book = resolveBook(entry.bookId);
      if (!book) return;
      const chip = document.createElement("button");
      chip.className = "sara-pinned-chip";
      chip.title = `${book.title}${book.author ? " · " + book.author : ""}`;
      chip.setAttribute("aria-label", `Pinned: ${book.title}. Click to open.`);
      if (book.thumbnail) {
        const img = document.createElement("img");
        img.src = String(book.thumbnail).replace(/^http:/, "https:");
        img.alt = "";
        chip.appendChild(img);
      } else {
        const fb = document.createElement("span");
        fb.className = "sara-pinned-chip-fallback";
        fb.textContent = (book.title || "??").slice(0, 2).toUpperCase();
        chip.appendChild(fb);
      }
      const label = document.createElement("span");
      label.className = "sara-pinned-chip-label";
      label.textContent = book.title;
      chip.appendChild(label);
      const remove = document.createElement("span");
      remove.className = "sara-pinned-chip-x";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Unpin ${book.title}`);
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        unpinBook(book.id);
      });
      chip.appendChild(remove);
      chip.addEventListener("click", () => {
        const L = window.Lumen;
        if (L && L.openBookDetail) L.openBookDetail(book.id);
      });
      pinnedTray.appendChild(chip);
    });
  }

  function renderContext() {
    if (!ctxBar) return;
    ctxBar.innerHTML = "";
    (ctxState.chips || []).forEach(chip => {
      const c = document.createElement("span");
      c.className = "ctx-chip";
      c.textContent = chip.label;
      ctxBar.appendChild(c);
    });
  }

  // Mood chips — primary entry point above the compose box. First-
  // person phrasing, relevant to the erotica-fiction audience. Sends
  // a templated prompt that the rule-based responder already handles.
  const MOODS = [
    { key: "slow burn",  label: "slow burn"  },
    { key: "tender",     label: "tender"     },
    { key: "intense",    label: "intense"    },
    { key: "forbidden",  label: "forbidden"  },
    { key: "escapist",   label: "escapist"   },
    { key: "literary",   label: "literary"   },
    { key: "short",      label: "short tonight" }
  ];
  function renderMoods() {
    if (!moodRow) return;
    moodRow.innerHTML = "";
    const lead = document.createElement("span");
    lead.className = "sara-moods-lead";
    lead.textContent = "Tonight I want…";
    moodRow.appendChild(lead);
    MOODS.forEach(m => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sara-mood-chip";
      b.textContent = m.label;
      b.addEventListener("click", () => send(`Show me something ${m.key} tonight.`));
      moodRow.appendChild(b);
    });
  }

  // Slash-command shortcuts. Each returns a canonical natural-language
  // prompt fed into the existing rule-based responder, so we don't have
  // to re-implement every handler here.
  function expandSlashCommand(raw) {
    if (!raw.startsWith("/")) return null;
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "/compare": return "Compare the titles I have pinned.";
      case "/why":     return arg ? `Why does ${arg} score that way?` : "Why does Lumen score that way?";
      case "/heat":    return arg ? `What's the heat level of ${arg}?` : "What's the heat level of my pinned titles?";
      case "/save":    return "Save this conversation to my Vault.";
      case "/journal": return "Give me a reflection prompt.";
      default: return null;
    }
  }

  function send(text) {
    const st = store();
    if (!st) return;
    const expanded = expandSlashCommand(text) || text;
    const userMessage = expanded === text ? text : `${text}\n_${expanded}_`;
    st.update(s => {
      s.chats.sara = s.chats.sara || [];
      s.chats.sara.push({ id: "m_" + Date.now(), role: "user", ts: Date.now(), text: userMessage });
    });
    renderMessages();
    if (composeTA) { composeTA.value = ""; autosizeCompose(); }
    setTimeout(() => {
      const reply = (window.Lumen && window.Lumen.saraRespond) ? window.Lumen.saraRespond(expanded, ctxState) : fallbackResponder(expanded);
      st.update(s => {
        s.chats.sara.push({ id: "m_" + (Date.now() + 1), role: "sara", ts: Date.now(), text: reply });
      });
      renderMessages();
    }, 240);
  }

  function fallbackResponder() {
    return "I'm here. I'll have more to say once everything finishes loading — try again in a moment.";
  }

  function open() {
    if (!panel) mount();
    ensureSeed();
    renderMessages();
    renderContext();
    renderMoods();
    renderPinnedTray();
    if (!opened) lastFocus = document.activeElement;
    panel.classList.add("open");
    opened = true;
    applyWidth();
    store() && store().update(s => { s.ui = s.ui || {}; s.ui.saraOpen = true; });
    setTimeout(() => composeTA && composeTA.focus(), 80);
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("open");
    opened = false;
    document.body.removeAttribute("data-sara-width");
    store() && store().update(s => { s.ui = s.ui || {}; s.ui.saraOpen = false; });
    if (lastFocus && typeof lastFocus.focus === "function") {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
  }

  function toggle() { opened ? close() : open(); }

  // Public pin/unpin API called from app.js book cards.
  function pinBook(bookId) {
    const st = store();
    if (!st || !bookId) return;
    st.update(s => {
      s.chats.saraPinned = s.chats.saraPinned || [];
      if (s.chats.saraPinned.some(e => e.bookId === bookId)) return;
      s.chats.saraPinned.push({ bookId, ts: Date.now() });
      s.chats.sara = s.chats.sara || [];
      s.chats.sara.push({
        id: "m_" + Date.now(),
        role: "book-card",
        bookId,
        ts: Date.now()
      });
      // Sara acknowledges the pin so the chat has a conversational
      // turn instead of a naked card.
      s.chats.sara.push({
        id: "m_" + (Date.now() + 1),
        role: "sara",
        ts: Date.now() + 1,
        text: "Pinned. I'll keep this one open while we talk."
      });
    });
    ensureSeed();
    open();
    renderPinnedTray();
    renderMessages();
    // First-time tip toast — via the host app's ui.toast if available.
    try {
      if (!localStorage.getItem(NUDGE_KEY)) {
        localStorage.setItem(NUDGE_KEY, "1");
        const L = window.Lumen;
        if (L && L.ui && L.ui.toast) {
          L.ui.toast("Pinned to Sara. Tap the bookmark on any card to share more.");
        }
      }
    } catch (e) { /* ignore */ }
  }

  function unpinBook(bookId) {
    const st = store();
    if (!st || !bookId) return;
    st.update(s => {
      s.chats.saraPinned = (s.chats.saraPinned || []).filter(e => e.bookId !== bookId);
    });
    renderPinnedTray();
    renderMessages();
  }

  function isPinned(bookId) {
    const st = store();
    if (!st || !bookId) return false;
    return (st.get().chats.saraPinned || []).some(e => e.bookId === bookId);
  }

  function store() { return window.Lumen && window.Lumen.store; }

  function setContext(patch) {
    Object.assign(ctxState, patch || {});
    if (panel) { renderContext(); }
    ctxSubs.forEach(fn => fn(ctxState));
  }

  function post(text) {
    ensureSeed();
    const st = store();
    if (!st) return;
    st.update(s => {
      s.chats.sara.push({ id: "m_" + Date.now(), role: "sara", ts: Date.now(), text });
    });
    if (panel) renderMessages();
  }

  function boot() {
    mount();
    const st = store();
    const s = st && st.get();
    if (s && s.ui && s.ui.saraOpen) open();
  }

  window.LumenSara = {
    boot,
    open, close, toggle,
    setContext,
    post,
    pinBook, unpinBook, isPinned,
    subscribe: (fn) => { ctxSubs.add(fn); return () => ctxSubs.delete(fn); },
    get context() { return Object.assign({}, ctxState); },
    get pinned() {
      const st = store();
      return st ? (st.get().chats.saraPinned || []).slice() : [];
    }
  };
})();
