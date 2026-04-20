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
    // Appearance — open the panel-background picker (presets +
    // upload). Sits to the left of the width control.
    const appearBtn = iconBtn("Background appearance", () => toggleAppearanceMenu(appearBtn), "✦");
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
    actions.appendChild(appearBtn);
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
    composeTA.placeholder = "Message Sara… try /picks, /swap, /why, /compare, /library, /profile";
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

  // -------- Panel background appearance --------
  // Stored at state.ui.saraAppearance = { kind, color?, image? }.
  // `kind` is one of "auto" | "cream" | "rose" | "slate" | "night" |
  // "custom" (custom uses `image` as a data URL). Applied on boot
  // via applyAppearance() and re-applied whenever the user picks a
  // new preset or uploads an image.
  const APPEARANCE_PRESETS = [
    { id: "auto",  label: "Default",  bg: "" },
    { id: "cream", label: "Cream",    bg: "linear-gradient(180deg, #fbf5ec, #f4e7d3)" },
    { id: "rose",  label: "Rose",     bg: "linear-gradient(180deg, #f9ecec, #f2d3d6)" },
    { id: "sage",  label: "Sage",     bg: "linear-gradient(180deg, #eef1e5, #dde4cf)" },
    { id: "slate", label: "Slate",    bg: "linear-gradient(180deg, #ecedef, #d4d7db)" },
    { id: "night", label: "Night",    bg: "linear-gradient(180deg, #2a2430, #1a1620)", dark: true }
  ];

  function readAppearance() {
    const st = store();
    const s = st && st.get();
    return (s && s.ui && s.ui.saraAppearance) || { kind: "auto" };
  }

  function applyAppearance() {
    if (!panel) return;
    const a = readAppearance();
    // Clear any prior inline background + dark flag.
    panel.style.background = "";
    panel.style.backgroundImage = "";
    panel.style.backgroundSize = "";
    panel.style.backgroundPosition = "";
    panel.classList.remove("is-dark-bg");
    if (a.kind === "custom" && a.image) {
      panel.style.backgroundImage = `url(${JSON.stringify(a.image)})`;
      panel.style.backgroundSize = "cover";
      panel.style.backgroundPosition = "center";
      if (a.dark) panel.classList.add("is-dark-bg");
      return;
    }
    const preset = APPEARANCE_PRESETS.find(p => p.id === a.kind);
    if (preset && preset.bg) {
      panel.style.background = preset.bg;
      if (preset.dark) panel.classList.add("is-dark-bg");
    }
  }

  function saveAppearance(patch) {
    const st = store();
    if (!st) return;
    st.update(s => {
      s.ui = s.ui || {};
      const next = Object.assign({}, s.ui.saraAppearance || { kind: "auto" }, patch);
      // When switching away from "custom", drop the image blob to
      // free localStorage room.
      if (next.kind && next.kind !== "custom") delete next.image;
      s.ui.saraAppearance = next;
    });
    applyAppearance();
  }

  let appearanceMenu = null;
  function toggleAppearanceMenu(anchor) {
    if (appearanceMenu && appearanceMenu.isConnected) {
      appearanceMenu.remove();
      appearanceMenu = null;
      return;
    }
    const menu = document.createElement("div");
    menu.className = "sara-appearance-menu";
    const current = readAppearance();
    APPEARANCE_PRESETS.forEach(p => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "sara-appearance-swatch" + (current.kind === p.id ? " is-active" : "");
      sw.title = p.label;
      sw.setAttribute("aria-label", p.label);
      sw.style.background = p.bg || "var(--bg-raised)";
      if (!p.bg) sw.textContent = "A"; // visible marker for Default
      sw.addEventListener("click", () => {
        saveAppearance({ kind: p.id, dark: !!p.dark });
        menu.remove(); appearanceMenu = null;
      });
      menu.appendChild(sw);
    });
    // Upload custom image as a data URL (persisted in localStorage —
    // keep it modest; images over ~1 MB will blow past quota).
    const upload = document.createElement("label");
    upload.className = "sara-appearance-upload";
    upload.textContent = "Upload image";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        saveAppearance({ kind: "custom", image: String(reader.result), dark: false });
        menu.remove(); appearanceMenu = null;
      };
      reader.readAsDataURL(f);
    });
    upload.appendChild(fileInput);
    menu.appendChild(upload);
    // Clear / revert to default.
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "sara-appearance-clear";
    clearBtn.textContent = "Default";
    clearBtn.addEventListener("click", () => {
      saveAppearance({ kind: "auto", image: null, dark: false });
      menu.remove(); appearanceMenu = null;
    });
    menu.appendChild(clearBtn);
    // Position: anchor it below the appearance icon button in the
    // Sara head. position: absolute inside the panel.
    panel.appendChild(menu);
    appearanceMenu = menu;
    // Click-outside-closes.
    setTimeout(() => {
      document.addEventListener("click", onDocClick, true);
      function onDocClick(e) {
        if (!appearanceMenu) return;
        if (!appearanceMenu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
          appearanceMenu.remove(); appearanceMenu = null;
          document.removeEventListener("click", onDocClick, true);
        }
      }
    }, 0);
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

  // First-contact greeting — references whatever's actively on the
  // user's screen from the pushed context. If there's nothing
  // concrete to reference, a calm generic opener stands in.
  function firstContactGreeting() {
    const focus = ctxState && ctxState.focus && ctxState.focus.book;
    const picks = (ctxState && ctxState.dailyPicks) || [];
    const route = (ctxState && ctxState.route) || "";
    if (focus && focus.title) {
      return `I see you're looking at _${focus.title}_ — is that the mood tonight, or are you still browsing?`;
    }
    if (route === "compare") {
      const titles = ((ctxState.compare && ctxState.compare.slots) || []).filter(Boolean).map(x => x.title);
      if (titles.length >= 2) return `Comparing _${titles.slice(0, 2).join("_ and _")}_, I see. Want me to say which leans which way for tonight?`;
    }
    if (route === "discovery" && ctxState.discovery && ctxState.discovery.lastQuery) {
      return `I see you're searching for _${ctxState.discovery.lastQuery}_. Want me to weigh in on the results once they land?`;
    }
    if (picks.length) {
      return `Hi — I'm Sara. Your three picks are up there; I can explain why any of them made the cut, or swap one if the mood isn't right. What are you in the mood for?`;
    }
    return `Hi — I'm Sara. Tell me what you're in the mood for tonight, and I'll read it with you.`;
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
          text: firstContactGreeting()
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

  // Matches [[ENHANCED_BOOK_CARD: <id>]] with flexible whitespace.
  const ENHANCED_CARD_RE = /\[\[\s*ENHANCED_BOOK_CARD\s*:\s*([a-z0-9_\-]+)\s*\]\]/gi;

  // Split a Sara reply into alternating text segments and enhanced-
  // book-card markers so renderMessages can render each in its own
  // DOM node. Returns [{ type: "text", text } | { type: "card", bookId }, …]
  function splitReplyWithCards(raw) {
    const out = [];
    let lastIdx = 0;
    let m;
    const re = new RegExp(ENHANCED_CARD_RE.source, "gi");
    while ((m = re.exec(raw || "")) !== null) {
      if (m.index > lastIdx) out.push({ type: "text", text: raw.slice(lastIdx, m.index) });
      out.push({ type: "card", bookId: m[1] });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < (raw || "").length) out.push({ type: "text", text: raw.slice(lastIdx) });
    return out.filter(p => p.type !== "text" || p.text.trim().length > 0);
  }

  // Renders the whole thread. The newest Sara message gets the
  // typing-reveal effect (once per insert); previous messages render
  // instantly so scroll-back stays snappy.
  let lastTypedMessageId = null;
  function renderMessages() {
    const st = store();
    if (!st || !body) return;
    const msgs = st.get().chats.sara || [];
    body.innerHTML = "";
    const latestSaraIdx = (() => {
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "sara") return i;
      return -1;
    })();

    msgs.forEach((m, i) => {
      if (m.role === "book-card" && m.bookId) {
        const card = renderBookCardMessage(m);
        if (card) body.appendChild(card);
        return;
      }
      if (m.role === "sara") {
        const parts = splitReplyWithCards(m.text || "");
        parts.forEach(p => {
          if (p.type === "text") {
            const node = document.createElement("div");
            node.className = "chat-msg from-them";
            const html = renderMarkdown(p.text);
            // IMPORTANT: append BEFORE starting the typing reveal so
            // revealInto's isConnected guard passes on the first
            // step() tick. Calling revealInto on a detached node
            // caused the bubble to stay empty until the next
            // renderMessages() pass bumped it out of "latest" status.
            body.appendChild(node);
            if (i === latestSaraIdx && m.id !== lastTypedMessageId) {
              revealInto(node, html);
            } else {
              node.innerHTML = html;
            }
          } else if (p.type === "card") {
            const card = renderBookCardMessage({ role: "book-card", bookId: p.bookId, sender: "sara" });
            if (card) {
              card.classList.add("sara-share-card-from-them");
              card.classList.remove("from-me");
              body.appendChild(card);
            }
          }
        });
        if (i === latestSaraIdx) lastTypedMessageId = m.id;
        return;
      }
      const node = document.createElement("div");
      node.className = "chat-msg " + (m.role === "user" ? "from-me" : "from-them");
      node.innerHTML = renderMarkdown(m.text || "");
      body.appendChild(node);
    });
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 10);
  }

  // Types the supplied HTML into `target` character by character,
  // with slight pauses at punctuation for a human reading pace.
  // Users with prefers-reduced-motion skip the animation.
  function revealInto(target, html) {
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !html || html.length > 2000) { target.innerHTML = html; return; }
    // Parse the html so we can reveal by character while preserving
    // markup. We walk text nodes only and rebuild each progressively.
    const temp = document.createElement("div");
    temp.innerHTML = html;
    // Collect (node, fullText) pairs in order.
    const textNodes = [];
    const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null, false);
    let tn;
    while ((tn = walker.nextNode())) textNodes.push({ node: tn, full: tn.nodeValue, i: 0 });
    // Clear each node's visible text and attach the stripped tree.
    textNodes.forEach(x => { x.node.nodeValue = ""; });
    target.innerHTML = "";
    while (temp.firstChild) target.appendChild(temp.firstChild);

    let idx = 0;
    // Fail-safe: if the animation stalls for any reason, drop in
    // the final text as a fallback after 20 s so the reply is
    // never "lost" to the user.
    const fallback = setTimeout(() => {
      textNodes.forEach(x => { x.node.nodeValue = x.full; });
    }, 20000);
    function step() {
      if (idx >= textNodes.length) { clearTimeout(fallback); return; }
      const cur = textNodes[idx];
      if (cur.i >= cur.full.length) { idx += 1; step(); return; }
      // Chunk characters in small bursts so we don't rAF every byte.
      const burst = 2;
      const nextI = Math.min(cur.i + burst, cur.full.length);
      const addition = cur.full.slice(cur.i, nextI);
      cur.node.nodeValue = cur.full.slice(0, nextI);
      cur.i = nextI;
      // Auto-scroll as text grows.
      if (body) body.scrollTop = body.scrollHeight;
      // Punctuation pause — feels like a breath at sentence boundaries.
      const lastChar = addition.slice(-1);
      const delay = ".?!".includes(lastChar) ? 180
                  : ",;:—–".includes(lastChar) ? 80
                  : 18;
      setTimeout(step, delay);
    }
    // Defer the first step to the next tick so the caller's
    // appendChild / layout has a chance to run before we begin
    // mutating the text nodes. Also means revealInto itself is
    // non-blocking.
    setTimeout(step, 0);
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
      const original = String(book.thumbnail).replace(/^http:/, "https:");
      const hi = (window.Lumen && window.Lumen.util && window.Lumen.util.hiresCover)
        ? window.Lumen.util.hiresCover(original) : original;
      const img = document.createElement("img");
      img.src = hi;
      img.alt = `Cover of ${book.title}`;
      img.loading = "lazy";
      const showFallback = () => {
        const fb = document.createElement("div");
        fb.className = "cover-fallback";
        fb.textContent = (book.title || "??").slice(0, 2).toUpperCase();
        cover.appendChild(fb);
      };
      img.onerror = function () {
        if (this.src !== original) {
          this.onerror = function () { this.remove(); showFallback(); };
          this.src = original;
        } else {
          this.remove();
          showFallback();
        }
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
        const original = String(book.thumbnail).replace(/^http:/, "https:");
        const hi = (window.Lumen && window.Lumen.util && window.Lumen.util.hiresCover)
          ? window.Lumen.util.hiresCover(original) : original;
        const img = document.createElement("img");
        img.src = hi;
        img.alt = "";
        img.onerror = function () {
          if (this.src !== original) {
            this.onerror = function () { this.remove(); };
            this.src = original;
          } else {
            this.remove();
          }
        };
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
      case "/picks":   return "Why did you pick these?";
      case "/swap":    return "How do I swap a pick?";
      case "/dismiss": return arg ? `How do I dismiss ${arg}?` : "How do I say 'not for me'?";
      case "/library": return "How many books are in my library?";
      case "/profile": return "Explain my profile.";
      case "/catalog": return "What's in the catalog right now?";
      default: return null;
    }
  }

  // Build the prior-turn array the LLM needs. We skip book-card
  // messages (they're UI artifacts) and system-style entries.
  function historyForLLM() {
    const st = store();
    if (!st) return [];
    const msgs = st.get().chats.sara || [];
    const out = [];
    for (const m of msgs) {
      if (!m || !m.text) continue;
      if (m.role === "user") out.push({ role: "user", content: String(m.text) });
      else if (m.role === "sara") out.push({ role: "assistant", content: String(m.text) });
    }
    return out;
  }

  async function send(text) {
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

    // Preferred path — LLM-backed Sara. Needs Claude API key and the
    // discovery bridge. Falls back to the rule-based responder on any
    // failure so the app never silently dies.
    const Disco = window.LumenDiscovery;
    const hasKey = Disco && typeof Disco.chatWithSara === "function" && Disco.getApiKey && Disco.getApiKey();
    let reply = "";
    if (hasKey) {
      try {
        const systemContext = (window.Lumen && typeof window.Lumen.buildSaraSystemContext === "function")
          ? window.Lumen.buildSaraSystemContext(ctxState && ctxState.route) : "";
        reply = await Disco.chatWithSara({
          systemContext,
          messages: historyForLLM()
        });
      } catch (err) {
        console.warn("[Lumen Sara] LLM path failed, falling back:", err && err.message);
        reply = "";
      }
    }
    if (!reply) {
      // Rule-based fallback — keeps the app functional without a key
      // and when the API is unreachable. Kept as-is.
      try {
        reply = (window.Lumen && window.Lumen.saraRespond)
          ? window.Lumen.saraRespond(expanded, ctxState)
          : fallbackResponder(expanded);
      } catch (e) { reply = fallbackResponder(); }
    }
    // If all else failed (empty string), use a graceful in-character
    // apology rather than silence.
    if (!reply) {
      const persona = window.LumenSaraPersona;
      reply = (persona && persona.randomFailsafe && persona.randomFailsafe())
        || "I lost my place in the book for a moment. Could you ask me again?";
    }

    st.update(s => {
      s.chats.sara.push({ id: "m_" + (Date.now() + 1), role: "sara", ts: Date.now(), text: reply });
    });
    renderMessages();
  }

  function fallbackResponder() {
    const persona = window.LumenSaraPersona;
    return (persona && persona.randomFailsafe && persona.randomFailsafe())
      || "I lost my place in the book for a moment. Could you ask me again?";
  }

  // Inject a fresh first-contact greeting if the gap since the last
  // Sara turn is long enough to count as a new session (2+ hours).
  // Stays silent otherwise so the user isn't pestered on every tab
  // flip.
  function maybeStartNewSession() {
    const st = store();
    if (!st) return;
    const s = st.get();
    const msgs = s.chats.sara || [];
    if (!msgs.length) return; // ensureSeed() already handled it.
    const lastSaraTurn = [...msgs].reverse().find(m => m.role === "sara");
    const since = lastSaraTurn ? (Date.now() - (lastSaraTurn.ts || 0)) : Infinity;
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    if (since < TWO_HOURS) return;
    st.update(s2 => {
      s2.chats.sara.push({
        id: "s_" + Math.random().toString(36).slice(2, 8),
        role: "sara",
        ts: Date.now(),
        text: firstContactGreeting()
      });
    });
  }

  function open() {
    if (!panel) mount();
    applyAppearance();
    ensureSeed();
    maybeStartNewSession();
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
    if (panel) { renderContext(); renderFocusStatus(); renderQuickReplies(); }
    ctxSubs.forEach(fn => fn(ctxState));
  }

  // Focus status line — when the user opens a book detail sheet, the
  // structured context carries focus.book. Show a one-liner in the
  // Sara head ("Reading *Venus in Furs* with you") so the chat feels
  // like it is tracking what's actively on screen.
  function renderFocusStatus() {
    if (!panel) return;
    const existing = panel.querySelector(".sara-focus-line");
    const focus = (ctxState.focus && ctxState.focus.book) || null;
    if (!focus) {
      if (existing) existing.remove();
      return;
    }
    const msg = `Reading ${focus.title} with you`;
    if (existing) { existing.textContent = msg; return; }
    const line = document.createElement("div");
    line.className = "sara-focus-line";
    line.textContent = msg;
    // Insert after the head, before the context chip strip so it
    // doesn't fight the chips for space.
    const head = panel.querySelector(".sara-head");
    if (head && head.nextSibling) panel.insertBefore(line, head.nextSibling);
    else panel.appendChild(line);
  }

  // Route-aware quick-reply chips that morph with real state. These
  // sit alongside the existing mood chip row so the primary entry
  // points remain mood-first but context prompts are one tap away.
  function renderQuickReplies() {
    if (!moodRow) return;
    // Remove any prior quick-reply row — we re-render in place.
    const prior = panel && panel.querySelector(".sara-quick-replies");
    if (prior) prior.remove();
    const chips = contextualQuickReplies(ctxState);
    if (!chips.length) return;
    const row = document.createElement("div");
    row.className = "sara-quick-replies";
    chips.forEach(c => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sara-quick-reply-chip";
      b.textContent = c.label;
      b.addEventListener("click", () => send(c.send));
      row.appendChild(b);
    });
    moodRow.insertAdjacentElement("afterend", row);
  }

  function contextualQuickReplies(ctx) {
    const list = [];
    const route = ctx.route || "discover";
    // Home / Discover
    if (route === "discover") {
      if ((ctx.dailyPicks || []).length) {
        list.push({ label: "Why these picks?", send: "Why did you pick these?" });
        list.push({ label: "Swap one", send: "How do I swap a pick?" });
      } else {
        list.push({ label: "Why nothing?", send: "Why is there nothing to pick?" });
      }
    }
    // Library
    if (route === "library") {
      list.push({ label: "How big is my library?", send: "How many books are in my library?" });
      list.push({ label: "What's best for tonight?", send: "What should I read tonight?" });
    }
    // Compare
    if (route === "compare") {
      const filled = ((ctx.compare && ctx.compare.slots) || []).filter(Boolean).length;
      if (filled >= 2) list.push({ label: "What's the biggest difference?", send: "What's the biggest difference between these?" });
      else list.push({ label: "What should I compare?", send: "What should I compare?" });
    }
    // Discovery
    if (route === "discovery") {
      if (ctx.discovery && ctx.discovery.resultCount) {
        list.push({ label: "Any strong fits here?", send: "Any strong fits in these results?" });
      }
    }
    // Profile
    if (route === "profile") {
      list.push({ label: "Explain my profile", send: "Explain my profile." });
      list.push({ label: "What changes help?", send: "What would I change for more fits?" });
    }
    // Focused book — always offered when something is in focus.
    if (ctx.focus && ctx.focus.book) {
      list.unshift({ label: `Why ${ctx.focus.book.title.length > 20 ? ctx.focus.book.title.slice(0, 18) + "…" : ctx.focus.book.title}?`,
                     send: `Why does ${ctx.focus.book.title} score the way it does?` });
    }
    return list.slice(0, 4);
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
    applyAppearance();
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
