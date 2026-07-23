export const LIFECYCLE_OPERATION_INPUT_VERSION =
  'northstar.lifecycle-operation-input/v1' as const;
export const SEMANTIC_OPERATION_REQUEST_VERSION =
  'northstar.semantic-operation-request/v1' as const;

export interface SemanticOperationGatewayPort<TContext, TResult> {
  invoke(
    context: TContext,
    request: {
      readonly input: {
        readonly expectedRevision: number;
        readonly lifecycleAction: 'ARCHIVE' | 'RESTORE';
        readonly reason: string;
        readonly recordId: string;
        readonly schemaVersion: typeof LIFECYCLE_OPERATION_INPUT_VERSION;
      };
      readonly operationId: string;
      readonly schemaVersion: typeof SEMANTIC_OPERATION_REQUEST_VERSION;
    },
  ): Promise<TResult>;
}

export interface LifecycleOperationBinding {
  readonly archiveOperationId: string;
  readonly restoreOperationId: string;
}

export interface LifecycleCommand {
  readonly expectedRevision: number;
  readonly reason: string;
  readonly recordId: string;
}

/** Shared archive/restore executor. It owns no persistence capability. */
export class LifecycleService<TContext, TResult> {
  constructor(
    private readonly operationGateway: SemanticOperationGatewayPort<
      TContext,
      TResult
    >,
  ) {}

  archive(
    context: TContext,
    binding: LifecycleOperationBinding,
    command: LifecycleCommand,
  ): Promise<TResult> {
    return this.#dispatch(
      context,
      binding.archiveOperationId,
      'ARCHIVE',
      command,
    );
  }

  restore(
    context: TContext,
    binding: LifecycleOperationBinding,
    command: LifecycleCommand,
  ): Promise<TResult> {
    return this.#dispatch(
      context,
      binding.restoreOperationId,
      'RESTORE',
      command,
    );
  }

  #dispatch(
    context: TContext,
    operationId: string,
    lifecycleAction: 'ARCHIVE' | 'RESTORE',
    command: LifecycleCommand,
  ): Promise<TResult> {
    assertCanonicalOperationId(operationId);
    const requiredSuffix =
      lifecycleAction === 'ARCHIVE' ? ':archive' : ':restore';
    if (!operationId.endsWith(requiredSuffix)) {
      throw new TypeError(
        `lifecycle ${lifecycleAction.toLowerCase()} binding must end with ${requiredSuffix}`,
      );
    }
    if (
      typeof command.recordId !== 'string' ||
      command.recordId.trim().length === 0
    ) {
      throw new TypeError('lifecycle recordId must not be blank');
    }
    if (
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 0
    ) {
      throw new TypeError(
        'lifecycle expectedRevision must be a non-negative safe integer',
      );
    }
    if (
      typeof command.reason !== 'string' ||
      command.reason.trim().length === 0
    ) {
      throw new TypeError('lifecycle reason must not be blank');
    }
    return this.operationGateway.invoke(
      context,
      Object.freeze({
        input: Object.freeze({
          expectedRevision: command.expectedRevision,
          lifecycleAction,
          reason: command.reason,
          recordId: command.recordId,
          schemaVersion: LIFECYCLE_OPERATION_INPUT_VERSION,
        }),
        operationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      }),
    );
  }
}

function assertCanonicalOperationId(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(
      value,
    )
  ) {
    throw new TypeError('lifecycle operationId must be a canonical ID');
  }
}
