# PR-1 — Mechanical GATE-INTEGRITY corrective

Status: accepted
Tier: Mechanical-leaning (Behavioral edge: locale comparator)
Branch: `fix/pr1-gate-integrity`
Base: `12e6c66ac1834274391e0b63c9d44a60eb2514c7`
Frozen reviewed candidate: `318cb7cdc2599b52cf6e4e50b759f4853ef55d2d`
Integrated evidence candidate: `b389f71498ce5a9a3cc4c287342b56b9469dd514`
Acceptance merge: `58538e20358b990e0ef613aa7bbd21dd60f2421e`
Review: PASS — one fresh naive Codex `gpt-5.6-sol` xhigh on the identical
unchanged candidate

## Authority and outcome

This packet implements the binding mechanical disposition in
`docs/execution/program-reviews/2026-07-24-g2-p3-party/converged-record.md`.
The review archive is preserved under
`docs/execution/program-reviews/2026-07-24-g2-p3-party/`, and the execution
ledger points to the converged B1 **KEEP**, B2 **ADJUST — sequencing only**
verdict. PR-1, PR-2, and PR-3 remain ordered before Catalog/Location fan-out.

PR-1 corrected the six selected gate-integrity defects and the three
explicitly authorized mechanical bridges. It did not begin PR-2 or PR-3 and
did not implement any semantic finding from the whole-app review.

## Corrective scope

1. **Browser gate.** The G2 module-conformance fixture imports
   `@north-star/canonical-model`, not a deep relative `.js` path across the
   root-CJS/apps-web-ESM boundary. Its fixture-local `package.json` establishes
   the ESM boundary expected by Playwright's transform, and the architecture
   fixture-shape assertion requires that file. The root browser command stays
   unfiltered.
2. **Unit discovery.** `test:unit` explicitly names all six unit files.
   `repository-hygiene.test.ts` independently discovers the files and asserts
   both the exact count and set, so adding or silently omitting a file fails.
3. **CI completeness.** CI now runs compiler, schema, agent, and locale gates.
   `lint` was already present and remains required. The architecture test's
   required-gate set matches the workflow.
4. **Deterministic comparators.** The three authorized `localeCompare` sites
   use explicit UTF-16 code-unit order: provider change-document entries,
   migration filenames, and storage-transition element ordering/validation.
   A real-provider subprocess probe runs under `C` and `sv_SE.UTF-8` and
   requires byte-identical persisted `changes::text`. No golden file or
   persisted digest contract changed.
5. **ADR-0011 status.** Its header is ratified and cites the ledger's Freeze-F
   ratification; decision content is unchanged.
6. **Doctrine.** `AGENTS.md` and mission-cadence require the full CI matrix at
   the exact integrated SHA, recorded by the ledger. Deadline, expiry, and
   elapsed-time logic uses a monotonic source; timing tests inject controlled
   clocks and never sleep-and-measure.
7. **Authorized lint bridge.** Commit `2604c634f9485d5f5453e6b1a02ec01627d3775c`
   mechanically clears all 19 inherited lint errors in a separable 14-file
   diff. Changes are type-only imports, explicit intentional `void` uses,
   equivalent control flow, and removal of one unused never-called helper.
   No code path changes behavior. No lint rule/config changed and no inline
   `eslint-disable` exists, so no disable justification is required.
8. **Authorized security exception.** The gitleaks finding is not a real
   credential. It is the static G2-P1 test sentinel
   `g2-secret-persistence-fixture`, supplied as `SECRET`-classified input so
   `test/postgres/trust-substrate.test.ts` can assert that the literal is
   absent from persisted evidence and only `REDACTED` remains. The exception
   is one adjacent-commented exact fingerprint:
   `a71aa33157ac35f54dd3c9e4f36bd65b5c5e0861:test/postgres/trust-substrate.test.ts:generic-api-key:52`.
   There is no path-wide or rule-wide exception. The clean scan passes while
   the disposable synthetic-negative repository still produces its required
   finding.
9. **Authorized archive normalization.** The copied Codex review begins with
   the required provenance line. Its body was mechanically verified against
   `/home/rvham/program-review-g2p3/r1-codex-reply.md` after normalizing only
   trailing spaces, line endings, and the final newline. The external file is
   the byte-exact source of truth; the other three archived inputs remain
   byte-identical.

The exact-fingerprint safeguard was also captured in `learnings.md` under the
repository's adjudicated-learning rule.

## Commit trail

| Commit | Purpose |
|---|---|
| `15908e54388947ee23f5d81e1f703a732e3c2772` | Preserve the converged program-review archive and ledger pointer |
| `753f7c969c5f4afa81086ae5d17e3e4e8324887a` | Implement the six selected gate-integrity fixes |
| `2604c634f9485d5f5453e6b1a02ec01627d3775c` | Authorized, separable mechanical lint bridge |
| `849e3b50cc788e2798755e086e7491f179c2f40a` | Require the fixture-local ESM boundary in architecture evidence |
| `318cb7cdc2599b52cf6e4e50b759f4853ef55d2d` | Exact synthetic-secret exception and archive normalization |

