import { createHash, randomUUID } from 'node:crypto';

import { canonicalize, unicodeCaseFold } from '@north-star/canonical-model';
import {
  PROJECTION_FAMILY_IDS,
  STORAGE_TARGET_PAYLOAD_VERSION,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import type {
  BusinessFieldChangeInput,
  BusinessValueStateInput,
  EvidenceMetadataInput,
  AcceptedMutationCommand,
} from '../../platform-runtime/src/trust/contracts.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type {
  RegisteredOperationDefinition,
  SemanticOperationExecutionRequest,
  SemanticOperationExecutor,
  SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_OPERATION_RESULT_VERSION } from '../../runtime/src/semantic-operation-gateway.js';
import type {
  RegisteredQueryDefinition,
  SemanticQueryExecutionRequest,
  SemanticQueryExecutor,
  SemanticQueryResultEnvelope,
  SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import { SEMANTIC_QUERY_RESULT_VERSION } from '../../runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

const artifactMediaType = 'application/vnd.northstar.canonical+json';
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;
const unicodeCaseFoldFunctionName = 'nsm_unicode_case_fold_v1';
const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ArtifactRow {
  artifact_kind: string;
  canonical_bytes: Uint8Array;
  content_hash: string;
  domain_tag: string;
  media_type: string;
}

interface MutationInput {
  expectedRevision: number | null;
  patch: Readonly<Record<string, ImmutableJsonValue>>;
  recordId: string;
  relations: Readonly<Record<string, string>>;
}

interface MutationPreparation {
  changes: readonly BusinessFieldChangeInput[];
  expectedRevision: number | null;
  projectedRevision: number;
  recordId: string;
}

interface RawRecord {
  archivedAt: Date | string | null;
  recordId: string;
  revision: number;
  values: Readonly<Record<string, ImmutableJsonValue>>;
}

type StorageEntity = StorageTargetPayloadV1['entities'][number];

export class ModuleRuntimeInterpreterError extends Error {
  override readonly name = 'ModuleRuntimeInterpreterError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The only PostgreSQL interpreter for compiled Q0/O0 module projections.
 * Canonical registration stays data: no module name or handler appears here.
 */
export class PostgresModuleRuntimeInterpreter
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly #trust: PostgresTrustService;

  constructor(
    private readonly pool: Pool,
    private readonly actorIssuer: TrustedActorEnvelopeIssuer,
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
    return 'arguments' in request
      ? this.#executeQuery(request)
      : this.#executeOperation(request);
  }

  async #executeQuery(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    return withTrustedRequestTransaction(
      this.pool,
      request.context,
      async (client) => {
        const storage = await loadPinnedStorageTarget(client, request);
        return withModuleRuntimeRole(client, () =>
          executeQueryOnClient(
            client,
            storage,
            request.definition,
            request.arguments,
          ),
        );
      },
    );
  }

  async #executeOperation(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    const input = parseMutationInput(request.definition, request.input);
    const storage = await withTrustedRequestTransaction(
      this.pool,
      request.context,
      async (client) => loadPinnedStorageTarget(client, request),
    );
    const entity = requiredEntity(
      storage,
      request.definition.effect.entity.targetId,
    );
    const preparation = await prepareMutation(
      this.pool,
      request,
      storage,
      entity,
      input,
    );
    const actor = await this.actorIssuer.issue(request.context);
    const ids = {
      changeDocumentId: randomUUID(),
      correlationId: randomUUID(),
      eventId: randomUUID(),
      invocationId: randomUUID(),
      outboxId: randomUUID(),
    };
    const command = acceptedCommand(request, preparation, ids);
    const receipt = await this.#trust.executeAcceptedMutation(
      request.context,
      actor,
      command,
      async (client) => {
        const currentStorage = await loadPinnedStorageTarget(client, request);
        const currentEntity = requiredEntity(
          currentStorage,
          request.definition.effect.entity.targetId,
        );
        return withModuleRuntimeRole(client, () =>
          executeMutationOnClient(
            client,
            currentStorage,
            currentEntity,
            request.definition,
            input,
            request.readBackDefinition.selections,
          ),
        );
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
}

