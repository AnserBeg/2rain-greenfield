# ADR-0026: Inventory posting as a declared capability

Date: 2026-07-29
Status: **ratified** 2026-08-21 — G3-P3 is accepted (ledger; reviewed and integrated
`3e813e347e057bcc9b0ceafa03c57713fde52fe1`), completing the condition this ADR set for
itself. (Status corrected by the orchestrator's 2026-08-21 record sweep, disposing program
review R1, which found the condition met and the text stale.)
Tier: Critical (review per `review-tiers`)

## Context

Inventory movements are append-only facts. The compiled Inventory definition
therefore gives `inventory_movement` no create, update, archive, or restore
operation. Compiler conformance requires an append-only fact entity to declare
zero operation effects, and its managed table grants only create-time insertion
plus read. This is intentional: an ordinary O0 handler cannot enforce a
whole-command stock decision, acquire all affected stock identities before
reading balance, or atomically couple the immutable fact to its natural effect
identity and trust evidence.

G3-P1a froze `northstar.inventory:capability.posting` version 1 and its initial
30-entry dependency set. G3-P2b-1 created its partitioned append-only storage,
and G3-P2b-2 froze the per-stock-identity serializer. Those artifacts declare
what posting must do, but none authorizes a provider implementation.

ADR-0023 permits platform-maintained capability execution only through an
accepted ADR and currently admits saved filters alone. ADR-0025 deliberately
admits the calendar and posting configuration but explicitly does not authorize
a posting path. Implementing the frozen posting ID without another decision
would therefore turn a pinned contract into an undeclared executor exception.

## Decision

`northstar.inventory:capability.posting` version 1 is admitted as the sole
writer of an Inventory movement. Its first implementation supports adjustment
posting only. Transfer and stock-count correction remain G3-P4.

This capability is not an alternate implementation for a Tier-A operation.
There is no generic movement-writing operation to bypass: the press makes one
structurally unrepresentable. Generic Q0 remains the movement read path, and the
generic O0 interpreter remains the only executor for the ordinary Inventory
entities and their draft lifecycle. Posting consumes an existing adjustment
draft, transitions its state, and appends the fact through this distinct,
declared command protocol.

The capability implementation is a versioned provider adapter. Registration
must match all of:

- capability ID `northstar.inventory:capability.posting`;
- capability version `1`;
- dependency-set version `3` and root
  `35fc38eaca7fbe47d8da5030ceefce8211a2194a25d233c45282ef0450d553ad`;
- an active tenant release with the same immutable content hash; and
- the compiler-emitted `northstar.storage-target-payload/v3` managed-storage
  contract.

Neither package provenance nor namespace dispatch selects it. The
capability-local adapter exact-matches the compiled-in frozen ID, version, and
dependency root; it does not accept an arbitrary `:capability.posting` suffix.
It also verifies that the supplied storage payload bytes and digest name an
actual projection chunk of the active release. The compiler,
generic interpreter, materializer, gateways, and fallback routing gain no
Inventory branch.

No current active-release artifact declares this posting capability. Therefore
this decision does not claim release-persisted capability admission. Creating a
separate admission table before the release has a declaration would create a
second desired-state authority with no release source, repeating the
dual-lineage defect. Inventory mounting in G3-P6a plus the routed projection
follow-on must make the declaration part of release output; only then may
runtime admission be evidenced against it. Until that lands, exact compiled
contract identity/root plus exact active storage artifact is the intentionally
recorded achievable boundary.

The dependency set evolves before first posting from v1/30 entries/root
`7ef50e86732818a0ec4ec2a03a001066ac59408ea260c65bf018646e4377a63d`
to v2/31 entries/root
`2eb1de635331ee5781fe928a37d3664e3d4f8ccfe56ca44e231a652a806eca05`.
The added `read:northstar.inventory:transaction_line` authority binds the
command to the complete persisted draft line set. Natural replay also reads the
outbox row that owns the effect-deduplication key, so the set then evolves to
v3/32 entries/root
`35fc38eaca7fbe47d8da5030ceefce8211a2194a25d233c45282ef0450d553ad`
by adding `read:northstar.trust:outbox_event`. Each change is a protocol version
event before the first fact, not a rewrite of posted history.

