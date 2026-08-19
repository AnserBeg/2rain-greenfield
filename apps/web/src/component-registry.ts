import { randomUUID } from 'node:crypto';

import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import { evaluateRegisteredOperationPrecondition } from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  registeredSemanticQueryFromPinnedView,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

import { escapeHtml, shortIdentity } from './html.js';
import { sharedListView } from './list-runtime.js';
import type { QueryDiagnosticCode } from './message-catalog.js';
import {
  messageAttributes,
  messageBody,
  type SurfaceMessageRef,
} from './message-render.js';
import { readCompiledSurfaceDataBinding } from './surface-contract.js';
import type {
  CompiledFieldOption,
  CompiledSurfaceDefinition,
  CompiledSurfaceField,
  CompiledSurfaceInputField,
  CompiledSurfaceOperationBinding,
  CompiledSurfaceRelationInput,
  CompiledSurfaceSlot,
  EntityRelationAuthority,
  SurfaceOperationIntent,
} from './surface-contract.js';

export interface SurfaceRelationPickerOption {
  readonly label: string;
  readonly recordId: string;
}

export interface SurfaceRelationPicker {
  readonly options: readonly SurfaceRelationPickerOption[];
  readonly relationId: string;
  readonly required: boolean;
}

export type SurfaceRelationPickerState =
  | {
      readonly pickers: readonly SurfaceRelationPicker[];
      readonly status: 'ready';
    }
  | { readonly relationId: string; readonly status: 'refused' }
  | { readonly status: 'unavailable' };

export interface SurfaceComponentContext {
  readonly data?: SurfaceDataRenderState;
  readonly feedback?: SurfaceOperationFeedback | null;
  readonly legalEntitySelection?: readonly string[];
  readonly operations?: readonly CompiledSurfaceOperationBinding[];
  readonly queryParameterValues?: Readonly<Record<string, string>>;
  readonly relationInputs?: EntityRelationAuthority;
  readonly relationPickers?: SurfaceRelationPickerState;
  readonly slot: CompiledSurfaceSlot;
  readonly surface: CompiledSurfaceDefinition;
  readonly surfaces?: readonly CompiledSurfaceDefinition[];
  readonly view: RuntimeViewContract.RequestRuntimeView;
}

export const SURFACE_SLOT_RESOLUTION_STATES = Object.freeze([
  'pending',
  'ready',
  'empty',
  'failed',
] as const);

export type SurfaceSlotResolutionState =
  (typeof SURFACE_SLOT_RESOLUTION_STATES)[number];

export interface SurfaceComponentRenderResult {
  readonly code?: 'COMPONENT_RENDER_FAILED' | 'UNSUPPORTED_COMPONENT';
  readonly html: string;
  readonly state: SurfaceSlotResolutionState;
}

export type SurfaceDataRenderState =
  | { readonly status: 'UNBOUND' }
  | {
      readonly aggregate: SemanticAggregateResultEnvelope;
      readonly status: 'AGGREGATE_READY';
    }
  | {
      readonly records: readonly SemanticRecordDto[];
      readonly result?: SemanticQueryResultEnvelope;
      readonly status: 'READY';
    }
  | { readonly status: 'EMPTY' }
  | {
      // One authority: the read path's diagnostic subset is declared in the
      // catalog, so the render state cannot admit a code the catalog does not
      // register, and the gateway-error mapping targets the same set.
      readonly code: QueryDiagnosticCode;
      readonly status: 'DIAGNOSTIC';
    };

export interface SurfaceOperationFeedback {
  readonly intent: SurfaceOperationIntent;
  readonly label: string;
  readonly record: SemanticRecordDto;
  readonly trustLinked: boolean;
}

export interface SurfaceDataComponentContext {
  readonly data: SurfaceDataRenderState;
  readonly feedback: SurfaceOperationFeedback | null;
  readonly operations: readonly CompiledSurfaceOperationBinding[];
  readonly surface: CompiledSurfaceDefinition;
}

/**
 * Compatibility projection for non-browser consumers of the shared List HTML.
 * Product rendering reaches the same table through the list:dataGrid slot.
 */
export function renderSurfaceDataComponent({
  data,
  feedback,
  surface,
}: SurfaceDataComponentContext): string {
  if (data.status === 'UNBOUND') return '';
  if (data.status === 'DIAGNOSTIC') {
    return `${feedbackHtml(feedback)}${dataDiagnostic(data.code)}`;
  }
  if (data.status === 'AGGREGATE_READY') {
    return `${feedbackHtml(feedback)}${dataDiagnostic('QUERY_UNSUPPORTED')}`;
  }
  if (data.status === 'EMPTY') {
    return `${feedbackHtml(feedback)}${emptyDataPanel()}`;
  }
  return `${feedbackHtml(feedback)}${renderListSurfaceContent(
    surface,
    data.records,
    data.result,
  )}`;
}

type SurfaceComponentRenderer = (context: SurfaceComponentContext) => string;
type MutationSurfaceRole = 'form' | 'record';

interface SurfaceSlotRegistration {
  readonly className: string;
  readonly mutationIntents?: Partial<
    Readonly<Record<MutationSurfaceRole, readonly SurfaceOperationIntent[]>>
  >;
  readonly ownsDataResolution?: true;
  readonly renderer: SurfaceComponentRenderer;
}

const componentRegistry: Readonly<Record<string, SurfaceComponentRenderer>> =
  Object.freeze({
    'northstar.shell:component.error_probe': renderBoundaryProbe,
    'northstar.shell:component.release_summary': renderReleaseSummary,
    'northstar.shell:component.setup_checklist': renderSetupChecklist,
  });

const surfaceSlotRegistry: Readonly<Record<string, SurfaceSlotRegistration>> =
  Object.freeze({
    'list:bulkActions': {
      className: 'bulk-actions-slot',
      renderer: renderBulkActions,
    },
    'list:dataGrid': {
      className: 'data-grid-slot',
      ownsDataResolution: true,
      renderer: renderDataGrid,
    },
    'list:title': {
      className: 'surface-title-slot',
      renderer: renderListTitle,
    },
    'record:breadcrumb': {
      className: 'breadcrumb-slot',
      renderer: renderBreadcrumb,
    },
    'record:commandBar': {
      className: 'command-bar-slot',
      mutationIntents: { record: ['archive', 'command', 'restore'] },
      renderer: renderCommandBar,
    },
    'record:keyFacts': {
      className: 'key-facts-slot',
      mutationIntents: { record: ['archive', 'restore'] },
      ownsDataResolution: true,
      renderer: renderKeyFacts,
    },
    'record:sections': {
      className: 'sections-slot',
      mutationIntents: { form: ['create', 'update'] },
      ownsDataResolution: true,
      renderer: renderSections,
    },
    'record:titleStatus': {
      className: 'title-status-slot',
      renderer: renderTitleStatus,
    },
    'task:decision': {
      className: 'task-decision-slot',
      ownsDataResolution: true,
      renderer: renderTaskDecision,
    },
    'task:primaryAction': {
      className: 'task-primary-action-slot',
      renderer: renderTaskPrimaryAction,
    },
    'task:scanInput': {
      className: 'task-scan-input-slot',
      renderer: renderTaskScanInput,
    },
  });

export const REGISTERED_SURFACE_COMPONENT_IDS = Object.freeze(
  Object.keys(componentRegistry).sort(),
);

/** One registry-resolution authority backs both visible diagnostics and writes. */
export function surfaceHasUnsupportedComponent(
  surface: CompiledSurfaceDefinition,
): boolean {
  return surface.slots.some(
    (slot) => surfaceComponentRenderer(surface, slot) === undefined,
  );
}

/**
 * The registry entries that render mutation controls also authorize their
 * submissions. Record lifecycle controls additionally require a writable form
 * for the same entity, so a visibly inert entity cannot be mutated by posting
 * around its release-defined UI.
 */
export function surfaceSupportsRuntimeIntent(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  intent: SurfaceOperationIntent,
): boolean {
  if (
    surfaceHasUnsupportedComponent(surface) ||
    !surface.slots.some((slot) =>
      slotRegistrationSupportsIntent(surface, slot, intent),
    )
  ) {
    return false;
  }
  if (surface.surfaceRole !== 'record') return true;
  if (intent === 'command') return true;
  const form = findRelatedSurface(view, surface, surfaces, 'form');
  return form
    ? surfaceSupportsRuntimeIntent(view, form, surfaces, 'create') ||
        surfaceSupportsRuntimeIntent(view, form, surfaces, 'update')
    : false;
}

