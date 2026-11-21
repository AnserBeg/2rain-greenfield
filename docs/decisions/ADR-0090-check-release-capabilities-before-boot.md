# ADR-0090. Check release capabilities before boot parses stored definitions

**2026-11-20 · Proposed for Fable review · Critical design**

## Context

DOCS-1 and Board found that an older process can refuse a newer release on the request path and still crash on restart. Startup builds policy in `releasePolicyBindings` (`packages/postgres-provider/src/serving-gateways.ts`), which strictly parses the stored normalized definition. A newer Board, layout or optional read-model flag can trigger `CANON_SCHEMA_INVALID` before the process listens.

## Decision

Split boot into release selection and definition loading. Resolve the boot-selected set from scoped pointers and release metadata. Include the verified serving generation and any install, replay, rollback or recovery releases that boot will open. Check the whole set before the first stored-definition parse, including parsers reached during selection and local authorization setup. Bind the check to the selected release IDs, roots and pointer fences under the release-scope lock. A changed selection requires a new check before loading, including when startup selects a verified fallback.

Read requirements from versioned, integrity-checked release metadata that older readers can inspect with definitions and projection payloads still opaque. Use the compiler and verifier's release-bound requirements, including features declared only in the definition and optional projection families. Compare every reader floor and every projection family, capability ID and required version against the exact build's supported capabilities. A scalar reader rung includes all lower rungs. Missing or inconsistent metadata blocks boot with an integrity or reconciliation error. Legacy releases with understated requirements need the verified evidence or successor specified in ADR-0085.

An unsupported requirement terminates startup with `UNSUPPORTED_RUNTIME_CAPABILITY`. The diagnostic names the affected release, the reader or capability and its required and supported versions. An unknown family or capability is named as unsupported. Propagate this refusal unchanged through boot recovery before any stored-definition parse, listener bind or worker claim.

This is the release check within ADR-0085 A14 binary admission. The admission transaction binds the result to the scoped process and build before it can establish trusted request context or claim work. Apply the deploy rule as well. No rollback below the newest patch parser or surface-reader rung already used by any tenant, even if the boot-selected releases fit the older binary. The fleet high-water register, rollback window and request-time checks continue to apply. [ADR-0085, Binary admission and rollback window](ADR-0085-platform-upgrades-for-customized-tenants.md#binary-admission-and-rollback-window)

An immutable build that predates the startup check cannot produce the new diagnostic itself. For those archives, the production deploy admission entry point checks the archived build's verified capability manifest against the same boot selection and emits the refusal before launching the process. Run compatible pre-handshake controls against isolated pre-tenant stores with the selection pinned. At the first-tenant switch, enforce ADR-0085's handshake-capable minimum in the store.

## Evidence required before the first tenant

- Start the archived preceding serving binaries through production boot admission against persisted, verified releases containing Board, a layout revision and an optional read-model flag, one case per feature. Pin the real archived build and its manifest. Each attempt must refuse by name and show that the definition parser, listener and worker claim were never entered. Cover restart on the active generation and a checked fallback, including an incompatible release later in a boot selection. Use the in-process startup entry point for handshake-capable archives and the production deploy entry point for pre-handshake archives.
- Start each preceding binary on its compatible release through its archived production loader and get an expected result from a real query. Start a capable build on each newer release and also answer a query. Compare the persisted release and definition rows byte for byte across refused starts.
- After committing the implementation and tests, remove only the boot capability check and demonstrate a red for each feature. Exercise the in-process and deploy admission entry points independently. The first-tenant ruling requires these green startup proofs and the A14 enforcement gate. [ADR-0066](ADR-0066-pre-tenant-development-re-baselines-the-release-lineage.md)

## Try it yourself

Run `scripts/check-records.sh` from the repository root and expect exit zero. Read the three archived-binary cases above for the runtime evidence required before the first tenant.