The capability also owns its atomic trust write as one closed aggregate. The
existing generic trust service begins its transaction and performs runtime-role,
context, release, and idempotency reads before invoking a mutation callback.
That callback position cannot satisfy the stock serializer's stronger rule that
lock acquisition immediately follow `BEGIN`, and wrapping posting in a second
transaction would destroy atomicity. This ADR therefore permits private,
capability-local writers for the already-ratified invocation, change, event,
outbox, and receipt rows. They use the shared versions and tables, expose no
standalone evidence API, and commit only with the movement; the shared trust
facts remain the sole cross-cutting authorities.

## Transaction contract

The adapter owns one top-level PostgreSQL transaction. Its order is binding:

1. `BEGIN`;
2. acquire every affected v1 stock identity with G3-P2b-2's serializer,
   immediately and before any caller savepoint;
3. acquire the scoped request-key lock in the same NSST advisory namespace,
   before the first semantic-receipt read;
4. row-lock the transaction header, every referenced base-unit row, and the
   period-lock row; capture a digest of the complete active draft line set under
   the header lock;
5. validate the draft and read serialized movement state, then evaluate
   `negativeStock` inside that transaction; load and enforce the release-recorded
   reason, approval, and backdate dials and the locked period close;
6. append each movement; its compiled `AFTER INSERT` trigger claims the natural
   effect identity atomically;
7. transition the existing adjustment draft to posted only if its line-set
   digest still matches, write invocation,
   business-change, domain-event, outbox, and immutable receipt evidence; and
8. commit all of it or roll back all of it.

No caller preflight may substitute for steps 2 through 5. In particular, a
balance read before stock-lock acquisition has no authority. The adapter may
create a savepoint only after the stock locks exist; rolling back to it cannot
release those earlier locks.

`recordedAt` comes from a required platform-owned time authority, is sampled
once after stock serialization begins, and is not an operation input. The same
instant is written to every movement and all linked trust evidence. Posting
changes only the existing draft's state and revision; it does not overwrite the
draft header's creation timestamp or business input. `effectiveAt` remains
author input. The global same-instant ordering is ascending canonical value
order over the frozen tuple; it is not a tenant dial.

## Idempotency and evidence

The database-enforced natural effect key remains
`(source_type, source_id, source_line, revision, posting_role)` under
tenant/environment/legal-entity scope. Exact retries return the original
movement and trust links; a reused request key or natural effect with different
business input fails typed. A race at the effect key rolls back to a savepoint
created after stock locking and resolves only an exact existing effect as a
replay. It never adds a second movement.

Movement, read-back, business-change evidence, domain-event payload, and outbox
carry quantity and lineage only. No monetary amount, cost, price, currency, or
valuation member is admitted. Receipt cost remains G4-owned and valuation
remains unsupported under ADR-0017.

## Boundaries

This ADR does not:

- add movement O0 effects or a module-specific generic-press branch;
- authorize an HTTP route, top-level agent tool, UI binding, import path, or
  reservation writer;
- authorize transfer, count correction, purchasing, valuation, or a mutable
  balance;
- change generic transaction-line create lifecycle: the digest closes a line
  inserted during posting, while a parent-draft guard on generic child creation
  remains separately routed press work;
- add any posting dependency beyond the ratified v3 32-entry set; or
- replace the policy kernel. The current adapter requires an upstream ALLOW
  decision and persists it; real policy narrowing remains owned by row 7.

A second posting implementation, another dependency-set change, new command
family, or new platform table requires a superseding decision. Similarity to
this capability is not authorization.

## Consequences and verification

The first immutable business fact can be written without weakening ADR-0023's
single-press rule: ordinary entities remain generic, while the fact writer is a
closed capability the ordinary press deliberately cannot represent.

G3-P3 must prove on real compiled storage that the stock lock precedes all
business reads; request-key conflicts, base-unit changes, period close, and a
phantom child insert each lose a real concurrent race with a typed abort and no
loser evidence; negative stock, reason, approval, and backdate decisions occur
transactionally; a duplicate natural effect does not double post; base-unit
mutation after posting names the binding movement; trusted recorded time has no
update path; and movement, read-back, audit, event, and outbox evidence contain
no monetary amount. The full matrix and Critical review chain run on the
identical integrated SHA.