/** Closed lookup: there is deliberately no register/override escape hatch. */
export function renderRegisteredSurfaceComponent(
  context: SurfaceComponentContext,
): SurfaceComponentRenderResult {
  const renderer = surfaceComponentRenderer(context.surface, context.slot);
  if (!renderer) {
    return Object.freeze({
      code: 'UNSUPPORTED_COMPONENT' as const,
      html: resolvedSlot(
        context,
        // The one message carrying a subject. The component id is a declared
        // subject in its own element, never interpolated into the sentence.
        diagnostic({
          code: 'UNSUPPORTED_COMPONENT',
          subject: context.slot.contentReferenceId,
        }),
        'failed',
      ),
      state: 'failed' as const,
    });
  }

  return renderComponent(renderer, context);
}

function surfaceComponentRenderer(
  surface: CompiledSurfaceDefinition,
  slot: CompiledSurfaceSlot,
): SurfaceComponentRenderer | undefined {
  const slotKey = `${surface.archetype}:${slot.slot}`;
  if (Object.hasOwn(surfaceSlotRegistry, slotKey)) {
    return surfaceSlotRegistry[slotKey]?.renderer;
  }
  return Object.hasOwn(componentRegistry, slot.contentReferenceId)
    ? componentRegistry[slot.contentReferenceId]
    : undefined;
}

function renderComponent(
  renderer: SurfaceComponentRenderer,
  context: SurfaceComponentContext,
): SurfaceComponentRenderResult {
  try {
    const state = slotResolutionState(context);
    return Object.freeze({
      html: resolvedSlot(context, renderer(context), state),
      state,
    });
  } catch {
    return Object.freeze({
      code: 'COMPONENT_RENDER_FAILED' as const,
      html: resolvedSlot(
        context,
        diagnostic({ code: 'COMPONENT_RENDER_FAILED' }),
        'failed',
      ),
      state: 'failed' as const,
    });
  }
}

function slotResolutionState(
  context: SurfaceComponentContext,
): Exclude<SurfaceSlotResolutionState, 'failed'> | 'failed' {
  if (!slotOwnsDataResolution(context.surface, context.slot)) return 'ready';
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'UNBOUND') return 'pending';
  if (data.status === 'DIAGNOSTIC') return 'failed';
  if (
    data.status === 'EMPTY' ||
    (data.status === 'READY' && data.records.length === 0)
  ) {
    return context.surface.surfaceRole === 'form' ? 'ready' : 'empty';
  }
  return 'ready';
}

function slotOwnsDataResolution(
  surface: CompiledSurfaceDefinition,
  slot: CompiledSurfaceSlot,
): boolean {
  return (
    surfaceSlotRegistry[`${surface.archetype}:${slot.slot}`]
      ?.ownsDataResolution === true
  );
}

function resolvedSlot(
  context: SurfaceComponentContext,
  html: string,
  state: SurfaceSlotResolutionState,
): string {
  const slotClassName = surfaceSlotClassName(context.surface, context.slot);
  return `<div class="surface-slot${slotClassName ? ` ${slotClassName}` : ''}" data-component="${escapeHtml(context.slot.contentReferenceId)}" data-platform-slot="${escapeHtml(`${context.surface.archetype}:${context.slot.slot}`)}" data-slot-state="${state}">${html}</div>`;
}

function surfaceSlotClassName(
  surface: CompiledSurfaceDefinition,
  slot: CompiledSurfaceSlot,
): string | undefined {
  return surfaceSlotRegistry[`${surface.archetype}:${slot.slot}`]?.className;
}

