# ANALYZE-1 · Run Python on company data and share a saved finding

**Slice 0 · Design accepted, 2026-11-21.** The orchestrator accepted `65bdc9f1` after Fable’s design read and the targeted check. The owner approved the charter and the orchestrator ruled on default AI access. [Amended ADR-0090](../../decisions/ADR-0090-python-analysis-and-saved-evidence.md)

## Decisions from the design read

| Item | Decision and location in the ADR |
| --- | --- |
| A1 | §5 adopts the person's sealed-snapshot profile and up to 20 filtered rows/source, then validated tables (50 rows/16 KiB), findings and capped errors. One approval covers five runs and the remaining daily dollars. Only draft, same-snapshot run and finish are available in context. Exact-code review precedes Save, Share, Schedule and recipe publication. Each call has a disclosure digest. Schema only is opt-in. §§4–5 govern saved evidence in the separate analysis profile. |
| A2 | §§2, 4 put private snapshot bytes in PostgreSQL and propose a separate **256 MiB saved + 40 MiB staging** analysis allowance per tenant/environment. Each scheduled destination keeps the latest four repeat inputs. One-off saved inputs follow the version lifetime. Trials expire at 24 hours or earlier, oldest first, under staging pressure. |
| A3 | §4 batches one governed check per source within a request budget of 32 source checks, 25,000 identity pairs and two seconds. Withhold unproved versions. Use authorized archive reads. Source purge withholds the version for everyone and purges snapshot bytes. The proposed **Analysis evidence — 90 days** minimum applies from publication. The Save/Share text tells authors how they too can lose access. |
| A4 | §§2, 4 bind both retained-input modes to the same current version, company, row and field decision as opening the version, plus the caller's run grant. |
| A5 | §4 excludes saved analysis tables from queries, declared reports, workflows and connectors. FORECAST-1 and ROUTES-1 hand proposals to a person through the bound prefilled Task. |
| A6 | §2 supports about 140 stops in a dense matrix and 1,000 part-periods per forecast table. ROUTES-1 first needs a stored, typed and governed travel-time matrix query. |
| A7 | §3 starts 1a with rootless launch, enforced limits, kill and verified teardown on this WSL laptop and a GitHub runner. One development slot, a lower tenant cap on shared hosts, measured free memory and a bounded queue govern admission. The protocol supports a separate linux/amd64 runner. A credential-free collector checks PNG headers before decode. |
| A8 | §§2–3 distinguish original-image repeat, same inputs on the current image and fresh capture. The receipt pins CPU feature class, seeds and execution settings. Compare actual results. Authorized readers keep the saved result if a repeat is unavailable. |
| A9 | The delivery table assigns stores, members, reader rungs, budgets and controls to 1a, 1b, 2, 3 and 4. A first-party Run analysis Task governs private one-offs. Slice 2 gives the DOCS-1 evidence type its own reader rung. The storage rules cover scoped grants, company isolation, fences/digests, writer isolation, lock order and system occurrence keys. |
| A10 | ADR-0090 is provisional. BOOT-CHECK, PLANNER-1 and COMMS-2 also claim 0090. At merge fetch main, take the next free ADR number, rename the file and update its title, every link and the ledger row. Re-fetch just before pushing and repeat on collision. The ledger cites the reviewed tip `6b62b00f`. |

**Other dispositions.** S1 drops the host SQL transform and validator PORT from v1. Python can use SQLite on its sealed input. S2 makes pre-launch refusals free and refunds host failures once. S3 counts per environment and reserves 2 of 20 daily person starts and 10 of 100 tenant starts for scheduled occurrences. S4 records field-ID visibility in published code. S5 accepts residual timing signals on shared hosts. S6 defers standing shares. S7 corrects the reviewed SHA in the ledger.

## Entry conditions from the targeted check

