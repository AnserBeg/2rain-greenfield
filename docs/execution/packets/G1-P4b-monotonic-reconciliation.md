# G1-P4b-fix — monotonic reconciliation deadlines

Status: evidence_ready
Tier: Critical
Branch: `fix/g1-p4b-monotonic-reconciliation`
Frozen candidate: _this commit_ (resolved to the candidate SHA at handoff)
Review: pending — fresh Codex `gpt-5.6-sol` xhigh, then Fable max on the
identical unchanged SHA

## Root cause and corrected invariant

G1-P4b persisted reconciliation `started_at` from PostgreSQL
`clock_timestamp()` and later compared its deadline with a fresh
`clock_timestamp()` read. Both are statement-time values, but neither is
monotonic. A backward host-clock correction could therefore reduce computed
age and delay or miss an overdue alarm. The load-sensitive 100 ms test exposed
the latent production defect while G2-P2c exercised the activation kernel.

Elapsed reconciliation age now has two authorities with distinct purposes:

- PostgreSQL `clock_timestamp()` remains the persisted wall-time observation
  used for timestamps and normal forward progress.
- A boot-scoped monotonic sample supplies elapsed duration. The provider binds
  Linux's monotonic `process.hrtime` value to `/proc`'s stable boot identity and
  persists the first sample as an immutable activation phase receipt under the
  already-serialized attempt lock.

Terminal outcomes and verification receipts persist a matching monotonic
completion anchor in their own transaction. Classification compares that
completion sample with the start sample, so a recovery that starts before the
deadline and commits after it cannot be misclassified when wall time steps
backward. Completion evidence and its anchor commit or roll back together.

The effective observation is the later of fresh PostgreSQL wall time and the
persisted anchor wall time plus monotonic elapsed milliseconds. A backward
wall step therefore cannot reduce or pause elapsed age. The anchor is durable,
so a database outage, pool teardown, or fresh coordinator process on the same
host boot retains the deadline trajectory. Once due, the existing immutable
alarm row remains the idempotent durable projection. No migration, schema
snapshot, policy, or activation contract version changed.

The injected clock is a provider construction dependency, never request or
operation input. Production samples use PostgreSQL wall time plus the Linux
boot-scoped monotonic source; tests inject both dimensions deterministically.

## Deterministic regression

The former sleep-based outage test now fixes a wall-time origin and a monotonic
origin, then proves this sequence without waiting on wall time:

1. reconciliation starts at monotonic 10,000 ms;
2. at 10,099 ms, the wall clock is injected two seconds backward and no alarm
   fires before the 100 ms deadline;
3. the database is paused and the monotonic clock advances through the
   deadline while the wall clock remains two seconds behind;
4. after unpause, a fresh pool and coordinator at 10,101 ms derive the overdue
   state from the persisted anchor and record exactly one alarm;
5. normal recovery completes and retains the durable alarm.

A second probe starts a recovery at monotonic +99 ms after another activation
has advanced the pointer, then completes the terminal `LOST_RACE` fact at
+101 ms while wall time remains two seconds behind. A proxy drops that
transaction's commit response before the separate alarm projection can run.
The test proves the terminal outcome and monotonic completion anchor committed
atomically, the alarm row is absent, and a fresh coordinator still derives
`OVERDUE_COMPLETED` before recording the one alarm.

The 3.1-second sleep is removed. The test asserts the single immutable anchor,
the synthetic effective observation, the pre-deadline non-alarm, and the
post-outage alarm. It does not widen a wall-clock tolerance.

## Exact scope

Owned corrective paths:

- `packages/postgres-provider/src/release-activation-service.ts`
- `test/postgres/release-activation.test.ts`
- `docs/execution/packets/G1-P4b-monotonic-reconciliation.md`
- `docs/execution/ledger.md`
- `learnings.md`

Out of scope: G2-P2c runtime work; module serving; release approval, CAS,
verification, expiry, or rollback semantics; migrations and schema snapshot;
tenant/RLS policy; real modules; and UI. The paused P2c branch is not modified.

## Gate evidence

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 84 files scanned |
| `corepack pnpm format` | PASS |
| `node --import tsx --test test/postgres/release-activation.test.ts` | PASS — 15/15, including the deterministic backward-step/outage case |
| `corepack pnpm test:postgres` under four concurrent CPU workers | PASS twice — 55/55 on each independent full run |
| `corepack pnpm check:schema` | PASS — 7 applied / 7 verified; drift clean and snapshot unchanged |
| `corepack pnpm test:architecture` | PASS — 35/35 |
| `git diff --check` | PASS |

The first name-filtered Node attempt discovered no nested tests (`1..0` inside
the file), so it is explicitly excluded from evidence. The complete activation
file and both complete PostgreSQL runs executed the regression non-vacuously.

## Review charter and status

Threat model: non-monotonic wall time under honest operation, including NTP or
load-induced correction. Out of scope: P2c O0 runtime and real modules.

The fresh Critical-tier reviewers must decide only whether:

1. backward wall-clock movement can never delay or miss the deadline/alarm,
   and the injected-step test proves it;
2. the monotonic trajectory survives database outage and a fresh coordinator;
3. no premature alarm fires and the existing alarm semantics remain intact;
4. the test injects wall and monotonic time deterministically rather than
   sleeping against wall time; and
5. no other activation-kernel behavior changed.

Fresh naive Codex xhigh round 1 reviewed `920169c5ae06e2ab2e037a0530d7be88ae71ee86`
and returned **REVISE** with one material finding: unresolved age used the
monotonic timeline, but completed recovery still classified only from its
stepped wall timestamp. The bounded fix adds the atomic completion anchor and
the commit-response-loss crossing probe described above. No other finding was
reported.

The new candidate awaits a fresh naive Codex xhigh re-review and then Fable
max confirmation on the identical SHA. Any code change invalidates both.

Program-review triggers do not fire at this checkpoint: this is an unintegrated
corrective packet, not a first end-to-end slice, fan-out point, stabilized new
correctness domain, zero-dev-code module, or stage gate.

## Test it yourself

From the repository root:

```bash
cd /home/rvham/2rain-greenfield
git show -s --format='%H %s' <frozen-candidate-sha>
node --import tsx --test test/postgres/release-activation.test.ts
corepack pnpm check:schema
corepack pnpm test:architecture
```

Expect the activation file to report 15/15 with
`reconciliation age survives a backward clock step, outage, and fresh
coordinator` green. Expect schema to report 7 applied / 7 verified with clean
drift and architecture to report 35/35. The regression should finish without
the former 3.1-second timing sleep.

No next implementation packet is authorized by this checkpoint. Stop for
review and user acceptance; do not resume G2-P2c.
