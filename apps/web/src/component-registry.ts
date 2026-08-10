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
  CompiledSurfaceDefinition,
  CompiledSurfaceOperationBinding,
  CompiledSurfaceSlot,
  SurfaceOperationIntent,
} from './surface-contract.js';

export interface SurfaceComponentContext {
  readonly data?: SurfaceDataRenderState;
  readonly feedback?: SurfaceOperationFeedback | null;
  readonly legalEntitySelection?: readonly string[];
  readonly operations?: readonly CompiledSurfaceOperationBinding[];
  readonly queryParameterValues?: Readonly<Record<string, string>>;
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
    const intent = record ? 'update' : 'create';
    return slotPanel(
      context,
      surfaceSupportsRuntimeIntent(
        context.view,
        context.surface,
        context.surfaces ?? [],
        intent,
      )
        ? `<div class="command-bar" aria-label="Record commands"><button type="submit" form="surface-record-form">Save</button></div>`
        : '',
      'command-bar-slot',
    );
  }

  const form = relatedSurface(context, 'form');
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
    record && form
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
  const intent = record ? 'update' : 'create';
  if (
    !surfaceSupportsRuntimeIntent(
      context.view,
      context.surface,
      context.surfaces ?? [],
      intent,
    )
  ) {
    return slotPanel(context, '', 'sections-slot');
  }
  const operation = (context.operations ?? []).find(
    (binding) => binding.intent === intent,
  );
  if (!operation) {
    return slotPanel(
      context,
      dataDiagnostic('QUERY_UNSUPPORTED'),
      'sections-slot',
    );
  }
  const recordId = record?.recordId ?? randomUUID();
  const compatibilityFeedback = hasSurfaceSlot(context, 'titleStatus')
    ? ''
    : feedbackHtml(context.feedback);
  const compatibilityCommand = hasSurfaceSlot(context, 'commandBar')
    ? ''
    : '<button type="submit">Save</button>';
  return slotPanel(
    context,
    `${compatibilityFeedback}<section class="panel data-panel" data-data-state="${record ? 'exact' : 'empty'}"><div class="panel__heading"><div><p class="eyebrow">Details</p><h2>${record ? 'Update the record' : 'Create a record'}</h2></div></div><form id="surface-record-form" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(recordId)}">${record ? `<input type="hidden" name="expectedRevision" value="${record.revision}">` : ''}<div class="form-fields">${context.surface.fieldIds.map((fieldId) => `<label><span>${escapeHtml(fieldLabel(fieldId))}</span><input name="value:${escapeHtml(fieldId)}" value="${record ? renderInputValue(record.values[fieldId]) : ''}" autocomplete="off"></label>`).join('')}</div>${compatibilityCommand}</form></section>`,
    'sections-slot',
  );
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
