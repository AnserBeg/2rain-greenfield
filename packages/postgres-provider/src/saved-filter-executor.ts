import { randomUUID } from 'node:crypto';

import {
  CanonicalModelError,
  NormalizedApplicationPackageSchema,
  PredicateExpressionSchema,
  canonicalAuthoredProjection,
  canonicalize,
  normalizeApplicationPackage,
  type NormalizedApplicationPackage,
  type PredicateExpression,
} from '@north-star/canonical-model';
import type { Pool, PoolClient } from 'pg';

import {
  POLICY_DECISION_EVIDENCE_VERSION,
  type AcceptedMutationCommand,
  type EvidenceMetadataInput,
} from '../../platform-runtime/src/trust/contracts.js';
import {
  SAVED_FILTER_ENVELOPE_VERSION,
  SAVED_FILTER_LIMITS,
  SAVED_FILTER_POSITION_PROFILE_VERSION,
  SavedFilterContractError,
  type SavedFilterEnvelope,
  type SavedFilterRegistration,
} from '../../platform-runtime/src/saved-filter-contracts.js';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_RESULT_VERSION,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../runtime/src/request-runtime-view.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import type { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

interface SavedFilterRow {
  authored_release_content_hash: string;
  authored_release_id: string;
  created_at: Date;
  criteria_canonical_json: string;
  environment_id: string;
  filter_id: string;
  language_version: string;
  lifecycle: 'active' | 'revoked';
  name: string;
  normalization_profile_version: string;
  owner_principal_id: string;
  position_profile_version: string;
  query_id: string;
  revision: string;
  tenant_id: string;
  updated_at: Date;
}

interface ReleaseMetadata {
  definition: NormalizedApplicationPackage;
  languageVersion: string;
  normalizationProfileVersion: string;
}

type SavedFilterMutationInput =
  | {
      kind: 'create';
      criteriaCanonicalJson: string;
      filterId: string;
      name: string;
      queryId: string;
    }
  | {
      expectedRevision: number;
      filterId: string;
      kind: 'update';
      patch: Partial<{
        criteriaCanonicalJson: string;
        name: string;
        queryId: string;
      }>;
    }
  | {
      expectedRevision: number;
      filterId: string;
      kind: 'archive' | 'restore';
    };

/**
 * Registered platform adapter for saved-filter reads and writes. It exposes no
 * repository mutation surface: durable changes enter through the Semantic
 * Operation executor contract and share its audit/idempotency transaction.
 */
export class PostgresSavedFilterExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly #trust: PostgresTrustService;

  constructor(
    private readonly pool: Pool,
    private readonly actorIssuer: TrustedActorEnvelopeIssuer,
    private readonly registration: SavedFilterRegistration,
    private readonly fallback:
      | (SemanticQueryExecutor & SemanticOperationExecutor)
      | undefined = undefined,
  ) {
    this.#trust = new PostgresTrustService(pool);
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  execute(
    request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope | SemanticOperationResultEnvelope> {
    if ('arguments' in request) {
      return this.#isSavedFilterQuery(request.definition.queryId)
        ? this.#executeQuery(request)
        : this.#requiredFallback().execute(request);
    }
    return this.#isSavedFilterOperation(request.definition.operationId)
      ? this.#executeOperation(request)
      : this.#requiredFallback().execute(request);
  }

  async recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    if (!this.#isSavedFilterOperation(request.operationId) && this.fallback) {
      await this.fallback.recordNonAccepted(request);
      return;
    }
    const actor = await this.actorIssuer.issue(request.context);
    const metadata = evidenceMetadata(request.operationId, null);
    await this.#trust.recordNonAcceptedInvocation(
      request.context,
      actor,
      Object.freeze({
        actionId: request.operationId,
        causationId: null,
        channel: request.channel,
        correlationId: randomUUID(),
        failureCode: request.failureCode,
        invocationId: randomUUID(),
        metadata,
        outcome: request.outcome,
        policy: Object.freeze({
          decision: request.policyDecision,
          evaluatorVersion: 'northstar.semantic-gateway-policy-evaluator/v1',
          policyVersion: request.policyVersion,
          relevantInputs: metadata,
          schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
        }),
        releaseContentHash: request.view.release.contentHash,
        releaseId: request.view.release.releaseId,
      }),
    );
  }

  async #executeQuery(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    if (request.filterPlans.length > 0) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_QUERY_INADMISSIBLE',
        'saved-filter queries cannot execute a predicate lowering plan',
        '$.filterPlans',
      );
    }
    if (
      request.definition.queryId !== this.registration.queryIds.get &&
      request.definition.queryId !== this.registration.queryIds.list
    ) {
      return Object.freeze({
        kind: 'semanticQueryResult',
        outcome: 'unsupported',
        queryId: request.definition.queryId,
        records: Object.freeze([]),
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: 'saved-filter-query-unsupported',
      });
    }
    return withTrustedRequestTransaction(
      this.pool,
      request.context,
      async (client) => {
        const release = await loadReleaseMetadata(client, request.view);
        const rows = await readRows(client, request, this.registration);
        const records = rows.map((row) => {
          validateStoredEnvelope(row, request.view, release);
          return rowToDto(row, this.registration);
        });
        return Object.freeze({
          kind: 'semanticQueryResult',
          outcome: 'exact',
          queryId: request.definition.queryId,
          records: Object.freeze(records),
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          unsupportedReason: null,
        });
      },
    );
  }

  async #executeOperation(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    const input = parseMutationInput(request, this.registration);
    const actor = await this.actorIssuer.issue(request.context);
    const receipt = await this.#trust.executeIdempotentAcceptedMutation(
      request.context,
      actor,
      Object.freeze({
        actionId: request.definition.operationId,
        idempotencyKey: request.idempotencyKey,
        inputDigest: request.inputDigest,
        releaseContentHash: request.view.release.contentHash,
        releaseId: request.view.release.releaseId,
      }),
      async (client) => {
        const release = await loadReleaseMetadata(client, request.view);
        const result = await mutateSavedFilter(client, request, input, release);
        return Object.freeze({
          command: acceptedCommand(request, input, result.before, result.after),
          mutationResult: rowToDto(result.after, this.registration),
        });
      },
    );
    return Object.freeze({
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: receipt.mutationResult,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: Object.freeze({
        changeDocumentId: receipt.changeDocumentId,
        domainEventId: receipt.domainEventId,
        invocationId: receipt.invocationId,
        outboxId: receipt.outboxId,
      }),
      unsupportedReason: null,
    });
  }

  #isSavedFilterQuery(queryId: string): boolean {
    return Object.values(this.registration.queryIds).includes(queryId);
  }

  #isSavedFilterOperation(operationId: string): boolean {
    return Object.values(this.registration.operationIds).includes(operationId);
  }

  #requiredFallback(): SemanticQueryExecutor & SemanticOperationExecutor {
    if (this.fallback) return this.fallback;
    throw new SavedFilterContractError(
      'SAVED_FILTER_QUERY_INADMISSIBLE',
      'executor received a non-platform registration without a fallback',
      '$.definition',
    );
  }
}