function renderListTitle(context: SurfaceComponentContext): string {
  const form = relatedSurface(context, 'form');
  const archiveToggle = renderArchiveToggle(context);
  return slotPanel(
    context,
    `<header class="surface-heading surface-heading--slot"><div><p class="eyebrow">List · compiled workspace</p><h1>${escapeHtml(context.surface.label)}</h1></div><div class="surface-heading__actions">${declaredStatusRoles(context.surface)}${archiveToggle}${form ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form, undefined, false, context))}">New</a>` : ''}</div></header>`,
    'surface-title-slot',
  );
}

function renderDataGrid(context: SurfaceComponentContext): string {
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'UNBOUND') {
    return slotPanel(context, '', 'data-grid-slot');
  }
  if (data.status === 'DIAGNOSTIC') {
    return slotPanel(
      context,
      `${feedbackHtml(context.feedback)}${dataDiagnostic(data.code)}`,
      'data-grid-slot',
    );
  }
  const records = data.status === 'READY' ? data.records : [];
  const html =
    data.status === 'EMPTY'
      ? emptyDataPanel()
      : renderListSurfaceContent(
          context.surface,
          records,
          data.status === 'READY' ? data.result : undefined,
          relatedSurface(context, 'record'),
          context,
        );
  return slotPanel(
    context,
    `${feedbackHtml(context.feedback)}${html}`,
    'data-grid-slot',
  );
}

function renderBulkActions(context: SurfaceComponentContext): string {
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'UNBOUND' || data.status === 'DIAGNOSTIC') {
    return slotPanel(context, '', 'bulk-actions-slot');
  }
  const formId = bulkSelectionFormId(context.surface);
  return slotPanel(
    context,
    `<form class="bulk-bar" id="${escapeHtml(formId)}" data-bulk-selection-form><div><p class="eyebrow">Bulk actions</p><strong class="bulk-empty">Select records to begin</strong><strong class="bulk-ready">Selection ready</strong><p>This release keeps business actions record-scoped.</p></div><button class="secondary-action bulk-ready" type="reset">Clear selection</button></form>`,
    'bulk-actions-slot',
  );
}

function renderTaskDecision(context: SurfaceComponentContext): string {
  if (!taskUsesAggregateQuery(context)) {
    return renderReferencedComponent(context);
  }
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'DIAGNOSTIC') {
    return slotPanel(context, dataDiagnostic(data.code), 'task-decision-slot');
  }
  if (data.status === 'AGGREGATE_READY') {
    const result = data.aggregate.value;
    const unit = 'baseUnitId' in result ? shortIdentity(result.baseUnitId) : '';
    return slotPanel(
      context,
      `<section class="panel task-decision" data-data-state="exact"><p class="eyebrow">Decision</p><h2>${escapeHtml(context.surface.label)}</h2><output aria-label="Lookup result" data-aggregate-selection-id="${escapeHtml(result.selectionId)}" data-aggregate-value="${escapeHtml(result.value)}">${escapeHtml(result.value)}</output>${unit ? `<p class="muted">Base unit ${escapeHtml(unit)}</p>` : ''}</section>`,
      'task-decision-slot',
    );
  }
  return slotPanel(
    context,
    `<section class="panel task-decision" data-data-state="unasked"><p class="eyebrow">Decision</p><h2>${escapeHtml(context.surface.label)}</h2><p class="lede">Choose the workspace context and complete every lookup input before asking for a result.</p></section>`,
    'task-decision-slot',
  );
}

function renderTaskScanInput(context: SurfaceComponentContext): string {
  if (!taskUsesAggregateQuery(context)) {
    return renderReferencedComponent(context);
  }
  const binding = readCompiledSurfaceDataBinding(context.view, context.surface);
  if (binding.query.queryType !== 'aggregate') {
    throw new TypeError('task scan input requires an aggregate query');
  }
  const scopeParameterId = binding.query.legalEntityScope?.operand.parameterId;
  const parameters = binding.query.parameters
    .filter((parameter) => parameter.parameterId !== scopeParameterId)
    .sort((left, right) => left.orderKey - right.orderKey);
  const labels = taskParameterLabels(
    parameters.map((item) => item.parameterId),
  );
  const fields = parameters
    .map((parameter, index) => {
      const label = labels[index]!;
      const value = context.queryParameterValues?.[parameter.parameterId] ?? '';
      const isDateTime = parameter.parameterType.kind === 'dateTimeFieldType';
      return `<label><span>${escapeHtml(label)}</span><input ${index === 0 ? 'data-scan-input="true" ' : ''}name="${escapeHtml(parameter.parameterId)}" value="${escapeHtml(value)}" autocomplete="off" inputmode="text" placeholder="${escapeHtml(isDateTime ? 'UTC instant, for example 2026-07-30T12:00:00.000Z' : `Enter or scan ${label.toLowerCase()}`)}" required></label>`;
    })
    .join('');
  const legalEntityId =
    context.legalEntitySelection?.length === 1
      ? context.legalEntitySelection[0]
      : undefined;
  const hiddenScope =
    scopeParameterId && legalEntityId
      ? `<input type="hidden" name="${escapeHtml(scopeParameterId)}" value="${escapeHtml(legalEntityId)}">`
      : '';
  return slotPanel(
    context,
    `<section class="panel task-input"><p class="eyebrow">Scan input</p><h2>Lookup inputs</h2><form id="${escapeHtml(taskLookupFormId(context.surface))}" method="get" action="/"><input type="hidden" name="surface" value="${escapeHtml(context.surface.surfaceId)}">${hiddenScope}<div class="form-fields">${fields}</div></form></section>`,
    'task-scan-input-slot',
  );
}

function renderTaskPrimaryAction(context: SurfaceComponentContext): string {
  if (!taskUsesAggregateQuery(context)) {
    return renderReferencedComponent(context);
  }
  return slotPanel(
    context,
    `<div class="task-primary-action"><button type="submit" form="${escapeHtml(taskLookupFormId(context.surface))}">Look up</button></div>`,
    'task-primary-action-slot',
  );
}

function taskUsesAggregateQuery(context: SurfaceComponentContext): boolean {
  return (
    registeredSemanticQueryFromPinnedView(
      context.view,
      context.surface.dataSourceQueryId,
    )?.queryType === 'aggregate'
  );
}

function renderReferencedComponent(context: SurfaceComponentContext): string {
  const renderer = componentRegistry[context.slot.contentReferenceId];
  if (!renderer) {
    throw new TypeError('task slot has no registered referenced component');
  }
  return renderer(context);
}

function taskParameterLabels(parameterIds: readonly string[]): string[] {
  const parts = parameterIds.map((parameterId) =>
    parameterId
      .slice(parameterId.lastIndexOf('.') + 1)
      .split('_')
      .filter(Boolean),
  );
  let shared = 0;
  const shortest = Math.min(...parts.map((tokens) => tokens.length));
  while (
    parts.length > 0 &&
    shared < shortest &&
    parts.every((tokens) => tokens[shared] === parts[0]?.[shared])
  ) {
    shared += 1;
  }
  return parts.map((tokens) =>
    tokens
      .slice(shared)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' '),
  );
}

function taskLookupFormId(surface: CompiledSurfaceDefinition): string {
  return `task-lookup-${surface.surfaceId}`;
}

function renderBreadcrumb(context: SurfaceComponentContext): string {
  const list = relatedSurface(context, 'list');
  const label = entityLabel(context.surface);
  return slotPanel(
    context,
    `<nav class="record-breadcrumb" aria-label="Breadcrumb">${list ? `<a href="${escapeHtml(surfaceHref(list, undefined, false, context))}">${escapeHtml(list.label)}</a><span aria-hidden="true">/</span>` : ''}<span aria-current="page">${escapeHtml(label)}</span></nav>`,
    'breadcrumb-slot',
  );
}

function renderTitleStatus(context: SurfaceComponentContext): string {
  const record = recordFrom(context.data);
  const form = context.surface.surfaceRole === 'form';
  const title = form
    ? `${record ? 'Edit' : 'New'} ${entityLabel(context.surface)}`
    : record
      ? recordTitle(context, record)
      : entityLabel(context.surface);
  const status =
    context.surface.statusRoles.length > 0
      ? declaredStatusRoles(context.surface)
      : record
        ? `<span class="status-pill" data-status-role="${record.archived ? 'attention' : 'success'}">${record.archived ? 'Archived' : 'Active'} · revision ${record.revision}</span>`
        : form
          ? '<span class="status-pill" data-status-role="inProgress">Draft</span>'
          : '';
  return slotPanel(
    context,
    `<header class="surface-heading surface-heading--slot"><div><p class="eyebrow">${form ? 'Record form' : 'Record detail'} · compiled workspace</p><h1>${escapeHtml(title)}</h1></div>${status}</header>${feedbackHtml(context.feedback)}`,
    'title-status-slot',
  );
}

function renderArchiveToggle(context: SurfaceComponentContext): string {
  const coverage =
    context.data?.status === 'READY'
      ? context.data.result?.listCoverage
      : undefined;
  const includeArchived = coverage?.includeArchived ?? false;
  const parameters = new URLSearchParams({
    surface: context.surface.surfaceId,
  });
  appendLegalEntitySelection(parameters, context.surface, context);
  if ((coverage?.search ?? '').length > 0) {
    parameters.set('q', coverage?.search ?? '');
  }
  if (!includeArchived) parameters.set('archived', 'yes');
  return `<a class="secondary-action" data-archive-view="${includeArchived ? 'shown' : 'hidden'}" href="/?${escapeHtml(parameters.toString())}">${includeArchived ? 'Hide archived' : 'Show archived'}</a>`;
}

function recordTitle(
  context: SurfaceComponentContext,
  record: SemanticRecordDto,
): string {
  const displayFieldId = readCompiledSurfaceDataBinding(
    context.view,
    context.surface,
  ).displayFieldId;
  const displayValue = displayFieldId
    ? (record.displayValues?.[displayFieldId] ?? record.values[displayFieldId])
    : undefined;
  return typeof displayValue === 'string' && displayValue.trim().length > 0
    ? displayValue
    : shortIdentity(record.recordId);
}

function renderCommandBar(context: SurfaceComponentContext): string {
  const record = recordFrom(context.data);
  if (context.surface.surfaceRole === 'form') {
    const admission = resolveFormAdmission(context, record);
    return slotPanel(
      context,
      admission.status === 'admitted'
        ? `<div class="command-bar" aria-label="Record commands"><button type="submit" form="surface-record-form">Save</button></div>`
        : '',
      'command-bar-slot',
    );
  }

  const form = relatedSurface(context, 'form');
  const update = operationForIntent(context, 'update');
  // EVERY granted command, not the first one. The binding may now carry more
  // than one (`INTENT_RENDERED_ARITY` in surface-contract.ts), and a `find`
  // here would render one operable control while the rest bound invisibly --
  // which is the shape of concealing an action the user is entitled to.
  const commands = record
    ? (context.operations ?? []).filter(
        (operation) =>
          operation.intent === 'command' &&
          evaluateRegisteredOperationPrecondition(
            operation.precondition,
            record.values,
          ).outcome === 'holds',
      )
    : [];
  const actions = [
    record && form && update && operationAvailableForRecord(update, record)
      ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form, record.recordId, false, context))}">Edit</a>`
      : '',
    form
      ? `<a class="secondary-action" href="${escapeHtml(surfaceHref(form, undefined, false, context))}">New</a>`
      : '',
    record
      ? commands
          .map((command) => renderCapabilityCommand(context, record, command))
          .join('')
      : '',
    record ? renderLifecycleOverflow(context, record) : '',
  ].join('');
  return slotPanel(
    context,
    `<div class="command-bar" aria-label="Record commands">${actions}</div>`,
    'command-bar-slot',
  );
}

/**
 * Two effects bind to the `command` intent and they post identical arguments:
 * a registered capability, and a record transition. The FORM is therefore the
 * same; only the standing explanation differs, because a transition stages no
 * draft and appends no business fact -- it moves one state under a
 * compare-and-swap. Saying otherwise would describe an effect that does not
 * happen.
 */
function renderCapabilityCommand(
  context: SurfaceComponentContext,
  record: SemanticRecordDto,
  operation: CompiledSurfaceOperationBinding,
): string {
  // Both sides of the merge are load-bearing and they compose exactly.
  // `5g3-sm` distinguishes the standing explanation by effect kind; this
  // packet replaces the `intent=command` hidden input with the operation's own
  // id. A release and a cancel are both transitions, so before this merge they
  // would have been two identical forms differing only in their button label
  // and posting the same `intent` -- the collision this packet fixes, arriving
  // for the first time on a tree where transitions actually bind.
  const explanation = operation.capabilityId
    ? '<span><strong>Draft staged.</strong> Posting is a separate confirmed step.</span>'
    : '<span><strong>Ready.</strong> This moves the record to its next state.</span>';
  return `<form class="capability-command" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}" data-capability-id="${escapeHtml(operation.capabilityId ?? '')}" data-operation-id="${escapeHtml(operation.operationId)}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}">${explanation}<button type="submit">${escapeHtml(operation.label)}</button></form>`;
}

