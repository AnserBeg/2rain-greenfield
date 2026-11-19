# ADR-0075: Literal validation and the Formula Rule validation profile

Status: Implementation draft for CUSTOMIZE-3. ADR-0074 governs admission.

## §5.11 contract

The language owns ordered comparison and presence. These constructs serve unrelated ordinary modules and bind to operations with compiler-resolved inputs. The first supported position is validation on declared plain create and update operations. Use the optional v6 Formula Rule registration in ADR-0074 and a versioned node and position profile. ADR-0021 continues to govern the existing inline PredicateExpression profile.

| Construct | Version 1 contract |
| --- | --- |
| Presence | `required` accepts a tagged present field value. Empty text, zero, and false are present values. Optional omitted values and their canonical storage absence resolve to the absence tag. A malformed or unreadable value refuses. |
| Ordering | `greaterThanOrEqual` and `lessThanOrEqual` compare both ordered values and equality directly. The first operands are a field and a typed literal with the same canonical type. Integer and decimal ordering is exact, with no binary float conversion. Decimal types carry precision, scale and currency where applicable. |
| Text length | The scalar length of a text value counts Unicode code points in the normalized stored text. The comparison takes a nonnegative integer literal. The absence tag propagates through the length operand. |
| Date | Date operands are calendar dates. A business date comes from one captured operation time resolved in the tenant’s declared business calendar, including its time zone and day boundary. The verifier supplies a pinned synthesized business date. A missing calendar gives a typed refusal. |
| Composition | The versioned profile implements the truth table in ADR-0074. An absent comparison yields unknown, and validation accepts true or unknown. A required test yields true or false from the presence tag. Evaluation checks every child and preserves malformed or unreadable operands as typed refusals. |

The first authoring slice admits literal bounds, presence, text-length bounds, and business-date bounds. Ordered comparisons can later admit field and path operands under their own typed and bounded contracts. The versioned AST reserves the discriminated operand tags `literal`, `field`, and `path`. Compilation refuses operand positions that lack a runtime contract. It resolves scalar types and applies the depth limit of 24.

## Bindings and evidence

- Each binding owns stable rule and target IDs, explicit create/update operation IDs, trigger, absence policy, refusal effect, existing-records policy, message and field anchors. The compiler derives watched fields, authorization closure, explanation and witnesses from the binding.
- Refusal can reveal information about a watched field. This position admits public and internal scalar fields. Confidential and restricted operands require a field visibility contract for both the operation and its explanation.
- Create checks the proposed values after defaults. Update compares typed proposed values with the locked current row and checks the rule when a watched value changes. Activate grandfathers stored rows. An authorized recovery records a report-only outcome.
- The compiler proves that its synthesized satisfying invocation passes all applicable constraints. For each rule it also proves that its violating invocation satisfies the base input contract and the other rules. Its update witnesses change a watched value. It pins the operation, fixture state, input, date, expected refusal code and message. The verifier passes through the witnesses and observes refusal before mutation.
- The same release-pinned rules drive the handled refusal and its field anchors in the form and the agent's rule discovery. Storage keeps the usual record values and no rule output. The approval, upgrade and rollback gates remain release-based.
- Prove omitted declarations reproduce a first-party and real tenant-runner release envelope byte for byte. Add a v6 positive fixture, explicit compiler refusals and re-derived coverage. Prove an actual prior reader rejects a declaring release at its existing operation-catalog gate. Exercise bound create and update, the refusal message, assistant handoff and rollback in the composed package.