async function readRows(
  client: PoolClient,
  request: SemanticQueryExecutionRequest,
  registration: SavedFilterRegistration,
): Promise<SavedFilterRow[]> {
  if (request.definition.queryId === registration.queryIds.get) {
    const input = exactRecord(request.arguments, ['filterId'], '$.arguments');
    const filterId = requiredUuid(input.filterId, '$.arguments.filterId');
    const result = await client.query<SavedFilterRow>(
      `${savedFilterSelect()} WHERE filter_id = $1`,
      [filterId],
    );
    if (result.rowCount !== 1) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_NOT_VISIBLE',
        'saved filter is not visible in the trusted tenant, environment, and principal scope',
        '$.arguments.filterId',
      );
    }
    return result.rows;
  }
  if (request.definition.queryId === registration.queryIds.list) {
    const input = exactRecord(request.arguments, ['queryId'], '$.arguments');
    const queryId = requiredCanonicalId(input.queryId, '$.arguments.queryId');
    requireTargetListQuery(request.view, queryId);
    const result = await client.query<SavedFilterRow>(
      `${savedFilterSelect()} WHERE query_id = $1 AND lifecycle = 'active' ORDER BY filter_id LIMIT $2`,
      [queryId, request.definition.maximumResultCount],
    );
    return result.rows;
  }
  return [];
}

