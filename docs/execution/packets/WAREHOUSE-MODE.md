# WAREHOUSE-MODE — a floor-staff Warehouse view and the period-lock screen

Status: both slices executable on draft PR #18 against `packet/INVENTORY-PARITY` (stacked on #13 <- #11 <- #10 <- #8 <- #7); no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (recommended choices taken, reported at the end).
Tier: outside the Critical set — a canonical grammar key, the compiler's surface projection, the web runtime, domain metadata and the module runtime's period-lock update rule (`module-runtime-interpreter.ts`, not the posting kernel); no posting-kernel, serializer, materializer, activation, verification, trust, migration, RLS or grant change. Stops taken: one part split out (the reason, below).
Base: `packet/INVENTORY-PARITY` at `e3da0a39`. Reference: PaneFlow `d057daff` (`app/inventory-app.tsx:3790-3811`, `app/components/warehouse.tsx`, `operations-suite.tsx:430`); audit rows I20, I22.

## Owner rulings (recommended, taken)

- WM-A: one period lock per company; no per-module locks.
- WM-B: warehouse mode reuses the existing Lists, Tasks and documents; it adds no posting path.
- WM-C: no Count tile until the Critical STOCK-COUNTS packet.
- WM-D: the reason is split out. Recording it with the change needs either a lock column, whose UPDATE grant is column-scoped RLS/grant SQL (`module-storage-materializer.ts`, Critical), or a reason carried by the operation into its trust evidence, which the release verification's generic invocations would then have to supply (Critical). Close and Reopen ship with their review and confirmation; the change document records who, when and the old and new Closed through.
- WM-E: the backdate window is neither shown nor changed: it is provisioning state (`platform.provision_inventory_scope`) that no release query reads.
- WM-F: a lock moves one way per operation. Close (advance) only later, Reopen only earlier or fully open, held by the module runtime, so Close cannot bypass the reopen permission and its confirmation.

## Claims

