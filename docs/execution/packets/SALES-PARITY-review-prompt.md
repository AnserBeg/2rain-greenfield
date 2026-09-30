# SALES-PARITY — review round 5 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `bf24b925`.
Review the fix `6317a1a4` (control `d5f11b84`), merged at `bf24b925`. Since round 4's `b829d633` the only
Critical-set change is `packages/postgres-provider/src/release-verification-service.ts` in `6317a1a4`.
Read wider code as you need.

Round 4 found one production defect, R1: `SemanticVerificationExecutor.#create` required every assigned
field (a server-assigned document number) to appear in the create operation's read-back DTO and threw
`VERIFICATION_ASSIGNED_VALUE_MISSING` otherwise, although a read-back is a declared projection that need
not select the number; and it registered the created record for cleanup only after that check, so the
failure left a live probe record.

The fix, provider-only: `#create` validates its system input before the create, registers the record for
cleanup immediately after the create succeeds, then obtains each assigned value through `#assignedWitness`:
from the read-back when it selects the field; otherwise from an active plain (not read-model) q0 get of the
entity that selects it, under the scope handling other gets use; otherwise the deterministic sentinel
(`verificationSentinelNumber`, now shared with `assignDocumentNumbers` in `module-runtime-interpreter.ts`)
is used unread. A value that was read must equal the sentinel: `VERIFICATION_ASSIGNED_VALUE_MISSING` for an
empty or non-string value, `VERIFICATION_ASSIGNED_VALUE_MISMATCH` otherwise. The compiler, the plan, the
evidence schema and the derivation reasons are unchanged.

Question: is R1 closed for every admitted declaration, and did the fix introduce a new production defect?
Try to break it. Report production defects separately from evidence, wording and naming, which are filed,
not fixed.

Where to look:
- `release-verification-service.ts`: `#create`, `#assignedWitness`, `archiveProbeRecords`, and the probes
  that consume assigned values (`#searchableExclusion`, `#uniquenessFold`, `#assignedUniqueness`, resolve).
- `module-runtime-interpreter.ts`: `verificationSentinelNumber`, `assignDocumentNumbers`, `toDto`.
- Tests: `test/postgres/document-numbering.test.ts` (the read-back-omission test: a number selected by the
  read-back, by a second get only, and by no get; a real-numbering run refused as a mismatch).
- Control: `test/evidence/SALES-PARITY.expected-red.json` `verification-reads-numbers-the-read-back-omits`.

Consider at least: whether registering before the witness step can archive a record twice or archive one
another scenario still needs; whether any verification create runs outside sentinel mode on a production
path (so an unread sentinel would be wrong); whether a get chosen as witness can return a different record
or none under some scope; and whether an unread sentinel lets a probe pass without testing anything.

Already filed (judge severity if you disagree, but they are known): E1 the assigned-number probe shows
distinct values and input ownership, not a stored fold; E2 document-numbering's executed-id set is scoped
by release root, not by one activation; W1 "keep distinct numbers" overclaims a 64-bit hash; latent,
unreached by any admitted declaration: `#declaredEvidence` and the refused create in `#assignedUniqueness`
do not register records they would create, and `archiveProbeRecords` stops at its first failed archive.

Not the packet records. Say plainly if this prompt steers you.