async function prepareMutation(
  pool: Pool,
  request: SemanticOperationExecutionRequest,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  input: MutationInput,
): Promise<MutationPreparation> {
  const kind = request.definition.effect.kind;
  if (kind === 'createRecordEffect') {
    return {
      changes: createChanges(input),
      expectedRevision: null,
      projectedRevision: 1,
      recordId: input.recordId,
    };
  }
  const prior = await withTrustedRequestTransaction(
    pool,
    request.context,
    async (client) =>
      withModuleRuntimeRole(client, () =>
        loadRawRecord(client, entity, input.recordId, true),
      ),
  );
  if (!prior) {
    throw failure('MODULE_RECORD_NOT_FOUND', 'module record was not found');
  }
  if (prior.revision !== input.expectedRevision) {
    throw failure(
      'MODULE_REVISION_CONFLICT',
      'module record revision does not match expectedRevision',
    );
  }
  const changes =
    kind === 'updateRecordEffect'
      ? updateChanges(prior, input.patch)
      : [
          Object.freeze({
            classification: 'INTERNAL' as const,
            fieldId: 'archiveStatus',
            newState: valueState(kind === 'archiveRecordEffect'),
            oldState: valueState(kind !== 'archiveRecordEffect'),
          }),
        ];
  return {
    changes,
    expectedRevision: input.expectedRevision,
    projectedRevision: prior.revision + 1,
    recordId: input.recordId,
  };
}

