import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import type { SemanticRecordDto } from '../../../packages/runtime/src/semantic-query-gateway.js';

import { escapeHtml, shortIdentity } from './html.js';
import type {
  CompiledSurfaceDefinition,
  CompiledSurfaceOperationBinding,
  CompiledSurfaceSlot,
} from './surface-contract.js';

export interface SurfaceComponentContext {
  readonly slot: CompiledSurfaceSlot;
  readonly surface: CompiledSurfaceDefinition;
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

type SurfaceComponentRenderer = (context: SurfaceComponentContext) => string;

const componentRegistry: Readonly<Record<string, SurfaceComponentRenderer>> =
  Object.freeze({
    'northstar.shell:component.error_probe': renderBoundaryProbe,
    'northstar.shell:component.release_summary': renderReleaseSummary,
    'northstar.shell:component.setup_checklist': renderSetupChecklist,
  });

export const REGISTERED_SURFACE_COMPONENT_IDS = Object.freeze(
  Object.keys(componentRegistry).sort(),
);

/** Closed lookup: there is deliberately no register/override escape hatch. */
export function renderRegisteredSurfaceComponent(
  context: SurfaceComponentContext,
): SurfaceComponentRenderResult {
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

/** Generic data component: its entire shape is compiled surface data + DTOs. */
export function renderSurfaceDataComponent({
  data,
  feedback,
  operations,
  surface,
}: SurfaceDataComponentContext): string {
  if (data.status === 'UNBOUND') return '';
  const feedbackHtml = feedback
    ? `<section class="operation-feedback" role="status" data-operation-intent="${feedback.intent}" data-trust-linked="${String(feedback.trustLinked)}"><strong>${escapeHtml(operationLabel(feedback.intent))} complete.</strong> The saved record is reflected below${feedback.trustLinked ? ' and its trust evidence is linked' : ''}.</section>`
    : '';
  if (data.status === 'DIAGNOSTIC') {
    return `${feedbackHtml}${dataDiagnostic(data.code)}`;
  }

  const records = data.status === 'READY' ? data.records : [];
  if (surface.surfaceRole === 'form') {
    return `${feedbackHtml}${renderFormSurface(surface, operations, records[0] ?? null)}`;
  }
  if (data.status === 'EMPTY') {
    return `${feedbackHtml}<section class="panel data-empty" data-data-state="empty"><p class="eyebrow">Live semantic data</p><h2>No records yet</h2><p class="lede">This view has no visible records for the current tenant, environment, and principal.</p></section>`;
  }
  if (surface.surfaceRole === 'record' || surface.archetype === 'record') {
    const record = records[0];
    return record
      ? `${feedbackHtml}${renderRecordSurface(surface, operations, record)}`
      : `${feedbackHtml}${dataDiagnostic('QUERY_NOT_FOUND')}`;
  }
  return `${feedbackHtml}${renderListSurface(surface, records)}`;
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

function renderListSurface(
  surface: CompiledSurfaceDefinition,
  records: readonly SemanticRecordDto[],
): string {
  if (records.length === 0) {
    return `<section class="panel data-empty" data-data-state="empty"><p class="eyebrow">Live semantic data</p><h2>No records yet</h2><p class="lede">This view has no visible records for the current tenant, environment, and principal.</p></section>`;
  }
  return `<section class="panel data-panel" data-data-state="exact"><div class="panel__heading"><div><p class="eyebrow">Live semantic data</p><h2>${escapeHtml(surface.label)}</h2></div><span class="status-pill">${records.length} visible</span></div><div class="data-table-wrap"><table><thead><tr><th scope="col">Record</th>${surface.fieldIds.map((fieldId) => `<th scope="col">${escapeHtml(fieldLabel(fieldId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${records.map((record) => `<tr data-record-id="${escapeHtml(record.recordId)}"><td><code>${escapeHtml(shortIdentity(record.recordId))}</code></td>${surface.fieldIds.map((fieldId) => `<td data-field-id="${escapeHtml(fieldId)}">${renderValue(record.values[fieldId])}</td>`).join('')}<td>${record.archived ? 'Archived' : 'Active'}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function renderRecordSurface(
  surface: CompiledSurfaceDefinition,
  operations: readonly CompiledSurfaceOperationBinding[],
  record: SemanticRecordDto,
): string {
  const archiveIntent = record.archived ? 'restore' : 'archive';
  const archive = operations.find(
    (binding) => binding.intent === archiveIntent,
  );
  return `<section class="panel data-panel" data-data-state="exact" data-record-id="${escapeHtml(record.recordId)}"><div class="panel__heading"><div><p class="eyebrow">Live semantic record</p><h2>${escapeHtml(surface.label)}</h2></div><span class="status-pill">${record.archived ? 'Archived' : 'Active'} · revision ${record.revision}</span></div><dl class="record-fields">${surface.fieldIds.map((fieldId) => `<div data-field-id="${escapeHtml(fieldId)}"><dt>${escapeHtml(fieldLabel(fieldId))}</dt><dd>${renderValue(record.values[fieldId])}</dd></div>`).join('')}</dl>${archive ? renderLifecycleForm(surface, record, archive) : ''}</section>`;
}

function renderFormSurface(
  surface: CompiledSurfaceDefinition,
  operations: readonly CompiledSurfaceOperationBinding[],
  record: SemanticRecordDto | null,
): string {
  const intent = record ? 'update' : 'create';
  const operation = operations.find((binding) => binding.intent === intent);
  if (!operation) return dataDiagnostic('QUERY_UNSUPPORTED');
  return `<section class="panel data-panel" data-data-state="${record ? 'exact' : 'empty'}"><div class="panel__heading"><div><p class="eyebrow">Semantic operation</p><h2>${record ? 'Update' : 'Create'} ${escapeHtml(surface.label)}</h2></div>${record ? `<span class="status-pill">Revision ${record.revision}</span>` : ''}</div><form method="post" action="/?surface=${encodeURIComponent(surface.surfaceId)}"><input type="hidden" name="intent" value="${intent}">${record ? `<input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}">` : ''}${operation.confirmation === 'humanRequired' ? '<input type="hidden" name="confirmed" value="yes">' : ''}<div class="form-fields">${surface.fieldIds.map((fieldId) => `<label><span>${escapeHtml(fieldLabel(fieldId))}</span><input name="value:${escapeHtml(fieldId)}" value="${record ? renderInputValue(record.values[fieldId]) : ''}" autocomplete="off"></label>`).join('')}</div><button type="submit">${record ? 'Save changes' : 'Create record'}</button></form></section>`;
}

function renderLifecycleForm(
  surface: CompiledSurfaceDefinition,
  record: SemanticRecordDto,
  operation: CompiledSurfaceOperationBinding,
): string {
  return `<form class="lifecycle-action" method="post" action="/?surface=${encodeURIComponent(surface.surfaceId)}"><input type="hidden" name="intent" value="${operation.intent}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}">${operation.confirmation === 'humanRequired' ? '<input type="hidden" name="confirmed" value="yes">' : ''}<button type="submit">${escapeHtml(operationLabel(operation.intent))}</button></form>`;
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
