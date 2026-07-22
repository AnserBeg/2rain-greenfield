# Deterministic compiler output protocol v0-experimental (Freeze B)

Status: PROVISIONAL downstream contract
Owner: `@north-star/compiler`
Output protocol: `northstar.compiler-output/v0-experimental`

## Freeze meaning

Freeze B freezes the compiler output protocol, not compiler internals. The
frozen surface is the release/projection/chunk envelope hierarchy, canonical
serialization and domain-separated SHA-256 construction, namespaced and
versioned projection protocol, diagnostic shape and structural order,
compiler attestation, incremental-equivalence obligation, and factual release
diff envelope. G1-P3 and later consumers may rely on those contracts.

The IR, traversal implementation, cache layout, chunk boundaries, physical
partitioning, presentation, risk policy, and projection payload schemas without
real consumers remain open. The current projection payload versions say
`provisional` deliberately. The family list and singleton cardinality are not
protocol constants: a release contains a sorted list of projection instances,
each with a namespaced family ID and logical scope.

Freeze B remains provisional until the checked-in empty bootstrap, minimal
vertical revision, exact optional-field/form revision, identical recompile,
and partial-lowering/no-root fixtures all pass on the pinned runtime.

## Pure compiler boundary and pipeline

`compileApplication` accepts one process-serializable data bundle: normalized
canonical bytes, the exact supported semantic profile, explicit limits,
content-bound dependencies, and an optional verified expected-active release.
It returns only process-serializable data. The compiler package may not read
the clock, environment, locale, random source, filesystem, network, database,
or coordinator state. Timeouts and resource exhaustion are coordinator
failures and never canonical compiler diagnostics.

The v0 pipeline is:

1. decode and schema-check the normalized bytes, re-normalize, and require
   byte equality with Freeze A canonical output;
2. collect globally unique symbols;
3. resolve every typed reference against the complete symbol table;
4. check resolved semantic types;
5. run whole-model capability and trust-gate validation;
6. lower the complete typed model to projection plans;
7. validate the lowered model, including the exact expected-active storage
   transition;
8. canonicalize and hash projection leaves, then emit projection manifests;
9. verify required-family completeness and cross-projection invariants; and
10. canonicalize the release manifest and domain-hash the release root.

Independent diagnostics accumulate within a phase. Unresolved references stop
type checking, and invalid types stop lowering, so cascades are suppressed.
Diagnostics deduplicate and sort by `(subjectId, path, phase, code,
occurrenceIndex)` using code-unit order. `rule` and `acceptedAlternative` are
hand-written explanatory copy outside identity and ordering. A versioned limit
adds one stable truncation diagnostic, then the complete truncated set is
sorted by the same structural tuple. Engine, Zod, stack, timeout, and OOM text
never enters frozen fields.

Any error returns `releaseRoot:null`, `bundle:null`, and `attestation:null`.
Already-emitted chunks may be reported as unreferenced staged artifacts for
collection, but a release-manifest artifact is never staged or returned on a
failing path. No publishable root exists. Success is atomic.

## Merkle release protocol

Hashes use SHA-256 over `UTF8(domainTag) || 0x00 || canonicalBytes`. Domains in
`HASH_DOMAINS` distinguish semantic constructs, projection semantic identity,
projection chunks, projection manifests, release manifests, diffs, profiles,
limits, dependency closures, cache inputs, node outputs, and attestations.

The hierarchy is:

```text
release root
  -> canonical release manifest
       -> ordered projection references
            -> canonical projection manifests
                 -> ordered content-addressed chunks
```

A projection reference and manifest carry:

- namespaced family ID, independent instance ID, and stable logical scope;
- output-protocol, manifest, payload-schema, and chunking-scheme versions;
- required runtime capability and minimum version, never an implementation
  name;
- a logical semantic digest distinct from the artifact/layout root; and
- compatibility facts: additive instances are allowed, unknown required
  families reject, payload changes version, and retirement requires a new
  protocol or explicit optionality.

Projection manifests admit many chunks even though v0 emits one chunk per
projection. Each descriptor carries its own version, stable logical scope,
byte length, media type, and content hash. Re-chunking therefore changes a
versioned artifact root without silently changing semantic identity.

The release manifest is a complete directly resolved snapshot. It carries the
normalized definition digest, compiler/language/normalizer/canonicalization/
policy versions, semantic-profile/limit/dependency/cache identities, sorted
projection references, deterministic capability facts, and the full artifact
closure. Runtime overlay, parent-chain, or patch evaluation is explicitly
forbidden. Shareable artifacts contain no tenant, environment, principal,
coordinator, approval, or activation identity; those belong to later release
records.

