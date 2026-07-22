# G1-P3 release-persistence salvage record

Packet: G1-P3
Mode: RE-EXPRESS + REFERENCE only; no PORT

## Source and target

Source repository: `/home/rvham/2rain_erp`, branch `chess`, commit
`668a60bb3912a2df0b66f098b4c47ff8fe1396a6`.

- RE-EXPRESS: `tests/mt-s1-org-safe-dispatch.test.ts`
- REFERENCE: `mts1-dispatch-report.md`
- Target: G1-P3 immutable `AppPackageRevision`/`TenantRelease` persistence and
  its two-tenant collision/isolation matrix.

The accepted local G0-P4a migration/schema-snapshot machinery and G0-P4b
trusted-context transaction, unprivileged role, RLS, and one-connection pool
reuse machinery are the implementation base. No prior runtime implementation
is used.

## Verified source evidence and limits

The source report records the focused two-organization dispatch suite as 3/3
passing and maps request-bound organization views, fail-closed mixed-identity
dispatch, scoped persistence reads, and absence of an identity-less metadata
fallback. It also states that the underlying provider remained globally keyed,
multi-tenant serving remained disabled, and provider selection/storage/cache
re-keying was deferred. Those limitations mean the source is useful only as a
behavioral warning and test checklist, not release-persistence authority.

## Disposition

| Source behavior or design | Disposition | G1-P3 expression |
|---|---|---|
| Two independently scoped views expose only their own synthesized definitions | REWRITE | Two trusted tenant/environment contexts can read only their own immutable revision, release, and link rows under forced RLS. |
| Mixed organization identity/view pairs fail before dispatch | REWRITE | Command tenant/environment/creator must match authenticated trusted context before persistence, and database RLS rejects cross-scope writes. |
| Each organization persists and reads only its own rows | REWRITE | A one-connection runtime-role test alternates tenants, proves scoped round trips, missing-context fail-closed reads, and cleared transaction-local settings. |
| Identity-less metadata fallback is forbidden | REWRITE | The repository requires a G0-P4b-issued context for every method; no default tenant/environment or unscoped blob read exists. |
| Source error messages avoid cross-organization catalog identifiers | REFERENCE | G1-P3 exposes no cross-tenant blob lookup/hash-oracle API and returns no foreign tenant release rows. |
| Static action registry, generated physical action facade, and `@agent-native/core` | REJECT | They are forbidden prior-repository authorities and unrelated to immutable release persistence. |
| Static metadata plus runtime customization overlay/child lineage | REJECT | Freeze A desired-state bytes and Freeze B complete release snapshots are the only stored definition path. |
| Globally keyed provider selection and active manifest state | REJECT | Release records are tenant/environment-qualified; activation and the sole active pointer belong to G1-P4. |
| Prior database/runtime files | REJECT | No code or schema is copied; G0-P4a/P4b are the accepted local base. |

## Invariants retained

1. Trusted scope is explicit at the boundary and cannot be substituted by the
   caller.
2. Cross-scope reads and writes fail closed, including after pooled connection
   reuse.
3. No identity-less fallback chooses application definition state.
4. Persisted rows retain their tenant scope and do not become a global active
   authority.

G1-P3 strengthens the source behavior with minted identity versus content-hash
separation, exact canonical `bytea` fidelity, verified Merkle closure, immutable
database guards, policy-free blob deduplication, and a direct hash-oracle denial.

## Defects that must not carry

- deployment-global package or active-manifest identity;
- a static-metadata plus overlay dual lineage;
- per-action physical registries or facades as application authority;
- globally keyed provider caches/state;
- multi-tenant claims based only on injected fake views; and
- any dependency on the prior repository at build or runtime.

## G1-P3 evidence and rollback

The rewritten behavior is gated by `test/postgres/releases.test.ts`,
`test/architecture/release-persistence-boundary.test.ts`, schema drift,
dependency boundaries, and the complete packet gate table. Removal before
integration is confined to migration `0003`, the generated schema snapshot,
`@north-star/platform-runtime`, the PostgreSQL repository, the two tests, and
this record; Freeze A/B and the accepted G0 provider machinery remain intact.
