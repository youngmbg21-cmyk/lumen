/* ============================================================
   Lumen — Editorial (Claude-backed curator)
   Public API: window.LumenEditorial.generate({ profile, candidates,
     angle, favorites, recentReads, coldStart })
   Returns: { angleStatement: string, picks: [{ bookId, summary }] }
   Throws:  { code, message } where code ∈
     "no-key" | "rate-limit" | "parse-failure" | "network" | "unknown"

   Loaded AFTER app.js. Mirrors discovery.js's Claude call pattern
   (same endpoint, same direct-browser headers, same key store).
   Model is claude-sonnet-4-6 — Haiku is used elsewhere for speed,
   but editorial writing rewards the sharper model.

   Consumed by the Today view in app.js via window.LumenEditorial.
   ============================================================ */
(function () {
  "use strict";

  const ENDPOINT   = "https://api.anthropic.com/v1/messages";
  const MODEL      = "claude-sonnet-4-6";
  const MAX_TOKENS = 2400;

  // --------------- key lookup (mirrors discovery.js) ---------------
  function getApiKey() {
    const D = window.LumenDiscovery;
    return (D && typeof D.getApiKey === "function") ? D.getApiKey() : "";
  }

  // Typed error helper — every throw from this module is shaped as
  // { code, message } so the caller can distinguish user-fixable
  // states ("no-key") from transient ones ("rate-limit") and
  // programming errors ("parse-failure").
  function err(code, message) { return { code, message }; }

  // --------------- profile → prose (deterministic) ---------------
  // Exactly the same profile always produces exactly the same text,
  // so the prompt Claude receives is stable for a given reader state.
  const LEVEL_WORDS = ["very low", "low", "moderate", "high", "very high"];
  function levelWord(n) {
    if (typeof n !== "number") return "moderate";
    const idx = Math.max(1, Math.min(5, Math.round(n))) - 1;
    return LEVEL_WORDS[idx];
  }
  function list(profile, key) {
    return Array.isArray(profile && profile[key]) ? profile[key] : [];
  }
  function joinOr(xs, sep, empty) {
    return xs.length ? xs.join(sep) : empty;
  }
  function profileToProse(profile) {
    if (!profile || typeof profile !== "object") {
      return "No reader profile has been set yet — write for a new reader.";
    }
    const n = (k, def) => {
      const v = profile[k];
      return typeof v === "number" ? v : def;
    };
    const heat     = n("heat", 3);
    const explicit = n("explicit", 3);
    const emotion  = n("emotion", 3);
    const consent  = n("consent", 3);
    const taboo    = n("taboo", 3);
    const plot     = n("plot", 3);

    // Sentence 1 — heat + explicit + emotion + consent + taboo.
    const s1 = [
      `This reader prefers ${levelWord(heat)}-heat stories (${heat}/5)`,
      `with ${levelWord(explicit)} explicitness (${explicit}/5)`,
      emotion >= 4 ? "and a strong emotional register"
        : emotion <= 2 ? "and a restrained emotional register"
        : "and a balanced emotional register",
      consent >= 4 ? "They want clear consent floors"
        : consent <= 2 ? "They're open to ambiguous consent dynamics"
        : "They prefer pragmatic but legible consent signals",
      taboo <= 2 ? "and low taboo tolerance"
        : taboo >= 4 ? "and broad taboo tolerance"
        : "and moderate taboo tolerance"
    ].join("; ") + ".";

    // Sentence 2 — tone / pacing / style / dynamic.
    const tones    = list(profile, "tone").slice(0, 3);
    const pacings  = list(profile, "pacing").slice(0, 2);
    const styles   = list(profile, "style")
                    .concat(list(profile, "literary_style"))
                    .slice(0, 2);
    const dynamics = list(profile, "dynamic")
                    .concat(list(profile, "relationship_dynamic"))
                    .slice(0, 3);
    const narrative = [
      pacings.length ? `${pacings.join(" and ")} pacing` : null,
      styles.length  ? `${styles.join(" and ")} prose` : null,
      tones.length   ? `a ${tones.join(", ")} tonal register` : null,
      dynamics.length ? `${dynamics.join(", ")} dynamics` : null
    ].filter(Boolean);
    const s2 = narrative.length
      ? `Narratively they're drawn to ${joinOr(narrative, "; ", "no fixed preferences")}.`
      : "They haven't flagged strong narrative preferences yet.";

    // Sentence 3 — named trope / kink interests.
    const tropes = list(profile, "trope").concat(list(profile, "trope_tags")).slice(0, 5);
    const kinks  = list(profile, "kink").concat(list(profile, "kink_tags")).slice(0, 5);
    const interestsParts = [];
    if (tropes.length) interestsParts.push(`trope interests include ${tropes.join(", ")}`);
    if (kinks.length)  interestsParts.push(`kinks of interest: ${kinks.join(", ")}`);
    const s3 = interestsParts.length
      ? "Their " + interestsParts.join("; ") + "."
      : "";

    // Sentence 4 — plot weight + orientation preferences.
    const orient = list(profile, "orientation").concat(list(profile, "orientation_tags")).slice(0, 3);
    const s4Parts = [`Plot weight preference: ${levelWord(plot)} (${plot}/5)`];
    if (orient.length) s4Parts.push(`orientation: ${orient.join(", ")}`);
    const s4 = s4Parts.join("; ") + ".";

    // Sentence 5 — Lumen's universal hard-exclusions. Stated
    // verbatim so Claude respects them even when the profile itself
    // doesn't carry explicit exclusion flags.
    const s5 = "They exclude, universally: underage sexual content, "
             + "depictions of exploitation presented approvingly, and "
             + "consent violations framed as desirable.";

    return [s1, s2, s3, s4, s5].filter(Boolean).join(" ");
  }

  // --------------- prompt assembly ---------------
  function formatBook(b, i, extras) {
    const lines = [];
    lines.push(`BOOK ${i + 1}:`);
    lines.push(`  id: ${b.id || "—"}`);
    lines.push(`  title: ${b.title || "—"}`);
    lines.push(`  author: ${b.author || "—"}`);
    if (b.year) lines.push(`  year: ${b.year}`);
    const sub = b.subgenre || b.category;
    if (sub) lines.push(`  subgenre: ${sub}`);
    const tropes = (b.trope_tags || b.trope || []).slice(0, 12);
    if (tropes.length) lines.push(`  tropes: ${tropes.join(", ")}`);
    const kinks = (b.kink_tags || b.kink || []).slice(0, 8);
    if (kinks.length) lines.push(`  kinks: ${kinks.join(", ")}`);
    const tone = (b.tone || []).slice(0, 6);
    if (tone.length) lines.push(`  tone: ${tone.join(", ")}`);
    const dyn = (b.relationship_dynamic || b.dynamic || []).slice(0, 6);
    if (dyn.length) lines.push(`  dynamics: ${dyn.join(", ")}`);
    const warn = (b.content_warnings || b.warnings || []).slice(0, 10);
    if (warn.length) lines.push(`  content_warnings: ${warn.join(", ")}`);
    const desc = b.description || b.short_summary || b.fit_notes || "";
    if (desc) lines.push(`  description: ${String(desc).slice(0, 900)}`);
    if (b.fit_notes && b.fit_notes !== desc) {
      lines.push(`  fit_notes: ${String(b.fit_notes).slice(0, 400)}`);
    }
    if (extras && typeof extras.fitScore === "number") {
      lines.push(`  fit_score: ${extras.fitScore}%`);
    }
    return lines.join("\n");
  }

  function buildPrompt({ profileProse, candidates, angle, favorites, recentReads, coldStart }) {
    const candidatesFormatted = candidates.map((c, i) => {
      return formatBook(c.book || {}, i, { fitScore: c.fitScore });
    }).join("\n\n");

    const recent = (recentReads || []).slice(0, 5)
      .map(b => `- ${b.title} by ${b.author}${b.year ? " (" + b.year + ")" : ""}`).join("\n") || "(none)";
    const favs = (favorites || []).slice(0, 8)
      .map(b => `- ${b.title} by ${b.author}${b.year ? " (" + b.year + ")" : ""}`).join("\n") || "(none)";

    const coldNote = coldStart
      ? "\nCOLD-START NOTE: This reader has fewer than five books in their library. "
      + "Write for them as someone opening Lumen for the first time — lean on their "
      + "stated profile rather than pattern-matching to their library.\n"
      : "";

    return (
`You are Lumen's editorial curator. You write with the voice of a thoughtful literary critic who takes the erotica and romance genres seriously. You've been given a reader's profile, a sample of their recent reading, and three books that Lumen's scoring engine has flagged as strong fits for them. Write a short editorial piece — roughly 150-250 words per book — that explains in specific, grounded terms why this particular reader would love this particular book.

Today's editorial angle is: ${angle.label}. Let that shape the register of your writing.
${coldNote}
Guidelines:

- Write confidently and specifically. Name what makes each book distinctive.
- Use literary reference points where relevant (comparisons to other books, styles, authors).
- Vary how you open each of the three summaries. One might begin with a mood, another with a specific scene or dynamic, another with the author's craft or a comparison.
- Never use marketing phrases like "you'll love this" or "this book is perfect for you."
- Do not invent plot details, scenes, characters, or themes that aren't in the book information provided. Work only from what you've been given. If you don't have enough to write richly about a book, lean on mood, style, and comparative positioning rather than fabricating.
- Write as though this reader might challenge you — ground every claim in something real.

Also write a single-sentence angle statement (max 20 words) that introduces the three picks as a set and reflects today's angle.

Return valid JSON matching this exact shape — no markdown fences, no commentary, just the JSON object:

{
  "angleStatement": "string, one sentence",
  "picks": [
    { "bookId": "string matching input ID", "summary": "string, 150-250 words" },
    { "bookId": "string matching input ID", "summary": "string, 150-250 words" },
    { "bookId": "string matching input ID", "summary": "string, 150-250 words" }
  ]
}

Reader profile:
${profileProse}

Recent reading (last 5):
${recent}

Favorites (up to 8):
${favs}

The three books to write about:
${candidatesFormatted}`
    );
  }

  // --------------- Claude call (mirrors discovery.js) ---------------
  async function callClaude(prompt) {
    const apiKey = getApiKey();
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
    } catch (e) {
      throw err("network", (e && e.message) || "Network error contacting Claude");
    }

    if (res.status === 429) {
      throw err("rate-limit", "Claude rate limit or quota hit (HTTP 429)");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = (body && body.error && body.error.message)
              || (body && body.message)
              || "";
      } catch (_) { /* body wasn't JSON */ }
      throw err("unknown", `Claude responded HTTP ${res.status}${detail ? " · " + detail : ""}`);
    }

    let payload;
    try { payload = await res.json(); }
    catch (e) { throw err("parse-failure", "Claude response was not JSON"); }

    const text = payload
              && Array.isArray(payload.content)
              && payload.content[0]
              && payload.content[0].text;
    if (!text || typeof text !== "string") {
      throw err("parse-failure", "Claude response missing text content");
    }
    return text;
  }

  // --------------- response parsing ---------------
  function parseResponse(raw) {
    // Strip optional ```json … ``` fences that Claude sometimes
    // emits despite being asked not to.
    let cleaned = String(raw || "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { throw err("parse-failure", "Editorial response was not valid JSON"); }

    if (!parsed || typeof parsed.angleStatement !== "string" || !Array.isArray(parsed.picks)) {
      throw err("parse-failure", "Editorial JSON missing angleStatement or picks");
    }
    const picks = parsed.picks.filter(p =>
      p && typeof p.bookId === "string" && typeof p.summary === "string"
    );
    if (!picks.length) {
      throw err("parse-failure", "Editorial JSON had no valid picks");
    }
    return {
      angleStatement: parsed.angleStatement.trim(),
      picks: picks.map(p => ({ bookId: p.bookId, summary: p.summary.trim() }))
    };
  }

  // --------------- public entry point ---------------
  async function generate(args) {
    args = args || {};
    const profile     = args.profile     || null;
    const candidates  = Array.isArray(args.candidates) ? args.candidates : [];
    const angle       = args.angle || { id: "deepen", label: "Three books that would deepen what you're already drawn to" };
    const favorites   = Array.isArray(args.favorites)   ? args.favorites   : [];
    const recentReads = Array.isArray(args.recentReads) ? args.recentReads : [];
    const coldStart   = !!args.coldStart;

    const profileProse = profileToProse(profile);
    const prompt = buildPrompt({ profileProse, candidates, angle, favorites, recentReads, coldStart });
    const raw = await callClaude(prompt);
    return parseResponse(raw);
  }

  window.LumenEditorial = { generate };
})();
