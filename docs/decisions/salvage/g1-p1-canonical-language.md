# G1-P1 salvage record — canonical language design references

Mode: REFERENCE only
Packet: G1-P1
Quarry: `/home/rvham/2rain_erp`, branch `chess`, SHA
`668a60bb3912a2df0b66f098b4c47ff8fe1396a6`

No prior source or test file is copied or imported. The greenfield schemas,
normalizer, strict JSON parser, canonicalizer, fixtures, and tests are new.

## Sources consulted

- v1 corpus `docs/canonical-erp-platform-replatform-plan.md` §7.2 for family
  coverage and scalar/relation/state semantics.
- `docs/module-authoring-ir-design.md` for stable logical identity, one full
  desired-state snapshot, strict unions, reference locality, typed behavior,
  serialization hazards, and compiler-completeness questions.
- `shared/runtime-customization/{dsl.ts,expressions.ts,effects.ts,assertions.ts,upgraders.ts}`
  and `shared/runtime-customization/primitives/` for the proven primitive,
  assertion, lifecycle, and verification vocabulary checklist.
- `docs/module-authoring-slo-lock.md` for the explicitly deferred scale and
  per-subgraph/incremental-compile budget questions.

## KEEP / RE-EXPRESS / REJECT

| Disposition | Referenced lesson | Greenfield result |
|---|---|---|
| KEEP | Stable IDs separate from labels; strict discriminated unions; complete desired-state snapshots; typed effects/assertions; fail-closed references | Re-expressed as namespaced runtime-validated IDs, closed v0 schemas, one normalized snapshot, typed predicate/effect/invocation nodes, and negative fixtures |
| KEEP | Exact decimals/large integers cannot use unrestricted JSON numbers; canonical bytes need explicit Unicode, ordering, duplicate-key, and hash policy | Re-expressed in the versioned normalizer/canonicalizer with golden byte/hash vectors |
| KEEP | Parent+row child scope and named state transitions are structural contracts | Minimal relation/state schemas carry only parent-scoped ownership and named transitions consumed by G2/G3 |
| RE-EXPRESS | Primitive capability and verification registries | One versioned capability requirement with explicit support status and mandatory projection set; one typed assertion family |
| RE-EXPRESS | Sparse input normalization and upgraders | Sparse authored transport normalizes through an explicit pure function; Zod schemas never supply defaults/transforms/coercion |
| REJECT | Deployment-global package identity and activation assumptions | Every canonical ID is package-namespaced; ADR-0001 tenant release authority remains exclusive |
| REJECT | Static-manifest plus primitive-overlay lineage | No overlay or second desired-state representation exists |
| REJECT | Documented-name aliases and validator-owned default injection | T1 admits no aliases; v0 defaults are explicit versioned normalizer constants |
| REJECT | Array-position presentation authority | Every ordered node has an explicit `orderKey`; set-like collections sort canonically |
| REJECT | Physical routes, action files, provider/storage names, handlers, SQL, or UI implementation in the IR | Strict schemas have no such properties; hidden-hook negative fixtures fail |

## Invariants retained

1. Unknown kinds, versions, keys, references, surface tokens, or capabilities
   fail closed.
2. Labels and routes never define identity or authority.
3. One complete normalized snapshot is the desired-state content; patches are
   transport only.
4. Behavior is typed algebra or a registered versioned capability with
   declared effects.
5. Parent-scoped children require explicit structural ownership; lifecycle
   changes use named transitions.
6. Canonical bytes and diagnostics are deterministic and version-bound.

## Known defects not carried

- deployment-global activation and package ownership;
- dual static/overlay metadata authority;
- alias normalization (`surface.column.place` versus `table.column.place`);
- `.trim()`, validator defaults, transforms, or coercion silently changing
  desired-state bytes;
- unrestricted JSON numbers for exact business values;
- position-owned array semantics; and
- the quarry's partially promoted/reserved field variants being presented as
  supported.

## Evidence and rollback

Required evidence is the G1-P1 schema/normalization/negative suite,
architecture purity test, boundary checker, pinned-runtime subprocess check,
golden vectors, and the packet's Critical review chain. Before integration,
rollback is deletion of the G1-P1-owned files and restoration of its three
manifest/lock changes; the accepted pre-step `.gitattributes` commit remains
part of this packet and rolls back with the branch.
