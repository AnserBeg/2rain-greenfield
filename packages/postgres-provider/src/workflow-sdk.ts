import {
  LEGACY_WORKFLOW_SDK_VERSION,
  WORKFLOW_SDK_VERSION,
  RemovedWorkflowAction,
} from './workflow-sdk-version.js';
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '@north-star/runtime/request-runtime-view';
import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';

import {
  parsePinnedOperationCatalog,
  type RegisteredOperationDefinition,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  acceptedLegalEntityScopeSelection,
  bindQueryParameters,
  registeredSemanticQueryFromPinnedView,
  type RegisteredSemanticQueryDefinition,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  parseMutationInput,
  requiredSearchText,
  requiredUuid,
} from './module-runtime-interpreter.js';

export interface WorkflowGrants {
  readonly queries: readonly string[];
  readonly operations: readonly string[];
}

export interface WorkflowEvent {
  readonly type: 'goodsReceiptPosted';
  readonly eventId: string;
  readonly receiptId: string;
  readonly legalEntityId: string;
}

export type WorkflowCall =
  | { readonly kind: 'now' }
  | { readonly kind: 'sleep'; readonly milliseconds: number }
  | {
      readonly kind: 'waitForEvent';
      readonly eventType: WorkflowEvent['type'];
      readonly timeoutMs: number;
    }
  | { readonly kind: 'requestApproval'; readonly summary: string }
  | {
      readonly kind: 'requestApproval';
      readonly summary: string;
      readonly operationId: string;
      readonly input: ImmutableJsonValue;
    }
  | {
      readonly kind: 'query' | 'operation';
      readonly id: string;
      readonly input: ImmutableJsonValue;
    };

export interface WorkflowSdk {
  readonly release: RequestRuntimeView['release'] &
    Pick<RequestRuntimeView, 'tenantId' | 'environmentId'>;
  readonly declarations: string;
  readonly version:
    typeof WORKFLOW_SDK_VERSION | typeof LEGACY_WORKFLOW_SDK_VERSION;
  admitCall(call: unknown): WorkflowCall;
}

