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

  // 1) Google Books search
  async function searchBooks(query, maxResults = 6) {
    if (!query || !query.trim()) return [];
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query.trim())}&maxResults=${maxResults}&printType=books`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Books ${res.status}`);
    const data = await res.json();
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
    return items;
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
      "Analyze the book below and return ONLY a compact JSON object matching this schema:",
      '{ "heat": <integer 1-5>, "tropes": <array of 2-4 short lowercase strings>, "insight": <one calm sentence under 28 words> }.',
      "Rules:",
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
      return { heat, tropes, insight };
    } catch (e) {
      return null;
    }
  }

  window.LumenDiscovery = {
    setApiKey,
    getApiKey,
    clearApiKey,
    searchBooks,
    analyzeWithClaude,
    onStatus,
    get status() { return state.status; },
    get message() { return state.lastMessage; }
  };
})();
