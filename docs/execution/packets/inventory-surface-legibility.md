# inventory-surface-legibility — operator-readable inventory surfaces

Date: 2026-08-19
Base: `ca6fe310cb10da883a009525dab6b3fb9f8a872c`
Branch: `packet/inventory-surface-legibility`
Tier: Behavioral
Status: **EVIDENCE READY — awaiting the user-run Behavioral review.** The
product, tests and bounded command-order ruling are committed at `c395788`.
The exact frozen packet tip is named in the emitted review prompt. No review or
full matrix has run yet.

## Packet definition

Goal: make the existing Inventory-facing surfaces read like an ERP rather than
like their compiler/runtime implementation, closing `ux-list-usability`,
`ux-clutter`, `surface-command-order`, and the visibility half of
`relation-update-fork` in one presentation subject.

One product source file changed: `apps/web/src/component-registry.ts`. Browser
and integration assertions changed only where the rendered business vocabulary
or order changed. No file under `packages/domain/**` or `apps/web/release/**`
was touched; those paths remained with the concurrent
`stock-on-hand-browsable` lane. No form-admission function or condition changed.

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

`fieldLabel()` now removes the current entity prefix and trailing identity
suffix before sentence-casing, while preserving the closed acronym spellings
API, ERP, ID, SKU, UOM and URL. `entityLabel()` applies the same business-label
rule after removing the surface-role suffix. Redundant eyebrows and copy about
compiled workspaces, releases, manifests and record-scoped implementation were
removed or rewritten as operator-facing workspace language.

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
was applied only after the green implementation commit and restored by patch;
`git diff --exit-code -- apps/web/src/component-registry.ts` then confirmed the
committed source was restored.

| Temporarily removed or bypassed | Observed red |
|---|---|
| rendered search form | table browser test timed out locating `Search records` |
| Previous link | table browser test failed: `Previous page` not found |
| compiled display title | table browser test failed: `Open Party Page filler 001` not found |
| entity-prefix stripping | table browser test observed `PARTY ROLE KIND` |
| command presentation sort | command browser test observed `Cancel, Release` instead of `Release, Cancel` |
| relation-freeze rendering | composed Inventory journey failed because `[data-relation-freeze]` was absent |

These are six independent vacuity vectors for the four filed rows; the three
list defects are not treated as one interchangeable assertion.

## Required pre-review gates

All ran on the restored executable tree containing `c395788`:

- `pnpm typecheck` — pass
- `pnpm lint` — pass
- `pnpm format` — pass
- `pnpm test:browser` — **90/90 pass**
- `pnpm test:integration` — **148/148 pass**
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
  meaning after business record titles made broad text locators ambiguous.
- No out-of-lease product bridge was taken.
- The generic command-order carrier remains intentionally deferred until the
  replacement trigger in ADR-0056 fires.
- A program review is already **DUE** at the completed required-relation
  checkpoint. This packet is still mid-flight and therefore an anti-trigger;
  propose the read-only whole-app review on clean integrated `main` after this
  packet is accepted and before another fan-out. Do not run it from this lane.