V0 emits semantic-model, storage-target, query-catalog, operation-catalog,
surface-manifest, policy-reference, agent-discovery, and verification-plan
instances. A storage-transition instance exists only when compiling a
candidate against one verified expected-active root. It binds exact from/to
normalized digests, release/storage roots, and semantic digests. The current
lowerer admits only adding optional fields while all existing storage fields
and entity storage contracts remain byte-semantically unchanged. It does not
precompute all release pairs.

The expected-active input includes canonical release-manifest, storage
projection-manifest, and storage payload bytes. Every domain hash and every
release-to-projection-to-chunk link is verified before lowering a transition,
including duplicated version, compatibility, scope, capability, semantic, and
artifact facts.

The provisional storage-target payload resolves each entity's selected storage
mapping by its canonical mapping ID, never by an overwritable entity index. It
also carries every compiler-derived state field with its owning machine. Those
derived fields participate in storage completeness and entity-skeleton
transition checks; Freeze B does not silently drop or invent a transition for
them.

## Completeness, capability, and policy facts

Every active admitted supported capability names its declared effects and
required projection families. Compilation fails closed when any required
family is not implemented or emitted. Retired or unsupported capability
records are retained as semantic history but neither advertise support nor
impose runtime-projection completeness. Post-lowering checks verify ordinary
and derived storage-field coverage, the selected storage-mapping descriptor,
surface/query field agreement, required base instances, and absence of tenant
or coordinator identity. The vertical fixture exercises one entity, optional
field, form, query, operation, policy reference, discovery view, and storage
target through this same path.

Releases bind policy references and
`northstar.policy-model/v0-experimental`. Authorization decisions remain a
live, current, deny-capable external dependency as required by the
constitution. Compiler output records factual authorization surfaces; it
never claims the current policy decision.

The agent-discovery projection exposes exactly `erp_discover`, `erp_query`,
`erp_plan`, `erp_execute`, and `erp_verify`. It does not add a raw database,
source, or model tool.

## Incremental seam and equivalence invariant

V0 performs a cold full compile. It nevertheless emits the seams future
incremental work must consume:

- semantic-profile and cache-input identities;
- a stable node ID;
- normalized input digest;
- ordered dependency content digests;
- semantic-profile identity;
- output fingerprint; and
- the explicit `recomputeWhenCacheInputIdentityChanges` invalidation rule.

The frozen invariant is: for the same cache-input identity, any future cached,
memoized, incremental, parallel, or structurally shared mode must produce
bit-identical release roots and artifacts to a cold full compile. The
twice-compile gate must become a cold-versus-cached gate when that mode lands.
Deltas may create a complete candidate snapshot and select work; they never
become runtime semantics.

## Factual release diff and later approval binding

`northstar.release-diff/v0-experimental` carries its algorithm version,
from/to normalized digests and manifest roots, stable subject and construct
identities, add/change/remove kind, before/after semantic fingerprints,
affected projections, versioned factual impact codes, exact transition-plan
digest, and a domain-separated canonical diff digest. `authorization-surface-
added` means a newly added field is actually present on a compiled surface;
it does not claim effective permission expansion. Risk tier, prose, renderer,
and presentation are outside Freeze B.

Diff construction fails closed when a storage change has no transition plan,
or when the candidate transition does not bind the supplied from/to normalized
digests, release base, and storage semantic/artifact roots.

G1-P4 must bind a human approval to tenant/environment context, expected
active base, target root, canonical diff digest, transition digest, compiler
attestation, and approval-policy version. Unknown impact codes fail closed for
that policy version; stale-base CAS fails. The audit record also stores the
renderer/view-schema version and digest of the exact rendered diff evidence.
Those records are obligations on G1-P4, not authorities implemented here.

## Release plane versus data plane

A change is release-plane if and only if it changes definitions projected by
the compiler. Saved views, personal column order, and preference-like state
are data-plane parameters validated against release-pinned schemas. The
platform must neither turn preferences into approval-queue releases nor hide
definition state in mutable data-plane records.

## Coordinator obligations and deferrals

The coordinator, beginning in G1-P3, owns persistence and transactional root
registration. It stores canonical artifact bytes unchanged as PostgreSQL
`bytea`, verifies them before registration, and runs compilation off the
serving event loop in a worker or child process. Compiler telemetry is a
separate attestation and cannot alter canonical output.

The doctrine map tracks these required later owners:

- G1-P4 prepare/verify/activate, approval, CAS, rollback-versus-forward-
  recovery, and rendered-diff evidence;
- a release gate before tenant- or AI-authored definitions become untrusted
  input, using real process isolation and resource limits;
- a G2 storage packet to choose and bound the online-compatible optional-field
  strategy before any seconds-fast usability claim;
- approval fan-out before multi-tenant production;
- cross-tenant CAS authorization/encryption/deduplication domains before
  global artifact reuse;
- authorization audits that retain policy/evaluator version, relevant inputs,
  and result;
- draft preview using this same hermetic compiler core, never a second
  evaluator; and
- measurement-triggered per-subgraph incremental implementation.