function acceptedCommand(
  request: SemanticOperationExecutionRequest,
  preparation: MutationPreparation,
  ids: {
    changeDocumentId: string;
    correlationId: string;
    eventId: string;
    invocationId: string;
    outboxId: string;
  },
): AcceptedMutationCommand {
  const metadata: EvidenceMetadataInput = Object.freeze({
    operationId: classified('INTERNAL', request.definition.operationId),
    requestKind: classified('INTERNAL', 'generic-o0'),
  });
  return Object.freeze({
    actionId: request.definition.operationId,
    causationId: null,
    change: Object.freeze({
      changeDocumentId: ids.changeDocumentId,
      changes: preparation.changes,
      recordId: preparation.recordId,
      recordType: request.definition.effect.entity.targetId,
      revision: preparation.projectedRevision,
    }),
    channel: 'API',
    correlationId: ids.correlationId,
    event: Object.freeze({
      eventId: ids.eventId,
      eventSchemaVersion: 'northstar.generic-module-event/v1',
      eventType: eventTypeFor(request.definition.operationId),
      payload: metadata,
    }),
    invocationId: ids.invocationId,
    metadata,
    outbox: Object.freeze({
      deduplicationKey: `${request.definition.operationId}:${preparation.recordId}:${ids.invocationId}`,
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

async function executeMutationOnClient(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  definition: RegisteredOperationDefinition,
  input: MutationInput,
  readBackSelections: readonly { readonly fieldId: string }[],
): Promise<SemanticRecordDto> {
  switch (definition.effect.kind) {
    case 'createRecordEffect':
      await insertRecord(client, storage, entity, input);
      break;
    case 'updateRecordEffect':
      await updateRecord(client, entity, input);
      break;
    case 'archiveRecordEffect':
      await setArchiveState(client, entity, input, true);
      break;
    case 'restoreRecordEffect':
      await setArchiveState(client, entity, input, false);
      break;
  }
  const record = await loadRawRecord(client, entity, input.recordId, true);
  if (!record) {
    throw failure(
      'MODULE_MUTATION_READ_BACK_MISSING',
      'successful module mutation had no read-back record',
    );
  }
  return toDto(entity, record, readBackSelections);
}

async function insertRecord(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  input: MutationInput,
): Promise<void> {
  const columns = ['tenant_id', 'environment_id', entity.recordIdentity.column];
  const values: unknown[] = [];
  const parameters = [
    'north_star_internal.trusted_tenant_id()',
    'north_star_internal.trusted_environment_id()',
    parameter(values, input.recordId),
  ];
  const knownFields = new Map(
    entity.columns.map((column) => [column.canonicalFieldId, column]),
  );
  for (const [fieldId, value] of Object.entries(input.patch).sort(
    compareEntry,
  )) {
    const column = knownFields.get(fieldId);
    if (!column) {
      throw failure('MODULE_FIELD_UNSUPPORTED', `unknown field ${fieldId}`);
    }
    columns.push(column.physicalName);
    parameters.push(parameter(values, databaseValue(value)));
  }
  for (const column of entity.columns) {
    if (
      !column.nullable &&
      column.defaultSemantics !== 'declaredDefault' &&
      !Object.hasOwn(input.patch, column.canonicalFieldId)
    ) {
      throw failure(
        'MODULE_REQUIRED_FIELD_MISSING',
        `required field ${column.canonicalFieldId} is missing`,
      );
    }
  }
  const relations = storage.relations.filter(
    (relation) => relation.sourceEntityId === entity.entityId,
  );
  const relationById = new Map(
    relations.map((relation) => [relation.relationId, relation]),
  );
  for (const [relationId, recordId] of Object.entries(input.relations).sort(
    compareEntry,
  )) {
    const relation = relationById.get(relationId);
    if (!relation) {
      throw failure(
        'MODULE_RELATION_UNSUPPORTED',
        `unknown relation ${relationId}`,
      );
    }
    await requireRelationTarget(client, storage, relation, recordId);
    columns.push(relation.relationColumn.physicalName);
    parameters.push(parameter(values, recordId));
  }
  for (const relation of relations) {
    if (
      !relation.relationColumn.nullable &&
      !Object.hasOwn(input.relations, relation.relationId)
    ) {
      throw failure(
        'MODULE_REQUIRED_RELATION_MISSING',
        `required relation ${relation.relationId} is missing`,
      );
    }
  }
  await client.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (${columns.map(quoted).join(', ')})
     VALUES (${parameters.join(', ')})`,
    values,
  );
}

async function requireRelationTarget(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  relation: StorageTargetPayloadV1['relations'][number],
  recordId: string,
): Promise<void> {
  const target = requiredEntity(storage, relation.targetEntityId);
  const result = await client.query(
    `SELECT 1
       FROM north_star_module.${quoted(target.physicalTableName)}
      WHERE tenant_id = north_star_internal.trusted_tenant_id()
        AND environment_id = north_star_internal.trusted_environment_id()
        AND ${quoted(target.recordIdentity.column)} = $1
      LIMIT 1`,
    [recordId],
  );
  if (result.rowCount !== 1) {
    throw failure(
      'MODULE_RELATION_TARGET_NOT_FOUND',
      'relation target was not found',
    );
  }
}

async function updateRecord(
  client: PoolClient,
  entity: StorageEntity,
  input: MutationInput,
): Promise<void> {
  if (Object.keys(input.patch).length === 0) {
    throw failure('MODULE_PATCH_EMPTY', 'update patch must not be empty');
  }
  const knownFields = new Map(
    entity.columns.map((column) => [column.canonicalFieldId, column]),
  );
  const values: unknown[] = [];
  const assignments = Object.entries(input.patch)
    .sort(compareEntry)
    .map(([fieldId, value]) => {
      const column = knownFields.get(fieldId);
      if (!column) {
        throw failure('MODULE_FIELD_UNSUPPORTED', `unknown field ${fieldId}`);
      }
      if (value === null && !column.nullable) {
        throw failure(
          'MODULE_REQUIRED_FIELD_CLEAR_FORBIDDEN',
          `required field ${fieldId} cannot be cleared`,
        );
      }
      return `${quoted(column.physicalName)} = ${parameter(values, databaseValue(value))}`;
    });
  assignments.push(
    `${quoted(entity.optimisticRevision.column)} = ${quoted(entity.optimisticRevision.column)} + 1`,
  );
  const recordParameter = parameter(values, input.recordId);
  const revisionParameter = parameter(values, input.expectedRevision);
  const result = await client.query(
    `UPDATE north_star_module.${quoted(entity.physicalTableName)}
        SET ${assignments.join(', ')}
      WHERE ${quoted(entity.recordIdentity.column)} = ${recordParameter}
        AND ${quoted(entity.optimisticRevision.column)} = ${revisionParameter}
        AND ${quoted(entity.archive.archivedAtColumn)} IS NULL`,
    values,
  );
  requireMutation(result.rowCount);
}

async function setArchiveState(
  client: PoolClient,
  entity: StorageEntity,
  input: MutationInput,
  archive: boolean,
): Promise<void> {
  const values: unknown[] = [];
  const recordParameter = parameter(values, input.recordId);
  const revisionParameter = parameter(values, input.expectedRevision);
  const result = await client.query(
    `UPDATE north_star_module.${quoted(entity.physicalTableName)}
        SET ${quoted(entity.archive.archivedAtColumn)} = ${archive ? 'clock_timestamp()' : 'NULL'},
            ${quoted(entity.optimisticRevision.column)} = ${quoted(entity.optimisticRevision.column)} + 1
      WHERE ${quoted(entity.recordIdentity.column)} = ${recordParameter}
        AND ${quoted(entity.optimisticRevision.column)} = ${revisionParameter}
        AND ${quoted(entity.archive.archivedAtColumn)} IS ${archive ? 'NULL' : 'NOT NULL'}`,
    values,
  );
  requireMutation(result.rowCount);
}

async function executeQueryOnClient(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  definition: RegisteredQueryDefinition,
  argumentValue: ImmutableJsonValue,
): Promise<SemanticQueryResultEnvelope> {
  if (!definition.infrastructure) {
    return queryResult(
      definition.queryId,
      'unsupported',
      [],
      'query-contract-unsupported',
    );
  }
  const entity = requiredEntity(storage, definition.sourceEntityId);
  const args = requireRecord(argumentValue, 'query arguments');
  const includeArchived = optionalBoolean(args.includeArchived, false);
  let records: RawRecord[];
  switch (definition.queryType) {
    case 'get': {
      const recordId = requiredUuid(args.recordId, 'recordId');
      const record = await loadRawRecord(
        client,
        entity,
        recordId,
        includeArchived,
      );
      records = record ? [record] : [];
      return queryResult(
        definition.queryId,
        records.length === 1 ? 'exact' : 'not-found',
        records.map((entry) => toDto(entity, entry, definition.selections)),
        null,
      );
    }
    case 'list': {
      const limit = boundedLimit(args.limit, definition.maximumResultCount);
      const afterRecordId = optionalUuid(args.afterRecordId, 'afterRecordId');
      records = await listRecords(
        client,
        entity,
        includeArchived,
        limit,
        afterRecordId,
      );
      return queryResult(
        definition.queryId,
        'exact',
        records.map((entry) => toDto(entity, entry, definition.selections)),
        null,
      );
    }
    case 'search': {
      const text = requiredSearchText(args.text);
      const limit = boundedLimit(args.limit, definition.maximumResultCount);
      records = await matchRecords(
        client,
        entity,
        definition,
        text,
        includeArchived,
        limit,
      );
      return queryResult(
        definition.queryId,
        'exact',
        records.map((entry) => toDto(entity, entry, definition.selections)),
        null,
      );
    }
    case 'resolve': {
      const text = requiredSearchText(args.text);
      const matches = await matchResolveRecords(
        client,
        entity,
        definition,
        text,
        includeArchived,
        Math.max(2, definition.maximumResultCount),
      );
      const outcome =
        matches.records.length === 0
          ? 'not-found'
          : matches.advisoryMatchCount === 0 &&
              matches.identifierMatchCount === 1
            ? 'exact'
            : 'ambiguous';
      return queryResult(
        definition.queryId,
        outcome,
        matches.records.map((entry) =>
          toDto(entity, entry, definition.selections),
        ),
        null,
      );
    }
  }
}

async function listRecords(
  client: PoolClient,
  entity: StorageEntity,
  includeArchived: boolean,
  limit: number,
  afterRecordId: string | null,
): Promise<RawRecord[]> {
  const values: unknown[] = [];
  const predicates = archivePredicate(entity, includeArchived);
  if (afterRecordId) {
    predicates.push(
      `${quoted(entity.recordIdentity.column)} > ${parameter(values, afterRecordId)}`,
    );
  }
  const rows = await client.query<QueryResultRow>(
    selectSql(
      entity,
      predicates,
      `ORDER BY ${quoted(entity.recordIdentity.column)} LIMIT ${parameter(values, limit)}`,
    ),
    values,
  );
  return rows.rows.map((row) => rawRecord(entity, row));
}

async function matchRecords(
  client: PoolClient,
  entity: StorageEntity,
  definition: RegisteredQueryDefinition,
  text: string,
  includeArchived: boolean,
  limit: number,
): Promise<RawRecord[]> {
  const selected = new Set(definition.selections.map((item) => item.fieldId));
  const columns = entity.columns.filter(
    (column) =>
      selected.has(column.canonicalFieldId) &&
      (column.searchMapping === 'normalizedTextIndex' ||
        /^(?:text|character varying|varchar)/.test(column.postgresqlType)),
  );
  if (columns.length === 0) return [];
  const values: unknown[] = [];
  const textParameter = parameter(values, `%${text}%`);
  const predicates = archivePredicate(entity, includeArchived);
  predicates.push(
    `(${columns
      .map(
        (column) =>
          `lower(${quoted(column.physicalName)}::text) LIKE lower(${textParameter})`,
      )
      .join(' OR ')})`,
  );
  const rows = await client.query<QueryResultRow>(
    selectSql(
      entity,
      predicates,
      `ORDER BY ${quoted(entity.recordIdentity.column)} LIMIT ${parameter(values, limit)}`,
    ),
    values,
  );
  return rows.rows.map((row) => rawRecord(entity, row));
}

async function matchResolveRecords(
  client: PoolClient,
  entity: StorageEntity,
  definition: RegisteredQueryDefinition,
  text: string,
  includeArchived: boolean,
  limit: number,
): Promise<{
  advisoryMatchCount: number;
  identifierMatchCount: number;
  records: RawRecord[];
}> {
  const keys = definition.resolveMatchKeys ?? [];
  if (keys.length === 0) {
    throw failure(
      'MODULE_RESOLVE_MATCH_AUTHORITY_REQUIRED',
      `resolve query ${definition.queryId} has no declared match authority`,
    );
  }
  const columnsById = new Map(
    entity.columns.map((column) => [column.canonicalFieldId, column] as const),
  );
  const columnsFor = (authority: 'advisory' | 'identifier') =>
    keys
      .filter((key) => key.authority === authority)
      .map((key) => {
        const column = columnsById.get(key.fieldId);
        if (
          !column ||
          !/^(?:text|character varying|varchar)/.test(column.postgresqlType)
        ) {
          throw failure(
            'MODULE_RESOLVE_MATCH_KEY_UNSUPPORTED',
            `resolve match key ${key.matchKeyId} has no supported text storage column`,
          );
        }
        return column;
      });
  const identifierMatches = await exactFoldedMatches(
    client,
    entity,
    columnsFor('identifier'),
    text,
    includeArchived,
    limit,
  );
  const advisoryMatches = await exactFoldedMatches(
    client,
    entity,
    columnsFor('advisory'),
    text,
    includeArchived,
    limit,
  );
  const recordsById = new Map<string, RawRecord>();
  for (const record of [...identifierMatches, ...advisoryMatches]) {
    recordsById.set(record.recordId, record);
  }
  return {
    advisoryMatchCount: advisoryMatches.length,
    identifierMatchCount: identifierMatches.length,
    records: [...recordsById.values()]
      .sort((left, right) =>
        left.recordId < right.recordId
          ? -1
          : left.recordId > right.recordId
            ? 1
            : 0,
      )
      .slice(0, limit),
  };
}

async function exactFoldedMatches(
  client: PoolClient,
  entity: StorageEntity,
  columns: readonly StorageEntity['columns'][number][],
  text: string,
  includeArchived: boolean,
  limit: number,
): Promise<RawRecord[]> {
  if (columns.length === 0) return [];
  const values: unknown[] = [];
  const textParameter = parameter(values, unicodeCaseFold(text));
  const predicates = archivePredicate(entity, includeArchived);
  predicates.push(
    `(${columns
      .map(
        (column) =>
          `north_star_module.${unicodeCaseFoldFunctionName}(${quoted(column.physicalName)}::text) = ${textParameter}`,
      )
      .join(' OR ')})`,
  );
  const rows = await client.query<QueryResultRow>(
    selectSql(
      entity,
      predicates,
      `ORDER BY ${quoted(entity.recordIdentity.column)} LIMIT ${parameter(values, limit)}`,
    ),
    values,
  );
  return rows.rows.map((row) => rawRecord(entity, row));
}

async function loadRawRecord(
  client: PoolClient,
  entity: StorageEntity,
  recordId: string,
  includeArchived: boolean,
): Promise<RawRecord | null> {
  const values: unknown[] = [];
  const predicates = archivePredicate(entity, includeArchived);
  predicates.push(
    `${quoted(entity.recordIdentity.column)} = ${parameter(values, recordId)}`,
  );
  const result = await client.query<QueryResultRow>(
    selectSql(entity, predicates, 'LIMIT 1'),
    values,
  );
  return result.rows[0] ? rawRecord(entity, result.rows[0]) : null;
}

function selectSql(
  entity: StorageEntity,
  predicates: readonly string[],
  suffix: string,
): string {
  const columns = [
    entity.recordIdentity.column,
    entity.optimisticRevision.column,
    entity.archive.archivedAtColumn,
    ...entity.columns.map((column) => column.physicalName),
  ];
  return `SELECT ${columns.map(quoted).join(', ')}
            FROM north_star_module.${quoted(entity.physicalTableName)}
           WHERE ${predicates.length > 0 ? predicates.join(' AND ') : 'true'}
           ${suffix}`;
}

function archivePredicate(
  entity: StorageEntity,
  includeArchived: boolean,
): string[] {
  return includeArchived
    ? []
    : [`${quoted(entity.archive.archivedAtColumn)} IS NULL`];
}

function rawRecord(entity: StorageEntity, row: QueryResultRow): RawRecord {
  const revision = Number(row[entity.optimisticRevision.column]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw failure('MODULE_RECORD_MALFORMED', 'record revision is invalid');
  }
  const values = Object.fromEntries(
    entity.columns.map((column) => [
      column.canonicalFieldId,
      immutableDatabaseValue(row[column.physicalName]),
    ]),
  );
  return Object.freeze({
    archivedAt: (row[entity.archive.archivedAtColumn] ?? null) as
      Date | string | null,
    recordId: requiredUuid(row[entity.recordIdentity.column], 'recordId'),
    revision,
    values: Object.freeze(values),
  });
}

function toDto(
  entity: StorageEntity,
  record: RawRecord,
  selections?: readonly { readonly fieldId: string }[],
): SemanticRecordDto {
  const allowed = selections
    ? new Set(selections.map((selection) => selection.fieldId))
    : null;
  return Object.freeze({
    archived: record.archivedAt !== null,
    entityId: entity.entityId,
    recordId: record.recordId,
    revision: record.revision,
    values: Object.freeze(
      Object.fromEntries(
        Object.entries(record.values).filter(
          ([fieldId]) => allowed === null || allowed.has(fieldId),
        ),
      ),
    ),
  });
}

function queryResult(
  queryId: string,
  outcome: SemanticQueryResultEnvelope['outcome'],
  records: readonly SemanticRecordDto[],
  unsupportedReason: string | null,
): SemanticQueryResultEnvelope {
  return Object.freeze({
    kind: 'semanticQueryResult',
    outcome,
    queryId,
    records: Object.freeze([...records]),
    schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
    unsupportedReason,
  });
}

async function loadPinnedStorageTarget(
  client: PoolClient,
  request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
): Promise<StorageTargetPayloadV1> {
  const result = await client.query<ArtifactRow>(
    `SELECT artifact_kind, content_hash, domain_tag, media_type, canonical_bytes
       FROM platform.read_tenant_release_artifacts($1)`,
    [request.view.release.releaseId],
  );
  const artifacts = new Map(result.rows.map((row) => [row.content_hash, row]));
  for (const artifact of artifacts.values()) verifyArtifact(artifact);
  const root = artifacts.get(request.view.release.contentHash);
  if (!root || root.artifact_kind !== 'releaseManifest') {
    throw failure(
      'MODULE_PINNED_RELEASE_MISSING',
      'pinned release manifest is not tenant-visible',
    );
  }
  const manifest = decodeCanonical(root.canonical_bytes);
  const projections = Array.isArray(manifest.projections)
    ? manifest.projections
    : [];
  const reference = projections.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (
    !reference ||
    typeof reference.artifactRoot !== 'string' ||
    reference.payloadSchemaVersion !== STORAGE_TARGET_PAYLOAD_VERSION
  ) {
    throw failure(
      'MODULE_STORAGE_PROJECTION_MISSING',
      'pinned release has no supported storage target',
    );
  }
  const projectionArtifact = artifacts.get(reference.artifactRoot);
  if (
    !projectionArtifact ||
    projectionArtifact.artifact_kind !== 'projectionManifest'
  ) {
    throw failure(
      'MODULE_STORAGE_PROJECTION_MISSING',
      'storage projection manifest is missing',
    );
  }
  const projection = decodeCanonical(projectionArtifact.canonical_bytes);
  if (
    projection.familyId !== PROJECTION_FAMILY_IDS.storageTarget ||
    projection.payloadSchemaVersion !== STORAGE_TARGET_PAYLOAD_VERSION ||
    !Array.isArray(projection.chunks) ||
    projection.chunks.length !== 1 ||
    !isRecord(projection.chunks[0]) ||
    typeof projection.chunks[0].contentHash !== 'string'
  ) {
    throw failure(
      'MODULE_STORAGE_PROJECTION_MALFORMED',
      'storage projection manifest is malformed',
    );
  }
  const chunk = artifacts.get(projection.chunks[0].contentHash);
  if (!chunk || chunk.artifact_kind !== 'projectionChunk') {
    throw failure(
      'MODULE_STORAGE_PROJECTION_MISSING',
      'storage projection chunk is missing',
    );
  }
  const target = decodeCanonical(chunk.canonical_bytes);
  if (
    target.kind !== 'storageTargetPayload' ||
    target.schemaVersion !== STORAGE_TARGET_PAYLOAD_VERSION ||
    !Array.isArray(target.entities) ||
    !Array.isArray(target.relations) ||
    !isRecord(target.providerAbi) ||
    target.providerAbi.managedSchema !== 'north_star_module' ||
    target.providerAbi.runtimeRole !== 'north_star_module_runtime'
  ) {
    throw failure(
      'MODULE_STORAGE_TARGET_MALFORMED',
      'storage target does not match the provider ABI',
    );
  }
  return target as unknown as StorageTargetPayloadV1;
}

function verifyArtifact(artifact: ArtifactRow): void {
  if (
    artifact.media_type !== artifactMediaType ||
    !sha256Pattern.test(artifact.content_hash) ||
    hashBytes(artifact.domain_tag, artifact.canonical_bytes) !==
      artifact.content_hash
  ) {
    throw failure(
      'MODULE_ARTIFACT_DIGEST_MISMATCH',
      'pinned release artifact failed content verification',
    );
  }
  decodeCanonical(artifact.canonical_bytes);
}

function decodeCanonical(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder().decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || canonicalize(value) !== text) throw new Error();
    return value;
  } catch {
    throw failure(
      'MODULE_ARTIFACT_NOT_CANONICAL',
      'pinned release artifact is not canonical JSON',
    );
  }
}

async function withModuleRuntimeRole<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  const initial = await roleFacts(client);
  if (
    initial.currentRole !== 'north_star_runtime' ||
    initial.sessionRole !== 'north_star_runtime'
  ) {
    throw failure(
      'MODULE_ROLE_ASSUMPTION_SOURCE_INVALID',
      'module role assumption requires the trusted runtime login',
    );
  }
  await client.query('SET LOCAL ROLE north_star_module_runtime');
  const assumed = await roleFacts(client);
  if (
    assumed.currentRole !== 'north_star_module_runtime' ||
    assumed.sessionRole !== 'north_star_runtime' ||
    assumed.superuser ||
    assumed.bypassRls
  ) {
    throw failure(
      'MODULE_ROLE_ASSUMPTION_INVALID',
      'module DML role assumption violated least privilege',
    );
  }
  const result = await run();
  await client.query('RESET ROLE');
  const reset = await roleFacts(client);
  if (
    reset.currentRole !== 'north_star_runtime' ||
    reset.sessionRole !== 'north_star_runtime'
  ) {
    throw failure(
      'MODULE_ROLE_RESET_FAILED',
      'trusted runtime role was not restored before evidence writes',
    );
  }
  return result;
}

async function roleFacts(client: PoolClient): Promise<{
  bypassRls: boolean;
  currentRole: string;
  sessionRole: string;
  superuser: boolean;
}> {
  const result = await client.query<{
    bypass_rls: boolean;
    current_role: string;
    session_role: string;
    superuser: boolean;
  }>(
    `SELECT current_user AS current_role,
            session_user AS session_role,
            role.rolsuper AS superuser,
            role.rolbypassrls AS bypass_rls
       FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user`,
  );
  const row = result.rows[0];
  if (!row) throw failure('MODULE_ROLE_MISSING', 'database role is missing');
  return {
    bypassRls: row.bypass_rls,
    currentRole: row.current_role,
    sessionRole: row.session_role,
    superuser: row.superuser,
  };
}

function parseMutationInput(
  definition: RegisteredOperationDefinition,
  value: ImmutableJsonValue,
): MutationInput {
  const input = requireRecord(value, 'operation input');
  const recordId = requiredUuid(input.recordId, 'recordId');
  switch (definition.effect.kind) {
    case 'createRecordEffect':
      assertAllowedKeys(input, ['recordId', 'relations', 'values']);
      return {
        expectedRevision: null,
        patch: immutableRecord(input.values, 'values'),
        recordId,
        relations: uuidRecord(input.relations, 'relations'),
      };
    case 'updateRecordEffect':
      assertAllowedKeys(input, ['expectedRevision', 'patch', 'recordId']);
      return {
        expectedRevision: requiredRevision(input.expectedRevision),
        patch: immutableRecord(input.patch, 'patch'),
        recordId,
        relations: Object.freeze({}),
      };
    case 'archiveRecordEffect':
    case 'restoreRecordEffect':
      assertAllowedKeys(input, ['expectedRevision', 'recordId']);
      return {
        expectedRevision: requiredRevision(input.expectedRevision),
        patch: Object.freeze({}),
        recordId,
        relations: Object.freeze({}),
      };
  }
}

function createChanges(
  input: MutationInput,
): readonly BusinessFieldChangeInput[] {
  const changes: BusinessFieldChangeInput[] = [
    Object.freeze({
      classification: 'INTERNAL',
      fieldId: 'recordLifecycle',
      newState: valueState('created'),
      oldState: Object.freeze({ state: 'ABSENT' }),
    }),
  ];
  for (const [fieldId, value] of Object.entries(input.patch).sort(
    compareEntry,
  )) {
    changes.push(
      Object.freeze({
        classification: 'SENSITIVE',
        fieldId: auditFieldId(fieldId),
        newState: valueState(value),
        oldState: Object.freeze({ state: 'ABSENT' }),
      }),
    );
  }
  for (const [relationId, recordId] of Object.entries(input.relations).sort(
    compareEntry,
  )) {
    changes.push(
      Object.freeze({
        classification: 'SENSITIVE',
        fieldId: auditFieldId(relationId),
        newState: valueState(recordId),
        oldState: Object.freeze({ state: 'ABSENT' }),
      }),
    );
  }
  return Object.freeze(changes);
}

function updateChanges(
  prior: RawRecord,
  patch: Readonly<Record<string, ImmutableJsonValue>>,
): readonly BusinessFieldChangeInput[] {
  if (Object.keys(patch).length === 0) {
    throw failure('MODULE_PATCH_EMPTY', 'update patch must not be empty');
  }
  return Object.freeze(
    Object.entries(patch)
      .sort(compareEntry)
      .map(([fieldId, value]) =>
        Object.freeze({
          classification: 'SENSITIVE' as const,
          fieldId: auditFieldId(fieldId),
          newState: valueState(value),
          oldState: valueState(prior.values[fieldId] ?? null),
        }),
      ),
  );
}

function valueState(value: unknown): BusinessValueStateInput {
  return value === null
    ? Object.freeze({ state: 'CLEARED' })
    : Object.freeze({ state: 'VALUE', value });
}

function auditFieldId(canonicalId: string): string {
  const readable = canonicalId.replaceAll(/[^A-Za-z0-9_.-]/g, '.');
  return readable.length <= 120
    ? readable
    : `field.${createHash('sha256').update(canonicalId).digest('hex')}`;
}

function eventTypeFor(operationId: string): string {
  return operationId.includes(':operation.')
    ? operationId.replace(':operation.', ':event.')
    : `${operationId}.event`;
}

function classified(
  classification: 'INTERNAL' | 'PUBLIC',
  value: unknown,
): { classification: 'INTERNAL' | 'PUBLIC'; value: unknown } {
  return Object.freeze({ classification, value });
}

function requiredEntity(
  target: StorageTargetPayloadV1,
  entityId: string,
): StorageEntity {
  const entity = target.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  if (!entity) {
    throw failure('MODULE_ENTITY_UNSUPPORTED', 'entity has no storage target');
  }
  safeIdentifier(entity.physicalTableName);
  return entity;
}

function requireMutation(rowCount: number | null): void {
  if (rowCount !== 1) {
    throw failure(
      'MODULE_MUTATION_PRECONDITION_FAILED',
      'module mutation did not match one current record',
    );
  }
}

function parameter(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${String(values.length)}`;
}

function databaseValue(value: ImmutableJsonValue): unknown {
  if (Array.isArray(value) || isRecord(value)) {
    throw failure(
      'MODULE_VALUE_UNSUPPORTED',
      'ordinary module fields accept scalar values only',
    );
  }
  return value;
}

function immutableDatabaseValue(value: unknown): ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  throw failure('MODULE_VALUE_MALFORMED', 'database returned a non-DTO value');
}

function requireRecord(
  value: ImmutableJsonValue,
  name: string,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (!isRecord(value)) {
    throw failure('MODULE_INPUT_MALFORMED', `${name} must be an object`);
  }
  return value as Readonly<Record<string, ImmutableJsonValue>>;
}

function immutableRecord(
  value: ImmutableJsonValue | undefined,
  name: string,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (value === undefined) return Object.freeze({});
  return requireRecord(value, name);
}

function uuidRecord(
  value: ImmutableJsonValue | undefined,
  name: string,
): Readonly<Record<string, string>> {
  const record = immutableRecord(value, name);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        requiredUuid(entry, `${name}.${key}`),
      ]),
    ),
  );
}

