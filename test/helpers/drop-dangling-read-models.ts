/**
 * For a composed application with a module taken out (a test fixture): a
 * read-model query that reads a query no longer present goes with it -- the
 * customer's credit reads Sales' invoices and orders (SALES-EXTRAS) -- and a
 * page that read its record through one reads its plain get instead, without
 * the figures only that read model stated.
 */
export function dropDanglingReadModels(
  definition: Record<string, unknown>,
): Record<string, unknown> {
  const reference = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null;
    const targetId = (value as Record<string, unknown>).targetId;
    return typeof targetId === 'string' ? targetId : null;
  };
  const queries = definition.queries as Array<Record<string, unknown>>;
  const present = new Set(queries.map((query) => String(query.queryId)));
  const plainGet = new Map<string, string>();
  definition.queries = queries.filter((query) => {
    const readModel = query.readModel as
      { queries?: Record<string, { targetId: string }> } | undefined;
    if (
      Object.values(readModel?.queries ?? {}).every((dependency) =>
        present.has(dependency.targetId),
      )
    )
      return true;
    const plain = queries.find(
      (candidate) =>
        candidate.queryType === 'get' &&
        !candidate.readModel &&
        reference(candidate.sourceEntity) === reference(query.sourceEntity),
    );
    if (plain) plainGet.set(String(query.queryId), String(plain.queryId));
    return false;
  });
  for (const surface of definition.surfaces as Array<Record<string, unknown>>) {
    const source = reference(surface.dataSource);
    const plain = source ? plainGet.get(source) : undefined;
    if (!plain) continue;
    surface.dataSource = {
      ...(surface.dataSource as Record<string, unknown>),
      targetId: plain,
    };
    const composition = surface.composition as
      | {
          fields: Array<{ columnId: string; field: string }>;
          presentation?: {
            header: { facts: string[] };
            blocks?: Array<{ columns: string[] }>;
          };
        }
      | undefined;
    if (!composition) continue;
    composition.fields = composition.fields.filter(
      (column) => !column.field.includes(':metric.'),
    );
    const kept = new Set(composition.fields.map((column) => column.columnId));
    const presentation = composition.presentation;
    if (!presentation) continue;
    presentation.header.facts = presentation.header.facts.filter((id) =>
      kept.has(id),
    );
    if (presentation.blocks)
      presentation.blocks = presentation.blocks
        .map((block) => ({
          ...block,
          columns: block.columns.filter((id) => kept.has(id)),
        }))
        .filter((block) => block.columns.length > 0);
  }
  return definition;
}
