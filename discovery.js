/* ============================================================
   Lumen — Discovery (Web search + Claude enrichment)
   Exposes window.LumenDiscovery with:
     setApiKey(key), getApiKey(),
     searchBooks(query) -> Promise<rawGoogleItems[]>
     analyzeWithClaude(book) -> Promise<enrichedBook>
     onStatus(fn) -> unsubscribe; status in
       { idle | reading | online | error }
   API key is stored in its own localStorage namespace (lumen:claude-key)
   so users can clear it independently of app state.
   ============================================================ */
(function () {
  "use strict";

  const KEY_STORAGE = "lumen:claude-key";
  const GBOOKS_KEY_STORAGE = "lumen:gbooks-key";

  const state = {
    status: "idle",   // idle | reading | online | error
    lastMessage: "Waiting for API key…"
  };
  const statusSubs = new Set();

  function setStatus(status, message) {
    state.status = status;
    state.lastMessage = message || defaultMessage(status);
    statusSubs.forEach(fn => { try { fn(state); } catch (e) { /* ignore */ } });
  }
  function defaultMessage(status) {
    return {
      idle:    "Waiting for API key",
      reading: "Claude is reading…",
      online:  "Analysis complete",
      error:   "Analysis failed"
    }[status] || "";
  }

  function onStatus(fn) {
    statusSubs.add(fn);
    try { fn(state); } catch (e) {}
    return () => statusSubs.delete(fn);
  }

  function setApiKey(key) {
    if (key && key.trim()) {
      localStorage.setItem(KEY_STORAGE, key.trim());
      setStatus("idle", "API key saved · ready");
    } else {
      localStorage.removeItem(KEY_STORAGE);
      setStatus("idle", "Waiting for API key");
    }
  }
  function getApiKey() {
    return localStorage.getItem(KEY_STORAGE) || "";
  }
  function clearApiKey() {
    localStorage.removeItem(KEY_STORAGE);
    setStatus("idle", "API key cleared");
  }

  function setGoogleKey(key) {
    if (key && key.trim()) localStorage.setItem(GBOOKS_KEY_STORAGE, key.trim());
    else localStorage.removeItem(GBOOKS_KEY_STORAGE);
  }
  function getGoogleKey() {
    return localStorage.getItem(GBOOKS_KEY_STORAGE) || "";
  }
  function clearGoogleKey() {
    localStorage.removeItem(GBOOKS_KEY_STORAGE);
  }

  // Strict category gate. Discovery is intentionally restricted to
  // novel-fiction erotica titles only. Results that fail this predicate
  // are dropped before rendering and before Claude enrichment.
  const EROTICA_CATEGORY_RE = /\berotic(a|ism)?\b/i;
  // Strong, unambiguous markers that a Google Books result is an erotica
  // novel (not "romance with heat", not literary fiction with sex scenes).
  const EROTICA_STRONG_RE = /\b(erotica|erotic (?:novel|fiction|romance|tale|stories|literature))\b/i;
  // Soft signals we accept only in combination with at least one other
  // signal (e.g. subject line + keyword, or category + keyword).
  const EROTICA_SOFT_RE = /\b(sensual|passionate|seductive|desire|lust|forbidden|taboo|bdsm|kink|fetish|explicit|adult fiction)\b/i;
  // Hard disqualifiers — non-fiction formats and adjacent genres that
  // should never pass the erotica-only gate, even if a keyword slips in.
  const NON_FICTION_BLOCK_RE = /\b(self[- ]?help|memoir|biography|cookbook|travel|history|academic|textbook|manual|guide|religion|spirituality|philosophy|business|parenting|poetry anthology)\b/i;

  function classifyEroticaMatch(item) {
    const cats = (item.categories || []).map(c => String(c).toLowerCase());
    const text = `${item.title || ""} ${item.description || ""}`;
    const catHit = cats.some(c => EROTICA_CATEGORY_RE.test(c));
    const strongHit = EROTICA_STRONG_RE.test(text);
    const softHit = EROTICA_SOFT_RE.test(text);
    // Apply the non-fiction block only to Google's structured categories,
    // not to the free-text description. Descriptions can mention "guide"
    // or "memoir" incidentally inside a legitimate erotica novel blurb.
    const blockedCat = cats.some(c => NON_FICTION_BLOCK_RE.test(c));
    // Admit only strict combinations:
    //  1. Google Books' own Erotica category, OR
    //  2. Explicit erotica phrasing in title/description, OR
    //  3. Soft sensuality signal AND an existing erotica category hit.
    // Anything else — including plain romance, literary fiction with sex
    // scenes, or non-fiction — is rejected.
    if (blockedCat) return { accepted: false, reason: "non-fiction category" };
    if (catHit) return { accepted: true, reason: "category=erotica" };
    if (strongHit) return { accepted: true, reason: "strong keyword match" };
    if (softHit && catHit) return { accepted: true, reason: "soft+category" };
    return { accepted: false, reason: "no erotica signal" };
  }

  // 1) Google Books search. Unauthenticated requests share a low daily quota;
  // pass a Google Books API key from Settings to raise the cap dramatically.
  // Throws an Error with a human-readable message the UI can render.
  // The query is always constrained to the Erotica subject so Google
  // Books returns candidates from the right shelf; the post-filter
  // double-checks each result before we hand it to the UI.
  async function searchBooks(query, maxResults = 6) {
    if (!query || !query.trim()) return [];
    const gkey = getGoogleKey();
    // Over-fetch so we still have enough cards after the strict
    // post-filter drops borderline results.
    const fetchCount = Math.max(maxResults * 3, 20);
    const normalized = query.trim();
    // subject:"Erotica" binds the entire search to the Erotica shelf on
    // Google Books. -subject:"Religion" etc. shaves off a few common
    // false positives that slip into the shelf.
    const q = `${normalized} subject:"Erotica" -subject:"Religion" -subject:"Self-Help"`;
    const url = "https://www.googleapis.com/books/v1/volumes"
      + "?q=" + encodeURIComponent(q)
      + "&maxResults=" + fetchCount
      + "&printType=books"
      + "&orderBy=relevance"
      + (gkey ? "&key=" + encodeURIComponent(gkey) : "");

    let res;
    try {
      res = await fetch(url);
    } catch (networkErr) {
      console.error("[Lumen Discovery] Network error calling Google Books:", networkErr);
      throw new Error("Can't reach Google Books — check your connection or see the console for the exact error.");
    }

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
      console.error("[Lumen Discovery] Google Books returned", res.status, detail);

      if (res.status === 429 || res.status === 403) {
        const err = new Error(gkey
          ? "Google Books rejected this key's quota (HTTP " + res.status + "). Check the key's daily limit in the Google Cloud console."
          : "Google Books daily quota exhausted on this network (HTTP " + res.status + "). Add a Google Books API key in Settings to raise the cap."
        );
        err.code = "quota";
        throw err;
      }
      throw new Error(`Google Books returned HTTP ${res.status}.` + (detail ? ` ${detail}` : ""));
    }

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error("[Lumen Discovery] Malformed Google Books response:", parseErr);
      throw new Error("Google Books returned an unreadable response.");
    }

    const items = (data.items || []).map(item => {
      const v = item.volumeInfo || {};
      return {
        id: "gb_" + item.id,
        title: v.title || "Untitled",
        author: (v.authors && v.authors[0]) || "Unknown author",
        authors: v.authors || [],
        year: (v.publishedDate || "").slice(0, 4),
        description: v.description || "No description available.",
        thumbnail: (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || null,
        categories: v.categories || [],
        sourceUrl: v.infoLink || v.canonicalVolumeLink || null,
        source: "Google Books"
      };
    });
    // Hard gate: drop anything that doesn't strongly match erotica. We
    // err on the side of rejecting borderline titles — the UI tells users
    // Discovery is intentionally erotica-only, so a short, strict result
    // set is the right behaviour.
    const filtered = [];
    for (const item of items) {
      const verdict = classifyEroticaMatch(item);
      if (verdict.accepted) filtered.push(item);
      else console.debug("[Lumen Discovery] dropped non-erotica result:", item.title, verdict.reason);
      if (filtered.length >= maxResults) break;
    }
    return filtered;
  }

  // Exposed so the analysis pipeline can apply the same rule on Claude's
  // classification (see analyzeWithClaude → isErotica).
  function isEroticaResult(item) {
    return classifyEroticaMatch(item).accepted;
  }

  // 2) Claude analysis
  // Returns { heat: 1-5, tropes: string[], insight: string }
  async function analyzeWithClaude(book) {
    const apiKey = getApiKey();
    if (!apiKey) {
      setStatus("error", "No API key set");
      throw new Error("missing-api-key");
    }

    setStatus("reading", `Claude is reading · ${book.title}`);

    const prompt = [
      "You are an editorial analyst for Lumen, a private reading companion for adult literature.",
      "Lumen's Discovery surface is intentionally restricted to novel-fiction erotica titles only.",
      "Analyze the book below and return ONLY a compact JSON object matching this schema:",
      '{ "isErotica": <boolean>, "heat": <integer 1-5>, "tropes": <array of 2-4 short lowercase strings>, "insight": <one calm sentence under 28 words> }.',
      "Rules:",
      "- isErotica = true ONLY if the book is fiction whose primary category is erotica / erotic fiction / erotic romance (explicit, sexual content is central, not incidental).",
      "  false for: general fiction, literary fiction with sex scenes, romance without explicit erotic focus, non-fiction, memoirs, self-help, manuals, poetry anthologies, or any borderline title. When in doubt, return false.",
      "- heat = overall sensual/erotic intensity on a 1 (barely-there) to 5 (unreserved) scale.",
      "- tropes = 2-4 concise narrative tropes (e.g. 'forbidden love', 'slow burn'). No quotes, no full stops.",
      "- insight = one non-judgemental sentence about what kind of reader this suits. Avoid hype. Do not make up facts.",
      "- Output strictly valid JSON, no prose, no backticks.",
      "",
      `Title: ${book.title}`,
      `Author: ${book.author}`,
      `Description: ${(book.description || "").slice(0, 1500)}`
    ].join("\n");

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }]
        })
      });
    } catch (err) {
      setStatus("error", "Network call failed");
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      setStatus("error", `Claude returned ${res.status}`);
      throw new Error(`claude-${res.status}: ${text}`);
    }

    const payload = await res.json();
    const textOut = (payload.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    const parsed = parseAnalysis(textOut);
    if (!parsed) {
      setStatus("error", "Could not parse Claude response");
      throw new Error("claude-parse-failed");
    }

    setStatus("online", `Analyzed · ${book.title}`);
    return parsed;
  }

  function parseAnalysis(raw) {
    if (!raw) return null;
    // Extract the first JSON object in the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]);
      const heat = Math.max(1, Math.min(5, parseInt(obj.heat, 10) || 3));
      const tropes = Array.isArray(obj.tropes) ? obj.tropes.filter(t => typeof t === "string").slice(0, 4) : [];
      const insight = typeof obj.insight === "string" ? obj.insight.trim() : "";
      // Default to true ONLY when the model explicitly says true. Any
      // other value — including missing/unknown — is treated as a
      // rejection so borderline titles never slip through.
      const isErotica = obj.isErotica === true;
      return { isErotica, heat, tropes, insight };
    } catch (e) {
      return null;
    }
  }

  window.LumenDiscovery = {
    setApiKey,
    getApiKey,
    clearApiKey,
    setGoogleKey,
    getGoogleKey,
    clearGoogleKey,
    searchBooks,
    analyzeWithClaude,
    isEroticaResult,
    onStatus,
    get status() { return state.status; },
    get message() { return state.lastMessage; }
  };
})();
