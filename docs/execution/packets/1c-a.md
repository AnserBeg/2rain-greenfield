# Packet 1c-a — rule the platform tier

Status: evidence ready; Critical review pending
Tier: Critical
Lane: DEPLOY
Initial base: `a7042042b77aa52a40d230c750c8ef0abe52f230`

## Outcome

Packet 1c-a selects branch (b): saved filters are a storage-less Tier-B platform capability,
not a Tier-A managed entity. [ADR-0023](../../decisions/ADR-0023-storageless-platform-capability-tier.md)
amends ADR-0011 narrowly while preserving the storage-topology verdict:

- the kernel migration remains exclusive desired-state owner of
  `platform.saved_master_filters`;
- the generic interpreter remains exclusive for managed module tables;
- ordinary Tier-A entities still require dedicated storage and the complete Q0/O0 contract;
  and
- the saved-filter package may declare only get/list plus its four real lifecycle operations,
  with every declared contract executed through real verification before admission.

Nothing is encoded. The current saved-filter refusal remains correct until the follow-on
changes the compiler/definition and produces genuine admission evidence.

## Scope

The final diff contains exactly two new documents:

- `docs/decisions/ADR-0023-storageless-platform-capability-tier.md`; and
- `docs/execution/packets/1c-a.md`.

Every file under `packages/`, `db/`, `apps/` and `test/` is read-only and byte-unchanged.
`docs/execution/ledger.md`, `current-plan.md` and `lanes.md` remain orchestrator-owned; the
completion handoff supplies their acceptance evidence.

The implementation is intentionally blocked by active leases: FIX holds compiler storage and
projections for 1d, and KERNEL holds the platform definition for 4c. The ruling makes the later
encoding mechanical rather than authorizing a lease collision.

## Verified premises

| Premise | Read-only observation at the packet base |
| --- | --- |
| Null storage is canonically representable | `schemas.ts:947-950` makes `storageClass` nullable/optional; the legacy-only rejection is gated at `normalize.ts:743` |
| The refusal is compiler-owned | `conformance.ts:169-177` emits `COMPILER_STORAGE_CLASS_REQUIRED`; `storage.ts:433-436` accepts only `dedicatedTable` |
| Completeness is compelled | `conformance.ts:287-349` requires all four Q0 queries and the O0/surface/assertion families for every active entity |
| Verification exposes the lie | `projections.ts:626-635` emits positive-and-negative resolver evidence; `saved-filter.test.ts:83-98` observes resolver failure, evidence 0, admissions 0 |
| The declaration exceeds implementation | `platform/definition.ts:17-22` declares four queries; the 1,176-line `saved-filter-executor.ts:181-191` serves get/list and returns unsupported otherwise |
| Compiled storage is decorative | migration 0012 creates the real `platform` table; the provider adapter reads/writes it directly |
| Generic storage cannot express owner scope | migration 0012 binds every policy to `owner_principal_id`; compiler storage and the materializer contain zero `principal_id` references |
| Provenance cannot classify the tier | Party, Catalog, Location, Platform and app-builder definitions all declare `firstParty` |
| The product blast radius is closed | the composed authored application contains only Party, Catalog and Location |
| The existing guard sees the contradiction | `test:architecture` reports `PRESS007_MODULE_GLUE_IN_PRESS` for the adapter and `PRESS006_MODULE_ID_IN_PRESS` for its platform identity |

Q1-P1's historical red is incorporated as evidence, not reproduced: before the explicit
refusal, a constant-false policy contribution still returned the saved row and the test failed
with `Missing expected rejection.` The current adapter now fails closed with
`SAVED_FILTER_QUERY_INADMISSIBLE`; row 1e owns making that obligation structurally impossible
to discard.

## Why branch (a) is rejected

Generic saved-filter storage would require a new per-principal row-ownership primitive across
canonical schema, compilation, materialization, RLS and the generic interpreter. Relation
ownership is not row ownership, provenance is not a discriminator, and a platform namespace
branch would violate ADR-0011 directly.

It would also have to compose with row 7's policy kernel: principal ownership must be a
mandatory non-overridable predicate while policy may only narrow. Row 7 is deferred past G3
and current policy returns ALLOW for every principal. Branch (a) is therefore both the larger
language event and the slower route to truthful releasability.

The ruling does not retain both options. A future generic principal-ownership primitive may
serve other demand, but moving saved filters onto it requires a superseding ADR, migration and
removal of the platform adapter.

## Anti-escape-hatch boundary

Storage absence alone grants nothing. The compiler-side classification requires both a
capability that declines the storage projection and null/absent compiled storage. Runtime
releasability additionally requires an exact versioned provider registration and real
plan/result conformance.

The v1 classification is package-wide and rejects a mixture of managed and platform entities.
Tier-B describes the provider capability envelope; the saved-filter get/list and lifecycle
contracts retain their ordinary Q0/O0 shapes.