function renderKeyFacts(context: SurfaceComponentContext): string {
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'UNBOUND') {
    return slotPanel(context, '', 'key-facts-slot');
  }
  if (data.status === 'DIAGNOSTIC') {
    return slotPanel(context, dataDiagnostic(data.code), 'key-facts-slot');
  }
  const record = recordFrom(data);
  if (!record && context.surface.surfaceRole === 'form') {
    return slotPanel(
      context,
      `<section class="panel key-facts-panel" data-data-state="empty"><div class="panel__heading"><div><p class="eyebrow">Key facts</p><h2>New ${escapeHtml(entityLabel(context.surface))}</h2></div></div><dl class="key-fact-grid"><div><dt>Mode</dt><dd>New record</dd></div><div><dt>Fields</dt><dd>${String(context.surface.fieldIds.length)} declared</dd></div><div><dt>State</dt><dd><span class="status-pill" data-status-role="inProgress">Draft</span></dd></div></dl></section>`,
      'key-facts-slot',
    );
  }
  const compatibilityStatus =
    record && !hasSurfaceSlot(context, 'titleStatus')
      ? `<span class="status-pill" data-status-role="${record.archived ? 'attention' : 'success'}">${record.archived ? 'Archived' : 'Active'} · revision ${record.revision}</span>`
      : '';
  const compatibilityFeedback = hasSurfaceSlot(context, 'titleStatus')
    ? ''
    : feedbackHtml(context.feedback);
  const compatibilityActions =
    record && !hasSurfaceSlot(context, 'commandBar')
      ? renderLifecycleOverflow(context, record)
      : '';
  return slotPanel(
    context,
    record
      ? `${compatibilityFeedback}<section class="panel key-facts-panel" data-data-state="exact" data-record-id="${escapeHtml(record.recordId)}"><div class="panel__heading"><div><p class="eyebrow">Key facts</p><h2>${escapeHtml(recordTitle(context, record))}</h2></div>${compatibilityStatus}</div><dl class="key-fact-grid"><div><dt>Record</dt><dd><code>${escapeHtml(shortIdentity(record.recordId))}</code></dd></div><div><dt>State</dt><dd>${record.archived ? 'Archived' : 'Active'}</dd></div><div><dt>Revision</dt><dd>${String(record.revision)}</dd></div></dl>${compatibilityActions}</section>`
      : dataDiagnostic('QUERY_NOT_FOUND'),
    'key-facts-slot',
  );
}

function renderSections(context: SurfaceComponentContext): string {
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'UNBOUND') {
    return slotPanel(context, '', 'sections-slot');
  }
  if (data.status === 'DIAGNOSTIC') {
    return slotPanel(context, dataDiagnostic(data.code), 'sections-slot');
  }
  const record = recordFrom(data);
  if (context.surface.surfaceRole === 'record') {
    return slotPanel(
      context,
      record
        ? `<section class="panel data-panel" data-data-state="exact"><div class="panel__heading"><div><p class="eyebrow">Details</p><h2>${escapeHtml(entityLabel(context.surface))} information</h2></div></div><details class="record-section-group" open><summary>${escapeHtml(entityLabel(context.surface))} fields</summary><dl class="record-fields">${context.surface.fieldIds.map((fieldId) => `<div data-field-id="${escapeHtml(fieldId)}"><dt>${escapeHtml(fieldLabel(fieldId))}</dt><dd>${renderValue(record.values[fieldId])}</dd></div>`).join('')}</dl></details></section>`
        : dataDiagnostic('QUERY_NOT_FOUND'),
      'sections-slot',
    );
  }
  const admission = resolveFormAdmission(context, record);
  if (admission.status === 'surfaceUnsupported') {
    return slotPanel(context, '', 'sections-slot');
  }
  if (admission.status === 'operationUnsupported') {
    return slotPanel(
      context,
      dataDiagnostic('QUERY_UNSUPPORTED'),
      'sections-slot',
    );
  }
  if (admission.status === 'relationRefused') {
    return slotPanel(context, admission.refusal, 'sections-slot');
  }
  if (admission.status === 'predicateRefused') {
    return slotPanel(context, admission.freeze, 'sections-slot');
  }
  const { operation, relationContent } = admission;
  const recordId = record?.recordId ?? randomUUID();
  const compatibilityFeedback = hasSurfaceSlot(context, 'titleStatus')
    ? ''
    : feedbackHtml(context.feedback);
  const compatibilityCommand = hasSurfaceSlot(context, 'commandBar')
    ? ''
    : '<button type="submit">Save</button>';
  return slotPanel(
    context,
    `${compatibilityFeedback}<section class="panel data-panel" data-data-state="${record ? 'exact' : 'empty'}"><div class="panel__heading"><div><p class="eyebrow">Details</p><h2>${record ? 'Update the record' : 'Create a record'}</h2></div></div>${relationContent.freeze}<form id="surface-record-form" method="post" action="${escapeHtml(surfaceHref(context.surface, undefined, false, context))}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(recordId)}">${record ? `<input type="hidden" name="expectedRevision" value="${record.revision}">` : ''}<div class="form-fields">${relationContent.controls}${renderFormFields(context.surface, operation, record)}</div>${compatibilityCommand}</form></section>`,
    'sections-slot',
  );
}

type FormAdmissionDecision =
  | {
      readonly operation: CompiledSurfaceOperationBinding;
      readonly relationContent: ReturnType<typeof renderRelationContent>;
      readonly status: 'admitted';
    }
  | { readonly status: 'surfaceUnsupported' }
  | { readonly status: 'operationUnsupported' }
  | { readonly refusal: string; readonly status: 'relationRefused' }
  | { readonly freeze: string; readonly status: 'predicateRefused' };

/**
 * Form content and its command bar are two slots presenting one admission
 * decision. Neither may offer its half when the other refuses the operation.
 */
function resolveFormAdmission(
  context: SurfaceComponentContext,
  record: SemanticRecordDto | null,
): FormAdmissionDecision {
  const intent = record ? 'update' : 'create';
  if (
    !surfaceSupportsRuntimeIntent(
      context.view,
      context.surface,
      context.surfaces ?? [],
      intent,
    )
  ) {
    return { status: 'surfaceUnsupported' };
  }
  const operation = operationForIntent(context, intent);
  if (!operation) return { status: 'operationUnsupported' };
  const relationContent = renderRelationContent(context, record);
  if (relationContent.refusal !== '') {
    return {
      refusal: relationContent.refusal,
      status: 'relationRefused',
    };
  }
  if (!operationAvailableForRecord(operation, record)) {
    return {
      freeze: relationContent.freeze,
      status: 'predicateRefused',
    };
  }
  return { operation, relationContent, status: 'admitted' };
}

function renderRelationContent(
  context: SurfaceComponentContext,
  record: SemanticRecordDto | null,
): {
  readonly controls: string;
  readonly freeze: string;
  readonly refusal: string;
} {
  const authority = context.relationInputs;
  if (!authority || authority.status === 'unavailable') {
    return {
      controls: '',
      freeze: '',
      refusal: dataDiagnostic('QUERY_UNSUPPORTED'),
    };
  }
  if (record) {
    return {
      controls: '',
      freeze: renderRelationFreeze(authority.relationInputs),
      refusal: '',
    };
  }
  const pickerState = context.relationPickers;
  if (!pickerState || pickerState.status === 'unavailable') {
    return {
      controls: '',
      freeze: '',
      refusal: dataDiagnostic('QUERY_UNSUPPORTED'),
    };
  }
  if (pickerState.status === 'refused') {
    return {
      controls: '',
      freeze: '',
      refusal: diagnostic({
        code: 'RELATION_ENUMERATION_UNAVAILABLE',
        subject: pickerState.relationId,
      }),
    };
  }
  return {
    controls: pickerState.pickers.map(renderRelationPicker).join(''),
    freeze: '',
    refusal: '',
  };
}

function renderRelationPicker(picker: SurfaceRelationPicker): string {
  const label = fieldLabel(picker.relationId);
  const first = picker.required
    ? `<option value="">Choose ${escapeHtml(label)}</option>`
    : '<option value="">None</option>';
  const options = picker.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.recordId)}">${escapeHtml(option.label)}</option>`,
    )
    .join('');
  return `<div class="form-field relation-picker" data-relation-id="${escapeHtml(picker.relationId)}"><label><span>${escapeHtml(label)}</span><select name="relation:${escapeHtml(picker.relationId)}" autocomplete="off"${picker.required ? ' required' : ''}>${first}${options}</select></label></div>`;
}

