import { createHash, randomUUID } from 'node:crypto';

import {
  PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_POSITION_PROFILE_VERSION,
  VERIFICATION_SENTINEL_PREFIX,
  canonicalize,
  unicodeCaseFold,
  type CanonicalScalar,
  type QueryFilterLoweringPlan,
} from '@north-star/canonical-model';
import {
  PROJECTION_FAMILY_IDS,
  SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS,
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
  RegisteredOperationInputContract,
  RegisteredRecordOperationDefinition,
  RegisteredTransitionOperationDefinition,
  RegisteredOperationSystemInput,
  SemanticOperationExecutionRequest,
  SemanticOperationExecutor,
  SemanticOperationNonAcceptedRequest,
  SemanticOperationParentGuard,
  SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  evaluateRegisteredOperationPrecondition,
} from '../../runtime/src/semantic-operation-gateway.js';
import type {
  RegisteredAggregateQueryDefinition,
  RegisteredQueryDefinition,
  SemanticAggregateQueryExecutionRequest,
  SemanticAggregateResultEnvelope,
  SemanticQueryExecutionRequest,
  SemanticQueryExecutor,
  SemanticQueryResultEnvelope,
  SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  SEMANTIC_AGGREGATE_RESULT_VERSION,
  SEMANTIC_QUERY_RESULT_VERSION,
} from '../../runtime/src/semantic-query-gateway.js';
import type {
  ImmutableJsonValue,
  LegalEntityReadScope,
} from '../../runtime/src/request-runtime-view.js';
import {
  encodeSharedListCursor,
  SHARED_LIST_RESULT_VERSION,
  SharedListContractError,
  sharedListFigureKinds,
  type AuthorizedSharedListRelationLabel,
  type AuthorizedSharedListReferenceLabel,
  type AuthorizedSharedListRequest,
  type SharedListBeforeFilter,
  type SharedListCoverage,
  type SharedListFigureOperand,
  type SharedListFigureThreshold,
  type SharedListFigureWithin,
} from '../../runtime/src/list-behavior/index.js';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import type { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

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
  systemInput: Readonly<{
    contract: RegisteredOperationSystemInput;
    value: string;
  }> | null;
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
  /** The target record ids of the relations a get was asked to state. */
  relationTargets?: Readonly<Record<string, string | null>>;
  revision: number;
  values: Readonly<Record<string, ImmutableJsonValue>>;
}

type StorageEntity = StorageTargetPayloadV1['entities'][number];

export interface StorageLegalEntityReadScopeRequirement {
  readonly column: string;
  readonly kind: 'legalEntity';
}

export interface AggregateCacheObservation {
  readonly cacheKey: string;
  readonly kind: 'anchor-discrepancy' | 'cache-hit' | 'ledger-recomputation';
  readonly queryId: string;
}

export interface ModuleProviderErrorMetadata {
  readonly columnName: string | null;
  readonly constraintName: string | null;
  readonly relationName: string | null;
  readonly sqlstate: string;
}

export interface ModuleProviderErrorMappingInput {
  readonly detail: string | null;
  readonly metadata: ModuleProviderErrorMetadata;
  readonly providerMessage: string;
  readonly subjectId: string;
}

export interface ModuleProviderErrorMappingResult {
  readonly code: string;
  readonly details: Readonly<Record<string, string>>;
  readonly message: string;
  readonly subjectId: string | null;
}

export interface ModuleProviderErrorMapping {
  readonly providerMessage: string;
  readonly sqlstate: string;
  translate(
    input: ModuleProviderErrorMappingInput,
  ): ModuleProviderErrorMappingResult | null;
}

interface VerifiedLegalEntityReadScope {
  readonly legalEntityIds: readonly string[];
}

export class ModuleRuntimeInterpreterError extends Error {
  override readonly name = 'ModuleRuntimeInterpreterError';
  readonly details: Readonly<Record<string, string>>;
  readonly providerMetadata: ModuleProviderErrorMetadata | null;

  constructor(
    readonly code: string,
    message: string,
    readonly subjectId: string | null = null,
    details: Readonly<Record<string, string>> = Object.freeze({}),
    providerMetadata: ModuleProviderErrorMetadata | null = null,
  ) {
    super(message);
    this.details = Object.freeze({ ...details });
    this.providerMetadata = providerMetadata
      ? Object.freeze({ ...providerMetadata })
      : null;
  }
}

/**
 * The only PostgreSQL interpreter for compiled Q0/Q1/O0 module projections.
 * Canonical registration stays data: no module name or handler appears here.
 */
export class PostgresModuleRuntimeInterpreter
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly #pinnedStorageTargets: ValidatedPinnedStorageTargetCache;
  readonly #providerErrorMappings: readonly ModuleProviderErrorMapping[];
  readonly #trust: PostgresTrustService;
  readonly #documentNumbers: DocumentNumberMode;

  constructor(
    private readonly pool: Pool,
    private readonly actorIssuer: TrustedActorEnvelopeIssuer,
    providerErrorMappings: readonly ModuleProviderErrorMapping[] = [],
    private readonly observeAggregateCache:
      | ((observation: AggregateCacheObservation) => void)
      | undefined = undefined,
    observePinnedStorageTargetCache:
      | ((observation: PinnedStorageTargetCacheObservation) => void)
      | undefined = undefined,
    options: { readonly documentNumbers?: DocumentNumberMode } = {},
  ) {
    this.#documentNumbers = options.documentNumbers ?? 'sequence';
    this.#pinnedStorageTargets = new ValidatedPinnedStorageTargetCache(
      observePinnedStorageTargetCache,
    );
    this.#providerErrorMappings = validatedProviderErrorMappings(
      providerErrorMappings,
    );
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
  ): Promise<SemanticOperationResultEnvelope | SemanticQueryResultEnvelope> {
    return 'arguments' in request
      ? this.#executeQuery(request).then((result) => {
          if (result.kind !== 'semanticQueryResult') {
            throw failure(
              'MODULE_QUERY_RESULT_INVALID',
              'record query returned an aggregate result',
              request.definition.queryId,
            );
          }
          return result;
        })
      : this.#executeOperation(request);
  }

  async executeAggregate(
    request: SemanticAggregateQueryExecutionRequest,
  ): Promise<SemanticAggregateResultEnvelope> {
    const result = await this.#executeQuery(request);
    if (result.kind !== 'semanticAggregateResult') {
      throw failure(
        'MODULE_AGGREGATE_RESULT_INVALID',
        'aggregate query returned a record result',
        request.definition.queryId,
      );
    }
    return result;
  }

  async recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    const actor = await this.actorIssuer.issue(request.context);
    const metadata: EvidenceMetadataInput = Object.freeze({
      operationId: classified('INTERNAL', request.operationId),
      requestKind: classified('INTERNAL', 'generic-o0'),
    });
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
    request:
      SemanticAggregateQueryExecutionRequest | SemanticQueryExecutionRequest,
  ): Promise<SemanticAggregateResultEnvelope | SemanticQueryResultEnvelope> {
    try {
      return await withTrustedRequestTransaction(
        this.pool,
        request.context,
        async (client) => {
          const storage = await this.#loadPinnedStorageTarget(client, request);
          return withModuleRuntimeRole(client, () =>
            executeQueryOnClient(
              client,
              storage,
              request,
              this.observeAggregateCache,
            ),
          );
        },
      );
    } catch (error) {
      throw providerBoundaryFailure(
        error,
        request.definition.sourceEntityId,
        this.#providerErrorMappings,
      );
    }
  }

  async #executeOperation(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    const parsedInput = parseMutationInput(request.definition, request.input);
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
        const currentStorage = await this.#loadPinnedStorageTarget(
          client,
          request,
        );
        const currentEntity = requiredEntity(
          currentStorage,
          request.definition.effect.entity.targetId,
        );
        assertOperationSystemInputStorageContract(
          request.definition,
          currentEntity,
          parsedInput,
        );
        return withModuleRuntimeRole(client, async () => {
          try {
            await requireActiveCreateLegalEntity(
              client,
              currentStorage,
              currentEntity,
              request.definition,
              parsedInput,
            );
            // Assigned before the change is prepared, so the change document
            // records the number the record is created with.
            const input = await assignDocumentNumbers(
              client,
              currentEntity,
              request.definition,
              parsedInput,
              this.#documentNumbers,
            );
            const preparation = await prepareMutation(
              client,
              request,
              currentEntity,
              input,
            );
            const ids = {
              changeDocumentId: randomUUID(),
              correlationId: randomUUID(),
              eventId: randomUUID(),
              invocationId: randomUUID(),
              outboxId: randomUUID(),
            };
            const mutationResult = await executeMutationOnClient(
              client,
              currentStorage,
              currentEntity,
              request,
              input,
              request.readBackDefinition.selections,
            );
            return Object.freeze({
              command: acceptedCommand(request, preparation, ids),
              mutationResult,
            });
          } catch (error) {
            throw translateModuleProviderError(
              error,
              currentStorage,
              currentEntity.entityId,
              this.#providerErrorMappings,
            );
          }
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

  #loadPinnedStorageTarget(
    client: PoolClient,
    request:
      | SemanticAggregateQueryExecutionRequest
      | SemanticOperationExecutionRequest
      | SemanticQueryExecutionRequest,
  ): Promise<StorageTargetPayloadV1> {
    const key = pinnedStorageTargetCacheKey(request);
    return this.#pinnedStorageTargets.get(key, (observeValidation) =>
      loadPinnedStorageTarget(client, request, observeValidation),
    );
  }
}

export interface PinnedStorageTargetCacheKey {
  readonly contentHash: string;
  readonly environmentId: string;
  readonly releaseId: string;
  readonly tenantId: string;
}

export interface PinnedStorageTargetCacheObservation {
  readonly key: PinnedStorageTargetCacheKey;
  readonly kind:
    | 'cacheCoalesced'
    | 'cacheHit'
    | 'cacheMiss'
    | 'cachePopulated'
    | 'canonicalArtifactsDecoded'
    | 'schemaValidated'
    | 'tenantVisibleArtifactsRead'
    | 'artifactHashesVerified';
}

type PinnedStorageTargetValidationObservation = (
  kind:
    | 'canonicalArtifactsDecoded'
    | 'schemaValidated'
    | 'tenantVisibleArtifactsRead'
    | 'artifactHashesVerified',
) => void;

class ValidatedPinnedStorageTargetCache {
  readonly #inFlight = new Map<string, Promise<StorageTargetPayloadV1>>();
  readonly #validated = new Map<string, StorageTargetPayloadV1>();

  constructor(
    private readonly observe:
      ((observation: PinnedStorageTargetCacheObservation) => void) | undefined,
  ) {}

  get(
    key: PinnedStorageTargetCacheKey,
    load: (
      observeValidation: PinnedStorageTargetValidationObservation,
    ) => Promise<StorageTargetPayloadV1>,
  ): Promise<StorageTargetPayloadV1> {
    const identity = pinnedStorageTargetCacheIdentity(key);
    const validated = this.#validated.get(identity);
    if (validated) {
      this.#notify(key, 'cacheHit');
      return Promise.resolve(validated);
    }
    const inFlight = this.#inFlight.get(identity);
    if (inFlight) {
      this.#notify(key, 'cacheCoalesced');
      return inFlight;
    }

    this.#notify(key, 'cacheMiss');
    const loading = (async () => {
      try {
        const target = await load((kind) => this.#notify(key, kind));
        this.#validated.set(identity, target);
        this.#notify(key, 'cachePopulated');
        return target;
      } finally {
        this.#inFlight.delete(identity);
      }
    })();
    this.#inFlight.set(identity, loading);
    return loading;
  }

  #notify(
    key: PinnedStorageTargetCacheKey,
    kind: PinnedStorageTargetCacheObservation['kind'],
  ): void {
    this.observe?.(Object.freeze({ key, kind }));
  }
}

function pinnedStorageTargetCacheKey(
  request:
    | SemanticAggregateQueryExecutionRequest
    | SemanticOperationExecutionRequest
    | SemanticQueryExecutionRequest,
): PinnedStorageTargetCacheKey {
  return Object.freeze({
    contentHash: request.view.release.contentHash,
    environmentId: request.context.environmentId,
    releaseId: request.view.release.releaseId,
    tenantId: request.context.tenantId,
  });
}

function pinnedStorageTargetCacheIdentity(
  key: PinnedStorageTargetCacheKey,
): string {
  return JSON.stringify([
    key.tenantId,
    key.environmentId,
    key.releaseId,
    key.contentHash,
  ]);
}