function savedFilterSelect(): string {
  return `SELECT tenant_id, environment_id, owner_principal_id, filter_id,
                 name, query_id, criteria_canonical_json, language_version,
                 normalization_profile_version, position_profile_version,
                 authored_release_id, authored_release_content_hash,
                 lifecycle, revision, created_at, updated_at
            FROM platform.saved_master_filters`;
}

async function mutateSavedFilter(
  client: PoolClient,
  request: SemanticOperationExecutionRequest,
  input: SavedFilterMutationInput,
  release: ReleaseMetadata,
): Promise<{ before: SavedFilterRow | null; after: SavedFilterRow }> {
  if (input.kind === 'create') {
    validateCriteria(
      input.criteriaCanonicalJson,
      input.queryId,
      request.view,
      release,
    );
    const inserted = await client.query<SavedFilterRow>(
      `INSERT INTO platform.saved_master_filters (
         tenant_id, environment_id, owner_principal_id, filter_id, name,
         query_id, criteria_canonical_json, language_version,
         normalization_profile_version, position_profile_version,
         authored_release_id, authored_release_content_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING tenant_id, environment_id, owner_principal_id, filter_id,
                 name, query_id, criteria_canonical_json, language_version,
                 normalization_profile_version, position_profile_version,
                 authored_release_id, authored_release_content_hash,
                 lifecycle, revision, created_at, updated_at`,
      [
        request.context.tenantId,
        request.context.environmentId,
        request.context.principalId,
        input.filterId,
        input.name,
        input.queryId,
        input.criteriaCanonicalJson,
        release.languageVersion,
        release.normalizationProfileVersion,
        SAVED_FILTER_POSITION_PROFILE_VERSION,
        request.view.release.releaseId,
        request.view.release.contentHash,
      ],
    );
    return { before: null, after: requiredRow(inserted.rows[0]) };
  }

  const before = await lockRow(client, input.filterId);
  if (Number(before.revision) !== input.expectedRevision) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_INPUT_MALFORMED',
      'saved filter revision does not match expectedRevision',
      '$.input.expectedRevision',
    );
  }
  if (input.kind === 'update') {
    const next = {
      criteriaCanonicalJson:
        input.patch.criteriaCanonicalJson ?? before.criteria_canonical_json,
      name: input.patch.name ?? before.name,
      queryId: input.patch.queryId ?? before.query_id,
    };
    validateCriteria(
      next.criteriaCanonicalJson,
      next.queryId,
      request.view,
      release,
    );
    const updated = await client.query<SavedFilterRow>(
      `UPDATE platform.saved_master_filters
          SET name = $2, query_id = $3, criteria_canonical_json = $4,
              language_version = $5, normalization_profile_version = $6,
              position_profile_version = $7, authored_release_id = $8,
              authored_release_content_hash = $9, revision = revision + 1,
              updated_at = transaction_timestamp()
        WHERE filter_id = $1 AND revision = $10
      RETURNING tenant_id, environment_id, owner_principal_id, filter_id,
                name, query_id, criteria_canonical_json, language_version,
                normalization_profile_version, position_profile_version,
                authored_release_id, authored_release_content_hash,
                lifecycle, revision, created_at, updated_at`,
      [
        input.filterId,
        next.name,
        next.queryId,
        next.criteriaCanonicalJson,
        release.languageVersion,
        release.normalizationProfileVersion,
        SAVED_FILTER_POSITION_PROFILE_VERSION,
        request.view.release.releaseId,
        request.view.release.contentHash,
        input.expectedRevision,
      ],
    );
    return { before, after: requiredRow(updated.rows[0]) };
  }

  if (input.kind === 'restore') {
    validateStoredEnvelope(
      { ...before, lifecycle: 'active' },
      request.view,
      release,
    );
  }
  const lifecycle = input.kind === 'archive' ? 'revoked' : 'active';
  const updated = await client.query<SavedFilterRow>(
    `UPDATE platform.saved_master_filters
        SET lifecycle = $2, revision = revision + 1,
            updated_at = transaction_timestamp()
      WHERE filter_id = $1 AND revision = $3
    RETURNING tenant_id, environment_id, owner_principal_id, filter_id,
              name, query_id, criteria_canonical_json, language_version,
              normalization_profile_version, position_profile_version,
              authored_release_id, authored_release_content_hash,
              lifecycle, revision, created_at, updated_at`,
    [input.filterId, lifecycle, input.expectedRevision],
  );
  return { before, after: requiredRow(updated.rows[0]) };
}

