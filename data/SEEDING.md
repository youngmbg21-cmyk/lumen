# Seeding the curated catalog

Three paths to populate `data/catalog.js`. Pick whichever matches how
you want to work.

## Path 1 · in-app importer (best for iterative curation)

Settings → **Curated catalog** card. Three input modes:

- **Titles list** — one `Title — Author` per line. Claude scores
  every field.
- **CSV sparse** — columns `title,author[,description]`. Claude fills
  the rest.
- **CSV full** — the full 26-column schema from `data/CATALOG.md`,
  used as-is.

Preview is editable — click any numeric cell to override Claude's
score (the field's provenance flips from `"ai"` to `"human"` so a
future re-enrich won't overwrite it).

Commit options:

- **Apply to this device** — writes `localStorage["lumen:catalog-override"]`,
  picked up on next reload without touching the repo.
- **Download catalog.js** — drop-in replacement for
  `data/catalog.js`. Commit it and the catalog is versioned.

## Path 2 · Claude Code sub-agent (best for first-run seeding)

If you're already in a Claude Code session, skip the spreadsheet
entirely. Hand Claude a title list or a curation brief; a
`general-purpose` sub-agent researches each title, scores it against
the schema in `data/CATALOG.md`, and writes `data/catalog.js`.

Prompt template:

> Use the `general-purpose` agent to seed `data/catalog.js`. For each
> of the titles below, research the work using your background
> knowledge, fill in every field from the schema in
> `data/CATALOG.md`, bias `content_warnings` toward inclusion, and
> write the resulting array to `data/catalog.js` using the same
> module template that's there now. Confirm every row has all six
> required 1–5 numeric fields.
>
> Titles:
>
> - Memoirs of a Woman of Pleasure — John Cleland
> - Venus in Furs — Leopold von Sacher-Masoch
> - (…100 rows…)

Or a brief:

> Seed `data/catalog.js` with a 100-book curated catalog biased
> toward historical erotica (1700–1920, ~40 titles), contemporary
> erotic romance (~30), and literary fiction with explicit erotic
> focus (~30). Keep `consent_clarity ≥ 3`. Use the schema in
> `data/CATALOG.md`.

The sub-agent should:

1. Produce a `CATALOG_BUILTIN` array matching the existing template
   in `data/catalog.js`.
2. Mark every field `_source: "ai"` inside each row so later re-
   enrichments know what is safe to overwrite.
3. Echo an import report (accepted / rejected / new vocab terms) to
   its final message.

## Path 3 · Node converter (for xlsx workflows)

*Script shipping in a future batch. Until then, use Path 1 with CSV
exported from your spreadsheet.*

```sh
node scripts/xlsx-to-json.mjs path/to/your_catalog.xlsx > data/catalog.js
```

## Fallback (no file upload, no Claude key)

Path 1's paste box accepts TSV, which is what Excel puts on the
clipboard when you copy a range. Select your spreadsheet rows, copy,
paste into the textarea, Parse, Apply or Download.

## Resolution order at runtime

1. `localStorage["lumen:catalog-override"]` (in-app Apply)
2. `data/catalog.js` (repo-committed)
3. empty array

## Provenance

Every book row carries a `_source` map:

```js
{
  heat_level: "ai",
  consent_clarity: "human",
  content_warnings: "human",
  // …
}
```

Re-enrichment only overwrites fields marked `"ai"`. Human edits are
preserved.
