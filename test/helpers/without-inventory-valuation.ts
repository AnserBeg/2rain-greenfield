/** A fixture that removes Inventory must also remove the composed Catalog cost reads. */
export function withoutInventoryValuation(
  application: Record<string, unknown>,
): Record<string, unknown> {
  const queries = application.queries as Record<string, unknown>[];
  const removed = new Set(
    queries
      .filter(
        (query) =>
          (
            query.readModel as
              { capability?: { targetId?: string } } | undefined
          )?.capability?.targetId ===
          'northstar.inventory:capability.valuation',
      )
      .map((query) => String(query.queryId)),
  );
  return {
    ...application,
    queries: queries.filter((query) => !removed.has(String(query.queryId))),
    surfaces: (application.surfaces as Record<string, unknown>[]).flatMap(
      (surface) => {
        if (surface.surfaceId === 'northstar.app:surface.inventory_value_list')
          return [];
        if (surface.surfaceId !== 'northstar.app:surface.item_detail')
          return [surface];
        const { composition: _, workspace, ...plain } = surface;
        const { entry: __, ...membership } = workspace as Record<
          string,
          unknown
        >;
        return [
          {
            ...plain,
            dataSource: {
              kind: 'queryReference',
              schemaVersion: 'v6',
              targetId: 'northstar.app:query.item_get',
            },
            workspace: membership,
            slots: (surface.slots as Record<string, unknown>[]).filter(
              (slot) => slot.slot !== 'childTables',
            ),
          },
        ];
      },
    ),
  };
}
