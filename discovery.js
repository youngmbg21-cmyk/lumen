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

  // ============================================================
  // Strict erotica-only gate. Discovery surfaces only novel-fiction
  // erotica. The filter is deliberately aggressive — results are
  // rejected by default unless they positively clear every rule.
  //
  // The gate has three layers:
  //   1. Metadata requirements  — a category must literally contain
  //      the word "erotica" (not merely "erotic").
  //   2. Category blocklist     — full Google Books BISAC-derived
  //      category names that never belong in this surface.
  //   3. Title / description    — blocklist of non-fiction and
  //      adjacent-genre patterns (workbook, handbook, psychology of,
  //      how to, workplace, leadership, academic, case study, etc.).
  // Any single failing rule rejects the result.
  //
  // Claude's classifier is the second independent layer and applies
  // four signals: isErotica, confidence (>=75), format in {erotica-
  // novel, erotic-romance-novel}, and containsNonfictionSignal=false.
  // ============================================================

  // Strict category match: the literal word "erotica". "erotic"
  // alone (as in "erotic love" in a psychology category) must NOT
  // pass. Word boundaries only.
  const EROTICA_CATEGORY_EXACT_RE = /\berotica\b/i;

  // Google Books uses BISAC-derived category strings like
  // "Psychology / Human Sexuality", "Social Science / Gender Studies",
  // "Family & Relationships / Love & Romance", "Body, Mind & Spirit /
  // Sexuality", "Business & Economics / Workplace Culture", etc. Any
  // category matching this pattern instantly disqualifies the book.
  const DISALLOWED_CATEGORY_RE = new RegExp([
    "\\bpsychology\\b",
    "\\bsociology\\b",
    "\\bsocial\\s*science(?:s)?\\b",
    "\\bself[- ]?help\\b",
    "\\bbusiness\\b",
    "\\beconomics\\b",
    "\\bfamily\\b",
    "\\brelationships?\\b",
    "\\breligion\\b",
    "\\bspirituality\\b",
    "\\bhealth\\b",
    "\\bfitness\\b",
    "\\bphilosophy\\b",
    "\\bpolitical\\s*science\\b",
    "\\bmedical\\b",
    "\\beducation\\b",
    "\\breference\\b",
    "\\blaw\\b",
    "\\bscience\\b",
    "\\btechnology\\b",
    "\\btravel\\b",
    "\\bbiography\\b",
    "\\bautobiography\\b",
    "\\bhistory\\b",
    "\\btrue\\s*crime\\b",
    "\\bcooking\\b",
    "\\bcookbook\\b",
    "\\bjuvenile\\b",
    "\\byoung\\s*adult\\b",
    "\\bchildren(?:'s)?\\b",
    "\\bcomics\\b",
    "\\bgraphic\\s*novels?\\b",
    "\\bcrafts\\b",
    "\\bhobbies\\b",
    "\\bgames\\b",
    "\\bgardening\\b",
    "\\bperforming\\s*arts\\b",
    "\\bsports\\b",
    "\\btransportation\\b",
    "\\bstudy\\s*aids\\b",
    "\\bnature\\b",
    "\\bhouse\\b",
    "\\bhome\\b",
    "\\barchitecture\\b",
    "\\bmusic\\b",
    "\\bdrama\\b",
    "\\bart\\b",
    "\\bliterary\\s*criticism\\b",
    "\\bcriticism\\b",
    "\\bessays?\\b",
    "\\bpoetry\\b",
    "\\bmemoir(?:s)?\\b",
    "\\bparenting\\b",
    "\\bmanual(?:s)?\\b",
    "\\btextbook(?:s)?\\b",
    "\\bbody,?\\s*mind\\b",
    "\\bmind\\s*&\\s*spirit\\b",
    "\\bnon[- ]?fiction\\b"
  ].join("|"), "i");

  // Title patterns that strongly signal non-fiction / adjacent genres.
  // Keep the list broad — the user explicitly called out workplace
  // books, psychology, relationship analysis, and general guides.
  const DISALLOWED_TITLE_RE = new RegExp([
    "\\bworkbook\\b",
    "\\bhandbook\\b",
    "\\bmanual\\b",
    "\\btextbook\\b",
    "\\bguide\\s+to\\b",
    "\\bguide\\s+for\\b",
    "\\bcomplete\\s+guide\\b",
    "\\bpractical\\s+guide\\b",
    "\\bpsychology\\s+of\\b",
    "\\bscience\\s+of\\b",
    "\\bsociology\\s+of\\b",
    "\\bphilosophy\\s+of\\b",
    "\\bhistory\\s+of\\b",
    "\\bart\\s+of\\b(?!\\s+(?:love|seduction))",
    "\\bhow\\s+to\\b",
    "\\bstep[- ]?by[- ]?step\\b",
    "\\bfor\\s+dummies\\b",
    "\\bessentials?\\s+of\\b",
    "\\bprinciples?\\s+of\\b",
    "\\bintroduction\\s+to\\b",
    "\\btheor(?:y|ies)\\s+of\\b",
    "\\bcase\\s+stud(?:y|ies)\\b",
    "\\bcompanion\\s+to\\b",
    "\\bplaybook\\b",
    "\\bleadership\\b",
    "\\bworkplace\\b",
    "\\bexecutive(?:'s)?\\b",
    "\\bcareer(?:s)?\\b",
    "\\bmanager(?:ial)?\\b",
    "\\bnegotiation\\b",
    "\\bnegotiating\\b",
    "\\bcoaching\\b",
    "\\btherapy\\b",
    "\\btherapist(?:'s)?\\b",
    "\\bcounsell?ing\\b",
    "\\bresearch\\b",
    "\\bhandbook(?:s)?\\b"
  ].join("|"), "i");

  // Description signatures that strongly suggest the book is
  // non-fiction even if the category string is missing or vague.
  const DISALLOWED_DESC_RE = new RegExp([
    "\\bworkbook\\b",
    "\\bmanual\\b",
    "\\bhandbook\\b",
    "\\btextbook\\b",
    "\\bstep[- ]?by[- ]?step\\b",
    "\\bessentials?\\s+of\\b",
    "\\bfor\\s+(?:dummies|beginners)\\b",
    "\\bpractical\\s+guide\\b",
    "\\bpractical\\s+advice\\b",
    "\\bexperts?\\s+(?:guide|advice)\\b",
    "\\bscientific\\s+stud(?:y|ies)\\b",
    "\\bresearch\\s+(?:paper|findings|shows|suggests)\\b",
    "\\bdata[- ]driven\\b",
    "\\bcase\\s+stud(?:y|ies)\\b",
    "\\bevidence[- ]based\\b",
    "\\bself[- ]?help\\b",
    "\\bacademic\\s+text\\b",
    "\\bclinical\\s+(?:insight|study|advice)\\b",
    "\\bhow[- ]to\\s+(?:guide|book|manual)\\b"
  ].join("|"), "i");

  // Positive signal: a fiction category string, as a safeguard. If a
  // result carries "Erotica" but also "Fiction" or equivalent, we
  // treat that as reassurance the book is a novel rather than a
  // category metadata glitch.
  const FICTION_CATEGORY_RE = /\bfiction\b/i;

  // Explicit positive markers in the description — must appear in
  // addition to a qualifying category for marginal cases.
  const EROTICA_DESCRIPTION_RE = /\b(erotica|erotic (?:novel|fiction|romance|tale|stories|literature))\b/i;

  function classifyEroticaMatch(item) {
    const cats = (item.categories || []).map(c => String(c).toLowerCase());
    const title = String(item.title || "");
    const desc = String(item.description || "");

    // --- Rule 1: must have at least one Google Books category.
    // Without a category we have no structured signal and anything
    // ambiguous is rejected by policy.
    if (!cats.length) return { accepted: false, reason: "no categories" };

    // --- Rule 2: at least one category must literally contain the
    // word "erotica". "erotic" alone (e.g. "Psychology / Erotic love")
    // is NOT enough.
    const hasEroticaCat = cats.some(c => EROTICA_CATEGORY_EXACT_RE.test(c));
    if (!hasEroticaCat) return { accepted: false, reason: "no 'erotica' category" };

    // --- Rule 3: no category may match the disallowed non-fiction /
    // adjacent-genre blocklist. A book with both "Erotica" and
    // "Psychology / Human Sexuality" is rejected — that's the exact
    // pattern letting non-fiction erotica analyses slip through now.
    const disallowedCat = cats.find(c => DISALLOWED_CATEGORY_RE.test(c));
    if (disallowedCat) return { accepted: false, reason: `disallowed category: ${disallowedCat}` };

    // --- Rule 4: title must not match the non-fiction / workplace /
    // psychology-of blocklist. This catches "The Psychology of the
    // Erotic", "Workbook for ...", "Leadership & Desire", etc.
    if (DISALLOWED_TITLE_RE.test(title)) {
      return { accepted: false, reason: "non-fiction title pattern" };
    }

    // --- Rule 5: description must not match the non-fiction / guide
    // / workbook / research blocklist.
    if (DISALLOWED_DESC_RE.test(desc)) {
      return { accepted: false, reason: "non-fiction description pattern" };
    }

    // At this point: has a bona fide "erotica" category, no
    // disallowed categories, no disallowed title / description
    // patterns. If a fiction category is also present, that's the
    // strongest possible signal. If only an erotica category is
    // present, we still require a positive description signal
    // (e.g. mentions "erotic novel" / "erotic fiction") to accept,
    // so purely metadata-based glitches don't pass.
    const hasFictionCat = cats.some(c => FICTION_CATEGORY_RE.test(c));
    if (hasFictionCat) return { accepted: true, reason: "erotica + fiction categories" };
    if (EROTICA_DESCRIPTION_RE.test(desc)) return { accepted: true, reason: "erotica category + description signal" };
    return { accepted: false, reason: "erotica category but no fiction/description signal" };
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
    // Over-fetch — the hard post-filter is aggressive and will reject
    // the majority of a raw Google Books page. Fetching 40 candidates
    // keeps us comfortably above the 6-card target after filtering.
    const fetchCount = Math.max(maxResults * 6, 40);
    const normalized = query.trim();
    // Constrain the query on both sides: require Erotica AND Fiction
    // subjects, and actively reject the adjacent-genre subjects that
    // caused the current leaks (psychology, social science, self-
    // help, business, family & relationships, body mind & spirit,
    // religion, health, philosophy, essays, poetry, memoir, history,
    // biography, reference). Google ANDs each bare term in `q`, so
    // this is an intersection and all negatives are enforced.
    const q = [
      normalized,
      'subject:"Erotica"',
      'subject:"Fiction"',
      '-subject:"Psychology"',
      '-subject:"Social Science"',
      '-subject:"Self-Help"',
      '-subject:"Business & Economics"',
      '-subject:"Family & Relationships"',
      '-subject:"Body, Mind & Spirit"',
      '-subject:"Religion"',
      '-subject:"Health & Fitness"',
      '-subject:"Philosophy"',
      '-subject:"Medical"',
      '-subject:"Political Science"',
      '-subject:"Education"',
      '-subject:"Reference"',
      '-subject:"Literary Criticism"',
      '-subject:"Memoir"',
      '-subject:"Biography & Autobiography"',
      '-subject:"History"',
      '-subject:"True Crime"',
      '-subject:"Poetry"',
      '-subject:"Essays"',
      '-subject:"Juvenile Fiction"',
      '-subject:"Juvenile Nonfiction"',
      '-subject:"Young Adult Fiction"',
      '-subject:"Young Adult Nonfiction"'
    ].join(" ");
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
      "You are an editorial classifier for Lumen, a private reading companion for adult literature.",
      "Lumen's Discovery surface is intentionally restricted to erotica novels only.",
      "Return ONLY a compact JSON object matching this schema — nothing else:",
      '{ "isErotica": <boolean>, "confidence": <integer 0-100>, "format": <one of "erotica-novel" | "erotic-romance-novel" | "romance-novel" | "general-fiction" | "nonfiction" | "other">, "containsNonfictionSignal": <boolean>, "heat": <integer 1-5>, "tropes": <array of 2-4 short lowercase strings>, "insight": <one calm sentence under 28 words> }.',
      "CLASSIFICATION RULES — be strict.",
      "- isErotica = true ONLY when the book is a novel (fiction) whose PRIMARY category and purpose is erotica / erotic fiction / erotic romance, with explicit sexual content as a central element.",
      "- isErotica = false for: romance novels without explicit erotica positioning, general fiction with sex scenes, literary fiction with sensual undertones, psychology books, self-help, workplace or leadership books, relationship advice, sociology, academic texts, essays, memoirs, biographies, poetry collections, manuals, guides, workbooks, therapy / counselling books, cookbooks, travel, or anything else non-novel.",
      "- When the genre is ambiguous (e.g. 'dark romance', 'spicy romance', 'romantic suspense') default to false unless the description or author positioning makes erotica-fiction the explicit primary category.",
      "- confidence = your certainty in the isErotica value, 0-100.",
      "- format = the single best-fitting format tag from the enum. Use 'nonfiction' for any analytical / advisory / academic / research-driven book, even if it discusses erotic themes.",
      "- containsNonfictionSignal = true if the title or description suggests psychology, self-help, workplace, academic, research, case-study, handbook, workbook, manual, guide, therapy, or relationship-advice positioning. When uncertain, return true.",
      "- heat = overall sensual/erotic intensity on a 1 (barely-there) to 5 (unreserved) scale.",
      "- tropes = 2-4 concise narrative tropes (e.g. 'forbidden love', 'slow burn'). No quotes, no full stops.",
      "- insight = one non-judgemental sentence about what kind of reader this suits. Avoid hype. Do not make up facts.",
      "- Output strictly valid JSON, no prose, no backticks. When in doubt about ANY field, err toward rejection (isErotica=false, low confidence, containsNonfictionSignal=true).",
      "",
      `Title: ${book.title}`,
      `Author: ${book.author}`,
      `Categories: ${((book.categories || []).join("; ")) || "(none)"}`,
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

  // Allowed format strings that pass the "erotica novel" gate on
  // Claude's side. Everything else — including romance-novel and
  // general-fiction — is rejected even if isErotica slipped in.
  const ACCEPTED_FORMATS = new Set(["erotica-novel", "erotic-romance-novel"]);
  // Confidence floor for Claude's classifier. Anything below this is
  // rejected — a decisive "yes" is required, not a lukewarm one.
  const CONFIDENCE_FLOOR = 75;

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
      // Strict boolean defaults: missing / unknown / parse-failed
      // values all read as rejection so borderline titles never slip
      // through. Claude must explicitly say {isErotica: true,
      // confidence>=75, format in accepted set, containsNonfictionSignal:
      // false}. Any deviation is treated as "not erotica".
      const rawIsErotica = obj.isErotica === true;
      const rawConfidence = Math.max(0, Math.min(100, parseInt(obj.confidence, 10)));
      const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;
      const format = typeof obj.format === "string" ? obj.format.toLowerCase().trim() : "";
      const containsNonfictionSignal = obj.containsNonfictionSignal === true;
      const formatOk = ACCEPTED_FORMATS.has(format);
      const isErotica = rawIsErotica
        && confidence >= CONFIDENCE_FLOOR
        && formatOk
        && !containsNonfictionSignal;
      return {
        isErotica,
        heat, tropes, insight,
        classifierConfidence: confidence,
        classifierFormat: format || "unknown",
        classifierNonfictionSignal: containsNonfictionSignal,
        classifierRawIsErotica: rawIsErotica
      };
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
    isEroticaResult,
    onStatus,
    get status() { return state.status; },
    get message() { return state.lastMessage; }
  };
})();