export function generateWorkflowSdk(
  view: RequestRuntimeView,
  grants: WorkflowGrants,
  version: WorkflowSdk['version'] = WORKFLOW_SDK_VERSION,
  legacyApproval = false,
): WorkflowSdk {
  assertRequestRuntimeView(view);
  const queries = new Map(
    grants.queries.map((id) => {
      const query = registeredSemanticQueryFromPinnedView(view, id);
      if (
        query?.lifecycle !== 'active' ||
        ('readModel' in query && query.readModel)
      )
        throw new Error(`Workflow query grant does not resolve: ${id}`);
      return [id, query] as const;
    }),
  );
  const catalog = grants.operations.length
    ? parsePinnedOperationCatalog(view.projections.operation.payload)
    : [];
  const operations = new Map(
    grants.operations.map((id) => {
      const operation = catalog.find((entry) => entry.operationId === id);
      if (
        operation?.lifecycle !== 'active' ||
        operation.tier !== 'o0' ||
        !operation.inputContract
      ) {
        throw new Error(
          `Workflow operation has no supported pinned input contract: ${id}`,
        );
      }
      return [id, operation] as const;
    }),
  );

  const approvalMethods = legacyApproval
    ? ''
    : [...operations.values()].map(approvalDeclaration).join('\n');
  const declarations = `
    type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
    type ReceiptEvent = Readonly<{ type: 'goodsReceiptPosted'; eventId: string; receiptId: string; legalEntityId: string }>;
    type RecordResult = Readonly<{ recordId: string; revision: number; values: Readonly<Record<string, Json>> }>;
    interface WorkflowSdk {
      now(): string;
      ${version === LEGACY_WORKFLOW_SDK_VERSION ? "sleep(milliseconds: number): void;\n      waitForEvent(type: ReceiptEvent['type'], timeoutMs: number): ReceiptEvent | null;" : '/** Maximum 90 days (7776000000 ms). */\n      sleep(milliseconds: number): void;'}
      ${legacyApproval ? 'requestApproval(summary: string): boolean;\n      ' : ''}${[...queries.values()].map(queryDeclaration).join('\n')}
      ${[...operations.values()].map(operationDeclaration).join('\n')}
    ${approvalMethods ? `${approvalMethods}\n    ` : ''}}
  `;
  return Object.freeze({
    release: Object.freeze({
      ...view.release,
      tenantId: view.tenantId,
      environmentId: view.environmentId,
    }),
    declarations,
    version,
    admitCall(value: unknown): WorkflowCall {
      if (!isRecord(value)) throw new Error('Invalid workflow call envelope');
      switch (value.kind) {
        case 'query':
        case 'operation': {
          const { kind, id, input } = value;
          assertKeys(value, ['kind', 'id', 'input']);
          if (typeof id !== 'string' || !isRecord(input))
            throw new Error('Invalid workflow call input');
          // The worker wire decoder has already admitted canonical JSON.
          const argumentsValue = input as Record<string, ImmutableJsonValue>;
          if (kind === 'query') {
            const query = queries.get(id);
            if (!query) throw new Error(`Workflow query grant refused: ${id}`);
            assertQueryInput(query, argumentsValue);
          } else {
            const operation = operations.get(id);
            if (!operation || operation.tier !== 'o0')
              throw new Error(`Workflow operation grant refused: ${id}`);
            parseMutationInput(operation, argumentsValue);
          }
          return { kind, id, input: argumentsValue };
        }
        case 'now':
          assertKeys(value, ['kind']);
          return { kind: 'now' };
        case 'sleep': {
          assertKeys(value, ['kind', 'milliseconds']);
          const milliseconds = duration(value.milliseconds);
          if (
            version !== LEGACY_WORKFLOW_SDK_VERSION &&
            milliseconds > 7_776_000_000
          )
            throw new Error('Workflow sleep exceeds 90 days');
          return { kind: 'sleep', milliseconds };
        }
        case 'waitForEvent':
          if (version !== LEGACY_WORKFLOW_SDK_VERSION)
            throw new RemovedWorkflowAction();
          assertKeys(value, ['kind', 'eventType', 'timeoutMs']);
          if (value.eventType !== 'goodsReceiptPosted')
            throw new Error('Unknown workflow event type');
          return {
            kind: 'waitForEvent',
            eventType: value.eventType,
            timeoutMs: duration(value.timeoutMs),
          };
        case 'requestApproval':
          if (typeof value.summary !== 'string' || !value.summary.trim())
            throw new Error('Workflow approval needs a summary');
          if (!legacyApproval && Object.hasOwn(value, 'operationId')) {
            assertKeys(value, ['kind', 'summary', 'operationId', 'input']);
            const operation =
              typeof value.operationId === 'string'
                ? operations.get(value.operationId)
                : undefined;
            if (!operation || operation.tier !== 'o0' || !isRecord(value.input))
              throw new Error('Workflow approval operation grant refused');
            const input = value.input as Record<string, ImmutableJsonValue>;
            parseMutationInput(operation, input);
            return {
              kind: 'requestApproval',
              summary: value.summary,
              operationId: operation.operationId,
              input,
            };
          }
          if (!legacyApproval)
            throw new Error(
              'Workflow approval needs an exact operation and input',
            );
          assertKeys(value, ['kind', 'summary']);
          return { kind: 'requestApproval', summary: value.summary };
        default:
          throw new Error('Unknown workflow call');
      }
    },
  });
}