async function lockRow(
  client: PoolClient,
  filterId: string,
): Promise<SavedFilterRow> {
  const result = await client.query<SavedFilterRow>(
    `${savedFilterSelect()} WHERE filter_id = $1 FOR UPDATE`,
    [filterId],
  );
  if (result.rowCount !== 1) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_NOT_VISIBLE',
      'saved filter is not visible in the trusted scope',
      '$.input.recordId',
    );
  }
  return requiredRow(result.rows[0]);
}

function parseMutationInput(
  request: SemanticOperationExecutionRequest,
  registration: SavedFilterRegistration,
): SavedFilterMutationInput {
  const effect = request.definition.effect.kind;
  const input = request.input;
  if (
    request.definition.effect.entity.targetId !== registration.entityId ||
    !Object.values(registration.operationIds).includes(
      request.definition.operationId,
    )
  ) {
    throw malformed('operation registration does not target saved filters');
  }
  if (effect === 'createRecordEffect') {
    const record = exactRecord(
      input,
      ['recordId', 'relations', 'values'],
      '$.input',
    );
    const relations = exactRecord(record.relations, [], '$.input.relations');
    void relations;
    const values = exactRecord(
      record.values,
      [
        registration.fieldIds.criteria,
        registration.fieldIds.name,
        registration.fieldIds.queryId,
      ],
      '$.input.values',
    );
    return {
      criteriaCanonicalJson: requiredString(
        values[registration.fieldIds.criteria],
        '$.input.values.criteria',
      ),
      filterId: requiredUuid(record.recordId, '$.input.recordId'),
      kind: 'create',
      name: requiredName(
        values[registration.fieldIds.name],
        '$.input.values.name',
      ),
      queryId: requiredCanonicalId(
        values[registration.fieldIds.queryId],
        '$.input.values.queryId',
      ),
    };
  }
  if (effect === 'updateRecordEffect') {
    const record = exactRecord(
      input,
      ['expectedRevision', 'patch', 'recordId'],
      '$.input',
    );
    const patch = partialRecord(
      record.patch,
      [
        registration.fieldIds.criteria,
        registration.fieldIds.name,
        registration.fieldIds.queryId,
      ],
      '$.input.patch',
    );
    if (Object.keys(patch).length === 0)
      throw malformed('patch must not be empty');
    return {
      expectedRevision: requiredRevision(record.expectedRevision),
      filterId: requiredUuid(record.recordId, '$.input.recordId'),
      kind: 'update',
      patch: {
        ...(Object.hasOwn(patch, registration.fieldIds.criteria)
          ? {
              criteriaCanonicalJson: requiredString(
                patch[registration.fieldIds.criteria],
                '$.input.patch.criteria',
              ),
            }
          : {}),
        ...(Object.hasOwn(patch, registration.fieldIds.name)
          ? {
              name: requiredName(
                patch[registration.fieldIds.name],
                '$.input.patch.name',
              ),
            }
          : {}),
        ...(Object.hasOwn(patch, registration.fieldIds.queryId)
          ? {
              queryId: requiredCanonicalId(
                patch[registration.fieldIds.queryId],
                '$.input.patch.queryId',
              ),
            }
          : {}),
      },
    };
  }
  const record = exactRecord(
    input,
    ['expectedRevision', 'recordId'],
    '$.input',
  );
  return {
    expectedRevision: requiredRevision(record.expectedRevision),
    filterId: requiredUuid(record.recordId, '$.input.recordId'),
    kind: effect === 'archiveRecordEffect' ? 'archive' : 'restore',
  };
}

