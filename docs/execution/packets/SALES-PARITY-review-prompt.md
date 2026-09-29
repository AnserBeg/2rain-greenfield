# SALES-PARITY — review round 3 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `40ca820a`.
Review the fix range `7f3c31f1..40ca820a` (`427d4a50` numbering; `40ca820a` a test case, evidence only). Read wider code as you need.

Round 2 (at `7f3c31f1`) found no regression and reported two older production defects in document
numbering:
1. A numbered field could be as narrow as its format (`X-1`, 3 characters), leaving release
   verification's truncated `V-<hex>` sentinels 16 possible values, so arranged records collided.
2. The maximum scan matched the raw value case-insensitively, while the unique business key compares
   by full Unicode case fold, so a stored value the key equates with the next number (`ß-000001` under
   prefix `SS`) was missed and every create chose the colliding number.

Question: are these two closed on every admitted declaration and stored value, and did the fix
introduce a new production defect? Try to break the fixes; do not assume they are sufficient.
Report production defects separately from evidence, wording and naming, which are filed, not fixed.

Where to look:
- `packages/canonical-model/src/field-numbering.ts` (`VERIFICATION_SENTINEL_MINIMUM_LENGTH`,
  `validateFieldNumbering`) and `FieldNumberingSchema` in `packages/canonical-model/src/schemas.ts`.
- `packages/postgres-provider/src/module-runtime-interpreter.ts` (`assignDocumentNumbers`), the fold
  function it calls (`nsm_unicode_case_fold_v1`, installed by `module-storage-materializer.ts`) and the
  business key's index definition.
- Tests: `test/unit/canonical-model/field-numbering.test.ts`, `test/postgres/document-numbering.test.ts`.
- Controls: `test/evidence/SALES-PARITY.expected-red.json` (`numbering-*` entries).

Consider at least: whether the folded scan and the business key can still disagree (fold function,
collation, the key's scope and archive predicate, the prefix fold); whether 64 bits is enough for how
many sentinels one verification keeps live in one key scope; the scan's cost on a large table; and
declarations that pass validation yet cannot be honoured at runtime.

Not the packet records. Say plainly if this prompt steers you.
