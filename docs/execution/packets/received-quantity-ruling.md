# received-quantity-ruling — ADR-0065, how received quantity persists

**A document packet.** It ships one ADR and this record, touches no executable
path, and the human read is the review. It rules, for `PUR-2` and `SAL-2`
together, how `received_quantity` and its mirror `shipped_quantity` persist,
where over-receipt is refused, and how the stored value is rebuilt and
reconciled — the decision `PUR-2c` §3 deferred and `current-plan.md`'s critical
path lists as *"parallel, now … unblocks step 2's charter"*.

- **Tier:** Behavioral, as chartered. The packets that build against the ADR are
  Critical; this one changes no behaviour.
- **Branch:** `packet/received-quantity-ruling`, cut from `origin/main` at
  `4218a66068041eb04e45e6fff4883c8aa8dfaebf` (measured with
  `git rev-parse origin/main` after `git fetch`, not taken from the charter).
  Worked in a fresh worktree, `../2rain-greenfield-rqr`; the shared checkout is
  `ENUM-WIDEN`'s.
- **ADR number:** 0065. ADR-0064 is reserved to `enum-widen` and is not touched.
- **Stops:** 0.
- **Diff:** narrative only. Per `mission-cadence`, *"a packet whose diff is
  narrative-only declares nothing and owes no block"* — there is no
  `record-claim` block in this record, and that absence is the declaration.
- **Frozen SHA:** `8924c67579684706634fd33e1e450f6e6538957c` is the content commit (ADR, record, rows); the gates below ran at it, and the two commits above it pin this table (the first pin left the architecture cell pending through a shell quoting slip, the second fills it); the branch tip is a narrative-only delta of this record, the ledger row and the lane row

## 1. The stop condition was tested first, and it did NOT fire

The charter's stop condition: if a fact the ruling needs genuinely does not
exist on `main`, stop and name it. `pur-2c.md` §3 claimed four such facts —
*"the posting protocol, locking rule, lineage, and concurrency evidence needed
to choose a persistence model do not yet exist."* Each was measured at the
symbol on `main` at the base SHA; the table is in the ADR's *Context*. Three
exist (`#post` with the family binding of ADR-0060; `acquireStockIdentityLocks`
first after `BEGIN` plus the source row locks and the period lock;
`enforceNegativeStock` walking serialized ledger state) and the fourth —
movement-to-order-line lineage — does not exist and **does not discriminate
between the candidates**, since a counter, a sum and a projection all need the
same attribution. A fifth fact `pur-2c.md` did not name, the persisted-and-verified
projection shape, exists as ADR-0057 plus `PUR-2a` round 8's
`assertPostedStockBalancesReconcile`.

So the ruling is made, on precedent that is on `main`, and the packet did not
stop.

## 2. What the plan withdrew, and what the ADR inherits instead

`purchasing-sales-v1-plan.md` §7.12 still says `PS-0` evidenced both a
stored-CAS arm and a derived lock-and-sum arm. §7.15 withdrew the second:
*"no arm sums movements … it supported a lock around a stored counter."* The ADR
quotes both and states the corrected base: `PS-0` showed a lock around a stored
counter closes the race; `main` has since shown, in gated code, that an
invariant walked over the serialized ledger closes a quantity race and that a
projection verified against the ledger sum before commit is a working shape. No
ruling in the ADR cites the withdrawn arm.

## 3. The ruling, in one paragraph

**Candidate 3.** Received quantity is a provider-written, rebuildable read model
in ADR-0057's shape — one operationless entity, one row per order line, its
stored value exactly the ledger sum of movements attributed to the line,
maintained inside the posting transaction and refused unless it equals the
recomputed sum before commit. Over-receipt is refused inside `#post`, after the
locks and before any insert, against the ledger under a row lock on the order
line, with the bound `0 ≤ received ≤ ordered` on the sum. Rebuild is the
materializer's, reconciliation is a read-only arm of the existing instrument,
and attribution must be recoverable from persisted post-immutable facts. An
amendment never touches the row; open-to-receive is derived and never stored;
the amend floor cannot be a compiled precondition (a `fieldComparisonPredicate`
compares a field to a scalar, never to a field) so it lives in a registered
handler, and the invariant still holds at every commit. `SAL-2` mirrors the
shape exactly, with negative stock as a second independent invariant and
reservation as a separate fact family. The candidate table, the placement
argument (separate entity, not a column), the ten claims `PUR-2c` must prove,
and the list of what is NOT decided are in the ADR.

## 4. Gates

Only the two the charter names; a document packet runs nothing else.