function renderRelationFreeze(
  relations: readonly CompiledSurfaceRelationInput[],
): string {
  if (relations.length === 0) return '';
  return `<aside class="relation-freeze" data-relation-freeze><p class="eyebrow">Relations</p><h3>Set at creation</h3><ul>${relations.map((relation) => `<li data-relation-id="${escapeHtml(relation.relationId)}"><strong>${escapeHtml(fieldLabel(relation.relationId))}</strong> is set when this record is created and cannot be changed here.</li>`).join('')}</ul></aside>`;
}

function renderReleaseSummary({
  surface,
  view,
}: SurfaceComponentContext): string {
  const roles =
    surface.statusRoles.length === 0
      ? 'No status roles declared'
      : surface.statusRoles.join(' · ');
  return `<section class="panel panel--hero">
    <div class="panel__accent" aria-hidden="true">↗</div>
    <p class="eyebrow">Pinned application definition</p>
    <h2>${escapeHtml(surface.label)} is release-defined</h2>
    <p class="lede">This request is rendering one immutable compiled surface. A later activation can change the next request without changing this one.</p>
    <dl class="fact-grid">
      <div><dt>Release</dt><dd>${escapeHtml(shortIdentity(view.release.releaseId))}</dd></div>
      <div><dt>Fence</dt><dd>${view.pointer.fence}</dd></div>
      <div><dt>Status grammar</dt><dd>${escapeHtml(roles)}</dd></div>
    </dl>
  </section>`;
}

function renderSetupChecklist({
  surface,
  view,
}: SurfaceComponentContext): string {
  return `<section class="panel">
    <div class="panel__heading">
      <div>
        <p class="eyebrow">Compiled setup</p>
        <h2>${escapeHtml(surface.label)} checklist</h2>
      </div>
      <span class="status-pill">Release ${escapeHtml(shortIdentity(view.release.releaseId))}</span>
    </div>
    <ol class="checklist">
      <li><span aria-hidden="true">01</span><div><strong>Surface manifest loaded</strong><p>${surface.slots.length} release-defined slot${surface.slots.length === 1 ? '' : 's'} selected.</p></div></li>
      <li><span aria-hidden="true">02</span><div><strong>Request definition pinned</strong><p>Fence ${view.pointer.fence} remains stable for this unit of work.</p></div></li>
      <li><span aria-hidden="true">03</span><div><strong>Projection ready</strong><p>${surface.fieldIds.length} compiled field reference${surface.fieldIds.length === 1 ? '' : 's'} available to later data screens.</p></div></li>
    </ol>
  </section>`;
}

function renderBoundaryProbe(): string {
  throw new Error('intentional registered boundary probe');
}

