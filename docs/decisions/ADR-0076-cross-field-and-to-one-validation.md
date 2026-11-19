# ADR-0076: Same-record comparisons and bounded to-one validation

Status: Accepted for CUSTOMIZE-3. ADR-0074 and ADR-0075 govern admission and the validation position.

## §5.11 contract

F2 compares two declared scalar fields on the proposed record. Resolve both field types during compilation. The operands must share a canonical type, currency and unit. Precision and scale may differ because exact ordered comparison aligns decimal coefficients without rounding. Validate the merged row after default application for creates or under the existing update lock. The write set watches both fields.

F4 also admits a single declared to-one relation as a bound right operand. Resolve the relation, its source key, target entity and terminal field at compile time. The first validation position can observe only a declared relation with a writable source key and a stored target scalar. The runtime reads the scoped target through the bound relation in the same write transaction and holds a share lock on the target row. No key produces the absence tag. An unreadable, invisible, archived or malformed referenced row gives a typed refusal. Cross-tenant values cannot enter the row. Independent writes to a related record do not invoke the source guard. The watched set includes the source key and same-record operands. A typed no-op key submission does not trigger validation.

The terminal field must be selected by an active, unfiltered Q0 get with no additional legal-entity operand. The source operation and the related read must both be authorized at the current policy version. The target is still scoped by its storage policy, and the terminal classification must permit disclosure through the refusal. Location's declared parent link supplies the first composed journey.

Both primitives retain the v1 validation meaning of absence, malformed operands and three-valued composition. Paths use the existing versioned operand and the depth ceiling of 24. A longer path, to-many traversal, or unsupported position refuses at compilation. These positions bind to ordinary O0 create and update and supply neither stored values nor an entry point into posting.

## Binding, verification and replay

- Carry resolved typed field and relation references, the watching rule, and classification and authorization closure in the dedicated Formula Rule projection. The mandatory operation catalog floor is advanced before the new operands can run. Keep existing literal release bytes and operation floors.
- Emit one satisfying synthesized invocation and an independently violating invocation per rule. Include both current and proposed watched values for updates and the related fixture for a path. Reproduce the fixture through governed operations in release verification, anchor the result to the planned input and exact refusal, and begin from a pinned business date.
- Refuse replays that retire or change the type or scope of either field, the relation or the bound operation. Retain the still-serving source when replay refuses.
- Exercise compiled admission and refusal at v6. Run the actual previous serving reader against a feature release. Exercise the rule on a real form, through the governed operation and in assistant discovery. Roll back to the previously active rules.
