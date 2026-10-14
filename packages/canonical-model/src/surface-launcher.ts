import type {
  SurfaceLauncher,
  VersionedNormalizedApplicationPackage,
} from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/**
 * A declared launcher (canonical `surface.launcher`) is cross-reference
 * checked: each tile opens a declared List, at a view that List declares, and
 * each scan target resolves an exact identifier of one entity and opens a
 * record page of that same entity. The runtime only ever turns a launcher into
 * links and declared query arguments it re-authorizes, so anything it could
 * not honour is refused here, by name, rather than skipped later.
 */
export function validateSurfaceLaunchers(
  model: VersionedNormalizedApplicationPackage,
): void {
  const surfaces = new Map(
    model.surfaces.map((surface) => [String(surface.surfaceId), surface]),
  );
  const queries = new Map(
    model.queries.map((query) => [String(query.queryId), query]),
  );
  const fail = (id: string, reason: string): never => {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_SCHEMA_INVALID',
        '$.surfaces.launcher',
        reason,
        'declare tiles over declared List views and scan targets over resolve queries and the record pages of their entity',
        id,
      ),
    ]);
  };
  const unique = (values: readonly string[], id: string, what: string) => {
    if (new Set(values).size !== values.length)
      fail(id, `launcher ${what} must be unique`);
  };
  for (const surface of model.surfaces) {
    if (!('launcher' in surface) || !surface.launcher) continue;
    const launcher: SurfaceLauncher = surface.launcher;
    const id = String(surface.surfaceId);
    if (surface.archetype !== 'task' || surface.surfaceRole !== undefined)
      fail(id, 'a launcher belongs to a Task surface');

    unique(
      launcher.tiles.map((tile) => tile.tileId),
      id,
      'tile ids',
    );
    for (const tile of launcher.tiles) {
      const target = surfaces.get(tile.surface);
      const list =
        target && 'list' in target && target.list ? target.list : undefined;
      if (
        !target ||
        target.lifecycle !== 'active' ||
        target.surfaceRole !== 'list' ||
        !list
      )
        fail(tile.tileId, 'a launcher tile opens an active declared List');
      if (
        tile.view !== undefined &&
        !list!.views.some((view) => view.viewId === tile.view)
      )
        fail(tile.tileId, "a launcher tile's view is one its List declares");
    }

    if (!launcher.scan) continue;
    const entities: string[] = [];
    for (const target of launcher.scan.targets) {
      const resolve = queries.get(target.query);
      if (
        !resolve ||
        resolve.lifecycle !== 'active' ||
        resolve.queryType !== 'resolve' ||
        !(resolve.resolveMatchKeys ?? []).some(
          (key) => key.authority === 'identifier',
        )
      )
        fail(
          target.query,
          'a scan target resolves an exact identifier through an active resolve query',
        );
      const entityId = String(resolve!.sourceEntity.targetId);
      const page = surfaces.get(target.surface);
      const read = page ? queries.get(String(page.dataSource.targetId)) : null;
      if (
        !page ||
        page.lifecycle !== 'active' ||
        page.surfaceRole !== 'record' ||
        !read ||
        String(read.sourceEntity.targetId) !== entityId
      )
        fail(
          target.surface,
          'a scan target opens a record page of the entity it resolves',
        );
      entities.push(entityId);
    }
    unique(entities, id, 'scan targets (one per entity)');
  }
}
