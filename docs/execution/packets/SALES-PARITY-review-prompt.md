# SALES-PARITY — review round 9 prompt (ONLINE confirm arm, user-run)
Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `8cf3fda2`, base round 8's
frozen `7d254902`. `fe864f66` and `43b0b473` change `packages/postgres-provider/src/release-verification-service.ts`, the
only Critical-set path changed; `2af96a5a` changes `document-numbering.test.ts`; `2af96a5a` and `43b0b473` change
`SALES-PARITY.expected-red.json`; `8ee86f85` and `8cf3fda2` merge them; `008adff9` merges CI changes, no Critical path.

Round 8's findings, as reported: (1) `#searchWitness` used the first executed plain search with the literal `true`
filter, and one positive field per search, without reading whether it returned the arranged record; a later Q0
literal-true search capped at one result, whose positive field is a searchable enum other records share, returned
another record ahead of an earlier Q1 `not(false)` search that returns it by text: `VERIFICATION_SEARCH_POSITIVE_FAILED`.
(2) `returnsAnyLiveRecordById` admitted only the literal `true`, so an admitted Q1 get filtered `not(false)` was no
reader; with read-back through a Q0 read-model get, cleanup refused `VERIFICATION_PROBE_RECORD_UNREADABLE`.
Changed in `fe864f66` and `43b0b473`, by function:
- `#searchWitness` reads each pair of an executed plain search and a positive field it selects until one returns the
  arranged record: searches for which `restrictsNothing` holds first, then the rest, each in catalog order; within a
  search, text inputs, then assigned numbers, then enums. A pair whose answer lacks the record is passed over;
  `VERIFICATION_SEARCH_WITNESS_UNCONSTRUCTABLE`, naming every pair tried, when none returns it.
- New `constantPredicateValue` (the value of a predicate built only from boolean literals with not/all/any, else
  undefined; at `43b0b473` computed by `inspectPredicateForExecution` with an evaluation request whose comparison
  resolver throws) and `restrictsNothing` (that value is `true`); `returnsAnyLiveRecordById` is now `gatewayExecutes`
  and `restrictsNothing` (it was `gatewayExecutes` and the literal `true`).
- Unchanged: `#searchableExclusion` (it still asserts the positive record), `gatewayExecutes`, `#findQueryForEntity`,
  `#queryForEntity`, `archiveProbeRecords`, `#assignedWitness`, `#typedErrorSurface`.
Claims: cleanup and the witness read through an executed plain get whose filter restricts nothing; the search probe
refuses only when no pair returns the arranged record. Questions. Answer each from the code; report production defects
separately from evidence, wording and naming:
1. Are round 8's two findings fixed for every admitted declaration?
2. For each caller that selects a query (`archiveProbeRecords`, `#assignedWitness`, `#searchableExclusion` with
   `#searchWitness`, `#typedErrorSurface`), is the selection exhaustive over the admitted queries, and for search the
   positive fields, that could serve it? Consider capped results, alternate positive fields, constant predicates,
   lifecycle, tier, read model and catalog order.
3. For each predicate to which `constantPredicateValue` assigns a value, does the gateway's execution agree with it?
4. Do the findings of rounds 5-7 remain fixed? Did `fe864f66` or `43b0b473` break anything else?
Where to look: the functions above; `semantic-query-gateway.ts` `invoke`; `semantic-operation-gateway.ts` (read-back
admission); `module-runtime-interpreter.ts` `executeQueryOnClient`; `predicate-kernel.ts`; `normalize.ts`;
`document-numbering.test.ts`; manifest entries whose `file` is `release-verification-service.ts`. Not the records.
Filed, already known: evidence limits of the assigned-number probe; unregistered creates in `#declaredEvidence` and
`#assignedUniqueness`; cleanup's failure handling; `#declaredEvidence` not comparing an answer with its expected
outcome; `#typedErrorSurface` recording a restrictive Q1 get's `not-found` as its positive probe.
Say plainly if this prompt steers you.