function validateStoredEnvelope(
  row: SavedFilterRow,
  view: RequestRuntimeView,
  release: ReleaseMetadata,
): SavedFilterEnvelope {
  const envelope: SavedFilterEnvelope = Object.freeze({
    authoredReleaseContentHash: row.authored_release_content_hash,
    authoredReleaseId: row.authored_release_id,
    criteriaCanonicalJson: row.criteria_canonical_json,
    environmentId: row.environment_id,
    filterId: row.filter_id,
    languageVersion: row.language_version,
    lifecycle: row.lifecycle,
    name: row.name,
    normalizationProfileVersion: row.normalization_profile_version,
    ownerPrincipalId: row.owner_principal_id,
    positionProfileVersion: SAVED_FILTER_POSITION_PROFILE_VERSION,
    queryId: row.query_id,
    schemaVersion: SAVED_FILTER_ENVELOPE_VERSION,
    tenantId: row.tenant_id,
  });
  if (
    envelope.tenantId !== view.tenantId ||
    envelope.environmentId !== view.environmentId ||
    envelope.ownerPrincipalId !== view.principalId
  ) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_NOT_VISIBLE',
      'saved filter does not belong to the trusted request scope',
      '$.scope',
    );
  }
  if (envelope.lifecycle !== 'active') {
    throw new SavedFilterContractError(
      'SAVED_FILTER_LIFECYCLE_REVOKED',
      'saved filter is revoked',
      '$.lifecycle',
    );
  }
  if (
    envelope.authoredReleaseId !== view.release.releaseId ||
    envelope.authoredReleaseContentHash !== view.release.contentHash ||
    envelope.languageVersion !== release.languageVersion ||
    envelope.normalizationProfileVersion !==
      release.normalizationProfileVersion ||
    row.position_profile_version !== SAVED_FILTER_POSITION_PROFILE_VERSION
  ) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_RELEASE_MISMATCH',
      'saved filter was not authored for the request-pinned release and profile',
      '$.authoredReleaseId',
    );
  }
  validateCriteria(
    envelope.criteriaCanonicalJson,
    envelope.queryId,
    view,
    release,
  );
  return envelope;
}

function validateCriteria(
  criteriaCanonicalJson: string,
  queryId: string,
  view: RequestRuntimeView,
  release: ReleaseMetadata,
): PredicateExpression {
  const byteLength = new TextEncoder().encode(criteriaCanonicalJson).byteLength;
  if (byteLength > SAVED_FILTER_LIMITS.maximumBytes) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_CRITERIA_BYTES_EXCEEDED',
      'saved-filter criteria exceed the byte budget',
      '$.criteria',
    );
  }
  let wire: unknown;
  try {
    wire = JSON.parse(criteriaCanonicalJson) as unknown;
  } catch {
    throw new SavedFilterContractError(
      'SAVED_FILTER_CRITERIA_CORRUPT',
      'saved-filter criteria are not JSON',
      '$.criteria',
    );
  }
  enforceResourceBounds(wire, release.languageVersion);
  const parsed = PredicateExpressionSchema.safeParse(wire);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SavedFilterContractError(
      'SAVED_FILTER_CRITERIA_CORRUPT',
      'saved-filter criteria do not match PredicateExpression',
      issue ? `$.criteria.${issue.path.join('.')}` : '$.criteria',
    );
  }
  if (canonicalize(parsed.data) !== criteriaCanonicalJson) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_CRITERIA_NOT_CANONICAL',
      'saved-filter criteria must use canonical JSON bytes',
      '$.criteria',
    );
  }
  const query = requireTargetListQuery(view, queryId);
  const selected = new Set(query.selections);
  visitComparisons(parsed.data, (fieldId, path) => {
    const field = fieldFromPinnedCatalog(view, fieldId);
    if (!field) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_FIELD_STALE',
        'saved-filter criteria reference a field absent from the pinned release',
        path,
      );
    }
    if (field.lifecycle !== 'active' || !selected.has(fieldId)) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_FIELD_INADMISSIBLE',
        'saved-filter criteria reference a field outside the target List projection',
        path,
      );
    }
  });
  validateAgainstPinnedDefinition(
    parsed.data,
    criteriaCanonicalJson,
    queryId,
    release.definition,
  );
  return parsed.data;
}

