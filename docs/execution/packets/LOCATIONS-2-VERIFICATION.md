# LOCATIONS-2-VERIFICATION — operation-aware release verification

Status: prerequisite proposed; Critical; implementation belongs to a separate owner-run packet.
Blocked consumer: LOCATIONS-2 status gateway. No Critical source is changed by LOCATIONS-2.

## Concrete dependency

LOCATIONS-2 narrows generic location create/update to code, name and type. Only
`location_update_status` writes inventory status, its required nonblank reason
and changed-at. Compiler `verificationPlanPayload` still plans `enumReject`
for `location_status`. `release-verification-service.ts` `#enumReject` calls
`#invokeEffect(entity, 'updateRecordEffect', ...)`, whose first operation is
`location_update`. The probe therefore receives `MODULE_FIELD_UNSUPPORTED`
before observing enum admission/refusal. Search exclusion arrangement also
must arrange a nonwritable field through its declared operation.

Removing the status probe, changing its expected error, allowing status on
generic writes, or passing a fabricated verification-only bypass would weaken
the claim. The required repair is inside the Critical verifier.

## Bounded charter and claims

1. A field probe selects a pinned active record operation that declares the field writable; it supplies the operation's other required inputs before observing the claimed field admission/refusal. No operation writes a field outside its contract.
2. Search exclusion arranges its sentinel through a pinned writable operation when create does not accept that field; the stored sentinel is observed before the exclusion is measured. No probe is dropped or repaired by the reader.
3. The verifier still executes every planned scenario exactly once and archives every arranged row; missing writer authority is a named refusal, never a skipped or green probe.

Owned Critical path: `packages/postgres-provider/src/release-verification-service.ts`.
Supporting compiler/contracts/tests may change only as needed to supply explicit writer metadata.
Kernel, stock serializer, activation, trust, migrations and grants stay outside the prerequisite.

## Expected-red controls to implement in that packet

- Claim 1: replace writer selection with the old first-update selection; the location-status enum probe must fail alone with `MODULE_FIELD_UNSUPPORTED`, then restore green.
- Claim 2: omit the dedicated status-reason sentinel update; the search-exclusion probe must fail alone because the stored sentinel is absent, then restore green.
- Claim 3: suppress one planned non-create-writable field scenario; the executed-versus-planned reconciliation must fail alone, then restore green.

One manifest entry per claim in `test/evidence/LOCATIONS-2-VERIFICATION.expected-red.json`.
Commit before controls; restore only confirmed mutations. CI `run-controls` supplies the recorded reds.
Gates: exact-head full CI, PostgreSQL verification probes, executed-file evidence, check-records.

## OWNER review prompt (run after the prerequisite has a frozen SHA)

Repository: AnserBeg/2rain-greenfield; branch packet/LOCATIONS-2-VERIFICATION.
Frozen SHA: replace with the prerequisite's executable tip before running.
Read docs/architecture/posting-kernel-guarantees.md, then the diff to
packages/postgres-provider/src/release-verification-service.ts.
Claims: (1) field probes choose declared writers and satisfy other required inputs;
(2) exclusion probes observe stored sentinels before measuring search;
(3) every planned scenario executes once and every arranged row is cleaned up.
Is there a production defect under these claims? Say plainly if this prompt steers you.