function assertAllowedKeys(
  value: Readonly<Record<string, ImmutableJsonValue>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw failure('MODULE_INPUT_MALFORMED', 'operation input has unknown keys');
  }
}

function requiredRevision(value: ImmutableJsonValue | undefined): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw failure(
      'MODULE_INPUT_MALFORMED',
      'expectedRevision must be a positive safe integer',
    );
  }
  return Number(value);
}

function boundedLimit(
  value: ImmutableJsonValue | undefined,
  maximum: number,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw failure('MODULE_INPUT_MALFORMED', 'limit must be a positive integer');
  }
  return Math.min(Number(value), maximum);
}

function optionalBoolean(
  value: ImmutableJsonValue | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw failure('MODULE_INPUT_MALFORMED', 'includeArchived must be boolean');
  }
  return value;
}

function requiredSearchText(value: ImmutableJsonValue | undefined): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 240) {
    throw failure('MODULE_INPUT_MALFORMED', 'text must be non-blank');
  }
  return value.normalize('NFKC');
}

function optionalUuid(
  value: ImmutableJsonValue | undefined,
  name: string,
): string | null {
  return value === undefined ? null : requiredUuid(value, name);
}

function requiredUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw failure('MODULE_INPUT_MALFORMED', `${name} must be a UUID`);
  }
  return value;
}

function quoted(identifier: string): string {
  safeIdentifier(identifier);
  return `"${identifier}"`;
}

function safeIdentifier(identifier: string): void {
  if (!identifierPattern.test(identifier)) {
    throw failure(
      'MODULE_STORAGE_IDENTIFIER_INVALID',
      'storage identifier is invalid',
    );
  }
}

function hashBytes(domainTag: string, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(domainTag, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

function compareEntry(
  left: readonly [string, unknown],
  right: readonly [string, unknown],
): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string): ModuleRuntimeInterpreterError {
  return new ModuleRuntimeInterpreterError(code, message);
}
