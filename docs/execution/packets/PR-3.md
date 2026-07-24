# PR-3 — CRITICAL OPERATION-MEDIATION corrective

Status: accepted
Tier: Critical
Branch: `fix/pr3-operation-mediation`
Base: `2b98441bca829f1f2125a596135a6d42c3ba1b7d`
Frozen reviewed candidate: `35d731e8fd64c731294aaa0401453c340d1394b2`
Acceptance merge: `01ad1c04d668896133b4d3ffeea376d194cef397`
Review: PASS — fresh naive Codex `gpt-5.6-sol` xhigh, then Fable max on
the identical unchanged candidate

## Authority and outcome

This packet implements the five binding PR-3 dispositions in
`docs/execution/program-reviews/2026-07-24-g2-p3-party/converged-record.md`.
It is the final operation-mediation corrective required before any
Catalog/Location fan-out. All production behavior is generic and driven by the
pinned compiled contract; there is no Party-specific branch.

The packet also contains one user-authorized mechanical security bridge for
`GHSA-mh99-v99m-4gvg`. That bridge is isolated in its own commit and changes
only `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

PR-3 does not start G2-P4, G2-P5, a fan-out module, or agent execution.

## Corrective scope

1. **Server-issued confirmation grants.**
   `SemanticOperationMediationAuthority` issues HMAC-SHA256 grants from a
   process-private random key. Each grant binds tenant, environment,
   principal, pinned release ID and content hash, operation ID, target record,
   canonical input SHA-256, expected revision, and schema version. The sole
   semantic operation gateway checks the grant for every trusted channel and
   refuses missing, forged, input-mismatched, or revision-stale grants with
   stable typed errors. The browser now performs a real preview → confirm
   transition and carries the server-issued grant; the hidden
   `confirmed=yes` field is deleted and its former bypass test is inverted.
2. **Classification honesty.** The exact canonical vocabulary is `public`,
   `internal`, `confidential`, and `restricted`; there is no canonical
   `secret` member. The compiler carries supported `public`/`internal`
   classification into the versioned operation input contract and rejects
   every currently unenforceable member (`confidential` and `restricted`) as
   `MODULE_CLASSIFICATION_UNSUPPORTED`. The generic interpreter derives
   change-document evidence classification from that compiled contract instead
   of hardcoding `SENSITIVE`. Party's `contactSummary` change is declaration
   only: `confidential` → `internal`, reflecting the interim lack of read-path
   masking. Policy-engine and trust-read enforcement remain recorded future
   work.
3. **Universal invocation evidence.** Trusted channel attribution is issued at
   the entry boundary and WeakMap-bound to the pinned request view; business
   input cannot supply or change it. One gateway orchestrator owns parsing,
   policy, confirmation, dispatch, and terminal failure handling. Accepted
   mutations keep their existing atomic provider path, denials record exactly
   one `DENIED` invocation, and validation/executor failures record exactly one
   `FAILED` invocation with a stable typed code. Malformed envelopes are inside
   that boundary. Evidence action IDs use the canonical 5..180 bound and fall
   back to `northstar.runtime:operation.malformed_request`, so even a
   regex-valid overlong operation ID cannot break failure recording.
4. **O0 durable idempotency.** Additive migration
   `0009_semantic_operation_receipts.sql` installs principal-scoped,
   append-only, forced-RLS receipts. A receipt binds tenant, environment,
   principal, release ID and content hash, operation, idempotency key, and
   canonical input digest. Advisory-lock serialization, receipt lookup,
   business DML, trust evidence, outbox, and receipt insertion share one
   transaction. Same key and input replay the byte-identical recorded result
   without another business row or invocation; different input returns
   `SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT`. Browser preview preserves its
   idempotency key. The outbox deduplication key excludes random invocation ID
   and includes principal, content hash, release ID, operation, and key; a real
   PostgreSQL test proves two distinct release IDs with identical content do
   not collide.
5. **One lifecycle authority.** The unused, incompatible
   `LifecycleService` is deleted. ADR-0010 now explicitly supersedes it and
   names compiled O0 dispatch through `SemanticOperationGateway` and the
   generic provider interpreter as the sole lifecycle authority. An
   architecture/integration assertion prevents the dead service from
   returning.

## Compiler-output and migration consequences

PR-3 intentionally adds canonical classification to a compiled runtime
contract. Structural goldens were regenerated from real compiler output and
the compiler suite was run twice without further movement. Final roots are:

- V1: `738b984276548df76d461b66e1390abeb9cad9e2f7be3471b5a8fa3b98496640`
- V2: `62434b54969db9ff983cf1f0498345b8871374c44eab03ccfc7dc6e1b073cae8`

No existing hash algorithm or domain string changed. The only new digest is
the canonical operation-input SHA-256 shared by confirmation and idempotency.
The full PostgreSQL consumer suite ran because compiler output changed.

Migration 0009 and the regenerated real-PostgreSQL snapshot are additive. The
snapshot was regenerated twice without movement; its final SHA-256 is
`8b3777eaf3c1e605b78535ac2d4dc13050e1a907b03ef87a5166db52c2aaccf4`.
Both pre-authorized migration-count assertions advanced from eight to nine.

## Mechanical security bridge

The dependency audit began reporting `GHSA-mh99-v99m-4gvg` against the
transitive development dependency `brace-expansion` at both former resolved
versions, 1.1.16 and 5.0.7. GitHub's advisory identifies all versions through
5.0.7 as affected and 5.0.8 as the sole first patched release; no patched 1.x
release exists.

pnpm 11 reads workspace overrides from `pnpm-workspace.yaml`, so the final
bridge adds the exact global override `brace-expansion: 5.0.8` there and
regenerates the lock. Both `minimatch@3.1.5` and `minimatch@10.2.5` now resolve
that patched version. This necessarily replaces the former vulnerable 1.x
transitive occurrence because the advisory offers no patched 1.x line; no
declared dependency, parent package, ESLint version, rule, or lint config was
upgraded or changed. No advisory suppression was added. An initially attempted
root `package.json` `pnpm.overrides` entry produced pnpm 11's ignored-location
warning and was reverted before any commit.

The security scan is clean. Lint remains green, and the effective ESLint
configuration SHA-256 before and after the bridge is identically
`6ed0136a8e3f3e3323035ffda23aefe97f112e4049e14f339811b6d2221a0d39`.

## Commit trail

| Commit | Purpose |
|---|---|
| `5820987cd274e2d1c96fa4fc04bbf0954aa68645` | Implement the five generic operation-mediation dispositions |
| `60bc4bde3f1241e716045131a63e601c9faf918d` | Bring malformed requests inside terminal evidence and bind outbox dedup to release ID |
| `cda4470ca7f1a86253f87db50fe314fea87130d8` | Bound malformed-attempt evidence identifiers and add the overlong-ID regression |
| `35d731e8fd64c731294aaa0401453c340d1394b2` | Isolated pnpm 11 brace-expansion security override and lock regeneration |

## Full-matrix evidence

The commands below first ran from a clean checkout at frozen candidate
`35d731e8fd64c731294aaa0401453c340d1394b2`. After acceptance, the same complete
matrix ran again at exactly the non-squash integrated merge
`01ad1c04d668896133b4d3ffeea376d194cef397`, with the results below. Focused
development runs and earlier reviewed candidates did not substitute for either
complete run.

| Gate | Result |
|---|---|
| Frozen install | PASS — pnpm 11.9.0, all 13 workspace projects |
| `corepack pnpm format` | PASS |
| `corepack pnpm lint` | PASS — effective rule surface unchanged by the security bridge |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 93 files scanned |
| `corepack pnpm build` | PASS |
| `corepack pnpm test:unit` | PASS — 27/27 from the explicit six-file set |
| `corepack pnpm test:compiler` | PASS — 49/49, repeated twice-stable |
| `corepack pnpm test:integration` | PASS — 42/42 |
| `corepack pnpm test:agent` | PASS — 1/1 |
| `corepack pnpm test:architecture` | PASS — 42/42 |
| `corepack pnpm check:schema` | PASS — 9 applied, 9 verified, no drift |
| `corepack pnpm test:postgres` | PASS — 61/61, including both semantic-contract executions and PR-3 real-provider probes |
| `corepack pnpm test:locale` | PASS — 1/1 |
| `corepack pnpm test:browser` | PASS — full suite 5/5, including real preview/confirm |
| Security CI job | PASS — dependency audit clean, repository scan clean, required synthetic-negative fixture detected |
| Observability CI job | PASS — 5/5 |
| Patch and tree cleanliness | PASS — base diff check, `git show --check`, and clean status |

Development reds were retained rather than hidden. The first Codex candidate
left malformed request parsing outside terminal evidence and omitted release
ID from outbox deduplication. The second candidate accepted a regex-valid
operation ID longer than the trust evidence contract's 180-character maximum.
Both findings received focused regressions before the next frozen candidate.
After the product fixes, the live dependency audit began flagging the new
brace-expansion advisory; the user-authorized pnpm 11 workspace override
resolved both vulnerable lock paths, and the complete matrix was rerun at the
final candidate.

## Review evidence

The Critical review charter was bounded to the five converged dispositions,
generic production scope, the authorized compiler classification bridge, the
additive receipt migration, existing digest preservation, and the isolated
mechanical security bridge. Its threat model was honest-code mediation gaps:
bypassable confirmation, dropped evidence, duplicate effects, stale retries,
and misattributed channels. It excluded the policy engine/read-path masking,
Q0 paging, agent execution, performance, G2-P4, fan-out, hostile database
administration, speculative cryptographic redesign, and dependency-family or
ESLint upgrades.

Codex round 1 reviewed `5820987` and returned REVISE with two material
findings: malformed request parsing could drop terminal invocation evidence,
and the outbox key could collide across distinct release IDs sharing a content
hash. `60bc4bd` corrected exactly those issues and added malformed-envelope and
two-release real-PostgreSQL probes.

Fresh Codex round 2 reviewed `60bc4bd` and returned REVISE with one material
finding: a regex-valid operation ID longer than 180 characters could make the
evidence writer throw while recording the original failure. `cda4470`
enforced the exact canonical bound, used a fixed valid fallback action, and
added the overlong-ID regression.

After the separately authorized security bridge, fresh Codex round 3 reviewed
`35d731e` and returned **PASS** on all eight decisive questions. Fable max then
independently confirmed **PASS** on the identical unchanged SHA. The packet
used exactly two REVISE rounds and then converged to PASS/PASS.

The reviewers and acceptance record contain five valid non-blocking future
observations:

- align the lower-authority runtime authority map's stale `LifecycleService`
  mention with amended ADR-0010;
- decide retired-field handling before an unsupported classified field is
  retired (the current compiler behavior is conservatively over-strict);
- narrow which generic uppercase system error codes may cross the gateway when
  a real API transport is introduced;
- add grant expiry/single-use semantics when the agent-channel threat model is
  admitted; current revision/input/principal/release binding satisfies this
  packet's honest-code threat model;
- the create path now takes `recordId` from the submitted form so the target
  bound into a confirmation grant survives preview → confirm. RLS and primary-
  key uniqueness bound the current consequence; reevaluate caller-selected
  create IDs together with grant expiry/single-use when an adversarial channel
  threat model is admitted.

These observations do not weaken or defer a PR-3 disposition. The policy
engine/trust read model, Q0 paging, agent execution, and performance remain the
explicit future-work boundaries from the binding charter.

## Test it yourself

From the repository root, these commands take under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git switch main
git merge-base --is-ancestor 35d731e8fd64c731294aaa0401453c340d1394b2 HEAD
corepack pnpm test:compiler
corepack pnpm test:integration
corepack pnpm test:postgres
corepack pnpm test:browser
SECURITY_EVIDENCE_DIR=test-results/security .github/scripts/run-security-scans.sh
```

Expect the ancestry command to exit zero, compiler 49/49, integration 42/42,
PostgreSQL 61/61, the unfiltered browser suite 5/5 with the real Party
preview/confirm journey, and a clean security scan that still detects its
required synthetic-negative control.

## Checkpoint

PR-3 was accepted by non-squash merge
`01ad1c04d668896133b4d3ffeea376d194cef397`, preserving reviewed candidate
`35d731e8fd64c731294aaa0401453c340d1394b2` as an ancestor. The complete matrix
passed at that exact integrated SHA. Together PR-1, PR-2, and PR-3 implement
every corrective in the converged G2-P3 program-review disposition.

The program-review trigger has already been satisfied by the archived,
converged G2-P3 whole-app review whose corrective sequence this packet closes.
Do not start G2-P4 or any fan-out packet without a new explicit selection.
