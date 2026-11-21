/**
 * Query-catalog reader rung for a catalog that declares any read-model
 * dependency `required: false`. A reader below it parses read models strictly,
 * so it must refuse such a catalog by name before decoding it (ADR-0085).
 * Rungs on this capability: 2 read models, 3 list sums, 4 calculated displays,
 * 5 booking owner usage, 6 optional read-model dependencies. Allocate from origin/main at integration.
 */
export const OPTIONAL_DEPENDENCY_QUERY_READER = 6;

/**
 * Whether any query in a normalized definition or a query-catalog payload
 * declares a read-model dependency `required: false`. Reads raw JSON so a
 * reader can decide the floor before it trusts the payload's shape.
 */
export function declaresOptionalReadModelDependency(queries: unknown): boolean {
  if (!Array.isArray(queries)) return false;
  return queries.some((query) => {
    const readModel =
      query && typeof query === 'object'
        ? (query as { readModel?: unknown }).readModel
        : undefined;
    const dependencies =
      readModel && typeof readModel === 'object'
        ? (readModel as { queries?: unknown }).queries
        : undefined;
    return (
      !!dependencies &&
      typeof dependencies === 'object' &&
      Object.values(dependencies).some(
        (dependency) =>
          !!dependency &&
          typeof dependency === 'object' &&
          (dependency as { required?: unknown }).required === false,
      )
    );
  });
}
