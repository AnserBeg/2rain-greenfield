import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../../packages/runtime/src/semantic-operation-gateway.js';
import type {
  SemanticOperationExecutionContext,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryResultEnvelope,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import type { SemanticQueryGateway } from '../../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../../packages/runtime/src/list-behavior/index.js';

import {
  FORM_EMPTY_INTENT_PREFIX,
  renderRegisteredSurfaceComponent,
  surfaceSupportsRuntimeIntent,
  type SurfaceDataRenderState,
  type SurfaceOperationFeedback,
} from './component-registry.js';
import { DESIGN_TOKENS } from './design-tokens.js';
import { escapeHtml, shortIdentity } from './html.js';
import {
  operationMessageCode,
  queryMessageCode,
} from './gateway-error-codes.js';
import type { OperationDiagnosticCode } from './message-catalog.js';
import {
  messageAttributes,
  messageBody,
  surfaceMessage,
  type SurfaceMessageRef,
} from './message-render.js';
import {
  readCompiledSurfaceManifest,
  readCompiledSurfaceDataBinding,
  SurfaceProjectionError,
  type CompiledNavigationEntry,
  type CompiledNavigationTree,
  type CompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceInputField,
  type SurfaceOperationIntent,
} from './surface-contract.js';

export interface SurfaceRuntimeResponse {
  readonly html: string;
  readonly statusCode: number;
}

export interface SurfaceRuntimeGateways {
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly operationGateway: SemanticOperationGateway;
  readonly queryGateway: SemanticQueryGateway;
}

export type SurfaceRuntimeSubmission = Readonly<Record<string, string>>;

interface SelectedSurface {
  readonly navigation: CompiledNavigationTree | null;
  readonly selected: CompiledSurfaceDefinition;
  readonly surfaces: readonly CompiledSurfaceDefinition[];
}

interface WorkspaceContextOption {
  readonly label: string;
  readonly recordId: string;
}

interface WorkspaceContextBar {
  readonly options: readonly WorkspaceContextOption[];
  readonly parameterId: string;
  readonly preservedParameters: readonly (readonly [string, string])[];
  readonly selectedRecordId: string | null;
  readonly targetSurfaceId: string;
}

/**
 * The sole browser renderer. Its only application-definition input is one
 * issued RequestRuntimeView; it has no loader, pointer, release, or cache port.
 */
export function renderSurfaceRuntime(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
): SurfaceRuntimeResponse {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  return renderSelectedSurface(
    view,
    selection,
    { status: 'UNBOUND' },
    null,
    [],
    200,
    [],
    null,
  );
}

/** Loads live DTOs through the semantic read gateway for one pinned surface. */
export async function renderSurfaceRuntimeWithData(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
  gateways: SurfaceRuntimeGateways,
  feedback: SurfaceOperationFeedback | null = null,
): Promise<SurfaceRuntimeResponse> {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  let binding: CompiledSurfaceDataBinding;
  try {
    binding = readCompiledSurfaceDataBinding(view, selection.selected);
  } catch {
    // The code is inaccurate and stays that way here on purpose: the throw is a
    // SurfaceProjectionError('INVALID_SURFACE_BINDING'), so this site names a
    // missing capability for what is really an unreadable binding. Correcting
    // it moves a `data-diagnostic-code` this packet is fenced from moving; it
    // is reported as a finding and INVALID_SURFACE_BINDING is declared
    // unreachable in the gate rather than silently absent.
    return Object.freeze({
      html: diagnosticDocument(view, { code: 'QUERY_UNSUPPORTED' }),
      statusCode: 422,
    });
  }

  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const legalEntitySelection = legalEntitySelectionForSurface(binding, url);
  const queryParameterValues = queryParameterValuesForSurface(binding, url);
  const workspaceContext = await loadWorkspaceContextBar(
    view,
    selection,
    binding,
    gateways.queryGateway,
    legalEntitySelection,
    url,
  );
  if (binding.query.legalEntityScope && legalEntitySelection.length === 0) {
    return renderSelectedSurface(
      view,
      selection,
      { code: 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED', status: 'DIAGNOSTIC' },
      feedback,
      binding.operations,
      422,
      legalEntitySelection,
      workspaceContext,
      queryParameterValues,
    );
  }
  if (binding.query.queryType === 'aggregate') {
    const scopeParameterId =
      binding.query.legalEntityScope?.operand.parameterId;
    const missingParameterIds = binding.query.parameters
      .map((parameter) => parameter.parameterId)
      .filter(
        (parameterId) =>
          parameterId !== scopeParameterId &&
          (queryParameterValues[parameterId] ?? '').trim() === '',
      );
    if (missingParameterIds.length > 0) {
      return renderSelectedSurface(
        view,
        selection,
        { code: 'QUERY_PARAMETER_REQUIRED', status: 'DIAGNOSTIC' },
        feedback,
        binding.operations,
        422,
        legalEntitySelection,
        workspaceContext,
        queryParameterValues,
      );
    }
  }
  const queryArguments = argumentsForSurface(binding, url);
  if (queryArguments === null) {
    const state: SurfaceDataRenderState =
      selection.selected.surfaceRole === 'form'
        ? { status: 'EMPTY' }
        : { code: 'QUERY_NOT_FOUND', status: 'DIAGNOSTIC' };
    return renderSelectedSurface(
      view,
      selection,
      state,
      feedback,
      binding.operations,
      200,
      legalEntitySelection,
      workspaceContext,
      queryParameterValues,
    );
  }

  let data: SurfaceDataRenderState;
  let statusCode = 200;
  try {
    const request = {
      arguments: queryArguments,
      queryId: selection.selected.dataSourceQueryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    } as const;
    if (binding.query.queryType === 'aggregate') {
      const result = await gateways.queryGateway.invokeAggregate(view, request);
      data = { aggregate: result, status: 'AGGREGATE_READY' };
    } else {
      const result = await gateways.queryGateway.invoke(view, request);
      data = dataState(result);
    }
  } catch (error) {
    const code = queryMessageCode(error);
    data = { code, status: 'DIAGNOSTIC' };
    if (code === 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED') {
      statusCode = 422;
    }
  }
  return renderSelectedSurface(
    view,
    selection,
    data,
    feedback,
    binding.operations,
    statusCode,
    legalEntitySelection,
    workspaceContext,
    queryParameterValues,
  );
}

/**
 * Resolves a submission to one pinned operation, SELECTED by the posted id and
 * AUTHORIZED only by the compiled binding.
 *
 * The distinction is the whole change, so it is stated rather than implied.
 * This used to resolve `intent -> the one operation carrying it`, which made
 * the one-operation-per-intent limit in `surface-contract.ts` load-bearing on
 * the write path: two commands would both post `intent=command` and the
 * `find` would return whichever sorted first, so pressing Cancel could
 * release. The set of reachable operations is UNCHANGED -- it is
 * `binding.operations`, exactly as before, and an id absent from it is
 * refused. Only the selection within that already-authorized set moved from
 * the server's sort order to the control the user actually pressed.
 */
export async function submitSurfaceRuntimeIntent(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
  submission: SurfaceRuntimeSubmission,
  gateways: SurfaceRuntimeGateways,
): Promise<SurfaceRuntimeResponse> {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  let binding: CompiledSurfaceDataBinding;
  try {
    binding = readCompiledSurfaceDataBinding(view, selection.selected);
  } catch {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }
  const operation = boundOperation(binding, submission.operationId);
  if (
    !operation ||
    !surfaceSupportsRuntimeIntent(
      view,
      selection.selected,
      selection.surfaces,
      operation.intent,
    )
  ) {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }
  const intent = operation.intent;
  let input: SurfaceOperationInput;
  try {
    input = operationInput(selection.selected, operation, intent, submission);
  } catch (error) {
    if (error instanceof InvalidSurfaceSubmissionError) {
      return operationDiagnostic('OPERATION_INPUT_INVALID', 422);
    }
    throw error;
  }
  if (
    operation.confirmation === 'humanRequired' &&
    typeof submission.confirmationGrant !== 'string'
  ) {
    try {
      const grant = gateways.operationMediation.issueConfirmationGrant(
        view,
        operation.operationId,
        input,
      );
      return renderConfirmationTransition(
        selection.selected,
        operation,
        submission,
        grant,
      );
    } catch {
      return operationDiagnostic('OPERATION_CONFIRMATION_REQUIRED', 422);
    }
  }

  let result;
  try {
    const executionContext = operationExecutionContext(
      binding,
      intent,
      new URL(requestUrl, 'http://surface-runtime.local'),
    );
    result = await gateways.operationGateway.invoke(
      view,
      semanticOperationRequestFor(
        operation,
        input,
        submission.confirmationGrant ?? null,
        submission.idempotencyKey ?? '',
      ),
      gateways.operationMediation.issueInvocation(view, 'UI'),
      executionContext,
    );
  } catch (error) {
    const code = operationMessageCode(error);
    return renderApplicationDiagnostic(
      code === 'OPERATION_PERMISSION_DENIED' ? 403 : 422,
      { code },
    );
  }
  if (result.outcome !== 'succeeded' || !result.readBack) {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }

  return renderSelectedSurface(
    view,
    selection,
    { records: [result.readBack], status: 'READY' },
    {
      intent,
      label: operation.label,
      record: result.readBack,
      trustLinked: result.trust !== null,
    },
    binding.operations,
    200,
    legalEntitySelectionForSurface(
      binding,
      new URL(requestUrl, 'http://surface-runtime.local'),
    ),
    null,
  );
}

function operationExecutionContext(
  binding: CompiledSurfaceDataBinding,
  intent: SurfaceOperationIntent,
  url: URL,
): SemanticOperationExecutionContext {
  // scoped-create-operand PROBE ONLY -- NOT FOR MERGE.
  if (intent !== 'create' || !binding.query.legalEntityScope) {
    return Object.freeze({});
  }
  const selection = legalEntitySelectionForSurface(binding, url);
  return Object.freeze({
    legalEntitySelection:
      selection.length === 1 ? selection[0]! : Object.freeze([...selection]),
  });
}

function renderSelectedSurface(
  view: RuntimeViewContract.RequestRuntimeView,
  { navigation, selected, surfaces }: SelectedSurface,
  data: SurfaceDataRenderState,
  feedback: SurfaceOperationFeedback | null,
  operations: CompiledSurfaceDataBinding['operations'],
  statusCode = 200,
  legalEntitySelection: readonly string[] = [],
  workspaceContext: WorkspaceContextBar | null = null,
  queryParameterValues: Readonly<Record<string, string>> = Object.freeze({}),
): SurfaceRuntimeResponse {
  // Compact and full layouts are alternative renderings of these same slots;
  // a responsive implementation must never mount both at once.
  const renderedSlots = selected.slots.map((slot) =>
    renderRegisteredSurfaceComponent({
      data,
      feedback,
      legalEntitySelection,
      operations,
      queryParameterValues,
      slot,
      surface: selected,
      surfaces,
      view,
    }),
  );
  const legacyHeading =
    selected.archetype === 'list' || selected.archetype === 'record'
      ? ''
      : `<header class="surface-heading">
      <div>
        <p class="eyebrow">${escapeHtml(selected.archetype)} surface · compiled release</p>
        <h1>${escapeHtml(selected.label)}</h1>
        <p class="surface-id">${escapeHtml(selected.surfaceId)}</p>
      </div>
      <div class="surface-status" aria-label="Surface status roles">
        ${selected.statusRoles.map((role) => `<span data-status-role="${escapeHtml(role)}">${escapeHtml(role)}</span>`).join('')}
      </div>
    </header>`;
  const body = `${legacyHeading}
    <div class="surface-grid" data-surface-archetype="${escapeHtml(selected.archetype)}">
      ${renderedSlots.map((result) => result.html).join('')}
    </div>`;

  return Object.freeze({
    html: shellDocument(
      view,
      surfaces,
      navigation,
      selected,
      body,
      workspaceContext,
    ),
    statusCode,
  });
}

function selectSurface(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
): SelectedSurface | SurfaceRuntimeResponse {
  let surfaces: readonly CompiledSurfaceDefinition[];
  let navigation: CompiledNavigationTree | null;
  try {
    const manifest = readCompiledSurfaceManifest(view);
    navigation = manifest.navigation;
    surfaces = manifest.surfaces.filter(
      (surface) => surface.lifecycle === 'active',
    );
  } catch (error) {
    // Five codes that shared one sentence before ADR-0048. Each now resolves
    // its own entry; the shared string was why a repeated surface id and an
    // unreadable navigation tree read identically to an operator.
    const code =
      error instanceof SurfaceProjectionError
        ? error.code
        : 'INVALID_SURFACE_MANIFEST';
    return Object.freeze({
      html: diagnosticDocument(view, { code }),
      statusCode: 422,
    });
  }
  if (surfaces.length === 0) {
    return Object.freeze({
      html: diagnosticDocument(view, { code: 'NO_ACTIVE_SURFACE' }),
      statusCode: 422,
    });
  }
  const requestedSurfaceId = new URL(
    requestUrl,
    'http://surface-runtime.local',
  ).searchParams.get('surface');
  const selected = requestedSurfaceId
    ? surfaces.find((surface) => surface.surfaceId === requestedSurfaceId)
    : surfaces[0];
  if (!selected) {
    return Object.freeze({
      html: shellDocument(
        view,
        surfaces,
        navigation,
        null,
        pageMessageSection({ code: 'UNKNOWN_SURFACE' }),
      ),
      statusCode: 404,
    });
  }
  return { navigation, selected, surfaces };
}

function argumentsForSurface(
  binding: CompiledSurfaceDataBinding,
  url: URL,
): RuntimeViewContract.ImmutableJsonValue | null {
  const includeArchived = url.searchParams.get('archived') === 'yes';
  const scopeArguments = legalEntityScopeArguments(binding, url);
  switch (binding.query.queryType) {
    case 'aggregate':
      return Object.freeze({
        ...Object.fromEntries(
          binding.query.parameters
            .filter(
              (parameter) =>
                parameter.parameterId !==
                binding.query.legalEntityScope?.operand.parameterId,
            )
            .map((parameter) => [
              parameter.parameterId,
              url.searchParams.get(parameter.parameterId) ?? '',
            ]),
        ),
        ...scopeArguments,
      });
    case 'get': {
      const recordId = url.searchParams.get('record');
      return recordId ? { includeArchived, recordId, ...scopeArguments } : null;
    }
    case 'list':
      return {
        includeArchived,
        list: {
          cursor: url.searchParams.get('cursor'),
          matchMode: 'substring',
          pageSize: binding.query.maximumResultCount,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: url.searchParams.get('q') ?? '',
          sort: [],
        },
        ...scopeArguments,
      };
    case 'resolve':
    case 'search': {
      const text = url.searchParams.get('q');
      return text
        ? {
            includeArchived,
            limit: binding.query.maximumResultCount,
            text,
            ...scopeArguments,
          }
        : null;
    }
  }
}

function queryParameterValuesForSurface(
  binding: CompiledSurfaceDataBinding,
  url: URL,
): Readonly<Record<string, string>> {
  if (binding.query.queryType !== 'aggregate') return Object.freeze({});
  return Object.freeze(
    Object.fromEntries(
      binding.query.parameters.flatMap((parameter) => {
        const value = url.searchParams.get(parameter.parameterId);
        return value === null ? [] : [[parameter.parameterId, value]];
      }),
    ),
  );
}

function legalEntityScopeArguments(
  binding: CompiledSurfaceDataBinding,
  url: URL,
): Readonly<Record<string, RuntimeViewContract.ImmutableJsonValue>> {
  const scope = binding.query.legalEntityScope;
  if (!scope) return {};
  const parameterId = scope.operand.parameterId;
  const selections = url.searchParams.getAll(parameterId);
  return {
    [parameterId]:
      scope.cardinality === 'exactlyOne' && selections.length <= 1
        ? (selections[0] ?? '')
        : selections,
  };
}

function legalEntitySelectionForSurface(
  binding: CompiledSurfaceDataBinding,
  url: URL,
): readonly string[] {
  const scope = binding.query.legalEntityScope;
  return scope ? url.searchParams.getAll(scope.operand.parameterId) : [];
}

async function loadWorkspaceContextBar(
  view: RuntimeViewContract.RequestRuntimeView,
  selection: SelectedSurface,
  selectedBinding: CompiledSurfaceDataBinding,
  queryGateway: SemanticQueryGateway,
  legalEntitySelection: readonly string[],
  currentUrl: URL,
): Promise<WorkspaceContextBar | null> {
  if (!selectedBinding.query.legalEntityScope) return null;
  const entityNamespace = selectedBinding.query.sourceEntityId.split(
    ':entity.',
    1,
  )[0];
  if (!entityNamespace) return null;
  const legalEntityId = `${entityNamespace}:entity.legal_entity`;
  const candidates = selection.surfaces.flatMap((surface) => {
    if (surface.surfaceRole !== 'list') return [];
    try {
      const binding = readCompiledSurfaceDataBinding(view, surface);
      return binding.query.lifecycle === 'active' &&
        binding.query.queryType === 'list' &&
        binding.query.sourceEntityId === legalEntityId &&
        binding.query.legalEntityScope === undefined
        ? [{ binding, surface }]
        : [];
    } catch {
      return [];
    }
  });
  if (candidates.length !== 1) return null;
  const legalEntityList = candidates[0]!;
  const targetSurface =
    selection.selected.surfaceRole === 'list' ||
    selectedBinding.query.queryType === 'aggregate'
      ? { binding: selectedBinding, surface: selection.selected }
      : selection.surfaces
          .filter((surface) => surface.surfaceRole === 'list')
          .flatMap((surface) => {
            try {
              const binding = readCompiledSurfaceDataBinding(view, surface);
              return binding.query.sourceEntityId ===
                selectedBinding.query.sourceEntityId
                ? [{ binding, surface }]
                : [];
            } catch {
              return [];
            }
          })[0];
  const parameterId =
    targetSurface?.binding.query.legalEntityScope?.operand.parameterId;
  if (!targetSurface || !parameterId) return null;

  let result: SemanticQueryResultEnvelope;
  try {
    result = await queryGateway.invoke(view, {
      arguments: {
        includeArchived: false,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: legalEntityList.binding.query.maximumResultCount,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: '',
          sort: [],
        },
      },
      queryId: legalEntityList.binding.query.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
  } catch {
    return null;
  }
  if (result.outcome !== 'exact') return null;
  const displayFieldId = legalEntityList.binding.displayFieldId;
  const options = result.records
    .map((record) => {
      const displayValue = displayFieldId
        ? (record.displayValues?.[displayFieldId] ??
          record.values[displayFieldId])
        : null;
      return Object.freeze({
        label:
          typeof displayValue === 'string' && displayValue.trim() !== ''
            ? displayValue
            : shortIdentity(record.recordId),
        recordId: record.recordId,
      });
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  return Object.freeze({
    options: Object.freeze(options),
    parameterId,
    preservedParameters: Object.freeze(
      targetSurface.binding.query.queryType === 'aggregate'
        ? targetSurface.binding.query.parameters.flatMap((parameter) => {
            if (parameter.parameterId === parameterId) return [];
            const value = currentUrl.searchParams.get(parameter.parameterId);
            return value === null
              ? []
              : ([[parameter.parameterId, value]] as const);
          })
        : [],
    ),
    selectedRecordId:
      legalEntitySelection.length === 1 ? legalEntitySelection[0]! : null,
    targetSurfaceId: targetSurface.surface.surfaceId,
  });
}

function dataState(
  result: SemanticQueryResultEnvelope,
): SurfaceDataRenderState {
  switch (result.outcome) {
    case 'exact':
      return result.records.length === 0 && !result.listCoverage
        ? { status: 'EMPTY' }
        : { records: result.records, result, status: 'READY' };
    case 'ambiguous':
      return { code: 'QUERY_AMBIGUOUS', status: 'DIAGNOSTIC' };
    case 'not-found':
      return { code: 'QUERY_NOT_FOUND', status: 'DIAGNOSTIC' };
    case 'unsupported':
      return { code: 'QUERY_UNSUPPORTED', status: 'DIAGNOSTIC' };
  }
}

/** Namespaces relation controls so they cannot collide with `value:` fields. */
const RELATION_SUBMISSION_PREFIX = 'relation:';

function relationInput(
  submission: SurfaceRuntimeSubmission,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(submission)
        .filter(
          (entry): entry is [string, string] =>
            entry[0].startsWith(RELATION_SUBMISSION_PREFIX) &&
            typeof entry[1] === 'string' &&
            entry[1] !== '',
        )
        .map(
          (entry) =>
            [
              entry[0].slice(RELATION_SUBMISSION_PREFIX.length),
              entry[1],
            ] as const,
        ),
    ),
  );
}

function operationInput(
  surface: CompiledSurfaceDefinition,
  operation: CompiledSurfaceDataBinding['operations'][number],
  intent: SurfaceOperationIntent,
  submission: SurfaceRuntimeSubmission,
): SurfaceOperationInput {
  const values = fieldInput(surface, operation, intent, submission);
  if (intent === 'create') {
    // ADR-0052: relations travel as a sibling of `values`, keyed by relation id
    // and carrying record ids as strings. `parseMutationInput` reads them
    // through `uuidRecord`, so a string is the native form and no coercion is
    // owed -- unlike field values, whose typed-wire question is `U7`'s.
    //
    // An unselected relation is OMITTED rather than sent as "". That keeps the
    // refusal for a missing REQUIRED relation where it is already declared and
    // discriminating -- on the provider, by name -- instead of turning it into
    // a uuid-parse failure on an empty string.
    return {
      recordId: submission.recordId ?? '',
      relations: relationInput(submission),
      values,
    };
  }
  const recordId = submission.recordId ?? '';
  const expectedRevision = Number.parseInt(
    submission.expectedRevision ?? '',
    10,
  );
  return intent === 'update'
    ? { expectedRevision, patch: values, recordId }
    : { expectedRevision, recordId };
}

type SurfaceOperationInput = Record<
  string,
  RuntimeViewContract.ImmutableJsonValue
>;

type FormFieldMutation =
  | { readonly kind: 'clear' }
  | { readonly kind: 'nothing' }
  | {
      readonly kind: 'set';
      readonly value: boolean | string;
    };

const EMPTY_INTENTS = Object.freeze(['clear', 'emptyText', 'nothing'] as const);
type EmptyIntent = (typeof EMPTY_INTENTS)[number];

class InvalidSurfaceSubmissionError extends Error {
  override readonly name = 'InvalidSurfaceSubmissionError';
}

/**
 * The form body is strings only. This is the single seam that turns those
 * validated strings into the provider's JSON value domain.
 *
 * Its result is discriminated before the object is built, so `nothing`,
 * `clear`, and `set` cannot collapse into the same provider input. The raw
 * request still needs runtime validation because it is untrusted bytes; a
 * malformed boolean or empty-intent spelling is refused before invocation.
 */
function fieldInput(
  surface: CompiledSurfaceDefinition,
  operation: CompiledSurfaceDataBinding['operations'][number],
  intent: SurfaceOperationIntent,
  submission: SurfaceRuntimeSubmission,
): Readonly<Record<string, RuntimeViewContract.ImmutableJsonValue>> {
  const fields = new Map(
    (operation.inputFields ?? []).map((field) => [field.fieldId, field]),
  );
  const entries: Array<
    readonly [string, RuntimeViewContract.ImmutableJsonValue]
  > = [];
  for (const fieldId of surface.fieldIds) {
    const field = fields.get(fieldId);
    const mutation = formFieldMutation(
      field,
      intent,
      submission[`value:${fieldId}`],
      submission[`${FORM_EMPTY_INTENT_PREFIX}${fieldId}`],
    );
    if (mutation.kind === 'nothing') continue;
    entries.push([fieldId, mutation.kind === 'clear' ? null : mutation.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function formFieldMutation(
  field: CompiledSurfaceInputField | undefined,
  intent: SurfaceOperationIntent,
  rawValue: string | undefined,
  rawEmptyIntent: string | undefined,
): FormFieldMutation {
  // Every required-text update has a two-member wire subject. Refuse complete
  // subject erasure before the generic absent-primary return can interpret it
  // as “leave alone.” The absent-primary branch below owns primary-only
  // erasure; readEmptyIntent owns companion-only erasure and invalid values.
  if (
    intent === 'update' &&
    field?.required === true &&
    field.kind === 'textFieldType' &&
    rawValue === undefined &&
    rawEmptyIntent === undefined
  ) {
    invalidFormSubmission();
  }
  if (rawValue === undefined) {
    if (rawEmptyIntent !== undefined || (field && !field.required)) {
      invalidFormSubmission();
    }
    return { kind: 'nothing' };
  }

  if (!field) {
    if (rawEmptyIntent !== undefined) invalidFormSubmission();
    return { kind: 'set', value: rawValue };
  }

  const emptyIntent = readEmptyIntent(field, intent, rawEmptyIntent);
  if (rawValue !== '') {
    if (field.kind !== 'booleanFieldType') {
      return { kind: 'set', value: rawValue };
    }
    if (rawValue === 'true') return { kind: 'set', value: true };
    if (rawValue === 'false') return { kind: 'set', value: false };
    invalidFormSubmission();
  }

  if (field.required) {
    // Every required text update carries a companion: `nothing` preserves an
    // unavailable historical value, while `emptyText` states the real value
    // "". Requiring that companion makes its deletion a refusal rather than an
    // accidental empty-text write. A non-empty replacement returns above as
    // `set` regardless of the companion's conditional blank meaning.
    if (emptyIntent === 'nothing') {
      return { kind: 'nothing' };
    }
    if (field.kind === 'textFieldType') {
      return { kind: 'set', value: '' };
    }
    invalidFormSubmission();
  }
  switch (emptyIntent) {
    case 'nothing':
      return { kind: 'nothing' };
    case 'clear':
      return { kind: 'clear' };
    case 'emptyText':
      return { kind: 'set', value: '' };
  }
  invalidFormSubmission();
}

function readEmptyIntent(
  field: CompiledSurfaceInputField,
  operationIntent: SurfaceOperationIntent,
  value: string | undefined,
): EmptyIntent | null {
  if (field.required) {
    if (operationIntent !== 'update') {
      if (value !== undefined) invalidFormSubmission();
      return null;
    }
    if (field.kind === 'textFieldType') {
      if (value === 'nothing' || value === 'emptyText') return value;
      invalidFormSubmission();
    }
    if (value === undefined) return null;
    if (value === 'nothing') return 'nothing';
    invalidFormSubmission();
  }
  if (!EMPTY_INTENTS.includes(value as EmptyIntent)) {
    invalidFormSubmission();
  }
  if (
    (value === 'clear' && operationIntent !== 'update') ||
    (value === 'emptyText' && field.kind !== 'textFieldType')
  ) {
    invalidFormSubmission();
  }
  return value as EmptyIntent;
}

function invalidFormSubmission(): never {
  throw new InvalidSurfaceSubmissionError(
    'form field submission does not match its pinned input contract',
  );
}

// The wire's `intent` parser is deliberately gone rather than kept alongside
// the id. It was a SECOND spelling of the closed vocabulary already declared
// in surface-contract.ts, and with the operation resolved from the binding the
// intent is read off that operation -- one authority, and a posted `intent`
// can no longer disagree with the operation it accompanies.

/**
 * Selection, and it can select from nothing else. `binding.operations` and one
 * posted string are the whole input, so there is no second axis to branch on
 * and no submission in scope to reach for.
 */
function boundOperation(
  binding: CompiledSurfaceDataBinding,
  postedOperationId: string | undefined,
): CompiledSurfaceDataBinding['operations'][number] | undefined {
  return binding.operations.find(
    (candidate) => candidate.operationId === postedOperationId,
  );
}

/**
 * The ONE construction site for a gateway request, and the argument list is
 * the control rather than a convention.
 *
 * `submission` is deliberately absent. A source scan asserting "the posted id
 * is only ever compared against the binding" is still a source scan: it stays
 * green against
 *
 *   submission.selectorBypass === '1' ? binding.operations[0] : find(...)
 *
 * because the compliant comparison is still written, and identically against a
 * spread that overrides the compliant member. Neither is expressible in here,
 * because the wire is not a parameter. That is ADR-0048 §2's `keyof typeof`
 * move applied one layer over: make the wrong thing INEXPRESSIBLE, not
 * detectable.
 *
 * The envelope is built member by member with no spread, so `input` -- which
 * does legitimately come from the wire -- cannot reach `operationId` either.
 *
 * **What this does not do**, stated rather than left to be discovered: it does
 * not constrain how the caller obtained `operation`. It guarantees that the id
 * the gateway receives is the id of whatever operation was resolved, never a
 * posted one. That the resolution itself reads only the binding is what
 * `boundOperation` above and the architecture ratchet hold.
 */
export function semanticOperationRequestFor(
  operation: CompiledSurfaceDataBinding['operations'][number],
  input: SurfaceOperationInput,
  confirmationGrant: string | null,
  idempotencyKey: string,
): {
  readonly confirmationGrant: string | null;
  readonly idempotencyKey: string;
  readonly input: SurfaceOperationInput;
  readonly operationId: string;
  readonly schemaVersion: typeof SEMANTIC_OPERATION_REQUEST_VERSION;
} {
  return Object.freeze({
    confirmationGrant,
    idempotencyKey,
    input,
    operationId: operation.operationId,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  });
}

function operationDiagnostic(
  code: OperationDiagnosticCode,
  statusCode: number,
): SurfaceRuntimeResponse {
  return renderApplicationDiagnostic(statusCode, { code });
}

function renderConfirmationTransition(
  surface: CompiledSurfaceDefinition,
  operation: CompiledSurfaceDataBinding['operations'][number],
  submission: SurfaceRuntimeSubmission,
  grant: string,
): SurfaceRuntimeResponse {
  const preserved = Object.entries(submission)
    .filter(([key]) => key !== 'confirmationGrant' && key !== 'confirmed')
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm ${escapeHtml(operation.label)} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card" data-confirmation-step="preview"><p class="eyebrow">Operation preview</p><h1>Confirm ${escapeHtml(operation.label)}</h1><p>Review this ${escapeHtml(surface.label)} operation before it is executed.</p>${operation.capabilityId ? `<section data-predicted-effects="registered-capability"><strong>Predicted effects</strong><p>The registered capability <code>${escapeHtml(operation.capabilityId)}</code> will validate this draft and append its declared business facts. The screen will wait for the committed result.</p></section>` : ''}<form method="post" action="/?surface=${encodeURIComponent(surface.surfaceId)}">${preserved}<input type="hidden" name="confirmationGrant" value="${escapeHtml(grant)}"><button type="submit">Confirm ${escapeHtml(operation.label)}</button></form></main></body></html>`,
    statusCode: 200,
  });
}

/**
 * Every message renderer in this file takes a `SurfaceMessageRef` and nothing
 * else — no title, no message, no free code string. That is ADR-0048 §5's
 * structural companion: a hardcoded sentence is not caught after the fact, it
 * has nowhere to be passed.
 */
export function renderApplicationDiagnostic(
  statusCode: number,
  ref: SurfaceMessageRef,
): SurfaceRuntimeResponse {
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(surfaceMessage(ref.code).sentence)} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card" role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Application diagnostic', 'h1')}</main></body></html>`,
    statusCode,
  });
}

function diagnosticDocument(
  view: RuntimeViewContract.RequestRuntimeView,
  ref: SurfaceMessageRef,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(surfaceMessage(ref.code).sentence)} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card" role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Pinned release diagnostic', 'h1')}<p class="diagnostic-release">Release ${escapeHtml(shortIdentity(view.release.releaseId))} · fence ${view.pointer.fence}</p></main></body></html>`;
}

/**
 * Page-level message inside the shell, for faults that arise before slot
 * composition but after a navigable manifest exists — the `ux-grammar` rule
 * that page-level diagnostics survive.
 */
function pageMessageSection(ref: SurfaceMessageRef): string {
  return `<section class="diagnostic diagnostic--page" role="alert" ${messageAttributes(ref)}>
          <div class="diagnostic__mark" aria-hidden="true">?</div>
          <div>${messageBody(ref, 'Release diagnostic', 'h1')}</div>
        </section>`;
}

function shellDocument(
  view: RuntimeViewContract.RequestRuntimeView,
  surfaces: readonly CompiledSurfaceDefinition[],
  compiledNavigation: CompiledNavigationTree | null,
  selected: CompiledSurfaceDefinition | null,
  body: string,
  workspaceContext: WorkspaceContextBar | null = null,
): string {
  const title = selected?.label ?? 'Release diagnostic';
  const navigation = navigationEntries(surfaces, compiledNavigation);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(title)} · 2rain</title>
    <style>${styles}</style>
  </head>
  <body>
    <a class="skip-link" href="#surface-content">Skip to content</a>
    <div class="app-shell" data-release-id="${escapeHtml(view.release.releaseId)}" data-release-content-hash="${escapeHtml(view.release.contentHash)}" data-pointer-fence="${view.pointer.fence}">
      <aside class="sidebar" style="--compact-nav-count:${String(Math.min(navigation.length, 5))}">
        <div class="brand"><span class="brand__mark" aria-hidden="true">2</span><span><strong>2rain</strong><small>Compiled workspace</small></span></div>
        <nav aria-label="Release navigation">
          <p class="nav-label">Application</p>
          <ul class="navigation-tree">${navigation.map((entry) => navigationItem(view, entry, surfaces, selected, workspaceContext)).join('')}</ul>
        </nav>
        <div class="release-card">
          <span class="release-card__pulse" aria-hidden="true"></span>
          <div><small>Pinned release</small><strong>${escapeHtml(shortIdentity(view.release.releaseId))}</strong><span>Fence ${view.pointer.fence}</span></div>
        </div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div><span class="topbar__context">${escapeHtml(shortIdentity(view.tenantId))}</span><span class="topbar__divider">/</span><span>${escapeHtml(shortIdentity(view.environmentId))}</span></div>
          ${workspaceContext ? renderWorkspaceContextBar(workspaceContext) : ''}
          <div class="principal" aria-label="Signed-in principal"><span class="principal__avatar" aria-hidden="true">${escapeHtml(view.principalId.slice(0, 2).toUpperCase())}</span><span><small>Signed in</small><strong>${escapeHtml(shortIdentity(view.principalId))}</strong></span></div>
        </header>
        <main id="surface-content" tabindex="-1">${body}</main>
      </div>
    </div>
  </body>
</html>`;
}

function navigationItem(
  view: RuntimeViewContract.RequestRuntimeView,
  entry: CompiledNavigationEntry,
  surfaces: readonly CompiledSurfaceDefinition[],
  selected: CompiledSurfaceDefinition | null,
  workspaceContext: WorkspaceContextBar | null,
): string {
  if (entry.kind === 'navigationGroup') {
    const current = navigationEntryIsCurrent(view, entry, surfaces, selected);
    if (
      entry.children.length === 1 &&
      entry.children[0]?.kind === 'navigationSurface'
    ) {
      const surface = surfaceForNavigation(surfaces, entry.children[0]);
      return `<li class="navigation-node navigation-node--direct">${navigationLink(view, surface, selected, entry.label, workspaceContext)}</li>`;
    }
    return `<li class="navigation-node navigation-node--group"><details class="navigation-group"${current ? ' data-current="true"' : ''}><summary><span class="nav-icon" aria-hidden="true">${escapeHtml(entry.label.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(entry.label)}</span><span class="nav-arrow" aria-hidden="true">›</span></summary><ul class="navigation-children">${entry.children.map((child) => navigationItem(view, child, surfaces, selected, workspaceContext)).join('')}</ul></details></li>`;
  }
  const surface = surfaceForNavigation(surfaces, entry);
  return `<li class="navigation-node navigation-node--surface">${navigationLink(view, surface, selected, navigationLabel(surface), workspaceContext)}</li>`;
}

function navigationLink(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition | null,
  label: string,
  workspaceContext: WorkspaceContextBar | null,
): string {
  const current = selected
    ? surface.surfaceId === selected.surfaceId ||
      sharesSurfaceEntity(view, surface, selected)
    : false;
  const parameters = new URLSearchParams({ surface: surface.surfaceId });
  if (workspaceContext?.selectedRecordId) {
    try {
      const scope = readCompiledSurfaceDataBinding(view, surface).query
        .legalEntityScope;
      if (scope) {
        parameters.set(
          scope.operand.parameterId,
          workspaceContext.selectedRecordId,
        );
      }
    } catch {
      // The binding validator renders the destination diagnostic; navigation
      // never guesses a parameter id when the pinned artifact is malformed.
    }
  }
  return `<a href="/?${parameters.toString()}"${current ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${escapeHtml(label.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(label)}</span><span class="nav-arrow" aria-hidden="true">›</span></a>`;
}

function renderWorkspaceContextBar(context: WorkspaceContextBar): string {
  return `<nav class="workspace-context-bar" aria-label="Legal entity" data-shell-region="workspace-context-bar" data-scope-parameter-id="${escapeHtml(context.parameterId)}">
    <span class="workspace-context-bar__label">Legal entity</span>
    <span class="workspace-context-bar__options">${
      context.options.length === 0
        ? '<span class="muted">No legal entities available</span>'
        : context.options
            .map((option) => {
              const parameters = new URLSearchParams(
                context.preservedParameters.map(([key, value]) => [key, value]),
              );
              parameters.set('surface', context.targetSurfaceId);
              parameters.set(context.parameterId, option.recordId);
              const current = option.recordId === context.selectedRecordId;
              return `<a class="secondary-action" href="/?${parameters.toString()}" data-legal-entity-id="${escapeHtml(option.recordId)}"${current ? ' aria-current="true"' : ''}>${escapeHtml(option.label)}</a>`;
            })
            .join('')
    }</span>
  </nav>`;
}

function navigationEntries(
  surfaces: readonly CompiledSurfaceDefinition[],
  navigation: CompiledNavigationTree | null,
): readonly CompiledNavigationEntry[] {
  return (
    navigation?.entries ??
    surfaces.filter(isNavigationSurface).map((surface) => ({
      kind: 'navigationSurface' as const,
      surfaceId: surface.surfaceId,
    }))
  );
}

function navigationEntryIsCurrent(
  view: RuntimeViewContract.RequestRuntimeView,
  entry: CompiledNavigationEntry,
  surfaces: readonly CompiledSurfaceDefinition[],
  selected: CompiledSurfaceDefinition | null,
): boolean {
  if (!selected) return false;
  return entry.kind === 'navigationSurface'
    ? sharesSurfaceEntity(
        view,
        surfaceForNavigation(surfaces, entry),
        selected,
      ) || entry.surfaceId === selected.surfaceId
    : entry.children.some((child) =>
        navigationEntryIsCurrent(view, child, surfaces, selected),
      );
}

function surfaceForNavigation(
  surfaces: readonly CompiledSurfaceDefinition[],
  entry: Extract<CompiledNavigationEntry, { kind: 'navigationSurface' }>,
): CompiledSurfaceDefinition {
  const surface = surfaces.find(
    (candidate) => candidate.surfaceId === entry.surfaceId,
  );
  if (!surface) {
    throw new TypeError('validated navigation surface is unavailable');
  }
  return surface;
}

function navigationLabel(surface: CompiledSurfaceDefinition): string {
  return surface.surfaceRole === 'list'
    ? surface.label.replace(/\s+list$/i, '')
    : surface.label;
}

function isNavigationSurface(surface: CompiledSurfaceDefinition): boolean {
  return (
    surface.surfaceRole === 'list' ||
    (surface.surfaceRole === null &&
      (surface.archetype === 'list' ||
        surface.archetype === 'home' ||
        surface.archetype === 'task'))
  );
}

function sharesSurfaceEntity(
  view: RuntimeViewContract.RequestRuntimeView,
  navigation: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition,
): boolean {
  if (navigation.surfaceRole !== 'list') return false;
  try {
    return (
      readCompiledSurfaceDataBinding(view, navigation).query.sourceEntityId ===
      readCompiledSurfaceDataBinding(view, selected).query.sourceEntityId
    );
  } catch {
    return false;
  }
}

const styles = `${DESIGN_TOKENS}
*{box-sizing:border-box}
html{font-size:16px}
body{margin:0;min-width:320px;background:var(--surface-page);color:var(--ink);font-family:var(--font-sans);font-size:var(--text-base);font-weight:var(--weight-body);line-height:1.45}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
h1,h2,h3,strong,summary,th,label{font-weight:var(--weight-emphasis)}
code,.surface-id,.principal strong,.release-card strong,.diagnostic-release{font-family:var(--font-mono);font-size:var(--text-code)}
th,td,.fact-grid dd,.key-fact-grid dd,.record-fields dd,.task-decision output,.surface-id,.principal strong,.release-card strong,.cell-numeric,code{font-variant-numeric:tabular-nums}
.skip-link{position:fixed;left:var(--space-4);top:-80px;z-index:5;padding:var(--space-2) var(--space-4);border-radius:var(--radius-control);background:var(--accent-ground);color:var(--ink-on-accent);font-weight:var(--weight-emphasis);text-decoration:none}
.skip-link:focus{top:var(--space-4)}
.app-shell{min-height:100vh;display:grid;grid-template-columns:280px minmax(0,1fr)}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:var(--space-4) var(--space-3);background:var(--surface-rail);color:var(--ink-on-rail)}
.brand{display:flex;gap:var(--space-3);align-items:center;padding:var(--space-1) var(--space-2) var(--space-6)}
.brand__mark{display:grid;place-items:center;width:32px;height:32px;border-radius:var(--radius-control);background:var(--brand);color:var(--ink-on-brand);font-size:var(--text-section);font-weight:var(--weight-emphasis)}
.brand strong,.brand small{display:block}
.brand strong{font-size:var(--text-section)}
.brand small{margin-top:2px;color:var(--ink-on-rail-muted);font-size:var(--text-micro)}
.nav-label{padding:0 var(--space-2);margin:0;color:var(--ink-on-rail-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.12em;text-transform:uppercase}
.sidebar ul{display:grid;gap:var(--space-1);padding:0;margin:var(--space-2) 0;list-style:none}
.sidebar a,.navigation-group>summary{display:grid;grid-template-columns:24px 1fr auto;gap:var(--space-2);align-items:center;min-height:44px;padding:var(--space-1) var(--space-2);border-left:3px solid transparent;border-radius:var(--radius-control);color:var(--ink-on-rail-muted);text-decoration:none;font-size:var(--text-body);font-weight:var(--weight-emphasis);cursor:pointer;list-style:none}
.navigation-group>summary::-webkit-details-marker{display:none}
.navigation-children{margin:var(--space-1) 0 var(--space-2) var(--space-3)!important;padding-left:var(--space-2)!important;border-left:1px solid var(--line-on-rail)}
.sidebar a:hover,.navigation-group>summary:hover{background:var(--surface-rail-raised);color:var(--ink-on-rail)}
.sidebar a:focus-visible,.navigation-group>summary:focus-visible{outline:3px solid var(--focus-ring-rail);outline-offset:2px}
.sidebar a[aria-current=page],.navigation-group[data-current=true]>summary{border-left-color:var(--brand);background:var(--surface-rail-raised);color:var(--ink-on-rail)}
.nav-icon{display:grid;place-items:center;width:24px;height:24px;border-radius:var(--radius-control);background:var(--line-on-rail);color:var(--ink-on-rail);font-size:var(--text-micro);font-weight:var(--weight-emphasis)}
.sidebar a[aria-current=page] .nav-icon,.navigation-group[data-current=true]>summary .nav-icon{background:var(--brand);color:var(--ink-on-brand)}
.nav-arrow{font-size:var(--text-section);color:var(--ink-on-rail-muted)}
.navigation-group[open]>summary .nav-arrow{transform:rotate(90deg)}
.release-card{display:flex;gap:var(--space-2);align-items:flex-start;margin-top:auto;padding:var(--space-3);border:1px solid var(--line-on-rail);border-radius:var(--radius-container)}
.release-card__pulse{width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--brand)}
.release-card small,.release-card strong,.release-card span{display:block}
.release-card small{color:var(--ink-on-rail-muted);font-size:var(--text-micro);text-transform:uppercase;letter-spacing:.08em}
.release-card strong{margin:var(--space-1) 0;color:var(--ink-on-rail)}
.release-card span{color:var(--ink-on-rail-muted);font-size:var(--text-micro)}
.workspace{min-width:0}
.topbar{min-height:56px;display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-2) var(--page-padding);border-bottom:1px solid var(--line);background:var(--surface-panel);color:var(--ink-muted);font-size:var(--text-body)}
.topbar__context{color:var(--ink);font-weight:var(--weight-emphasis)}
.topbar__divider{padding:0 var(--space-2);color:var(--line-strong)}
.principal{display:flex;align-items:center;gap:var(--space-2)}
.principal__avatar{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--accent-selected);color:var(--accent-ink);font-size:var(--text-micro);font-weight:var(--weight-emphasis)}
.principal small,.principal strong{display:block}
.principal small{font-size:var(--text-micro);color:var(--ink-muted)}
.principal strong{color:var(--ink)}
main{width:min(1200px,100%);margin:0 auto;padding:var(--page-padding) var(--page-padding) var(--space-12)}
.surface-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-6);margin-bottom:var(--space-5)}
.eyebrow{margin:0 0 var(--space-1);color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.12em;text-transform:uppercase}
.surface-heading h1,.standalone h1,.diagnostic--page h1{margin:0;color:var(--ink-strong);font-family:var(--font-sans);font-size:var(--text-title);font-weight:var(--weight-emphasis);line-height:1.25;letter-spacing:-.01em}
.surface-id{margin:var(--space-2) 0 0;color:var(--ink-muted)}
.surface-status{display:flex;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.surface-status span,.status-pill{display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-3);border-radius:999px;background:var(--surface-sunken);color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis)}
.surface-status [data-status-role]::before,.status-pill[data-status-role]::before{content:"";flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:currentColor}
.surface-status [data-status-role=success],.status-pill[data-status-role=success]{background:var(--status-success-ground);color:var(--status-success-ink)}
.surface-status [data-status-role=attention],.status-pill[data-status-role=attention]{background:var(--status-attention-ground);color:var(--status-attention-ink)}
.surface-status [data-status-role=blocked],.status-pill[data-status-role=blocked]{background:var(--status-blocked-ground);color:var(--status-blocked-ink)}
.surface-status [data-status-role=inProgress],.status-pill[data-status-role=inProgress]{background:var(--status-inprogress-ground);color:var(--status-inprogress-ink)}
.surface-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--space-4)}
.panel,.diagnostic{grid-column:span 12;border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.panel{padding:var(--space-5)}
.panel--hero{position:relative;overflow:hidden;border-color:var(--accent-edge);background:var(--accent-soft)}
.panel__accent{position:absolute;right:var(--space-5);top:var(--space-5);display:grid;place-items:center;width:32px;height:32px;border-radius:var(--radius-container);background:var(--accent-ground);color:var(--ink-on-accent);font-size:var(--text-section)}
.panel h2,.diagnostic h2{max-width:60ch;margin:0 0 var(--space-2);font-family:var(--font-sans);font-size:var(--text-section);font-weight:var(--weight-emphasis);letter-spacing:0}
.lede{max-width:70ch;margin:0;color:var(--ink-muted);font-size:var(--text-base);line-height:1.55}
.fact-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-2);margin:var(--space-5) 0 0}
.fact-grid div,.key-fact-grid div,.record-fields div{padding:var(--space-3);border-radius:var(--radius-control);background:var(--surface-sunken)}
.fact-grid dt,.key-fact-grid dt,.record-fields dt,.form-fields span{color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);text-transform:uppercase;letter-spacing:.07em}
.fact-grid dd,.key-fact-grid dd,.record-fields dd{margin:var(--space-1) 0 0;font-size:var(--text-body)}
.panel__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4)}
.panel__heading h2{margin:0}
.checklist{display:grid;padding:0;margin:var(--space-4) 0 0;list-style:none}
.checklist li{display:grid;grid-template-columns:28px 1fr;gap:var(--space-3);align-items:start;padding:var(--space-3) 0;border-top:1px solid var(--line)}
.checklist li>span{display:grid;place-items:center;width:24px;height:24px;border-radius:var(--radius-control);background:var(--accent-selected);color:var(--accent-ink);font-size:var(--text-micro);font-weight:var(--weight-emphasis)}
.checklist strong{font-size:var(--text-body)}
.checklist p{margin:var(--space-1) 0 0;color:var(--ink-muted);font-size:var(--text-body);line-height:1.5}
.diagnostic{display:flex;gap:var(--space-3);align-items:flex-start;padding:var(--space-5);border-color:var(--status-blocked-ground);background:var(--status-blocked-ground);color:var(--status-blocked-ink)}
.diagnostic__mark{flex:0 0 auto;display:grid;place-items:center;width:28px;height:28px;border-radius:var(--radius-control);background:var(--status-blocked-ink);color:var(--status-blocked-ground);font-size:var(--text-section);font-weight:var(--weight-emphasis)}
.diagnostic h2,.diagnostic p{color:var(--status-blocked-ink)}
.diagnostic p{margin:0 0 var(--space-2);line-height:1.5}
.diagnostic code,.standalone code{display:inline-block;padding:var(--space-1) var(--space-2);border-radius:var(--radius-control);background:var(--surface-sunken);color:var(--ink)}
.standalone{min-height:100vh;display:grid;place-items:center;padding:var(--space-5);background:var(--surface-page)}
.standalone__card{width:min(640px,100%);padding:var(--space-6);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.standalone__card>p{color:var(--ink-muted);line-height:1.55}
.diagnostic-release{margin-top:var(--space-5);color:var(--ink-muted)}
.workspace-context-bar{display:flex;flex:1;min-width:0;align-items:center;justify-content:center;gap:var(--space-2)}
.workspace-context-bar__label{flex:0 0 auto;color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.08em;text-transform:uppercase}
.workspace-context-bar__options{display:flex;min-width:0;gap:var(--space-2);overflow-x:auto}
.workspace-context-bar__options .secondary-action{flex:0 0 auto;padding:var(--space-1) var(--space-3);font-size:var(--text-body)}
.workspace-context-bar__options .secondary-action[aria-current=true]{border-color:var(--accent-edge);background:var(--accent-selected)}
.surface-slot{display:contents}
.surface-heading--slot,.record-breadcrumb,.command-bar{grid-column:span 12}
.surface-heading--slot{margin-bottom:var(--space-1)}
.surface-heading__actions{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}
.record-breadcrumb{display:flex;gap:var(--space-2);align-items:center;color:var(--ink-muted);font-size:var(--text-body);font-weight:var(--weight-emphasis)}
.record-breadcrumb a{color:var(--accent-ink)}
.command-bar{display:flex;gap:var(--space-2);align-items:center;min-height:56px;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.command-bar .action-overflow{margin-left:auto}
.action-overflow{width:max-content}
.action-overflow summary{display:grid;place-items:center;min-height:44px;padding:var(--space-2) var(--space-4);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--accent-ink);font-weight:var(--weight-emphasis);cursor:pointer;list-style:none}
.action-overflow summary::-webkit-details-marker{display:none}
.action-overflow summary:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.action-overflow[open]{padding:var(--space-1);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-sunken)}
.action-overflow .lifecycle-action{margin:var(--space-1) 0 0}
.primary-action,.secondary-action{display:inline-grid;place-items:center;min-height:44px;padding:var(--space-2) var(--space-4);border-radius:var(--radius-control);font-size:var(--text-body);font-weight:var(--weight-emphasis);text-decoration:none}
.primary-action{background:var(--accent-ground);color:var(--ink-on-accent)}
.primary-action:hover{background:var(--accent-ground-hover)}
.primary-action:active{background:var(--accent-ground-pressed)}
.secondary-action{border:1px solid var(--line-strong);background:var(--surface-panel);color:var(--accent-ink)}
.secondary-action:hover{background:var(--accent-soft)}
.primary-action:focus-visible,.secondary-action:focus-visible,.record-link:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.data-panel,.data-empty,.operation-feedback{grid-column:span 12}
.surface-grid[data-surface-archetype=task]{max-width:768px;margin:0 auto}
.task-decision-slot,.task-scan-input-slot,.task-primary-action-slot,.task-primary-action{grid-column:span 12}
.task-decision output{display:block;margin:var(--space-3) 0;font-family:var(--font-sans);font-size:var(--text-title);font-weight:var(--weight-emphasis)}
.task-primary-action{display:flex;justify-content:flex-end}
.task-primary-action button{min-width:192px;min-height:44px}
.data-table-wrap{margin-top:var(--space-4);overflow-x:auto}
.data-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:var(--text-body)}
.data-table-wrap th{height:var(--row-header-height);padding:0 var(--space-3);border-bottom:1px solid var(--line);color:var(--ink-muted);font-size:var(--text-micro);text-transform:uppercase;letter-spacing:.08em;vertical-align:middle}
.data-table-wrap td{height:var(--row-height);padding:0 var(--space-3);border-bottom:1px solid var(--line);vertical-align:middle}
.data-table-wrap tbody tr:hover{background:var(--accent-soft)}
.data-table-wrap td:has(.cell-numeric){text-align:right}
.record-link{color:var(--accent-ink);font-weight:var(--weight-emphasis)}
.list-pagination{display:flex;justify-content:flex-end;margin-top:var(--space-3)}
.list-page-link{display:inline-grid;place-items:center;min-height:44px;padding:var(--space-2) var(--space-4);border-radius:var(--radius-control);background:var(--accent-ground);color:var(--ink-on-accent);font-size:var(--text-body);font-weight:var(--weight-emphasis);text-decoration:none}
.list-page-link:hover{background:var(--accent-ground-hover)}
.list-page-link:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.record-fields,.key-fact-grid{display:grid;gap:var(--space-2);margin:var(--space-4) 0}
.record-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
.key-fact-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.key-facts-panel{grid-column:span 12}
.record-fields dd{margin:var(--space-1) 0 0}
.form-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin:var(--space-4) 0}
.form-field{display:grid;align-content:start;gap:var(--space-2)}
.form-fields label{display:grid;gap:var(--space-1)}
.form-fields .form-empty-intent{padding-top:var(--space-1)}
.form-unavailable-value{display:block;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-sunken);color:var(--ink-muted);font-size:var(--text-body);line-height:1.45}
.form-unavailable-value code{color:var(--ink);overflow-wrap:anywhere}
.form-fields input,.form-fields select{width:100%;min-height:44px;padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--ink);font:inherit}
.form-fields input[type="checkbox"]{width:24px;height:24px;min-height:24px;padding:0;justify-self:start;margin:10px 0}
.form-fields input:focus-visible,.form-fields select:focus-visible,button:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
button{min-height:44px;padding:var(--space-2) var(--space-4);border:0;border-radius:var(--radius-control);background:var(--accent-ground);color:var(--ink-on-accent);font:inherit;font-weight:var(--weight-emphasis);cursor:pointer}
button:hover{background:var(--accent-ground-hover)}
button:active{background:var(--accent-ground-pressed)}
.lifecycle-action{margin-top:var(--space-4)}
.operation-feedback{padding:var(--space-3) var(--space-4);border-radius:var(--radius-container);background:var(--status-success-ground);color:var(--status-success-ink)}
.operation-feedback strong{margin-right:var(--space-1)}
.muted{color:var(--ink-muted)}
.record-section-group summary{display:flex;align-items:center;min-height:44px;padding:var(--space-2) 0;border-bottom:1px solid var(--line);color:var(--accent-ink);font-weight:var(--weight-emphasis);cursor:pointer}
.record-section-group summary:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.selection-cell{width:52px}
.record-selector{display:grid;place-items:center;min-width:44px;min-height:44px;cursor:pointer}
.record-selector__input{width:16px;height:16px;accent-color:var(--accent)}
.bulk-bar{grid-column:span 12;display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.bulk-bar p{margin:var(--space-1) 0 0;color:var(--ink-muted);font-size:var(--text-body)}
.bulk-ready{display:none}
body:has(.record-selector__input:checked) .bulk-empty{display:none}
body:has(.record-selector__input:checked) .bulk-ready{display:inline-grid}
.skeleton{position:relative;overflow:hidden;border-radius:var(--radius-control);background:var(--skeleton-base)}
.skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,var(--skeleton-sheen) 50%,transparent 100%);transform:translateX(-100%);animation:skeleton-sweep var(--shimmer-duration) linear infinite}
@keyframes skeleton-sweep{to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.skeleton::after{animation:none;display:none}}
@media (prefers-reduced-motion:no-preference){.sidebar a,.navigation-group>summary,.primary-action,.secondary-action,.list-page-link,.record-link,.data-table-wrap tbody tr,button{transition:background-color var(--motion-duration) var(--motion-easing),border-color var(--motion-duration) var(--motion-easing),color var(--motion-duration) var(--motion-easing),opacity var(--motion-duration) var(--motion-easing)}}
@media(max-width:800px){
body{padding-bottom:72px}
.app-shell{display:block}
.sidebar{position:fixed;z-index:4;right:0;bottom:0;left:0;width:100%;height:auto;padding:var(--space-1);border-top:1px solid var(--line-on-rail);background:var(--surface-rail)}
.brand,.release-card,.nav-label{display:none}
.sidebar .navigation-tree{display:grid;grid-template-columns:repeat(var(--compact-nav-count,4),minmax(0,1fr));gap:var(--space-1);margin:0;overflow:visible}
.navigation-tree>li{min-width:0}
.navigation-tree>li>a,.navigation-tree>li>.navigation-group>summary{display:flex;min-height:44px;justify-content:center;align-items:center;padding:var(--space-1);gap:var(--space-1);border-left:0;border-bottom:3px solid transparent;font-size:var(--text-micro);text-align:center}
.navigation-tree>li>a[aria-current=page],.navigation-tree>li>.navigation-group[data-current=true]>summary{border-left:0;border-bottom-color:var(--brand)}
.navigation-tree>.navigation-node--group>.navigation-group[open]>.navigation-children{position:fixed;right:var(--space-1);bottom:64px;left:var(--space-1);display:grid;max-height:60vh;overflow-y:auto;padding:var(--space-2)!important;margin:0!important;border:1px solid var(--line-on-rail);border-radius:var(--radius-container);background:var(--surface-rail-raised);box-shadow:var(--elevation-overlay)}
.navigation-tree>.navigation-node--group>.navigation-group[open]>.navigation-children .navigation-children{position:static;max-height:none;margin:var(--space-1) 0 var(--space-1) var(--space-3)!important;padding-left:var(--space-2)!important;overflow:visible;border:0;border-left:1px solid var(--line-on-rail);box-shadow:none}
.nav-icon,.nav-arrow{display:none}
.topbar{min-height:56px;height:auto;gap:var(--space-3);flex-wrap:wrap;padding-top:var(--space-2);padding-bottom:var(--space-2)}
.workspace-context-bar{order:3;flex-basis:100%;justify-content:flex-start}
.surface-heading{align-items:flex-start;flex-direction:column;gap:var(--space-3)}
.surface-status{justify-content:flex-start}
.fact-grid,.record-fields,.form-fields,.key-fact-grid{grid-template-columns:1fr}
.principal strong{max-width:144px;overflow:hidden;text-overflow:ellipsis}
.command-bar,.task-primary-action{position:sticky;z-index:3;bottom:80px;box-shadow:var(--elevation-overlay)}
.task-primary-action{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.task-primary-action button{width:100%}
.record-section-group:not([open]){padding-bottom:var(--space-3)}
.data-table-wrap{overflow:visible}
.data-table-wrap table,.data-table-wrap tbody{display:block}
.data-table-wrap thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.data-table-wrap tr[data-compact-card=true]{display:grid;gap:var(--space-1);margin:var(--space-3) 0;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.data-table-wrap tr[data-compact-card=true] td{display:grid;grid-template-columns:minmax(104px,38%) minmax(0,1fr);gap:var(--space-3);align-items:center;height:auto;min-height:44px;padding:var(--space-1) var(--space-2);border:0;text-align:left}
.data-table-wrap tr[data-compact-card=true] td::before{content:attr(data-column-label);color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.07em;text-transform:uppercase}
.data-table-wrap tr[data-compact-card=true] td:has(.cell-numeric){text-align:right}
.data-table-wrap tr[data-compact-card=true] td:has(.cell-numeric)::before{text-align:left}
.data-table-wrap tr[data-compact-card=true] .selection-cell{width:auto}
.bulk-bar{align-items:flex-start;flex-direction:column}
.bulk-bar .secondary-action{width:100%}
}
`;
