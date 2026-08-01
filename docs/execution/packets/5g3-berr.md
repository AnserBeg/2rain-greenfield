# 5g3-berr — Typed provider errors

Lane: FIX · Tier: Behavioral · Branch: `packet/berr` · Initial base: `718b668`

Status: implementation, required packet gates, Behavioral review, and full
matrix complete; evidence ready for the user checkpoint.

## Outcome

The generic PostgreSQL module interpreter now accepts an immutable list of
module-owned provider-error mappings. A mapping selects one exact PostgreSQL
SQLSTATE and provider message, then returns the stable typed error code, message,
subject, and explicitly admitted detail fields. Product assembly supplies the
registrations to both release verification and the serving interpreter. The
interpreter contains no module identity, branch, or domain term.

Inventory declares its mapping in
`packages/postgres-provider/src/inventory-provider-error-mappings.ts`. It reuses
the existing `translateInventoryPostingError` implementation for PostgreSQL
`P0001` / `INVENTORY_BASE_UNIT_IMMUTABLE`; the posting service itself is unchanged.
The composed application root registers that declaration rather than teaching the
generic interpreter about Inventory.

This is dependency injection at a provider boundary, not a canonical or persisted
contract. It changes no canonical bytes, compiler output, SQL, migration, privilege,
budget, or generic Q0/O0 dispatch rule, so it does not require an ADR-scale design
event beyond current-plan ruling `5g3-berr`.

## Safe unregistered failure boundary

An error that matches no registration still becomes `MODULE_PROVIDER_FAILURE`.
The interpreter constructs a fresh `providerMetadata` object containing only:

- `sqlstate`, from PostgreSQL `code`;
- `relationName`, from PostgreSQL `table`;
- `constraintName`, from PostgreSQL `constraint`; and
- `columnName`, from PostgreSQL `column`.

The sanitized error message renders only those four fields so an unhandled test
failure is diagnosable. It never copies the provider message, `DETAIL`, query text,
row values, parameter values, or the raw error as `cause`.

## Controls and non-vacuity

| Control | Observation |
|---|---|
| A — real Catalog update | After a real adjustment posts the first movement, the semantic Operation gateway invokes `northstar.app:operation.item_update` with the current revision and a base-unit patch. It returns `INVENTORY_BASE_UNIT_IMMUTABLE` with the exact item, binding movement, binding unit, and requested unit. |
| A — before-fix red | With the same control and no registration supplied, the real operation returned `MODULE_PROVIDER_FAILURE`; the expected typed code assertion failed. After registration it passes. |
| B — second module | A synthetic Party declaration registers a second mapping for the same `P0001` SQLSTATE but a different provider message. With Inventory's mapping present in the same list, the Party mapping returns its own typed code and detail. |
| C — unregistered refusal | An unregistered `P7701` remains `MODULE_PROVIDER_FAILURE`; it is not coerced into either registered typed error. |
| D — exact cause metadata | The `P7701` control asserts the exact SQLSTATE, relation, constraint, and column in both the structured error and sanitized message. |
| E — no business-data escape | The raw provider error contains customer-row and parameter sentinels in its message, `DETAIL`, query, and parameters. Neither the error object, JSON rendering, nor Node's `%o` log rendering contains either sentinel, the row-field name, or query text. |

The end-to-end control lives in `test/postgres/inventory-posting.test.ts`, beside
the pre-existing translator-only control, so the two observations cannot be
confused. Generic registration, fallback, metadata, and leak controls live in
`test/unit/module-provider-error-mappings.test.ts`; that new file is registered in
the root `test:unit` command, repository-hygiene inventory, and reachability
producer inventory.

## Evidence

- Focused pre-fix control: **RED**, actual `MODULE_PROVIDER_FAILURE`, expected
  `INVENTORY_BASE_UNIT_IMMUTABLE`.
- Focused post-fix end-to-end control: **PASS**.
- Focused generic controls: **2/2 PASS**.
- `corepack pnpm typecheck`: **PASS**.
- `corepack pnpm test:unit`: **54/54 PASS**.
- `corepack pnpm test:architecture`: **101/101 PASS**, with only the three
  pre-existing routed module-press findings.
- `corepack pnpm test:postgres`: **133/133 PASS**.
- `corepack pnpm lint`: **PASS**.
- `corepack pnpm format`: **PASS**.
- Fresh Codex Behavioral review of frozen SHA
  `4b420c3f76c3e44f22f0cf652a5f558655eb19f7`: **VERDICT: PASS**, no in-scope
  material findings. Result:
  `~/2rain-missions/5g3-berr-codex-review-4b420c3.last-message.txt`.
- The shared machine was confirmed free of another matrix before measurement;
  this lane ran no other gate, review, or authoring process during its matrix.
- Full matrix on the executable-identical docs descendant:
  `FULL_MATRIX_PASS_SHA=a708f49ae7d788b843b9b5a67af0bbc6e5be509b`.