function renderListSurfaceContent(
  surface: CompiledSurfaceDefinition,
  records: readonly SemanticRecordDto[],
  result: SemanticQueryResultEnvelope | undefined,
  detail?: CompiledSurfaceDefinition,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): string {
  if (result?.listCoverage) {
    return renderSharedListSurface(surface, result, detail, linkContext);
  }
  if (records.length === 0) {
    return emptyDataPanel();
  }
  const selectable = hasNamedSlot(surface, 'bulkActions');
  const formId = bulkSelectionFormId(surface);
  return `<section class="panel data-panel" data-data-state="exact"><div class="panel__heading"><div><p class="eyebrow">Records</p><h2>${escapeHtml(surface.label)}</h2></div><span class="status-pill">${records.length} visible</span></div><div class="data-table-wrap" data-list-rendering="responsive-single"><table><thead><tr>${selectable ? '<th scope="col">Select</th>' : ''}<th scope="col">Record</th>${surface.fieldIds.map((fieldId) => `<th scope="col">${escapeHtml(fieldLabel(fieldId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${records.map((record) => `<tr data-compact-card="true" data-record-id="${escapeHtml(record.recordId)}">${selectable ? selectionCell(formId, record) : ''}<td data-column-label="Record" data-column-priority="0">${detail ? `<a class="record-link" href="${escapeHtml(surfaceHref(detail, record.recordId, record.archived, linkContext))}" aria-label="Open ${escapeHtml(entityLabel(surface))} ${escapeHtml(shortIdentity(record.recordId))}"><code>${escapeHtml(shortIdentity(record.recordId))}</code></a>` : `<code>${escapeHtml(shortIdentity(record.recordId))}</code>`}</td>${surface.fieldIds.map((fieldId, index) => `<td data-column-label="${escapeHtml(fieldLabel(fieldId))}" data-column-priority="${String(index + 1)}" data-field-id="${escapeHtml(fieldId)}">${renderValue(record.values[fieldId])}</td>`).join('')}<td data-column-label="Status" data-column-priority="${String(surface.fieldIds.length + 1)}">${record.archived ? 'Archived' : 'Active'}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function renderSharedListSurface(
  surface: CompiledSurfaceDefinition,
  result: SemanticQueryResultEnvelope,
  detail?: CompiledSurfaceDefinition,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): string {
  const view = sharedListView(result);
  const firstVisible =
    view.listCoverage.returnedCount === 0
      ? 0
      : view.listCoverage.pageOffset + 1;
  const lastVisible =
    view.listCoverage.pageOffset + view.listCoverage.returnedCount;
  const coverage = `${firstVisible}–${lastVisible} of ${view.listCoverage.totalCount}`;
  const columns =
    view.columns.length > 0
      ? view.columns
      : surface.fieldIds.map((columnId) => ({
          columnId,
          kind: 'field' as const,
        }));
  const coverageRole =
    view.listCoverage.hasMore || view.listCoverage.truncatedByMaximum
      ? 'attention'
      : 'success';
  const selectable = hasNamedSlot(surface, 'bulkActions');
  const formId = bulkSelectionFormId(surface);
  const body =
    view.rows.length === 0
      ? `<div class="data-empty" data-data-state="empty" data-list-zero-input="true"><h3>No records yet</h3><p>This search has zero visible records for the current tenant, environment, and principal.</p></div>`
      : `<div class="data-table-wrap" data-list-rendering="responsive-single"><table><thead><tr>${selectable ? '<th scope="col">Select</th>' : ''}<th scope="col">Record</th>${columns.map((column) => `<th scope="col">${escapeHtml(fieldLabel(column.columnId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${view.rows.map((row) => `<tr data-compact-card="true" data-record-id="${escapeHtml(row.record.recordId)}">${selectable ? selectionCell(formId, row.record) : ''}<td data-column-label="Record" data-column-priority="0">${detail ? `<a class="record-link" href="${escapeHtml(surfaceHref(detail, row.record.recordId, row.archived, linkContext))}" aria-label="Open ${escapeHtml(entityLabel(surface))} ${escapeHtml(shortIdentity(row.record.recordId))}"><code>${escapeHtml(shortIdentity(row.record.recordId))}</code></a>` : `<code>${escapeHtml(shortIdentity(row.record.recordId))}</code>`}</td>${columns.map((column, index) => `<td data-column-label="${escapeHtml(fieldLabel(column.columnId))}" data-column-priority="${String(index + 1)}" ${column.kind === 'relation' ? 'data-relation-id' : 'data-field-id'}="${escapeHtml(column.columnId)}">${renderValue(row.cells[column.columnId])}</td>`).join('')}<td data-column-label="Status" data-column-priority="${String(columns.length + 1)}"><span class="status-pill" data-status-role="${row.archived ? 'attention' : 'success'}">${row.archived ? 'Archived' : 'Active'}</span></td></tr>`).join('')}</tbody></table></div>`;
  const next = view.listCoverage.nextCursor
    ? `<a class="list-page-link" href="${escapeHtml(nextPageHref(surface, view.listCoverage.nextCursor, view.listCoverage.search, view.listCoverage.includeArchived, linkContext))}">Next page</a>`
    : '';
  return `<section class="panel data-panel" data-data-state="exact" data-list-result="${escapeHtml(view.listCoverage.schemaVersion)}"><div class="panel__heading"><div><p class="eyebrow">Records</p><h2>${escapeHtml(surface.label)}</h2></div><span class="status-pill" data-status-role="${coverageRole}" data-list-coverage="${escapeHtml(coverage)}">${escapeHtml(coverage)} visible</span></div>${body}<nav class="list-pagination" aria-label="List pages">${next}</nav></section>`;
}

function nextPageHref(
  surface: CompiledSurfaceDefinition,
  cursor: string,
  search: string,
  includeArchived: boolean,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): string {
  const parameters = new URLSearchParams({
    cursor,
    surface: surface.surfaceId,
  });
  if (search.length > 0) parameters.set('q', search);
  if (includeArchived) parameters.set('archived', 'yes');
  appendLegalEntitySelection(parameters, surface, linkContext);
  return `/?${parameters.toString()}`;
}

function renderLifecycleForm(
  context: SurfaceComponentContext,
  record: SemanticRecordDto,
): string {
  const intent = record.archived ? 'restore' : 'archive';
  if (
    !surfaceSupportsRuntimeIntent(
      context.view,
      context.surface,
      context.surfaces ?? [],
      intent,
    )
  ) {
    return '';
  }
  const operation = (context.operations ?? []).find(
    (binding) => binding.intent === intent,
  );
  return operation
    ? `<form class="lifecycle-action" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}"><button class="secondary-action" type="submit">${escapeHtml(operation.label)}</button></form>`
    : '';
}

function renderLifecycleOverflow(
  context: SurfaceComponentContext,
  record: SemanticRecordDto,
): string {
  const lifecycleForm = renderLifecycleForm(context, record);
  return lifecycleForm
    ? `<details class="action-overflow"><summary>More actions</summary>${lifecycleForm}</details>`
    : '';
}

function dataDiagnostic(
  code: Extract<SurfaceDataRenderState, { status: 'DIAGNOSTIC' }>['code'],
): string {
  return diagnostic({ code });
}

function fieldLabel(fieldId: string): string {
  const local = fieldId.slice(fieldId.lastIndexOf('.') + 1);
  return local
    .split('_')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function slotPanel(
  context: SurfaceComponentContext,
  html: string,
  className: string,
): string {
  if (surfaceSlotClassName(context.surface, context.slot) !== className) {
    throw new TypeError('surface slot class does not match its registry key');
  }
  return html;
}

function feedbackHtml(
  feedback: SurfaceOperationFeedback | null | undefined,
): string {
  return feedback
    ? `<section class="operation-feedback" role="status" data-operation-intent="${feedback.intent}" data-trust-linked="${String(feedback.trustLinked)}"><strong>${escapeHtml(feedback.label)} complete.</strong> The saved record is reflected below${feedback.trustLinked ? ' and its trust evidence is linked' : ''}.</section>`
    : '';
}

function emptyDataPanel(): string {
  return `<section class="panel data-empty" data-data-state="empty"><p class="eyebrow">Records</p><h2>No records yet</h2><p class="lede">This view has no visible records for the current tenant, environment, and principal.</p></section>`;
}

function recordFrom(
  data: SurfaceDataRenderState | undefined,
): SemanticRecordDto | null {
  return data?.status === 'READY' ? (data.records[0] ?? null) : null;
}

function relatedSurface(
  context: SurfaceComponentContext,
  role: CompiledSurfaceDefinition['surfaceRole'],
): CompiledSurfaceDefinition | undefined {
  const related = findRelatedSurface(
    context.view,
    context.surface,
    context.surfaces ?? [],
    role,
  );
  if (!related || role !== 'form') return related;
  return surfaceSupportsRuntimeIntent(
    context.view,
    related,
    context.surfaces ?? [],
    'create',
  ) ||
    surfaceSupportsRuntimeIntent(
      context.view,
      related,
      context.surfaces ?? [],
      'update',
    )
    ? related
    : undefined;
}

/**
 * A current-record affordance is a view of the compiled operation predicate,
 * never a second state rule. The interpreter remains authoritative over create
 * candidates and both update images; this only prevents offering a control the
 * current image already proves cannot execute. Unsupported predicates fail
 * closed for the same reason command rendering does.
 */
function operationForIntent(
  context: SurfaceComponentContext,
  intent: SurfaceOperationIntent,
): CompiledSurfaceOperationBinding | undefined {
  return (context.operations ?? []).find(
    (binding) => binding.intent === intent,
  );
}

function operationAvailableForRecord(
  operation: CompiledSurfaceOperationBinding,
  record: SemanticRecordDto | null,
): boolean {
  return (
    record === null ||
    evaluateRegisteredOperationPrecondition(
      operation.precondition,
      record.values,
    ).outcome === 'holds'
  );
}

function findRelatedSurface(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  role: CompiledSurfaceDefinition['surfaceRole'],
): CompiledSurfaceDefinition | undefined {
  try {
    const entityId = readCompiledSurfaceDataBinding(view, surface).query
      .sourceEntityId;
    return surfaces.find((candidate) => {
      if (candidate.lifecycle !== 'active' || candidate.surfaceRole !== role) {
        return false;
      }
      try {
        return (
          readCompiledSurfaceDataBinding(view, candidate).query
            .sourceEntityId === entityId
        );
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

function slotRegistrationSupportsIntent(
  surface: CompiledSurfaceDefinition,
  slot: CompiledSurfaceSlot,
  intent: SurfaceOperationIntent,
): boolean {
  if (surface.surfaceRole !== 'form' && surface.surfaceRole !== 'record') {
    return false;
  }
  const registration = surfaceSlotRegistry[`${surface.archetype}:${slot.slot}`];
  return (
    registration?.mutationIntents?.[surface.surfaceRole]?.includes(intent) ??
    false
  );
}

function surfaceHref(
  surface: CompiledSurfaceDefinition,
  recordId?: string,
  includeArchived = false,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): string {
  const parameters = new URLSearchParams({ surface: surface.surfaceId });
  if (recordId) parameters.set('record', recordId);
  if (includeArchived) parameters.set('archived', 'yes');
  appendLegalEntitySelection(parameters, surface, linkContext);
  return `/?${parameters.toString()}`;
}

function appendLegalEntitySelection(
  parameters: URLSearchParams,
  surface: CompiledSurfaceDefinition,
  linkContext:
    Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'> | undefined,
): void {
  const selection = linkContext?.legalEntitySelection ?? [];
  if (!linkContext || selection.length === 0) return;
  const scope = readCompiledSurfaceDataBinding(linkContext.view, surface).query
    .legalEntityScope;
  if (!scope) return;
  const parameterId = scope.operand.parameterId;
  if (scope.cardinality === 'exactlyOne') {
    parameters.set(parameterId, selection[0]!);
    return;
  }
  for (const legalEntityId of selection) {
    parameters.append(parameterId, legalEntityId);
  }
}

function entityLabel(surface: CompiledSurfaceDefinition): string {
  return surface.label.replace(/\s+(?:detail|form|list)$/i, '');
}

function hasSurfaceSlot(
  context: SurfaceComponentContext,
  slot: string,
): boolean {
  return context.surface.slots.some((candidate) => candidate.slot === slot);
}

function hasNamedSlot(
  surface: CompiledSurfaceDefinition,
  slot: string,
): boolean {
  return surface.slots.some((candidate) => candidate.slot === slot);
}

function bulkSelectionFormId(surface: CompiledSurfaceDefinition): string {
  return `bulk-selection-${surface.surfaceId}`;
}

function selectionCell(formId: string, record: SemanticRecordDto): string {
  return `<td class="selection-cell" data-column-label="Select"><label class="record-selector"><span class="sr-only">Select ${escapeHtml(shortIdentity(record.recordId))}</span><input aria-label="Select ${escapeHtml(shortIdentity(record.recordId))}" class="record-selector__input" form="${escapeHtml(formId)}" name="recordId" type="checkbox" value="${escapeHtml(record.recordId)}"></label></td>`;
}

function declaredStatusRoles(surface: CompiledSurfaceDefinition): string {
  return surface.statusRoles
    .map(
      (role) =>
        `<span class="status-pill" data-status-role="${escapeHtml(role)}">${escapeHtml(role)}</span>`,
    )
    .join('');
}

/**
 * Above this many options an enum renders as a `datalist`-backed input rather
 * than a `select`. A short closed list is faster to operate as a menu; a long
 * one is faster to type into, and `datalist` gives that typeahead with **no
 * script at all** -- which is the whole reason it is the carrier here.
 * ADR-0036 §2 authorises exactly four client behaviours and a scripted combobox
 * is none of them, so the choice was between a native control and nothing.
 */
const ENUM_SELECT_MAXIMUM_OPTIONS = 5;

/**
 * The compiled surface says what a field IS; this decides what it looks like.
 *
 * When the manifest carries no per-field kinds -- every profile version before
 * the unadopted v2, which is every recorded release today -- every field falls
 * back to the bare text box that was here before. **That fallback exists only
 * for manifests BELOW the field-capability floor.** It is not a compatibility
 * guarantee and nothing may be argued from it: a manifest that carries `fields`
 * declares surface-manifest capability version 3, and a reader without field
 * support must refuse it rather than fall back to this branch.
 *
 * This paragraph previously said the fallback was why `minimumVersion` did not
 * have to move. It has moved. The version is what prevents an unaware reader
 * from serving a field-bearing manifest; the fallback only serves the older
 * ones.
 *
 * What this does NOT do is decide how the form BEHAVES. Required-ness, inline
 * validation, chunking and string-to-typed normalisation are `U7`'s.
 *
 * **The line between the two moved once, under review, and the correction is
 * worth keeping.** Choosing a control that cannot express a field's declared
 * domain is not deferring to `U7`; it is destroying the value before `U7` can
 * see it. So a control here must admit everything the declaration admits, and
 * where no native control does, the carrier stays lossless and the refusal is
 * named rather than absorbed.
 */
/**
 * The string-only form wire's closed empty-control vocabulary. Exporting the
 * prefix from the renderer keeps the HTML name and the submission reader on
 * one spelling; the reader still validates every posted value at runtime.
 */
export const FORM_EMPTY_INTENT_PREFIX = 'empty:';

function renderFormFields(
  surface: CompiledSurfaceDefinition,
  operation: CompiledSurfaceOperationBinding,
  record: SemanticRecordDto | null,
): string {
  const fieldsById = new Map(
    (surface.fields ?? []).map((field) => [field.fieldId, field]),
  );
  const inputFieldsById = new Map(
    (operation.inputFields ?? []).map((field) => [field.fieldId, field]),
  );
  return surface.fieldIds
    .map((fieldId, index) => {
      const value = record ? record.values[fieldId] : undefined;
      const field = fieldsById.get(fieldId);
      const inputField = inputFieldsById.get(fieldId);
      const control = renderFormControl(
        field,
        inputField,
        fieldId,
        index,
        value,
      );
      const emptyIntent = renderEmptyIntentControl(
        inputField,
        fieldId,
        value,
        record !== null,
        control.storedValueUnavailable,
      );
      const unavailableValue = control.storedValueUnavailable
        ? renderUnavailableStoredValue(fieldId, index, inputField, value)
        : '';
      return `<div class="form-field"><label><span>${escapeHtml(fieldLabel(fieldId))}</span>${control.html}</label>${unavailableValue}${emptyIntent}</div>`;
    })
    .join('');
}

/**
 * A blank control never has to guess between three different mutations.
 *
 * - `nothing` omits the field (create: no value stated; update: leave alone),
 * - `clear` emits JSON null, and
 * - `emptyText` emits the real text value `""`.
 *
 * All are native server-rendered choices. On update, `nothing` is the safe
 * default for every non-empty stored value: a non-empty primary control still
 * wins as `set`, while a blank control cannot clear anything unless the
 * operator explicitly chooses `clear`. Stored empty text selects `emptyText`.
 * Every required text update gets the explicit `nothing | emptyText` choice,
 * so the submission reader can require the companion from the pinned
 * operation contract without knowing the record state that caused the render.
 * `nothing` safely preserves an unavailable value; `emptyText` keeps ordinary
 * required text intentionally blankable. An unavailable required non-text
 * value needs only the hidden preservation marker. No field value is invented
 * or destroyed by a control default.
 */
function renderEmptyIntentControl(
  field: CompiledSurfaceInputField | undefined,
  fieldId: string,
  value: unknown,
  updating: boolean,
  storedValueUnavailable: boolean,
): string {
  if (!field) return '';
  const option = (
    intent: 'clear' | 'emptyText' | 'nothing',
    label: string,
    selectedIntent: 'clear' | 'emptyText' | 'nothing',
  ): string =>
    `<option value="${intent}"${selectedIntent === intent ? ' selected' : ''}>${label}</option>`;
  const select = (options: readonly string[]): string =>
    `<label class="form-empty-intent"><span>When ${escapeHtml(fieldLabel(fieldId))} is blank</span><select name="${FORM_EMPTY_INTENT_PREFIX}${escapeHtml(fieldId)}" data-empty-intent-for="${escapeHtml(fieldId)}" autocomplete="off">${options.join('')}</select></label>`;
  if (field.required) {
    if (!updating) return '';
    if (field.kind === 'textFieldType') {
      const selected =
        storedValueUnavailable || value === null || value === undefined
          ? 'nothing'
          : 'emptyText';
      return select([
        option('nothing', 'Leave unchanged', selected),
        option('emptyText', 'Save an empty text value', selected),
      ]);
    }
    if (!storedValueUnavailable) return '';
    return `<input type="hidden" name="${FORM_EMPTY_INTENT_PREFIX}${escapeHtml(fieldId)}" value="nothing" data-preserve-unavailable-for="${escapeHtml(fieldId)}">`;
  }
  const selected =
    !updating || value === null || value === undefined
      ? 'nothing'
      : field.kind === 'textFieldType' && value === ''
        ? 'emptyText'
        : 'nothing';
  const options = [
    option('nothing', updating ? 'Leave unchanged' : 'No value', selected),
    ...(updating ? [option('clear', 'Clear stored value', selected)] : []),
    ...(field.kind === 'textFieldType'
      ? [option('emptyText', 'Save an empty text value', selected)]
      : []),
  ];
  return select(options);
}

interface RenderedFormControl {
  readonly html: string;
  /** The browser will sanitize or de-select this stored value to blank. */
  readonly storedValueUnavailable: boolean;
}

function renderFormControl(
  field: CompiledSurfaceField | undefined,
  inputField: CompiledSurfaceInputField | undefined,
  fieldId: string,
  index: number,
  value: unknown,
): RenderedFormControl {
  const name = `value:${escapeHtml(fieldId)}`;
  const storedValueUnavailable =
    value !== null &&
    value !== undefined &&
    (field
      ? !typedControlPreservesValue(field, value)
      : inputField
        ? !bareControlPreservesValue(inputField, value)
        : false);
  // Make the unavailable state deterministic in the rendered HTML rather than
  // relying on each browser to sanitize the value after parsing the attribute.
  const renderedValue = storedValueUnavailable ? undefined : value;
  const describedBy = storedValueUnavailable
    ? ` aria-describedby="${unavailableStoredValueId(index)}"`
    : '';
  if (!field) {
    return {
      html: `<input${describedBy} name="${name}" value="${renderInputValue(renderedValue)}" autocomplete="off">`,
      storedValueUnavailable,
    };
  }
  const current = renderInputValue(renderedValue);
  const kind = ` data-field-kind="${field.kind}"${describedBy}`;
  const html = (() => {
    switch (field.kind) {
      case 'enumFieldType':
        return renderEnumControl(
          field.options,
          name,
          kind,
          index,
          renderedValue,
        );
      case 'booleanFieldType':
        return renderBooleanControl(name, kind, renderedValue);
      case 'dateFieldType':
        // The only temporal kind a native control admits whole: `calendar` and
        // `timezoneSemantics` are single-valued in the canonical schema, and
        // `type="date"` emits exactly the `YYYY-MM-DD` the write path validates.
        return `<input type="date"${kind} name="${name}" value="${current}" autocomplete="off">`;
      case 'dateTimeFieldType':
        return renderDateTimeControl(field, name, kind, current);
      case 'timeFieldType':
        // Without a step a time input defaults to 60 seconds and silently REFUSES
        // `12:34:56`, which is the value the contract requires. The step comes from
        // the declared precision -- `1` second, `0.001` millisecond -- so the
        // control admits the declared domain and nothing wider.
        return `<input type="time" step="${field.temporal.precision === 'millisecond' ? '0.001' : '1'}"${kind} name="${name}" value="${current}" autocomplete="off">`;
      case 'integerFieldType':
        return `<input type="number" inputmode="numeric" step="1"${kind} name="${name}" value="${current}" autocomplete="off">`;
      case 'exactDecimalFieldType':
      case 'moneyFieldType':
      case 'quantityFieldType':
        // `step="any"` rather than a scale-derived step: the manifest carries the
        // kind, not the scale, and a guessed step REJECTS values the field admits.
        return `<input type="number" inputmode="decimal" step="any"${kind} name="${name}" value="${current}" autocomplete="off">`;
      case 'textFieldType':
        return `<input type="text"${kind} name="${name}" value="${current}" autocomplete="off">`;
    }
  })();
  return {
    html,
    storedValueUnavailable,
  };
}

/**
 * Profile v1 has no typed surface metadata, but the selected operation still
 * declares the provider-facing field kind. The fallback is a one-line text
 * input, so it is faithful only when that carrier and the input contract agree
 * on the stored value's runtime type and the browser will not sanitize it.
 */
function bareControlPreservesValue(
  field: CompiledSurfaceInputField,
  value: unknown,
): boolean {
  return field.kind === 'booleanFieldType'
    ? typeof value === 'boolean'
    : oneLineInputPreservesValue(value);
}

/**
 * Whether the typed control's live IDL value can carry the stored value.
 *
 * This follows browser parsing, not provider admission. A value that the
 * provider no longer admits may still remain visible in a lossless text
 * carrier and will then refuse by name on submission; this classifier exists
 * for the sharper failure where the browser silently turns the stored value
 * into blank before the user touches it.
 */
function typedControlPreservesValue(
  field: CompiledSurfaceField,
  value: unknown,
): boolean {
  switch (field.kind) {
    case 'booleanFieldType':
      return typeof value === 'boolean';
    case 'enumFieldType':
      return (
        oneLineInputPreservesValue(value) &&
        (field.options.length > ENUM_SELECT_MAXIMUM_OPTIONS ||
          field.options.some((option) => option.optionId === value))
      );
    case 'dateFieldType':
      return typeof value === 'string' && nativeDateValue(value);
    case 'timeFieldType':
      return typeof value === 'string' && nativeTimeValue(value);
    case 'integerFieldType':
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return typeof value === 'string' && nativeNumberValue(value);
    case 'textFieldType':
    case 'dateTimeFieldType':
      return oneLineInputPreservesValue(value);
  }
}

function oneLineInputPreservesValue(value: unknown): value is string {
  return typeof value === 'string' && !/[\r\n]/u.test(value);
}

function nativeDateValue(value: string): boolean {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function nativeTimeValue(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/u.exec(value);
  return (
    match !== null &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    (match[3] === undefined || Number(match[3]) < 60)
  );
}

function nativeNumberValue(value: string): boolean {
  return (
    /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value) &&
    Number.isFinite(Number(value))
  );
}

function unavailableStoredValueId(index: number): string {
  return `surface-field-unavailable-${String(index)}`;
}

function renderUnavailableStoredValue(
  fieldId: string,
  index: number,
  inputField: CompiledSurfaceInputField | undefined,
  value: unknown,
): string {
  const encoded = escapeHtml(JSON.stringify(value) ?? String(value));
  const consequence =
    inputField && !inputField.required
      ? 'It will be left unchanged unless you choose a replacement or explicitly clear it.'
      : 'It will be left unchanged unless you enter a valid replacement.';
  return `<small id="${unavailableStoredValueId(index)}" class="form-unavailable-value" data-unavailable-value-for="${escapeHtml(fieldId)}"><strong>Stored value unavailable in this control:</strong> <code>${encoded}</code>. ${consequence}</small>`;
}

/**
 * No native control expresses a canonical date-time, so this refuses one by name
 * and keeps the carrier lossless.
 *
 * `datetime-local` is local time WITHOUT timezone information. A `utcInstant`
 * needs its trailing `Z` and an `offsetDateTime` needs a real `±HH:MM` the user
 * supplies; neither is expressible, and the control would additionally drop
 * seconds and milliseconds at its default 60-second step. Rendering it would
 * destroy the stored value on any edit -- silently, and before `U7` could
 * normalise anything.
 *
 * So the control is a text carrier, which round-trips the canonical string
 * exactly, and the refusal is DECLARED on the element: `data-refused-control`
 * names what was not offered and the declared domain says why. That is
 * ADR-0044's shape -- structural absence, declared and observable -- rather than
 * silent inability. It is deliberately not a message: `ux-grammar` closes
 * message placement over `page | slot` and reserves any field-level anchor for
 * `U7`, so inventing one here would coin the vocabulary that ADR forbids.
 */
function renderDateTimeControl(
  // Narrowed to the one branch that HAS a declared date-time domain. The wider
  // parameter compiled before the type discriminated on kind, and it is what let
  // the domain be optional here -- a control that could silently render without
  // the two facts it exists to declare.
  field: Extract<CompiledSurfaceField, { kind: 'dateTimeFieldType' }>,
  name: string,
  kind: string,
  current: string,
): string {
  const { precision, timezoneSemantics } = field.temporal;
  return `<input type="text"${kind} data-refused-control="datetime-local" data-timezone-semantics="${timezoneSemantics}" data-precision="${precision}" name="${name}" value="${current}" autocomplete="off">`;
}

/**
 * A boolean is a `select`, not a checkbox, and the reason is that a checkbox
 * cannot count to three.
 *
 * An optional boolean has three states -- `true`, `false`, and no value stated --
 * and a checkbox has two. The first cut of this rendered a checkbox beside a
 * hidden `value="false"`, which made `null`, absent and `false` render
 * identically AND post `"false"`, so editing an unrelated field on the same form
 * silently rewrote a stored `null` to `false`. That is information destroyed
 * upstream of normalisation, where `U7` cannot recover it.
 *
 * The blank option is the third state, and that is the whole of its job.
 *
 * It previously carried a second argument -- that an untouched field posts `""`
 * here exactly as a bare text box does, so old and new readers submit alike --
 * and the capability floor was said to depend on it. **That argument is
 * withdrawn.** Submission equivalence between readers is not a supported
 * invariant of this renderer and must not be relied on when changing a control
 * or allocating the next floor; surface-manifest version 3 is what keeps an
 * unaware reader away from a field-bearing manifest.
 *
 * The blank stays present even when the field is REQUIRED. A create form has no
 * value yet, and a two-option select would preselect `true` -- materializing a
 * default is the one thing this layer must never do. What `required` means for
 * submission is `U7`'s.
 */
function renderBooleanControl(
  name: string,
  kind: string,
  value: unknown,
): string {
  const option = (optionValue: string, label: string): string =>
    `<option value="${optionValue}"${value === (optionValue === 'true') && typeof value === 'boolean' ? ' selected' : ''}>${label}</option>`;
  return `<select${kind} name="${name}" autocomplete="off"><option value=""></option>${option('true', 'Yes')}${option('false', 'No')}</select>`;
}

function renderEnumControl(
  options: readonly CompiledFieldOption[],
  name: string,
  kind: string,
  index: number,
  value: unknown,
): string {
  if (options.length <= ENUM_SELECT_MAXIMUM_OPTIONS) {
    // The blank option is not decoration. Without it a select silently posts
    // its first option for a field the record never had a value for, which is
    // materializing a default at the one layer that is supposed to carry only
    // what was declared.
    const chosen = options.map(
      (option) =>
        `<option value="${escapeHtml(option.optionId)}"${option.optionId === value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    );
    return `<select${kind} name="${name}" autocomplete="off"><option value=""></option>${chosen.join('')}</select>`;
  }
  const listId = `surface-field-options-${String(index)}`;
  const suggestions = options.map(
    (option) =>
      `<option value="${escapeHtml(option.optionId)}">${escapeHtml(option.label)}</option>`,
  );
  return `<input${kind} name="${name}" value="${renderInputValue(value)}" list="${listId}" autocomplete="off"><datalist id="${listId}">${suggestions.join('')}</datalist>`;
}

function renderInputValue(value: unknown): string {
  return value === null || value === undefined
    ? ''
    : escapeHtml(typeof value === 'string' ? value : JSON.stringify(value));
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined)
    return '<span class="muted">—</span>';
  // ADR-0035 §6: numbers are right-aligned and tabular; text is left-aligned.
  // The alignment is CSS, but only the renderer knows the value is a number.
  if (typeof value === 'number')
    return `<span class="cell-numeric">${escapeHtml(String(value))}</span>`;
  return escapeHtml(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * The slot-local message card. `data-status-role` is derived from the catalog
 * entry's consequence rather than pinned to `blocked` here — ADR-0048 §3, and
 * the reason a required-input message no longer reads as a failure.
 */
function diagnostic(ref: SurfaceMessageRef): string {
  return `<section class="diagnostic" role="alert" ${messageAttributes(ref)}>
    <div class="diagnostic__mark" aria-hidden="true">!</div>
    <div>${messageBody(ref, 'Release diagnostic', 'h2')}</div>
  </section>`;
}
