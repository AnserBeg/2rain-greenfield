# CUSTOMIZE — a non-developer adds a record type, field, choice or layout, reads a plain diff, approves, activates, rolls back

Status: slice 1 (draft and diff) integrating; slices 2-4 built on `packet/CUSTOMIZE-s2..s4`, slice 5 owed. Charter: [CUSTOMIZE-charter](CUSTOMIZE-charter.md).
Tier: Critical-touching — `db/migrations/0029_customization_patch_lineage.sql` (RLS/grant SQL). Merges are logged `merged — unread`. Stops taken: none.
Base: `main` `a7a4cba1`.

## Claims

1. A change is one of four typed patches (`addRecordType`, `addField`, `addChoice`, `arrangeLayout`), Zod-validated (`packages/customization/src/patch.ts`); any other kind is `unsupported`, naming it; nothing is recorded for a refused, unsupported, invalid or compiler-rejected change.
2. `platform.customization_patches` (0029) is append-only (update/delete rules refuse), RLS-scoped to the trusted tenant and environment, insert bound to the authoring principal, and the database checks `payload_digest = sha256(payload)`. It binds payload, channel (§5.6's five), actor, base package id/version/revision/release root, parent and resulting revision and release, language and normalization profile versions and trusted time. No release manifest, projection or pointer reads it (ADR-0013 §2).
3. The child revision is `normalize(apply(first-party authored, ordered patch chain))`, `provenance = tenantAuthored`, parent = the active revision. Every draft re-applies the recorded chain and refuses unless each link reproduces its recorded release root (ADR-0013's determinism gate); a base the checked-in authored file no longer normalizes to is refused.
4. The untrusted-definition release gate (doctrine-coverage, Freeze B): the compiler still refuses non-first-party input unless a typed `untrustedDefinitionSandbox` attestation within fixed caps (2 GiB heap, 120 s) is supplied; only `sandbox-worker.ts` declares it, observing its own IPC parent, explicit heap flag and wall clock; the runner kills it at its wall clock. First-party compiles are unchanged (`check:app-release`, `check:demo-release` unmoved).
5. §10.6 boundary (v1): `addField` and `arrangeLayout` target tenant entities or the masters/headers item, location, party, purchase order and sales order (the published posting set names only single fields of them); everything else is refused `CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET`. `addChoice` widens only tenant-authored choice fields (`CUSTOMIZE_CHOICE_PLATFORM_OWNED`); a first-party field added by a patch is optional.
6. `customize draft` prints the plain-language diff rendered from `diffCompiledReleases` and both normalized definitions, never from the patch; drafting moves no pointer.

## Decisions (one line each)

- New permissions are bound at compile by evaluator bindings synthesized for the tenant permissions; the acknowledgement file is never written.
- The tenant module id is `northstar.app:module.custom_<label>`; every tenant id's local part starts `custom_`.
- Patches apply to the AUTHORED form: normalized bytes do not re-normalize (measured), so the authored first-party base is the only honest base.
- The CLI is `corepack pnpm customize` (`apps/api/scripts/customize-cli.ts`), channel `declarativeEditor`; it acts as the local-demo identities (maker: the local human; approver: the local approver), like boot.
- Re-drafting the same patch on the same parent returns the existing record (unique on parent and payload digest).
- A tenant revision is reused only under the same parent (`ensurePersistedRelease`), because the rollback policy reads that edge.

## Slices

1. Draft and diff — `customize draft <patch.json>`; [Test it yourself](#test-it-yourself).

## Gates

- Local: format, typecheck, lint, `check:boundaries`, `check:app-release`, `check:demo-release`; unit `customization` 7/7 (two reds: in-process tenant compile refused; worker without heap flag refused); architecture `customization-sandbox-boundary` 1/1. The PostgreSQL test runs in CI only (local container runs are reserved for reproducing a CI red).

## Test it yourself

With `corepack pnpm dev` running (or started once on this database):

```
corepack pnpm customize draft apps/api/scripts/examples/equipment.json
corepack pnpm customize status
```

Expected: "New record type "Equipment" with 4 fields" with Name, Serial number, Purchase date and Status (one of "In service", "Under repair", "Retired"), "Stored data: a new table, a new index", and "Nothing is live yet"; `status` lists one `addRecordType` change. The running app does not show Equipment. Running `draft` again prints "(already drafted; nothing new recorded)".

## Filed

- Re-applying tenant patches to a moved first-party base (ADR-0013 upgrade) fails loudly with the pre-tenant remedy `dev:reset`; the rebase itself is not built.
- The full §8.5 builder archetype (charter: filed, not built).
