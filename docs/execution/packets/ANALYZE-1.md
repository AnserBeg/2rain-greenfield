# ANALYZE-1 · Run Python on company data and share a saved finding

**Slice 0, design proposed on 2026-11-21.** The owner approved the charter. The orchestrator owns the independent Fable read and ruling before any code or merge. No Critical path changed. [ADR-0090](../../decisions/ADR-0090-python-analysis-and-saved-evidence.md)

## Claims at this checkpoint

1. The ADR traces an analysis from the requesting person's governed queries to a retained input, a bounded Python run and an immutable DOCS-1 version.
2. It specifies how a colleague loses access to a saved chart, how a buyer repeats the original calculation and what the scheduler may do on the buyer's behalf.
3. It identifies the prior-repo PORT inputs and their admission gates. The Fable reader is reviewing a design. The runtime and its controls belong to later slices.

## Decisions

- Keep REPORTS-1's catalog authoritative. Forecasts and route proposals are evidence. Only a separately submitted, named Task can change business records.
- Capture one bounded, authorized read instant. Preserve the bytes for an exact repeat and capture again for a refresh.
- Run one credential-free, network-isolated Linux container per attempt. Pin the CPU image and its seven libraries and enforce quotas and cancellation outside Python.
- Store validated tables, PNGs, prose, source code and input digest in a generated-only DOCS-1 version. Intersect the version grant with live access to every input on each read.
- Let a person or the assistant write the code. A live trial requires review of the exact code and sources. Reserve run and model budgets against both person and tenant.
- Publish recipes, report bindings and schedules as additive revisions. The visual and AI builders emit the same change set. Each capability earns its reader and replay proofs at introduction.
- Use a durable workflow occurrence for each scheduled refresh, bound to a sponsor, approved recipe, company, budget and fence.

## Slices and evidence after approval

| Slice | Test it yourself at its checkpoint | What the build must observe |
| --- | --- | --- |
| 1 · Runner and snapshot | Run a parts forecast, enter another receipt, repeat the original inputs, then refresh. | Exact capture and digest on repeat, a fresh capture on refresh. Compare two companies in one tenant and a hidden field. Probe actual process isolation, revocation, cap+1 and complete teardown. |
| 2 · Reports and sharing | Save a chart and share its version. Remove the recipient's access to one contributing record. Open the same link again. | No title, pixels or bytes via either the report or generic DOCS-1 path. A save retry gives one stored version. Opening a suggested Task leaves business rows untouched. |
| 3 · AI authoring | Ask for the forecast, inspect the code, edit it and confirm the new version. | An instruction in a source value produces no new call. Exact review binds the edit. Two concurrent requests for the last budget slot can reserve it only once. |
| 4 · Schedules | Turn on a Monday refresh, restart after save but before acknowledgement, then revoke the sponsor's access. | One version and one charged run for the first occurrence. No new version after revocation or stale-fence wake. |

Each slice that adds a member owes persisted absence parity, actual preceding-reader refusal, compatible and conflicting replay, rollbacks and live schema-generated drafter evals. The code-authoring experience in slice 3 builds on that support.

## Gates

Local Slice 0 gate: `scripts/check-records.sh`. This narrative packet declares no executable changes. The CI reference below is the successful **base** run at `630e2aa6`, whose executable tree this branch shares.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599

## Test it yourself · design read (under five minutes)

1. From the packet branch run `git diff --name-only 630e2aa6...HEAD`. Expect the ADR, this record and one ledger file.
2. In ADR §§2 and 4, follow a buyer who saves Tuesday's forecast and a colleague who loses access to one cost field on Wednesday. The buyer can repeat Tuesday's input while authorized. The colleague's old chart link must withhold the whole version.
3. In §§5 and 7, follow a draft containing “publish the route” and a retried Monday timer. The text can supply a finding. Only a person submitting the bound Task can publish the route. The timer can produce one private report version.

The ADR ends with three owner choices and proposed defaults for snapshot lifetime, daily budgets and sharing scheduled results.
