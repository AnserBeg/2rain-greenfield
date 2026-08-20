# inventory-surface-legibility — operator-readable inventory surfaces

Date: 2026-08-19; revised 2026-08-20 after Behavioral review rounds 1–2
Base: `ca6fe310cb10da883a009525dab6b3fb9f8a872c`
Branch: `packet/inventory-surface-legibility`
Tier: Behavioral
Status: **EVIDENCE READY — round-2 evidence REVISE corrected; awaiting a fresh
Behavioral review.** The corrected product remains committed at `f95d6e5`; the
round-2 test-only correction is `a0b1100`; the bounded command-order ruling
remains at `c395788`. The exact frozen packet tip is named in the emitted review
prompt. No full matrix has run.

## Packet definition

Goal: make the existing Inventory-facing surfaces read like an ERP rather than
like their compiler/runtime implementation, closing `ux-list-usability`,
`ux-clutter`, `surface-command-order`, and the visibility half of
`relation-update-fork` in one presentation subject.

Two product presentation files changed: `apps/web/src/component-registry.ts`
and the reviewer-required bridge `apps/web/src/surface-runtime.ts`. Browser and
integration assertions changed only where rendered business vocabulary or
order changed. No file under `packages/domain/**` or `apps/web/release/**` was
touched; those paths remained with the concurrent `stock-on-hand-browsable`
lane. No form-admission function or condition changed.

## What changed

### Lists are usable from the rendered page

- A native GET search form now sends the already-supported `q` argument,
  preserves archive and legal-entity scope, enforces the existing 240-character
  maximum in the control, and offers a non-scripted Clear path.
- Shared lists now render Previous as well as Next. Previous uses the runtime's
  opaque cursor encoder and the exact current coverage/search/sort inputs; page
  one intentionally carries no cursor.
- The row link and selection label use the compiled display field. A shortened
  record UUID remains only the fallback when the pinned surface has no usable
  display value.

The distributor checkpoint observed Item coverage `1–100 of 119`, then
`101–119 of 119`, then a return to `1–100 of 119`. Searching for the page-two
record `Air filter — 20 × 20 in` returned `1–1 of 1`.

### Labels use business vocabulary

`entityLabel()` now preserves authored operator copy after removing only the
known surface-role suffix. `fieldLabel()` remains identifier formatting: it
derives the removable prefix from the compiled query's canonical
`sourceEntityId` (or a semantic record's `entityId` in the compatibility
renderer), removes the trailing identity suffix, and preserves the closed
acronym spellings API, ERP, ID, SKU, UOM and URL. Authored copy is no longer
normalized or used to infer canonical structure.

The independent Task-page renderer no longer emits “task surface · compiled
release” or the canonical surface ID. The real shipped `On-hand lookup` journey
reads its authored label, archetype, statuses and canonical ID from the compiled
subject. It asserts the heading's direct operator-visible content: exactly the
authored title plus declared statuses, with neither the canonical ID nor the
entire `${archetype} surface` vocabulary.

The live Item table rendered `Item`, `Base unit`, `Description`, `Name`, and
`SKU`; its first record link read `Field notebook`, not a UUID.

### The current document pair is primary-first

[ADR-0056](../../decisions/ADR-0056-current-document-command-order-is-a-bounded-presentation-rule.md)
rules the narrow presentation fallback: Release first, unknown commands stable
in compiled order, Cancel last. The renderer sorts a copy of the already
admitted commands. It does not change reachability, operation ids, policy,
preconditions, confirmation, execution or form admission.

The distributor release at this base contains no two-command Release/Cancel
surface, so there is no honest `pnpm dev` click path for that pair. The browser
control renders a real two-command record surface, observes `Release, Cancel`,
and then presses Release to prove the reordered controls still dispatch their
own operation. The integration control separately retains the compiler binding
order `Cancel, Release`, proving the change is presentation-only.

### Create-only relations say what is frozen

The create-only rule did not change. On update, the existing disclosure is now
an operator note headed `Locked after creation`; each relation uses its business
label and says it is chosen during creation and cannot be changed later.

The live dev database's previously persisted Stock count line update showed
both `Session` and `Transaction line` under that note while retaining its
existing Save admission. The distributor seed itself still creates no Inventory
records; that already-filed `dev-seed-has-no-inventory` row remains out of scope.

## Controls and deletion observations

Every control is CI-reachable through an existing browser or integration file.
No new test file or reachability registration was needed. Each mutation below
was applied only after its green implementation commit and restored by patch;
`git diff --exit-code` then confirmed both product sources matched the committed
tree.

| Temporarily removed or bypassed | Observed red |
|---|---|
| rendered search form | table browser test timed out locating `Search records` |
| Previous link | table browser test failed: `Previous page` not found |
| compiled display title | table browser test failed: `Open Party Page filler 001` not found |
| entity-prefix stripping | table browser test observed `PARTY ROLE KIND` |
| command presentation sort | command browser test observed `Cancel, Release` instead of `Release, Cancel` |
| relation-freeze rendering | composed Inventory journey failed because `[data-relation-freeze]` was absent |
| classless canonical Task ID rendered under the title | real on-hand journey observed the independently read compiled `surfaceId` in the heading |
| renamed `task surface · runtime release` eyebrow rendered | real on-hand journey rejected `${archetype} surface` and the heading's extra direct content |
| authored-label normalization restored | label browser test could not find `VAT & R&D orders` |
| product List prefix authority changed from `query.sourceEntityId` to its opaque surface ID | label browser test could not find the `Name` column |
| Form field prefix authority changed from the compiled source entity to its opaque surface ID | label browser test could not find the `Number` field |
| Record-section field prefix authority changed from the compiled source entity to its opaque surface ID | label browser test could not find the `Name` fact |
| Record breadcrumb passed through identifier normalization | label browser test could not find authored `A/P & VAT audit` copy |
| compatibility List prefix authority changed from `record.entityId` to its divergent label/surface ID | direct integration specimen rendered `Master name` instead of `Name` |
| relation-picker prefix authority changed from the compiled source entity to its divergent form surface ID | required-relation integration specimen rendered `Master role parent` instead of `Parent` |
| relation-freeze prefix authority changed from the compiled source entity to its divergent form surface ID | update integration specimen rendered `Master role parent` instead of `Parent` |