## Full-matrix evidence on the frozen candidate

The commands below ran from a clean checkout state at exactly
`318cb7cdc2599b52cf6e4e50b759f4853ef55d2d`. Focused development runs did not
substitute for this matrix.

| Gate | Result |
|---|---|
| Frozen install | PASS — pnpm 11.9.0, all 13 workspace projects |
| `corepack pnpm format` | PASS |
| `corepack pnpm lint` | PASS — all 19 inherited errors cleared; no disables |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 92 files scanned |
| `corepack pnpm build` | PASS |
| `corepack pnpm test:unit` | PASS — 26/26 from the explicit six-file set |
| `corepack pnpm test:compiler` | PASS — 46/46; no pinned golden moved |
| `corepack pnpm test:integration` | PASS — 40/40 |
| `corepack pnpm test:agent` | PASS — 1/1 |
| `corepack pnpm test:architecture` | PASS — 42/42 |
| `corepack pnpm check:schema` | PASS — 8 applied, 8 verified, no drift |
| `corepack pnpm test:postgres` | PASS — 60/60, including locale evidence |
| `corepack pnpm test:locale` | PASS — 1/1, persisted bytes identical across `C` and `sv_SE.UTF-8` |
| `corepack pnpm test:browser` | PASS — 5/5, all three spec files loaded |
| Security CI job | PASS — dependency audit exit 0; 174-commit clean scan found no leaks; required negative fixture detected |
| Observability CI job | PASS — 5/5 |
| Patch and tree cleanliness | PASS — `git diff --check main...HEAD`, no tracked or untracked residue |

Development reds were retained rather than hidden. Before bridge #7, `lint`
reported 19 inherited errors. Candidate `2604c63` ran 41/42 architecture tests
because the new fixture-local `package.json` was not yet admitted to the exact
fixture shape; `849e3b5` corrected that expectation. Candidate `849e3b5` then
exposed the historical synthetic-secret false positive and intentional
Markdown hard breaks in the newly archived review. The user-authorized exact
corrections produced the green frozen candidate above.

## Review evidence

The first launcher command was rejected before model invocation because the
installed CLI requires `agents.max_depth >= 1`; it produced no review session
or verdict. The subsequent invocation was fresh, naive, read-only, used Codex
`gpt-5.6-sol` at xhigh effort, and reviewed only
`main...318cb7cdc2599b52cf6e4e50b759f4853ef55d2d`.

The charter bounded the reviewer to: the six fixes; genuine full-browser
loading; self-checking discovery; no persisted-digest/golden movement;
doctrine agreement; mechanical-only lint fixes without linter weakening; the
exact synthetic fingerprint; and whitespace-only archive normalization. It
explicitly excluded PR-2/PR-3 semantics, fan-out, broad security redesign,
style preferences, and adversarial-evasion hypotheticals.

Verdict: **PASS** on all seven decisive questions, with no in-scope material
findings. The reviewer confirmed all three browser specs/five tests remain in
the unfiltered suite, all six unit files are explicitly and independently
checked, comparator changes are code-unit deterministic without persisted
digest or golden movement, doctrine matches the converged record, all 19 lint
fixes preserve behavior with no disables, and both authorized full-matrix
corrections are exact.

No REVISE round was needed.

## Test it yourself

From the repository root, these commands take under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git show -s --format='%H %s' b389f71498ce5a9a3cc4c287342b56b9469dd514
corepack pnpm lint
corepack pnpm test:architecture
corepack pnpm test:locale
corepack pnpm test:browser
SECURITY_EVIDENCE_DIR=test-results/security .github/scripts/run-security-scans.sh
```

Expect the frozen commit, a silent successful lint run, architecture 42/42,
locale 1/1, and browser 5/5 across `party-runtime.spec.ts`,
`surface-data-binding.spec.ts`, and `surface-runtime.spec.ts`. The security
command must report no leaks in the repository, one finding in its disposable
negative fixture, and an overall pass.

## Checkpoint

PR-1 is accepted by non-squash merge
`58538e20358b990e0ef613aa7bbd21dd60f2421e`, preserving integrated candidate
`b389f71498ce5a9a3cc4c287342b56b9469dd514` as an ancestor. The archived and
converged G2-P3 whole-app program review governs the remaining corrective
sequence, and the full-matrix-at-integrated-SHA rule is in force. No new
program-review trigger fires at this checkpoint. PR-2 remains unstarted and
requires explicit user selection. Do not fan out to Catalog or Location.
