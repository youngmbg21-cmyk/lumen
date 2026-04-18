/* ============================================================
   Lumen — Deep analysis (Batch 4)
   Rule-based pipeline. Takes scored books + profile and returns
   a structured payload the Compare view can render. No LLM calls.
   Exposed on window.LumenAnalysis.
   ============================================================ */
(function () {
  "use strict";

  const Engine = window.LumenEngine;
  const CATEGORIES = [
    { key: "heat",        label: "Heat" },
    { key: "explicit",    label: "Explicit" },
    { key: "emotion",     label: "Emotion" },
    { key: "consent",     label: "Consent" },
    { key: "taboo",       label: "Taboo fit" },
    { key: "plot",        label: "Plot/scene" },
    { key: "tone",        label: "Tone" },
    { key: "pacing",      label: "Pacing" },
    { key: "style",       label: "Style" },
    { key: "dynamic",     label: "Dynamic" },
    { key: "trope",       label: "Tropes" },
    { key: "kink",        label: "Kinks" },
    { key: "orientation", label: "Orientation" }
  ];

  const MOODS = [
    { id: "escape",     label: "Escape + intensity",     dims: ["heat", "emotion", "explicit"] },
    { id: "slow",       label: "Slow burn + reflection", dims: ["plot", "tone", "style"] },
    { id: "literary",   label: "Literary pleasure",      dims: ["style", "plot", "tone"] },
    { id: "comfort",    label: "Safe and unhurried",     dims: ["consent"], invert: { taboo: true } },
    { id: "edge",       label: "Transgressive edge",     dims: ["taboo", "kink", "dynamic"] }
  ];

  function headlineVerdict(scoredList) {
    const sorted = [...scoredList].sort((a, b) => b.fitScore - a.fitScore);
    const best = sorted[0];
    const gap = best.fitScore - sorted[1].fitScore;
    if (scoredList.every(s => s.fitScore === best.fitScore))
      return `Every title is tied at ${best.fitScore} — the decision is about mood, not fit.`;
    if (gap <= 5)
      return `${best.book.title} edges the lineup at ${best.fitScore}, but every title is within ${gap} points.`;
    if (gap <= 15)
      return `${best.book.title} is the clearer fit — ${best.fitScore} versus ${sorted.slice(1).map(x => x.fitScore).join(" and ")}.`;
    return `${best.book.title} is the dominant choice at ${best.fitScore}. The others are substantially further from your profile.`;
  }

  function executiveSummaryFor(scored, profile) {
    const strongTags = Object.entries(scored.contributions)
      .filter(([, v]) => v.score >= 0.75)
      .sort((a, b) => b[1].contrib - a[1].contrib)
      .slice(0, 2)
      .map(([k]) => CATEGORIES.find(c => c.key === k)?.label?.toLowerCase() || k);
    const weakTags = Object.entries(scored.contributions)
      .filter(([, v]) => v.score < 0.35)
      .sort((a, b) => a[1].score - b[1].score)
      .slice(0, 2)
      .map(([k]) => CATEGORIES.find(c => c.key === k)?.label?.toLowerCase() || k);

    const want = strongTags.length
      ? `Pick if you want ${strongTags.join(" and ")}.`
      : `Pick for a gentle all-rounder against your profile.`;
    const beware = weakTags.length
      ? ` Beware it's weaker on ${weakTags.join(" and ")}.`
      : "";
    const warn = scored.book.content_warnings.length
      ? ` Carries ${scored.book.content_warnings.length} content warning${scored.book.content_warnings.length > 1 ? "s" : ""}.`
      : "";
    return want + beware + warn;
  }

  function categoryWinners(scoredList) {
    return CATEGORIES.map(cat => {
      const values = scoredList.map(sc => ({
        title: sc.book.title,
        score: sc.contributions[cat.key]?.score ?? 0
      }));
      const sorted = [...values].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const margin = top.score - (sorted[1]?.score ?? 0);
      const tier = margin < 0.1 ? "tight" : (margin < 0.3 ? "clear" : "decisive");
      return {
        category: cat.label,
        winner: top.title,
        winnerScore: Math.round(top.score * 100),
        margin: Math.round(margin * 100),
        tier,
        values: values.map(v => ({ ...v, score: Math.round(v.score * 100) }))
      };
    });
  }

  function tradeoffMatrix(scoredList) {
    const pairs = [];
    for (let i = 0; i < scoredList.length; i++) {
      for (let j = i + 1; j < scoredList.length; j++) {
        const a = scoredList[i], b = scoredList[j];
        const diffs = CATEGORIES.map(cat => {
          const sa = a.contributions[cat.key]?.score ?? 0;
          const sb = b.contributions[cat.key]?.score ?? 0;
          return { category: cat.label, key: cat.key, delta: sa - sb };
        }).filter(d => Math.abs(d.delta) >= 0.25)
          .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
          .slice(0, 3);

        pairs.push({
          a: a.book.title,
          b: b.book.title,
          differences: diffs.map(d => ({
            category: d.category,
            leader: d.delta > 0 ? a.book.title : b.book.title,
            magnitude: Math.abs(Math.round(d.delta * 100))
          }))
        });
      }
    }
    return pairs;
  }

  function moodMapping(scoredList) {
    return MOODS.map(mood => {
      const ranked = scoredList.map(sc => {
        const base = mood.dims.reduce((acc, k) => acc + (sc.contributions[k]?.score ?? 0), 0) / mood.dims.length;
        let score = base;
        if (mood.invert) {
          for (const [k] of Object.entries(mood.invert)) {
            score -= (sc.contributions[k]?.score ?? 0) * 0.5;
          }
        }
        return { title: sc.book.title, score };
      }).sort((a, b) => b.score - a.score);

      const top = ranked[0];
      const runnerUp = ranked[1];
      const tight = (top.score - (runnerUp?.score ?? 0)) < 0.1;
      return {
        mood: mood.label,
        winner: top.title,
        tight,
        note: tight ? `Close between ${top.title} and ${runnerUp.title}.` : null
      };
    });
  }

  function readingOrder(scoredList) {
    if (scoredList.length < 2) return null;
    // Sort by combined heat + emotion + warn count as a proxy for intensity
    const byIntensity = [...scoredList]
      .map(sc => ({
        title: sc.book.title,
        intensity: (sc.book.heat_level + sc.book.emotional_intensity + sc.book.content_warnings.length * 0.5)
      }))
      .sort((a, b) => a.intensity - b.intensity);

    if (scoredList.length === 2) {
      return {
        pattern: "gentle-then-peak",
        order: byIntensity.map(x => x.title),
        note: `Start with ${byIntensity[0].title} as the softer onramp, then rise into ${byIntensity[1].title}.`
      };
    }
    // 3 titles: gentle → peak → cooldown
    const [low, mid, high] = byIntensity;
    return {
      pattern: "gentle-peak-cooldown",
      order: [low.title, high.title, mid.title],
      note: `Ease in with ${low.title}, let ${high.title} peak, then cool down with ${mid.title} — intensity-shaped for a single reading session.`
    };
  }

  function confidencePanel(scoredList, profile) {
    const entries = scoredList.map(sc => ({
      title: sc.book.title,
      fit: sc.fitScore,
      confidence: sc.confidence,
      warnPenalty: sc.warnPenalty,
      warnCount: sc.warnCount,
      critical: sc.criticallyWarned
    }));
    const flags = [];
    if (entries.some(e => e.confidence < 60)) {
      flags.push("At least one title has low confidence — your profile has few signals that intersect with its metadata.");
    }
    if (entries.some(e => e.critical)) {
      flags.push("A title carries a critical warning (underage, violation, or exploitation themes). The app flags these regardless of how high the fit looks.");
    }
    if (entries.some(e => e.warnPenalty > 1)) {
      flags.push(`Your warning strictness (${profile.warnStrict}) is dragging down at least one score. Loosening it in your profile would change this analysis.`);
    }
    if (entries.every(e => e.confidence >= 70) && !flags.length) {
      flags.push("Confidence is solid across the lineup. Treat this analysis as a strong signal — but never as authoritative.");
    }
    return { entries, flags };
  }

  function thematicTakeaway(scoredList) {
    const decisiveWins = categoryWinners(scoredList).filter(w => w.tier === "decisive");
    if (!decisiveWins.length) return "None of the titles dominate on any single dimension — expect a close race whichever you pick.";
    const groups = decisiveWins.reduce((acc, w) => {
      (acc[w.winner] = acc[w.winner] || []).push(w.category.toLowerCase());
      return acc;
    }, {});
    const parts = Object.entries(groups).map(([title, cats]) =>
      `${title} dominates ${cats.slice(0, 3).join(", ")}`
    );
    return parts.join(". ") + ".";
  }

  function deepAnalysis(scoredList, profile) {
    if (!scoredList || scoredList.length < 2) return null;
    const timestamp = Date.now();
    return {
      timestamp,
      bookCount: scoredList.length,
      titles: scoredList.map(s => s.book.title),
      headline: headlineVerdict(scoredList),
      summaries: scoredList.map(sc => ({
        title: sc.book.title,
        fit: sc.fitScore,
        confidence: sc.confidence,
        summary: executiveSummaryFor(sc, profile)
      })),
      categoryWinners: categoryWinners(scoredList),
      tradeoffs: tradeoffMatrix(scoredList),
      moods: moodMapping(scoredList),
      readingOrder: readingOrder(scoredList),
      confidence: confidencePanel(scoredList, profile),
      thematic: thematicTakeaway(scoredList)
    };
  }

  window.LumenAnalysis = { deepAnalysis, CATEGORIES };
})();
