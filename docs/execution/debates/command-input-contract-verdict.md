# Command input contract — converged verdict

**Status: CLOSED and binding.** Ruled 2026-08-01 by two independent arms (Codex
`gpt-5.6-sol` xhigh, Fable max) against a shared charter, reconciled by the
orchestrator after verifying both arms' load-bearing claims by reading.

Trigger: [ADR-0038](../../decisions/ADR-0038-capability-backed-surface-operations.md)
ruled the O1 route from a surface to an admitted capability and deliberately left
one question open, naming it the largest — *how does a compiled definition
describe a capability-backed operation's inputs?*

**The arms disagreed fundamentally**, which is why this was worth debating.

## The ruling

**No new canonical grammar. The input contract of a capability-backed operation
is the existing `module-input-contract/v1` node in its record-scoped form.**

The command's business content is **never surface input**. Instead:

1. The user **stages a draft document** through the ordinary `o0` press — a
   header create, then one create per line through the compiled required
   relation. Server-rendered forms the press already ships.
2. The record surface offers the command as a **precondition-gated lifecycle
   action** carrying only a record reference, a revision pin, and a
   render-minted idempotency key.
3. A **capability-local dispatch adapter** hydrates the ratified frozen command
   from the draft rows.
4. `PostgresInventoryPostingService`, **unchanged**, re-verifies the hydrated
   command against those same rows under serialized locks and refuses on any
   divergence.

Arm 2 (Fable) argued this and the orchestrator verified every load-bearing claim.
Arm 1 (Codex) argued for a new versioned `OperationDefinition.input` node at
canonical language **v5**, carrying scalars, nested records and bounded one-level
repeated records.

## Why arm 2 prevailed — verified, not deferred to

Three claims decided it, each checked by reading rather than accepted:

**1. Posting already cross-checks the persisted draft.**
`inventory-posting-service.ts:2245` refuses with
`INVENTORY_TRANSACTION_STATE_CONFLICT` — *"transaction … does not exactly match
the active draft"* — and `:2549` compares persisted quantities. The draft rows
are authoritative; the command's `lines` are a **snapshot that must match**, not
the sole source of truth. ADR-0026 evolved the dependency set specifically to
bind the command to the persisted line set.

**2. `module-input-contract/v1` exists and is already emitted.**
`packages/compiler/src/protocol.ts:46`, consumed by the operation gateway at
`semantic-operation-gateway.ts:129,882`. The builder at
`projections.ts:845-870` keys on `effectKind`: `relationInputs` only for
`createRecordEffect`, fields only when the effect writes fields. **A
`registeredCapabilityEffect` therefore already yields the record-scoped form
today**, incidentally. The implementing packet makes that deliberate with an
explicit arm and a control — it does not invent it.

**3. Arm 1's central objection does not hold.** Arm 1 rejected this shape because
a transaction-id-only command would have to *read* the line set to know which
stock identities to lock, inverting ADR-0026's requirement that stock locks be
acquired immediately after `BEGIN`, before any authoritative business read.

But hydration happens in an **adapter, before the posting transaction opens**.
The service still receives a complete command and locks immediately. A draft that
shifted between hydration and posting is caught by the cross-check in claim 1.
The concurrency protocol is untouched.

## Why this is the cheaper answer, and cheapness is not the only reason

Arm 1's shape requires cutting canonical language **v5** — a near one-way door.
This program treats language versions with visible care: ADR-0031 cut v4
*without adoption* precisely so nothing moved, and `lang-adopt` was a whole packet
about the fact that one module cannot move alone.

Arm 2's shape needs **no new grammar, no language event, and no change to
ratified posting code**.

But it is also **more faithful to the domain**, which matters more. An operator
does not fill in a command; they build a document and then post it. Draft-then-
post is how inventory work is actually done, it makes entry incremental and
resumable, and it dissolves the charter's hardest problem — *how do you add a
second line with no JavaScript* — by never needing a repeating form widget. The
press already ships one-line-at-a-time child creates.

## Binding conditions on the implementing packet

- **The dispatch adapter registers by exact frozen capability identity** and
  posts nothing itself. It must not be module-specific glue inside a generic
  component; ADR-0011 bans that and the architecture suite gates it. The
  precedent is `5g3-berr`'s provider-error mappings, integrated 2026-07-31: a
  generic registration contract with the module owning its own declaration file.
- **`PostgresInventoryPostingService` stays byte-identical.** Verify it. ADR-0026
  warns that "similarity to this capability is not authorization" and that a
  second posting implementation requires a superseding decision. Hydration is not
  posting.
- **One validation authority per object.** The gateway validates the closed
  argument keys; the capability validates business invariants. ADR-0031 §4 refused
  two authorities over one argument and that refusal stands.
- **Verification probes the real contract by typed refusal**, never by posting a
  business fact — ADR-0031 §5 and ADR-0038.
- **No client JavaScript.** `U3` remains open; nothing here needs it.

## What this does not decide

- **Whether Inventory's ordinary `o0` creates on transaction and stock-count
  entities should be retired.** This ruling **depends on them** as the line-entry
  path. ADR-0038 left the question open; it is now answered in one direction —
  they stay, guarded by ADR-0034 preconditions. Retiring them without a
  replacement would invalidate this verdict.
- **Which further capabilities become O1-reachable.** Posting adjustment first.

## The trigger to revisit — arm 1's real contribution

Arm 1's shape becomes necessary if a ratified command appears whose business
content is **genuinely per-request and cannot be staged as records** — a value
forbidden to persist before commit, for instance.

**Both arms agree none exists today**: every declared command family — transfer,
count correction, receiving, shipping — stages a document. That agreement is what
makes the cheaper shape safe, and it is also exactly what must be rechecked
before the second O1 command family is authored.

Record this as the revisit condition. If it fires, arm 1's `OperationDefinition.input`
at v5 is the designed answer and its analysis should be read rather than redone:
`~/2rain-missions/cmdinput-codex.result.txt`.