- **1b/2 · Capture and purge (§4).** Serialize sealing and purge in tenant/environment scope. Check current contributor tombstones under the lock. Pause a capture after its read, commit purge, then resume and verify zero retained payload bytes and no usable handle. Reverse the order and verify purge erases the sealed copy. Cover trials in 1b and saved versions in 2.
- **3 · Profile disclosure (§5).** On the first profile-only model call, before any sample or output, assert exactly draft code, run on this same sealed snapshot and finish. Dispatch a share request from that context and verify refusal with no share.

## Slice 1a · Run and cancel the fixed forecast

1. The dedicated user socket must report rootless Docker and delegated cgroup v2. WSL kernel `6.6.87.2-microsoft-standard-WSL2` reported a rootful system daemon, no user socket and missing `newuidmap`/`newgidmap`. Local starts return `ANALYSIS_RUNTIME_UNAVAILABLE` before launch. Laptop measurements await owner setup.
2. On GitHub, the one-CPU cgroup throttled competing workers. The supervisor killed at 60.065 aggregate CPU-seconds and 90.037 wall seconds. The 1 GiB limit produced one OOM kill with zero swap, and a child hit EAGAIN at the 32-task ceiling. Only loopback was visible. DNS failed and Unix, IPv4 and IPv6 socket creation returned EPERM. Cancel killed the job, removed its cgroup and left the next scratch mount empty. [Measured limits](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44896600860) · [Initial capability gate](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44888493877)
3. The image profile pins the OCI manifest, interpreter base, image config and wheel lock. A fresh sandbox decodes and re-encodes each PNG after checking its header. The collector caps incoming bytes, validates typed cells and escapes text. The fixture produced 12 units in period 4 and a 240 × 160 PNG with matching pixels on repeat. The OCI manifest is `sha256:66b1239f293e2904a5132e7fcb56f37e5d788d15408a68035222dc22556601f0`.
4. PostgreSQL admits the fixed fixture under stored company membership and a run grant. Leases reserve worker and collector memory, enforce person and tenant slots, alternate eligible tenants, expire queued jobs and hold ambiguous starts for reconciliation. Released leases retain their tenant and release time. Five tenant stores use required tenant IDs. The internal operator switch table accepts only global and image scopes. Both interactive day counters reserve atomically. Prelaunch refusals are free, launched script failures count and host failures refund once.
5. Global, tenant and image stops fence dispatch and publication. Cancellation terminates the active guest before the slot returns. The v1 protocol passed over stdin/stdout and host-key-pinned SSH. The hosted SSH proof uses two processes on one VM. A dedicated runner can expose `analysis/analysis-worker` as an SSH forced command and configure `ANALYSIS_RUNNER_HOST` on the controller.

**Controls.** Each OCI flag removal runs only a fixed probe. Removing `--network=none` exposes another interface, removing `--memory=1g` exposes an unlimited memory cgroup. Dropping supervisor decisions leaves the job alive. The fixture tests also exercise malformed and excess output, charged and refunded retries, cap+1, company scope, kill/publication and both independent SQL budget mutations. [Hosted fixture run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44896600860)

## Slice 1a fix round

A launched run whose container or cgroup disappears before a confirmed supervisor kill counts as a script failure. The guest and the SIGINT-ignoring sleeper use different unprivileged UIDs. The hosted signal fixture checks PostgreSQL's reservation disposition. The worker classifies malformed guest input at the collector boundary and refunds identifiable host errors.

Recovery uses the runner's boot ID and monotonic lease age. A second tenant's controller leaves a new dispatch alone through the 120-second transport deadline. Expired starts are fenced at the worker. After settlement the controller retries acknowledgment until the worker has removed the job files.

The hosted science fixture repeats the isolation probe on the admitted image. Three removal controls cover production preflight, cgroup limits and the live isolation guard. The spike evaluates x32 and i386 socket decisions offline against libseccomp bytecode. Text cells and findings reject Unicode control and format characters.

For SSH, install `analysis-worker` on the runner account's command path. Its dedicated `authorized_keys` entry is `restrict,command="analysis-worker" ssh-ed25519 <controller-public-key-base64>`. The controller pins the host key and disables agent and port forwarding. The fixture exercises a mismatched pin between two valid connections.