function validateAgainstPinnedDefinition(
  predicate: PredicateExpression,
  criteriaCanonicalJson: string,
  queryId: string,
  definition: NormalizedApplicationPackage,
): void {
  const authored = canonicalAuthoredProjection(definition);
  let normalized: NormalizedApplicationPackage;
  try {
    normalized = normalizeApplicationPackage({
      ...authored,
      queries: authored.queries.map((query) =>
        query.queryId === queryId ? { ...query, filter: predicate } : query,
      ),
    });
  } catch (error) {
    if (error instanceof CanonicalModelError) {
      const diagnostic =
        error.diagnostics.find((entry) => entry.objectId === queryId) ??
        error.diagnostics[0];
      throw new SavedFilterContractError(
        'SAVED_FILTER_FIELD_INADMISSIBLE',
        'saved-filter criteria are inadmissible for the pinned field contract',
        diagnostic?.path.replace('$.queries.filter', '$.criteria') ??
          '$.criteria',
      );
    }
    throw error;
  }
  const normalizedQuery = normalized.queries.find(
    (query) => query.queryId === queryId,
  );
  if (!normalizedQuery) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_QUERY_STALE',
      'saved-filter target query is absent from the normalized pinned release',
      '$.queryId',
    );
  }
  if (canonicalize(normalizedQuery.filter) !== criteriaCanonicalJson) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_CRITERIA_NOT_CANONICAL',
      'saved-filter criteria must already be in canonical predicate order and scalar form',
      '$.criteria',
    );
  }
}

function enforceResourceBounds(wire: unknown, languageVersion: string): void {
  const stack: Array<{ depth: number; path: string; value: unknown }> = [
    { depth: 1, path: '$.criteria', value: wire },
  ];
  let collections = 0;
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!isRecord(current.value)) continue;
    nodes += 1;
    if (nodes > SAVED_FILTER_LIMITS.maximumNodes) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_NODE_LIMIT_EXCEEDED',
        'saved-filter criteria exceed the node budget',
        current.path,
      );
    }
    if (current.depth > SAVED_FILTER_LIMITS.maximumDepth) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_DEPTH_LIMIT_EXCEEDED',
        'saved-filter criteria exceed the depth budget',
        current.path,
      );
    }
    if (current.value.schemaVersion !== languageVersion) {
      throw new SavedFilterContractError(
        'SAVED_FILTER_NODE_VERSION_UNSUPPORTED',
        'every saved-filter node must use the pinned release language version',
        `${current.path}.schemaVersion`,
      );
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (Array.isArray(value)) {
        collections += 1;
        if (
          collections > SAVED_FILTER_LIMITS.maximumCollections ||
          value.length > SAVED_FILTER_LIMITS.maximumTermsPerCollection
        ) {
          throw new SavedFilterContractError(
            'SAVED_FILTER_COLLECTION_LIMIT_EXCEEDED',
            'saved-filter criteria exceed the collection budget',
            `${current.path}.${key}`,
          );
        }
        value.forEach((entry, index) =>
          stack.push({
            depth: current.depth + 1,
            path: `${current.path}.${key}[${String(index)}]`,
            value: entry,
          }),
        );
      } else if (isRecord(value)) {
        stack.push({
          depth:
            key === 'term' || key === 'terms'
              ? current.depth + 1
              : current.depth,
          path: `${current.path}.${key}`,
          value,
        });
      }
    }
  }
}

function visitComparisons(
  predicate: PredicateExpression,
  visit: (fieldId: string, path: string) => void,
  path = '$.criteria',
): void {
  if (predicate.kind === 'fieldComparisonPredicate') {
    if (predicate.field.kind !== 'fieldReference') {
      throw new SavedFilterContractError(
        'SAVED_FILTER_FIELD_INADMISSIBLE',
        'comparison references must be field references',
        `${path}.field`,
      );
    }
    visit(predicate.field.targetId, `${path}.field.targetId`);
    return;
  }
  if (predicate.kind === 'notPredicate') {
    visitComparisons(predicate.term, visit, `${path}.term`);
    return;
  }
  if (predicate.kind === 'allPredicate' || predicate.kind === 'anyPredicate') {
    predicate.terms.forEach((term, index) =>
      visitComparisons(term, visit, `${path}.terms[${String(index)}]`),
    );
  }
}