That boundary preserves the ordinary diagnostic: a Tier-A capability that still requires
storage cannot lose `storageClass`. A package that drops both cannot invent executable code or
evidence. It stays non-releasable without a registered adapter. New Tier-B platform
capabilities require their own ADR, protocol, kernel-plane ownership and verification; no
namespace/provenance allowlist enters the press.

This answers audit B5/G11 directly. The selected path is a narrow typed capability envelope,
not a late general code hatch: no tenant-authored body, no direct route/tool, no managed-table
access, no policy/release/trust bypass, and no advertised support without executed evidence.

The existing adapter may know its own registered protocol IDs; generic compiler/interpreter/
gateway/fallback/materializer code may not. Row 1e must replace the current two recorded press-
law violations with a structural capability-adapter classification, not a saved-filter ID or
path allowlist. Failure to express that distinction is a stop condition for 1c-b.

## Downstream disposition

- **Current-plan row 1 (`savedViews`)** proceeds after the encoding packet makes get/list and
  lifecycle operations releasable.
- **Row 1e** retains the executor-contract work that makes accepting or explicitly refusing
  every gateway obligation structural rather than voluntary, and must replace the two current
  press-law findings with structural adapter classification before a second Tier-B capability.
- **Row 7** later contributes real permission/policy denial and narrowing. It cannot weaken
  migration 0012's tenant/environment/principal RLS.

Saved filters become release-admissible only after the follow-on removes decorative storage,
removes resolve/search declarations, generates the truthful verification plan and persists a
complete genuine result set. They remain internal-team-only until row 7, matching the current
composed application's authorization restriction.

## Gates and artifact check

This packet changes no executable or generated input. The final full CI matrix is run at the
frozen candidate after both documents are committed and after confirming no other lane matrix
is active. The immutable completion handoff records the exact counts and SHA; editing this file
after that run would invalidate the evidence.

The first frozen draft at `a869bfbd1c9a8879e899f8ce12e5d64041f301f1` was deliberately
superseded before review. Its matrix was manually stopped after the architecture gate's two
saved-filter press-law diagnostics exposed an ambiguous enforcement paragraph; every gate
through schema drift was green, and PostgreSQL had passed 1/92 when stopped. The replacement
candidate explicitly rules capability-local identity versus generic module branching and
routes the structural guard to row 1e. The stopped run is not final gate evidence.

Artifact stillness is checked rather than inferred:

```bash
git diff --name-only a7042042b77aa52a40d230c750c8ef0abe52f230...HEAD
corepack pnpm check:demo-release
corepack pnpm check:app-release
git diff --exit-code -- apps/web/release test/fixtures
```

Expected: only the ADR and packet record are listed, both freshness checks pass, and no
generated artifact differs.

## Review evidence

Pending on the frozen candidate: one fresh naive Codex `gpt-5.6-sol` xhigh consistency review
to PASS, followed by Fable max confirmation on the identical unchanged SHA. The bounded charter
checks the binary choice, consistency with ADR-0011 and its debate verdict, the anti-escape
boundary, verification/releasability, and the three named downstream consumers. Code design or
implementation findings are out of scope unless they show the ADR cannot be encoded without a
new unresolved decision.

## Test it yourself

This is a ruling packet with no runtime surface. Read ADR-0023 and verify four decisive points:

1. branch (b) is selected and branch (a) is rejected rather than retained;
2. Tier-A dedicated storage and generic interpretation remain binding;
3. saved filters declare get/list only and stay non-releasable until real verification passes;
   and
4. storage absence cannot create an executor or bypass admission.

Then confirm the documents-only boundary:

```bash
cd /home/rvham/2rain-greenfield-1c-a
git diff --name-only a7042042b77aa52a40d230c750c8ef0abe52f230...HEAD
git diff --exit-code -- packages db apps test
```

Expected: exactly the ADR and packet record are listed by the first command; the second prints
nothing and exits zero.

## Program-review trigger evaluation

No new whole-app review is due at this document checkpoint. The current G2 composition review
and its ADR-vs-code finding directly caused row 1c. This packet resolves the design contradiction
but encodes no running capability, so the program-review skill's fresh-contract anti-trigger
applies. Re-evaluate after the follow-on is integrated or at the next stage/capability-tier gate.

## Proposed next packets

1. **1c-b — encode ADR-0023** (recommended once 1d and 4c release their paths): remove the
   decorative storage class/projection, narrow queries, derive Tier-B conformance and genuine
   verification, and make saved filters release-admissible.
2. **1e — consolidate the press guards/executor obligation contract:** make silent gateway-
   obligation drops structurally impossible and distinguish a typed platform-capability
   adapter from generic module glue without an ID/path allowlist.
3. **G2-P5d-b savedViews slice:** consume the admitted get/list capability after 1c-b rather
   than building against the currently refused package.