function queryDeclaration(query: RegisteredSemanticQueryDefinition): string {
  const keys = (query.parameters ?? []).map(
    ({ parameterId, parameterType }) => {
      let type = scalarType(parameterType.kind);
      if (parameterId === query.legalEntityScope?.operand.parameterId) {
        type =
          query.legalEntityScope.cardinality === 'exactlyOne'
            ? 'string'
            : 'readonly string[]';
      } else if (
        parameterType.kind === 'enumFieldType' &&
        Array.isArray(parameterType.options)
      ) {
        type =
          parameterType.options
            .map((option) =>
              isRecord(option) ? JSON.stringify(option.optionId) : 'never',
            )
            .join(' | ') || 'never';
      }
      return `${JSON.stringify(parameterId)}: ${type}`;
    },
  );
  if (query.queryType === 'get') keys.push('recordId: string');
  if (query.queryType === 'search' || query.queryType === 'resolve')
    keys.push('text: string');
  const result =
    query.queryType === 'aggregate'
      ? 'Readonly<{ outcome: "exact"; value: Json }>'
      : 'Readonly<{ outcome: "exact" | "ambiguous" | "not-found" | "unsupported"; records: readonly RecordResult[] }>';
  return `query(id: ${JSON.stringify(query.queryId)}, input: ${objectType(keys)}): ${result};`;
}

function operationInputDeclaration(
  operation: RegisteredOperationDefinition,
): string {
  const contract = operation.inputContract!;
  const fields = contract.fields.map((field) => {
    const type = field.enumOptionIds.length
      ? field.enumOptionIds.map((id) => JSON.stringify(id)).join(' | ')
      : scalarType(field.fieldKind);
    return `${JSON.stringify(field.fieldId)}${field.required ? '' : '?'}: ${type}${field.required ? '' : ' | null'}`;
  });
  const relations = contract.relationInputs.map(
    ({ relationId, required }) =>
      `${JSON.stringify(relationId)}${required ? '' : '?'}: string`,
  );
  const declarations = new Map([
    ['recordId', 'recordId: string'],
    ['expectedRevision', 'expectedRevision: number'],
    ['legalEntityId', 'legalEntityId: string'],
    ['values', `values: ${objectType(fields)}`],
    ['patch', `patch: Partial<${objectType(fields)}>`],
    [
      'relations',
      `relations${contract.relationInputs.some(({ required }) => required) ? '' : '?'}: ${objectType(relations)}`,
    ],
  ]);
  const keys = contract.closedArgumentKeys.map((key) => {
    const declaration = declarations.get(key);
    if (!declaration)
      throw new Error(`Unsupported workflow operation argument: ${key}`);
    return declaration;
  });
  return `id: ${JSON.stringify(operation.operationId)}, input: ${objectType(keys)}`;
}

function operationDeclaration(
  operation: RegisteredOperationDefinition,
): string {
  return `operation(${operationInputDeclaration(operation)}): Readonly<{ outcome: "succeeded" | "unsupported"; readBack: RecordResult | null }>;`;
}

function approvalDeclaration(operation: RegisteredOperationDefinition): string {
  return `requestApproval(summary: string, ${operationInputDeclaration(operation)}): boolean;`;
}

function assertQueryInput(
  query: RegisteredSemanticQueryDefinition,
  input: Record<string, ImmutableJsonValue>,
): void {
  const keys = (query.parameters ?? []).map(({ parameterId }) => parameterId);
  if (query.queryType === 'get') {
    keys.push('recordId');
    requiredUuid(input.recordId, 'recordId');
  }
  if (query.queryType === 'search' || query.queryType === 'resolve') {
    keys.push('text');
    requiredSearchText(input.text);
  }
  assertKeys(input, keys);
  if (query.legalEntityScope)
    acceptedLegalEntityScopeSelection(query, query.legalEntityScope, input);
  bindQueryParameters(query, input);
}

function objectType(fields: readonly string[]): string {
  return fields.length ? `{ ${fields.join('; ')} }` : 'Record<string, never>';
}

function scalarType(kind: ImmutableJsonValue | undefined): string {
  // Numeric fields use canonical strings in both semantic gateways.
  return kind === 'booleanFieldType' ? 'boolean' : 'string';
}

function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid workflow duration');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error('Workflow input keys disagree with the pinned contract');
  }
}
