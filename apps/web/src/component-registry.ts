import { randomUUID } from 'node:crypto';

import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import type {
  SemanticQueryResultEnvelope,
  SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

import { escapeHtml, shortIdentity } from './html.js';
import { sharedListView } from './list-runtime.js';
import { readCompiledSurfaceDataBinding } from './surface-contract.js';
import type {
  CompiledSurfaceDefinition,
  CompiledSurfaceOperationBinding,
  CompiledSurfaceSlot,
} from './surface-contract.js';

export interface SurfaceComponentContext {
  readonly data?: SurfaceDataRenderState;
  readonly feedback?: SurfaceOperationFeedback | null;
  readonly operations?: readonly CompiledSurfaceOperationBinding[];
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
      readonly records: readonly SemanticRecordDto[];
      readonly result?: SemanticQueryResultEnvelope;
      readonly status: 'READY';
    }
  | { readonly status: 'EMPTY' }
  | {
      readonly code:
        | 'QUERY_AMBIGUOUS'
        | 'QUERY_NOT_FOUND'
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

const componentRegistry: Readonly<Record<string, SurfaceComponentRenderer>> =
  Object.freeze({
    'northstar.shell:component.error_probe': renderBoundaryProbe,
    'northstar.shell:component.release_summary': renderReleaseSummary,
    'northstar.shell:component.setup_checklist': renderSetupChecklist,
  });

const surfaceSlotRegistry: Readonly<Record<string, SurfaceComponentRenderer>> =
  Object.freeze({
    'list:dataGrid': renderDataGrid,
    'list:title': renderListTitle,
    'record:breadcrumb': renderBreadcrumb,
    'record:commandBar': renderCommandBar,
    'record:keyFacts': renderKeyFacts,
    'record:sections': renderSections,
    'record:titleStatus': renderTitleStatus,
  });

export const REGISTERED_SURFACE_COMPONENT_IDS = Object.freeze(
  Object.keys(componentRegistry).sort(),
);

/** Closed lookup: there is deliberately no register/override escape hatch. */
export function renderRegisteredSurfaceComponent(
  context: SurfaceComponentContext,
): SurfaceComponentRenderResult {
  const slotKey = `${context.surface.archetype}:${context.slot.slot}`;
  const slotRenderer = Object.hasOwn(surfaceSlotRegistry, slotKey)
    ? surfaceSlotRegistry[slotKey]
    : undefined;
  if (slotRenderer) return renderComponent(slotRenderer, context);

  const renderer = Object.hasOwn(
    componentRegistry,
    context.slot.contentReferenceId,
  )
    ? componentRegistry[context.slot.contentReferenceId]
    : undefined;
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
  return slotPanel(
    context,
    `<header class="surface-heading surface-heading--slot"><div><p class="eyebrow">List · compiled workspace</p><h1>${escapeHtml(context.surface.label)}</h1></div><div class="surface-heading__actions">${declaredStatusRoles(context.surface)}${form ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form))}">New</a>` : ''}</div></header>`,
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
        );
  return slotPanel(
    context,
    `${feedbackHtml(context.feedback)}${html}`,
    'data-grid-slot',
  );
}

function renderBreadcrumb(context: SurfaceComponentContext): string {
  const list = relatedSurface(context, 'list');
  const label = entityLabel(context.surface);
  return slotPanel(
    context,
    `<nav class="record-breadcrumb" aria-label="Breadcrumb">${list ? `<a href="${escapeHtml(surfaceHref(list))}">${escapeHtml(list.label)}</a><span aria-hidden="true">/</span>` : ''}<span aria-current="page">${escapeHtml(label)}</span></nav>`,
    'breadcrumb-slot',
  );
}

function renderTitleStatus(context: SurfaceComponentContext): string {
  const record = recordFrom(context.data);
  const form = context.surface.surfaceRole === 'form';
  const title = form
    ? `${record ? 'Edit' : 'New'} ${entityLabel(context.surface)}`
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

function renderCommandBar(context: SurfaceComponentContext): string {
  const record = recordFrom(context.data);
  if (context.surface.surfaceRole === 'form') {
    return slotPanel(
      context,
      `<div class="command-bar" aria-label="Record commands"><button type="submit" form="surface-record-form">Save</button></div>`,
      'command-bar-slot',
    );
  }

  const form = relatedSurface(context, 'form');
  const actions = [
    record && form
      ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form, record.recordId))}">Edit</a>`
      : '',
    form
      ? `<a class="secondary-action" href="${escapeHtml(surfaceHref(form))}">New</a>`
      : '',
    record ? renderLifecycleForm(context, record) : '',
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
  const compatibilityStatus =
    record && !hasSurfaceSlot(context, 'titleStatus')
      ? `<span class="status-pill" data-status-role="${record.archived ? 'attention' : 'success'}">${record.archived ? 'Archived' : 'Active'} · revision ${record.revision}</span>`
      : '';
  return slotPanel(
    context,
    record
      ? `<section class="panel data-panel" data-data-state="exact" data-record-id="${escapeHtml(record.recordId)}"><div class="panel__heading"><div><p class="eyebrow">Key facts</p><h2>${escapeHtml(entityLabel(context.surface))}</h2></div>${compatibilityStatus}</div><dl class="record-fields">${context.surface.fieldIds.map((fieldId) => `<div data-field-id="${escapeHtml(fieldId)}"><dt>${escapeHtml(fieldLabel(fieldId))}</dt><dd>${renderValue(record.values[fieldId])}</dd></div>`).join('')}</dl></section>`
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
  const intent = record ? 'update' : 'create';
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
  return slotPanel(
    context,
    `${compatibilityFeedback}<section class="panel data-panel" data-data-state="${record ? 'exact' : 'empty'}"><div class="panel__heading"><div><p class="eyebrow">Details</p><h2>${record ? 'Update the record' : 'Create a record'}</h2></div></div><form id="surface-record-form" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}"><input type="hidden" name="intent" value="${intent}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(recordId)}">${record ? `<input type="hidden" name="expectedRevision" value="${record.revision}">` : ''}<div class="form-fields">${context.surface.fieldIds.map((fieldId) => `<label><span>${escapeHtml(fieldLabel(fieldId))}</span><input name="value:${escapeHtml(fieldId)}" value="${record ? renderInputValue(record.values[fieldId]) : ''}" autocomplete="off"></label>`).join('')}</div></form></section>`,
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
): string {
  if (result?.listCoverage) {
    return renderSharedListSurface(surface, result, detail);
  }
  if (records.length === 0) {
    return emptyDataPanel();
  }
  return `<section class="panel data-panel" data-data-state="exact"><div class="panel__heading"><div><p class="eyebrow">Records</p><h2>${escapeHtml(surface.label)}</h2></div><span class="status-pill">${records.length} visible</span></div><div class="data-table-wrap"><table><thead><tr><th scope="col">Record</th>${surface.fieldIds.map((fieldId) => `<th scope="col">${escapeHtml(fieldLabel(fieldId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${records.map((record) => `<tr data-record-id="${escapeHtml(record.recordId)}"><td>${detail ? `<a class="record-link" href="${escapeHtml(surfaceHref(detail, record.recordId))}" aria-label="Open ${escapeHtml(entityLabel(surface))} ${escapeHtml(shortIdentity(record.recordId))}"><code>${escapeHtml(shortIdentity(record.recordId))}</code></a>` : `<code>${escapeHtml(shortIdentity(record.recordId))}</code>`}</td>${surface.fieldIds.map((fieldId) => `<td data-field-id="${escapeHtml(fieldId)}">${renderValue(record.values[fieldId])}</td>`).join('')}<td>${record.archived ? 'Archived' : 'Active'}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function renderSharedListSurface(
  surface: CompiledSurfaceDefinition,
  result: SemanticQueryResultEnvelope,
  detail?: CompiledSurfaceDefinition,
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
  const body =
    view.rows.length === 0
      ? `<div class="data-empty" data-data-state="empty" data-list-zero-input="true"><h3>No records yet</h3><p>This search has zero visible records for the current tenant, environment, and principal.</p></div>`
      : `<div class="data-table-wrap"><table><thead><tr><th scope="col">Record</th>${columns.map((column) => `<th scope="col">${escapeHtml(fieldLabel(column.columnId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${view.rows.map((row) => `<tr data-record-id="${escapeHtml(row.record.recordId)}"><td>${detail ? `<a class="record-link" href="${escapeHtml(surfaceHref(detail, row.record.recordId))}" aria-label="Open ${escapeHtml(entityLabel(surface))} ${escapeHtml(shortIdentity(row.record.recordId))}"><code>${escapeHtml(shortIdentity(row.record.recordId))}</code></a>` : `<code>${escapeHtml(shortIdentity(row.record.recordId))}</code>`}</td>${columns.map((column) => `<td ${column.kind === 'relation' ? 'data-relation-id' : 'data-field-id'}="${escapeHtml(column.columnId)}">${renderValue(row.cells[column.columnId])}</td>`).join('')}<td><span class="status-pill" data-status-role="${row.archived ? 'attention' : 'success'}">${row.archived ? 'Archived' : 'Active'}</span></td></tr>`).join('')}</tbody></table></div>`;
  const next = view.listCoverage.nextCursor
    ? `<a class="list-page-link" href="${escapeHtml(nextPageHref(surface, view.listCoverage.nextCursor, view.listCoverage.search, view.listCoverage.includeArchived))}">Next page</a>`
    : '';
  return `<section class="panel data-panel" data-data-state="exact" data-list-result="${escapeHtml(view.listCoverage.schemaVersion)}"><div class="panel__heading"><div><p class="eyebrow">Records</p><h2>${escapeHtml(surface.label)}</h2></div><span class="status-pill" data-status-role="${coverageRole}" data-list-coverage="${escapeHtml(coverage)}">${escapeHtml(coverage)} visible</span></div>${body}<nav class="list-pagination" aria-label="List pages">${next}</nav></section>`;
}

function nextPageHref(
  surface: CompiledSurfaceDefinition,
  cursor: string,
  search: string,
  includeArchived: boolean,
): string {
  const parameters = new URLSearchParams({
    cursor,
    surface: surface.surfaceId,
  });
  if (search.length > 0) parameters.set('q', search);
  if (includeArchived) parameters.set('archived', 'yes');
  return `/?${parameters.toString()}`;
}

function renderLifecycleForm(
  context: SurfaceComponentContext,
  record: SemanticRecordDto,
): string {
  const intent = record.archived ? 'restore' : 'archive';
  const operation = (context.operations ?? []).find(
    (binding) => binding.intent === intent,
  );
  return operation
    ? `<form class="lifecycle-action" method="post" action="/?surface=${encodeURIComponent(context.surface.surfaceId)}"><input type="hidden" name="intent" value="${operation.intent}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}"><button class="secondary-action" type="submit">${escapeHtml(operationLabel(operation.intent))}</button></form>`
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
    QUERY_NOT_FOUND: [
      'Record not found',
      'No visible record matched this request in the pinned release.',
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
  try {
    const entityId = readCompiledSurfaceDataBinding(
      context.view,
      context.surface,
    ).query.sourceEntityId;
    return context.surfaces?.find((candidate) => {
      if (candidate.lifecycle !== 'active' || candidate.surfaceRole !== role) {
        return false;
      }
      try {
        return (
          readCompiledSurfaceDataBinding(context.view, candidate).query
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

function surfaceHref(
  surface: CompiledSurfaceDefinition,
  recordId?: string,
): string {
  const parameters = new URLSearchParams({ surface: surface.surfaceId });
  if (recordId) parameters.set('record', recordId);
  return `/?${parameters.toString()}`;
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
