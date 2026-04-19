# Lumen curated catalog — schema

The curated catalog is the trusted internal book corpus used by Discover,
Daily Picks, Compare, Library, and profile-based matching. It lives as
`data/catalog.js`, a plain JavaScript file that exposes
`window.LumenData.CATALOG`.

This document describes the spreadsheet schema the catalog is generated
from, the normalization rules applied during import, and the two
workflows for regenerating `catalog.js` from your master spreadsheet.

> See also [`SEEDING.md`](./SEEDING.md) for the Claude Code sub-agent
> path that generates the catalog from a title list without any
> spreadsheet at all.

## Workflow A · in-app importer (recommended for non-developers)

1. Open **Settings → Import catalog**. *(Shipped in Batch 2.)*
2. Either upload `catalog.csv` or paste the CSV / TSV content directly
   from Excel. Excel's native **Copy** puts TSV on the clipboard, so
   `select range → Ctrl/Cmd+C → paste` is enough.
3. The importer runs the full validator and shows a preview with a
   report: accepted rows, rejected rows, warnings, new vocab terms.
4. Click **Download catalog.js**, replace `data/catalog.js` with the
   downloaded file, commit.
5. *Or* click **Apply to this device** to store the catalog in
   `localStorage` without a commit — useful for iterating.

## Workflow B · Node converter (one command)

*(Shipped in Batch 3.)*

```sh
node scripts/xlsx-to-json.mjs path/to/your_catalog.xlsx > data/catalog.js
```

Reads the first sheet of the workbook, runs the same validator as
Workflow A, prints the report to stderr, and writes `catalog.js` to
stdout.

## Workflow C · fallback (no file upload / no Node)

Paste TSV / CSV directly into the in-app importer's `<textarea>`. The
importer is identical regardless of upload vs paste, and Excel puts
tab-separated text on the clipboard on copy.

## Spreadsheet schema

One row per book. The first row of the spreadsheet **must** be the
header row using these column names (case- and whitespace-insensitive).
List columns use `;` as the separator so they survive CSV round-trips.

| Column                  | Type             | Required | Notes                                                         |
| ----------------------- | ---------------- | -------- | ------------------------------------------------------------- |
| `id`                    | slug             | —        | Blank → auto-generated from title + short hash of author.     |
| `title`                 | string           | **yes**  |                                                               |
| `author`                | string           | **yes**  |                                                               |
| `year`                  | integer          | —        | Negative for BCE. Blank → 0 (unknown).                        |
| `category`              | slug             | —        | e.g. `historical-erotic-literature`, `contemporary-erotic-romance`. |
| `subgenre`              | slug             | —        |                                                               |
| `description`           | string           | **yes**  | 1–3 sentences.                                                |
| `source`                | string           | —        | e.g. `Project Gutenberg`, `Curated`. Defaults to `Curated`.   |
| `source_url`            | URL              | —        |                                                               |
| `thumbnail`             | URL              | —        | Cover image URL.                                              |
| `heat_level`            | 1–5              | **yes**  | Overall sensual/erotic intensity.                             |
| `explicitness`          | 1–5              | **yes**  | Directness of prose.                                          |
| `emotional_intensity`   | 1–5              | **yes**  |                                                               |
| `consent_clarity`       | 1–5              | **yes**  | 5 = on-page unambiguous.                                      |
| `taboo_level`           | 1–5              | **yes**  |                                                               |
| `plot_weight`           | 1–5              | **yes**  | 1 = scene-heavy, 5 = strong narrative architecture.           |
| `tone`                  | `;`-list         | —        | Vocab: see `VOCAB.tone` in `data.js`.                         |
| `pacing`                | `;`-list         | —        | Vocab: `VOCAB.pacing`.                                        |
| `literary_style`        | `;`-list         | —        | Vocab: `VOCAB.style`.                                         |
| `relationship_dynamic`  | `;`-list         | —        | Vocab: `VOCAB.dynamic`.                                       |
| `trope_tags`            | `;`-list         | —        | Vocab: `VOCAB.trope` or freeform.                             |
| `kink_tags`             | `;`-list         | —        | Vocab: `VOCAB.kink`.                                          |
| `gender_pairing`        | `;`-list         | —        | e.g. `m/f; m/m; f/f; m/f/f`.                                  |
| `orientation_tags`      | `;`-list         | —        | Vocab: `VOCAB.orientation`.                                   |
| `content_warnings`      | `;`-list         | —        | Vocab: `ALL_WARNINGS` or freeform.                            |

Unknown columns are ignored with a warning. Columns can appear in any
order.

## Validation and cleanup rules

Identical for both workflows so output is deterministic.

- **Required-field gate** — rows missing any of `title`, `author`,
  `description`, or any of the six 1–5 numeric fields are rejected and
  appear in the import report by row number.
- **Numeric clamp** — numeric fields are `round(parseFloat(v))` clamped
  to `[1, 5]`. Non-numeric values fail the row.
- **Array normalization** — split on `;` (fallback `|` or `,`), trim,
  lowercase, dedupe, drop empties.
- **ID generation** — if `id` is blank, generated as
  `slug(title).slice(0, 48) + "-" + short-hash(author)`. Deterministic.
- **Dedup within import** — last row wins; earlier duplicates warned.
- **Dedup across imports** — catalog replaces by `id`; user state
  (reading status, custom tags, journal, vault pins) is preserved.
- **Missing optional fields** — tag arrays default to `[]`, `year`
  defaults to `0`, `source` defaults to `"Curated"`, `thumbnail` /
  `source_url` default to `null`.
- **Unknown vocab values** — kept but flagged in the report so the
  vocab in `data.js` can be extended deliberately.

## Resolution order at runtime

On boot, `window.LumenData.CATALOG` is read once from whichever source
is available first:

1. `localStorage["lumen:catalog-override"]` — in-app imports apply
   here without touching the repo.
2. `data/catalog.js` — the committed catalog loaded via `<script>`.
3. Empty array.

## How the catalog becomes usable

- `listAllBooks()` in `app.js` merges `CATALOG` with the user's
  `state.discovered`, filtered by `state.hidden`.
- Discover / Daily Picks / Compare / Library / Profile KPIs all read
  from `listAllBooks()`, so the catalog is available everywhere
  immediately once this file is populated.
- Catalog entries carry `_catalog: true` so the UI can badge them as
  *Curated* and make the dismiss action a soft hide (never a delete —
  future re-imports will re-expose the row).
