# CUSTOMIZE — a non-developer adds a record type, field, choice or layout, reads a plain diff, approves, activates, rolls back

Status: slices 1, 2 and 4 integrated (merges `41697099`, `9bbc6adf`, `273c7129`; main CI green); slice 5 (rehearsal) integrating; slice 3 (the Customize screen) STOPPED for a ruling (below).
Tier: Critical-touching — `db/migrations/0029_customization_patch_lineage.sql` (RLS/grant SQL). Merges are logged `merged — unread`.
Base: `main` `a7a4cba1`. Stops: slice 3 (ux-grammar seam).

## Claims

1. A change is one of four typed patches (`addRecordType`, `addField`, `addChoice`, `arrangeLayout`), Zod-validated (`packages/customization/src/patch.ts`); any other kind is `unsupported`, naming it; nothing is recorded for a refused, unsupported, invalid or compiler-rejected change.
2. `platform.customization_patches` (0029) is append-only (update/delete rules refuse), RLS-scoped to the trusted tenant and environment, insert bound to the authoring principal, and the database checks `payload_digest = sha256(payload)`. It binds payload, channel (§5.6's five), actor, base package id/version/revision/release root, parent and resulting revision and release, language and normalization profile versions and trusted time. No release manifest, projection or pointer reads it (ADR-0013 §2).
3. The child revision is `normalize(apply(first-party authored, ordered patch chain))`, `provenance = tenantAuthored`, parent = the active revision. Every draft, approval and rollback re-applies the recorded chain and refuses unless each link reproduces its recorded release root (ADR-0013's determinism gate).
4. Untrusted-definition release gate (doctrine-coverage, Freeze B): the compiler refuses non-first-party input unless a typed `untrustedDefinitionSandbox` attestation within fixed caps (2 GiB heap, 120 s) is supplied; only `sandbox-worker.ts` declares it, from its own IPC parent, heap flag and wall clock; the runner kills it at its wall clock. First-party output is unchanged (`check:app-release`, `check:demo-release`).
5. §10.6 (v1): `addField`/`arrangeLayout` target tenant entities or item, location, party, purchase order, sales order (the posting set names only single fields of them); else `CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET`. `addChoice` widens only tenant-authored choice fields (`CUSTOMIZE_CHOICE_PLATFORM_OWNED`).
6. Every release-diff preparation (boot and customize) binds `diffCompiledReleases`' canonical digest and the digest of the plain-language text the approver is shown, replacing the placeholders; a module preparation is refused unless the diff's transition plan digest equals the materializer's. A rollback binds the forward diff it undoes, read backwards.
7. Activation runs the existing CAS/fence/verification kernel unchanged; the running runtime builds policy bindings and capability executors per release (`composed-application-runtime.ts`, `ReleaseRouting*Gateway`) and serves the next request from the release its view names — no restart.
8. Rollback goes through `authorizeReverseTransitionIfApplicable` (createTable included); storage is additive, rows are kept and return on re-activation. Boot serves a pointer naming a tenant descendant of the lineage tip and fails loudly (pre-tenant remedy `dev:reset`) when the first-party base moved.
9. AI drafting: the model answers only through one tool whose input is read by the same Zod schema; text is never a change; a malformed patch gets one repair turn; anything else is `unsupported`, naming it.

## Decisions (one line each)

- Permissions: evaluator bindings for tenant permissions are synthesized at compile; the acknowledgement file is never written. Grants go to the local demo's two full-release roles at activation, exactly as boot grants first-party ones.
- Tenant ids: module `northstar.app:module.custom_<label>`; every tenant id's local part starts `custom_`.
- Patches apply to the AUTHORED form: normalized bytes do not re-normalize (measured).
- CLI `corepack pnpm customize draft|ask|approve|activate|rollback|status`; identities are the local demo's (maker: local human; approver: local approver), like boot. Re-activation after a rollback needs a fresh approval.
- A re-draft of the same patch on the same parent returns the existing record; a tenant revision is reused only under the same parent.
- The materializer preparation expires in 23 h, inside the approval's 24 h default.
- AI drafting reuses `@north-star/operations-agent`'s adapter and key loading, `claude-opus-5-5` at medium effort, wrapped in the composition (its tool-name type is narrowed to the agent's five). Local real-model check 2026-11-17, three requests: Equipment → `addRecordType` (2.4 s), "customers need a tax exempt number" → `addField` on Party (1.5 s), two-approval workflow → `unsupported` "Approval workflow" (1.1 s).
- The denial-recorder expected-red control is re-pointed at the per-release gateway wiring (`auth.expected-red.json`).
- Approval prepares the inert storage plan (a new table) before verifying the candidate, the order boot uses; capability read-backs go through the runtime's one routed read ingress.
- Activation, rollback and a boot serving a tenant release re-run `platform.provision_inventory_scope` with each scope's stored policy and the active root: the posting kernel posts only for the release a scope names. Between the swap and that call a posting refuses loudly (`INVENTORY_POSTING_RELEASE_MISMATCH`).
- Review fix (Sol read at `4d2b5672`, merge `6d06f76c`): swap, pointer re-read and scope reconcile hold one tenant-environment advisory lock, and `activate` on a live change or `rollback` with nothing live reconcile (F1); a reused staged release returns its own revision, a conflicting tenant one is refused `CUSTOMIZE_RELEASE_REVISION_CONFLICT` (F2); `previewEligibility` is routed and a test proves every gateway method is (F3); rollback targets the live change's parent (F5).
- Agent terminal and web server agree: every runtime routes each request by the pointer; opening a runtime on a database whose pointer names a tenant descendant of its tip serves it and moves nothing (tested); a moved base fails loudly. AGENT-2's "terminal refuses a foreign release" must accept a tenant descendant of its tip.

## Slices

1. Draft and diff — `customize draft`. 2. Approve, live activation, rollback — `customize approve|activate|rollback`, `test/postgres/customization*.test.ts`. 3. Customize screen — STOPPED, built on `packet/CUSTOMIZE-s3`. 4. AI drafting — `customize ask`. 5. Rehearsal — [result](../evidence/2026-11-17-customize-week6-rehearsal.md): request to live record 46.6 s, rollback 3.0 s (CI run 44077868142).

## Gates

- Local: format, typecheck, lint, `check:boundaries`, `check:app-release`, `check:demo-release`, `check:expected-red`; unit `customization` 7/7 (reds: in-process tenant compile refused; worker without heap flag refused), `customization-ai-draft` 4/4; Docker-free architecture 28/28. PostgreSQL and browser suites run in CI only.

## Test it yourself

With `corepack pnpm dev` running: `corepack pnpm customize draft apps/api/scripts/examples/equipment.json` prints "New record type "Equipment" with 4 fields" and "Nothing is live yet"; `customize status` lists it; `customize approve <id>` then `customize activate <id>`; reload the app: Equipment is in the menu, no restart. `customize rollback`: Equipment is gone; records entered under it return after approve and activate again. With `NORTH_STAR_AGENT_KEY_FILE` set, `corepack pnpm customize ask "customers need a tax exempt number"` drafts a field on Party.

## STOP — slice 3, the Customize screen

What: the ux-grammar skill ("Every screen renders through SurfaceRuntime… Never build a bespoke screen outside SurfaceRuntime… a separate builder application") and SURF001 forbid the minimal screen the charter asks for "in the web app"; the only application screen outside the seam is owner-ratified (RECEIPT §5.11). Options: (1) ratify a one-line seam exception for a local-demo-only Customize screen (`apps/web/src/customize-screen.ts`, built and tested on `packet/CUSTOMIZE-s3`: four forms, plain diff, Approve, Activate, Roll back; any demo persona can approve and the approval names the fixture approver); (2) build Customize through SurfaceRuntime as compiled surfaces with registered capability operations — the §8.5 builder the charter filed. Recommendation: (1).

## Filed

- Re-applying tenant patches to a moved first-party base (ADR-0013 upgrade) fails loudly with `dev:reset`; the rebase is not built.
- The full §8.5 builder archetype (charter: filed, not built).
- F5's deeper case: after base→A→B and a rollback to A, rolling A back to base is refused (`CUSTOMIZE_ROLLBACK_NOT_REVERSIBLE`): the reverse-transition policy reverses only the activation that made the current release live (here B's rollback). Needs a policy change (orchestrator's call).
- F4 (TRUNCATE bypasses the append-only rules, repo-wide) and F6 (terminal guard) are the orchestrator's and AGENT-2's.
- AGENT harness: under the scope mismatch above, the receive task's scripted run answered with no refused tool call while posting nothing; only its end-state check caught it (for AGENT-2).
