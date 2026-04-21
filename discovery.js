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

  // 1) Google Books search. Unauthenticated requests share a low daily quota;
  // pass a Google Books API key from Settings to raise the cap dramatically.
  // Throws an Error with a human-readable message the UI can render.
  // No category filtering — users can search for any title, author, or
  // topic and add any result to their Library.
  async function searchBooks(query, maxResults = 6) {
    if (!query || !query.trim()) return [];
    const gkey = getGoogleKey();
    const fetchCount = Math.max(maxResults, 10);
    const q = query.trim();
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
    return items.slice(0, maxResults);
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

  // ----------------------------------------------------------------
  // Lightweight metadata lookup for a known title/author pair. Used by
  // the catalog enrichment pipeline to attach a cover thumbnail, a
  // publication year, and (optionally) a richer description the AI
  // can reason against. Returns `null` if Google Books has no good
  // match — the enrichment continues without the cover.
  // ----------------------------------------------------------------
  async function lookupBookMetadata(input) {
    if (!input || !input.title) return null;
    const gkey = getGoogleKey();
    const parts = [`intitle:"${input.title.replace(/"/g, "")}"`];
    if (input.author) parts.push(`inauthor:"${String(input.author).replace(/"/g, "")}"`);
    const q = parts.join(" ");
    const url = "https://www.googleapis.com/books/v1/volumes"
      + "?q=" + encodeURIComponent(q)
      + "&maxResults=5"
      + "&printType=books"
      + "&orderBy=relevance"
      + (gkey ? "&key=" + encodeURIComponent(gkey) : "");
    let res;
    try { res = await fetch(url); }
    catch (e) { return null; }
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch (e) { return null; }
    const items = (data.items || []).map(it => it.volumeInfo || {});
    if (!items.length) return null;
    // Prefer the first result that has both a thumbnail and a
    // reasonably close title. Falls back to the top result.
    const titleLc = input.title.toLowerCase();
    const scored = items.map(v => {
      const hasThumb = !!(v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail));
      const t = String(v.title || "").toLowerCase();
      const titleHit = t === titleLc ? 3 : t.includes(titleLc) ? 2 : titleLc.includes(t) ? 1 : 0;
      return { v, score: titleHit + (hasThumb ? 1 : 0) };
    }).sort((a, b) => b.score - a.score);
    const v = scored[0].v;
    const thumb = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
    return {
      thumbnail: thumb ? String(thumb).replace(/^http:/, "https:") : null,
      year: (v.publishedDate || "").slice(0, 4) ? parseInt(v.publishedDate.slice(0, 4), 10) : null,
      description: v.description || null,
      categories: v.categories || []
    };
  }

  // ----------------------------------------------------------------
  // Catalog enrichment — takes a minimal input (title + author,
  // optional description) and returns a fully scored catalog entry
  // matching the schema in data/CATALOG.md. Used by the in-app
  // importer so the user can paste a title list and have Claude
  // fill in the scoring metadata. Every field is marked "ai" in
  // the returned _source map so downstream re-enrichment knows
  // what is safe to overwrite vs. what the human has edited.
  // ----------------------------------------------------------------
  async function enrichCatalogEntry(input) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("missing-api-key");
    if (!input || !input.title) throw new Error("missing-title");

    // 1) Look up cover + year + description on Google Books.
    // This runs first so we can pass any richer description to
    // Claude for better scoring, and so the thumbnail URL is
    // attached even if Claude scoring fails later.
    setStatus("reading", `Finding cover · ${input.title}`);
    let gb = null;
    try { gb = await lookupBookMetadata(input); } catch (e) { gb = null; }

    setStatus("reading", `Claude is scoring · ${input.title}`);

    const effectiveDescription = input.description || (gb && gb.description) || "";

    const schemaHint = [
      '{',
      '  "category": "slug e.g. contemporary-erotic-romance | historical-erotic-literature | literary-erotica",',
      '  "subgenre": "slug (optional, short)",',
      '  "year": integer (4-digit, negative for BCE; 0 if unknown),',
      '  "description": "1-3 sentence editorial blurb",',
      '  "heat_level": 1..5,',
      '  "explicitness": 1..5,',
      '  "emotional_intensity": 1..5,',
      '  "consent_clarity": 1..5,',
      '  "taboo_level": 1..5,',
      '  "plot_weight": 1..5,',
      '  "tone": ["lowercase-slug", ...],',
      '  "pacing": ["..."],',
      '  "literary_style": ["..."],',
      '  "relationship_dynamic": ["..."],',
      '  "trope_tags": ["..."],',
      '  "kink_tags": ["..."],',
      '  "gender_pairing": ["m/f", "f/f", "m/m", "m/f/f", ...],',
      '  "orientation_tags": ["hetero-dominant", "queer", "polymorphous", ...],',
      '  "content_warnings": ["..."],',
      '  "confidence": 0..100',
      '}'
    ].join("\n");

    const prompt = [
      "You are an editorial analyst for Lumen, a private reading companion for adult-fiction readers (erotica novels).",
      "For the book below, return ONLY a compact JSON object matching this schema — no prose, no markdown fences, no commentary:",
      schemaHint,
      "",
      "Rules:",
      "- All numeric 1..5 fields are REQUIRED integers; reason carefully about what the book actually is.",
      "- heat_level = overall sensual/erotic intensity; 1 implied, 5 unreserved explicit-throughout.",
      "- explicitness = directness of the prose (veiled metaphor → clinically direct).",
      "- emotional_intensity = how much emotional weight the text carries.",
      "- consent_clarity = 5 = on-page enthusiastic consent; lower values tolerate period-typical or ambiguous framings. When uncertain err LOW.",
      "- taboo_level = how transgressive the content is for a modern mainstream reader.",
      "- plot_weight = 1 = scene-heavy, 5 = strong narrative architecture.",
      "- Tag arrays must be lowercase slugs (dash-separated if multi-word). 2–4 values each when possible; empty arrays are acceptable.",
      "- gender_pairing: use m/f, m/m, f/f, m/f/f, etc.",
      "- content_warnings: BE CONSERVATIVE — err toward INCLUDING a warning. Use slugs like 'consent-ambiguity', 'dated-attitudes', 'period-typical-problematic-content', 'power-imbalance', 'underage-content-highly-disturbing', 'incest-theme', 'exploitation', 'self-negation'.",
      "- confidence: 0..100 — your confidence in the scoring overall.",
      "- If the book is not a work of fiction (it's a guide, essay, psychology text, self-help, etc.) return {\"error\": \"not-fiction\"} INSTEAD of the schema above.",
      "",
      `Title: ${input.title}`,
      `Author: ${input.author || "Unknown"}`,
      effectiveDescription ? `Description: ${String(effectiveDescription).slice(0, 1500)}` : "Description: (not provided; use your background knowledge)"
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
          max_tokens: 900,
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
      .filter(b => b.type === "text").map(b => b.text).join("\n").trim();

    // Parse + normalize. Missing numeric fields are rejected (the
    // whole row fails); unknown tag values are kept so the importer
    // can surface them as "new vocab terms" in the preview report.
    const m = textOut.match(/\{[\s\S]*\}/);
    if (!m) { setStatus("error", "Could not parse Claude response"); throw new Error("claude-parse-failed"); }
    let obj;
    try { obj = JSON.parse(m[0]); }
    catch (e) { setStatus("error", "Invalid JSON"); throw new Error("claude-json-invalid"); }

    if (obj.error === "not-fiction") {
      setStatus("online", `Not fiction · ${input.title}`);
      const e = new Error("not-fiction");
      e.code = "not-fiction";
      throw e;
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
    const requireNumeric = (k) => {
      const v = Number(obj[k]);
      if (!Number.isFinite(v)) throw new Error(`ai-missing-${k}`);
      return clamp(v, 1, 5);
    };
    const normList = (v) => {
      if (!Array.isArray(v)) return [];
      const out = [];
      const seen = new Set();
      for (const raw of v) {
        if (typeof raw !== "string") continue;
        const s = raw.trim().toLowerCase().replace(/\s+/g, "-");
        if (!s || seen.has(s)) continue;
        seen.add(s); out.push(s);
      }
      return out;
    };

    const enriched = {
      title: input.title,
      author: input.author || "Unknown",
      year: (gb && gb.year) || (Number.isFinite(Number(obj.year)) ? parseInt(obj.year, 10) || 0 : 0),
      category: (typeof obj.category === "string" && obj.category.trim()) || "erotica-fiction",
      subgenre: (typeof obj.subgenre === "string" && obj.subgenre.trim()) || "",
      description: (typeof obj.description === "string" && obj.description.trim())
        || effectiveDescription
        || input.description
        || "No description available.",
      thumbnail: (gb && gb.thumbnail) || null,
      heat_level: requireNumeric("heat_level"),
      explicitness: requireNumeric("explicitness"),
      emotional_intensity: requireNumeric("emotional_intensity"),
      consent_clarity: requireNumeric("consent_clarity"),
      taboo_level: requireNumeric("taboo_level"),
      plot_weight: requireNumeric("plot_weight"),
      tone: normList(obj.tone),
      pacing: normList(obj.pacing),
      literary_style: normList(obj.literary_style),
      relationship_dynamic: normList(obj.relationship_dynamic),
      trope_tags: normList(obj.trope_tags),
      kink_tags: normList(obj.kink_tags),
      gender_pairing: normList(obj.gender_pairing),
      orientation_tags: normList(obj.orientation_tags),
      content_warnings: normList(obj.content_warnings)
    };

    // Provenance: every field that came from the model is marked
    // "ai" so a later human edit can flip a single field to
    // "human" and re-enrichment won't overwrite it. Fields we
    // pulled from Google Books (thumbnail, year) are marked
    // "google-books" so a future refresh knows they can be re-
    // resolved from the same source without touching the AI scores.
    const _source = {};
    Object.keys(enriched).forEach(k => { _source[k] = "ai"; });
    if (gb && gb.thumbnail) _source.thumbnail = "google-books";
    if (gb && gb.year) _source.year = "google-books";

    setStatus("online", `Scored · ${input.title}`);
    return {
      book: enriched,
      _source,
      confidence: Number.isFinite(Number(obj.confidence)) ? clamp(Number(obj.confidence), 0, 100) : null
    };
  }

  // ----------------------------------------------------------------
  // chatWithSara — the LLM path for the persistent companion.
  //   args = {
  //     systemContext:   string (the "=== CONTEXT ===" block, built
  //                       in app.js from the structured Sara ctx)
  //     messages:        [{ role: "user" | "assistant", content: string }]
  //   }
  // Returns the assistant's text on success. On any failure (no
  // key, network, parse, rate limit) throws an Error that the
  // caller converts into Sara's graceful fail-safe line.
  //
  // Persona prompt comes from window.LumenSaraPersona.PERSONA_PROMPT
  // (see sara-persona.js) and is prepended to the systemContext so
  // both land in Claude's `system` field.
  // ----------------------------------------------------------------
  async function chatWithSara({ systemContext = "", messages = [] } = {}) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("missing-api-key");
    const persona = (window.LumenSaraPersona && window.LumenSaraPersona.PERSONA_PROMPT) || "";
    const system = persona + (systemContext ? "\n\n=== CONTEXT ===\n" + systemContext : "");
    // Sanitize messages: must alternate user/assistant and start on
    // user; Claude rejects other shapes. We filter out empty/non-
    // text messages and coalesce consecutive same-role turns.
    const clean = [];
    for (const m of messages) {
      if (!m || !m.content) continue;
      const role = m.role === "assistant" || m.role === "user" ? m.role : null;
      if (!role) continue;
      const last = clean[clean.length - 1];
      if (last && last.role === role) last.content += "\n\n" + String(m.content);
      else clean.push({ role, content: String(m.content) });
    }
    // Drop leading assistant turn if present.
    while (clean.length && clean[0].role !== "user") clean.shift();
    if (!clean.length) throw new Error("empty-conversation");

    setStatus("reading", "Bianca is thinking…");
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
          max_tokens: 600,
          system,
          messages: clean
        })
      });
    } catch (err) {
      setStatus("error", "Network call failed");
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      setStatus("error", `Claude returned ${res.status}`);
      throw new Error(`claude-${res.status}: ${txt.slice(0, 200)}`);
    }
    const payload = await res.json();
    const out = (payload.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();
    if (!out) { setStatus("error", "Empty reply"); throw new Error("claude-empty-reply"); }
    setStatus("online", "Bianca is here");
    return out;
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
    enrichCatalogEntry,
    lookupBookMetadata,
    chatWithSara,
    onStatus,
    get status() { return state.status; },
    get message() { return state.lastMessage; }
  };
})();