**Known limits.** R4 trusts the runner's self-reported machine ID, receipt and output. R5 leaves a guest under cgroup limits until the 120-second sleeper exits if its supervisor dies. A permanently lost runner retains the person's slot. [ADR-0090 §3](../../decisions/ADR-0090-python-analysis-and-saved-evidence.md)

## Owner setup

Run these commands as the laptop owner in an interactive WSL systemd login. The current account already has 65,536 subordinate UIDs and GIDs and the Docker rootless setup tool. The existing system daemon can continue serving other projects. [Docker rootless setup](https://docs.docker.com/engine/security/rootless/) · [Controller delegation](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources)

```sh
sudo apt-get update && sudo apt-get install -y uidmap
sudo install -d /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
# Save work, restart WSL from PowerShell with wsl --shutdown, then reopen this distro and continue.
systemctl --user start analysis.slice && systemctl --user set-property analysis.slice MemorySwapMax=0
rootlesskit true && dockerd-rootless-setuptool.sh install --force
systemctl --user enable --now docker
docker --host "unix:///run/user/$(id -u)/docker.sock" info --format '{{json .SecurityOptions}}'
```

The user endpoint must report `name=rootless`. The hosted capability gate governs development while laptop setup is pending.

## Gates and Test it yourself

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44893791677

Tenant scope, retained leases, schema replay and the rootless SSH fixture passed in [targeted CI 44896600860](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44896600860). The historical full run above failed at the architecture checks on `34573444`. The fix-round gate is one full dispatch on the packet tip and its push-triggered Analysis fixture run.

- On this laptop run `python3 -B -m unittest discover -s analysis/tests` for the worker and collector tests, then `python3 -B analysis/runner/runtime.py` for the named refusal. Inspect the completed run with `gh run view 44896600860 --log | rg 'Isolation:|Expected red:|Rootless capability gate|projects 12'`.
- On a configured rootless host run `python3 analysis/image/build.py && analysis/tests/fixture-db.sh --science`. The fixture driver uses a disposable host PostgreSQL cluster. It checks the period-4 table, chart pixels, replay and cancellation.
- Slice 1a adds migration 0060 provisionally. Recheck the number against main at integration. The owner’s WSL setup and the 1b/2 and 3 entry conditions above carry forward. Slice 1a stays on its packet branch for review.

```record-claim
{"schemaVersion":"northstar.record-claim/v1","packet":"ANALYZE-1","base":"644a9a3998cf1196852ab30c8ccca4dda6bea226","head":"ff8778a401e52fddaccbe66d719285b6547fb888","changedPaths":[".github/workflows/analysis-fixture.yml","analysis/analysis-worker","analysis/controller.mjs","analysis/image/.dockerignore","analysis/image/Dockerfile","analysis/image/build.py","analysis/image/profile.json","analysis/image/wheels.lock","analysis/runner/clean_png.py","analysis/runner/execution.py","analysis/runner/fixture.py","analysis/runner/frames.py","analysis/runner/guest.py","analysis/runner/runtime.py","analysis/runner/seccomp.json","analysis/runner/worker.py","analysis/tests/admission.mjs","analysis/tests/fixture-db.mjs","analysis/tests/fixture-db.sh","analysis/tests/hosted-transport.sh","analysis/tests/science.py","analysis/tests/seccomp_decisions.py","analysis/tests/spike.py","analysis/tests/test_execution.py","analysis/tests/test_frames.py","analysis/tests/test_protocol.py","analysis/tests/test_runtime.py","db/migrations/0060_analysis_fixture.sql","db/schema.snapshot.json","packages/dev-tooling/src/tenant-completeness.ts","test/architecture/release-persistence-boundary.test.ts","test/architecture/tenant-completeness.manifest.json","test/architecture/tenant-completeness.test.ts","test/postgres/inventory-storage.test.ts","test/postgres/migrations.test.ts","test/postgres/module-storage-transition.test.ts","test/postgres/trust-substrate.test.ts"],"symbols":[{"path":"analysis/controller.mjs","name":"FixtureController"}]}
```