| gate | at | result |
|---|---|---|
| `scripts/check-records.sh` | `8924c67` | `records: OK (138 record(s), 5 declaring: 42 claimed path(s) and 68 claimed symbol(s) observed in their frozen trees; 159 ledger row(s), ids unique)`, `EXIT=0`. This record is the 138th and declares nothing, which is the declaration |
| `corepack pnpm test:architecture` (reads `docs/**`; Docker up; exclusive lock free — `ENUM-WIDEN` was not holding it) | `8924c67` | `# tests 189` / `# pass 189` / `# fail 0`, `duration_ms 52667`, `EXIT=0`. Run in the fresh worktree with Docker up; the exclusive lock was free |

`pnpm format` was not run: `.prettierignore` excludes `docs/`, so a narrative
packet cannot make it red.

## 5. Lease

Written: `docs/decisions/ADR-0065-received-quantity-is-a-rebuildable-ledger-sum.md`
(new), this record (new), one ledger row and the `RULING` lane row. Nothing under
`packages/`, `apps/`, `db/` or `test/` was touched; `git status` on the worktree
shows exactly those four paths. Under the QUEUE FREEZE no row was added to
`current-plan.md`; nothing found here blocks a critical-path step (§7).

## 6. Test it yourself

Under ten minutes; no diff reading. Open the ADR and check three of its claims
against the three source symbols they rest on. From the repository root on
`packet/received-quantity-ruling`:

**A. Claim: over-receipt is refused the way negative stock is — against
serialized ledger state, under locks taken before any work (~3 min).**

```bash
grep -n "acquireStockIdentityLocks(client, identities)\|^async function enforceNegativeStock\|toSorted(compareInventoryMovementOrderEntries)\|'INVENTORY_STOCK_NEGATIVE'," packages/postgres-provider/src/inventory-posting-service.ts
```

Expect four hits. Open `#post` at the first: the lock call sits immediately after
`BEGIN` and `set_config('lock_timeout', …)`, before any read. Open
`enforceNegativeStock` at the second: it selects the persisted movements of the
stock identity, merges the planned ones, sorts, and walks a running total,
throwing inside the transaction. The ADR's *Where over-receipt is refused* copies
this shape and changes only the serialization unit (order line) and the bound.

**B. Claim: a provider-written projection is verified against the ledger sum
before the posting commits (~2 min).**

```bash
grep -n "^async function assertPostedStockBalancesReconcile\|coalesce(sum(\|does not equal the movement ledger it projects" packages/postgres-provider/src/inventory-posting-service.ts
```

Expect three hits. The function recomputes `sum(quantity_delta)` from the
movement table for the affected identity and proves the trigger-written row
equals it, or refuses. This is the ADR's *maintained inside the posting
transaction and refused unless it equals the ledger sum*.

**C. Claim: reconciliation is independent and non-healing by construction
(~2 min).**

```bash
grep -n "SET LOCAL transaction_read_only = on\|INVENTORY_RECONCILIATION_TRANSACTION_NOT_READ_ONLY\|POSTED_STOCK_BALANCE_LEDGER_DIVERGED\|repairedSubjectCount: 0" packages/postgres-provider/src/inventory-reconciliation-service.ts
```

Expect four hits. The sweep runs read-only and refuses to run otherwise; the
posted-stock arm reports divergence and repairs nothing. The ADR's
*reconciliation obligation* adds an arm of exactly this kind.

**D. The one compiler fact that decided placement (~1 min).**

```bash
grep -n "kind: 'fieldComparisonPredicate'" -B 12 packages/canonical-model/src/predicate-kernel.ts | grep -n "fieldReference\|VersionedCanonicalScalarSchema"
```

Expect two lines: the left side must be a `fieldReference` and the right side a
scalar. That is why the ADR says the amend floor cannot be a compiled
precondition, and it is one of the two reasons the read model is a separate
entity rather than a column.

**E. Read, rather than run.** The ADR's candidate table and the paragraph under
it beginning *"The deciding argument is not aesthetic."* If you disagree with the
ruling, that paragraph is where to disagree, and the *What this ADR does NOT
decide* section is what you would be widening.

## 7. Nothing blocks a critical-path step, and two things the orchestrator may want

Filed as report lines, not rows, per the freeze:

- **`purchasing-sales-v1-plan.md` §7.12 still carries the sentence §7.15
  withdrew** (*"Both are supported by the measurement"*). The plan is outside
  this lease; the ADR states the corrected base so a reader of §7.12 alone is
  not misled twice. A one-line correction pointing §7.12 at §7.15 is the
  orchestrator's.
- **Resumed `PUR-2c`'s charter should set Band A for the stored-value claims**
  (ADR claims 3, 4, 7, 8, 10). The charter that commissioned this ADR asked for
  Band B per claim; the ADR lists that as the minimum and says why it is not the
  ceiling.

## 8. Ledger and lane rows

Added: the `received-quantity-ruling` row in `ledger.md`. Updated: the `RULING`
row in `lanes.md`. No other row was touched.
