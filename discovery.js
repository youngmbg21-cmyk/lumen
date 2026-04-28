/* ============================================================
   Lumen — Discovery (Web search + Claude enrichment)
   Exposes window.LumenDiscovery with:
     setApiKey(key), getApiKey(),
     setAdminKey(key), getAdminKey(),
     searchBooks(query) -> Promise<rawGoogleItems[]>
     analyzeWithClaude(book) -> Promise<enrichedBook>
     onStatus(fn) -> unsubscribe; status in
       { idle | reading | online | error }

   Discovery Phase architecture — three-tier provider fallback:
     Priority 1: Edge proxy at /api/analyze
     Priority 2: Admin key (set by operator, stored in lumen:admin-key)
     Priority 3: User key (lumen:claude-key) for power users
   Session throttle: 10 AI calls per rolling 60-minute window.
   ============================================================ */
(function () {
  "use strict";

  const KEY_STORAGE          = "lumen:claude-key";
  const MASTER_KEY_STORAGE   = "lumen:master-key";
  const DEMO_MODE_STORAGE    = "lumen:demo-mode";
  const SESSION_CAP_STORAGE  = "lumen:session-cap";
  const GBOOKS_KEY_STORAGE   = "lumen:gbooks-key";
  const THROTTLE_KEY         = "lumen:throttle";   // sessionStorage
  const PROXY_URL            = "/api/analyze";
  const DEFAULT_THROTTLE_CAP = 10;
  const THROTTLE_WINDOW_MS   = 60 * 60 * 1000;

  // Migrate legacy lumen:admin-key → lumen:master-key on first load.
  (function _migrateLegacyAdminKey() {
    try {
      const legacy = localStorage.getItem("lumen:admin-key");
      if (legacy && !localStorage.getItem(MASTER_KEY_STORAGE)) {
        localStorage.setItem(MASTER_KEY_STORAGE, legacy);
      }
    } catch (e) { /* storage unavailable */ }
  })();

  const state = {
    status:      "idle",  // idle | reading | online | error
    lastMessage: "Ready"
  };
  const statusSubs = new Set();

  function setStatus(status, message) {
    state.status = status;
    state.lastMessage = message || defaultMessage(status);
    statusSubs.forEach(fn => { try { fn(state); } catch (e) { /* ignore */ } });
  }
  function defaultMessage(status) {
    if (status === "idle") {
      const { via } = resolveProvider();
      if (via === "admin") return "Bianca is online";
      if (via === "user")  return "Bianca is online · your key";
      if (via === "proxy") return "Bianca is online";
      return "Waiting for API key";
    }
    return {
      reading: "Bianca is reading…",
      online:  "Bianca is online",
      error:   "Analysis failed"
    }[status] || "";
  }

  function onStatus(fn) {
    statusSubs.add(fn);
    try { fn(state); } catch (e) {}
    return () => statusSubs.delete(fn);
  }

  // ── User key ──────────────────────────────────────────────────
  function setApiKey(key) {
    if (key && key.trim()) {
      localStorage.setItem(KEY_STORAGE, key.trim());
      setStatus("idle", "API key saved · ready");
    } else {
      localStorage.removeItem(KEY_STORAGE);
      setStatus("idle", "Ready");
    }
  }
  function getApiKey()  { return localStorage.getItem(KEY_STORAGE)  || ""; }
  function clearApiKey() {
    localStorage.removeItem(KEY_STORAGE);
    setStatus("idle", "API key cleared");
  }

  // ── Master key + Demo Mode + Session Cap (operator, Discovery Phase) ──
  function setMasterKey(key) {
    if (key && key.trim()) {
      localStorage.setItem(MASTER_KEY_STORAGE, key.trim());
      setStatus("idle");
    } else {
      localStorage.removeItem(MASTER_KEY_STORAGE);
      setStatus("idle");
    }
  }
  function getMasterKey()  { return localStorage.getItem(MASTER_KEY_STORAGE) || ""; }
  function clearMasterKey() { localStorage.removeItem(MASTER_KEY_STORAGE); setStatus("idle"); }

  function setDemoMode(on) {
    if (on) localStorage.setItem(DEMO_MODE_STORAGE, "1");
    else    localStorage.removeItem(DEMO_MODE_STORAGE);
    setStatus("idle");
  }
  function getDemoMode() { return !!localStorage.getItem(DEMO_MODE_STORAGE); }

  function setSessionCap(n) {
    const v = parseInt(n, 10);
    if (Number.isFinite(v) && v > 0) localStorage.setItem(SESSION_CAP_STORAGE, String(v));
    else localStorage.removeItem(SESSION_CAP_STORAGE);
  }
  function getSessionCap() {
    const v = parseInt(localStorage.getItem(SESSION_CAP_STORAGE), 10);
    return (Number.isFinite(v) && v > 0) ? v : DEFAULT_THROTTLE_CAP;
  }

  // Back-compat aliases so any existing call sites in app.js still work.
  const setAdminKey   = setMasterKey;
  const getAdminKey   = getMasterKey;
  const clearAdminKey = clearMasterKey;

  // ── Google Books key ──────────────────────────────────────────
  function setGoogleKey(key) {
    if (key && key.trim()) localStorage.setItem(GBOOKS_KEY_STORAGE, key.trim());
    else localStorage.removeItem(GBOOKS_KEY_STORAGE);
  }
  function getGoogleKey()  { return localStorage.getItem(GBOOKS_KEY_STORAGE) || ""; }
  function clearGoogleKey() { localStorage.removeItem(GBOOKS_KEY_STORAGE); }

  // ── Provider resolution: master (demo) → master (any) → user → none ──
  // When Demo Mode is ON the master key is used unconditionally so
  // visitors never see a "Waiting for API key" prompt. When Demo Mode
  // is OFF the master key still works but only for the operator.
  function resolveProvider() {
    const master = getMasterKey();
    if (master && getDemoMode()) return { via: "admin", key: master };
    if (master)                  return { via: "admin", key: master };
    const user = getApiKey();
    if (user)                    return { via: "user",  key: user };
    return { via: "proxy", key: null };
  }

  // ── Session throttle ──────────────────────────────────────────
  // Tracks timestamps of AI calls in sessionStorage. Drops entries
  // older than THROTTLE_WINDOW_MS so the limit is a rolling window,
  // not a hard session cap.
  function _readThrottle() {
    try {
      const raw = sessionStorage.getItem(THROTTLE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function _writeThrottle(list) {
    try { sessionStorage.setItem(THROTTLE_KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
  }
  function throttleRemaining() {
    const now  = Date.now();
    const recent = _readThrottle().filter(ts => now - ts < THROTTLE_WINDOW_MS);
    return Math.max(0, getSessionCap() - recent.length);
  }
  function _recordThrottledCall() {
    const now    = Date.now();
    const recent = _readThrottle().filter(ts => now - ts < THROTTLE_WINDOW_MS);
    recent.push(now);
    _writeThrottle(recent);
  }
  function _checkThrottle() {
    if (throttleRemaining() <= 0) {
      const err = new Error("session-throttled");
      err.code = "throttled";
      throw err;
    }
  }

  // Keywords that indicate a result is fiction/romance/erotica and should be kept.
  // Google Books categories are usually broad strings like "Fiction / Romance / General".
  const ROMANCE_KEEP = /romance|erotica|erotic|fiction|love stor|adult fiction/i;
  // Keywords that indicate a clearly non-fiction, non-genre result to discard.
  const ROMANCE_DROP = /education|academic|textbook|reference|science|history|biography|poetry|religion|cooking|travel|business|law|medical|computing|philosophy|psychology|self.?help|craft|art|music|sport/i;

  function isRomanceEligible(item) {
    const cats = (item.categories || []).join(" ");
    if (!cats) return true;           // no category data — let Claude decide
    if (ROMANCE_DROP.test(cats)) return false;
    return true;
  }

  // 1) Google Books search restricted to romance/fiction. Unauthenticated
  // requests share a low daily quota; pass a Google Books API key from
  // Settings to raise the cap dramatically.
  // Throws an Error with a human-readable message the UI can render.
  async function searchBooks(query, maxResults = 6) {
    if (!query || !query.trim()) return [];
    const gkey = getGoogleKey();
    // Fetch extra results because the post-filter may discard some.
    const fetchCount = Math.max(maxResults * 2, 16);
    // subject:romance biases Google Books toward the romance/erotica shelf
    // without hard-blocking books filed under plain "Fiction".
    const q = query.trim() + " subject:romance";
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

    const filtered = items.filter(isRomanceEligible);
    // Return filtered results; if filtering removed everything fall back to
    // the unfiltered set so the user isn't left with a blank page.
    return (filtered.length ? filtered : items).slice(0, maxResults);
  }

  // ── Low-level Claude POST helper ─────────────────────────────
  // Shared by analyzeWithClaude, enrichCatalogEntry, chatWithBianca.
  // Tries the edge proxy first when a proxyPayload is supplied;
  // falls back to direct Anthropic API using the resolved key.
  async function _claudePost({ directPayload, proxyPayload = null }) {
    // Proxy attempt — fire-and-forget on 404/network so local dev
    // works without a running server.
    if (proxyPayload) {
      try {
        const pr = await fetch(PROXY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proxyPayload)
        });
        if (pr.ok) return await pr.json();
        if (pr.status !== 404 && pr.status !== 405) {
          const txt = await pr.text().catch(() => "");
          throw new Error(`proxy-${pr.status}: ${txt.slice(0, 200)}`);
        }
        // 404/405 = no proxy deployed; fall through to direct call.
      } catch (netErr) {
        if (netErr.message && netErr.message.startsWith("proxy-")) throw netErr;
        // Network error (no server at all) → fall through silently.
      }
    }

    // Direct Anthropic API — requires a key.
    const { via, key } = resolveProvider();
    if (!key) {
      setStatus("error", "No API key — add one in Admin");
      const err = new Error("missing-api-key");
      err.code  = "missing-api-key";
      throw err;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json"
      },
      body: JSON.stringify(directPayload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const label = via === "admin" ? "Admin key" : "API key";
      setStatus("error", `${label} · Claude returned ${res.status}`);
      throw new Error(`claude-${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // ── 2) Quick analysis: heat + tropes + insight ────────────────
  // Returns { heat: 1-5, tropes: string[], insight: string }
  async function analyzeWithClaude(book) {
    _checkThrottle();
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

    const directPayload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    };

    let payload;
    try {
      payload = await _claudePost({
        directPayload,
        proxyPayload: { action: "analyze", book: { title: book.title, author: book.author, description: (book.description || "").slice(0, 1500) } }
      });
    } catch (err) {
      setStatus("error", "Analysis failed");
      throw err;
    }

    _recordThrottledCall();

    const textOut = (payload.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("\n").trim();

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

    async function gbFetch(q) {
      const url = "https://www.googleapis.com/books/v1/volumes"
        + "?q=" + encodeURIComponent(q)
        + "&maxResults=8"
        + "&printType=books"
        + "&orderBy=relevance"
        + (gkey ? "&key=" + encodeURIComponent(gkey) : "");
      try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.items || []).map(it => it.volumeInfo || {});
      } catch (e) { return []; }
    }

    function upgradeThumb(url) {
      if (!url) return null;
      return String(url).replace(/^http:/, "https:").replace(/zoom=\d+/, "zoom=5");
    }

    function pickBest(items) {
      if (!items.length) return null;
      const titleLc = input.title.toLowerCase();
      const scored = items.map(v => {
        const hasThumb = !!(v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail));
        const t = String(v.title || "").toLowerCase();
        const titleHit = t === titleLc ? 3 : t.includes(titleLc) ? 2 : titleLc.includes(t) ? 1 : 0;
        return { v, hasThumb, titleHit, score: titleHit * 2 + (hasThumb ? 3 : 0) };
      }).sort((a, b) => b.score - a.score);
      // Prefer any result that has a thumbnail and at least a partial title match.
      // Falls back to the top scorer (which may have no thumbnail).
      const best = scored.find(s => s.hasThumb && s.titleHit >= 1) || scored[0];
      const v = best.v;
      const raw = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
      return {
        thumbnail: upgradeThumb(raw),
        year: (v.publishedDate || "").slice(0, 4) ? parseInt(v.publishedDate.slice(0, 4), 10) : null,
        description: v.description || null,
        categories: v.categories || []
      };
    }

    // 1) Strict query: intitle:"X" inauthor:"Y"
    const strictParts = [`intitle:"${input.title.replace(/"/g, "")}"`];
    if (input.author) strictParts.push(`inauthor:"${String(input.author).replace(/"/g, "")}"`);
    let items = await gbFetch(strictParts.join(" "));

    // 2) If strict query found nothing with a thumbnail, retry with a loose query.
    const hasThumb = items.some(v => v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail));
    if (!hasThumb) {
      const loose = await gbFetch(`${input.title}${input.author ? " " + input.author : ""}`);
      if (loose.length) items = loose;
    }

    return pickBest(items);
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

    let payload;
    try {
      payload = await _claudePost({
        directPayload: {
          model: "claude-sonnet-4-6",
          max_tokens: 900,
          messages: [{ role: "user", content: prompt }]
        }
      });
    } catch (err) {
      setStatus("error", "Network call failed");
      throw err;
    }

    _recordThrottledCall();

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
  // chatWithBianca — the LLM path for the persistent companion.
  //   args = {
  //     systemContext:   string (the "=== CONTEXT ===" block, built
  //                       in app.js from the structured Bianca ctx)
  //     messages:        [{ role: "user" | "assistant", content: string }]
  //   }
  // Returns the assistant's text on success. On any failure (no
  // key, network, parse, rate limit) throws an Error that the
  // caller converts into Bianca's graceful fail-safe line.
  //
  // Persona prompt comes from window.LumenBiancaPersona.PERSONA_PROMPT
  // (see bianca-persona.js) and is prepended to the systemContext so
  // both land in Claude's `system` field.
  // ----------------------------------------------------------------
  async function chatWithBianca({ systemContext = "", messages = [] } = {}) {
    _checkThrottle();

    const persona = (window.LumenBiancaPersona && window.LumenBiancaPersona.PERSONA_PROMPT) || "";
    const system  = persona + (systemContext ? "\n\n=== CONTEXT ===\n" + systemContext : "");

    // Sanitize: must alternate user/assistant starting with user.
    const clean = [];
    for (const m of messages) {
      if (!m || !m.content) continue;
      const role = m.role === "assistant" || m.role === "user" ? m.role : null;
      if (!role) continue;
      const last = clean[clean.length - 1];
      if (last && last.role === role) last.content += "\n\n" + String(m.content);
      else clean.push({ role, content: String(m.content) });
    }
    while (clean.length && clean[0].role !== "user") clean.shift();
    if (!clean.length) throw new Error("empty-conversation");

    setStatus("reading", "Bianca is thinking…");

    let payload;
    try {
      payload = await _claudePost({
        directPayload: {
          model: "claude-sonnet-4-6",
          max_tokens: 150,   // Discovery Mode: concise replies, budget-safe
          system,
          messages: clean
        },
        proxyPayload: { action: "chat", model: "claude-sonnet-4-6", max_tokens: 150, system, messages: clean }
      });
    } catch (err) {
      setStatus("error", "Network call failed");
      throw err;
    }

    _recordThrottledCall();

    const out = (payload.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (!out) { setStatus("error", "Empty reply"); throw new Error("claude-empty-reply"); }
    setStatus("online", "Bianca is online");
    return out;
  }

  // Seed the initial status badge based on whichever provider is active.
  // Runs after all functions are defined so resolveProvider() is available.
  setStatus("idle");

  window.LumenDiscovery = {
    // User key
    setApiKey, getApiKey, clearApiKey,
    hasKey: () => resolveProvider().via !== "none",
    // Master key + Demo Mode + Session Cap (operator, Discovery Phase)
    setMasterKey, getMasterKey, clearMasterKey,
    setDemoMode, getDemoMode,
    setSessionCap, getSessionCap,
    // Back-compat aliases
    setAdminKey, getAdminKey, clearAdminKey,
    // Google Books key
    setGoogleKey, getGoogleKey, clearGoogleKey,
    // Throttle introspection
    throttleRemaining,
    // Core API
    searchBooks,
    analyzeWithClaude,
    enrichCatalogEntry,
    lookupBookMetadata,
    chatWithBianca,
    onStatus,
    get status()  { return state.status; },
    get message() { return state.lastMessage; }
  };
})();
