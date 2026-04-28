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
   Session throttle: 30 AI calls per calendar day (00:00–23:59).
   ============================================================ */
(function () {
  "use strict";

  const KEY_STORAGE          = "lumen:claude-key";
  const MASTER_KEY_STORAGE   = "lumen:master-key";
  const DEMO_MODE_STORAGE    = "lumen:demo-mode";
  const SESSION_CAP_STORAGE  = "lumen:session-cap";
  const GBOOKS_KEY_STORAGE   = "lumen:gbooks-key";
  const THROTTLE_KEY         = "lumen:throttle";   // localStorage
  const PROXY_URL            = "/api/analyze";
  const DEFAULT_THROTTLE_CAP = 30;

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

  // ── Session throttle (disabled) ───────────────────────────────
  // Limit is currently off. throttleRemaining() returns Infinity and
  // _checkThrottle() is a no-op so all call sites pass through unchanged.
  function throttleRemaining() { return Infinity; }
  function _recordThrottledCall() { /* no-op */ }
  function _checkThrottle() { /* no-op */ }

  // Category-level signals for non-romance/non-fiction books.
  const ROMANCE_DROP = /education|academic|textbook|reference|science|history|biography|poetry|religion|cooking|travel|business|law|medical|computing|philosophy|psychology|self.?help|craft|art|music|sport|criticism|anthology|journalism|language arts/i;

  // Description-level signals used when Google Books returns no category metadata.
  // DROP wins over KEEP — e.g. "encyclopedia of romance" is still a reference work.
  const DESC_DROP = /encyclopedia|handbook|workbook|guidebook|self.?help|self.?improvement|how.to|therapy|therapist|detective|murder|mystery|thriller|crime|investigation|horror|parenting|cookbook|recipe|nutrition|fitness|academic|dissertation|research study|collects essays|collection of essays|anthology of/i;
  const DESC_KEEP = /romance novel|romantic comedy|rom.?com|love story|falling in love|meet cute|enemies.to.lovers|second chance|fake dating|steamy|swoon|happily ever after|love interest|fated|heart.*flutter|forbidden love|billionaire.*love|small.town.*love|marriage.*romance|fake.*relationship|arranged.*marriage/i;

  function isRomanceEligible(item) {
    const year = parseInt(item.year, 10);
    if (!isNaN(year) && year < 1950) return false;

    const cats = (item.categories || []).join(" ");
    if (cats) return !ROMANCE_DROP.test(cats);

    // No category metadata — use description signals.
    // DESC_DROP eliminates reference works, thrillers, self-help, etc.
    // DESC_KEEP confirms actual romance fiction language.
    // Books with neither signal are too ambiguous to include.
    const desc = item.description || "";
    if (DESC_DROP.test(desc)) return false;
    if (DESC_KEEP.test(desc)) return true;
    return false;
  }

  function _upgradeThumb(url) {
    if (!url) return null;
    return String(url).replace(/^http:/, "https:").replace(/zoom=\d+/, "zoom=5");
  }

  function _mapGBItem(item) {
    const v = item.volumeInfo || {};
    const rawThumb = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
    return {
      id:          "gb_" + item.id,
      title:       v.title || "Untitled",
      author:      (v.authors && v.authors[0]) || "Unknown author",
      authors:     v.authors || [],
      year:        (v.publishedDate || "").slice(0, 4),
      description: v.description || "No description available.",
      thumbnail:   _upgradeThumb(rawThumb),
      categories:  v.categories || [],
      sourceUrl:   v.infoLink || v.canonicalVolumeLink || null,
      source:      "Google Books"
    };
  }

  // Parse "Title — Author", "Title by Author", or bare title.
  function _parseQueryIntent(query) {
    const q = query.trim();
    const dashMatch = q.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    if (dashMatch) return { title: dashMatch[1].trim(), author: dashMatch[2].trim() };
    const byMatch = q.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) return { title: byMatch[1].trim(), author: byMatch[2].trim() };
    return { title: q, author: null };
  }

  async function _gbFetch(q, maxResults, gkey, _attempt) {
    _attempt = _attempt || 1;
    const url = "https://www.googleapis.com/books/v1/volumes"
      + "?q=" + encodeURIComponent(q)
      + "&maxResults=" + maxResults
      + "&printType=books"
      + "&orderBy=relevance"
      + (gkey ? "&key=" + encodeURIComponent(gkey) : "");
    let res;
    try {
      res = await fetch(url);
    } catch (networkErr) {
      console.error("[Lumen Discovery] Network error calling Google Books:", networkErr);
      throw new Error("Can't reach Google Books — check your connection and try again.");
    }
    if (!res.ok) {
      console.error("[Lumen Discovery] Google Books returned", res.status);
      if (res.status === 429 || res.status === 403) {
        const err = new Error(gkey
          ? "Google Books rejected this key's quota. Check the key's daily limit in the Google Cloud console."
          : "Google Books daily quota exhausted on this network. Add a Google Books API key in Settings to raise the cap."
        );
        err.code = "quota";
        throw err;
      }
      // Retry once on transient server errors (5xx).
      if (res.status >= 500 && _attempt < 3) {
        await new Promise(r => setTimeout(r, _attempt * 1500));
        return _gbFetch(q, maxResults, gkey, _attempt + 1);
      }
      throw new Error("Google Books is temporarily unavailable — please try again in a moment.");
    }
    let data;
    try { data = await res.json(); } catch (e) {
      throw new Error("Google Books returned an unreadable response.");
    }
    return (data.items || []).map(_mapGBItem);
  }

  // Derive the romance subgenre label from a book's category metadata.
  function _subgenreFor(anchor) {
    const cats = (anchor.categories || []).join(" ");
    if (/contemporary/i.test(cats))                         return "contemporary romance";
    if (/historical/i.test(cats))                           return "historical romance";
    if (/paranormal|supernatural|fantasy/i.test(cats))      return "paranormal romance";
    if (/suspense|thriller|mystery/i.test(cats))            return "romantic suspense";
    if (/erotic/i.test(cats))                               return "erotic romance";
    return "romance";
  }

  // Build a thematic search query from description keywords + subgenre.
  // Never uses title words so searching "Pucked Up" finds hockey-romance
  // reads rather than other books with "pucked" in the title.
  function _similarityQuery(anchor) {
    const subgenre = _subgenreFor(anchor);

    const stopwords = new Set([
      "the","and","for","with","from","that","this","have","its","was","but","not",
      "you","all","are","just","into","more","when","than","your","will","also","been",
      "about","once","after","they","them","their","what","which","there","then","some",
      "she","her","him","his","who","had","has","being","would","could","should","only",
      "even","back","like","know","love","make","take","come","look","want","need","find",
      "keep","tell","well","much","many","such","over","most","both","each","very","still",
      "own","good","give","think","where","before","every","never","these","those","here",
      "since","while","until","does","did","said","same","long","down","high","very"
    ]);
    const titleWords = new Set(
      anchor.title.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z]/g, "")).filter(Boolean)
    );
    const desc = (anchor.description || "").replace(/No description available\.?/i, "");
    const descSeeds = desc
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z]/g, "").toLowerCase())
      .filter(w => w.length >= 5 && !stopwords.has(w) && !titleWords.has(w))
      .slice(0, 2)
      .join(" ");

    return descSeeds ? `${descSeeds} ${subgenre} fiction` : `${subgenre} fiction`;
  }

  // A book is usable only if it has both a real cover and a description.
  // Google Books returns thumbnail URLs even for editions with no cover art,
  // and those coverless editions almost always lack a description too.
  function _hasGoodMeta(b) {
    return !!b.thumbnail && b.description !== "No description available.";
  }

  // Two-phase search:
  //   Phase 1 — find the best matching edition of the searched book,
  //             preferring editions that have a cover and description.
  //   Phase 2 — fill remaining slots with in-genre books that have covers.
  //             Falls back to a broader subgenre query if the first pass
  //             doesn't yield enough results.
  async function searchBooks(query, maxResults = 6) {
    if (!query || !query.trim()) return [];
    const gkey = getGoogleKey();
    const { title, author } = _parseQueryIntent(query.trim());

    // Phase 1 — pick the edition with the best title match AND metadata.
    const strictParts = [`intitle:"${title.replace(/"/g, "")}"`];
    if (author) strictParts.push(`inauthor:"${author.replace(/"/g, "")}"`);
    let exactBook = null;
    try {
      const exactItems = await _gbFetch(strictParts.join(" "), 10, gkey);
      if (exactItems.length) {
        const titleLc = title.toLowerCase();
        const scored = exactItems
          .map(b => {
            const t = b.title.toLowerCase();
            const titleScore = t === titleLc ? 3 : t.includes(titleLc) ? 2 : titleLc.includes(t) ? 1 : 0;
            const metaScore  = (b.thumbnail ? 2 : 0) + (_hasGoodMeta(b) ? 1 : 0);
            return { b, score: titleScore * 10 + metaScore };
          })
          .sort((a, b_) => b_.score - a.score);
        exactBook = scored[0].b;
        exactBook.isExactMatch = true;
      }
    } catch (e) {
      console.warn("[Lumen Discovery] Exact lookup failed:", e.message);
    }

    // Phase 2 — collect in-genre books with covers and descriptions.
    const similarCount  = maxResults - (exactBook ? 1 : 0);
    const exactTitleLc  = exactBook ? exactBook.title.toLowerCase() : "";
    const seen          = new Set([exactTitleLc]);

    function filterSim(items) {
      return items
        .filter(b => !seen.has(b.title.toLowerCase()))
        .filter(_hasGoodMeta)
        .filter(isRomanceEligible);
    }

    // First pass — description-seeded query for thematic variety.
    const simQuery   = exactBook ? _similarityQuery(exactBook) : `${title} romance fiction`;
    const simItems   = await _gbFetch(simQuery, Math.max(similarCount * 6, 30), gkey);
    let similar      = filterSim(simItems).slice(0, similarCount);
    similar.forEach(b => seen.add(b.title.toLowerCase()));

    // Second pass — broaden to subgenre-only if still short.
    if (similar.length < similarCount) {
      const subgenre    = _subgenreFor(exactBook || { categories: [] });
      const moreItems   = await _gbFetch(`${subgenre} fiction`, Math.max((similarCount - similar.length) * 8, 30), gkey);
      const more        = filterSim(moreItems).slice(0, similarCount - similar.length);
      similar           = [...similar, ...more];
    }

    return exactBook ? [exactBook, ...similar] : similar.slice(0, maxResults);
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

    const upgradeThumb = _upgradeThumb;

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
