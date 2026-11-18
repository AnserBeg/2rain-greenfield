# LOOK-1 — every screen in the Ledger look the owner chose

Status: in progress. Mechanical (no Critical path). Base `08260fc2`. Stops, each ruled 2026-11-17: line progress carrier
(option A), icon carrier (option A); plain names for the setup lists required (slice 4).

## Claims

1. The tokens are the spec's (`ledger-spec.md` §1, §3, §4): light, dark (media and `data-theme`), compact and
   comfortable; the stylesheet (`apps/web/src/ledger-styles.ts`) reads tokens only; no colour literal outside the block.
2. `inProgress` rides the accent hue; success, attention and blocked stay outside it (browser gate derives the band
   from the rendered `--accent`); every status keeps colour + glyph + word.
3. The shell: work queues (Today + the landing launcher's declared tiles, counts where the page read them) above the
   area groups; desktop groups always list their destinations; at 900px and below the sidebar is a drawer behind a
   native `<details>` menu button (no script); the top bar searches through the launcher's declared scan.
4. Icons come from a closed set of 20 names declared on a module, a destination's workspace and a launcher tile; an
   undeclared icon falls back to the destination's kind (launcher, list, page).
5. A record page: eyebrow, serif number, status badge with the kind its own List declares (neutral otherwise),
   subtitle; the stepper and the next-step card (one primary button, a sentence from the record's figures); the facts
   grid; per-line progress bars from a declared `presentation.progress`; the totals block from the declared print totals.

## Decisions (one line each)

- Specs live in `apps/web/test/browser/` (the charter's `test/browser/**`).
- Stylesheet moved out of `surface-runtime.ts` into `ledger-styles.ts`; `styles` and `surfaceRuntimeStyles()` stay the
  seam SPEED-1's asset route serves. No inline `style=` added (SPEED-1's sidebar rule wins on merge).
- Fonts: IBM Plex first in each stack, system fallbacks until SPEED-1 slice 5 serves them same-origin.
- Desktop groups stay `<details>` (every nav test contract holds) with `::details-content{content-visibility:visible}`.
- The diagnostic code stays visible on diagnostics (its detail asks the reader to pass it on); hidden elsewhere.
- Next-step sentence: "{open} of {total} {item} still open." / "{units} units still open on {lines} lines." from the
  next Task's `rows` and per-row `fillFrom`; any other next step: "{title} is {status}."; detail "Step n of m · {step}".
- Status kind of a document: the role its own List's status column declares for that state; none → neutral.
- Phone touch targets stay ≥ 44px (ux-grammar), not the mockup's 36px.
- Launcher tiles: four a row, two below 1000px (the WAREHOUSE-MODE contract test moved with them).
- Re-baselines (ADR-0066): the progress and icon keys and their first-party declarations: `dev:reset`.

## Slices

1. Tokens and type — `0f54907e`.
2. Shell — queues, groups, icons, menu, search, demo strip in the sidebar footer.
3. Record page — header, stepper, next-step card, facts, line progress, totals.

## Gates

CI on PR #70. Local: format, typecheck, the unit tests named above, `check:app-release`.

## Test it yourself

`pnpm --filter @north-star/api dev:reset`, `pnpm dev`, <http://127.0.0.1:4174/>: Today in the Ledger look, queues at
the top of the sidebar; walk LOOP-1's path (its record, "Test it yourself"); every page is pale paper with one teal
button; a purchase order shows its stepper, the next step sentence and button, each line's bar.

## Filed

- Stepper captions (date each step was entered; "204 of 210 in") have no source.
- To invoice queue: the sales order List holds its eight views (the language's maximum) and has no shipped-not-invoiced
  figure; the queue waits for one.
- Tenant record types use the structural icon until the customization patch kinds learn the `icon` key.
- Tenant record types have no line datasets yet, so `presentation.progress` does not touch the patch kinds.
- Totals show no currency code: no declared currency column for the totals block.
