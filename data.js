/* ============================================================
   Lumen — Catalogue and vocabularies (Batch 1)
   Exposed on window.LumenData.
   ============================================================ */
(function () {
  "use strict";

  const BOOKS = [
    {
      id: "fanny_hill",
      title: "Memoirs of a Woman of Pleasure",
      author: "John Cleland",
      year: 1748,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/25305",
      category: "historical-erotic-literature",
      subgenre: "epistolary-memoir",
      description: "An 18th-century epistolary novel, narrated as letters from Fanny Hill, chronicling her arrival in London and subsequent life of sexual discovery. Known for its ornate prose that describes every act through elaborate metaphor rather than explicit language — a founding work of English-language erotic fiction.",
      heat_level: 4, explicitness: 3, emotional_intensity: 3, consent_clarity: 2, taboo_level: 4, plot_weight: 3,
      tone: ["sensual", "reflective"],
      pacing: ["slow-burn", "meandering"],
      literary_style: ["ornate", "classical", "metaphorical"],
      relationship_dynamic: ["mentor-student", "multiple-partners", "heteronormative-era"],
      trope_tags: ["coming-of-age", "city-of-pleasure", "patroness"],
      kink_tags: ["voyeurism", "power-dynamics-era-typical"],
      gender_pairing: ["m/f", "f/f-brief"],
      orientation_tags: ["hetero-dominant", "bi-curious-hints"],
      content_warnings: ["period-typical-consent-ambiguity", "sex-work", "dated-attitudes"]
    },
    {
      id: "romance_of_lust",
      title: "The Romance of Lust",
      author: "Anonymous (attributed)",
      year: 1873,
      source: "Internet Archive",
      source_url: "https://archive.org/details/theromanceoflust",
      category: "historical-erotic-literature",
      subgenre: "victorian-underground",
      description: "A Victorian-era anonymously-published work published clandestinely in four volumes. Notable as a representative of 19th-century underground English erotic fiction, extremely explicit for its time and transgressive by design. Historical interest is high; literary quality is uneven.",
      heat_level: 5, explicitness: 5, emotional_intensity: 2, consent_clarity: 1, taboo_level: 5, plot_weight: 1,
      tone: ["transgressive", "detached"],
      pacing: ["relentless", "episodic"],
      literary_style: ["victorian", "verbose"],
      relationship_dynamic: ["multiple-partners", "power-imbalance"],
      trope_tags: ["underground-press", "gothic-undertones"],
      kink_tags: ["multi-partner", "power-dynamics-era-typical"],
      gender_pairing: ["m/f", "m/m-brief", "f/f-brief"],
      orientation_tags: ["polymorphous"],
      content_warnings: ["consent-ambiguity", "dated-attitudes", "transgressive-scenarios", "period-typical-problematic-content"]
    },
    {
      id: "laura_middleton",
      title: "Laura Middleton; Her Brother and her Lover",
      author: "Anonymous",
      year: 1890,
      source: "Internet Archive",
      source_url: "https://archive.org",
      category: "historical-erotic-literature",
      subgenre: "victorian-underground",
      description: "A short late-Victorian anonymous work centred on a young woman's sexual awakening through her closest relationships. Representative of the clandestine publishing tradition of its era — historically significant as a specimen of private-circulation fiction rather than for literary ambition.",
      heat_level: 4, explicitness: 4, emotional_intensity: 3, consent_clarity: 2, taboo_level: 5, plot_weight: 2,
      tone: ["transgressive", "melodramatic"],
      pacing: ["quick", "scene-heavy"],
      literary_style: ["victorian", "concise"],
      relationship_dynamic: ["forbidden", "intense-closeness"],
      trope_tags: ["awakening", "forbidden-desire"],
      kink_tags: ["power-dynamics-era-typical"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["incest-theme", "consent-ambiguity", "dated-attitudes"]
    },
    {
      id: "josefine_mutzenbacher",
      title: "Josefine Mutzenbacher",
      author: "Anonymous (commonly attributed to Felix Salten)",
      year: 1906,
      source: "Project Gutenberg (German)",
      source_url: "https://www.projekt-gutenberg.org",
      category: "historical-erotic-literature",
      subgenre: "first-person-memoir",
      description: "A pseudonymous Austrian novel framed as the memoir of a Viennese woman reflecting on her life. Culturally significant for its unapologetic first-person female voice within the genre, though heavily contested for its inclusion of underage material that modern readers will find disturbing.",
      heat_level: 4, explicitness: 4, emotional_intensity: 3, consent_clarity: 1, taboo_level: 5, plot_weight: 2,
      tone: ["transgressive", "wry"],
      pacing: ["quick", "episodic"],
      literary_style: ["vernacular", "austrian-german"],
      relationship_dynamic: ["multiple-partners", "power-imbalance"],
      trope_tags: ["memoir", "urban-vienna"],
      kink_tags: ["power-dynamics-era-typical"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["underage-content-highly-disturbing", "consent-violations", "period-typical-problematic-content", "recommended-with-extreme-caution"]
    },
    {
      id: "kama_sutra",
      title: "The Kama Sutra of Vatsyayana",
      author: "Vatsyayana (trans. Richard Burton)",
      year: 1883,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/27827",
      category: "sexuality-literature",
      subgenre: "philosophical-treatise",
      description: "A 2nd-century Sanskrit text on pleasure, courtship, and the art of living well, presented here in Burton's 19th-century English translation. More philosophy and practical guidance than erotica — a foundational text in the history of human sexuality and relationship ethics.",
      heat_level: 2, explicitness: 3, emotional_intensity: 2, consent_clarity: 4, taboo_level: 2, plot_weight: 1,
      tone: ["contemplative", "instructional"],
      pacing: ["measured", "treatise"],
      literary_style: ["aphoristic", "classical-sanskrit-tradition"],
      relationship_dynamic: ["courtship", "long-term-partnership"],
      trope_tags: ["philosophy-of-pleasure", "classical-wisdom"],
      kink_tags: ["sensuality-focus", "technique-focus"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-historical"],
      content_warnings: ["dated-gender-norms", "translation-era-biases"]
    },
    {
      id: "perfumed_garden",
      title: "The Perfumed Garden",
      author: "Shaykh Nefzawi (trans. Burton)",
      year: 1886,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org",
      category: "sexuality-literature",
      subgenre: "manual",
      description: "A 15th-century Tunisian manual on love, marriage, and sexual practice, translated from Arabic in the late 19th century. A blend of anecdote, advice, and erotic poetry. Of historical and cultural interest as a North African counterpart to other classical sexuality texts.",
      heat_level: 3, explicitness: 3, emotional_intensity: 2, consent_clarity: 3, taboo_level: 2, plot_weight: 1,
      tone: ["reflective", "anecdotal"],
      pacing: ["episodic", "measured"],
      literary_style: ["classical-arabic-tradition", "mixed-verse-prose"],
      relationship_dynamic: ["marriage", "courtship"],
      trope_tags: ["manual", "poetic-interludes"],
      kink_tags: ["sensuality-focus"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-historical"],
      content_warnings: ["dated-gender-norms", "translation-era-biases"]
    },
    {
      id: "ananga_ranga",
      title: "Ananga Ranga",
      author: "Kalyana Malla (trans. Burton & Arbuthnot)",
      year: 1885,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org",
      category: "sexuality-literature",
      subgenre: "manual",
      description: "A 16th-century Sanskrit manual intended for married couples, focused on sustaining long-term erotic connection. Translated in the Victorian era alongside the Kama Sutra. A short, pragmatic work — more concerned with companionship than conquest.",
      heat_level: 2, explicitness: 2, emotional_intensity: 3, consent_clarity: 4, taboo_level: 1, plot_weight: 1,
      tone: ["contemplative", "pragmatic"],
      pacing: ["measured", "concise"],
      literary_style: ["aphoristic", "classical-sanskrit-tradition"],
      relationship_dynamic: ["long-term-partnership", "marriage"],
      trope_tags: ["marital-intimacy", "practical-wisdom"],
      kink_tags: ["sensuality-focus"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-historical"],
      content_warnings: ["dated-gender-norms"]
    },
    {
      id: "satyricon",
      title: "Satyricon",
      author: "Petronius (various translations)",
      year: -60,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/5611",
      category: "classical-literature-with-erotic-themes",
      subgenre: "satirical-novel",
      description: "A fragmentary Latin novel from Nero's Rome — satirical, picaresque, and unapologetically bawdy. More social comedy than erotica, but threaded with sexual episodes that give an unfiltered window into Roman attitudes. Literary value is enormous; erotic intensity is episodic.",
      heat_level: 3, explicitness: 3, emotional_intensity: 2, consent_clarity: 2, taboo_level: 4, plot_weight: 4,
      tone: ["satirical", "wry", "biting"],
      pacing: ["episodic", "uneven"],
      literary_style: ["classical-latin-tradition", "satirical", "picaresque"],
      relationship_dynamic: ["shifting-triangles", "no-attachment"],
      trope_tags: ["picaresque", "social-satire"],
      kink_tags: ["multi-partner", "power-dynamics-era-typical"],
      gender_pairing: ["m/f", "m/m"],
      orientation_tags: ["polymorphous", "queer-historical"],
      content_warnings: ["dated-attitudes", "consent-ambiguity", "fragmentary-text"]
    },
    {
      id: "decameron",
      title: "The Decameron",
      author: "Giovanni Boccaccio",
      year: 1353,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/23700",
      category: "classical-literature-with-erotic-themes",
      subgenre: "frame-story-collection",
      description: "One hundred tales told by ten young Florentines sheltering from the plague — ranging from witty to earthy to explicitly sexual. A landmark of world literature. Many tales are sharp, comic, and decidedly adult, with themes of seduction, infidelity, and desire.",
      heat_level: 3, explicitness: 2, emotional_intensity: 3, consent_clarity: 3, taboo_level: 3, plot_weight: 5,
      tone: ["wry", "humanist", "varied"],
      pacing: ["episodic", "compact-tales"],
      literary_style: ["medieval-humanist", "literary"],
      relationship_dynamic: ["varied", "infidelity-themes", "courtship"],
      trope_tags: ["frame-story", "seduction-comedy", "moral-inversion"],
      kink_tags: ["power-dynamics-era-typical"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["dated-attitudes", "infidelity-themes"]
    },
    {
      id: "the_lover_ovid",
      title: "The Art of Love (Ars Amatoria)",
      author: "Ovid",
      year: -2,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/47677",
      category: "classical-literature-with-erotic-themes",
      subgenre: "instructional-poetry",
      description: "A Roman poetic treatise on seduction, courtship, and love. Witty, subversive, and unapologetically focused on the art of desire. Not erotica in the modern sense — closer to playful philosophical instruction that scandalised Augustus himself.",
      heat_level: 2, explicitness: 2, emotional_intensity: 3, consent_clarity: 3, taboo_level: 3, plot_weight: 2,
      tone: ["wry", "knowing", "reflective"],
      pacing: ["measured", "aphoristic"],
      literary_style: ["classical-latin-tradition", "verse", "aphoristic"],
      relationship_dynamic: ["courtship", "flirtation"],
      trope_tags: ["instructional", "seduction-philosophy"],
      kink_tags: ["sensuality-focus"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-historical"],
      content_warnings: ["dated-gender-norms"]
    },
    {
      id: "song_of_songs",
      title: "The Song of Songs",
      author: "Unknown (biblical)",
      year: -500,
      source: "Project Gutenberg (Bible texts)",
      source_url: "https://www.gutenberg.org",
      category: "classical-literature-with-erotic-themes",
      subgenre: "lyric-poetry",
      description: "An ancient Hebrew love poem preserved in the biblical canon, remarkable for its frankly sensual imagery and celebration of mutual desire between lovers. A short, intense work — more incantation than narrative, rich in metaphor and tenderness.",
      heat_level: 2, explicitness: 1, emotional_intensity: 5, consent_clarity: 5, taboo_level: 1, plot_weight: 1,
      tone: ["lyrical", "tender", "reverent"],
      pacing: ["short", "imagistic"],
      literary_style: ["hebrew-poetic-tradition", "metaphor-rich", "lyrical"],
      relationship_dynamic: ["mutual-longing", "celebration"],
      trope_tags: ["lyric-love", "nature-imagery"],
      kink_tags: ["sensuality-focus"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-traditional"],
      content_warnings: []
    },
    {
      id: "venus_in_furs",
      title: "Venus in Furs",
      author: "Leopold von Sacher-Masoch",
      year: 1870,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/6852",
      category: "historical-erotic-literature",
      subgenre: "psychological-novel",
      description: "The novella that gave masochism its name. A man enters an intentionally asymmetrical arrangement with a woman he adores, exploring dynamics of submission and emotional power. More psychologically intense than physically explicit — a study of desire as self-annihilation.",
      heat_level: 3, explicitness: 2, emotional_intensity: 5, consent_clarity: 4, taboo_level: 4, plot_weight: 4,
      tone: ["intense", "psychological", "obsessive"],
      pacing: ["slow-burn", "dialogue-heavy"],
      literary_style: ["literary", "psychological-novel", "continental"],
      relationship_dynamic: ["dominance-submission", "contractual", "power-exchange"],
      trope_tags: ["power-exchange", "obsession", "contract"],
      kink_tags: ["dominance-submission", "masochism", "power-exchange", "fetish"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["power-imbalance-themes", "psychological-intensity", "self-negation"]
    },
    {
      id: "my_secret_life",
      title: "My Secret Life",
      author: "Anonymous (\"Walter\")",
      year: 1888,
      source: "Internet Archive",
      source_url: "https://archive.org",
      category: "historical-erotic-literature",
      subgenre: "sexual-memoir",
      description: "An extraordinarily long pseudonymous Victorian memoir detailing a man's sexual encounters across decades. Of considerable historical interest as an unvarnished social document of Victorian sexuality, though much of the content is ethically troubling by modern standards. Not recommended as entertainment.",
      heat_level: 5, explicitness: 5, emotional_intensity: 2, consent_clarity: 1, taboo_level: 5, plot_weight: 1,
      tone: ["detached", "clinical", "transgressive"],
      pacing: ["relentless", "catalogue-like"],
      literary_style: ["victorian", "memoir"],
      relationship_dynamic: ["transactional", "power-imbalance"],
      trope_tags: ["memoir", "social-document"],
      kink_tags: ["multi-partner", "power-dynamics-era-typical"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["consent-violations", "exploitation", "class-power-imbalance", "dated-attitudes", "historical-study-only"]
    },
    {
      id: "lady_bumtickler",
      title: "The Autobiography of a Flea",
      author: "Anonymous",
      year: 1887,
      source: "Internet Archive",
      source_url: "https://archive.org",
      category: "historical-erotic-literature",
      subgenre: "victorian-underground",
      description: "A Victorian anonymously-published work narrated improbably by a flea observing human affairs. More notable as a curious specimen of 19th-century clandestine publishing than for its literary merit. The framing device gives some distance from the explicit content.",
      heat_level: 4, explicitness: 4, emotional_intensity: 1, consent_clarity: 1, taboo_level: 5, plot_weight: 2,
      tone: ["satirical", "transgressive", "detached"],
      pacing: ["quick", "episodic"],
      literary_style: ["victorian", "unusual-framing"],
      relationship_dynamic: ["multiple-partners", "power-imbalance"],
      trope_tags: ["unusual-narrator", "social-satire-veiled"],
      kink_tags: ["multi-partner", "power-dynamics-era-typical"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["consent-violations", "abuse-of-power", "dated-attitudes", "period-typical-problematic-content"]
    },
    {
      id: "lysistrata",
      title: "Lysistrata",
      author: "Aristophanes",
      year: -411,
      source: "Project Gutenberg",
      source_url: "https://www.gutenberg.org/ebooks/7700",
      category: "classical-literature-with-erotic-themes",
      subgenre: "comic-drama",
      description: "The ancient Athenian comedy where the women of Greece collectively withhold sex until the men agree to end the Peloponnesian War. A bawdy, sharply political comedy — its erotic energy drives the premise but is channeled through satire rather than explicit scenes.",
      heat_level: 2, explicitness: 2, emotional_intensity: 3, consent_clarity: 4, taboo_level: 2, plot_weight: 5,
      tone: ["satirical", "comic", "political"],
      pacing: ["quick", "dramatic"],
      literary_style: ["greek-drama", "comic"],
      relationship_dynamic: ["marriage", "political-power"],
      trope_tags: ["social-satire", "gender-politics", "collective-action"],
      kink_tags: ["denial-theme"],
      gender_pairing: ["m/f"],
      orientation_tags: ["hetero-dominant"],
      content_warnings: ["dated-attitudes", "bawdy-language"]
    }
  ];

  const VOCAB = {
    tone: ["sensual","tender","intense","wry","satirical","lyrical","reflective","transgressive","contemplative","melodramatic","obsessive","detached"],
    pacing: ["slow-burn","quick","episodic","meandering","measured","relentless","dialogue-heavy","scene-heavy","compact-tales"],
    style: ["ornate","classical","literary","aphoristic","vernacular","metaphorical","psychological-novel","verse","concise","continental"],
    dynamic: ["mentor-student","multiple-partners","dominance-submission","contractual","power-exchange","courtship","long-term-partnership","marriage","forbidden","mutual-longing","transactional"],
    trope: ["coming-of-age","forbidden-desire","awakening","power-exchange","obsession","memoir","frame-story","social-satire","marital-intimacy","philosophy-of-pleasure","lyric-love","gender-politics","seduction-comedy"],
    kink: ["voyeurism","dominance-submission","masochism","power-exchange","fetish","sensuality-focus","technique-focus","denial-theme","multi-partner"],
    orientation: ["hetero-dominant","bi-curious-hints","polymorphous","queer-historical","hetero-traditional","hetero-historical"]
  };

  const SCENARIOS = [
    {
      id: "high-spice-low-taboo",
      name: "High spice, low taboo",
      desc: "Intensity and explicitness without transgressive themes. Modern sensibilities, clear consent.",
      tags: ["explicit","contemporary-feel","no-taboo"],
      profile: {
        heat: 5, explicit: 5, emotion: 4, consent: 5, taboo: 1, plot: 2,
        tone: ["sensual","intense"], pacing: ["quick","scene-heavy"],
        style: ["literary","concise"], dynamic: ["mutual-longing","long-term-partnership"],
        trope: ["awakening"], kink: ["sensuality-focus","power-exchange"],
        orientation: [], exclude: ["dated-attitudes","consent-violations","consent-ambiguity","exploitation","underage-content-highly-disturbing","incest-theme"],
        warnStrict: "strict"
      }
    },
    {
      id: "literary-classics",
      name: "Literary erotic classics",
      desc: "Ornate prose, cultural significance, measured pacing. The canon, not the underground.",
      tags: ["literary","classical","slow-burn"],
      profile: {
        heat: 3, explicit: 2, emotion: 4, consent: 4, taboo: 2, plot: 4,
        tone: ["reflective","lyrical","wry"], pacing: ["slow-burn","measured"],
        style: ["literary","ornate","classical","aphoristic"], dynamic: ["courtship","long-term-partnership","mutual-longing"],
        trope: ["lyric-love","philosophy-of-pleasure","frame-story"], kink: ["sensuality-focus"],
        orientation: [], exclude: ["underage-content-highly-disturbing","exploitation","consent-violations"],
        warnStrict: "moderate"
      }
    },
    {
      id: "plot-heavy-romance",
      name: "Plot-heavy erotic romance",
      desc: "Narrative architecture comes first. Strong characters, arcs, and stakes — desire woven through story.",
      tags: ["story-first","character-driven"],
      profile: {
        heat: 3, explicit: 3, emotion: 4, consent: 4, taboo: 2, plot: 5,
        tone: ["wry","tender","reflective"], pacing: ["slow-burn","dialogue-heavy"],
        style: ["literary","psychological-novel"], dynamic: ["courtship","forbidden","marriage"],
        trope: ["coming-of-age","social-satire","seduction-comedy"], kink: ["sensuality-focus"],
        orientation: [], exclude: ["underage-content-highly-disturbing","consent-violations","exploitation"],
        warnStrict: "moderate"
      }
    },
    {
      id: "curious-cautious",
      name: "Curious but cautious",
      desc: "A beginner-friendly entry point. Lighter heat, strict on warnings and consent clarity.",
      tags: ["beginner","gentle","safe"],
      profile: {
        heat: 2, explicit: 2, emotion: 3, consent: 5, taboo: 1, plot: 4,
        tone: ["tender","lyrical","reflective"], pacing: ["measured","slow-burn"],
        style: ["literary","aphoristic"], dynamic: ["courtship","long-term-partnership","mutual-longing"],
        trope: ["lyric-love","marital-intimacy","philosophy-of-pleasure"], kink: ["sensuality-focus"],
        orientation: [], exclude: ["consent-violations","consent-ambiguity","exploitation","underage-content-highly-disturbing","incest-theme","dated-attitudes","transgressive-scenarios"],
        warnStrict: "strict"
      }
    },
    {
      id: "dark-tone-strict-control",
      name: "Darker tone, strong warning control",
      desc: "Willing to explore psychologically heavier work, but with firm limits on what's allowed in.",
      tags: ["intense","controlled"],
      profile: {
        heat: 3, explicit: 3, emotion: 5, consent: 4, taboo: 3, plot: 4,
        tone: ["intense","obsessive","psychological","transgressive"], pacing: ["slow-burn","dialogue-heavy"],
        style: ["psychological-novel","literary","continental"], dynamic: ["dominance-submission","power-exchange","obsession","forbidden"],
        trope: ["obsession","power-exchange"], kink: ["dominance-submission","power-exchange","masochism"],
        orientation: [], exclude: ["underage-content-highly-disturbing","exploitation","consent-violations","incest-theme"],
        warnStrict: "strict"
      }
    }
  ];

  const DEFAULT_WEIGHTS = {
    heat: 1.0, explicit: 1.0, emotion: 1.0, consent: 1.5, taboo: 1.2,
    plot: 0.8, tone: 0.9, pacing: 0.6, style: 1.0, dynamic: 1.0,
    trope: 1.1, kink: 1.3, orientation: 0.8
  };

  const DEFAULT_PROFILE = {
    heat: 3, explicit: 3, emotion: 3, consent: 5, taboo: 2, plot: 3,
    tone: [], pacing: [], style: [], dynamic: [], trope: [], kink: [],
    orientation: [], exclude: [],
    warnStrict: "moderate",
    // Conversational-companion preferences used by Sara to tailor
    // tone and filtering. Hard constraints land in the system
    // prompt; soft ones become hints.
    readingLevel: "casual",         // "casual" | "literary" | "academic"
    formatPreference: "any",         // "any" | "audiobook" | "ebook" | "hardcover" | "paperback"
    spoilersEnabled: false
  };

  const READING_STATES = [
    { id: "none",    label: "Not tracked",     short: "—" },
    { id: "want",    label: "Want to read",    short: "Want" },
    { id: "reading", label: "Currently reading", short: "Reading" },
    { id: "read",    label: "Already read",    short: "Read" },
    { id: "skip",    label: "Not for me",      short: "Skip" }
  ];

  /* Previously the 15 historical titles were the app's default catalogue,
     populating Home, Library, Compare, and the profile preview on first
     run. That's now an explicit opt-in: the same list is exposed as
     SEED_BOOKS and loadable from Settings. window.LumenData.BOOKS stays
     as an empty array so any stray call site receives a safe default
     instead of crashing. */
  const SEED_BOOKS = BOOKS;

  /* ALL_WARNINGS used to be derived from BOOKS at load time. With BOOKS
     empty by default the profile exclusion UI needs a dependable list,
     so we curate it here. Values match the union of warnings in
     SEED_BOOKS; the list is hand-maintained so it stays stable
     regardless of what's currently in the library. */
  const ALL_WARNINGS = [
    "abuse-of-power",
    "bawdy-language",
    "class-power-imbalance",
    "consent-ambiguity",
    "consent-violations",
    "dated-attitudes",
    "dated-gender-norms",
    "exploitation",
    "fragmentary-text",
    "historical-study-only",
    "incest-theme",
    "infidelity-themes",
    "period-typical-consent-ambiguity",
    "period-typical-problematic-content",
    "power-imbalance-themes",
    "psychological-intensity",
    "recommended-with-extreme-caution",
    "self-negation",
    "sex-work",
    "transgressive-scenarios",
    "translation-era-biases",
    "underage-content-highly-disturbing"
  ];

  window.LumenData = {
    /* Legacy export: BOOKS is now an empty catalogue. Every surface
       reads from user state. Use SEED_BOOKS when you need the
       historical starter list (e.g. the Settings loader). */
    BOOKS: [],
    SEED_BOOKS,
    VOCAB, SCENARIOS,
    DEFAULT_WEIGHTS, DEFAULT_PROFILE,
    READING_STATES, ALL_WARNINGS
  };
})();
