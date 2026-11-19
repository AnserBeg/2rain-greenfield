# ADR-0077: Exact-decimal calculated display fields

Status: Implementation draft for CUSTOMIZE-3. ADR-0074 governs Formula Rule family admission.

## §5.11 contract

A calculated display field owns a stable field ID, label, record type, exact decimal expression and declared display sinks. The server evaluates the bound expression against the same scoped read row as the rest of the record. A display field does not appear in storage mappings, defaults or mutation contracts. It cannot feed a posting, valuation, reservation or tax, or a second calculated field in this slice.

A decimal operand carries precision, scale and any declared currency or unit. Addition and subtraction require the same currency and unit. The result scale is the greater operand scale, with one carry digit beyond the greater integer-digit capacity. Multiplication adds the operand precisions and scales. It accepts two neutral factors or one currency and one unpriced factor. Currency-squared results and mixed currencies refuse. The result is exact at every step. This display profile permits up to 76 digits and scale 36, the exact product of two stored precision-38, scale-18 operands. Propagation beyond either bound refuses at compile time. A missing source value yields absence and a malformed value gives a typed read refusal.

## Binding and evidence

- Admit a separate optional v6 `addCalculatedDisplayField` declaration. A declaring release projects the expression, typed dependencies, authorization and classification, admitted read sinks, result shape, exact evaluator version and assertion reference. Its mandatory query consumer raises an existing reader floor.
- A record or list query may compute only a field elected for that sink and only through readable source operands. The record page, optional list column, CSV and assistant get the same server result. An ordinary create or update never writes the result. The product provides no filter or sort over the result in this slice.
- Approval identifies the operands, operation, result type and display sinks. Upgrade replay checks both the result's targets and the operand types, including currencies, at the authoritative destination. Rollback restores the prior display shape.
- A calculated display uses its own draft and approval. A calculated member in a grouped draft gives a typed capability gap.
- Prove v6 compile accept/refuse, the old serving reader's refusal, the typed result in PostgreSQL and the real UI, assistant visibility and rollback. Re-derive the conformance ledger and keep omitted declarations byte-identical.
