# ANALYZE-1a · Python fixture runner

N5-02 consumes the chess design at `668a60bb3912a2df0b66f098b4c47ff8fe1396a6`. Read the prior sources at that commit. The old test suite was not executed and provides no isolation measurements for the new host.

| Source | Disposition | Admission condition |
| --- | --- | --- |
| server/data-analysis/python-runner.ts | Keep per-run container identity, dropped privileges, bounded output and named termination. Rewrite preflight, deadlines, I/O and cleanup. | Observe rootless cgroups, no network, a closed output stream and complete teardown. |
| docker/data-analysis-runner/ | Keep the non-root scientific Python image and Agg. Replace the mutable tag and dependency install. | Admit linux/amd64 image content by digest with a hashed wheel lock. |
| server/data-analysis/persistence.ts | Keep run identity and artifact provenance. Rewrite reservation and receipt storage for scoped, retryable operations. | A refused launch is free and a host failure refunds once. |

1. Every job gets fresh isolated scratch. The host controls its identity and its lifetime.
2. The collector counts bytes before interpretation and exposes only a complete validated result.
3. A retry cannot spend another start.

Exclude host workspace mounts, guest-named artifacts, SVG, environment-selected executables, raw database access and mutable session ACLs. Before integration, dropping this packet branch removes the fixture and its dedicated job.