The first-round historical exact-spelling/class mutations also red, but are not
used as closure evidence after round 2 demonstrated their proxy coupling. The
nine second-round mutations above use equivalent spelling/class survivors and
path-local authority reversions. They supplement the original search, paging,
row-identity, command-order, whole-freeze and authored-copy controls rather than
treating those subjects as interchangeable assertions.

## Behavioral review round 1

The user reviewed the exact remote candidate `be87317bba4670a2ba7adc9e9e421410bdfa6b6f`
over `ca6fe310cb10da883a009525dab6b3fb9f8a872c..be87317bba4670a2ba7adc9e9e421410bdfa6b6f`
and returned REVISE. The executable delta from product candidate `c395788` to
that frozen head was empty.

Two findings were accepted. First, the shipped Inventory Task still exposed a
compiler eyebrow and canonical surface ID through `surface-runtime.ts`, outside
the packet's original one-file premise. Second, the label helper transformed
valid authored business copy and inferred canonical field structure from that
display copy. The correction and four independent deletion controls are
recorded above.

The same review found no form-admission change, upheld ADR-0056 as a bounded
rule, and closed search, backward paging, row identity, command dispatch/order,
relation freeze, and the assertion bridges. Those closed claims are not
reopened by the narrow correction; the fresh review is chartered on the two
corrected findings and their regression boundary.

## Behavioral review round 2

The user reviewed exact remote candidate
`e72fb612a586edeb8c68188d30077c598047a62e`. The correction range contained
product commit `f95d6e5` and narrative-only freeze `e72fb61`. The reviewer
closed both round-1 production findings and again found form admission
unchanged, but returned REVISE on the controls.

Two evidence findings were accepted. First, absence of the former
`.surface-id` class and exact phrase `compiled release` did not exclude a
classless canonical ID or renamed runtime eyebrow. Second, the divergent-copy
fixture still correlated entity and surface identifiers and did not reach the
compatibility List, relation, Record-section and breadcrumb paths changed by
the production fix. Test-only commit `a0b1100` now derives Task expectations
from the compiled subject, uses opaque List/Form/Record surface IDs, and gives
each source-sensitive renderer a divergent specimen. The nine equivalent or
path-local mutations recorded above each red independently. No production or
form-admission code changed in this round.

## Required pre-review gates

All reran on the restored executable tree containing production commit
`f95d6e5` and test-only correction `a0b1100`:

- `pnpm typecheck` — pass
- `pnpm lint` — pass
- `pnpm format` — pass
- `pnpm test:browser` — **91/91 pass**
- `pnpm test:integration` — **149/149 pass**
- `pnpm test:contracts` — **16/16 pass**

Per the packet charter and `git-workflow`, the full matrix runs once only after
review converges. It has not been run early and no matrix result is claimed.

## Human checkpoint and cleanup

`pnpm dev` started the distributor profile at `http://127.0.0.1:4174` with 176
seeded records. A headless browser drove the same server-rendered controls:

1. **Search, paging and row identity:** Catalog → Item; click Next page, click
   Previous page, then search for `Air filter — 20 × 20 in`.
2. **Business labels:** Catalog → Item shows `SKU`, `Base unit`, `Name` and a
   business record link. Inventory → Inventory transaction shows `Actor`,
   `Effective at`, `Number`, `Source`, `State`, and `Type`.
3. **Command order:** no distributor click path exists at this base because the
   release has no two-command document. Run the named browser control; do not
   infer a dev surface that is not shipped.
4. **Visible freeze:** Inventory → Stock count line, open the previously
   persisted checkpoint row, then its edit form; `Locked after creation` names
   `Session` and `Transaction line`. A fresh distributor database has no such
   row because `dev-seed-has-no-inventory` remains filed and untouched.

As predicted by the charter, `pnpm --filter @north-star/api dev:stop` stopped
the database container but left `node --import tsx src/main.ts` listening on
4174 as PID 84077. The exact process was inspected, killed, and `ss` confirmed
the port had no listener.

## Bridges, limits and next boundary

- Assertion-shape bridges were confined to preserving existing browser-test
  meaning after business record titles made broad text locators ambiguous and
  to expecting the fixture's authored lowercase `master` after the old
  title-casing side effect was removed.
- Review round 1 granted the bounded `apps/web/src/surface-runtime.ts` bridge:
  that file independently owned the Task-page implementation copy named by the
  finding. No other out-of-lease product bridge was taken.
- Review round 2 required only owned browser/integration evidence and
  `learnings.md`; it introduced no product bridge.
- The generic command-order carrier remains intentionally deferred until the
  replacement trigger in ADR-0056 fires.
- A program review is already **DUE** at the completed required-relation
  checkpoint. This packet is still mid-flight and therefore an anti-trigger;
  propose the read-only whole-app review on clean integrated `main` after this
  packet is accepted and before another fan-out. Do not run it from this lane.