function requireTargetListQuery(
  view: RequestRuntimeView,
  queryId: string,
): { selections: string[] } {
  const payload = view.projections.query.payload;
  if (!isRecord(payload) || !Array.isArray(payload.queries)) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_QUERY_STALE',
      'pinned query catalog is unavailable',
      '$.queryId',
    );
  }
  const query = payload.queries.find(
    (candidate) => isRecord(candidate) && candidate.queryId === queryId,
  );
  if (!isRecord(query)) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_QUERY_STALE',
      'saved-filter target query is absent from the pinned release',
      '$.queryId',
    );
  }
  if (
    query.lifecycle !== 'active' ||
    query.tier !== 'q0' ||
    query.queryType !== 'list' ||
    !Array.isArray(query.selections)
  ) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_QUERY_INADMISSIBLE',
      'saved filters may target only an active Q0 List query',
      '$.queryId',
    );
  }
  return {
    selections: query.selections.flatMap((selection) =>
      isRecord(selection) && typeof selection.fieldId === 'string'
        ? [selection.fieldId]
        : [],
    ),
  };
}

function fieldFromPinnedCatalog(
  view: RequestRuntimeView,
  fieldId: string,
): { lifecycle: unknown } | null {
  const payload = view.projections.catalog.payload;
  if (!isRecord(payload) || !Array.isArray(payload.constructs)) return null;
  const field = payload.constructs.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.constructKind === 'fieldDefinition' &&
      candidate.subjectId === fieldId,
  );
  return isRecord(field) ? { lifecycle: 'active' } : null;
}

async function loadReleaseMetadata(
  client: PoolClient,
  view: RequestRuntimeView,
): Promise<ReleaseMetadata> {
  const result = await client.query<{
    content_hash: string;
    desired_state: Uint8Array;
    language_version: string;
    normalization_profile_version: string;
  }>(
    `SELECT release.content_hash, revision.desired_state,
            revision.language_version,
            revision.normalization_profile_version
       FROM platform.tenant_releases AS release
       JOIN platform.app_package_revisions AS revision
         ON revision.tenant_id = release.tenant_id
        AND revision.revision_id = release.app_package_revision_id
      WHERE release.release_id = $1`,
    [view.release.releaseId],
  );
  const row = result.rows[0];
  if (!row || row.content_hash !== view.release.contentHash) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_RELEASE_MISMATCH',
      'request-pinned release metadata is unavailable',
      '$.release',
    );
  }
  let definition: NormalizedApplicationPackage;
  try {
    definition = NormalizedApplicationPackageSchema.parse(
      JSON.parse(new TextDecoder().decode(row.desired_state)) as unknown,
    );
  } catch {
    throw new SavedFilterContractError(
      'SAVED_FILTER_RELEASE_MISMATCH',
      'request-pinned release definition is unavailable or corrupt',
      '$.release',
    );
  }
  if (
    definition.languageVersion !== row.language_version ||
    definition.normalizationProfileVersion !== row.normalization_profile_version
  ) {
    throw new SavedFilterContractError(
      'SAVED_FILTER_RELEASE_MISMATCH',
      'request-pinned release definition disagrees with immutable revision metadata',
      '$.release',
    );
  }
  return {
    definition,
    languageVersion: row.language_version,
    normalizationProfileVersion: row.normalization_profile_version,
  };
}

function rowToDto(
  row: SavedFilterRow,
  registration: SavedFilterRegistration,
): SemanticRecordDto {
  return Object.freeze({
    archived: row.lifecycle === 'revoked',
    entityId: registration.entityId,
    recordId: row.filter_id,
    revision: Number(row.revision),
    values: Object.freeze({
      [registration.fieldIds.criteria]: row.criteria_canonical_json,
      [registration.fieldIds.name]: row.name,
      [registration.fieldIds.queryId]: row.query_id,
    }),
  });
}

