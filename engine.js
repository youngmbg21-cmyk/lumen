/* ============================================================
   Lumen — Fit engine (Batch 2)
   Numeric + tag scoring, hard exclusions, warning penalties,
   confidence, "why it matched" reasoning.
   Exposed on window.LumenEngine.
   ============================================================ */
(function () {
  "use strict";

  // No default catalogue — callers pass the book list they want scored.
  const BOOKS = [];

  function normalizeProfile(p) {
    return {
      numeric: {
        heat: p.heat, explicit: p.explicit, emotion: p.emotion,
        consent: p.consent, taboo: p.taboo, plot: p.plot
      },
      sets: {
        tone: new Set(p.tone),
        pacing: new Set(p.pacing),
        style: new Set(p.style),
        dynamic: new Set(p.dynamic),
        trope: new Set(p.trope),
        kink: new Set(p.kink),
        orientation: new Set(p.orientation)
      },
      hardNo: new Set(p.exclude),
      warnStrict: p.warnStrict
    };
  }

  function applyHardExclusions(books, nProfile) {
    return books.filter(b => {
      for (const w of b.content_warnings) {
        if (nProfile.hardNo.has(w)) return false;
      }
      if (b.consent_clarity < nProfile.numeric.consent - 2) return false;
      if (nProfile.numeric.taboo === 1 && b.taboo_level >= 4) return false;
      return true;
    });
  }

  function numericMatch(userVal, bookVal) {
    const diff = Math.abs(userVal - bookVal);
    if (diff === 0) return 1.0;
    if (diff === 1) return 0.6;
    if (diff === 2) return 0.25;
    return 0;
  }

  function tagOverlap(userSet, bookArr, isPartial) {
    if (userSet.size === 0) return { credit: 0.5, matched: [] };
    if (!bookArr || bookArr.length === 0) {
      return { credit: isPartial ? 0.5 : 0, matched: [] };
    }
    const matched = bookArr.filter(t => userSet.has(t));
    if (matched.length === 0) return { credit: 0, matched: [] };
    // Base 0.5 credit for any match; additional 0.5 scales with how many
    // of the user's preferences the book satisfies. This prevents a large
    // wishlist from unfairly collapsing scores when books only carry a
    // subset of the user's tags (which is normal for real catalog metadata).
    const credit = 0.5 + 0.5 * (matched.length / userSet.size);
    return { credit, matched };
  }

  function evaluateBookFit(book, nProfile) {
    const n = nProfile.numeric;
    const s = nProfile.sets;
    const partial = !!book._isPartial;
    const numericResults = {
      heat:    numericMatch(n.heat, book.heat_level),
      explicit: numericMatch(n.explicit, book.explicitness),
      emotion: numericMatch(n.emotion, book.emotional_intensity),
      consent: book.consent_clarity >= n.consent ? 1.0 : numericMatch(n.consent, book.consent_clarity),
      taboo:   book.taboo_level <= n.taboo ? 1.0 : numericMatch(n.taboo, book.taboo_level),
      plot:    numericMatch(n.plot, book.plot_weight)
    };
    const tagResults = {
      tone:        tagOverlap(s.tone, book.tone, partial),
      pacing:      tagOverlap(s.pacing, book.pacing, partial),
      style:       tagOverlap(s.style, book.literary_style, partial),
      dynamic:     tagOverlap(s.dynamic, book.relationship_dynamic, partial),
      trope:       tagOverlap(s.trope, book.trope_tags, partial),
      kink:        tagOverlap(s.kink, book.kink_tags, partial),
      orientation: tagOverlap(s.orientation, book.orientation_tags, partial)
    };
    return { numericResults, tagResults };
  }

  function scoreBook(book, nProfile, weights) {
    const fit = evaluateBookFit(book, nProfile);

    let raw = 0;
    let maxPossible = 0;
    const contributions = {};

    for (const [k, score] of Object.entries(fit.numericResults)) {
      const weight = weights[k] || 1;
      const contrib = score * weight;
      raw += contrib;
      maxPossible += weight;
      contributions[k] = { score, weight, contrib };
    }

    for (const [k, result] of Object.entries(fit.tagResults)) {
      const weight = weights[k] || 1;
      const contrib = result.credit * weight;
      raw += contrib;
      maxPossible += weight;
      contributions[k] = { score: result.credit, weight, contrib, matched: result.matched };
    }

    const warnCount = book.content_warnings.length;
    const strictness = nProfile.warnStrict;
    let warnPenalty = 0;
    if (strictness === "strict")       warnPenalty = warnCount * 0.08 * (weights.consent + 1);
    else if (strictness === "moderate") warnPenalty = warnCount * 0.03 * (weights.consent + 1);

    const criticallyWarned = book.content_warnings.some(w =>
      w.includes("underage") || w.includes("violation") || w.includes("exploitation")
    );
    if (strictness === "strict" && criticallyWarned) warnPenalty += 2.0;

    const finalRaw = Math.max(0, raw - warnPenalty);
    const percent  = maxPossible > 0 ? Math.round((finalRaw / maxPossible) * 100) : 0;

    const tagSignalsPresent = Object.values(fit.tagResults).filter(r => r.matched && r.matched.length > 0).length;
    const preferencesExpressed = Object.values(nProfile.sets).filter(s => s.size > 0).length;
    const metadataDensity = (Object.values(book).filter(v =>
      Array.isArray(v) ? v.length > 0 : (v !== null && v !== undefined && v !== "")
    ).length) / 22;
    const signalRatio = preferencesExpressed > 0 ? tagSignalsPresent / preferencesExpressed : 0.5;
    const confidence  = Math.min(100, Math.round((signalRatio * 0.6 + metadataDensity * 0.4) * 100));

    return {
      fitScore: Math.min(100, percent),
      confidence,
      warnPenalty: Math.round(warnPenalty * 10) / 10,
      warnCount,
      contributions,
      rawScore: Math.round(finalRaw * 100) / 100,
      maxPossible: Math.round(maxPossible * 100) / 100,
      criticallyWarned
    };
  }

  const NUMERIC_LABELS = {
    heat: "heat level", explicit: "explicitness", emotion: "emotional intensity",
    consent: "consent clarity", taboo: "taboo tolerance", plot: "plot/scene balance"
  };
  const TAG_LABELS = {
    tone: "tone", pacing: "pacing", style: "literary style",
    dynamic: "relationship dynamic", trope: "tropes", kink: "kink tags", orientation: "orientation"
  };

  function generateWhyItMatched(book, scoreData, nProfile) {
    const reasons = [];
    const partials = [];
    const penalties = [];

    for (const k of Object.keys(NUMERIC_LABELS)) {
      const c = scoreData.contributions[k];
      if (!c) continue;
      if (c.score >= 0.95)      reasons.push(`Exact match on ${NUMERIC_LABELS[k]}`);
      else if (c.score >= 0.55) partials.push(`Near match on ${NUMERIC_LABELS[k]}`);
    }

    for (const k of Object.keys(TAG_LABELS)) {
      const c = scoreData.contributions[k];
      if (!c || !c.matched) continue;
      if (c.matched.length > 0 && c.score >= 0.6) {
        reasons.push(`Strong ${TAG_LABELS[k]} overlap: ${c.matched.slice(0, 2).map(x => x.replace(/-/g, " ")).join(", ")}`);
      } else if (c.matched.length > 0) {
        partials.push(`Partial ${TAG_LABELS[k]} overlap: ${c.matched[0].replace(/-/g, " ")}`);
      }
    }

    if (scoreData.warnPenalty > 0.5) {
      penalties.push(`Warnings reduced score by ${scoreData.warnPenalty.toFixed(1)} (strictness: ${nProfile.warnStrict})`);
    }
    if (reasons.length === 0 && partials.length === 0) {
      reasons.push(`Matches your baseline profile with no strong conflicts`);
    }

    return { reasons: reasons.slice(0, 4), partials: partials.slice(0, 3), penalties };
  }

  function rankRecommendations(profile, weights, books = BOOKS) {
    const nProfile = normalizeProfile(profile);
    const survivors = applyHardExclusions(books, nProfile);
    const scored = survivors.map(b => {
      const s = scoreBook(b, nProfile, weights);
      return { book: b, ...s, why: generateWhyItMatched(b, s, nProfile) };
    });
    scored.sort((a, b) => (b.fitScore - a.fitScore) || (b.confidence - a.confidence));
    return {
      scored,
      screened: books.length,
      matched: scored.length,
      excluded: books.length - survivors.length
    };
  }

  function compareBooks(bookIds, profile, weights, books = BOOKS) {
    const nProfile = normalizeProfile(profile);
    return bookIds.map(id => {
      const b = books.find(x => x.id === id);
      if (!b) return null;
      const s = scoreBook(b, nProfile, weights);
      return { book: b, ...s, why: generateWhyItMatched(b, s, nProfile) };
    }).filter(Boolean);
  }

  // ── Partial-data adapters ──────────────────────────────────────
  // fromDiscovery: maps a raw Google Books item + Claude enrichment
  // { heat, tropes, insight } into a full catalog-shaped book so
  // scoreBook() produces a consistent score without re-implementing
  // any logic. Missing numerics default to 3 (mid-scale) so they
  // contribute a partial match rather than zero. _isPartial: true
  // lets the UI show an "estimated" badge on the score chip.
  function fromDiscovery(book, enrichment) {
    const e = enrichment && !enrichment.error ? enrichment : {};
    return {
      id:                   book.id || "",
      title:                book.title || "",
      author:               book.author || "",
      description:          book.description || "",
      heat_level:           typeof e.heat === "number" ? e.heat : 3,
      explicitness:         3,
      emotional_intensity:  3,
      consent_clarity:      3,
      taboo_level:          3,
      plot_weight:          3,
      tone:                 [],
      pacing:               [],
      literary_style:       [],
      relationship_dynamic: [],
      trope_tags:           Array.isArray(e.tropes) ? e.tropes : [],
      kink_tags:            [],
      gender_pairing:       [],
      orientation_tags:     [],
      content_warnings:     [],
      _isPartial:           true
    };
  }

  // withDefaults: fills any missing numeric or tag fields in a
  // partial catalog book so scoreBook() never receives NaN.
  // Used by analysis.js heuristicFitScore and any caller that has
  // a catalog book but cannot guarantee every field is populated.
  function withDefaults(book) {
    if (!book) return fromDiscovery({}, null);
    return {
      ...book,
      heat_level:           book.heat_level          ?? 3,
      explicitness:         book.explicitness        ?? 3,
      emotional_intensity:  book.emotional_intensity ?? 3,
      consent_clarity:      book.consent_clarity     ?? 3,
      taboo_level:          book.taboo_level         ?? 3,
      plot_weight:          book.plot_weight         ?? 3,
      tone:                 book.tone                || [],
      pacing:               book.pacing              || [],
      literary_style:       book.literary_style      || [],
      relationship_dynamic: book.relationship_dynamic|| [],
      trope_tags:           book.trope_tags          || [],
      kink_tags:            book.kink_tags           || [],
      gender_pairing:       book.gender_pairing      || [],
      orientation_tags:     book.orientation_tags    || [],
      content_warnings:     book.content_warnings    || []
    };
  }

  // ── Canonical score labels — single source of truth ───────────
  // All views call these instead of inlining threshold checks, so
  // threshold drift across surfaces is impossible.
  function fitLabel(score) {
    if (score >= 75) return "Strong";
    if (score >= 55) return "Moderate";
    if (score >= 35) return "Loose";
    return "Thin";
  }
  function confLabel(score) {
    if (score >= 70) return "Signal-rich";
    if (score >= 45) return "Moderate";
    return "Thin data";
  }

  window.LumenEngine = {
    normalizeProfile,
    applyHardExclusions,
    scoreBook,
    generateWhyItMatched,
    rankRecommendations,
    compareBooks,
    fromDiscovery,
    withDefaults,
    fitLabel,
    confLabel,
    NUMERIC_LABELS,
    TAG_LABELS
  };
})();
