# 5g3-activation-cost — cache validated pinned storage targets

Status: accepted candidate; integration matrix pending

Tier: Behavioral

Base: `2ac0b5b`

Reviewed candidate: `7347bfa02e96cff7ddf170a9d8d15cb2543e625b`

## Outcome

The PostgreSQL module runtime caches a fully validated pinned storage target by
the exact tuple `{tenantId, environmentId, releaseId, contentHash}`. A cache
entry becomes visible only after the tenant-visible artifact read, artifact hash
verification, canonical decode, and schema validation have all succeeded.
Concurrent first loads share the same pending validation, while a rejected load
is removed and cannot populate the validated cache.

The cache changes neither the immutable lineage nor the verification scenarios.
It removes repeated validation of the same immutable pinned bytes within one
interpreter. The quiet profile moved from 4,739 verification artifact reloads
and 249.6 seconds to 17 reloads and 96.4 seconds, with a second after-cache
sample at 80.3 seconds. The separate cost that still scales with append-only
lineage is recorded outside this packet.

## Controls

- Separate tenant, environment, release-ID, and content-hash arms each prove
  that changing only that key dimension misses independently.
- A corrupt first read is refused, does not populate, and is followed by a real
  second read that succeeds before a subsequent hit.
- An ordered observation records tenant-visible read, hash verification,
  canonical decode, schema validation, and only then cache population.
- Concurrent first callers coalesce onto one physical read, and neither caller
  can settle before the shared validation completes.
- The unchanged composed activation parent records the reload-count and elapsed
  time movement without raising its timeout, reducing tenants or releases, or
  returning executable scenarios to derivations.

## Known limitations from review

- The statement that every execution receives a fresh interpreter is true for
  release verification, but not for the composed-application runtime, which
  reuses one interpreter. This is harmless at the reviewed SHA because that
  process is single-tenant and cache correctness comes from the complete key,
  not interpreter lifetime; the broader fresh-interpreter premise must not be
  relied on.
- The validated payload stored in the cache is not deep-frozen. No mutator
  exists at the reviewed SHA, so this is cheap defensive hardening rather than
  a present correctness defect.

## Review

Codex xhigh passed all seven controls on the reviewed candidate. Fable max
confirmed the cache and supplied the two known-limitations refinements above.

