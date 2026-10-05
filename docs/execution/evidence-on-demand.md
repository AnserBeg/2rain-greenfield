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
