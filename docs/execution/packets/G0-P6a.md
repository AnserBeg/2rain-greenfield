# G0-P6a — X-01 baseline input freeze

Status: accepted
Tier: Mechanical
Frozen candidate: `68f748cde06ecc795b159be5ae507a9d973106ac`
Annotated tag: `x01-baseline-v1`

## Outcome

Captured immutable X-01 baseline inputs in the isolated quarry worktree
`/home/rvham/2rain_erp-wt/g0-p6a` on branch `codex/g0-p6a-x01-freeze`. All
365 changed paths are under `baselines/x01-v1/`; the original quarry checkout
at `/home/rvham/2rain_erp` was not modified.

The baseline contains redacted configuration-key names, toolchain metadata, a
candidate seeded harness database, the tracked ERP-agent corpus and local
historical results, the Terra operations report, source identity/provenance,
and an integrity verifier. See [baseline record](../baselines/x01-v1.md).

## Gates and review

| Gate | Command | Result |
|---|---|---|
| Integrity | `bash baselines/x01-v1/verify.sh --integrity` | PASS: `manifest_and_payload=ok`, `database_integrity=ok`, `secret_scan=ok`, `tag_provenance=ok`, `x01_integrity=ok` |
| Whitespace | `git diff --check 68f748c^ 68f748c` | PASS (no output) |
| Owned-path scope | `git diff --name-only cdfc54b^ 68f748c` | PASS: 365 paths, all under `baselines/x01-v1/` |
| Typecheck | N/A | The packet produces no compilable source, and the quarry's `corepack pnpm typecheck` fails during a pre-existing non-interactive reinstall unrelated to this freeze; `verify.sh` is the operative gate. |

Mechanical-tier review was orchestrator self-verification, permitted by
`review-tiers`: the commands above were run against the final unchanged SHA.
Earlier reviewer process attempts were stopped without a verdict and are not
review evidence.

## Test it yourself

```bash
cd /home/rvham/2rain_erp-wt/g0-p6a
git show --no-patch --format=fuller x01-baseline-v1
bash baselines/x01-v1/verify.sh --integrity
git diff --check 68f748cde06ecc795b159be5ae507a9d973106ac^ 68f748cde06ecc795b159be5ae507a9d973106ac
```

In under a minute, the tag should resolve to the frozen commit, the verifier
should print five `=ok` lines, and the final command should print nothing.

## Capture note

The initial freeze had four trailing blank lines in metadata. They were
normalized before final acceptance; the checksum inventory, manifest facts,
commit, and annotated tag were regenerated together.
