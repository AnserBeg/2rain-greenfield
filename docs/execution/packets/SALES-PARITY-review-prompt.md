# SALES-PARITY — review round 2 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `7f3c31f1`.
Review the fix range `974ae755..7f3c31f1`: `53ca49f4` (numbering), `4e2e018a` (an order-only move inside
`apps/web/release/current-policy-bindings.json`) and `7f3c31f1` (a control's text, evidence only).
Read wider code as you need.

Round 1 (at `974ae755`) reported three production defects in document numbering:
1. A sequence could use prefix `V`; with a narrow field, release verification's truncated `V-<hex>`
   sentinel could be all digits (`V-770098`), matching the sequence's scan and colliding with its values.
2. The maximum scan matched at most 18 digits, so `SO-0000000000000000042` was ignored and the
   allocator's own `SO-1000000000000000000` was unreadable on the next create.
3. Validation sized the field by the minimum digits only, so a wider `start` admitted a first number
   that could not be stored.

Question: are these three closed on every admitted declaration and stored value, and did the fix
introduce a new production defect? Try to break the fixes; do not assume they are sufficient.
Report production defects separately from evidence, wording and naming, which are filed, not fixed.

Where to look:
- `packages/canonical-model/src/field-numbering.ts` (`VERIFICATION_SENTINEL_PREFIX`, `validateFieldNumbering`)
  and `FieldNumberingSchema` in `packages/canonical-model/src/schemas.ts`.
- `packages/postgres-provider/src/module-runtime-interpreter.ts` (`assignDocumentNumbers`: the sentinel,
  the scan, the `MODULE_DOCUMENT_SEQUENCE_EXHAUSTED` refusal) and where it is called.
- Tests: `test/unit/canonical-model/field-numbering.test.ts`, `test/postgres/document-numbering.test.ts`.
- Controls: `test/evidence/SALES-PARITY.expected-red.json` (`numbering-*` entries).

Consider at least: every other way a sentinel or any other generated value could satisfy a sequence's
scan; case, width and character-count semantics of the scan, the cast and the length check against the
compiled column; whether a refusal can leave a partial write or a consumed number; declarations that
pass validation yet cannot be honoured at runtime; and whether moving bindings can change what any
release compiles or authorizes.

Not the packet records. Say plainly if this prompt steers you.
