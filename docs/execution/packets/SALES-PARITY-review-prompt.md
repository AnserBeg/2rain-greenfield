# SALES-PARITY — review round 6 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `28ecce28`.
Review the fix `f339e83c` (tests and controls `45b4733c`), merged at `28ecce28`. Since round 5's `bf24b925` the
only Critical-set change is `packages/postgres-provider/src/release-verification-service.ts` in `f339e83c`.
Read wider code as you need.

R1 (round 4): `#create` required every server-assigned document number in the create's read-back and
registered the record for cleanup only afterwards; its fix reads an omitted number through a plain get that
selects it, else uses the record's deterministic sentinel (`verificationSentinelNumber`) unread, and
registers each create before reading its numbers.

Round 5 found R1 not closed for every admitted declaration. The compiler admits any boolean filter on a Q0
query, but the query gateway runs a Q0 read only when `inspectPredicateForExecution(filter)` accepts it (the
literal `true`) and answers any other `unsupported` without reading. P2a: `#assignedWitness` read a number
the create's read-back omits through the first active plain q0 get that selects it, without that admission,
so a get filtered `booleanPredicate false` made a stored number read as missing (a false
`VERIFICATION_ASSIGNED_VALUE_MISSING`). P2b, pre-existing: cleanup's `#queryForEntity` could pick such a get
as the entity's first plain get, and `archiveProbeRecords` treated its no-row answer as already archived, so
probe records were left live.

The fix, provider-only: `gatewayExecutesQ0(query)` is active + Q0 + the gateway's own fence accepting the
filter. The witness reads only through the first plain get that selects the field and that the gateway
executes, else uses the record's sentinel unread; a get that ran must answer `exact` with the record's
sentinel (`VERIFICATION_ASSIGNED_VALUE_MISSING`/`_MISMATCH` otherwise, now naming the query and its answer).
`#queryForEntity` (over `#findQueryForEntity`) returns the first plain query of the type that the gateway
executes. `archiveProbeRecords` skips only `not-found` with no records; a record it cannot read (its entity
has no get the gateway executes, or the answer is neither the record nor `not-found`) is collected and,
after every readable record is archived, refused as `VERIFICATION_PROBE_RECORD_UNREADABLE` naming each one.
The compiler, the plan, the evidence schema and the derivation reasons are unchanged.

Question: are P2a and P2b closed for every admitted declaration, and did the fix introduce a new production
defect? Try to break it. Report production defects separately from evidence, wording and naming, which are
filed, not fixed.

Where to look:
- `release-verification-service.ts`: `gatewayExecutesQ0`, `#assignedWitness`, `#findQueryForEntity` and its
  callers (`archiveProbeRecords`, `#queryForEntity` for `#searchableExclusion` and `#typedErrorSurface`),
  `queryAnswer`.
- The gateway's own admission: `semantic-query-gateway.ts` `invoke` (lifecycle, tier, filter fence),
  `predicate-kernel.ts` `inspectPredicateForExecution`; `module-runtime-interpreter.ts` `executeQueryOnClient`.
- Tests: `test/postgres/document-numbering.test.ts`, the new test (Party with `party_account_get` filtered
  `false` and sorted before `party_get`, `party_z_account_get` executed, `party_role_number_get` filtered
  `false`; then a verification whose executor answers `party_get` `unsupported`) and the R1 test.
- Controls: `test/evidence/SALES-PARITY.expected-red.json` `verification-witness-reads-through-executed-gets`,
  `verification-refuses-unreadable-probe-records`, `verification-reads-numbers-the-read-back-omits`.

Consider at least: whether `gatewayExecutesQ0` can disagree with the gateway for any get or search
verification invokes (retired, q1, a scope operand, a read model); whether the narrower `#queryForEntity`
can refuse (`VERIFICATION_QUERY_MISSING`) a release that should verify; whether `not-found` can mean anything
but "a probe archived it"; whether deferring the refusal can archive a record a scenario still needs or hide
another failure; and whether any probe now passes without reading what it claims.

Already filed (judge severity if you disagree, but they are known): E1 the assigned-number probe shows
distinct values and input ownership, not a stored fold; E2 document-numbering's executed-id set is scoped by
release root, not by one activation; W1 "keep distinct numbers" overclaims a 64-bit hash; E3 (noted while
fixing round 5) `#declaredEvidence` records a query assertion's answer, `unsupported` included, without
comparing it with the assertion's expected outcome (no product assertion targets a query the gateway does
not execute); latent, unreached by any admitted declaration: `#declaredEvidence` and the refused create in
`#assignedUniqueness` do not register records they would create, and `archiveProbeRecords` stops at its
first failed archive (an unreadable record no longer stops it) and, from `finally`, can mask the scenario's
own error.

Not the packet records. Say plainly if this prompt steers you.
