# Review after the merge — why the doctrine changed on 2026-11-15

Status: **adopted by the owner on 2026-11-15 ("Adopt it", PR #39).** Proposed by the BUILD lane at the owner's request ("decide the best approach… create a better doctrine"). It amends `AGENTS.md` §3-§6 and the `review-tiers`, `mission-cadence` and `git-workflow` skills, inside their size caps (155 -> 155, 62 -> 60, 102 -> 99, 86 -> 85 lines).

## What the reviews since 2026-09-04 found

The class column is the lane's classification from the records, not re-verified in code.

| where | arms | found | class |
|---|---|---|---|
| SALE-FULFILLMENT, the posting path | 1, reopened once | F1 a reservation restored with no stock behind it; F3 a committed line dropped from a packing list by paging; F2 an unchanged retry refused | F1, F3 silent; F2 loud |
| SALES-PARITY, numbering (rounds 1-3) | 3 | six allocation defects (sentinel prefix, scan width, case fold, a number read as input) | mostly loud; not classified one by one |
| SALES-PARITY, the verifier (rounds 4-8) | 5, a sixth owed | each round, one regression of the previous round's fix: a false `VERIFICATION_*` refusal on a declaration the first-party package does not contain; round 5 also found a probe record left live | loud, except the stray record |
| POSTING-FORWARD-DATE; SALES-PARITY grants | 1 each | nothing | — |
| RELATION-INSTALL `locateColumn` | 0 | never read | unread |

Reading: one arm on the posting path found silent defects in one pass. Eight arms on the verifier found failures that announce themselves, and the existing rule "a second same-class defect means re-scope" did not stop them, because every fix was a new SHA that owed its own arm. The cost was the owner pasting a prompt and a verdict per round, with the merge waiting each time.

## What changes

1. **Nothing waits for a review.** A vertical merges on CI green. Before: a Critical-touching vertical waited for its arm (SALES-PARITY: eight pastes, a ninth owed, never merged).
2. **One read of the trunk, by trigger.** The Critical diff on `main` since the last read is read when it passes 400 changed lines, and always before a stage gate, the week-6 decision and the first tenant. Still fresh, online and user-run. The paths are unchanged and mechanical.
3. **One question: silent harm.** A wrong quantity or amount, a lost or repeated posting, a crossed tenant or company boundary, a wider grant, a missing audit row, a release passed that should be refused. A failure that announces itself is filed.
4. **No confirm arms, by construction.** A fix merges with a test; it is in the next read's range.
5. **Less paper:** an 80-line record, no lane rows, one trunk, no stacked branches.

## What this gives up, plainly

- A silent defect on a Critical path can sit on `main` until the next read — at most 400 changed lines, and never past a stage gate or the first tenant. Pre-tenant there is no real stock or money for it to corrupt.
- A verifier or activation change that wrongly refuses a release is found when a real package hits it, as an error at that moment, not in advance.
- Not changed: the arm is never run by a lane or the orchestrator; CI is the gate; expected-red controls for silent-harm claims; the plan's stage-gate packet still carries independent reviewer findings (plan §"Each gate packet contains", item 10).

## Gates

`check-review-record.sh` is unchanged and still satisfied: every merge records a row naming the packet tip. **Follow-up filed, not built here:** no script computes the unread range or refuses a stage-gate record while it is non-empty (about twenty lines beside `check-review-record.sh`).

## The first read — the trunk's unread residue (replaces the arm INTEGRATION owed)

Of INTEGRATION's Critical diff, the posting hunk and the grant hunks were read before with nothing found, and the verifier was read through `7d254902`. Two sub-ranges were never read. It does not block the trunk merge; it is owed before the week-6 decision, and it is small enough to run now.

```text
You are a fresh reviewer. Repository https://github.com/AnserBeg/2rain-greenfield, branch `packet/INTEGRATION`, SHA `781cd80910e6a0d82b4e5301a5f65d219bb6ecf6` (an ancestor of the branch tip, and of `main` once the trunk is merged; every later commit is docs-only: `git diff 781cd809 origin/packet/INTEGRATION -- packages apps db test` prints nothing).

Read `docs/architecture/posting-kernel-guarantees.md`, then exactly these two diffs under `packages/postgres-provider/src/`, and whatever code you need around them. Do not read the packet records.
1. `git diff 974ae755 781cd809 -- packages/postgres-provider/src/module-storage-materializer.ts` (+17): `locateColumn` now resolves a column element that belongs to a relation.
2. `git diff 7d254902 781cd809 -- packages/postgres-provider/src/release-verification-service.ts` (+79 -54): how release verification picks the search and the get it probes through, and how it evaluates constant filters.

One question: can either diff, silently, install a column on the wrong table or with the wrong shape, leave a verification probe record live, or let verification pass a release it should refuse? Also say if either can store a wrong value, cross a tenant or company boundary, or widen a grant.

Out of scope, file as one line each if you see them: a refusal that announces itself (a false `VERIFICATION_*` error, an `ELEMENT_TARGET_MISSING`), evidence depth, naming, records.

Not verified by the writer: neither diff was read by any earlier review; the writer ran no control against them; CI at this SHA is green on all 14 jobs, which shows the first-party package verifies and installs, not that other admitted packages do.

This framing is a claim under test and bounds nothing. Say plainly if it steers you. For any silent defect, give the input that exposes it.
```