async function prepareMutation(
  client: PoolClient,
  request: SemanticOperationExecutionRequest,
  entity: StorageEntity,
  input: MutationInput,
): Promise<MutationPreparation> {
  const kind = request.definition.effect.kind;
  if (kind === 'createRecordEffect') {
    // Candidate image. A create that would forge a terminal state must refuse
    // on the record it is about to write, not on one that does not exist yet.
    requirePrecondition(
      request.definition.precondition,
      input.patch,
      'candidate',
    );
    return {
      changes: createChanges(request.definition.inputContract, input),
      expectedRevision: null,
      projectedRevision: 1,
      recordId: input.recordId,
    };
  }
  const prior = await loadRawRecord(client, entity, input.recordId, true, []);
  if (!prior) {
    throw failure('MODULE_RECORD_NOT_FOUND', 'module record was not found');
  }
  if (prior.revision !== input.expectedRevision) {
    throw failure(
      'MODULE_REVISION_CONFLICT',
      'module record revision does not match expectedRevision',
    );
  }
  // Prior image, for every effect that consumes an existing record. This is
  // what stops a mutation of already-terminal evidence.
  requirePrecondition(request.definition.precondition, prior.values, 'prior');
  if (kind === 'updateRecordEffect') {
    // Projected image, a SEPARATE obligation. Without it an update could move
    // a record INTO the guarded state -- the prior image passes, and the row
    // lands terminal by press rather than by the sanctioned writer.
    requirePrecondition(
      request.definition.precondition,
      { ...prior.values, ...input.patch },
      'projected',
    );
  }
  const changes =
    kind === 'updateRecordEffect'
      ? updateChanges(request.definition.inputContract, prior, input.patch)
      : // A transition's change document records the state move, not an
        // archive flip. The old and new states are both compiled, so the
        // document cannot disagree with what the UPDATE pinned.
        kind === 'transitionStateEffect' &&
          request.definition.effect.kind === 'transitionStateEffect'
        ? [
            Object.freeze({
              classification: 'INTERNAL' as const,
              fieldId: auditFieldId(request.definition.effect.stateFieldId),
              newState: valueState(request.definition.effect.toStateId),
              oldState: valueState(request.definition.effect.fromStateId),
            }),
          ]
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

/**
 * Evaluates a compiled operation precondition against one record image.
 *
 * The kernel owns Boolean composition and absence; this resolver supplies only
 * present-value truth, so the provider cannot fork F1. A comparison this
 * resolver cannot decide is an ERROR, never `absent` -- absence is a real
 * semantic answer (`false` under the position profile), and quietly reporting
 * it for an unreadable value would turn `not(equals)` into a pass. That is the
 * fail-open direction for exactly the guard this exists to enforce.
 */
function requirePrecondition(
  precondition: Readonly<Record<string, ImmutableJsonValue>>,
  image: Readonly<Record<string, ImmutableJsonValue>>,
  imageLabel: 'candidate' | 'parent' | 'prior' | 'projected',
): void {
  const evaluation = evaluateRegisteredOperationPrecondition(
    precondition,
    image,
  );
  if (evaluation.outcome === 'unsupported') {
    throw failure(
      'MODULE_OPERATION_PRECONDITION_UNSUPPORTED',
      `operation precondition is not executable on the ${imageLabel} image`,
    );
  }
  if (evaluation.outcome === 'refused') {
    throw failure(
      'MODULE_OPERATION_PRECONDITION_REFUSED',
      `operation precondition does not hold on the ${imageLabel} image`,
    );
  }
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
    channel: request.channel,
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
      deduplicationKey: [
        request.context.principalId,
        request.view.release.contentHash,
        request.view.release.releaseId,
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

async function executeMutationOnClient(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  request: SemanticOperationExecutionRequest,
  input: MutationInput,
  readBackSelections: readonly { readonly fieldId: string }[],
): Promise<SemanticRecordDto> {
  const definition = request.definition;
  switch (definition.effect.kind) {
    case 'createRecordEffect':
      await insertRecord(client, storage, entity, input, request.parentGuards);
      break;
    case 'updateRecordEffect':
      await requireExistingParentGuards(
        client,
        storage,
        entity,
        input.recordId,
        request.parentGuards,
      );
      await updateRecord(client, entity, input);
      break;
    case 'archiveRecordEffect':
      await requireExistingParentGuards(
        client,
        storage,
        entity,
        input.recordId,
        request.parentGuards,
      );
      await setArchiveState(client, storage, entity, input, true);
      break;
    case 'restoreRecordEffect':
      await requireExistingParentGuards(
        client,
        storage,
        entity,
        input.recordId,
        request.parentGuards,
      );
      await setArchiveState(client, storage, entity, input, false);
      break;
    case 'transitionStateEffect':
      await requireExistingParentGuards(
        client,
        storage,
        entity,
        input.recordId,
        request.parentGuards,
      );
      await transitionRecordState(client, entity, request.definition, input);
      break;
  }
  const record = await loadRawRecord(client, entity, input.recordId, true, []);
  if (!record) {
    throw failure(
      'MODULE_MUTATION_READ_BACK_MISSING',
      'successful module mutation had no read-back record',
    );
  }
  return toDto(entity, record, readBackSelections);
}

/**
 * `sequence` assigns real document numbers; `verificationSentinel` is used only
 * by release verification, whose arranged records must not consume them.
 */
export type DocumentNumberMode = 'sequence' | 'verificationSentinel';

/**
 * The number a numbered field takes in `verificationSentinel` mode: the
 * sentinel prefix, a hyphen and the hexadecimal SHA-256 of the record id and
 * the field, cut to the column's length. It depends on nothing the create
 * decides, so release verification knows the number of a record it arranged
 * even when no read of that record selects the field.
 */
export function verificationSentinelNumber(
  recordId: string,
  fieldId: string,
  maximumLength: number | null,
): string {
  const sentinel = `${VERIFICATION_SENTINEL_PREFIX}-${createHash('sha256')
    .update(recordId, 'utf8')
    .update(Uint8Array.of(0))
    .update(fieldId, 'utf8')
    .digest('hex')}`;
  return maximumLength === null ? sentinel : sentinel.slice(0, maximumLength);
}

/**
 * A create's server-assigned document numbers (canonical field `numbering`):
 * the next value of each named sequence per tenant and environment. One
 * allocator runs at a time per sequence -- the transaction-scoped lock is held
 * to commit, so concurrent creates serialize and a rolled-back create gives
 * its number back. The next value follows the highest existing number of that
 * prefix among ALL of the tenant's records, archived and in every company,
 * whatever its digit count (leading zeros included), so a number is never
 * reused. Stored values are read through the business key's own fold -- its
 * stored folded companion, the column its unique index covers -- so a value
 * the key equates with the next number (`ſO-000016` and `SO-000016`) is
 * counted without folding every row again; the key's unique index, over live
 * records of its scope, remains the backstop. A next number that no longer fits
 * its field refuses by name. A replay of the same idempotency key never reaches
 * this, so a retry keeps its number.
 */
async function assignDocumentNumbers(
  client: PoolClient,
  entity: StorageEntity,
  definition: SemanticOperationExecutionRequest['definition'],
  input: MutationInput,
  mode: DocumentNumberMode,
): Promise<MutationInput> {
  const assigned =
    definition.effect.kind === 'createRecordEffect'
      ? (definition.inputContract?.assignedFields ?? [])
      : [];
  if (assigned.length === 0) return input;
  const patch: Record<string, ImmutableJsonValue> = { ...input.patch };
  for (const field of assigned) {
    if (Object.hasOwn(patch, field.fieldId))
      throw failure(
        'MODULE_FIELD_UNSUPPORTED',
        'an assigned document number is not an operation input',
        field.fieldId,
      );
    const column = entity.columns.find(
      (candidate) => candidate.canonicalFieldId === field.fieldId,
    );
    if (!column || column.fieldContract.fieldKind !== 'textFieldType')
      throw failure(
        'MODULE_FIELD_UNSUPPORTED',
        'an assigned document number has no compiled text column',
        field.fieldId,
      );
    if (mode === 'verificationSentinel') {
      // Release verification arranges records to exercise a release; it asks
      // no business question and must not consume a tenant's document numbers.
      // Its number is a `V-` sentinel hashed from the record id and field, at
      // least 64 bits of it (the numbering contract's width floor), so
      // arranged records collide only with negligible probability. No sequence
      // may use the prefix (the contract reserves it), so a sentinel is never a
      // business number.
      patch[field.fieldId] = verificationSentinelNumber(
        input.recordId,
        field.fieldId,
        column.fieldContract.bounds.maximumLength,
      );
      continue;
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         north_star_internal.trusted_tenant_id()::text || ':' ||
         north_star_internal.trusted_environment_id()::text || ':' || $1, 0))`,
      [field.sequenceId],
    );
    const highest = await client.query<{ highest: string | null }>(
      `SELECT max(((regexp_match(${foldedColumnSql(entity, column)}, $1))[1])::numeric)::text AS highest
         FROM north_star_module.${quoted(entity.physicalTableName)}
        WHERE tenant_id = north_star_internal.trusted_tenant_id()
          AND environment_id = north_star_internal.trusted_environment_id()`,
      [`^${unicodeCaseFold(field.prefix)}-([0-9]+)$`],
    );
    const observed = highest.rows[0]?.highest ?? null;
    const next =
      observed === null || BigInt(observed) < BigInt(field.start)
        ? BigInt(field.start)
        : BigInt(observed) + 1n;
    const number = `${field.prefix}-${next.toString().padStart(field.minimumDigits, '0')}`;
    const maximumLength = column.fieldContract.bounds.maximumLength;
    if (maximumLength !== null && number.length > maximumLength)
      throw failure(
        'MODULE_DOCUMENT_SEQUENCE_EXHAUSTED',
        'the next document number no longer fits its field',
        field.fieldId,
      );
    patch[field.fieldId] = number;
  }
  return Object.freeze({ ...input, patch: Object.freeze(patch) });
}

async function insertRecord(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  input: MutationInput,
  parentGuards: readonly SemanticOperationParentGuard[],
): Promise<void> {
  const columns = ['tenant_id', 'environment_id', entity.recordIdentity.column];
  const values: unknown[] = [];
  const parameters = [
    'north_star_internal.trusted_tenant_id()',
    'north_star_internal.trusted_environment_id()',
    parameter(values, input.recordId),
  ];
  if (input.systemInput) {
    columns.push(input.systemInput.contract.physicalColumn);
    parameters.push(parameter(values, input.systemInput.value));
  }
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
    (relation) =>
      relation.sourceEntityId === entity.entityId &&
      relation.relationColumn.origin !== 'field',
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
    await requireRelationTarget(
      client,
      storage,
      relation,
      recordId,
      parentGuards,
    );
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
  if (new Set(columns).size !== columns.length) {
    throw failure(
      'MODULE_STORAGE_COLUMN_AUTHORITY_CONFLICT',
      'module create input produced more than one authority for a storage column',
      entity.entityId,
    );
  }
  await client.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (${columns.map(quoted).join(', ')})
     VALUES (${parameters.join(', ')})`,
    values,
  );
}

async function requireExistingParentGuards(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  recordId: string,
  parentGuards: readonly SemanticOperationParentGuard[],
): Promise<void> {
  const relations = storage.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entityId &&
      relation.ownership === 'parentScopedChild',
  );
  for (const relation of relations) {
    const result = await client.query<QueryResultRow>(
      `SELECT ${quoted(relation.relationColumn.physicalName)} AS parent_record_id
         FROM north_star_module.${quoted(entity.physicalTableName)}
        WHERE tenant_id = north_star_internal.trusted_tenant_id()
          AND environment_id = north_star_internal.trusted_environment_id()
          AND ${quoted(entity.recordIdentity.column)} = $1
        LIMIT 1`,
      [recordId],
    );
    if (result.rowCount !== 1) {
      throw failure(
        'MODULE_RECORD_NOT_FOUND',
        'module record was not found while resolving its parent guard',
      );
    }
    const parentRecordId = result.rows[0]?.parent_record_id;
    if (parentRecordId === null && relation.relationColumn.nullable) continue;
    await requireRelationTarget(
      client,
      storage,
      relation,
      requiredUuid(parentRecordId, 'parentRecordId'),
      parentGuards,
    );
  }
}

async function requireRelationTarget(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  relation: StorageTargetPayloadV1['relations'][number],
  recordId: string,
  parentGuards: readonly SemanticOperationParentGuard[],
): Promise<void> {
  const target = requiredEntity(storage, relation.targetEntityId);
  const values: unknown[] = [];
  const result = await client.query<QueryResultRow>(
    selectSql(
      target,
      [
        `${quoted(target.recordIdentity.column)} = ${parameter(values, recordId)}`,
      ],
      'LIMIT 1 FOR SHARE',
    ),
    values,
  );
  const parent = result.rows[0] ? rawRecord(target, result.rows[0]) : null;
  if (!parent) {
    throw failure(
      'MODULE_RELATION_TARGET_NOT_FOUND',
      'relation target was not found',
    );
  }
  if (relation.archiveBehavior === 'restrict' && parent.archivedAt !== null) {
    throw failure(
      'MODULE_RELATION_VIOLATION',
      'relation target cannot accept active dependents',
      relation.relationId,
    );
  }
  if (relation.ownership === 'parentScopedChild') {
    for (const guard of parentGuards.filter(
      (candidate) => candidate.parentEntityId === target.entityId,
    )) {
      requirePrecondition(guard.precondition, parent.values, 'parent');
    }
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

/**
 * The transition writer. Everything a named document transition needs is
 * already here in the generic press and none of it is new:
 *
 *  - the target is `effect.toStateId`, a COMPILED constant. The caller's input
 *    is `['expectedRevision','recordId']` and carries no patch at all, so there
 *    is no argument through which a target could be supplied.
 *  - `expectedRevision` pins the row, exactly as `updateRecord` does.
 *  - `fromStateId` pins the prior state IN THE SAME `WHERE`, so a concurrent
 *    winner leaves this statement matching zero rows.
 *  - one `UPDATE`, `requireMutation` on the row count: written exactly once.
 */
async function transitionRecordState(
  client: PoolClient,
  entity: StorageEntity,
  definition: SemanticOperationExecutionRequest['definition'],
  input: MutationInput,
): Promise<void> {
  if (definition.effect.kind !== 'transitionStateEffect') {
    throw failure('MODULE_FIELD_UNSUPPORTED', 'effect is not a transition');
  }
  const effect = definition.effect;
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === effect.stateFieldId,
  );
  if (!column) {
    throw failure(
      'MODULE_FIELD_UNSUPPORTED',
      `state field ${effect.stateFieldId} has no column`,
    );
  }
  const values: unknown[] = [];
  const result = await client.query(
    `UPDATE north_star_module.${quoted(entity.physicalTableName)}
        SET ${quoted(column.physicalName)} = ${parameter(values, effect.toStateId)},
            ${quoted(entity.optimisticRevision.column)} = ${quoted(entity.optimisticRevision.column)} + 1
      WHERE ${quoted(entity.recordIdentity.column)} = ${parameter(values, input.recordId)}
        AND ${quoted(entity.optimisticRevision.column)} = ${parameter(values, input.expectedRevision)}
        AND ${quoted(column.physicalName)} = ${parameter(values, effect.fromStateId)}
        AND ${quoted(entity.archive.archivedAtColumn)} IS NULL`,
    values,
  );
  requireMutation(result.rowCount);
}

async function setArchiveState(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  input: MutationInput,
  archive: boolean,
): Promise<void> {
  await lockLifecycleRecord(client, entity, input.recordId);
  if (archive) {
    await assertNoActiveDependents(client, storage, entity, input.recordId);
  } else {
    await assertRestorableRelations(client, storage, entity, input.recordId);
  }
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

async function lockLifecycleRecord(
  client: PoolClient,
  entity: StorageEntity,
  recordId: string,
): Promise<void> {
  await client.query(
    `SELECT 1
       FROM north_star_module.${quoted(entity.physicalTableName)}
      WHERE ${quoted(entity.recordIdentity.column)} = $1
      FOR NO KEY UPDATE`,
    [recordId],
  );
}

async function assertNoActiveDependents(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  recordId: string,
): Promise<void> {
  for (const relation of storage.relations.filter(
    (entry) =>
      entry.targetEntityId === entity.entityId &&
      entry.archiveBehavior === 'restrict',
  )) {
    const source = requiredEntity(storage, relation.sourceEntityId);
    const result = await client.query(
      `SELECT 1
         FROM north_star_module.${quoted(source.physicalTableName)}
        WHERE ${quoted(relation.relationColumn.physicalName)} = $1
          AND ${quoted(source.archive.archivedAtColumn)} IS NULL
        LIMIT 1`,
      [recordId],
    );
    if (result.rowCount === 1) {
      throw failure(
        'MODULE_ARCHIVE_RESTRICTED',
        'record has active dependent records',
        relation.relationId,
      );
    }
  }
}

async function assertRestorableRelations(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  recordId: string,
): Promise<void> {
  for (const relation of storage.relations.filter(
    (entry) =>
      entry.sourceEntityId === entity.entityId &&
      entry.archiveBehavior === 'restrict',
  )) {
    const result = await client.query<QueryResultRow>(
      `SELECT ${quoted(relation.relationColumn.physicalName)} AS target_record_id
         FROM north_star_module.${quoted(entity.physicalTableName)}
        WHERE ${quoted(entity.recordIdentity.column)} = $1
        LIMIT 1`,
      [recordId],
    );
    if (result.rowCount !== 1) {
      throw failure(
        'MODULE_RECORD_NOT_FOUND',
        'module record was not found while resolving its restore relations',
      );
    }
    const targetRecordId = result.rows[0]?.target_record_id;
    if (targetRecordId === null) continue;
    await requireRelationTarget(
      client,
      storage,
      relation,
      requiredUuid(targetRecordId, 'targetRecordId'),
      [],
    );
  }
}

async function executeQueryOnClient(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  request:
    SemanticAggregateQueryExecutionRequest | SemanticQueryExecutionRequest,
  observeAggregateCache:
    ((observation: AggregateCacheObservation) => void) | undefined,
): Promise<SemanticAggregateResultEnvelope | SemanticQueryResultEnvelope> {
  const { arguments: argumentValue, definition, filterPlans, list } = request;
  const entity = requiredEntity(storage, definition.sourceEntityId);
  const relationPlans =
    definition.queryType === 'list' && list
      ? [
          ...list.relationLabels.map((authorization, index) =>
            listRelationPlan(storage, entity, authorization, index),
          ),
          ...(list.referenceLabels ?? []).map((reference, index) =>
            listReferencePlan(
              storage,
              entity,
              reference,
              list.relationLabels.length + index,
            ),
          ),
        ]
      : [];
  const progressPlan =
    definition.queryType === 'list' && list
      ? listProgressPlan(storage, entity, list)
      : null;
  const figuresPlan =
    definition.queryType === 'list' && list
      ? listFiguresPlan(storage, entity, list)
      : null;
  const readScope = await verifyLegalEntityReadScope(
    client,
    storage,
    request.legalEntityReadScope,
    [
      entity,
      ...relationPlans.map((plan) => plan.target),
      ...(progressPlan ? [progressPlan.lines, progressPlan.done] : []),
      ...(figuresPlan?.entities ?? []),
    ],
  );
  if (definition.queryType === 'aggregate') {
    return executeAggregateQuery(
      client,
      entity,
      request as SemanticAggregateQueryExecutionRequest,
      readScope,
      observeAggregateCache,
    );
  }
  if (!definition.infrastructure) {
    return queryResult(
      definition.queryId,
      'unsupported',
      [],
      'query-contract-unsupported',
    );
  }
  const args = requireRecord(argumentValue, 'query arguments');
  const includeArchived = optionalBoolean(args.includeArchived, false);
  let records: RawRecord[];
  switch (definition.queryType) {
    case 'get': {
      const recordId = requiredUuid(args.recordId, 'recordId');
      const targets = relationTargetPlans(
        storage,
        entity,
        args.relationTargets,
      );
      const record = await loadScopedRawRecord(
        client,
        entity,
        recordId,
        includeArchived,
        filterPlans,
        readScope,
        targets,
      );
      records = record ? [record] : [];
      return queryResult(
        definition.queryId,
        records.length === 1 ? 'exact' : 'not-found',
        records.map((entry) =>
          withRelationTargets(
            toDto(entity, entry, definition.selections),
            entry,
            targets,
          ),
        ),
        null,
      );
    }
    case 'list': {
      if (list) {
        return listSharedRecords(
          client,
          entity,
          definition,
          list,
          filterPlans,
          relationPlans,
          readScope,
          parentScopePlan(storage, entity, list),
          relatedFilterPlan(storage, entity, list),
          progressPlan,
          figuresPlan,
        );
      }
      const limit = boundedLimit(args.limit, definition.maximumResultCount);
      const afterRecordId = optionalUuid(args.afterRecordId, 'afterRecordId');
      records = await listRecords(
        client,
        entity,
        includeArchived,
        limit,
        afterRecordId,
        filterPlans,
        readScope,
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
      const matchMode = optionalSearchMatchMode(args.matchMode);
      const limit = boundedLimit(args.limit, definition.maximumResultCount);
      records = await matchRecords(
        client,
        entity,
        definition,
        text,
        matchMode,
        includeArchived,
        limit,
        filterPlans,
        readScope,
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
        filterPlans,
        readScope,
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

async function executeAggregateQuery(
  client: PoolClient,
  entity: StorageEntity,
  request: SemanticAggregateQueryExecutionRequest,
  readScope: VerifiedLegalEntityReadScope | null,
  observeAggregateCache:
    ((observation: AggregateCacheObservation) => void) | undefined,
): Promise<SemanticAggregateResultEnvelope> {
  const { definition, filterPlans, parameterValues } = request;
  const aggregate = definition.aggregate;
  if (
    !aggregate ||
    aggregate.operator !== 'sum' ||
    !definition.aggregatePlan ||
    definition.aggregatePlan.costClass !== 'tenantBoundedScan'
  ) {
    throw failure(
      'MODULE_AGGREGATE_CONTRACT_INVALID',
      'aggregate query does not carry the required sum lowering contract',
      definition.queryId,
    );
  }
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === aggregate.fieldId,
  );
  const scale = Number(aggregate.resultType.scale);
  const sourceFieldType = definition.aggregatePlan.sourceFieldType;
  const quantitySource = sourceFieldType.kind === 'quantityFieldType';
  const quantityResult =
    aggregate.resultType.kind === 'quantityAggregateResultType';
  if (
    !column ||
    (column.fieldContract.fieldKind !== 'exactDecimalFieldType' &&
      column.fieldContract.fieldKind !== 'quantityFieldType') ||
    !fieldTypeMatchesPhysicalContract(sourceFieldType, column.fieldContract) ||
    quantitySource !== quantityResult ||
    column.nullable ||
    column.fieldContract.bounds.scale !== scale ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 18
  ) {
    throw failure(
      'MODULE_AGGREGATE_CONTRACT_INVALID',
      'aggregate source does not match the compiled required exact-numeric contract',
      aggregate.fieldId,
    );
  }

  // The anchor contract is scoped by an issued business dimension. Existing
  // tenant-shared aggregates retain their uncached behavior.
  if (!readScope) {
    return executeAggregateLedgerQuery(
      client,
      entity,
      definition,
      filterPlans,
      parameterValues,
      readScope,
    );
  }

  await client.query(
    'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
    [
      aggregateGenerationLockKey(
        request.context.tenantId,
        request.context.environmentId,
      ),
    ],
  );
  const movementGeneration = await loadAggregateMovementGeneration(
    client,
    request.context.tenantId,
    request.context.environmentId,
  );
  const identity = aggregateCacheIdentity(
    request,
    readScope,
    movementGeneration,
  );
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    identity.cacheKey,
  ]);
  const anchor = await loadAggregateAnchor(client, identity);
  if (anchor) {
    const cached = aggregateResultFromAnchor(definition.queryId, anchor);
    const expectedAnchorDigest = aggregateAnchorDigest(identity, cached);
    const anchorIntegrityMatches =
      aggregateAnchorMatchesIdentity(anchor, identity) &&
      anchor.anchor_digest === expectedAnchorDigest;
    if (anchorIntegrityMatches) {
      observeAggregateCacheSafely(observeAggregateCache, {
        cacheKey: identity.cacheKey,
        kind: 'cache-hit',
        queryId: definition.queryId,
      });
      // Victim for the cache-hit control: deleting this return makes every
      // consistent anchor fall through to a ledger recomputation.
      return cached;
    }
    const recomputed = await executeAggregateLedgerQuery(
      client,
      entity,
      definition,
      filterPlans,
      parameterValues,
      readScope,
    );
    observeAggregateCacheSafely(observeAggregateCache, {
      cacheKey: identity.cacheKey,
      kind: 'ledger-recomputation',
      queryId: definition.queryId,
    });
    await recordAggregateAnchorDiscrepancy(
      client,
      identity,
      anchor,
      expectedAnchorDigest,
      recomputed,
    );
    observeAggregateCacheSafely(observeAggregateCache, {
      cacheKey: identity.cacheKey,
      kind: 'anchor-discrepancy',
      queryId: definition.queryId,
    });
    if (!anchorIntegrityMatches) {
      // Victim for the no-stale-answer control: deleting this line falls
      // through to the preserved (and deliberately bad) cached value.
      return recomputed;
    }
    return cached;
  }

  const recomputed = await executeAggregateLedgerQuery(
    client,
    entity,
    definition,
    filterPlans,
    parameterValues,
    readScope,
  );
  observeAggregateCacheSafely(observeAggregateCache, {
    cacheKey: identity.cacheKey,
    kind: 'ledger-recomputation',
    queryId: definition.queryId,
  });
  await insertAggregateAnchor(client, identity, recomputed);
  return recomputed;
}

async function executeAggregateLedgerQuery(
  client: PoolClient,
  entity: StorageEntity,
  definition: RegisteredAggregateQueryDefinition,
  filterPlans: readonly QueryFilterLoweringPlan[],
  parameterValues: Readonly<Record<string, ImmutableJsonValue>>,
  readScope: VerifiedLegalEntityReadScope | null,
): Promise<SemanticAggregateResultEnvelope> {
  const aggregate = definition.aggregate;
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === aggregate.fieldId,
  );
  const scale = Number(aggregate.resultType.scale);
  if (!column) {
    throw failure(
      'MODULE_AGGREGATE_CONTRACT_INVALID',
      'aggregate source has no compiled storage column',
      aggregate.fieldId,
    );
  }
  const values: unknown[] = [];
  const predicates = archivePredicate(entity, false);
  appendLegalEntityReadScopePredicate(entity, readScope, values, predicates);
  appendQueryFilterPredicates(
    entity,
    filterPlans,
    values,
    predicates,
    undefined,
    parameterValues,
  );
  let result;
  try {
    result = await client.query<{ aggregate_value: string }>(
      `SELECT COALESCE(SUM(${quoted(column.physicalName)}), 0)::numeric(38,${String(scale)})::text AS aggregate_value
         FROM north_star_module.${quoted(entity.physicalTableName)}
        WHERE ${predicates.join(' AND ')}`,
      values,
    );
  } catch (error) {
    if (providerErrorProperty(error, 'code') === '22003') {
      throw failure(
        'MODULE_AGGREGATE_NUMERIC_OVERFLOW',
        'aggregate sum exceeds precision 38',
        aggregate.selectionId,
      );
    }
    throw error;
  }
  const value = result.rows[0]?.aggregate_value;
  if (result.rowCount !== 1 || typeof value !== 'string') {
    throw failure(
      'MODULE_AGGREGATE_RESULT_INVALID',
      'aggregate query did not return exactly one scalar value',
      aggregate.selectionId,
    );
  }
  const common = Object.freeze({
    precision: 38 as const,
    scale,
    selectionId: aggregate.selectionId,
    value: canonicalAggregateDecimal(value),
  });
  const quantity = aggregate.resultType.kind === 'quantityAggregateResultType';
  if (quantity && !isRecord(aggregate.resultType.baseUnit)) {
    throw failure(
      'MODULE_AGGREGATE_CONTRACT_INVALID',
      'quantity aggregate result has no base-unit identity',
      aggregate.selectionId,
    );
  }
  return Object.freeze({
    kind: 'semanticAggregateResult',
    outcome: 'exact',
    queryId: definition.queryId,
    schemaVersion: SEMANTIC_AGGREGATE_RESULT_VERSION,
    value: quantity
      ? Object.freeze({
          ...common,
          baseUnitId: String(
            (aggregate.resultType.baseUnit as Record<string, unknown>).targetId,
          ),
          kind: 'quantityResult' as const,
        })
      : Object.freeze({
          ...common,
          kind: 'exactDecimalResult' as const,
        }),
  });
}

interface AggregateCacheIdentity {
  readonly cacheKey: string;
  readonly environmentId: string;
  readonly filterPlanDigest: string;
  readonly legalEntityIds: readonly string[];
  readonly movementGeneration: string;
  readonly parameterValues: Readonly<Record<string, ImmutableJsonValue>>;
  readonly principalId: string;
  readonly queryId: string;
  readonly releaseContentHash: string;
  readonly temporalHorizons: Readonly<Record<string, ImmutableJsonValue>>;
  readonly tenantId: string;
}

interface AggregateAnchorRow {
  readonly anchor_digest: string;
  readonly balance_value: string;
  readonly base_unit_id: string | null;
  readonly cache_key: string;
  readonly environment_id: string;
  readonly filter_plan_digest: string;
  readonly legal_entity_ids: string[];
  readonly movement_generation: string;
  readonly parameter_values: Record<string, ImmutableJsonValue>;
  readonly principal_id: string;
  readonly query_id: string;
  readonly release_content_hash: string;
  readonly result_kind: 'exactDecimalResult' | 'quantityResult';
  readonly result_precision: number;
  readonly result_scale: number;
  readonly selection_id: string;
  readonly temporal_horizons: Record<string, ImmutableJsonValue>;
  readonly tenant_id: string;
}

function aggregateCacheIdentity(
  request: SemanticAggregateQueryExecutionRequest,
  readScope: VerifiedLegalEntityReadScope,
  movementGeneration: string,
): AggregateCacheIdentity {
  const environmentId = canonicalAggregateUuid(
    request.context.environmentId,
    'environmentId',
  );
  const legalEntityIds = Object.freeze(
    readScope.legalEntityIds.map((legalEntityId) =>
      canonicalAggregateUuid(legalEntityId, 'legalEntityId'),
    ),
  );
  const principalId = canonicalAggregateUuid(
    request.context.principalId,
    'principalId',
  );
  const tenantId = canonicalAggregateUuid(request.context.tenantId, 'tenantId');
  const temporalHorizons = Object.fromEntries(
    request.definition.parameters
      .filter(
        (parameter) => parameter.parameterType.kind === 'dateTimeFieldType',
      )
      .map((parameter) => [
        parameter.parameterId,
        request.parameterValues[parameter.parameterId]!,
      ]),
  );
  const filterPlanDigest = aggregateCacheDigest(
    'northstar.semantic-aggregate-filter-plans/v1',
    request.filterPlans,
  );
  const keyInput = Object.freeze({
    environmentId,
    filterPlanDigest,
    legalEntityIds,
    movementGeneration,
    parameterValues: request.parameterValues,
    principalId,
    queryId: request.definition.queryId,
    releaseContentHash: request.view.release.contentHash,
    schemaVersion: 'northstar.semantic-aggregate-anchor-key/v2',
    tenantId,
    temporalHorizons,
  });
  return Object.freeze({
    cacheKey: aggregateCacheDigest(
      'northstar.semantic-aggregate-anchor-key/v2',
      keyInput,
    ),
    environmentId,
    filterPlanDigest,
    legalEntityIds,
    movementGeneration,
    parameterValues: request.parameterValues,
    principalId,
    queryId: request.definition.queryId,
    releaseContentHash: request.view.release.contentHash,
    temporalHorizons: Object.freeze(temporalHorizons),
    tenantId,
  });
}

function aggregateCacheDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalize(value), 'utf8')
    .digest('hex');
}

/**
 * Exported so the reconciliation sweep guards its snapshot with the same key
 * this read path and `advance_semantic_aggregate_generation` already use. A
 * second derivation of this string would drift and silently stop conflicting.
 */
export function aggregateGenerationLockKey(
  tenantId: string,
  environmentId: string,
): string {
  return `northstar.semantic-aggregate-generation/v1:${canonicalAggregateUuid(tenantId, 'tenantId')}:${canonicalAggregateUuid(environmentId, 'environmentId')}`;
}

function canonicalAggregateUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) {
    throw failure(
      'MODULE_AGGREGATE_IDENTITY_INVALID',
      `aggregate ${field} must be a UUID`,
    );
  }
  return value.toLowerCase();
}

