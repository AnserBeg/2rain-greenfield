# SALES-PARITY — review round 8 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `7d254902`.

Commits since round 7's frozen `0e30b6b1`:
- `64493a52` changes `packages/postgres-provider/src/release-verification-service.ts`, the only Critical-set
  path changed.
- `7c82ea9b` changes `test/postgres/document-numbering.test.ts` and `test/evidence/SALES-PARITY.expected-red.json`.
- `7d254902` merges both into `packet/SALES-PARITY`.

Round 7's finding, as reported: `#searchableExclusion` took the entity's first plain search admitted by
`gatewayExecutes`. With `northstar.party:query.party_search` (active, plain, Q1, filter literal `false`, with a
compiled filter plan) sorting before `northstar.party:query.party_z_search` (active, plain, Q0, filter literal
`true`), release verification failed with `VERIFICATION_SEARCH_POSITIVE_FAILED`. The reviewer reported the same
mechanism for satisfiable Q1 filters that the generically arranged record does not meet.

Functions changed in `64493a52`: `#searchableExclusion` (changed) and `#searchWitness` (new). Not changed in it:
`gatewayExecutes`, `returnsAnyLiveRecordById`, `#findQueryForEntity`, `#queryForEntity`, `archiveProbeRecords`,
`#assignedWitness`, `#typedErrorSurface`.

Questions. Answer each from the code, and report production defects separately from evidence, wording and naming,
which are filed, not fixed:
1. Is round 7's finding fixed for every admitted declaration?
2. For each of the four callers that select a query (`archiveProbeRecords`, `#assignedWitness`,
   `#searchableExclusion` with `#searchWitness`, `#typedErrorSurface`), does any admitted declaration make its
   selection pick an unsuitable query or miss a suitable one? Consider lifecycle, tier, filter (literal or
   predicate), read model, selections and catalog order.
3. Do round 5's findings (P2a, P2b) and round 6's finding remain fixed?
4. Did `64493a52` break anything else?

Where to look:
- `release-verification-service.ts`: the functions above.
- `semantic-query-gateway.ts` `invoke`; `semantic-operation-gateway.ts` (read-back admission);
  `module-runtime-interpreter.ts` `executeQueryOnClient`; `predicate-kernel.ts` `inspectPredicateForExecution`;
  `normalize.ts` (query filter and parameter rules).
- Tests: `test/postgres/document-numbering.test.ts`.
- Controls: `test/evidence/SALES-PARITY.expected-red.json`, entries whose `file` is
  `release-verification-service.ts`.

Filed items, already known:
- E1: the assigned-number probe shows distinct values and input ownership, not a stored fold; a number that no
  qualifying get selects is taken as its sentinel unread.
- E2: document-numbering's executed-id set is scoped by release root, not by one activation.
- W1: "keep distinct numbers" overclaims a 64-bit hash.
- E3: `#declaredEvidence` records a query assertion's answer without comparing it with the assertion's expected
  outcome.
- `#declaredEvidence` and the refused create in `#assignedUniqueness` do not register records they would create.
- `archiveProbeRecords` can leave a record it cannot read live, stops at a failed archive, and, run from
  `finally`, its exception can replace the scenario's own error.
- `#typedErrorSurface` can select an executable restrictive Q1 get and record its empty `not-found` as its
  positive probe.

Not the packet records. Say plainly if this prompt steers you.
