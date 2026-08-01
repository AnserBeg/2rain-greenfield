import { randomUUID } from 'node:crypto';

import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  registeredSemanticQueryFromPinnedView,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

import { escapeHtml, shortIdentity } from './html.js';
import { sharedListView } from './list-runtime.js';
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

export type SurfaceComponentRenderResult =
  | { readonly html: string; readonly status: 'RENDERED' }
  | {
      readonly code: 'COMPONENT_RENDER_FAILED' | 'UNSUPPORTED_COMPONENT';
      readonly html: string;
      readonly status: 'DIAGNOSTIC';
    };

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
      readonly code:
        | 'QUERY_AMBIGUOUS'
        | 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED'
        | 'QUERY_NOT_FOUND'
        | 'QUERY_PARAMETER_REQUIRED'
        | 'QUERY_PERMISSION_DENIED'
        | 'QUERY_UNAVAILABLE'
        | 'QUERY_UNSUPPORTED';
      readonly status: 'DIAGNOSTIC';
    };

export interface SurfaceOperationFeedback {
  readonly intent: 'archive' | 'create' | 'restore' | 'update';
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
  readonly mutationIntents?: Partial<
    Readonly<Record<MutationSurfaceRole, readonly SurfaceOperationIntent[]>>
  >;
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
    'list:bulkActions': { renderer: renderBulkActions },
    'list:dataGrid': { renderer: renderDataGrid },
    'list:title': { renderer: renderListTitle },
    'record:breadcrumb': { renderer: renderBreadcrumb },
    'record:commandBar': {
      mutationIntents: { record: ['archive', 'restore'] },
      renderer: renderCommandBar,
    },
    'record:keyFacts': {
      mutationIntents: { record: ['archive', 'restore'] },
      renderer: renderKeyFacts,
    },
    'record:sections': {
      mutationIntents: { form: ['create', 'update'] },
      renderer: renderSections,
    },
    'record:titleStatus': { renderer: renderTitleStatus },
    'task:decision': { renderer: renderTaskDecision },
    'task:primaryAction': { renderer: renderTaskPrimaryAction },
    'task:scanInput': { renderer: renderTaskScanInput },
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
      html: diagnostic(
        'Unsupported release capability',
        `This runtime does not register ${context.slot.contentReferenceId}.`,
        'UNSUPPORTED_COMPONENT',
      ),
      status: 'DIAGNOSTIC' as const,
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
    return Object.freeze({
      html: renderer(context),
      status: 'RENDERED' as const,
    });
  } catch {
    return Object.freeze({
      code: 'COMPONENT_RENDER_FAILED' as const,
      html: diagnostic(
        'Component unavailable',
        'The release-defined component could not be rendered. The rest of the pinned surface is unchanged.',
        'COMPONENT_RENDER_FAILED',
      ),
      status: 'DIAGNOSTIC' as const,
    });
  }
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
  const legalEntityId = context.legalEntitySelection?.[0];
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
        : `<span class="status-pill" data-status-role="inProgress">${form ? 'Draft' : 'Loading'}</span>`;
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
  const actions = [
    record && form
      ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form, record.recordId, false, context))}">Edit</a>`
      : '',
    form
      ? `<a class="secondary-action" href="${escapeHtml(surfaceHref(form, undefined, false, context))}">New</a>`
      : '',
    record ? renderLifecycleOverflow(context, record) : '',
  ].join('');
  return slotPanel(
    context,
    `<div class="command-bar" aria-label="Record commands">${actions}</div>`,
    'command-bar-slot',
  );
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
    `${compatibilityFeedback}<section class="panel data-panel" data-data-state="${record ? 'exact' : 'empty'}"><div class="panel__heading"><div><p class="eyebrow">Details</p><h2>${record ? 'Update the record' : 'Create a record'}</h2></div></div><form id="surface-record-form" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}"><input type="hidden" name="intent" value="${intent}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(recordId)}">${record ? `<input type="hidden" name="expectedRevision" value="${record.revision}">` : ''}<div class="form-fields">${context.surface.fieldIds.map((fieldId) => `<label><span>${escapeHtml(fieldLabel(fieldId))}</span><input name="value:${escapeHtml(fieldId)}" value="${record ? renderInputValue(record.values[fieldId]) : ''}" autocomplete="off"></label>`).join('')}</div>${compatibilityCommand}</form></section>`,
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
  return `<section class="panel panel--hero" data-component="northstar.shell:component.release_summary">
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
  return `<section class="panel" data-component="northstar.shell:component.setup_checklist">
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
    ? `<form class="lifecycle-action" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}"><input type="hidden" name="intent" value="${operation.intent}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}"><button class="secondary-action" type="submit">${escapeHtml(operationLabel(operation.intent))}</button></form>`
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
  code: Exclude<
    Extract<SurfaceDataRenderState, { status: 'DIAGNOSTIC' }>['code'],
    never
  >,
): string {
  const copy = {
    QUERY_AMBIGUOUS: [
      'More than one record matched',
      'Refine the semantic query before choosing a record.',
    ],
    QUERY_LEGAL_ENTITY_SCOPE_REQUIRED: [
      'Legal entity required',
      'Choose a legal entity before loading this scoped data.',
    ],
    QUERY_NOT_FOUND: [
      'Record not found',
      'No visible record matched this request in the pinned release.',
    ],
    QUERY_PARAMETER_REQUIRED: [
      'Lookup parameters required',
      'Complete every lookup input before asking for a result.',
    ],
    QUERY_PERMISSION_DENIED: [
      'Access denied',
      'Current policy does not allow this data to be shown.',
    ],
    QUERY_UNAVAILABLE: [
      'Data unavailable',
      'Live data could not be loaded safely. Try the request again.',
    ],
    QUERY_UNSUPPORTED: [
      'Capability unavailable',
      'The pinned release does not provide this semantic data capability.',
    ],
  } as const;
  const [title, message] = copy[code];
  return diagnostic(title, message, code);
}

function fieldLabel(fieldId: string): string {
  const local = fieldId.slice(fieldId.lastIndexOf('.') + 1);
  return local
    .split('_')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function operationLabel(intent: SurfaceOperationFeedback['intent']): string {
  return intent.slice(0, 1).toUpperCase() + intent.slice(1);
}

function slotPanel(
  context: SurfaceComponentContext,
  html: string,
  className: string,
): string {
  return `<div class="surface-slot ${className}" data-component="${escapeHtml(context.slot.contentReferenceId)}" data-platform-slot="${escapeHtml(`${context.surface.archetype}:${context.slot.slot}`)}">${html}</div>`;
}

function feedbackHtml(
  feedback: SurfaceOperationFeedback | null | undefined,
): string {
  return feedback
    ? `<section class="operation-feedback" role="status" data-operation-intent="${feedback.intent}" data-trust-linked="${String(feedback.trustLinked)}"><strong>${escapeHtml(operationLabel(feedback.intent))} complete.</strong> The saved record is reflected below${feedback.trustLinked ? ' and its trust evidence is linked' : ''}.</section>`
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
  return escapeHtml(typeof value === 'string' ? value : JSON.stringify(value));
}

function diagnostic(title: string, message: string, code: string): string {
  return `<section class="diagnostic" role="alert" data-diagnostic-code="${escapeHtml(code)}">
    <div class="diagnostic__mark" aria-hidden="true">!</div>
    <div><p class="eyebrow">Release diagnostic</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><code>${escapeHtml(code)}</code></div>
  </section>`;
}
