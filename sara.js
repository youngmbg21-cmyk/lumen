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

  let panel, body, composeTA, ctxBar, fab;
  let opened = false;
  let wide = false;
  let lastFocus = null;

  function mount() {
    if (panel) return;

    panel = document.createElement("div");
    panel.className = "sara-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-label", "Sara, your reading companion");

    const head = document.createElement("div");
    head.className = "sara-head";
    const title = document.createElement("div");
    title.innerHTML =
      '<div class="sara-title">Sara</div>' +
      '<div class="sara-sub">Your reading companion · private to this device</div>';
    const actions = document.createElement("div");
    actions.className = "sara-head-actions";
    const widthBtn = iconBtn("Expand", () => {
      wide = !wide;
      panel.classList.toggle("wide", wide);
      widthBtn.textContent = wide ? "◧" : "◨";
    }, "◨");
    const resetBtn = iconBtn("Reset conversation", () => {
      if (!confirm("Clear this conversation?")) return;
      store().update(s => { s.chats.sara = []; });
      ensureSeed();
      renderMessages();
    }, "↺");
    const closeBtn = iconBtn("Close", () => close(), "×");
    actions.appendChild(widthBtn);
    actions.appendChild(resetBtn);
    actions.appendChild(closeBtn);
    head.appendChild(title);
    head.appendChild(actions);
    panel.appendChild(head);

    ctxBar = document.createElement("div");
    ctxBar.className = "sara-context";
    panel.appendChild(ctxBar);

    body = document.createElement("div");
    body.className = "sara-body";
    body.setAttribute("role", "log");
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-label", "Conversation with Sara");
    panel.appendChild(body);

    const sugg = document.createElement("div");
    sugg.className = "sara-suggestions";
    sugg.id = "sara-suggestions";
    panel.appendChild(sugg);

    const compose = document.createElement("form");
    compose.className = "sara-compose";
    composeTA = document.createElement("textarea");
    composeTA.placeholder = "Message Sara…";
    composeTA.rows = 1;
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
    fab.textContent = "S";
    fab.addEventListener("click", toggle);
    document.body.appendChild(fab);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && opened) close();
    });
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
    if (!s.chats.sara || s.chats.sara.length === 0) {
      st.update(s2 => {
        s2.chats.sara = s2.chats.sara || [];
        s2.chats.sara.push({
          id: "s_" + Math.random().toString(36).slice(2, 8),
          role: "sara",
          ts: Date.now(),
          text: "Hi — I'm Sara. I'm here in every tab if you want me. Ask what to read tonight, what two titles have in common, or how to journal something. Everything stays on your device."
        });
      });
    }
  }

  function renderMessages() {
    const st = store();
    if (!st || !body) return;
    const msgs = st.get().chats.sara || [];
    body.innerHTML = "";
    msgs.forEach(m => {
      const node = document.createElement("div");
      node.className = "chat-msg " + (m.role === "user" ? "from-me" : "from-them");
      const safe = (m.text || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      node.innerHTML = safe;
      body.appendChild(node);
    });
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 10);
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

  function renderSuggestions() {
    const host = document.getElementById("sara-suggestions");
    if (!host) return;
    host.innerHTML = "";
    const list = suggestionsForRoute(ctxState.route);
    list.forEach(s => {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = s;
      b.addEventListener("click", () => send(s));
      host.appendChild(b);
    });
  }

  function suggestionsForRoute(route) {
    const base = ["What should I read tonight?", "Why does Lumen score that way?", "How private is this?"];
    const perRoute = {
      discover: ["Pick tonight's book", "Summarize my profile"],
      library:  ["What matches my mood?", "Filter to high-fit only"],
      compare:  ["What's the biggest difference?", "Which is safer?"],
      chat:     ["Show conversation history"],
      journal:  ["Give me a reflection prompt"],
      vault:    ["What have I pinned recently?"],
      profile:  ["What do my settings mean?"],
      settings: ["Where is my API key stored?", "What can you see?"],
      transparency: ["What won't you do?"]
    };
    return (perRoute[route] || []).concat(base).slice(0, 5);
  }

  function send(text) {
    const st = store();
    if (!st) return;
    st.update(s => {
      s.chats.sara = s.chats.sara || [];
      s.chats.sara.push({ id: "m_" + Date.now(), role: "user", ts: Date.now(), text });
    });
    renderMessages();
    if (composeTA) composeTA.value = "";
    setTimeout(() => {
      const reply = (window.Lumen && window.Lumen.saraRespond) ? window.Lumen.saraRespond(text, ctxState) : fallbackResponder(text);
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
    renderSuggestions();
    if (!opened) lastFocus = document.activeElement;
    panel.classList.add("open");
    opened = true;
    store() && store().update(s => { s.ui = s.ui || {}; s.ui.saraOpen = true; });
    setTimeout(() => composeTA && composeTA.focus(), 80);
  }

  function close() {
    if (!panel) return;
    panel.classList.remove("open");
    opened = false;
    store() && store().update(s => { s.ui = s.ui || {}; s.ui.saraOpen = false; });
    if (lastFocus && typeof lastFocus.focus === "function") {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
  }

  function toggle() { opened ? close() : open(); }

  function store() { return window.Lumen && window.Lumen.store; }

  function setContext(patch) {
    Object.assign(ctxState, patch || {});
    if (panel) { renderContext(); renderSuggestions(); }
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
    subscribe: (fn) => { ctxSubs.add(fn); return () => ctxSubs.delete(fn); },
    get context() { return Object.assign({}, ctxState); }
  };
})();
