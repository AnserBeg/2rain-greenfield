# Evidence on demand: expected-red controls and the schema snapshot on GitHub

Two steps that tie the laptop up for hours run on GitHub's runners instead, when
a pull request asks for them by label (`.github/workflows/evidence.yml`, approved
by the owner 2026-10-04). Without a label every job is skipped, so they cost
nothing. The token is read-only: nothing is committed for you.

| Label | What runs |
|---|---|
| `run-controls` | `bash scripts/check-expected-red.sh --run <name>`, one control per job, four at a time, 45 minutes per job. **Which controls:** every `test/evidence/*.expected-red.json` entry the pull request adds or changes against its base. **Override:** a line `controls: name1 name2` in the pull request body runs exactly those names. |
| `regen-snapshot` | `node --import tsx test/helpers/generate-fresh-tenant-full-replay-schema.ts` on a clean checkout of the head. Uploads the artifact `full-replay-schema-snapshot-<head sha>` (kept 7 days) and says whether it differs from the committed file. |

## Asking for a run

```bash
gh pr edit <n> --add-label run-controls
gh pr edit <n> --add-label regen-snapshot
```

- A label runs its job once, at the pull request's current head. While it stays
  on, every push runs it again, and a newer push cancels the older run. Remove
  it when you have what you need: `gh pr edit <n> --remove-label run-controls`.
- To change the `controls:` line, edit the body first, then remove and re-add the
  label. Editing the body alone starts nothing.
- If the pull request adds or changes no entry and has no `controls:` line,
  nothing runs and the summary says so. A production change that moves the code
  an unchanged entry mutates is not detected; name that entry on the
  `controls:` line.
- GitHub runs nothing for a pull request with merge conflicts.

## Reading the result

```bash
gh pr checks <n>
gh run list --workflow evidence.yml --branch <head branch> --limit 5
gh run view <run-id>    # ANNOTATIONS: one line per control, and the snapshot verdict
```

Each control job writes one line to the run's summary page and as an
annotation, from the runner's own markers for that entry (`MUTATION_RED`,
`EXPECTED_RED_RESTORED` and its final `OK`), never from the exit code alone:

- `` `<name>` at <sha12>: killed with the declared reason (N declared kill(s) failed as declared) and restored green (M passing). ``
- `` `<name>` at <sha12>: FAILED (exit S) — <the runner's first failure line> ``

A control job without a line was cancelled; read its log.

## Citing it in a packet record

The run URL, the head SHA, and the per-control lines exactly as printed:

```text
Expected-red controls on CI: https://github.com/AnserBeg/2rain-greenfield/actions/runs/<run-id> (evidence.yml, head <sha>)
- `<name>` at <sha12>: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (1 passing).
```

The run is evidence for the SHA its lines name, the same as a local `--run` at
that SHA. A later commit that changes executable content needs a fresh run.

## Committing the regenerated snapshot

```bash
dir="$(mktemp -d)"
gh run download <run-id> -n full-replay-schema-snapshot-<head sha> -D "$dir"
cp "$dir/fresh-tenant-full-replay-schema.snapshot.json" test/postgres/
git add test/postgres/fresh-tenant-full-replay-schema.snapshot.json
```

Then commit it with the change that needed it, as the pull request's author.

## Packet and main CI

A packet pull request or a non-main dispatch starts with quick selection. The
selector reads the entire packet diff against the event base (the merge base
with origin/main for dispatch). Renames include both paths. Its allowlist
covers Markdown under docs, README.md, learnings.md, recognized test files
and the exact source entries in the [coverage map](../../.github/scripts/ci-selection.mjs).
A decision record edit also selects the integration test that reads decision records.
Each source entry lists its directly covering tests. Unmapped paths, deletions,
shared infrastructure and the exclusive compiler performance test select full.
Fork pull requests run full under the read-only token.

Quick runs quality, both security scans, architecture, unit, compiler and the
changed or mapped tests. Its reachability summary names every omitted producer.
Full checks all jobs, unfiltered invocations and executed files in one attempt.
A rerun of failed jobs alone cannot combine evidence from different attempts.

GitHub assigns the run title before it reads the diff. A quick request that
selects full dispatches a run named **CI full** and waits for its conclusion.
Follow the full link in the promotion job summary. A promoted pull request tests
the original synthetic merge. The dispatcher uses the parent carrying that exact
workflow version and the child verifies the parent SHA. Cite the run that executed the tests. New packet records carry a
standalone line such as `CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/12345`.

A selectable Critical change on a `packet/` ref stays quick. Database migrations
match the shared `db/` path and promote to full. Quick can run explicitly changed
or mapped PostgreSQL tests, but a migration alone maps to none. At readiness,
a migration lane cites a successful full run on its packet tip or dispatches
one with `gh workflow run ci.yml --ref packet/<id> -f tier=full`. Check the
tested SHA when citing a pull request run, which tests a synthetic merge.

The 2026-11-21 packet selector logs both reported the shared/unknown fallback.
UPGRADE-2-fixes reported `.gitleaksignore` and CUSTOMIZE-5-slice1 reported
`apps/web/src/component-registry.ts`. Both paths continue to select full.
[UPGRADE-2 log](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880635235/job/136775007517)
and [CUSTOMIZE-5 log](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44881203941/job/136776671897).

On main, the push itself runs the selected tier in a per-SHA concurrency group.
Quick applies only if the entire `before..sha` diff passes the merge window's
non-executable path test and has no Critical change. Editing the Critical
pathspec block requires full. A new branch or missing, zero or unavailable
push base requires full. The reachability job names the tier and exact SHA.

Only the head of the merge line builds a candidate. Reserve the merge window
under the packet or train name. From current origin/main, merge one to three
packet tips in order with `--no-ff`. Resolve numbering and regenerate artifacts
inside each merge resolution. Each merge keeps the packet tip as its second
parent and gets its own review-log row keyed by that SHA.

Push the final commit to `candidate/<owner>` and dispatch
`gh workflow run ci.yml --ref candidate/<owner> -f tier=full`. Before pushing
main, run `node scripts/check-merge-window.mjs <owner> <40-character-tip-SHA>`.
An executable or Critical range requires a successful full reachability job on
that exact tip. A docs-only range can use the exemption when main is healthy.
The newest completed full main push must be green, with no newer failed or
cancelled push. Pending full or unclassified runs require exact full candidate
evidence too. If main advances, rebuild on current main. If the train is red,
identify the packet that owns the failing job, drop it and rebuild the rest
from current main with a fresh full run. Watch the main push through completion.
