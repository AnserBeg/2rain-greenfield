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

## Build checkpoints after the targeted check

| Slice | Members and rungs | Stores, budgets and Test it yourself |
| --- | --- | --- |
| 1a · Fixture runner | No member or rung | Runs, leases, controls, counters and reservations. On both hosts run the fixed fixture and inspect a collected table and PNG. Exercise the start budget, kill switch and teardown. |
| 1b · Governed trials | First-party Run analysis Task rung, no member | Snapshots and lineage. Run one company's forecast, change a receipt, then repeat and refresh. Observe staging limits, input digests and current authority. |
| 2 · Save and share | Recipe and report-binding members and rungs, plus the evidence content-type rung | Reports, version/source links, version grants and DOCS-1 stores. Share one saved chart, remove a contributing field grant and try its direct document link. Test access at cap and cap+1, source purge and idempotent save. |
| 3 · AI authoring | Analysis profile, no new member or rung | Sessions, calls and the model-dollar budget. Approve a forecast, inspect two iterations and their digests, try an injected instruction and race the last reservation. |
| 4 · Schedules | Schedule member and rung | Consents and existing workflow timer/journal. Restart after Monday's save, check one scheduled charge and version, revoke the sponsor and verify the next wake refuses. After five publications open the oldest result and inspect its expired repeat choice. |

Each new member earns its own persisted absence parity, actual preceding-reader refusal, replay, rollback and schema-generated drafter evals. The DOCS-1 stored type independently owes actual preceding-reader refusal by name.

## Slice 1a · Stopped at the WSL capability spike, 2026-11-21

- On kernel `6.6.87.2-microsoft-standard-WSL2`, the native Docker endpoint reported `systemd`, cgroup v2 and security options `name=seccomp,profile=builtin` and `name=cgroupns`. It did not report `name=rootless`.
- The user endpoint `/run/user/1000/docker.sock` was absent. `rootlesskit true` exited 1 during UID/GID mapping because `newuidmap` was missing. Both `/usr/bin/newuidmap` and `/usr/bin/newgidmap` were absent.
- The WSL gate refused before launch. The CPU, memory, process, time, DNS, socket, kill and scratch checks have no measurements. The hosted spike and full CI dispatch are pending.
- **Try it yourself** on this WSL host. Run `docker info --format '{{json .SecurityOptions}}'`, then `rootlesskit true`. Before retrying the fixture, the intended user daemon must report `name=rootless` and the mapping probe must exit 0.

## Owner setup

Run these commands as the laptop owner in an interactive WSL systemd login. The current account already has 65,536 subordinate UIDs and GIDs and the Docker rootless setup tool. The existing system daemon can continue serving other projects. [Docker rootless setup](https://docs.docker.com/engine/security/rootless/) · [Controller delegation](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources)

```sh
sudo apt-get update && sudo apt-get install -y uidmap
sudo install -d /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
sudo systemctl set-property --runtime "user@$(id -u).service" Delegate="cpu cpuset io memory pids"
systemctl --user start analysis.slice && systemctl --user set-property analysis.slice MemorySwapMax=0
rootlesskit true && dockerd-rootless-setuptool.sh install --force
systemctl --user enable --now docker
docker --host "unix:///run/user/$(id -u)/docker.sock" info --format '{{json .SecurityOptions}}'
```

The user endpoint must report `name=rootless`. The hosted capability gate governs development while laptop setup is pending.

## Gates

Local docs gate is `scripts/check-records.sh`. This checkpoint changes documentation only. The CI reference is the successful full **base** run at `630e2aa6`, whose executable tree the packet shares.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599

## Test it yourself · design read (under five minutes)

1. Run `git diff --name-only 6b62b00f...HEAD` on the packet branch. Expect the ADR, this record and the ledger.
2. In §§2 and 4, follow a colleague opening Tuesday's saved forecast after losing access to one contributing row. Both the direct chart link and an original-input repeat withhold it. Follow a fifth scheduled publication instead and an authorized reader can still open the oldest result.
3. In §5 follow a sample cell that asks the assistant to share the report. Inspect the three available tools, the session limits and the human's separate exact-code review before Share. In §7 a retried schedule wake supplies one version without a model call.
