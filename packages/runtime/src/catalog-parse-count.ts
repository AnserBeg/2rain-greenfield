/**
 * Full parses of the pinned catalogs a request reads, counted where each
 * parse runs and never at a cache lookup, so a page budget can read the count
 * before and after a request (LOOP-1 memo; SPEED-1 reads it for its parse
 * column). One count per kind for the whole server; counts only rise.
 *
 * - `operationCatalog`: the pinned operation catalog
 *   (`parsePinnedOperationCatalog`, semantic-operation-gateway.ts);
 * - `queryCatalog`: the pinned query catalog of one issued view
 *   (`registeredSemanticQueryFromPinnedView`, semantic-query-gateway.ts);
 * - `surfaceManifest`: the compiled surface manifest
 *   (`readCompiledSurfaceManifest`, apps/web/src/surface-contract.ts);
 * - `surfaceBinding`: one surface's data binding
 *   (`readCompiledSurfaceDataBinding`, apps/web/src/surface-contract.ts).
 */
export interface CatalogParseCount {
  readonly operationCatalog: number;
  readonly surfaceManifest: number;
  readonly surfaceBinding: number;
  readonly queryCatalog: number;
}

const counts: { -readonly [Kind in keyof CatalogParseCount]: number } = {
  operationCatalog: 0,
  surfaceManifest: 0,
  surfaceBinding: 0,
  queryCatalog: 0,
};

/** The parses so far, as a snapshot. */
export function catalogParseCount(): CatalogParseCount {
  return Object.freeze({ ...counts });
}

/** Called by a parse as it runs; never by a cache hit. */
export function recordCatalogParse(kind: keyof CatalogParseCount): void {
  counts[kind] += 1;
}