1. `surface.launcher` (optional v6 key on a Task surface): tiles (1-6) that each open a declared List at one of its declared views, and an optional scan box (label, action label, 1-8 targets of a resolve query and a record page). The validator refuses, by name, a launcher off a Task, duplicate tile ids, a tile that is not an active declared List, a view that List does not declare, a target that is not an active resolve query with an identifier key, a target page that is not a record page of the entity it resolves, and two targets of one entity. A launcher Task may be a navigation member (`navigation members must be Lists or launcher Tasks`).
2. Surface floor 18 when any surface declares a launcher (17 is REPLENISHMENT's, landing beside it); the runtime supports 18. A reader that dropped the key would serve the on-hand lookup's raw id inputs under the Warehouse name.
3. Inventory → **Warehouse** is a launcher Task over the on-hand lookup's own company-scoped query, entered like a List (it may default the company) and authorized by the Posted stock List's query. Tiles: Receive → Expected receipts *To receive*, Put away → Inventory transactions *Transfers*, Pick and ship → Sales orders *To ship*; each shows its view's count, asked exactly as the List counts its tab, and a count current policy withholds is omitted, never guessed. The on-hand lookup itself is unchanged and contextual.
4. The scan box (focused on arrival, a plain GET, no script) resolves the trimmed code (at most 120 characters) through each target in declared order — purchase order, sales order, goods receipt, shipment, stock document, then item — in the page's company; the first exact identifier match opens its record page in that company (an item at its stock). A name or several matches open nothing (`SCAN_NOT_EXACT`); nothing at all, or only targets current policy withholds, reads `SCAN_NO_MATCH`; the code stays in the box.
5. The period lock page is a composition with "Close period through" (`advance_period_lock`) and "Reopen to" (`reopen_period`, offered only while Closed through is set), each a Task with one required UTC instant, reviewed and confirmed under its own permission; Reopen's operation also takes its human confirmation grant. A closed period refuses postings inside the posting transaction (`INVENTORY_PERIOD_CLOSED`), as before.
6. A Task's instant input bound to a UTC date-time field renders the draft editor's `datetime-local` picker, to the second, labelled "(UTC)", and sends the field's canonical spelling (`…:59.000Z` at millisecond precision); an unreadable value is refused beside its input before anything runs.
7. The module runtime refuses a period-lock advance that does not move Closed through later (or sets none) and a reopen that does not move a closed lock earlier or open it, `MODULE_PERIOD_LOCK_DIRECTION_INVALID`, with nothing written.
8. A record composition with record commands gains the command bar a read-only record never declared (the period lock's), as it gains sections and child tables.

## Decisions

- One Task surface (`inventory_warehouse`) rather than turning the on-hand lookup into the Warehouse: the as-of lookup by ids keeps its journeys. "Reuse" is its query, its archetype and its scan-first slot.
- Scan targets are tried in declared order without prefix rules: documents first, then items; at most six resolves per scan, each authorized under current policy.
- Put away opens the Transfers view, where New starts a transfer document; opening the editor preset to Transfer would need an editor preset key (filed).
- Navigation keeps module groups: Warehouse is an Inventory leaf (top-level entries stay five).
- The launcher module (`apps/web/src/surface-launcher.ts`) joins the SurfaceRuntime seam allowlists as a generic interpreter delegated only by SurfaceRuntime and its registry.
- Test fixtures that strip Sales (compiler) or a resolve query (compiler) drop the launcher's dependent tiles and targets; the composed-inventory helper pins the period lock's composition.

## Gates

- Local, on `e21319e0`: tsc clean; eslint and prettier clean on every changed file; release entry 7 rebuilt from INVENTORY-PARITY's six-entry envelope (28,924,518 -> 34,100,056 B), `--check` PASS, demo `--check` PASS; unit 212/212 (new `surface-launcher` 3/3); compiler 177/180 (+2 fixtures fixed; the third is `COMPILE_BUDGET_INDETERMINATE`, CPU idle 66%, the perf job's); integration 243/243 plus WAREHOUSE-MODE 2/2; web contract 39/39; architecture (grammar, seam, ux pin, purity, press law, reachability, hygiene) green but the matrix-lock control, refused over another lane's live container (the gate working); language coverage 2673 -> 2681 obligations, 831 -> 838 observed, PASS.
- Pins from the compile: surfaces 101 -> 102, navigation leaves 16 -> 17 (Inventory adds Warehouse), surface floor 16 -> 18, runtime support 16 -> 18, message catalog 48 -> 50; verification plan 573 scenarios, unchanged; no storage change, so the full-replay schema snapshot is not regenerated.
- PostgreSQL `period-lock-commands` and the operations browser spec `inventory-warehouse-mode`: see the CI line.
- CI on PR #18: pending.

## Test it yourself

`WAREHOUSE-MODE-test-it-yourself.md`: §1 the Warehouse, §2 the period lock.

## Deferred

- The reason on Close and Reopen (WM-D, Critical: the lock's column grant or the operation's evidence).
- A Count tile (STOCK-COUNTS, Critical); showing or changing the backdate window (POSTING-FORWARD-DATE); per-module locks (not in the plan).
- PaneFlow's "next receipt" panel and directed tasks (N3-02).

## Filed

- A record Task's way back reads "Back to order" on every record, the period lock's included.
- The period lock page's title is its Closed through value, "—" while open: the lock has no name of its own.
- A refused confirmed Task reads "could not be verified … Retry" (`COMPOSITION_UNCERTAIN`) even when the refusal is certain, as every record Task does.
- Put away could open a new transfer directly with an editor preset key.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WAREHOUSE-MODE",
  "base": "e3da0a3918620c5ce3e494eba3fdf1b3f8c91c4a",
  "head": "HEAD_PLACEHOLDER",
  "changedPaths": [],
  "symbols": []
}
```

Review: not owed — outside the Critical set.