function aggregateAnchorDigest(
  identity: AggregateCacheIdentity,
  result: SemanticAggregateResultEnvelope,
): string {
  return aggregateCacheDigest(
    'northstar.semantic-aggregate-anchor-integrity/v2',
    Object.freeze({
      cacheKey: identity.cacheKey,
      environmentId: identity.environmentId,
      filterPlanDigest: identity.filterPlanDigest,
      legalEntityIds: identity.legalEntityIds,
      movementGeneration: identity.movementGeneration,
      parameterValues: identity.parameterValues,
      principalId: identity.principalId,
      queryId: identity.queryId,
      releaseContentHash: identity.releaseContentHash,
      result,
      schemaVersion: 'northstar.semantic-aggregate-anchor-integrity/v2',
      tenantId: identity.tenantId,
      temporalHorizons: identity.temporalHorizons,
    }),
  );
}

/**
 * The identity and integrity digests a stored anchor's own persisted content
 * implies.
 *
 * Exported so the reconciliation sweep verifies anchors through THIS
 * derivation. A sweep carrying a second copy of the digest rule would drift
 * from the read path and then verify nothing — which is the failure the sweep
 * exists to catch, reproduced inside the thing catching it.
 *
 * The cache key is itself a digest over the identity, so recomputing both
 * detects a rewritten identity as well as a rewritten result.
 */
export function expectedAggregateAnchorIntegrity(
  anchor: PersistedAggregateAnchorV1,
): { readonly anchorDigest: string; readonly cacheKey: string } {
  const row: AggregateAnchorRow = {
    anchor_digest: anchor.anchorDigest,
    balance_value: anchor.balanceValue,
    base_unit_id: anchor.baseUnitId,
    cache_key: anchor.cacheKey,
    environment_id: anchor.environmentId,
    filter_plan_digest: anchor.filterPlanDigest,
    legal_entity_ids: [...anchor.legalEntityIds],
    movement_generation: anchor.movementGeneration,
    parameter_values: anchor.parameterValues,
    principal_id: anchor.principalId,
    query_id: anchor.queryId,
    release_content_hash: anchor.releaseContentHash,
    result_kind: anchor.resultKind,
    result_precision: anchor.resultPrecision,
    result_scale: anchor.resultScale,
    selection_id: anchor.selectionId,
    temporal_horizons: anchor.temporalHorizons,
    tenant_id: anchor.tenantId,
  };
  const keyInput = Object.freeze({
    environmentId: anchor.environmentId,
    filterPlanDigest: anchor.filterPlanDigest,
    legalEntityIds: Object.freeze([...anchor.legalEntityIds]),
    movementGeneration: anchor.movementGeneration,
    parameterValues: anchor.parameterValues,
    principalId: anchor.principalId,
    queryId: anchor.queryId,
    releaseContentHash: anchor.releaseContentHash,
    schemaVersion: 'northstar.semantic-aggregate-anchor-key/v2',
    tenantId: anchor.tenantId,
    temporalHorizons: anchor.temporalHorizons,
  });
  const cacheKey = aggregateCacheDigest(
    'northstar.semantic-aggregate-anchor-key/v2',
    keyInput,
  );
  const identity: AggregateCacheIdentity = {
    cacheKey: anchor.cacheKey,
    environmentId: anchor.environmentId,
    filterPlanDigest: anchor.filterPlanDigest,
    legalEntityIds: Object.freeze([...anchor.legalEntityIds]),
    movementGeneration: anchor.movementGeneration,
    parameterValues: anchor.parameterValues,
    principalId: anchor.principalId,
    queryId: anchor.queryId,
    releaseContentHash: anchor.releaseContentHash,
    temporalHorizons: anchor.temporalHorizons,
    tenantId: anchor.tenantId,
  };
  return Object.freeze({
    anchorDigest: aggregateAnchorDigest(
      identity,
      aggregateResultFromAnchor(anchor.queryId, row),
    ),
    cacheKey,
  });
}

export interface PersistedAggregateAnchorV1 {
  readonly anchorDigest: string;
  readonly balanceValue: string;
  readonly baseUnitId: string | null;
  readonly cacheKey: string;
  readonly environmentId: string;
  readonly filterPlanDigest: string;
  readonly legalEntityIds: readonly string[];
  readonly movementGeneration: string;
  readonly parameterValues: Record<string, ImmutableJsonValue>;
  readonly principalId: string;
  readonly queryId: string;
  readonly releaseContentHash: string;
  readonly resultKind: 'exactDecimalResult' | 'quantityResult';
  readonly resultPrecision: number;
  readonly resultScale: number;
  readonly selectionId: string;
  readonly temporalHorizons: Record<string, ImmutableJsonValue>;
  readonly tenantId: string;
}

async function loadAggregateMovementGeneration(
  client: PoolClient,
  tenantId: string,
  environmentId: string,
): Promise<string> {
  const result = await client.query<{ movement_generation: string }>(
    `SELECT movement_generation::text AS movement_generation
       FROM north_star_internal.semantic_aggregate_generations
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantId, environmentId],
  );
  if (result.rowCount === 0) return '0';
  const movementGeneration = result.rows[0]?.movement_generation;
  if (
    result.rowCount !== 1 ||
    typeof movementGeneration !== 'string' ||
    !/^[1-9][0-9]*$/u.test(movementGeneration)
  ) {
    throw failure(
      'MODULE_AGGREGATE_GENERATION_INVALID',
      'aggregate movement generation is not one positive integer',
    );
  }
  return movementGeneration;
}

async function loadAggregateAnchor(
  client: PoolClient,
  identity: AggregateCacheIdentity,
): Promise<AggregateAnchorRow | null> {
  const result = await client.query<AggregateAnchorRow>(
    `SELECT tenant_id::text AS tenant_id,
            environment_id::text AS environment_id,
            cache_key,
            movement_generation::text AS movement_generation,
            query_id,
            principal_id::text AS principal_id,
            release_content_hash,
            legal_entity_ids::text[] AS legal_entity_ids,
            parameter_values,
            temporal_horizons,
            filter_plan_digest,
            result_kind,
            selection_id,
            balance_value,
            result_precision,
            result_scale,
            base_unit_id,
            anchor_digest
       FROM north_star_internal.semantic_aggregate_anchors AS anchor
      WHERE anchor.tenant_id = $1
        AND anchor.environment_id = $2
        AND anchor.cache_key = $3`,
    [identity.tenantId, identity.environmentId, identity.cacheKey],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || !result.rows[0]) {
    throw failure(
      'MODULE_AGGREGATE_ANCHOR_INVALID',
      'aggregate cache key resolved more than one anchor',
      identity.queryId,
    );
  }
  return result.rows[0];
}

function aggregateAnchorMatchesIdentity(
  anchor: AggregateAnchorRow,
  identity: AggregateCacheIdentity,
): boolean {
  return (
    anchor.tenant_id === identity.tenantId &&
    anchor.environment_id === identity.environmentId &&
    anchor.cache_key === identity.cacheKey &&
    anchor.movement_generation === identity.movementGeneration &&
    anchor.query_id === identity.queryId &&
    anchor.principal_id === identity.principalId &&
    anchor.release_content_hash === identity.releaseContentHash &&
    canonicalize(anchor.legal_entity_ids) ===
      canonicalize(identity.legalEntityIds) &&
    canonicalize(anchor.parameter_values) ===
      canonicalize(identity.parameterValues) &&
    canonicalize(anchor.temporal_horizons) ===
      canonicalize(identity.temporalHorizons) &&
    anchor.filter_plan_digest === identity.filterPlanDigest
  );
}

function aggregateResultFromAnchor(
  queryId: string,
  anchor: AggregateAnchorRow,
): SemanticAggregateResultEnvelope {
  const common = Object.freeze({
    precision: anchor.result_precision as 38,
    scale: anchor.result_scale,
    selectionId: anchor.selection_id,
    value: canonicalAggregateDecimal(anchor.balance_value),
  });
  return Object.freeze({
    kind: 'semanticAggregateResult',
    outcome: 'exact',
    queryId,
    schemaVersion: SEMANTIC_AGGREGATE_RESULT_VERSION,
    value:
      anchor.result_kind === 'quantityResult'
        ? Object.freeze({
            ...common,
            baseUnitId: String(anchor.base_unit_id),
            kind: 'quantityResult' as const,
          })
        : Object.freeze({
            ...common,
            kind: 'exactDecimalResult' as const,
          }),
  });
}

async function insertAggregateAnchor(
  client: PoolClient,
  identity: AggregateCacheIdentity,
  result: SemanticAggregateResultEnvelope,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO north_star_internal.semantic_aggregate_anchors (
       tenant_id,
       environment_id,
       cache_key,
       movement_generation,
       query_id,
       principal_id,
       release_content_hash,
       legal_entity_ids,
       parameter_values,
       temporal_horizons,
       filter_plan_digest,
       result_kind,
       selection_id,
       balance_value,
       result_precision,
       result_scale,
       base_unit_id,
       anchor_digest
     ) SELECT
       $1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9::jsonb, $10::jsonb,
       $11, $12, $13, $14, $15, $16, $17, $18
      WHERE COALESCE(
        (
          SELECT generation.movement_generation
            FROM north_star_internal.semantic_aggregate_generations AS generation
           WHERE generation.tenant_id = $1
             AND generation.environment_id = $2
        ),
        0
      ) = $4::bigint`,
    [
      identity.tenantId,
      identity.environmentId,
      identity.cacheKey,
      identity.movementGeneration,
      identity.queryId,
      identity.principalId,
      identity.releaseContentHash,
      [...identity.legalEntityIds],
      JSON.stringify(identity.parameterValues),
      JSON.stringify(identity.temporalHorizons),
      identity.filterPlanDigest,
      result.value.kind,
      result.value.selectionId,
      result.value.value,
      result.value.precision,
      result.value.scale,
      result.value.kind === 'quantityResult' ? result.value.baseUnitId : null,
      aggregateAnchorDigest(identity, result),
    ],
  );
  if (inserted.rowCount !== 1) {
    throw failure(
      'MODULE_AGGREGATE_GENERATION_CHANGED',
      'aggregate generation changed before the anchor could be persisted',
      identity.queryId,
    );
  }
}

