# SALES-PARITY — review round 7 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `ac52f21b`.
Since round 6's frozen `28ecce28`, the only Critical-set path changed is
`packages/postgres-provider/src/release-verification-service.ts`, in `893a10df`. `fca4719e` adds a test and an
expected-red control; `ac52f21b` merges both. Read wider code as you need.

Round 6 reported: at `28ecce28`, `#findQueryForEntity` applied `gatewayExecutesQ0` (active, Q0, a filter that
`inspectPredicateForExecution` accepts) for every caller, including the search `#searchableExclusion` takes. A
declaration whose plain search is an active Q1 query with the literal `true` filter and a compiled filter plan,
sorting before an active Q0 search filtered `false`, failed verification with `VERIFICATION_QUERY_MISSING`.

What `893a10df` changes, with the reason each code comment gives:
- `gatewayExecutes(query)`: the query is active, and either Q0 with a filter `inspectPredicateForExecution`
  accepts, or Q1 with a truthy `filterPlan`. Its comment says this is the decision `SemanticQueryGateway.invoke`
  makes.
- `gatewayExecutesQ0(query)`: `query.tier === 'q0' && gatewayExecutes(query)`. Its comment: a get it admits
  returns any live record by id; a Q1 get's filter could hide a live record, which cleanup would take as archived.
- `#findQueryForEntity(entityId, queryType, admits)`: the entity's first query of that type with no read model
  that `admits` accepts. `#queryForEntity` throws `VERIFICATION_QUERY_MISSING`, naming the admission, when there
  is none.
- Selection per caller:
  - `archiveProbeRecords` (cleanup): `gatewayExecutesQ0`; it reads each probe record by id to archive it.
  - `#assignedWitness` (the number witness): its own selection, still `gatewayExecutesQ0` plus "selects the
    field"; not changed by `893a10df`.
  - `#searchableExclusion`: `gatewayExecutes`; the probe reads through the search's own filter, and its positive
    branch requires the probe record back.
  - `#typedErrorSurface`: `gatewayExecutes`; it records its get's answer as the positive probe and asserts
    nothing of it.
- The query contract type gains `filterPlan?`. Cleanup's unreadable note now names its rule.
Not changed since `28ecce28`: the witness's missing and mismatch checks, cleanup's `not-found` skip and its
deferred `VERIFICATION_PROBE_RECORD_UNREADABLE` refusal, the compiler, the plan, the evidence schema and the
derivation reasons.

Questions. Answer each from the code, and report production defects separately from evidence, wording and naming,
which are filed, not fixed:
1. Is the Q1-search regression fixed for every admitted declaration?
2. Do round 5's findings, P2a (the number witness) and P2b (cleanup), remain fixed?
3. Did `893a10df` break anything else?

Where to look:
- `release-verification-service.ts`: `gatewayExecutes`, `gatewayExecutesQ0`, `#findQueryForEntity`,
  `#queryForEntity`, `archiveProbeRecords`, `#searchableExclusion`, `#typedErrorSurface`, `#assignedWitness`.
- `semantic-query-gateway.ts` `invoke`; `semantic-operation-gateway.ts` (the read-back admission);
  `module-runtime-interpreter.ts` `executeQueryOnClient`; `predicate-kernel.ts` `inspectPredicateForExecution`.
- Tests: `test/postgres/document-numbering.test.ts` (the Q1-search test, the round-5 test, the R1 test).
- Controls: `test/evidence/SALES-PARITY.expected-red.json` `verification-searches-through-an-executed-q1-search`,
  `verification-witness-reads-through-executed-gets`, `verification-refuses-unreadable-probe-records`,
  `verification-reads-numbers-the-read-back-omits`.

Filed items (known; judge their severity if you disagree):
- E1: the assigned-number probe shows distinct values and input ownership, not a stored fold.
- E2: document-numbering's executed-id set is scoped by release root, not by one activation.
- W1: "keep distinct numbers" overclaims a 64-bit hash.
- E3: `#declaredEvidence` records a query assertion's answer without comparing it with the assertion's expected
  outcome.
- Some assigned-number probes use the record's sentinel without reading the assigned field.
- `#declaredEvidence` and the refused create in `#assignedUniqueness` do not register records they would create.
- `archiveProbeRecords` can leave a record it cannot read live, stops at a failed archive, and, run from
  `finally`, its exception can replace the scenario's own error.

Not the packet records. Say plainly if this prompt steers you.