function acceptedCommand(
  request: SemanticOperationExecutionRequest,
  input: SavedFilterMutationInput,
  before: SavedFilterRow | null,
  after: SavedFilterRow,
): AcceptedMutationCommand {
  const ids = {
    changeDocumentId: randomUUID(),
    correlationId: randomUUID(),
    eventId: randomUUID(),
    invocationId: randomUUID(),
    outboxId: randomUUID(),
  };
  const metadata = evidenceMetadata(
    request.definition.operationId,
    after.query_id,
  );
  return Object.freeze({
    actionId: request.definition.operationId,
    causationId: null,
    change: Object.freeze({
      changeDocumentId: ids.changeDocumentId,
      changes: mutationChanges(input, before, after),
      recordId: after.filter_id,
      recordType: request.definition.effect.entity.targetId,
      revision: Number(after.revision),
    }),
    channel: request.channel,
    correlationId: ids.correlationId,
    event: Object.freeze({
      eventId: ids.eventId,
      eventSchemaVersion: 'northstar.saved-filter-event/v1',
      eventType: 'northstar.platform:event.saved_filter_changed',
      payload: metadata,
    }),
    invocationId: ids.invocationId,
    metadata,
    outbox: Object.freeze({
      deduplicationKey: [
        request.context.tenantId,
        request.context.environmentId,
        request.context.principalId,
        request.definition.operationId,
        request.idempotencyKey,
      ].join(':'),
      outboxId: ids.outboxId,
    }),
    policy: Object.freeze({
      decision: 'ALLOW',
      evaluatorVersion: 'northstar.semantic-gateway-policy-evaluator/v1',
      policyVersion: request.policyVersion,
      relevantInputs: metadata,
      schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
    }),
    releaseContentHash: request.view.release.contentHash,
    releaseId: request.view.release.releaseId,
  });
}

function mutationChanges(
  input: SavedFilterMutationInput,
  before: SavedFilterRow | null,
  after: SavedFilterRow,
): AcceptedMutationCommand['change']['changes'] {
  const absent = Object.freeze({ state: 'ABSENT' as const });
  const value = (entry: unknown) =>
    Object.freeze({ state: 'VALUE' as const, value: entry });
  if (input.kind === 'archive' || input.kind === 'restore') {
    return Object.freeze([
      Object.freeze({
        classification: 'INTERNAL' as const,
        fieldId: 'archiveStatus',
        newState: value(after.lifecycle),
        oldState: value(before?.lifecycle ?? null),
      }),
    ]);
  }
  return Object.freeze([
    Object.freeze({
      classification: 'INTERNAL' as const,
      fieldId: 'savedFilter.name',
      newState: value(after.name),
      oldState: before ? value(before.name) : absent,
    }),
    Object.freeze({
      classification: 'INTERNAL' as const,
      fieldId: 'savedFilter.queryId',
      newState: value(after.query_id),
      oldState: before ? value(before.query_id) : absent,
    }),
    Object.freeze({
      classification: 'SENSITIVE' as const,
      fieldId: 'savedFilter.criteria',
      newState: value(after.criteria_canonical_json),
      oldState: before ? value(before.criteria_canonical_json) : absent,
    }),
  ]);
}

function evidenceMetadata(
  operationId: string,
  queryId: string | null,
): EvidenceMetadataInput {
  return Object.freeze({
    operationId: Object.freeze({
      classification: 'INTERNAL' as const,
      value: operationId,
    }),
    queryId: Object.freeze({
      classification: 'INTERNAL' as const,
      value: queryId,
    }),
    requestKind: Object.freeze({
      classification: 'INTERNAL' as const,
      value: 'saved-filter-o0',
    }),
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw malformed(`${path} must be an object`, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw malformed(`${path} keys do not match the closed contract`, path);
  }
  return value;
}

function partialRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw malformed(`${path} must be an object`, path);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw malformed(`${path} contains an unknown field`, path);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw malformed(`${path} must be text`, path);
  return value;
}

function requiredName(value: unknown, path: string): string {
  const name = requiredString(value, path).trim();
  if (name.length === 0 || [...name].length > 120) {
    throw malformed(`${path} must contain 1 through 120 characters`, path);
  }
  return name;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw malformed(
      'expectedRevision must be a positive integer',
      '$.input.expectedRevision',
    );
  }
  return Number(value);
}

function requiredUuid(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw malformed(`${path} must be a UUID`, path);
  }
  return value;
}

function requiredCanonicalId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(
      value,
    )
  ) {
    throw malformed(`${path} must be a canonical ID`, path);
  }
  return value;
}

function requiredRow(row: SavedFilterRow | undefined): SavedFilterRow {
  if (row) return row;
  throw new SavedFilterContractError(
    'SAVED_FILTER_NOT_VISIBLE',
    'saved-filter mutation did not affect one visible row',
    '$.input.recordId',
  );
}

function malformed(
  message: string,
  path = '$.input',
): SavedFilterContractError {
  return new SavedFilterContractError(
    'SAVED_FILTER_INPUT_MALFORMED',
    message,
    path,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