async function recordAggregateAnchorDiscrepancy(
  client: PoolClient,
  identity: AggregateCacheIdentity,
  anchor: AggregateAnchorRow,
  expectedAnchorDigest: string,
  recomputed: SemanticAggregateResultEnvelope,
): Promise<void> {
  await client.query(
    `INSERT INTO north_star_internal.semantic_aggregate_anchor_discrepancies (
       tenant_id,
       environment_id,
       discrepancy_id,
       cache_key,
       stored_anchor_digest,
       expected_anchor_digest,
       cached_balance_value,
       recomputed_balance_value
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      identity.tenantId,
      identity.environmentId,
      randomUUID(),
      identity.cacheKey,
      anchor.anchor_digest,
      expectedAnchorDigest,
      anchor.balance_value,
      recomputed.value.value,
    ],
  );
}

function observeAggregateCacheSafely(
  observer: ((observation: AggregateCacheObservation) => void) | undefined,
  observation: AggregateCacheObservation,
): void {
  try {
    observer?.(Object.freeze(observation));
  } catch {
    // Instrumentation is evidence, never query authority.
  }
}

function canonicalAggregateDecimal(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) {
    throw failure(
      'MODULE_AGGREGATE_RESULT_INVALID',
      'aggregate result is not an exact decimal',
    );
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '', fraction = ''] = unsigned.split('.');
  const canonicalInteger = integer.replace(/^0+(?=\d)/u, '');
  const canonicalFraction = fraction.replace(/0+$/u, '');
  if (/^0+$/u.test(canonicalInteger) && canonicalFraction === '') return '0';
  return `${negative ? '-' : ''}${canonicalInteger}${
    canonicalFraction === '' ? '' : `.${canonicalFraction}`
  }`;
}

async function listRecords(
  client: PoolClient,
  entity: StorageEntity,
  includeArchived: boolean,
  limit: number,
  afterRecordId: string | null,
  filterPlans: readonly QueryFilterLoweringPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
): Promise<RawRecord[]> {
  const values: unknown[] = [];
  const predicates = archivePredicate(entity, includeArchived);
  appendLegalEntityReadScopePredicate(entity, readScope, values, predicates);
  if (afterRecordId) {
    predicates.push(
      `${quoted(entity.recordIdentity.column)} > ${parameter(values, afterRecordId)}`,
    );
  }
  appendQueryFilterPredicates(entity, filterPlans, values, predicates);
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

interface ListRelationPlan {
  readonly labelColumn: StorageEntity['columns'][number];
  readonly labelAlias: string;
  /** The relation id or reference id the label is reported and sorted under. */
  readonly labelId: string;
  readonly recordAlias: string;
  /**
   * The source column joined to the target's record id: a compiled relation
   * column (uuid), or -- for a reference label -- a text field that stores a
   * record id, compared as text so a malformed value finds no label rather
   * than failing the whole list.
   */
  readonly sourceColumn: string;
  readonly sourceIsText: boolean;
  readonly tableAlias: string;
  readonly target: StorageEntity;
}

interface ListParentScopePlan {
  readonly column: string;
  readonly recordId: string;
}

interface ListRelatedFilterPlan {
  readonly related: StorageEntity;
  readonly relationColumn: string;
  readonly filters: readonly {
    readonly column: StorageEntity['columns'][number];
    readonly value: string;
  }[];
}

interface ListProgressPlan {
  readonly done: StorageEntity;
  /** The done rows' column that holds a line's record id. */
  readonly doneLineColumn: string;
  readonly doneQuantityColumn: string;
  readonly lines: StorageEntity;
  /** The lines' column that holds the listed record's id. */
  readonly linesParentColumn: string;
  readonly linesQuantityColumn: string;
  readonly openIn: {
    readonly column: StorageEntity['columns'][number];
    readonly values: readonly string[];
  } | null;
  readonly openOnly: boolean;
  readonly outputs: {
    readonly done: string;
    readonly open: string;
    readonly ordered: string;
  };
}

/**
 * Resolves list progress against the PINNED COMPILED storage, never against
 * caller input: the lines must be the queried entity's `parentScopedChild`
 * children, the done rows must point at those lines, both quantities must be
 * compiled exact decimal columns, and the open states a compiled column of the
 * queried entity. Anything else fails closed rather than summing a column a
 * request happened to name.
 */
function listProgressPlan(
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  list: AuthorizedSharedListRequest,
): ListProgressPlan | null {
  const requested = list.progress;
  if (!list.query.progress) return null;
  if (!requested)
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'list progress reached the executor without authorization',
      list.query.progress.lines.queryId,
    );
  const lines = requiredEntity(storage, requested.linesEntityId);
  const done = requiredEntity(storage, requested.doneEntityId);
  const toLines = storage.relations.find(
    (candidate) =>
      candidate.relationId === requested.lines.relationId &&
      candidate.sourceEntityId === lines.entityId &&
      candidate.targetEntityId === entity.entityId &&
      candidate.ownership === 'parentScopedChild',
  );
  const toDone = storage.relations.find(
    (candidate) =>
      candidate.relationId === requested.done.relationId &&
      candidate.sourceEntityId === done.entityId &&
      candidate.targetEntityId === lines.entityId,
  );
  if (!toLines || !toDone)
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'list progress does not match the compiled storage relations',
      (toLines ? requested.done : requested.lines).relationId,
    );
  const quantity = (target: StorageEntity, fieldId: string) => {
    const column = target.columns.find(
      (candidate) => candidate.canonicalFieldId === fieldId,
    );
    if (!column || column.fieldContract.fieldKind !== 'exactDecimalFieldType')
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'list progress sums a compiled exact decimal column',
        fieldId,
      );
    return column.physicalName;
  };
  const states = requested.openIn;
  const stateColumn = states
    ? entity.columns.find(
        (candidate) => candidate.canonicalFieldId === states.fieldId,
      )
    : undefined;
  if (states && !stateColumn)
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'list progress states name a compiled column of the queried entity',
      states.fieldId,
    );
  return Object.freeze({
    done,
    doneLineColumn: toDone.relationColumn.physicalName,
    doneQuantityColumn: quantity(done, requested.done.fieldId),
    lines,
    linesParentColumn: toLines.relationColumn.physicalName,
    linesQuantityColumn: quantity(lines, requested.lines.fieldId),
    openIn:
      states && stateColumn
        ? Object.freeze({ column: stateColumn, values: states.values })
        : null,
    openOnly: requested.openOnly === true,
    outputs: requested.outputs,
  });
}

const PROGRESS_ALIAS = 'table_progress';

/**
 * Per listed row, one lateral answer: the sum of its active lines' quantity,
 * the sum of the active done rows of those same lines, and the open remainder
 * between them -- zero outside the declared open states. It sits in FROM, so
 * the count and the page read the same figures and `openOnly` filters before
 * both. Every joined row is pinned to the listed row's tenant, environment and
 * company, and conjoined with the issued read scope, as a relation label is.
 */
function listProgressFromSql(
  entity: StorageEntity,
  sourceAlias: string,
  plan: ListProgressPlan,
  readScope: VerifiedLegalEntityReadScope | null,
  values: unknown[],
): string {
  const line = 'table_progress_line';
  const done = 'table_progress_done';
  const sameCompany = (
    alias: string,
    target: StorageEntity,
    anchorAlias: string,
    anchor: StorageEntity,
  ) => {
    const joined = legalEntityReadScopeRequirement(target);
    const owner = legalEntityReadScopeRequirement(anchor);
    return joined && owner
      ? `
          AND ${qualified(alias, joined.column)} = ${qualified(anchorAlias, owner.column)}`
      : '';
  };
  const activeLines = () =>
    `${qualified(line, 'tenant_id')} = ${qualified(sourceAlias, 'tenant_id')}
          AND ${qualified(line, 'environment_id')} = ${qualified(sourceAlias, 'environment_id')}
          AND ${qualified(line, plan.linesParentColumn)} = ${qualified(sourceAlias, entity.recordIdentity.column)}
          AND ${qualified(line, plan.lines.archive.archivedAtColumn)} IS NULL${sameCompany(line, plan.lines, sourceAlias, entity)}${legalEntityReadScopeJoinConjunction(plan.lines, readScope, values, line)}`;
  const ordered = `(SELECT coalesce(sum(${qualified(line, plan.linesQuantityColumn)}), 0)
         FROM north_star_module.${quoted(plan.lines.physicalTableName)} AS ${quoted(line)}
        WHERE ${activeLines()})`;
  const recorded = `(SELECT coalesce(sum(${qualified(done, plan.doneQuantityColumn)}), 0)
         FROM north_star_module.${quoted(plan.lines.physicalTableName)} AS ${quoted(line)}
         JOIN north_star_module.${quoted(plan.done.physicalTableName)} AS ${quoted(done)}
           ON ${qualified(done, 'tenant_id')} = ${qualified(line, 'tenant_id')}
          AND ${qualified(done, 'environment_id')} = ${qualified(line, 'environment_id')}
          AND ${qualified(done, plan.doneLineColumn)} = ${qualified(line, plan.lines.recordIdentity.column)}
          AND ${qualified(done, plan.done.archive.archivedAtColumn)} IS NULL${sameCompany(done, plan.done, line, plan.lines)}${legalEntityReadScopeJoinConjunction(plan.done, readScope, values, done)}
        WHERE ${activeLines()})`;
  const totals = 'table_progress_totals';
  const remainder = `${qualified(totals, 'ordered_total')} - ${qualified(totals, 'done_total')}`;
  const open = plan.openIn
    ? `CASE WHEN ${qualified(sourceAlias, plan.openIn.column.physicalName)}::text = ANY(${parameter(values, [...plan.openIn.values])}::text[]) THEN ${remainder} ELSE 0 END`
    : remainder;
  return `CROSS JOIN LATERAL (
    SELECT ${qualified(totals, 'ordered_total')} AS ${quoted('ordered_total')},
           ${qualified(totals, 'done_total')} AS ${quoted('done_total')},
           ${open} AS ${quoted('open_total')}
      FROM (SELECT ${ordered} AS ${quoted('ordered_total')},
                   ${recorded} AS ${quoted('done_total')}) AS ${quoted(totals)}
  ) AS ${quoted(PROGRESS_ALIAS)}`;
}

/**
 * Before-today filters resolve against the queried entity's selected columns:
 * a calendar date is compared with the instant's UTC date, a UTC instant with
 * the instant itself. A text-stored offset time is refused, never compared.
 */
function appendListBeforePredicates(
  selectedColumns: readonly StorageEntity['columns'][number][],
  sourceAlias: string,
  filters: readonly SharedListBeforeFilter[],
  values: unknown[],
  predicates: string[],
): void {
  for (const filter of filters) {
    const column = selectedColumns.find(
      (candidate) => candidate.canonicalFieldId === filter.fieldId,
    );
    const contract = column?.fieldContract;
    const instant =
      contract?.fieldKind === 'dateTimeFieldType' &&
      contract.temporal.timezoneSemantics === 'utcInstant';
    if (!column || !(instant || contract?.fieldKind === 'dateFieldType'))
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'a before filter compares a selected date or UTC instant column',
        filter.fieldId,
      );
    const bound = parameter(values, filter.before);
    predicates.push(
      instant
        ? `${qualified(sourceAlias, column.physicalName)} < ${bound}::timestamptz`
        : `${qualified(sourceAlias, column.physicalName)} < (${bound}::timestamptz AT TIME ZONE 'UTC')::date`,
    );
  }
}

/** A summed exact decimal as its canonical string: no trailing zeros. */
function canonicalProgressDecimal(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match)
    throw failure(
      'MODULE_LIST_RESULT_INVALID',
      'list progress is not an exact decimal',
    );
  const [, sign, whole, fraction = ''] = match;
  const kept = fraction.replace(/0+$/u, '');
  const digits = `${BigInt(whole!).toString()}${kept ? `.${kept}` : ''}`;
  return sign && digits !== '0' ? `-${digits}` : digits;
}

type StorageColumn = StorageEntity['columns'][number];

interface FigureRowsPlan {
  readonly entity: StorageEntity;
  /** The rows' text column that holds the listed record's id. */
  readonly matchColumn: string;
  readonly quantityColumn: string | null;
}

interface FigureWithinPlan {
  readonly parent: StorageEntity;
  /** The rows' column that holds their parent's record id. */
  readonly relationColumn: string;
  readonly stateColumn: StorageColumn;
  readonly values: readonly string[];
}

interface FigureRelatedPlan {
  readonly entity: StorageEntity;
  /** The related rows' column that holds a figure row's record id. */
  readonly relationColumn: string;
  readonly quantityColumn: string;
}

type FigureOperandPlan =
  { readonly figureId: string } | { readonly column: string };

type FigureThresholdPlan =
  { readonly column: string } | { readonly value: string };

interface ListFiguresPlan {
  readonly sums: readonly {
    readonly figureId: string;
    readonly rows: FigureRowsPlan;
    readonly within: FigureWithinPlan | null;
    readonly related: FigureRelatedPlan | null;
    readonly sum: 'related' | 'remaining' | 'rows';
  }[];
  readonly totals: readonly {
    readonly figureId: string;
    readonly plus: readonly FigureOperandPlan[];
    readonly minus: readonly FigureOperandPlan[];
    readonly floor: boolean;
  }[];
  readonly bands: readonly {
    readonly figureId: string;
    readonly of: string;
    readonly cases: readonly {
      readonly value: string;
      readonly comparison: 'atMost' | 'below';
      readonly threshold: FigureThresholdPlan;
    }[];
    readonly otherwise: string;
  }[];
  readonly latest: readonly {
    readonly figureId: string;
    readonly rows: FigureRowsPlan;
    readonly within: FigureWithinPlan;
    readonly byColumn: string;
    readonly valueColumn: string;
    readonly label: {
      readonly entity: StorageEntity;
      readonly column: StorageColumn;
    };
  }[];
  readonly keep: {
    readonly figureId: string;
    readonly values: readonly string[];
  } | null;
  /** Every figure id, in the order the statement computes and projects them. */
  readonly order: readonly {
    readonly figureId: string;
    readonly kind: 'band' | 'latest' | 'number';
  }[];
  /** Every entity the figures read, for the read-scope verification. */
  readonly entities: readonly StorageEntity[];
}

/**
 * Resolves list figures against the PINNED COMPILED storage, never against
 * caller input: each query the gateway authorized names its entity; the
 * match, quantity, state, date and value columns must be compiled columns of
 * the kind the figure needs; a parent is reached through the rows' compiled
 * relation to it and related rows through theirs to the rows; a listed row's
 * operand is a compiled exact decimal of the queried entity. Anything else
 * fails closed rather than summing a column a request happened to name.
 */
function listFiguresPlan(
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  list: AuthorizedSharedListRequest,
): ListFiguresPlan | null {
  const requested = list.query.figures;
  if (!requested) return null;
  const authorized = list.figures;
  const refuse = (subject: string, message: string): never => {
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      message,
      subject,
    );
  };
  if (!authorized)
    return refuse(
      requested.sums[0]!.rows.queryId,
      'list figures reached the executor without authorization',
    );
  const entities = new Map<string, StorageEntity>();
  const entityOf = (queryId: string) => {
    const entityId = authorized.entityIds[queryId];
    if (!entityId)
      return refuse(
        queryId,
        'a figure query reached the executor unauthorized',
      );
    const target = requiredEntity(storage, entityId);
    entities.set(target.entityId, target);
    return target;
  };
  const column = (
    target: StorageEntity,
    fieldId: string,
    kinds: readonly string[],
    message: string,
  ) => {
    const found = target.columns.find(
      (candidate) => candidate.canonicalFieldId === fieldId,
    );
    if (!found || !kinds.includes(found.fieldContract.fieldKind))
      return refuse(fieldId, message);
    return found;
  };
  const rowsPlan = (
    queryId: string,
    matchFieldId: string,
    quantityFieldId?: string,
  ): FigureRowsPlan => {
    const target = entityOf(queryId);
    return Object.freeze({
      entity: target,
      matchColumn: column(
        target,
        matchFieldId,
        ['textFieldType'],
        'a figure matches the listed record by a compiled text column',
      ).physicalName,
      quantityColumn:
        quantityFieldId === undefined
          ? null
          : column(
              target,
              quantityFieldId,
              ['exactDecimalFieldType'],
              'a figure sums a compiled exact decimal column',
            ).physicalName,
    });
  };
  const withinPlan = (
    rows: FigureRowsPlan,
    within: SharedListFigureWithin,
  ): FigureWithinPlan => {
    const parent = entityOf(within.queryId);
    const relation = storage.relations.find(
      (candidate) =>
        candidate.relationId === within.relationId &&
        candidate.sourceEntityId === rows.entity.entityId &&
        candidate.targetEntityId === parent.entityId,
    );
    if (!relation)
      return refuse(
        within.relationId,
        "a figure's parent does not match the compiled storage relations",
      );
    const stateColumn = parent.columns.find(
      (candidate) => candidate.canonicalFieldId === within.fieldId,
    );
    if (!stateColumn)
      return refuse(
        within.fieldId,
        "a figure's parent values name a compiled column of the parent",
      );
    return Object.freeze({
      parent,
      relationColumn: relation.relationColumn.physicalName,
      stateColumn,
      values: within.values,
    });
  };
  const listedDecimal = (fieldId: string) =>
    column(
      entity,
      fieldId,
      ['exactDecimalFieldType'],
      'a figure adds or compares a compiled exact decimal of the listed entity',
    ).physicalName;
  const operand = (value: SharedListFigureOperand): FigureOperandPlan =>
    'figureId' in value
      ? Object.freeze({ figureId: value.figureId })
      : Object.freeze({ column: listedDecimal(value.fieldId) });
  const threshold = (value: SharedListFigureThreshold): FigureThresholdPlan =>
    'fieldId' in value
      ? Object.freeze({ column: listedDecimal(value.fieldId) })
      : Object.freeze({ value: value.value });
  const sums = requested.sums.map((sum) => {
    const rows = rowsPlan(
      sum.rows.queryId,
      sum.rows.matchFieldId,
      sum.rows.quantityFieldId,
    );
    const related = sum.related
      ? (() => {
          const pointing = entityOf(sum.related.queryId);
          const relation = storage.relations.find(
            (candidate) =>
              candidate.relationId === sum.related!.relationId &&
              candidate.sourceEntityId === pointing.entityId &&
              candidate.targetEntityId === rows.entity.entityId,
          );
          if (!relation)
            return refuse(
              sum.related.relationId,
              "a figure's related rows do not match the compiled storage relations",
            );
          return Object.freeze({
            entity: pointing,
            relationColumn: relation.relationColumn.physicalName,
            quantityColumn: column(
              pointing,
              sum.related.fieldId,
              ['exactDecimalFieldType'],
              'a figure sums a compiled exact decimal column',
            ).physicalName,
          });
        })()
      : null;
    return Object.freeze({
      figureId: sum.figureId,
      rows,
      within: sum.within ? withinPlan(rows, sum.within) : null,
      related,
      sum: sum.sum,
    });
  });
  const totals = (requested.totals ?? []).map((total) =>
    Object.freeze({
      figureId: total.figureId,
      plus: total.plus.map(operand),
      minus: total.minus.map(operand),
      floor: total.floor === 'zero',
    }),
  );
  const bands = (requested.bands ?? []).map((band) =>
    Object.freeze({
      figureId: band.figureId,
      of: band.of,
      cases: band.cases.map((entry) =>
        Object.freeze({
          value: entry.value,
          comparison: entry.below ? ('below' as const) : ('atMost' as const),
          threshold: threshold((entry.below ?? entry.atMost)!),
        }),
      ),
      otherwise: band.otherwise,
    }),
  );
  const latest = (requested.latest ?? []).map((figure) => {
    const rows = rowsPlan(figure.rows.queryId, figure.rows.matchFieldId);
    const within = withinPlan(rows, figure.within);
    const by = column(
      within.parent,
      figure.byFieldId,
      ['dateFieldType', 'dateTimeFieldType'],
      'a latest figure orders by a compiled date or UTC instant column',
    );
    if (
      by.fieldContract.fieldKind === 'dateTimeFieldType' &&
      by.fieldContract.temporal.timezoneSemantics !== 'utcInstant'
    )
      refuse(
        figure.byFieldId,
        'a latest figure orders by a compiled date or UTC instant column',
      );
    const labelEntity = entityOf(figure.label.queryId);
    const labelColumn = labelEntity.columns.find(
      (candidate) => candidate.canonicalFieldId === figure.label.fieldId,
    );
    if (!labelColumn)
      return refuse(
        figure.label.fieldId,
        'a latest label reads a compiled column of its entity',
      );
    return Object.freeze({
      figureId: figure.figureId,
      rows,
      within,
      byColumn: by.physicalName,
      valueColumn: column(
        within.parent,
        figure.valueFieldId,
        ['textFieldType'],
        'a latest figure reads a compiled text column',
      ).physicalName,
      label: Object.freeze({ entity: labelEntity, column: labelColumn }),
    });
  });
  return Object.freeze({
    sums,
    totals,
    bands,
    latest,
    keep: requested.keep ?? null,
    order: Object.freeze(
      [...sharedListFigureKinds(requested)].map(([figureId, kind]) =>
        Object.freeze({ figureId, kind }),
      ),
    ),
    entities: Object.freeze([...entities.values()]),
  });
}

const FIGURE_SUMS_ALIAS = 'table_figure_sums';
const FIGURES_ALIAS = 'table_figures';

/**
 * Per listed row, two lateral answers in FROM: every sum and latest value in
 * one, then every total, band and label over them, so the count and the page
 * read the same figures and a kept band filters before both. Every joined row
 * is pinned to the listed row's tenant and environment, to the issued read
 * scope, and -- parent and related rows -- to its own row's company; the rows
 * that hold the listed record's id compare that id as text.
 */
function listFiguresFromSql(
  entity: StorageEntity,
  sourceAlias: string,
  plan: ListFiguresPlan,
  readScope: VerifiedLegalEntityReadScope | null,
  values: unknown[],
): string {
  const sameCompany = (
    alias: string,
    target: StorageEntity,
    anchorAlias: string,
    anchor: StorageEntity,
  ) => {
    const joined = legalEntityReadScopeRequirement(target);
    const owner = legalEntityReadScopeRequirement(anchor);
    return joined && owner
      ? `
          AND ${qualified(alias, joined.column)} = ${qualified(anchorAlias, owner.column)}`
      : '';
  };
  const matching = (rows: FigureRowsPlan, alias: string) =>
    `${qualified(alias, 'tenant_id')} = ${qualified(sourceAlias, 'tenant_id')}
          AND ${qualified(alias, 'environment_id')} = ${qualified(sourceAlias, 'environment_id')}
          AND ${qualified(alias, rows.matchColumn)}::text = ${qualified(sourceAlias, entity.recordIdentity.column)}::text
          AND ${qualified(alias, rows.entity.archive.archivedAtColumn)} IS NULL${legalEntityReadScopeJoinConjunction(rows.entity, readScope, values, alias)}`;
  const parentJoin = (
    within: FigureWithinPlan,
    rows: FigureRowsPlan,
    rowsAlias: string,
    alias: string,
  ) => `
         JOIN north_star_module.${quoted(within.parent.physicalTableName)} AS ${quoted(alias)}
           ON ${qualified(alias, 'tenant_id')} = ${qualified(rowsAlias, 'tenant_id')}
          AND ${qualified(alias, 'environment_id')} = ${qualified(rowsAlias, 'environment_id')}
          AND ${qualified(alias, within.parent.recordIdentity.column)} = ${qualified(rowsAlias, within.relationColumn)}
          AND ${qualified(alias, within.parent.archive.archivedAtColumn)} IS NULL${sameCompany(alias, within.parent, rowsAlias, rows.entity)}${legalEntityReadScopeJoinConjunction(within.parent, readScope, values, alias)}
          AND ${qualified(alias, within.stateColumn.physicalName)}::text = ANY(${parameter(values, [...within.values])}::text[])`;
  const relatedTotal = (
    related: FigureRelatedPlan,
    rows: FigureRowsPlan,
    rowsAlias: string,
    alias: string,
  ) => `(SELECT coalesce(sum(${qualified(alias, related.quantityColumn)}), 0)
           FROM north_star_module.${quoted(related.entity.physicalTableName)} AS ${quoted(alias)}
          WHERE ${qualified(alias, 'tenant_id')} = ${qualified(rowsAlias, 'tenant_id')}
            AND ${qualified(alias, 'environment_id')} = ${qualified(rowsAlias, 'environment_id')}
            AND ${qualified(alias, related.relationColumn)} = ${qualified(rowsAlias, rows.entity.recordIdentity.column)}
            AND ${qualified(alias, related.entity.archive.archivedAtColumn)} IS NULL${sameCompany(alias, related.entity, rowsAlias, rows.entity)}${legalEntityReadScopeJoinConjunction(related.entity, readScope, values, alias)})`;
  const sumColumns = plan.sums.map((sum, index) => {
    const rowsAlias = `table_figure_${String(index)}_rows`;
    const parentAlias = `table_figure_${String(index)}_parent`;
    const relatedAlias = `table_figure_${String(index)}_related`;
    const quantity = sum.rows.quantityColumn
      ? qualified(rowsAlias, sum.rows.quantityColumn)
      : null;
    const related = sum.related
      ? relatedTotal(sum.related, sum.rows, rowsAlias, relatedAlias)
      : null;
    // Per row, before adding: what remains is never below zero, so an
    // over-recorded row cannot cancel what another row still has open.
    const term =
      sum.sum === 'rows'
        ? quantity!
        : sum.sum === 'related'
          ? related!
          : `greatest(${quantity!} - ${related!}, 0)`;
    return `(SELECT coalesce(sum(${term}), 0)
         FROM north_star_module.${quoted(sum.rows.entity.physicalTableName)} AS ${quoted(rowsAlias)}${sum.within ? parentJoin(sum.within, sum.rows, rowsAlias, parentAlias) : ''}
        WHERE ${matching(sum.rows, rowsAlias)}) AS ${quoted(`sum_${String(index)}`)}`;
  });
  const latestColumns = plan.latest.map((figure, index) => {
    const rowsAlias = `table_latest_${String(index)}_rows`;
    const parentAlias = `table_latest_${String(index)}_parent`;
    return `(SELECT ${qualified(parentAlias, figure.valueColumn)}::text
         FROM north_star_module.${quoted(figure.rows.entity.physicalTableName)} AS ${quoted(rowsAlias)}${parentJoin(figure.within, figure.rows, rowsAlias, parentAlias)}
        WHERE ${matching(figure.rows, rowsAlias)}
        ORDER BY ${qualified(parentAlias, figure.byColumn)} DESC NULLS LAST,
                 ${qualified(parentAlias, figure.within.parent.recordIdentity.column)} DESC
        LIMIT 1) AS ${quoted(`latest_${String(index)}`)}`;
  });
  // Totals, bands and labels read the sums by id; a total names only figures
  // declared before it, so each expression is built from finished ones.
  const expressions = new Map<string, string>();
  plan.sums.forEach((sum, index) =>
    expressions.set(
      sum.figureId,
      qualified(FIGURE_SUMS_ALIAS, `sum_${String(index)}`),
    ),
  );
  const operandSql = (value: FigureOperandPlan) => {
    if ('column' in value) return qualified(sourceAlias, value.column);
    const expression = expressions.get(value.figureId);
    if (!expression)
      throw failure(
        'MODULE_LIST_RESULT_INVALID',
        'a list figure names a figure not computed before it',
        value.figureId,
      );
    return expression;
  };
  const figureColumns: string[] = [];
  plan.totals.forEach((total, index) => {
    const signed = [
      ...total.plus.map((value) => `+ ${operandSql(value)}`),
      ...total.minus.map((value) => `- ${operandSql(value)}`),
    ].join(' ');
    const sum = `(0 ${signed})`;
    // A total over an unstated field stays unstated: never floored to zero.
    const expression = total.floor
      ? `(CASE WHEN ${sum} < 0 THEN 0 ELSE ${sum} END)`
      : sum;
    expressions.set(total.figureId, expression);
    figureColumns.push(`${expression} AS ${quoted(`total_${String(index)}`)}`);
  });
  plan.bands.forEach((band, index) => {
    const of = operandSql({ figureId: band.of });
    const cases = band.cases
      .map((entry) => {
        const threshold =
          'column' in entry.threshold
            ? qualified(sourceAlias, entry.threshold.column)
            : `${parameter(values, entry.threshold.value)}::numeric`;
        return `WHEN ${of} ${entry.comparison === 'below' ? '<' : '<='} ${threshold} THEN ${parameter(values, entry.value)}::text`;
      })
      .join(' ');
    figureColumns.push(
      `(CASE ${cases} ELSE ${parameter(values, band.otherwise)}::text END) AS ${quoted(`band_${String(index)}`)}`,
    );
  });
  plan.latest.forEach((figure, index) => {
    const alias = `table_latest_${String(index)}_label`;
    figureColumns.push(
      `(SELECT ${visibleFieldExpression(figure.label.column, alias)}
          FROM north_star_module.${quoted(figure.label.entity.physicalTableName)} AS ${quoted(alias)}
         WHERE ${qualified(alias, 'tenant_id')} = ${qualified(sourceAlias, 'tenant_id')}
           AND ${qualified(alias, 'environment_id')} = ${qualified(sourceAlias, 'environment_id')}
           AND ${qualified(alias, figure.label.entity.recordIdentity.column)}::text = ${qualified(FIGURE_SUMS_ALIAS, `latest_${String(index)}`)}${legalEntityReadScopeJoinConjunction(figure.label.entity, readScope, values, alias)}) AS ${quoted(`label_${String(index)}`)}`,
    );
  });
  return `CROSS JOIN LATERAL (
    SELECT ${[...sumColumns, ...latestColumns].join(',\n           ')}
  ) AS ${quoted(FIGURE_SUMS_ALIAS)}
  CROSS JOIN LATERAL (
    SELECT ${['1 AS "figures"', ...figureColumns].join(',\n           ')}
  ) AS ${quoted(FIGURES_ALIAS)}`;
}

/** Where each figure's value -- and a latest one's label -- is projected. */
function listFigureColumns(plan: ListFiguresPlan): readonly {
  readonly figureId: string;
  readonly kind: 'band' | 'latest' | 'number';
  readonly value: string;
  readonly label: string | null;
}[] {
  const sums = new Map(plan.sums.map((sum, index) => [sum.figureId, index]));
  const totals = new Map(
    plan.totals.map((total, index) => [total.figureId, index]),
  );
  const bands = new Map(
    plan.bands.map((band, index) => [band.figureId, index]),
  );
  const latest = new Map(
    plan.latest.map((figure, index) => [figure.figureId, index]),
  );
  return plan.order.map(({ figureId, kind }) => {
    const sum = sums.get(figureId);
    const total = totals.get(figureId);
    const band = bands.get(figureId);
    const last = latest.get(figureId);
    return Object.freeze({
      figureId,
      kind,
      value:
        sum !== undefined
          ? qualified(FIGURE_SUMS_ALIAS, `sum_${String(sum)}`)
          : total !== undefined
            ? qualified(FIGURES_ALIAS, `total_${String(total)}`)
            : band !== undefined
              ? qualified(FIGURES_ALIAS, `band_${String(band)}`)
              : qualified(FIGURE_SUMS_ALIAS, `latest_${String(last!)}`),
      label:
        last !== undefined
          ? qualified(FIGURES_ALIAS, `label_${String(last)}`)
          : null,
    });
  });
}

/**
 * Resolves a related-record existence filter against the PINNED COMPILED
 * relation: the related entity must be the relation's source and the queried
 * entity its target, and every filter field must be a compiled column of the
 * related entity. Anything else fails closed rather than degrading to an
 * unfiltered list.
 */
function relatedFilterPlan(
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  list: AuthorizedSharedListRequest,
): ListRelatedFilterPlan | null {
  const requested = list.relatedFilter;
  if (!list.query.relatedFilter) return null;
  const relation = requested
    ? storage.relations.find(
        (candidate) =>
          candidate.relationId === requested.relationId &&
          candidate.sourceEntityId === requested.relatedEntityId &&
          candidate.targetEntityId === entity.entityId,
      )
    : undefined;
  if (!requested || !relation)
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'related filter does not match the compiled storage relation',
      list.query.relatedFilter.relationId,
    );
  const related = requiredEntity(storage, requested.relatedEntityId);
  return Object.freeze({
    related,
    relationColumn: relation.relationColumn.physicalName,
    filters: Object.freeze(
      requested.fieldFilters.map((filter) => {
        const column = related.columns.find(
          (candidate) => candidate.canonicalFieldId === filter.fieldId,
        );
        if (!column)
          throw new SharedListContractError(
            'LIST_FIELD_NOT_AUTHORIZED',
            'related filter field has no compiled column',
            filter.fieldId,
          );
        return Object.freeze({ column, value: filter.value });
      }),
    ),
  });
}

/**
 * Resolves an exact parent restriction against the PINNED COMPILED relation,
 * never against caller input. The request names a relation identity; the
 * physical column is read from the compiled storage target, so a caller cannot
 * turn a supplied string into column or table authority. The relation must
 * belong to this query's source entity and must be the `parentScopedChild`
 * class -- the same class the parent-guard chain uses -- and anything else
 * fails closed rather than degrading to an unfiltered list.
 */
function parentScopePlan(
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  list: AuthorizedSharedListRequest,
): ListParentScopePlan | null {
  const requested = list.query.parentScope ?? list.query.referenceScope;
  if (!requested) return null;
  const relation = storage.relations.find(
    (candidate) => candidate.relationId === requested.relationId,
  );
  if (
    !relation ||
    relation.sourceEntityId !== entity.entityId ||
    relation.ownership !==
      (list.query.referenceScope ? 'reference' : 'parentScopedChild')
  ) {
    throw failure(
      'MODULE_LIST_PARENT_SCOPE_INVALID',
      'list parentScope must name a parentScopedChild relation of the queried entity',
      requested.relationId,
    );
  }
  return Object.freeze({
    column: relation.relationColumn.physicalName,
    recordId: requested.recordId,
  });
}

async function listSharedRecords(
  client: PoolClient,
  entity: StorageEntity,
  definition: RegisteredQueryDefinition,
  list: AuthorizedSharedListRequest,
  filterPlans: readonly QueryFilterLoweringPlan[],
  relationPlans: readonly ListRelationPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
  parentScope: ListParentScopePlan | null,
  relatedFilter: ListRelatedFilterPlan | null = null,
  progress: ListProgressPlan | null = null,
  figures: ListFiguresPlan | null = null,
): Promise<SemanticQueryResultEnvelope> {
  const sourceAlias = 'table_source';
  const selectedColumns = definition.selections.map((selection) => {
    const column = entity.columns.find(
      (candidate) => candidate.canonicalFieldId === selection.fieldId,
    );
    if (!column) {
      throw failure(
        'MODULE_LIST_PROJECTION_INVALID',
        'selected list field has no compiled storage column',
        selection.fieldId,
      );
    }
    return column;
  });
  const values: unknown[] = [];
  const fromSql = [
    listFromSql(entity, sourceAlias, relationPlans, readScope, values),
    ...(progress
      ? [listProgressFromSql(entity, sourceAlias, progress, readScope, values)]
      : []),
    ...(figures
      ? [listFiguresFromSql(entity, sourceAlias, figures, readScope, values)]
      : []),
  ].join('\n');
  const figureColumns = figures ? listFigureColumns(figures) : [];
  const predicates = listArchivePredicates(
    entity,
    sourceAlias,
    list.query.includeArchived,
  );
  appendLegalEntityReadScopePredicate(
    entity,
    readScope,
    values,
    predicates,
    sourceAlias,
  );
  const searchExpressions = [
    ...selectedColumns.map((column) =>
      foldedVisibleFieldExpression(entity, column, sourceAlias),
    ),
    ...relationPlans.map((plan) =>
      foldedVisibleFieldExpression(
        plan.target,
        plan.labelColumn,
        plan.tableAlias,
      ),
    ),
  ];
  if (list.query.search.trim() !== '') {
    const match = buildFoldedExpressionMatchPredicate(
      searchExpressions,
      list.query.search,
      list.query.matchMode,
      values.length,
    );
    values.push(...match.values);
    predicates.push(match.sql);
  }
  appendQueryFilterPredicates(
    entity,
    filterPlans,
    values,
    predicates,
    sourceAlias,
  );
  if (parentScope) {
    // Ahead of both the count and the page window, so the paged set IS the
    // parent's children rather than a broader set the page happens to land in.
    predicates.push(
      `${qualified(sourceAlias, parentScope.column)} = ${parameter(
        values,
        parentScope.recordId,
      )}::uuid`,
    );
  }
  if (relatedFilter) {
    // Ahead of the count and the page window, like the parent scope: a page of
    // customers is a page of the eligible set, never a filtered broader page.
    const alias = 'table_related_filter';
    predicates.push(
      `EXISTS (SELECT 1 FROM north_star_module.${quoted(relatedFilter.related.physicalTableName)} AS ${quoted(alias)}
        WHERE ${qualified(alias, 'tenant_id')} = ${qualified(sourceAlias, 'tenant_id')}
          AND ${qualified(alias, 'environment_id')} = ${qualified(sourceAlias, 'environment_id')}
          AND ${qualified(alias, relatedFilter.relationColumn)} = ${qualified(sourceAlias, entity.recordIdentity.column)}
          AND ${qualified(alias, relatedFilter.related.archive.archivedAtColumn)} IS NULL${relatedFilter.filters
            .map(
              (filter) =>
                `\n          AND ${qualified(alias, filter.column.physicalName)}::text = ${parameter(values, filter.value)}`,
            )
            .join('')})`,
    );
  }
  for (const filter of list.query.fieldFilters ?? []) {
    const column = selectedColumns.find(
      (column) => column.canonicalFieldId === filter.fieldId,
    );
    if (!column)
      throw failure(
        'MODULE_LIST_FIELD_INVALID',
        'Exact filters must name a selected field',
        filter.fieldId,
      );
    predicates.push(
      `${qualified(sourceAlias, column.physicalName)}::text = ${parameter(values, filter.value)}`,
    );
  }
  // Ahead of the count and the page window, like every filter above: a tab of
  // orders with something still to arrive, or arriving late, counts and pages
  // exactly that set.
  if (progress?.openOnly)
    predicates.push(`${qualified(PROGRESS_ALIAS, 'open_total')} > 0`);
  // A kept band, like an open view: the tab counts and pages exactly the rows
  // whose band the statement itself judged.
  if (figures?.keep) {
    const kept = figures.keep;
    const band = figureColumns.find(
      (column) => column.figureId === kept.figureId && column.kind === 'band',
    );
    if (!band)
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'a kept figure is a band the statement computes',
        kept.figureId,
      );
    predicates.push(
      `${band.value} = ANY(${parameter(values, [...kept.values])}::text[])`,
    );
  }
  appendListBeforePredicates(
    selectedColumns,
    sourceAlias,
    list.query.beforeFilters ?? [],
    values,
    predicates,
  );
  const whereSql = predicates.length > 0 ? predicates.join(' AND ') : 'true';
  const count = await client.query<{ total_count: string }>(
    `SELECT count(*)::text AS total_count ${fromSql} WHERE ${whereSql}`,
    values,
  );
  const totalCount = Number(count.rows[0]?.total_count ?? '0');
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw failure(
      'MODULE_LIST_RESULT_INVALID',
      'list count is not a non-negative safe integer',
    );
  }
  const pageValues = [...values];
  const limitSql = parameter(pageValues, list.query.effectivePageSize + 1);
  const offsetSql = parameter(pageValues, list.query.pageOffset);
  const rows = await client.query<QueryResultRow>(
    `SELECT ${listSelectList(entity, sourceAlias, selectedColumns, relationPlans, progress !== null, figureColumns)}
       ${fromSql}
      WHERE ${whereSql}
      ORDER BY ${listOrderBy(
        entity,
        sourceAlias,
        selectedColumns,
        relationPlans,
        list,
      )}
      LIMIT ${limitSql} OFFSET ${offsetSql}`,
    pageValues,
  );
  const hasMore = rows.rows.length > list.query.effectivePageSize;
  const pageRows = rows.rows.slice(0, list.query.effectivePageSize);
  const records = pageRows.map((row) =>
    toListDto(
      entity,
      row,
      selectedColumns,
      relationPlans,
      progress,
      figureColumns,
    ),
  );
  const nextOffset = list.query.pageOffset + records.length;
  const listCoverage: SharedListCoverage = Object.freeze({
    effectivePageSize: list.query.effectivePageSize,
    hasMore,
    includeArchived: list.query.includeArchived,
    matchMode: list.query.matchMode,
    nextCursor: hasMore
      ? encodeSharedListCursor(definition.queryId, list.query, nextOffset)
      : null,
    pageOffset: list.query.pageOffset,
    parentScope: list.query.parentScope,
    ...(list.query.referenceScope
      ? { referenceScope: list.query.referenceScope }
      : {}),
    ...(list.query.fieldFilters
      ? { fieldFilters: list.query.fieldFilters }
      : {}),
    ...(relatedFilter && list.query.relatedFilter
      ? { relatedFilter: list.query.relatedFilter }
      : {}),
    // Echoed only when applied: the gateway requires both back unchanged.
    ...(progress && list.query.progress
      ? { progress: list.query.progress }
      : {}),
    ...(figures && list.query.figures ? { figures: list.query.figures } : {}),
    ...(list.query.beforeFilters
      ? { beforeFilters: list.query.beforeFilters }
      : {}),
    ...(list.query.outputMode ? { outputMode: list.query.outputMode } : {}),
    projectedSearchValueCount:
      list.query.search.trim() === '' ? 0 : searchExpressions.length,
    requestedPageSize: list.query.requestedPageSize,
    returnedCount: records.length,
    schemaVersion: SHARED_LIST_RESULT_VERSION,
    search: list.query.search,
    sort: list.query.sort,
    totalCount,
    truncatedByMaximum: list.query.truncatedByMaximum,
  });
  return Object.freeze({
    kind: 'semanticQueryResult',
    outcome: 'exact',
    queryId: definition.queryId,
    records: Object.freeze(records),
    schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
    listCoverage,
    unsupportedReason: null,
  });
}

function listRelationPlan(
  storage: StorageTargetPayloadV1,
  source: StorageEntity,
  authorization: AuthorizedSharedListRelationLabel,
  index: number,
): ListRelationPlan {
  const relation = storage.relations.find(
    (candidate) =>
      candidate.relationId === authorization.relationId &&
      candidate.sourceEntityId === source.entityId &&
      candidate.targetEntityId === authorization.targetEntityId,
  );
  if (!relation) {
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'authorized relation label does not match the compiled storage relation',
      authorization.relationId,
    );
  }
  const target = requiredEntity(storage, relation.targetEntityId);
  const labelColumn = target.columns.find(
    (candidate) => candidate.canonicalFieldId === authorization.fieldId,
  );
  if (!labelColumn) {
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'authorized relation label field has no compiled target column',
      authorization.fieldId,
    );
  }
  return Object.freeze({
    labelAlias: `nsm_table_relation_${String(index)}_label`,
    labelColumn,
    labelId: authorization.relationId,
    recordAlias: `nsm_table_relation_${String(index)}_record`,
    sourceColumn: relation.relationColumn.physicalName,
    sourceIsText: false,
    tableAlias: `table_relation_${String(index)}`,
    target,
  });
}

/**
 * A reference label resolves against the PINNED COMPILED storage: the source
 * field must be a text column of the queried entity and the label a column of
 * the authorized target entity. A request can therefore name only compiled
 * identities; neither a column nor a table comes from caller input.
 */
function listReferencePlan(
  storage: StorageTargetPayloadV1,
  source: StorageEntity,
  reference: AuthorizedSharedListReferenceLabel,
  index: number,
): ListRelationPlan {
  const sourceColumn = source.columns.find(
    (candidate) => candidate.canonicalFieldId === reference.sourceFieldId,
  );
  if (
    !sourceColumn ||
    sourceColumn.fieldContract.fieldKind !== 'textFieldType'
  ) {
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'a reference label reads a compiled text column of the queried entity',
      reference.sourceFieldId,
    );
  }
  const target = requiredEntity(storage, reference.targetEntityId);
  const labelColumn = target.columns.find(
    (candidate) => candidate.canonicalFieldId === reference.fieldId,
  );
  if (!labelColumn) {
    throw new SharedListContractError(
      'LIST_FIELD_NOT_AUTHORIZED',
      'authorized reference label field has no compiled target column',
      reference.fieldId,
    );
  }
  return Object.freeze({
    labelAlias: `nsm_table_relation_${String(index)}_label`,
    labelColumn,
    labelId: reference.referenceId,
    recordAlias: `nsm_table_relation_${String(index)}_record`,
    sourceColumn: sourceColumn.physicalName,
    sourceIsText: true,
    tableAlias: `table_relation_${String(index)}`,
    target,
  });
}

function listFromSql(
  entity: StorageEntity,
  sourceAlias: string,
  relations: readonly ListRelationPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
  values: unknown[],
): string {
  return [
    `FROM north_star_module.${quoted(entity.physicalTableName)} AS ${quoted(sourceAlias)}`,
    ...relations.map(
      (plan) =>
        `LEFT JOIN north_star_module.${quoted(plan.target.physicalTableName)} AS ${quoted(plan.tableAlias)}
           ON ${qualified(plan.tableAlias, 'tenant_id')} = ${qualified(sourceAlias, 'tenant_id')}
          AND ${qualified(plan.tableAlias, 'environment_id')} = ${qualified(sourceAlias, 'environment_id')}
          AND ${qualified(plan.tableAlias, plan.target.recordIdentity.column)}${plan.sourceIsText ? '::text' : ''} = ${qualified(sourceAlias, plan.sourceColumn)}${legalEntityReadScopeJoinConjunction(
            plan.target,
            readScope,
            values,
            plan.tableAlias,
          )}`,
    ),
  ].join('\n');
}

function listArchivePredicates(
  entity: StorageEntity,
  sourceAlias: string,
  includeArchived: boolean,
): string[] {
  return includeArchived
    ? []
    : [qualified(sourceAlias, entity.archive.archivedAtColumn) + ' IS NULL'];
}

function listSelectList(
  entity: StorageEntity,
  sourceAlias: string,
  selectedColumns: readonly StorageEntity['columns'][number][],
  relations: readonly ListRelationPlan[],
  progress = false,
  figures: ReturnType<typeof listFigureColumns> = [],
): string {
  const rawColumns = [
    entity.recordIdentity.column,
    entity.optimisticRevision.column,
    entity.archive.archivedAtColumn,
    ...entity.columns.map((column) => column.physicalName),
  ].map((column) => `${qualified(sourceAlias, column)} AS ${quoted(column)}`);
  const displays = selectedColumns.map(
    (column, index) =>
      `${visibleFieldExpression(column, sourceAlias)} AS ${quoted(`nsm_table_display_${String(index)}`)}`,
  );
  const relationValues = relations.flatMap((plan) => [
    `${qualified(plan.tableAlias, plan.target.recordIdentity.column)} AS ${quoted(plan.recordAlias)}`,
    `${visibleFieldExpression(plan.labelColumn, plan.tableAlias)} AS ${quoted(plan.labelAlias)}`,
  ]);
  const progressValues = progress
    ? (['ordered', 'done', 'open'] as const).map(
        (figure) =>
          `${qualified(PROGRESS_ALIAS, `${figure}_total`)}::text AS ${quoted(`nsm_table_progress_${figure}`)}`,
      )
    : [];
  const figureValues = figures.flatMap((figure, index) => [
    `${figure.value}::text AS ${quoted(`nsm_table_figure_${String(index)}`)}`,
    ...(figure.label
      ? [
          `${figure.label} AS ${quoted(`nsm_table_figure_label_${String(index)}`)}`,
        ]
      : []),
  ]);
  return [
    ...rawColumns,
    ...displays,
    ...relationValues,
    ...progressValues,
    ...figureValues,
  ].join(', ');
}

function listOrderBy(
  entity: StorageEntity,
  sourceAlias: string,
  selectedColumns: readonly StorageEntity['columns'][number][],
  relations: readonly ListRelationPlan[],
  list: AuthorizedSharedListRequest,
): string {
  const selectedById = new Map(
    selectedColumns.map((column) => [column.canonicalFieldId, column] as const),
  );
  const relationsById = new Map(
    relations.map((plan) => [plan.labelId, plan] as const),
  );
  const order = list.query.sort.map((sort) => {
    const column = selectedById.get(sort.fieldId);
    const relation = relationsById.get(sort.fieldId);
    const expression = column
      ? listSortExpression(column, sourceAlias)
      : relation
        ? visibleFieldExpression(relation.labelColumn, relation.tableAlias)
        : null;
    if (!expression) {
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'list sort field is not present in the authorized projection',
        sort.fieldId,
      );
    }
    return `${expression} ${sort.direction === 'descending' ? 'DESC' : 'ASC'} NULLS LAST`;
  });
  order.push(`${qualified(sourceAlias, entity.recordIdentity.column)} ASC`);
  return order.join(', ');
}

function listSortExpression(
  column: StorageEntity['columns'][number],
  tableAlias: string,
): string {
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
    case 'enumFieldType':
    case 'textFieldType':
      return visibleFieldExpression(column, tableAlias);
    default:
      return qualified(tableAlias, column.physicalName);
  }
}

function toListDto(
  entity: StorageEntity,
  row: QueryResultRow,
  selectedColumns: readonly StorageEntity['columns'][number][],
  relations: readonly ListRelationPlan[],
  progress: ListProgressPlan | null = null,
  figures: ReturnType<typeof listFigureColumns> = [],
): SemanticRecordDto {
  const projected = toDto(
    entity,
    rawRecord(entity, row),
    selectedColumns.map((column) => ({ fieldId: column.canonicalFieldId })),
  );
  // The summed figures ride the row's values under their declared ids, as
  // canonical exact decimals the List shows and exports unchanged.
  const base = progress
    ? Object.freeze({
        ...projected,
        values: Object.freeze({
          ...projected.values,
          [progress.outputs.ordered]: canonicalProgressDecimal(
            row.nsm_table_progress_ordered,
          ),
          [progress.outputs.done]: canonicalProgressDecimal(
            row.nsm_table_progress_done,
          ),
          [progress.outputs.open]: canonicalProgressDecimal(
            row.nsm_table_progress_open,
          ),
        }),
      })
    : projected;
  // Each figure rides the row's values under its id: a sum or a total as a
  // canonical exact decimal (unstated reads null), a band as its value, a
  // latest record id as it is -- with that record's label beside it.
  const figured =
    figures.length > 0
      ? Object.freeze({
          ...base,
          values: Object.freeze({
            ...base.values,
            ...Object.fromEntries(
              figures.map((figure, index) => {
                const value = row[
                  `nsm_table_figure_${String(index)}`
                ] as unknown;
                return [
                  figure.figureId,
                  value === null || value === undefined
                    ? null
                    : figure.kind === 'number'
                      ? canonicalProgressDecimal(value)
                      : nullableDisplayValue(value),
                ];
              }),
            ),
          }),
        })
      : base;
  const displayValues = Object.freeze(
    Object.fromEntries([
      ...selectedColumns.map((column, index) => [
        column.canonicalFieldId,
        nullableDisplayValue(row[`nsm_table_display_${String(index)}`]),
      ]),
      ...figures.flatMap((figure, index) =>
        figure.label
          ? [
              [
                figure.figureId,
                nullableDisplayValue(
                  row[`nsm_table_figure_label_${String(index)}`],
                ),
              ],
            ]
          : [],
      ),
    ]),
  );
  const relationLabels = Object.freeze(
    Object.fromEntries(
      relations.map((plan) => [
        plan.labelId,
        Object.freeze({
          label: nullableDisplayValue(row[plan.labelAlias]),
          recordId: nullableUuid(row[plan.recordAlias]),
        }),
      ]),
    ),
  );
  return Object.freeze({ ...figured, displayValues, relationLabels });
}

function visibleFieldExpression(
  column: StorageEntity['columns'][number],
  tableAlias: string,
): string {
  const value = qualified(tableAlias, column.physicalName);
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
      return `CASE WHEN ${value} IS NULL THEN NULL WHEN ${value} THEN 'Yes' ELSE 'No' END`;
    case 'enumFieldType':
      return `initcap(replace(regexp_replace(${value}::text, '^.*[.:]', ''), '_', ' '))`;
    default:
      return `${value}::text`;
  }
}

function foldedVisibleFieldExpression(
  entity: StorageEntity,
  column: StorageEntity['columns'][number],
  tableAlias: string,
): string {
  if (
    column.fieldContract.fieldKind === 'textFieldType' &&
    (entity.foldedColumns ?? []).some(
      (candidate) => candidate.canonicalFieldId === column.canonicalFieldId,
    )
  ) {
    return foldedColumnSql(entity, column, tableAlias);
  }
  return `north_star_module.${unicodeCaseFoldFunctionName}(${visibleFieldExpression(column, tableAlias)})`;
}

function nullableDisplayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw failure(
      'MODULE_LIST_RESULT_INVALID',
      'formatted list value is not text',
    );
  }
  return value;
}

function nullableUuid(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : requiredUuid(value, 'relation recordId');
}

async function matchRecords(
  client: PoolClient,
  entity: StorageEntity,
  definition: RegisteredQueryDefinition,
  text: string,
  matchMode: 'prefix' | 'substring',
  includeArchived: boolean,
  limit: number,
  filterPlans: readonly QueryFilterLoweringPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
): Promise<RawRecord[]> {
  const selected = new Set(definition.selections.map((item) => item.fieldId));
  const columns = entity.columns.filter(
    (column) =>
      selected.has(column.canonicalFieldId) &&
      column.searchMapping === 'normalizedTextIndex',
  );
  if (columns.length === 0) {
    throw failure(
      'MODULE_SEARCH_CAPABILITY_UNAVAILABLE',
      `registered search query ${definition.queryId} has no usable lowered search column`,
      definition.queryId,
    );
  }
  const match = buildFoldedMatchPredicate(entity, columns, text, matchMode);
  const values = [...match.values];
  const predicates = archivePredicate(entity, includeArchived);
  appendLegalEntityReadScopePredicate(entity, readScope, values, predicates);
  predicates.push(match.sql);
  appendQueryFilterPredicates(entity, filterPlans, values, predicates);
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
  filterPlans: readonly QueryFilterLoweringPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
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
    filterPlans,
    readScope,
  );
  const advisoryMatches = await exactFoldedMatches(
    client,
    entity,
    columnsFor('advisory'),
    text,
    includeArchived,
    limit,
    filterPlans,
    readScope,
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
  filterPlans: readonly QueryFilterLoweringPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
): Promise<RawRecord[]> {
  if (columns.length === 0) return [];
  const match = buildFoldedMatchPredicate(entity, columns, text, 'exact');
  const values = [...match.values];
  const predicates = archivePredicate(entity, includeArchived);
  appendLegalEntityReadScopePredicate(entity, readScope, values, predicates);
  predicates.push(match.sql);
  appendQueryFilterPredicates(entity, filterPlans, values, predicates);
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

export function buildFoldedMatchPredicate(
  entity: StorageTargetPayloadV1['entities'][number],
  columns: readonly StorageTargetPayloadV1['entities'][number]['columns'][number][],
  text: string,
  mode: 'exact' | 'prefix' | 'substring',
): { readonly sql: string; readonly values: readonly unknown[] } {
  if (columns.length === 0) {
    throw failure(
      'MODULE_FOLDED_MATCH_COLUMNS_REQUIRED',
      'folded matching requires at least one declared column',
    );
  }
  return buildFoldedExpressionMatchPredicate(
    columns.map((column) => foldedColumnSql(entity, column)),
    text,
    mode,
  );
}

function buildFoldedExpressionMatchPredicate(
  foldedExpressions: readonly string[],
  text: string,
  mode: 'exact' | 'prefix' | 'substring',
  parameterOffset = 0,
): { readonly sql: string; readonly values: readonly unknown[] } {
  if (foldedExpressions.length === 0) {
    throw failure(
      'MODULE_FOLDED_MATCH_COLUMNS_REQUIRED',
      'folded matching requires at least one declared expression',
    );
  }
  const values: unknown[] = [];
  const appendParameter = (value: unknown): string => {
    values.push(value);
    return `$${String(parameterOffset + values.length)}`;
  };
  const textParameter = appendParameter(text);
  const foldedParameter = `north_star_module.${unicodeCaseFoldFunctionName}(${textParameter}::text)`;
  const escapedSubstringParameter = `replace(replace(replace(${foldedParameter}, '!', '!!'), '%', '!%'), '_', '!_')`;
  const upperBound =
    mode === 'prefix' ? foldedPrefixUpperBound(text) : undefined;
  const upperParameter =
    upperBound === null || upperBound === undefined
      ? null
      : appendParameter(upperBound);
  const terms = foldedExpressions.map((foldedColumn) => {
    switch (mode) {
      case 'exact':
        return `${foldedColumn} = ${foldedParameter}`;
      case 'substring':
        return `${foldedColumn} LIKE ('%' || ${escapedSubstringParameter} || '%') ESCAPE '!'`;
      case 'prefix':
        return upperParameter === null
          ? `${foldedColumn} COLLATE "C" >= ${foldedParameter} COLLATE "C"`
          : `(${foldedColumn} COLLATE "C" >= ${foldedParameter} COLLATE "C" AND ${foldedColumn} COLLATE "C" < ${upperParameter}::text COLLATE "C")`;
    }
  });
  return Object.freeze({
    sql: `(${terms.join(' OR ')})`,
    values: Object.freeze(values),
  });
}

/** Returns the exclusive C-collation bound for a folded literal prefix. */
export function foldedPrefixUpperBound(value: string): string | null {
  const codePoints = Array.from(unicodeCaseFold(value), (character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw failure(
        'MODULE_INPUT_MALFORMED',
        'text must contain only Unicode scalar values',
      );
    }
    return codePoint;
  });
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index]!;
    if (codePoint === 0x10ffff) continue;
    const successor =
      codePoint + 1 >= 0xd800 && codePoint + 1 <= 0xdfff
        ? 0xe000
        : codePoint + 1;
    return String.fromCodePoint(...codePoints.slice(0, index), successor);
  }
  return null;
}

function foldedColumnSql(
  entity: StorageEntity,
  column: StorageEntity['columns'][number],
  tableAlias?: string,
): string {
  const foldedColumn = (entity.foldedColumns ?? []).find(
    (candidate) => candidate.canonicalFieldId === column.canonicalFieldId,
  );
  if (foldedColumn) {
    if (
      foldedColumn.collation !== 'C' ||
      foldedColumn.foldFunction !==
        'north_star_module.nsm_unicode_case_fold_v1' ||
      foldedColumn.sourceColumn !== column.physicalName ||
      foldedColumn.stored !== true
    ) {
      throw failure(
        'MODULE_FOLDED_COLUMN_CONTRACT_INVALID',
        `stored folded column contract is invalid for ${column.canonicalFieldId}`,
        column.canonicalFieldId,
      );
    }
    return tableAlias
      ? qualified(tableAlias, foldedColumn.physicalName)
      : quoted(foldedColumn.physicalName);
  }
  if (!Object.hasOwn(entity, 'foldedColumns')) {
    const source = tableAlias
      ? qualified(tableAlias, column.physicalName)
      : quoted(column.physicalName);
    return `north_star_module.${unicodeCaseFoldFunctionName}(${source}::text)`;
  }
  throw failure(
    'MODULE_FOLDED_COLUMN_CONTRACT_MISSING',
    `stored folded column is missing for ${column.canonicalFieldId}`,
    column.canonicalFieldId,
  );
}

export function buildQueryFilterPredicate(
  entity: StorageTargetPayloadV1['entities'][number],
  plans: readonly QueryFilterLoweringPlan[],
  tableAlias?: string,
  parameterValues: Readonly<Record<string, ImmutableJsonValue>> = Object.freeze(
    {},
  ),
): { readonly sql: string; readonly values: readonly unknown[] } {
  const values: unknown[] = [];
  const terms = plans.map((plan) =>
    renderQueryFilterPlan(entity, plan, values, tableAlias, parameterValues),
  );
  return Object.freeze({
    sql: terms.length === 0 ? 'TRUE' : `(${terms.join(' AND ')})`,
    values: Object.freeze(values),
  });
}

function appendQueryFilterPredicates(
  entity: StorageEntity,
  plans: readonly QueryFilterLoweringPlan[],
  values: unknown[],
  predicates: string[],
  tableAlias?: string,
  parameterValues: Readonly<Record<string, ImmutableJsonValue>> = Object.freeze(
    {},
  ),
): void {
  for (const plan of plans) {
    predicates.push(
      renderQueryFilterPlan(entity, plan, values, tableAlias, parameterValues),
    );
  }
}

function renderQueryFilterPlan(
  entity: StorageEntity,
  plan: QueryFilterLoweringPlan,
  values: unknown[],
  tableAlias?: string,
  parameterValues: Readonly<Record<string, ImmutableJsonValue>> = Object.freeze(
    {},
  ),
): string {
  if (
    plan.kind !== 'predicateLoweringPlan' ||
    (plan.schemaVersion !== PREDICATE_LOWERING_PLAN_VERSION &&
      plan.schemaVersion !== PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION) ||
    plan.positionProfileVersion !== PREDICATE_POSITION_PROFILE_VERSION
  ) {
    throw failure(
      'MODULE_QUERY_FILTER_PLAN_INVALID',
      'query filter plan identity is invalid',
    );
  }
  return renderQueryFilterNode(
    entity,
    plan.root,
    values,
    tableAlias,
    parameterValues,
  );
}

function renderQueryFilterNode(
  entity: StorageEntity,
  node: QueryFilterLoweringPlan['root'],
  values: unknown[],
  tableAlias?: string,
  parameterValues: Readonly<Record<string, ImmutableJsonValue>> = Object.freeze(
    {},
  ),
): string {
  switch (node.kind) {
    case 'booleanPredicate':
      return node.value ? 'TRUE' : 'FALSE';
    case 'notPredicate':
      return `(NOT ${renderQueryFilterNode(entity, node.term, values, tableAlias, parameterValues)})`;
    case 'allPredicate':
    case 'anyPredicate': {
      if (node.terms.length === 0) {
        return node.kind === 'allPredicate' ? 'TRUE' : 'FALSE';
      }
      const joiner = node.kind === 'allPredicate' ? ' AND ' : ' OR ';
      return `(${node.terms
        .map((term) =>
          renderQueryFilterNode(
            entity,
            term,
            values,
            tableAlias,
            parameterValues,
          ),
        )
        .join(joiner)})`;
    }
    case 'fieldComparisonPredicate': {
      const column = entity.columns.find(
        (candidate) => candidate.canonicalFieldId === node.fieldId,
      );
      const parameterReference =
        node.value.kind === 'queryParameterReference' ? node.value : null;
      const scalarValue = parameterReference
        ? null
        : (node.value as Readonly<CanonicalScalar>);
      const sourceFieldType =
        'sourceFieldType' in node ? node.sourceFieldType : null;
      if (
        !column ||
        (sourceFieldType !== null &&
          !fieldTypeMatchesPhysicalContract(
            sourceFieldType,
            column.fieldContract,
          )) ||
        (scalarValue !== null &&
          !scalarMatchesField(scalarValue, column.fieldContract))
      ) {
        throw failure(
          'MODULE_QUERY_FILTER_PLAN_INVALID',
          'query filter comparison does not match a compiled field',
          node.fieldId,
        );
      }
      const expectedMode =
        column.fieldContract.fieldKind === 'textFieldType' &&
        column.collation === 'unicodeCaseInsensitive'
          ? 'unicodeCaseFold'
          : 'binary';
      if (node.comparisonMode !== expectedMode) {
        throw failure(
          'MODULE_QUERY_FILTER_PLAN_INVALID',
          'query filter comparison mode does not match the field contract',
          node.fieldId,
        );
      }
      const indexedFolded =
        node.loweringRowId ===
        'northstar.predicate-lowering/folded-equality-v1';
      const parameterizedComparison =
        node.loweringRowId ===
        'northstar.predicate-lowering/parameterized-comparison-v1';
      const remainingComparison =
        node.loweringRowId ===
        'northstar.predicate-lowering/tenant-scan-comparison-v1';
      if (
        (indexedFolded !==
          (node.operator === 'equals' &&
            node.comparisonMode === 'unicodeCaseFold' &&
            hasQueryFoldedIndex(entity, column)) &&
          !parameterizedComparison) ||
        (!indexedFolded && !parameterizedComparison && !remainingComparison) ||
        (parameterizedComparison &&
          !parameterReference &&
          node.operator !== 'greaterThanOrEqual' &&
          node.operator !== 'lessThanOrEqual') ||
        node.costClass !==
          (indexedFolded ? 'indexedFoldedEquality' : 'tenantBoundedScan')
      ) {
        throw failure(
          'MODULE_QUERY_FILTER_PLAN_INVALID',
          'query filter lowering row does not match physical access',
          node.fieldId,
        );
      }
      const left =
        node.comparisonMode === 'unicodeCaseFold'
          ? foldedComparisonExpression(entity, column, tableAlias)
          : tableAlias
            ? qualified(tableAlias, column.physicalName)
            : quoted(column.physicalName);
      if (
        parameterReference &&
        !Object.hasOwn(parameterValues, parameterReference.parameterId)
      ) {
        throw failure(
          'MODULE_QUERY_PARAMETER_MISSING',
          'query parameter value was not bound before provider execution',
          parameterReference.parameterId,
        );
      }
      const comparisonValue = parameterReference
        ? parameterValues[parameterReference.parameterId]
        : scalarDatabaseValue(scalarValue!);
      const valueParameter = parameter(values, comparisonValue);
      const right =
        node.comparisonMode === 'unicodeCaseFold'
          ? `north_star_module.${unicodeCaseFoldFunctionName}(${valueParameter}::text) COLLATE "C"`
          : valueParameter;
      const operator = {
        equals: '=',
        greaterThan: '>',
        greaterThanOrEqual: '>=',
        lessThan: '<',
        lessThanOrEqual: '<=',
        notEquals: '<>',
      }[node.operator];
      return `(${left} IS NOT NULL AND ${left} ${operator} ${right})`;
    }
  }
}

function foldedComparisonExpression(
  entity: StorageEntity,
  column: StorageEntity['columns'][number],
  tableAlias?: string,
): string {
  const folded = entity.foldedColumns.find(
    (candidate) => candidate.canonicalFieldId === column.canonicalFieldId,
  );
  if (folded) {
    return `${
      tableAlias
        ? qualified(tableAlias, folded.physicalName)
        : quoted(folded.physicalName)
    } COLLATE "C"`;
  }
  const value = tableAlias
    ? qualified(tableAlias, column.physicalName)
    : quoted(column.physicalName);
  return `north_star_module.${unicodeCaseFoldFunctionName}(${value}::text) COLLATE "C"`;
}

function hasQueryFoldedIndex(
  entity: StorageEntity,
  column: StorageEntity['columns'][number],
): boolean {
  const folded = entity.foldedColumns.find(
    (candidate) => candidate.canonicalFieldId === column.canonicalFieldId,
  );
  return (
    folded !== undefined &&
    entity.indexes.some(
      (index) =>
        (index.indexKind === 'foldedAccess' &&
          index.columnNames.includes(folded.physicalName)) ||
        (index.indexKind === 'caseInsensitiveUnique' &&
          index.columnNames.includes(column.physicalName)),
    )
  );
}

function scalarMatchesField(
  scalar: Readonly<CanonicalScalar>,
  field: StorageEntity['columns'][number]['fieldContract'],
): boolean {
  const expected: Record<typeof field.fieldKind, CanonicalScalar['kind']> = {
    booleanFieldType: 'booleanValue',
    dateFieldType: 'dateValue',
    dateTimeFieldType: 'dateTimeValue',
    enumFieldType: 'textValue',
    exactDecimalFieldType: 'exactDecimalValue',
    integerFieldType: 'integerValue',
    moneyFieldType: 'moneyValue',
    quantityFieldType: 'quantityValue',
    textFieldType: 'textValue',
    timeFieldType: 'timeValue',
  };
  return scalar.kind === expected[field.fieldKind];
}

function fieldTypeMatchesPhysicalContract(
  type: unknown,
  field: StorageEntity['columns'][number]['fieldContract'],
): boolean {
  if (!isRecord(type) || type.kind !== field.fieldKind) return false;
  switch (field.fieldKind) {
    case 'textFieldType':
      return type.maximumLength === field.bounds.maximumLength;
    case 'enumFieldType': {
      if (!Array.isArray(type.options)) return false;
      const optionIds = type.options
        .map((option) => (isRecord(option) ? option.optionId : null))
        .filter((optionId): optionId is string => typeof optionId === 'string')
        .sort();
      return (
        optionIds.length === type.options.length &&
        optionIds.join('\0') === field.enumOptionIds.join('\0')
      );
    }
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return (
        type.precision === field.bounds.precision &&
        type.scale === field.bounds.scale
      );
    case 'dateFieldType':
      return field.temporal.timezoneSemantics === 'calendarDate';
    case 'timeFieldType':
      return (
        type.precision === field.temporal.precision &&
        field.temporal.timezoneSemantics === 'localWallTime'
      );
    case 'dateTimeFieldType':
      return (
        type.precision === field.temporal.precision &&
        type.timezoneSemantics === field.temporal.timezoneSemantics
      );
    case 'booleanFieldType':
    case 'integerFieldType':
      return true;
  }
}

function scalarDatabaseValue(scalar: Readonly<CanonicalScalar>): unknown {
  switch (scalar.kind) {
    case 'booleanValue':
      return scalar.value;
    case 'dateTimeValue':
    case 'dateValue':
    case 'exactDecimalValue':
    case 'integerValue':
    case 'moneyValue':
    case 'quantityValue':
    case 'textValue':
    case 'timeValue':
      return scalar.value;
  }
}

async function loadRawRecord(
  client: PoolClient,
  entity: StorageEntity,
  recordId: string,
  includeArchived: boolean,
  filterPlans: readonly QueryFilterLoweringPlan[],
): Promise<RawRecord | null> {
  const values: unknown[] = [];
  const predicates = archivePredicate(entity, includeArchived);
  predicates.push(
    `${quoted(entity.recordIdentity.column)} = ${parameter(values, recordId)}`,
  );
  appendQueryFilterPredicates(entity, filterPlans, values, predicates);
  const result = await client.query<QueryResultRow>(
    selectSql(entity, predicates, 'LIMIT 1'),
    values,
  );
  return result.rows[0] ? rawRecord(entity, result.rows[0]) : null;
}

async function loadScopedRawRecord(
  client: PoolClient,
  entity: StorageEntity,
  recordId: string,
  includeArchived: boolean,
  filterPlans: readonly QueryFilterLoweringPlan[],
  readScope: VerifiedLegalEntityReadScope | null,
  relationTargets: readonly RelationTargetPlan[] = [],
): Promise<RawRecord | null> {
  const values: unknown[] = [];
  const predicates = archivePredicate(entity, includeArchived);
  appendLegalEntityReadScopePredicate(entity, readScope, values, predicates);
  predicates.push(
    `${quoted(entity.recordIdentity.column)} = ${parameter(values, recordId)}`,
  );
  appendQueryFilterPredicates(entity, filterPlans, values, predicates);
  const result = await client.query<QueryResultRow>(
    selectSql(
      entity,
      predicates,
      'LIMIT 1',
      relationTargets.map((target) => target.column),
    ),
    values,
  );
  const row = result.rows[0];
  if (!row) return null;
  const record = rawRecord(entity, row);
  // The stated targets are read in the same statement as the record itself.
  return relationTargets.length
    ? Object.freeze({
        ...record,
        relationTargets: Object.freeze(
          Object.fromEntries(
            relationTargets.map((target) => [
              target.relationId,
              nullableUuid(row[target.column]),
            ]),
          ),
        ),
      })
    : record;
}

interface RelationTargetPlan {
  readonly column: string;
  readonly relationId: string;
}

/**
 * The relations a get is asked to state (`relationTargets`), resolved against
 * the PINNED COMPILED storage, never against caller input: each must be a
 * relation whose source is the queried entity, and it reads that relation's
 * own compiled column. Anything else is refused by name rather than read, as
 * list progress fails closed. The gateway has already ruled the shape.
 */
export function relationTargetPlans(
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  requested: ImmutableJsonValue | undefined,
): readonly RelationTargetPlan[] {
  if (requested === undefined) return [];
  if (!Array.isArray(requested) || requested.length === 0)
    throw failure(
      'MODULE_RELATION_TARGET_INVALID',
      'relation targets must name at least one relation',
    );
  return Object.freeze(
    requested.map((relationId) => {
      const relation = storage.relations.find(
        (candidate) =>
          candidate.relationId === relationId &&
          candidate.sourceEntityId === entity.entityId,
      );
      if (!relation)
        throw failure(
          'MODULE_RELATION_TARGET_INVALID',
          'a relation target must be a compiled relation of the queried entity',
          typeof relationId === 'string' ? relationId : null,
        );
      return Object.freeze({
        column: relation.relationColumn.physicalName,
        relationId: relation.relationId,
      });
    }),
  );
}

/** A get's stated relation targets: the stored target id, never a label. */
function withRelationTargets(
  dto: SemanticRecordDto,
  record: RawRecord,
  targets: readonly RelationTargetPlan[],
): SemanticRecordDto {
  if (!targets.length) return dto;
  return Object.freeze({
    ...dto,
    relationLabels: Object.freeze(
      Object.fromEntries(
        targets.map((target) => [
          target.relationId,
          Object.freeze({
            label: null,
            recordId: record.relationTargets?.[target.relationId] ?? null,
          }),
        ]),
      ),
    ),
  });
}

function selectSql(
  entity: StorageEntity,
  predicates: readonly string[],
  suffix: string,
  extraColumns: readonly string[] = [],
): string {
  const columns = [
    entity.recordIdentity.column,
    entity.optimisticRevision.column,
    entity.archive.archivedAtColumn,
    ...entity.columns.map((column) => column.physicalName),
  ];
  for (const column of extraColumns)
    if (!columns.includes(column)) columns.push(column);
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
  request:
    | SemanticAggregateQueryExecutionRequest
    | SemanticOperationExecutionRequest
    | SemanticQueryExecutionRequest,
  observeValidation: PinnedStorageTargetValidationObservation,
): Promise<StorageTargetPayloadV1> {
  const result = await client.query<ArtifactRow>(
    `SELECT artifact_kind, content_hash, domain_tag, media_type, canonical_bytes
       FROM platform.read_tenant_release_artifacts($1)`,
    [request.view.release.releaseId],
  );
  observeValidation('tenantVisibleArtifactsRead');
  const artifacts = new Map(result.rows.map((row) => [row.content_hash, row]));
  for (const artifact of artifacts.values()) verifyArtifact(artifact);
  observeValidation('artifactHashesVerified');
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
  if (!reference || typeof reference.artifactRoot !== 'string') {
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
  observeValidation('canonicalArtifactsDecoded');
  assertSupportedStorageTargetArtifactVersions({
    projectionPayloadSchemaVersion: projection.payloadSchemaVersion,
    referencePayloadSchemaVersion: reference.payloadSchemaVersion,
    targetSchemaVersion: target.schemaVersion,
  });
  if (
    target.kind !== 'storageTargetPayload' ||
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
  const validated = target as unknown as StorageTargetPayloadV1;
  assertModuleSemanticStorageContract(validated);
  observeValidation('schemaValidated');
  return validated;
}

export function assertSupportedStorageTargetArtifactVersions(versions: {
  readonly projectionPayloadSchemaVersion: unknown;
  readonly referencePayloadSchemaVersion: unknown;
  readonly targetSchemaVersion: unknown;
}): void {
  if (
    !SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS.some(
      (supportedVersion) =>
        supportedVersion === versions.referencePayloadSchemaVersion,
    )
  ) {
    throw failure(
      'MODULE_STORAGE_PROJECTION_MISSING',
      'pinned release has no supported storage target',
    );
  }
  if (
    versions.projectionPayloadSchemaVersion !==
    versions.referencePayloadSchemaVersion
  ) {
    throw failure(
      'MODULE_STORAGE_PROJECTION_MALFORMED',
      'storage projection manifest payload version does not match its release reference',
    );
  }
  if (versions.targetSchemaVersion !== versions.referencePayloadSchemaVersion) {
    throw failure(
      'MODULE_STORAGE_TARGET_MALFORMED',
      'storage target payload version does not match its projection manifest',
    );
  }
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

export async function withModuleRuntimeRole<T>(
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

/**
 * Exported so a gate can ask the REAL write path whether an input is acceptable
 * without standing up a database.
 *
 * This is the first thing `#executeOperation` does (`:311`), before a
 * connection is taken, and it is where every compiled value contract is
 * enforced -- enum membership, decimal precision and scale, ISO date, time and
 * date-time shape against the declared precision and timezone semantics. A
 * browser round trip that asserts what a form SUBMITS is asserting a proxy
 * unless something decides whether the provider would accept it; this is that
 * decision, not a copy of it.
 */
export function parseMutationInput(
  definition:
    | RegisteredRecordOperationDefinition
    | RegisteredTransitionOperationDefinition,
  value: ImmutableJsonValue,
): MutationInput {
  const contract = definition.inputContract;
  if (!contract) {
    throw failure(
      'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
      'pinned operation lacks the required semantic input contract',
      definition.operationId,
    );
  }
  const input = requireRecord(value, 'operation input');
  const recordId = requiredUuid(input.recordId, 'recordId');
  switch (definition.effect.kind) {
    case 'createRecordEffect':
      assertAllowedKeys(input, contract.closedArgumentKeys);
      return validateMutationInput(contract, {
        expectedRevision: null,
        patch: immutableRecord(input.values, 'values'),
        recordId,
        relations: uuidRecord(input.relations, 'relations'),
        systemInput: requiredSystemInput(contract, input),
      });
    case 'updateRecordEffect':
      assertAllowedKeys(input, contract.closedArgumentKeys);
      return validateMutationInput(contract, {
        expectedRevision: requiredRevision(input.expectedRevision),
        patch: immutableRecord(input.patch, 'patch'),
        recordId,
        relations: Object.freeze({}),
        systemInput: null,
      });
    // A transition takes the SAME closed two-argument input as archive and
    // restore, and carries an empty patch. That emptiness is not incidental:
    // it is what makes the target server-selected rather than caller-supplied.
    // The gateway now applies the same closed-key fence before this point;
    // this check stays as the inner of two, because the provider must not
    // trust an input contract it did not read itself.
    case 'archiveRecordEffect':
    case 'restoreRecordEffect':
    case 'transitionStateEffect':
      assertAllowedKeys(input, contract.closedArgumentKeys);
      return validateMutationInput(contract, {
        expectedRevision: requiredRevision(input.expectedRevision),
        patch: Object.freeze({}),
        recordId,
        relations: Object.freeze({}),
        systemInput: null,
      });
  }
}

function validateMutationInput(
  contract: RegisteredOperationInputContract,
  input: MutationInput,
): MutationInput {
  const fields = new Map(
    contract.fields.map((field) => [field.fieldId, field] as const),
  );
  const writable = new Set(contract.writableFieldIds);
  for (const [fieldId, value] of Object.entries(input.patch)) {
    const field = fields.get(fieldId);
    if (!field || !writable.has(fieldId) || !field.writable) {
      throw failure(
        'MODULE_FIELD_UNSUPPORTED',
        'operation input contains a field outside its writable set',
        fieldId,
      );
    }
    validateFieldValue(field, value);
  }
  if (input.expectedRevision === null) {
    for (const field of contract.fields) {
      if (field.required && !Object.hasOwn(input.patch, field.fieldId)) {
        throw failure(
          'MODULE_REQUIRED_FIELD_MISSING',
          'required operation input field is missing',
          field.fieldId,
        );
      }
    }
  }
  const relations = new Map(
    contract.relationInputs.map(
      (relation) => [relation.relationId, relation] as const,
    ),
  );
  for (const relationId of Object.keys(input.relations)) {
    if (!relations.has(relationId)) {
      throw failure(
        'MODULE_RELATION_UNSUPPORTED',
        'operation input contains an unknown relation',
        relationId,
      );
    }
  }
  for (const relation of contract.relationInputs) {
    if (
      relation.required &&
      !Object.hasOwn(input.relations, relation.relationId)
    ) {
      throw failure(
        'MODULE_REQUIRED_RELATION_MISSING',
        'required operation input relation is missing',
        relation.relationId,
      );
    }
  }
  return input;
}

function requiredSystemInput(
  contract: RegisteredOperationInputContract,
  input: Readonly<Record<string, ImmutableJsonValue>>,
): MutationInput['systemInput'] {
  const systemInput = contract.systemInput;
  if (!systemInput) return null;
  if (!Object.hasOwn(input, systemInput.argumentKey)) {
    throw failure(
      'MODULE_REQUIRED_SYSTEM_INPUT_MISSING',
      'required compiler-derived operation input is missing',
      systemInput.argumentKey,
    );
  }
  return Object.freeze({
    contract: systemInput,
    value: requiredUuid(
      input[systemInput.argumentKey],
      systemInput.argumentKey,
    ),
  });
}

function assertOperationSystemInputStorageContract(
  definition: RegisteredOperationDefinition,
  entity: StorageEntity,
  input: MutationInput,
): void {
  const contract = definition.inputContract;
  const systemInput = contract?.systemInput;
  const storageInput = entity.legalEntity;
  if (definition.effect.kind !== 'createRecordEffect') {
    if (systemInput || input.systemInput) {
      throw failure(
        'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
        'immutable system input is present on a non-create operation',
        definition.operationId,
      );
    }
    return;
  }
  if (!storageInput && !systemInput && !input.systemInput) return;
  if (
    !storageInput ||
    !systemInput ||
    !input.systemInput ||
    systemInput.argumentKey !== 'legalEntityId' ||
    systemInput.classification !== 'INTERNAL' ||
    systemInput.immutableAfterCreate !== storageInput.immutableAfterCreate ||
    systemInput.physicalColumn !== storageInput.column ||
    systemInput.required !== !storageInput.nullable ||
    systemInput.valueKind !== storageInput.postgresqlType
  ) {
    throw failure(
      'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
      'pinned operation system input does not match compiled storage',
      definition.operationId,
    );
  }
}

/**
 * ADR-0015:100. A compiler-declared legal-entity create operand names new
 * work, so the selected master must still have active business status and
 * must not be generically archived when the row is inserted. The master row
 * is locked in the same accepted-mutation transaction as the create; a
 * concurrent status or archive update cannot pass between this check and the
 * insert.
 */
async function requireActiveCreateLegalEntity(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  definition: RegisteredOperationDefinition,
  input: MutationInput,
): Promise<void> {
  if (
    definition.effect.kind !== 'createRecordEffect' ||
    entity.legalEntity === undefined
  ) {
    return;
  }
  if (!input.systemInput) {
    throw failure(
      'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
      'entity-owned create reached execution without its system input',
      definition.operationId,
    );
  }
  const masters = storage.entities.filter(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  if (masters.length !== 1) {
    throw failure(
      'MODULE_STORAGE_TARGET_MALFORMED',
      'entity-owned create requires exactly one legal-entity master',
      entity.entityId,
    );
  }
  const master = masters[0]!;
  const descriptor = master.legalEntityMaster!;
  for (const identifier of [
    master.physicalTableName,
    master.recordIdentity.column,
    master.archive.archivedAtColumn,
    descriptor.fieldColumns.status,
  ]) {
    safeIdentifier(identifier);
  }
  const selected = await client.query<{
    archivedAt: Date | string | null;
    status: string;
  }>(
    `SELECT ${quoted(descriptor.fieldColumns.status)}::text AS status,
            ${quoted(master.archive.archivedAtColumn)} AS "archivedAt"
       FROM north_star_module.${quoted(master.physicalTableName)}
      WHERE tenant_id = north_star_internal.trusted_tenant_id()
        AND environment_id = north_star_internal.trusted_environment_id()
        AND ${quoted(master.recordIdentity.column)} = $1
      FOR NO KEY UPDATE`,
    [input.systemInput.value],
  );
  if (
    selected.rows[0]?.status !== descriptor.activeStatusValue ||
    selected.rows[0]?.archivedAt !== null
  ) {
    throw failure(
      'MODULE_LEGAL_ENTITY_CREATE_INACTIVE',
      'legal entity is not active for new work',
      input.systemInput.value,
    );
  }
}

function validateFieldValue(
  field: RegisteredOperationInputContract['fields'][number],
  value: ImmutableJsonValue,
): void {
  if (value === null) {
    if (field.required) {
      throw failure(
        'MODULE_REQUIRED_FIELD_CLEAR_FORBIDDEN',
        'required operation input field cannot be cleared',
        field.fieldId,
      );
    }
    return;
  }
  let valid = false;
  switch (field.fieldKind) {
    case 'booleanFieldType':
      valid = typeof value === 'boolean';
      break;
    case 'textFieldType':
      valid =
        typeof value === 'string' &&
        (field.bounds.maximumLength === null ||
          [...value].length <= field.bounds.maximumLength);
      break;
    case 'enumFieldType':
      valid = typeof value === 'string' && field.enumOptionIds.includes(value);
      break;
    case 'integerFieldType':
      valid =
        typeof value === 'string' && /^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(value);
      break;
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      valid =
        typeof value === 'string' &&
        decimalFits(value, field.bounds.precision, field.bounds.scale);
      break;
    case 'dateFieldType':
      valid = typeof value === 'string' && isValidIsoDate(value);
      break;
    case 'timeFieldType':
      valid =
        typeof value === 'string' &&
        isValidIsoTime(value, field.temporal.precision);
      break;
    case 'dateTimeFieldType':
      valid =
        typeof value === 'string' &&
        isValidIsoDateTime(
          value,
          field.temporal.precision,
          field.temporal.timezoneSemantics,
        );
      break;
  }
  if (!valid) {
    throw failure(
      field.fieldKind === 'enumFieldType'
        ? 'MODULE_ENUM_VALUE_INVALID'
        : 'MODULE_FIELD_VALUE_INVALID',
      'operation input field violates its compiled value contract',
      field.fieldId,
    );
  }
}

function decimalFits(
  value: string,
  precision: number | null,
  scale: number | null,
): boolean {
  if (
    precision === null ||
    scale === null ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u.test(value) ||
    value === '-0'
  ) {
    return false;
  }
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const integerDigits = integer === '0' ? 0 : integer!.length;
  return (
    fraction.length <= scale &&
    integerDigits <= precision - scale &&
    Math.max(1, integerDigits + fraction.length) <= precision
  );
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isValidIsoTime(
  value: string,
  precision: 'millisecond' | 'second' | null,
): boolean {
  if (precision === null) return false;
  const match = new RegExp(
    `^(\\d{2}):(\\d{2}):(\\d{2})${precision === 'millisecond' ? '\\.\\d{3}' : ''}$`,
    'u',
  ).exec(value);
  return (
    match !== null &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    Number(match[3]) < 60
  );
}

function isValidIsoDateTime(
  value: string,
  precision: 'millisecond' | 'second' | null,
  timezoneSemantics:
    'calendarDate' | 'localWallTime' | 'offsetDateTime' | 'utcInstant' | null,
): boolean {
  if (
    precision === null ||
    (timezoneSemantics !== 'utcInstant' &&
      timezoneSemantics !== 'offsetDateTime')
  ) {
    return false;
  }
  const fraction = precision === 'millisecond' ? '(\\.\\d{3})' : '';
  const zone =
    timezoneSemantics === 'utcInstant' ? '(Z)' : '([+-](\\d{2}):(\\d{2}))';
  const match = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})${fraction}${zone}$`,
    'u',
  ).exec(value);
  if (!match || !isValidIsoDate(match[1]!)) return false;
  const time = `${match[2]}${precision === 'millisecond' ? match[3] : ''}`;
  if (!isValidIsoTime(time, precision)) return false;
  if (timezoneSemantics === 'utcInstant') return true;
  const zoneValue = match.at(-3);
  const offsetHour = Number(match.at(-2));
  const offsetMinute = Number(match.at(-1));
  if (zoneValue === '-00:00') return false;
  return (
    offsetMinute < 60 &&
    (offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0))
  );
}

export function assertModuleSemanticStorageContract(
  storage: StorageTargetPayloadV1,
): void {
  const invalidEntity = storage.entities.find(
    (entity) =>
      !Array.isArray(entity.checkConstraints) ||
      entity.columns.some(
        (column) =>
          !column.fieldContract ||
          column.fieldContract.schemaVersion !==
            'northstar.module-field-contract/v1' ||
          !column.fieldContract.temporal,
      ),
  );
  const invalidRelation = storage.relations.find(
    (relation) =>
      relation.archiveBehavior !== 'restrict' &&
      relation.archiveBehavior !== 'retainReference',
  );
  if (invalidEntity || invalidRelation) {
    throw failure(
      'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
      'pinned storage lacks the required semantic enforcement contract',
      invalidRelation?.relationId ?? invalidEntity?.entityId ?? null,
    );
  }
}

/**
 * The compiler-owned marker is the entire dispatch key. Module identity,
 * entity identity, and domain-specific families are intentionally absent.
 */
export function legalEntityReadScopeRequirement(
  entity: StorageEntity,
): StorageLegalEntityReadScopeRequirement | null {
  if (!Object.hasOwn(entity, 'legalEntity')) return null;
  const legalEntity = entity.legalEntity;
  if (
    !legalEntity ||
    legalEntity.column !== 'legal_entity_id' ||
    legalEntity.familyClassification !== 'entityOwned' ||
    legalEntity.immutableAfterCreate !== true ||
    legalEntity.nullable !== false ||
    legalEntity.postgresqlType !== 'uuid' ||
    legalEntity.referencedFamilyId !== 'legal_entity'
  ) {
    throw failure(
      'MODULE_STORAGE_TARGET_MALFORMED',
      'entity-owned storage has an invalid legal-entity scope descriptor',
      entity.entityId,
    );
  }
  safeIdentifier(legalEntity.column);
  return Object.freeze({ column: legalEntity.column, kind: 'legalEntity' });
}

async function verifyLegalEntityReadScope(
  client: PoolClient,
  storage: StorageTargetPayloadV1,
  value: LegalEntityReadScope | null,
  readEntities: readonly StorageEntity[],
): Promise<VerifiedLegalEntityReadScope | null> {
  const required: Array<{
    entity: StorageEntity;
    requirement: StorageLegalEntityReadScopeRequirement;
  }> = [];
  for (const entity of readEntities) {
    const requirement = legalEntityReadScopeRequirement(entity);
    if (requirement) required.push({ entity, requirement });
  }
  if (required.length === 0) return null;
  if (value === null || value === undefined) {
    throw failure(
      'MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED',
      'entity-owned reads require an issued legal-entity read scope',
      required[0]!.entity.entityId,
    );
  }

  const legalEntityIds = value.legalEntityIds;

  const masters = storage.entities.filter(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  if (masters.length !== 1) {
    throw failure(
      'MODULE_STORAGE_TARGET_MALFORMED',
      'entity-owned storage requires exactly one legal-entity master',
      required[0]!.entity.entityId,
    );
  }
  const master = masters[0]!;
  safeIdentifier(master.physicalTableName);
  safeIdentifier(master.recordIdentity.column);

  const result = await client.query<{ legal_entity_id: string }>(
    `SELECT ${quoted(master.recordIdentity.column)}::text AS legal_entity_id
       FROM north_star_module.${quoted(master.physicalTableName)}
      WHERE ${quoted(master.recordIdentity.column)} = ANY($1::uuid[])`,
    [[...legalEntityIds]],
  );
  const existingIds = new Set(
    result.rows.map((row) =>
      requiredUuid(row.legal_entity_id, 'legalEntityId'),
    ),
  );
  const missingId = legalEntityIds.find(
    (legalEntityId) => !existingIds.has(legalEntityId),
  );
  if (missingId) {
    throw failure(
      'MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND',
      'issued legal-entity read scope contains no tenant-visible entity',
      missingId,
    );
  }
  return Object.freeze({ legalEntityIds });
}

function appendLegalEntityReadScopePredicate(
  entity: StorageEntity,
  readScope: VerifiedLegalEntityReadScope | null,
  values: unknown[],
  predicates: string[],
  alias?: string,
): void {
  const requirement = legalEntityReadScopeRequirement(entity);
  if (!requirement) return;
  if (!readScope) {
    throw failure(
      'MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED',
      'verified legal-entity read scope is absent during predicate lowering',
      entity.entityId,
    );
  }
  const column = alias
    ? qualified(alias, requirement.column)
    : quoted(requirement.column);
  predicates.push(
    `${column} = ANY(${parameter(values, [...readScope.legalEntityIds])}::uuid[])`,
  );
}

function legalEntityReadScopeJoinConjunction(
  entity: StorageEntity,
  readScope: VerifiedLegalEntityReadScope | null,
  values: unknown[],
  alias: string,
): string {
  const requirement = legalEntityReadScopeRequirement(entity);
  if (!requirement) return '';
  if (!readScope) {
    throw failure(
      'MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED',
      'verified legal-entity read scope is absent during join lowering',
      entity.entityId,
    );
  }
  return `
          AND ${qualified(alias, requirement.column)} = ANY(${parameter(values, [...readScope.legalEntityIds])}::uuid[])`;
}

function createChanges(
  contract: RegisteredOperationInputContract | undefined,
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
  if (input.systemInput) {
    changes.push(
      Object.freeze({
        classification: input.systemInput.contract.classification,
        fieldId: input.systemInput.contract.argumentKey,
        newState: valueState(input.systemInput.value),
        oldState: Object.freeze({ state: 'ABSENT' }),
      }),
    );
  }
  for (const [fieldId, value] of Object.entries(input.patch).sort(
    compareEntry,
  )) {
    changes.push(
      Object.freeze({
        classification: fieldClassification(contract, fieldId),
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
        classification: 'INTERNAL',
        fieldId: auditFieldId(relationId),
        newState: valueState(recordId),
        oldState: Object.freeze({ state: 'ABSENT' }),
      }),
    );
  }
  return Object.freeze(changes);
}

function updateChanges(
  contract: RegisteredOperationInputContract | undefined,
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
          classification: fieldClassification(contract, fieldId),
          fieldId: auditFieldId(fieldId),
          newState: valueState(value),
          oldState: valueState(prior.values[fieldId] ?? null),
        }),
      ),
  );
}

function fieldClassification(
  contract: RegisteredOperationInputContract | undefined,
  fieldId: string,
): 'INTERNAL' | 'PUBLIC' {
  const field =
    contract?.fields.find((candidate) => candidate.fieldId === fieldId) ??
    contract?.assignedFields?.find(
      (candidate) => candidate.fieldId === fieldId,
    );
  if (!field) {
    throw failure(
      'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
      'pinned operation lacks canonical field classification',
      fieldId,
    );
  }
  return field.classification;
}

function valueState(value: unknown): BusinessValueStateInput {
  return value === null
    ? Object.freeze({ state: 'CLEARED' })
    : Object.freeze({ state: 'VALUE', value });
}

export function auditFieldId(canonicalId: string): string {
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
  return value;
}

function optionalSearchMatchMode(
  value: ImmutableJsonValue | undefined,
): 'prefix' | 'substring' {
  if (value === undefined || value === 'substring') return 'substring';
  if (value === 'prefix') return 'prefix';
  throw failure(
    'MODULE_INPUT_MALFORMED',
    'matchMode must be prefix or substring',
  );
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

function qualified(tableAlias: string, identifier: string): string {
  return `${quoted(tableAlias)}.${quoted(identifier)}`;
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

export function translateModuleProviderError(
  error: unknown,
  storage: StorageTargetPayloadV1,
  entityId: string,
  providerErrorMappings: readonly ModuleProviderErrorMapping[] = [],
): ModuleRuntimeInterpreterError {
  const entity = requiredEntity(storage, entityId);
  if (error instanceof ModuleRuntimeInterpreterError) return error;
  const code = providerErrorProperty(error, 'code');
  const constraint = providerErrorProperty(error, 'constraint');
  if (code === '23505') {
    const uniquePhysicalName = [
      ...entity.uniqueKeys.map((candidate) => candidate.physicalName),
      ...entity.indexes
        .filter((candidate) => candidate.indexKind === 'caseInsensitiveUnique')
        .map((candidate) => candidate.physicalName),
    ].find((candidate) => candidate === constraint);
    const subjectId = uniquePhysicalName
      ? canonicalUniqueSubject(storage, uniquePhysicalName)
      : entity.entityId;
    return failure(
      'MODULE_UNIQUE_VIOLATION',
      'module uniqueness contract rejected the value',
      subjectId,
    );
  }
  if (code === '23503') {
    const relation = storage.relations.find(
      (candidate) => candidate.foreignKey.physicalName === constraint,
    );
    return failure(
      'MODULE_RELATION_VIOLATION',
      'module relation contract rejected the value',
      relation?.relationId ?? entity.entityId,
    );
  }
  const registered = registeredProviderFailure(
    error,
    entity.entityId,
    providerErrorMappings,
  );
  if (registered) {
    return registered;
  }
  return unregisteredProviderFailure(error, entity.entityId);
}

function canonicalUniqueSubject(
  storage: StorageTargetPayloadV1,
  physicalName: string,
): string {
  const mapping = storage.physicalMapping.records.find(
    (record) =>
      (record.objectKind === 'constraint' || record.objectKind === 'index') &&
      record.physicalName === physicalName,
  );
  return mapping?.canonicalId.split('#')[0] ?? 'module:field.unknown';
}

function providerErrorProperty(
  error: unknown,
  property: 'code' | 'column' | 'constraint' | 'detail' | 'message' | 'table',
): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === 'string' ? value : null;
}

function providerBoundaryFailure(
  error: unknown,
  subjectId: string,
  providerErrorMappings: readonly ModuleProviderErrorMapping[],
): ModuleRuntimeInterpreterError | SharedListContractError {
  if (
    error instanceof ModuleRuntimeInterpreterError ||
    error instanceof SharedListContractError
  ) {
    return error;
  }
  return (
    registeredProviderFailure(error, subjectId, providerErrorMappings) ??
    unregisteredProviderFailure(error, subjectId)
  );
}

function failure(
  code: string,
  message: string,
  subjectId: string | null = null,
  details: Readonly<Record<string, string>> = Object.freeze({}),
  providerMetadata: ModuleProviderErrorMetadata | null = null,
): ModuleRuntimeInterpreterError {
  return new ModuleRuntimeInterpreterError(
    code,
    message,
    subjectId,
    details,
    providerMetadata,
  );
}

function registeredProviderFailure(
  error: unknown,
  subjectId: string,
  providerErrorMappings: readonly ModuleProviderErrorMapping[],
): ModuleRuntimeInterpreterError | null {
  const metadata = providerErrorMetadata(error);
  const providerMessage = providerErrorProperty(error, 'message');
  if (!metadata || !providerMessage) return null;
  const registration = providerErrorMappings.find(
    (candidate) =>
      candidate.sqlstate === metadata.sqlstate &&
      candidate.providerMessage === providerMessage,
  );
  if (!registration) return null;
  let mapped: ModuleProviderErrorMappingResult | null;
  try {
    mapped = registration.translate(
      Object.freeze({
        detail: providerErrorProperty(error, 'detail'),
        metadata,
        providerMessage,
        subjectId,
      }),
    );
  } catch {
    return failure(
      'MODULE_PROVIDER_ERROR_MAPPING_INVALID',
      'registered module provider error mapping failed',
      subjectId,
    );
  }
  if (mapped === null) return null;
  if (
    !/^[A-Z][A-Z0-9_]{1,79}$/u.test(mapped.code) ||
    mapped.message.trim() === '' ||
    (mapped.subjectId !== null && mapped.subjectId.trim() === '') ||
    Object.values(mapped.details).some((value) => typeof value !== 'string')
  ) {
    return failure(
      'MODULE_PROVIDER_ERROR_MAPPING_INVALID',
      'registered module provider error mapping returned an invalid result',
      subjectId,
    );
  }
  return failure(mapped.code, mapped.message, mapped.subjectId, mapped.details);
}

function unregisteredProviderFailure(
  error: unknown,
  subjectId: string,
): ModuleRuntimeInterpreterError {
  const metadata = providerErrorMetadata(error);
  return failure(
    'MODULE_PROVIDER_FAILURE',
    metadata
      ? `module provider rejected the operation (sqlstate=${metadata.sqlstate} relation=${metadata.relationName ?? 'unknown'} constraint=${metadata.constraintName ?? 'unknown'} column=${metadata.columnName ?? 'unknown'})`
      : 'module provider rejected the operation',
    subjectId,
    Object.freeze({}),
    metadata,
  );
}

function providerErrorMetadata(
  error: unknown,
): ModuleProviderErrorMetadata | null {
  const sqlstate = providerErrorProperty(error, 'code');
  if (!sqlstate || !/^[0-9A-Z]{5}$/u.test(sqlstate)) return null;
  return Object.freeze({
    columnName: providerErrorProperty(error, 'column'),
    constraintName: providerErrorProperty(error, 'constraint'),
    relationName: providerErrorProperty(error, 'table'),
    sqlstate,
  });
}

function validatedProviderErrorMappings(
  mappings: readonly ModuleProviderErrorMapping[],
): readonly ModuleProviderErrorMapping[] {
  const keys = new Set<string>();
  return Object.freeze(
    mappings.map((mapping) => {
      if (
        !/^[0-9A-Z]{5}$/u.test(mapping.sqlstate) ||
        mapping.providerMessage.trim() === ''
      ) {
        throw new TypeError('module provider error mapping is invalid');
      }
      const key = `${mapping.sqlstate}\0${mapping.providerMessage}`;
      if (keys.has(key)) {
        throw new TypeError('module provider error mapping is duplicated');
      }
      keys.add(key);
      return Object.freeze({
        providerMessage: mapping.providerMessage,
        sqlstate: mapping.sqlstate,
        translate: mapping.translate,
      });
    }),
  );
}
