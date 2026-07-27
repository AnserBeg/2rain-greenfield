export const SAVED_FILTER_ENVELOPE_VERSION =
  'northstar.saved-filter-envelope/v1' as const;
export const SAVED_FILTER_POSITION_PROFILE_VERSION =
  'northstar.predicate-position.saved-filter/v1' as const;

export const SAVED_FILTER_LIMITS = Object.freeze({
  maximumBytes: 4_000,
  maximumCollections: 64,
  maximumDepth: 24,
  maximumNodes: 60,
  maximumTermsPerCollection: 128,
});

export type SavedFilterLifecycle = 'active' | 'revoked';

export interface SavedFilterEnvelope {
  readonly authoredReleaseContentHash: string;
  readonly authoredReleaseId: string;
  readonly criteriaCanonicalJson: string;
  readonly environmentId: string;
  readonly filterId: string;
  readonly languageVersion: string;
  readonly lifecycle: SavedFilterLifecycle;
  readonly name: string;
  readonly normalizationProfileVersion: string;
  readonly ownerPrincipalId: string;
  readonly positionProfileVersion: typeof SAVED_FILTER_POSITION_PROFILE_VERSION;
  readonly queryId: string;
  readonly schemaVersion: typeof SAVED_FILTER_ENVELOPE_VERSION;
  readonly tenantId: string;
}

export interface SavedFilterRegistration {
  readonly entityId: string;
  readonly fieldIds: {
    readonly criteria: string;
    readonly name: string;
    readonly queryId: string;
  };
  readonly operationIds: {
    readonly archive: string;
    readonly create: string;
    readonly restore: string;
    readonly update: string;
  };
  readonly queryIds: {
    readonly get: string;
    readonly list: string;
    readonly resolve: string;
    readonly search: string;
  };
}

export type SavedFilterDiagnosticCode =
  | 'SAVED_FILTER_COLLECTION_LIMIT_EXCEEDED'
  | 'SAVED_FILTER_CRITERIA_BYTES_EXCEEDED'
  | 'SAVED_FILTER_CRITERIA_CORRUPT'
  | 'SAVED_FILTER_CRITERIA_NOT_CANONICAL'
  | 'SAVED_FILTER_DEPTH_LIMIT_EXCEEDED'
  | 'SAVED_FILTER_FIELD_INADMISSIBLE'
  | 'SAVED_FILTER_FIELD_STALE'
  | 'SAVED_FILTER_INPUT_MALFORMED'
  | 'SAVED_FILTER_LIFECYCLE_REVOKED'
  | 'SAVED_FILTER_NODE_LIMIT_EXCEEDED'
  | 'SAVED_FILTER_NODE_VERSION_UNSUPPORTED'
  | 'SAVED_FILTER_NOT_VISIBLE'
  | 'SAVED_FILTER_QUERY_INADMISSIBLE'
  | 'SAVED_FILTER_QUERY_STALE'
  | 'SAVED_FILTER_RELEASE_MISMATCH';

export class SavedFilterContractError extends Error {
  override readonly name = 'SavedFilterContractError';

  constructor(
    readonly code: SavedFilterDiagnosticCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}
