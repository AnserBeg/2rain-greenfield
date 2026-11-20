import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DOCUMENT_ATTACH_CAPABILITY,
  documentAttachOperation,
  documentAttachPermission,
} from '../../canonical-model/src/documents.js';
import {
  DocumentRequestError,
  type DocumentMetadata,
} from '../../runtime/src/document-gateway.js';
import type { RequestRuntimeView } from '../../runtime/src/request-runtime-view.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationAuthorizationRequest,
  type RegisteredCapabilityOperationDefinition,
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationGateway,
  type SemanticOperationMediationAuthority,
} from '../../runtime/src/semantic-operation-gateway.js';
import type {
  SemanticRecordDto,
  RegisteredQueryDefinition,
} from '../../runtime/src/semantic-query-gateway.js';

interface StagedPublication {
  readonly view: RequestRuntimeView;
  readonly record: SemanticRecordDto;
  readonly query: RegisteredQueryDefinition;
  readonly companyId: string | null;
  readonly uploadId: string;
  readonly commit: () => Promise<DocumentMetadata>;
  receipt?: DocumentMetadata;
}

/** The original request can publish only its scanned staging input. */
export class PostgresDocumentPublication implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = DOCUMENT_ATTACH_CAPABILITY;
  readonly #staged = new AsyncLocalStorage<StagedPublication>();

  async publish(
    stage: StagedPublication,
    operations: SemanticOperationGateway,
    mediation: SemanticOperationMediationAuthority,
  ): Promise<DocumentMetadata> {
    return this.#staged.run(stage, async () => {
      const result = await operations.invoke(
        stage.view,
        {
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          operationId: documentAttachOperation(stage.record.entityId),
          confirmationGrant: null,
          idempotencyKey: stage.uploadId,
          input: {
            recordId: stage.record.recordId,
            expectedRevision: stage.record.revision,
            uploadId: stage.uploadId,
          },
        },
        mediation.issueInvocation(stage.view, 'UI'),
      );
      if (result.outcome !== 'succeeded' || !stage.receipt)
        throw new DocumentRequestError(
          409,
          'The attachment could not be published.',
        );
      return stage.receipt;
    });
  }

  resolveStagedOperation(
    view: RequestRuntimeView,
    operationId: string,
  ): RegisteredCapabilityOperationDefinition | undefined {
    const stage = this.#staged.getStore();
    if (
      !stage ||
      stage.view !== view ||
      operationId !== documentAttachOperation(stage.record.entityId)
    )
      return;
    return {
      operationId,
      permissionId: documentAttachPermission(stage.record.entityId),
      lifecycle: 'active',
      tier: 'o1',
      confirmation: 'none',
      precondition: {
        kind: 'booleanPredicate',
        schemaVersion: 'v6',
        value: true,
      },
      readBackQueryId: stage.query.queryId,
      effect: {
        kind: 'registeredCapabilityEffect',
        schemaVersion: 'v6',
        capability: {
          kind: 'capabilityReference',
          targetId: this.capabilityId,
          schemaVersion: 'v6',
        },
      },
      inputContract: {
        schemaVersion: 'northstar.module-input-contract/v1',
        closedArgumentKeys: ['recordId', 'expectedRevision', 'uploadId'],
        fields: [],
        relationInputs: [],
        writableFieldIds: [],
      },
    };
  }

  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ) {
    const stage = this.#boundStage(request);
    const scope = stage.query.legalEntityScope;
    return {
      decisionInput: stage.companyId ? { legalEntityId: stage.companyId } : {},
      legalEntityReadScopeIds: stage.companyId ? [stage.companyId] : [],
      readBackArguments: {
        recordId: stage.record.recordId,
        ...(scope && stage.companyId
          ? {
              [scope.operand.parameterId]:
                scope.cardinality === 'exactlyOne'
                  ? stage.companyId
                  : [stage.companyId],
            }
          : {}),
      },
    };
  }

  async execute(request: RegisteredCapabilityOperationExecutionRequest) {
    const stage = this.#boundStage(request);
    if (
      stage.receipt ||
      request.idempotencyKey !== stage.uploadId ||
      request.policyVersion !== stage.view.entryPolicyVersion
    )
      throw new DocumentRequestError(409, 'This attachment request expired.');
    stage.receipt = await stage.commit();
    return {
      kind: 'semanticOperationResult' as const,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded' as const,
      readBack: stage.record,
      trust: null,
      unsupportedReason: null,
    };
  }

  #boundStage(request: RegisteredCapabilityOperationAuthorizationRequest) {
    const stage = this.#staged.getStore();
    const input = request.input;
    if (
      !stage ||
      stage.view !== request.view ||
      request.definition.operationId !==
        documentAttachOperation(stage.record.entityId) ||
      request.readBackDefinition.queryId !== stage.query.queryId ||
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      !('uploadId' in input) ||
      input.uploadId !== stage.uploadId ||
      !('recordId' in input) ||
      input.recordId !== stage.record.recordId ||
      !('expectedRevision' in input) ||
      input.expectedRevision !== stage.record.revision
    )
      throw new DocumentRequestError(
        404,
        'This staged attachment is unavailable.',
      );
    return stage;
  }
}
