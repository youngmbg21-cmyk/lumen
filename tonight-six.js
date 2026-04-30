/* ============================================================
   Lumen — Tonight's Six (Margin Notes / Constellation curator)
   Public API: window.LumenTonightSix.generate({ profile, candidates,
     heroBookId, favorites, recentReads, coldStart, angle })
   Returns: { angleStatement, biancaLetter, picks: [{bookId, summary}] }
   Throws:  { code, message } same shape as editorial.js.

   Sister of editorial.js. Six picks instead of three, plus a
   short handwritten-style letter from Bianca for the Margin Notes
   right page. Calls the same /api/analyze proxy with claude-sonnet
   so we keep one server-side endpoint and one cost lane.
   ============================================================ */
(function () {
  "use strict";

  const ENDPOINT   = "https://api.anthropic.com/v1/messages";
  const PROXY_URL  = "/api/analyze";
  const MODEL      = "claude-sonnet-4-6";
  const MAX_TOKENS = 2400;

  function getApiKey() {
    const D = window.LumenDiscovery;
    return (D && typeof D.getApiKey === "function") ? D.getApiKey() : "";
  }
  function getAdminKey() {
    const D = window.LumenDiscovery;
    return (D && typeof D.getAdminKey === "function") ? D.getAdminKey() : "";
  }
  function err(code, message) { return { code, message }; }

  function arr(x) { return Array.isArray(x) ? x : []; }

  function profileLine(profile) {
    if (!profile) return "(no profile yet)";
    const parts = [];
    if (profile.heat     != null) parts.push(`heat ${profile.heat}/5`);
    if (profile.explicit != null) parts.push(`explicit ${profile.explicit}/5`);
    if (profile.emotion  != null) parts.push(`emotion ${profile.emotion}/5`);
    if (profile.consent  != null) parts.push(`consent ≥ ${profile.consent}/5`);
    if (profile.taboo    != null) parts.push(`taboo ${profile.taboo}/5`);
    if (profile.plot     != null) parts.push(`plot weight ${profile.plot}/5`);
    if (arr(profile.tone).length)    parts.push(`tone: ${profile.tone.join(", ")}`);
    if (arr(profile.trope).length)   parts.push(`tropes: ${profile.trope.slice(0,4).join(", ")}`);
    if (arr(profile.exclude).length) parts.push(`HARD exclusions: ${profile.exclude.slice(0,5).join(", ")}`);
    return parts.join(" · ");
  }

  function formatBook(c, i) {
    const b = c.book || {};
    const reasons = (c.contributions && c.contributions.reasons) || (c.why && c.why.reasons) || [];
    const lines = [
      `[${i}] id=${b.id}`,
      `    title: ${b.title}`,
      `    author: ${b.author || "Unknown"}`,
      `    year: ${b.year || "?"}`,
      `    fitScore: ${c.fitScore}`,
      `    heat: ${b.heat_level || "?"}/5  emotion: ${b.emotional_intensity || "?"}/5  taboo: ${b.taboo_level || "?"}/5  consent: ${b.consent_clarity || "?"}/5`
    ];
    const tropes = (b.trope_tags || b.trope || []).slice(0, 4);
    if (tropes.length) lines.push(`    tropes: ${tropes.join(", ")}`);
    const tone = (b.tone || []).slice(0, 4);
    if (tone.length) lines.push(`    tone: ${tone.join(", ")}`);
    if (reasons.length) lines.push(`    why: ${reasons.slice(0, 3).join("; ")}`);
    if (b.short_summary || b.description) {
      lines.push(`    summary: ${(b.short_summary || b.description).slice(0, 280)}`);
    }
    return lines.join("\n");
  }

  function buildPrompt({ profile, candidates, angle, heroIdx, favorites, recentReads, coldStart }) {
    const candidatesFormatted = candidates.map((c, i) => formatBook(c, i)).join("\n\n");
    const favs = (favorites || []).slice(0, 6)
      .map(b => `- ${b.title} by ${b.author}`).join("\n") || "(none)";
    const recent = (recentReads || []).slice(0, 5)
      .map(b => `- ${b.title} by ${b.author}`).join("\n") || "(none)";
    const heroNote = (typeof heroIdx === "number" && heroIdx >= 0)
      ? `Book index ${heroIdx} is the hero — the one that goes on the open-book left page. Address THAT book in the letter.\n`
      : "";
    const coldNote = coldStart
      ? "COLD-START NOTE: This reader has fewer than five books in their library yet. Lean on their stated profile, not their library history.\n"
      : "";

    return (
`You are Bianca, Lumen's reading companion. You're picking tonight's six books for one reader and writing a short handwritten letter that goes alongside the hero pick.

VOICE — non-negotiable:
- Sharp, grounded, like a smart older sister who reads everything. Direct sentences. Honest opinions.
- Banned phrases: "thematic resonance", "intellectual fingerprint", "narrative arc", "literary tapestry", "evocative meditation", "you'll love this".
- Favoured words: weight, texture, honest, sharp, effortless, messy, grounded.
- Talk about how a book feels and what it does — not what it "explores".
- No emoji. No marketing language. No headings.

READER PROFILE: ${profileLine(profile)}

EDITORIAL ANGLE for tonight: ${angle && angle.label ? angle.label : "deepen what they're already drawn to"}.

RECENT READING (last few finished):
${recent}

FAVOURITES (positive taste signal, not for fresh recs):
${favs}

THE SIX BOOKS (already chosen by Lumen's scoring engine — your job is to ground them, not to swap them):

${candidatesFormatted}

${heroNote}${coldNote}
WHAT TO WRITE:

1. angleStatement — one sentence under 22 words that frames tonight's six as a set. No hype.
2. biancaLetter — a tight, honest letter to the reader (Reader, …) that goes on the right page of an open-book spread, beside the hero book. HARD LIMIT: 160-180 words total, including "Reader," and the signature. 3 short paragraphs is plenty — never more than 4. The letter must fit on the page without scrolling, so density and editing matter more than coverage. Reference WHY the hero is for them tonight (one engine reason or one profile note is enough — don't list everything). Be honest about heat / weight / pacing in one sentence — if the heat is psychological and not on the page, say so plainly. Use **bold** for the hero's title only when first named. Sign it "— your reader, marked at p. N" where N is a plausible page number.
3. picks — for each of the six books in the order given, write a one-sentence summary (under 28 words) that names what the book DOES rather than what it's about. These show up as small annotations on the reading-pile cards and the constellation rail. Vary how they open — don't all start with "A …".

Return STRICT JSON, no markdown fences, no commentary, matching this shape exactly:

{
  "angleStatement": "<one sentence>",
  "biancaLetter": "<the letter, with \\n\\n between paragraphs>",
  "picks": [
    { "bookId": "<id from the list above>", "summary": "<one sentence>" },
    ... (one entry per book, same order)
  ]
}`
    );
  }

  async function callClaude(prompt) {
    try {
      const pr = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "chat",
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (pr.ok) {
        const data = await pr.json();
        const text = data && Array.isArray(data.content) && data.content[0] && data.content[0].text;
        if (text) return text;
        throw err("parse-failure", "Proxy response missing text content");
      }
      if (pr.status !== 404 && pr.status !== 405) {
        throw err("unknown", `Proxy responded HTTP ${pr.status}`);
      }
    } catch (e) {
      if (e.code) throw e;
    }

    const apiKey = getAdminKey() || getApiKey();
    if (!apiKey) throw err("no-key", "No Claude API key set");
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: prompt }]
        })
      });
    } catch (e) { throw err("network", (e && e.message) || "Network error"); }

    if (res.status === 429) throw err("rate-limit", "Claude rate limit hit");
    if (!res.ok) throw err("unknown", `Claude responded HTTP ${res.status}`);
    let payload;
    try { payload = await res.json(); }
    catch (e) { throw err("parse-failure", "Claude response was not JSON"); }
    const text = payload && Array.isArray(payload.content) && payload.content[0] && payload.content[0].text;
    if (!text) throw err("parse-failure", "Claude response missing text");
    return text;
  }

  function parseResponse(raw, expectedIds) {
    const cleaned = String(raw || "").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { throw err("parse-failure", "Tonight-six response was not valid JSON"); }
    if (!parsed || typeof parsed.biancaLetter !== "string" || !Array.isArray(parsed.picks)) {
      throw err("parse-failure", "Tonight-six JSON missing biancaLetter or picks");
    }
    const picks = parsed.picks
      .filter(p => p && typeof p.bookId === "string" && typeof p.summary === "string")
      .map(p => ({ bookId: p.bookId, summary: p.summary.trim() }));
    if (!picks.length) throw err("parse-failure", "Tonight-six JSON had no valid picks");
    return {
      angleStatement: typeof parsed.angleStatement === "string" ? parsed.angleStatement.trim() : "",
      biancaLetter: parsed.biancaLetter.trim(),
      picks
    };
  }

  async function generate(args) {
    args = args || {};
    const profile     = args.profile     || null;
    const candidates  = arr(args.candidates);
    const angle       = args.angle || { id: "deepen", label: "Six books that would deepen what you're already drawn to" };
    const favorites   = arr(args.favorites);
    const recentReads = arr(args.recentReads);
    const coldStart   = !!args.coldStart;
    let heroIdx       = typeof args.heroIdx === "number" ? args.heroIdx : -1;
    if (heroIdx < 0 && args.heroBookId && candidates.length) {
      heroIdx = candidates.findIndex(c => c.book && c.book.id === args.heroBookId);
    }
    if (heroIdx < 0) heroIdx = 0;

    const prompt = buildPrompt({ profile, candidates, angle, heroIdx, favorites, recentReads, coldStart });
    const raw = await callClaude(prompt);
    const expectedIds = candidates.map(c => c.book && c.book.id).filter(Boolean);
    return parseResponse(raw, expectedIds);
  }

  window.LumenTonightSix = { generate };
})();
