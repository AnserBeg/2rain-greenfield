import {
  renderCompositionFields,
  renderCompositionActions,
  renderCompositionChildren,
  renderCompositionHeader,
  displayFieldValue,
  type CompositionData,
} from './surface-composition.js';
import { randomUUID } from 'node:crypto';

import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import { evaluateRegisteredOperationPrecondition } from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  registeredSemanticQueryFromPinnedView,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  encodeSharedListCursor,
  SHARED_LIST_QUERY_VERSION,
} from '../../../packages/runtime/src/list-behavior/index.js';

import { escapeHtml, shortIdentity } from './html.js';
import {
  renderReceivingSection,
  renderReceivingNavigation,
  type ReceivingNavigation,
  type ReceivingSection,
} from './receiving-section.js';
import type {
  SalesOrderSection,
  ShipmentPackingDocument,
} from './sales-section.js';
import { sharedListView } from './list-runtime.js';
import {
  declaredCellText,
  declaredListParameters,
  declaredRowAction,
  orderedColumns,
  orderedFilters,
  orderedViews,
  overdueDays,
  startOfTodayUtc,
  type DeclaredListColumn,
  type DeclaredListRowAction,
  type DeclaredListState,
  type FieldPresenter,
} from './list-declaration.js';
import type { SurfaceList } from '../../../packages/canonical-model/src/index.js';
import type { SharedListCoverage } from '../../../packages/runtime/src/list-behavior/index.js';
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

/**
 * Server counts per saved view, the request's declared List state, and the
 * instant the request's "before today" views were counted at.
 */
export interface DeclaredListRenderData {
  readonly counts: Readonly<Record<string, number>>;
  readonly now: Date;
  /**
   * The progress query current policy withheld from a List whose figures are
   * supplementary: they read "—", and a view that keeps open rows refuses.
   */
  readonly progressWithheld?: string;
  readonly state: DeclaredListState;
}

export type SurfaceDataRenderState =
  | { readonly status: 'UNBOUND' }
  | {
      readonly aggregate: SemanticAggregateResultEnvelope;
      readonly status: 'AGGREGATE_READY';
    }
  | {
      readonly records: readonly SemanticRecordDto[];
      readonly documentEditorSlots?: Readonly<Record<string, string>>;
      readonly receiving?: ReceivingSection;
      readonly receivingNavigation?: ReceivingNavigation;
      readonly composition?: CompositionData;
      readonly compositionTask?: string;
      readonly salesOrder?: SalesOrderSection;
      readonly packingDocument?: ShipmentPackingDocument;
      readonly result?: SemanticQueryResultEnvelope;
      readonly declaredList?: DeclaredListRenderData;
      readonly status: 'READY';
    }
  | { readonly status: 'EMPTY' }
  | {
      // One authority: the read path's diagnostic subset is declared in the
      // catalog, so the render state cannot admit a code the catalog does not
      // register, and the gateway-error mapping targets the same set.
      readonly code: QueryDiagnosticCode;
      /** A refused List view: the List's other views still serve. */
      readonly declaredList?: DeclaredListRenderData;
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
    'list:savedViews': {
      className: 'saved-views-slot',
      renderer: renderSavedViews,
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
    'record:childTables': {
      className: 'child-tables-slot',
      ownsDataResolution: true,
      renderer: (context) =>
        context.data?.status === 'READY' && context.data.composition
          ? context.data.compositionTask &&
            !context.surface.composition?.presentation?.task
            ? context.data.compositionTask
            : (context.data.compositionTask ?? '') +
              renderCompositionChildren(
                context.data.composition,
                context.surface,
                context.view,
              )
          : '',
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

/** One registry-resolution authority backs visible slot diagnostics. */
export function surfaceHasUnsupportedComponent(
  surface: CompiledSurfaceDefinition,
): boolean {
  return surface.slots.some(
    (slot) => surfaceComponentRenderer(surface, slot) === undefined,
  );
}

/**
 * The registry entries that render mutation controls also authorize their
 * submissions. An unsupported non-mutation slot fails visibly in its own
 * position but cannot veto a registered mutation control elsewhere on the
 * surface. Record lifecycle controls additionally require a writable form for
 * the same entity, so a visibly inert entity cannot be mutated by posting
 * around its release-defined UI.
 */
export function surfaceSupportsRuntimeIntent(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  intent: SurfaceOperationIntent,
): boolean {
  if (
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
  if (
    context.surface.documentEditor &&
    context.data?.status === 'READY' &&
    context.data.documentEditorSlots &&
    context.slot.slot !== 'breadcrumb'
  ) {
    return {
      state: 'ready',
      html: resolvedSlot(
        context,
        context.data.documentEditorSlots[context.slot.slot] ?? '',
        'ready',
      ),
    };
  }
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
  if (
    surface.archetype === 'record' &&
    slot.slot === 'childTables' &&
    !surface.composition
  )
    return Object.hasOwn(componentRegistry, slot.contentReferenceId)
      ? componentRegistry[slot.contentReferenceId]
      : undefined;
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
    `<header class="surface-heading surface-heading--slot"><div><h1>${escapeHtml(entityLabel(context.surface))}</h1></div><div class="surface-heading__actions">${declaredStatusRoles(context.surface)}${archiveToggle}${form ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form, undefined, false, context))}">New</a>` : ''}</div></header>`,
    'surface-title-slot',
  );
}

function declaredListBase(context: SurfaceComponentContext): URLSearchParams {
  const parameters = new URLSearchParams({
    surface: context.surface.surfaceId,
  });
  appendLegalEntitySelection(parameters, context.surface, context);
  return parameters;
}

function renderSavedViews(context: SurfaceComponentContext): string {
  const list = context.surface.list;
  // A refused view keeps its tabs: the List's other views still serve.
  const declared =
    context.data?.status === 'READY' || context.data?.status === 'DIAGNOSTIC'
      ? context.data.declaredList
      : undefined;
  return slotPanel(
    context,
    list && declared
      ? renderDeclaredListViews(
          list,
          declared.state,
          declaredListBase(context),
          declared.counts,
        )
      : '',
    'saved-views-slot',
  );
}

function renderDataGrid(context: SurfaceComponentContext): string {
  const data = context.data ?? { status: 'UNBOUND' as const };
  if (data.status === 'UNBOUND') {
    return slotPanel(context, '', 'data-grid-slot');
  }
  if (
    data.status === 'READY' &&
    context.surface.list &&
    data.declaredList &&
    data.result?.listCoverage
  ) {
    const detail = relatedSurface(context, 'record');
    const recordLabel = entityLabel(context.surface);
    const formId = bulkSelectionFormId(context.surface);
    const binding = readCompiledSurfaceDataBinding(
      context.view,
      context.surface,
    );
    const detailHref = (record: SemanticRecordDto) =>
      detail
        ? surfaceHref(detail, record.recordId, record.archived, context)
        : null;
    return slotPanel(
      context,
      `${feedbackHtml(context.feedback)}${renderDeclaredList({
        base: declaredListBase(context),
        coverage: data.result.listCoverage,
        detailHref,
        exportLimit:
          'exportMaximumResultCount' in binding.query
            ? (binding.query.exportMaximumResultCount ?? null)
            : null,
        list: context.surface.list,
        now: data.declaredList.now,
        present: (record, fieldId, value) =>
          displayFieldValue(context.view, record, fieldId, value),
        progressWithheld: data.declaredList.progressWithheld ?? null,
        recordLabel,
        records: data.records,
        // The row's record page, at the section its action names -- only a
        // section the page's composition declares (the validator refuses any
        // other), so a link never promises a place the page does not have.
        rowActionHref: (record, action) => {
          const href = detailHref(record);
          if (href === null || action.section === undefined) return href;
          return detail?.composition?.children.some(
            (child) => child.datasetId === action.section,
          )
            ? `${href}#${action.section}`
            : null;
        },
        selectionCell: hasNamedSlot(context.surface, 'bulkActions')
          ? (record, title) => selectionCell(formId, record, recordLabel, title)
          : null,
        state: data.declaredList.state,
      })}`,
      'data-grid-slot',
    );
  }
  if (data.status === 'DIAGNOSTIC') {
    // A view refused for its withheld figures says which figures it needs.
    const withheld =
      context.surface.list && data.declaredList?.progressWithheld
        ? progressWithheldNote(
            context.surface.list,
            data.declaredList.progressWithheld,
          )
        : '';
    return slotPanel(
      context,
      `${feedbackHtml(context.feedback)}${withheld}${dataDiagnostic(data.code)}`,
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
    `<form class="bulk-bar" id="${escapeHtml(formId)}" data-bulk-selection-form><div><strong class="bulk-empty">Select records to begin</strong><strong class="bulk-ready">Selection ready</strong><p>Choose one or more records to see the available actions.</p></div><button class="secondary-action bulk-ready" type="reset">Clear selection</button></form>`,
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
  if (
    context.data?.status === 'READY' &&
    context.data.composition &&
    context.surface.composition?.presentation
  )
    return slotPanel(
      context,
      renderCompositionHeader(context.surface, context.data.composition) +
        feedbackHtml(context.feedback),
      'title-status-slot',
    );
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
    `<header class="surface-heading surface-heading--slot"><div><h1>${escapeHtml(title)}</h1></div>${status}</header>${feedbackHtml(context.feedback)}`,
    'title-status-slot',
  );
}

function renderArchiveToggle(context: SurfaceComponentContext): string {
  const coverage =
    context.data?.status === 'READY'
      ? context.data.result?.listCoverage
      : undefined;
  const includeArchived = coverage?.includeArchived ?? false;
  const declared =
    context.data?.status === 'READY' ? context.data.declaredList : undefined;
  if (declared) {
    const href = `/?${declaredListParameters(declared.state, declaredListBase(context), { includeArchived: !includeArchived, page: 1 }).toString()}`;
    return `<a class="secondary-action" data-archive-view="${includeArchived ? 'shown' : 'hidden'}" href="${escapeHtml(href)}">${includeArchived ? 'Hide archived' : 'Show archived'}</a>`;
  }
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
  return listRecordTitle(context.surface, record, context);
}

function listRecordTitle(
  surface: CompiledSurfaceDefinition,
  record: SemanticRecordDto,
  linkContext?: Pick<SurfaceComponentContext, 'view'>,
): string {
  const displayFieldId = linkContext
    ? readCompiledSurfaceDataBinding(linkContext.view, surface).displayFieldId
    : undefined;
  const displayValue = displayFieldId
    ? (record.displayValues?.[displayFieldId] ?? record.values[displayFieldId])
    : Object.values(record.displayValues ?? {}).find(
        (value) => typeof value === 'string' && value.trim().length > 0,
      );
  return typeof displayValue === 'string' && displayValue.trim().length > 0
    ? displayValue
    : shortIdentity(record.recordId);
}

function renderCommandBar(context: SurfaceComponentContext): string {
  if (context.data?.status === 'READY' && context.data.compositionTask)
    return slotPanel(context, '', 'command-bar-slot');
  const compositionActions =
    context.data?.status === 'READY' && context.data.composition
      ? renderCompositionActions(
          context.surface,
          context.data.composition,
          context.view,
        )
      : '';
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
  const orderedCommands = [...commands].sort(commandPresentationOrder);
  const editor = context.surface.documentEditor;
  const documentEditable =
    !editor ||
    (record &&
      editor.editableStateIds.some(
        (state) => record.values[editor.stateFieldId] === state,
      ));
  const actions = [
    record &&
    form &&
    update &&
    documentEditable &&
    operationAvailableForRecord(update, record)
      ? `<a class="primary-action" href="${escapeHtml(surfaceHref(form, record.recordId, false, context))}">Edit</a>`
      : '',
    form
      ? `<a class="secondary-action" href="${escapeHtml(surfaceHref(form, undefined, false, context))}">New</a>`
      : '',
    record
      ? orderedCommands
          .map((command) => renderCapabilityCommand(context, record, command))
          .join('')
      : '',
    record ? renderLifecycleOverflow(context, record) : '',
  ].join('');
  return slotPanel(
    context,
    `${compositionActions}${context.surface.composition?.presentation?.recordActions === 'progressive' ? `<details class="composition-record-actions"><summary>Record actions</summary><div class="command-bar" aria-label="Record commands">${actions}</div></details>` : `<div class="command-bar" aria-label="Record commands">${actions}</div>`}`,
    'command-bar-slot',
  );
}

/**
 * The current document workflow has one settled primary/secondary pair but no
 * authored command-order carrier: Release advances the document and Cancel is
 * the alternative. Keep every other command in the binding's deterministic
 * order rather than inventing meaning for unknown verbs.
 */
function commandPresentationOrder(
  left: CompiledSurfaceOperationBinding,
  right: CompiledSurfaceOperationBinding,
): number {
  return commandPresentationRank(left) - commandPresentationRank(right);
}

function commandPresentationRank(
  operation: CompiledSurfaceOperationBinding,
): number {
  const verb = operation.operationId.slice(
    operation.operationId.lastIndexOf('_') + 1,
  );
  if (verb === 'release') return 0;
  if (verb === 'cancel') return 2;
  return 1;
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
  return `<form class="capability-command" method="post" action="${escapeHtml(surfaceHref(context.surface, record.recordId, record.archived, context))}" data-capability-id="${escapeHtml(operation.capabilityId ?? '')}" data-operation-id="${escapeHtml(operation.operationId)}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}">${explanation}<button type="submit">${escapeHtml(operation.label)}</button></form>`;
}

function renderKeyFacts(context: SurfaceComponentContext): string {
  if (
    context.surface.composition?.presentation?.technicalDetails ===
    'progressive'
  ) {
    const record = recordFrom(context.data);
    return slotPanel(
      context,
      record
        ? `<details class="panel composition-technical"><summary>Technical details · record identity, activity and revision</summary><dl class="record-fields"><div><dt>Record</dt><dd>${escapeHtml(record.recordId)}</dd></div><div><dt>Activity</dt><dd>${record.archived ? 'Archived' : 'Active'}</dd></div><div><dt>Revision</dt><dd>${record.revision}</dd></div></dl></details>`
        : '',
      'key-facts-slot',
    );
  }

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
      `<section class="panel key-facts-panel" data-data-state="empty"><div class="panel__heading"><div><h2>New ${escapeHtml(entityLabel(context.surface))}</h2></div></div><dl class="key-fact-grid"><div><dt>Mode</dt><dd>New record</dd></div><div><dt>Fields</dt><dd>${String(context.surface.fieldIds.length)} ready</dd></div><div><dt>State</dt><dd><span class="status-pill" data-status-role="inProgress">Draft</span></dd></div></dl></section>`,
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
      ? `${compatibilityFeedback}<section class="panel key-facts-panel" data-data-state="exact" data-record-id="${escapeHtml(record.recordId)}"><div class="panel__heading"><div><h2>${escapeHtml(recordTitle(context, record))}</h2></div>${compatibilityStatus}</div><dl class="key-fact-grid"><div><dt>Record</dt><dd><code>${escapeHtml(shortIdentity(record.recordId))}</code></dd></div><div><dt>State</dt><dd>${record.archived ? 'Archived' : 'Active'}</dd></div><div><dt>Revision</dt><dd>${String(record.revision)}</dd></div></dl>${compatibilityActions}</section>`
      : dataDiagnostic('QUERY_NOT_FOUND'),
    'key-facts-slot',
  );
}

function renderSections(context: SurfaceComponentContext): string {
  if (context.data?.status === 'READY' && context.data.composition)
    return renderCompositionFields(context.surface, context.data.composition);
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
        ? `${data.status === 'READY' && data.receiving ? renderReceivingSection(data.receiving) : ''}${data.status === 'READY' && data.receivingNavigation ? renderReceivingNavigation(data.receivingNavigation) : ''}${data.status === 'READY' && data.salesOrder ? renderSalesOrderSection(data.salesOrder) : ''}${data.status === 'READY' && data.packingDocument ? renderPackingDocument(data.packingDocument) : ''}<section class="panel data-panel" data-data-state="exact"><div class="panel__heading"><div><h2>${escapeHtml(entityLabel(context.surface))} information</h2></div></div><details class="record-section-group" open><summary>${escapeHtml(entityLabel(context.surface))} fields</summary><dl class="record-fields">${context.surface.fieldIds.map((fieldId) => `<div data-field-id="${escapeHtml(fieldId)}"><dt>${escapeHtml(fieldLabel(fieldId, surfaceEntityId(context)))}</dt><dd>${renderValue(record.values[fieldId])}</dd></div>`).join('')}</dl></details></section>`
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
  return slotPanel(
    context,
    `${compatibilityFeedback}<section class="panel data-panel" data-data-state="${record ? 'exact' : 'empty'}"><div class="panel__heading"><div><h2>${record ? 'Update the record' : 'Create a record'}</h2></div></div>${relationContent.freeze}<form id="surface-record-form" method="post" action="${escapeHtml(surfaceHref(context.surface, undefined, false, context))}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(recordId)}">${record ? `<input type="hidden" name="expectedRevision" value="${record.revision}">` : ''}<div class="form-fields">${relationContent.controls}${renderFormFields(context, operation, record)}</div></form></section>`,
    'sections-slot',
  );
}

function renderSalesOrderSection(section: SalesOrderSection): string {
  const link = (local: string, recordId?: string) => {
    const parameters = new URLSearchParams({
      surface: `${section.namespace}:surface.${local}`,
      [section.scopeParameterIds[local]!]: section.legalEntityId,
    });
    if (recordId) parameters.set('record', recordId);
    return escapeHtml(`/?${parameters}`);
  };
  const rows = section.lines
    .map(
      (line) =>
        `<tr data-sales-order-line="${escapeHtml(line.recordId)}"><td><a href="${link('sales_order_line_detail', line.recordId)}">${escapeHtml(line.lineNumber)}</a></td><td>${escapeHtml(line.item)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.reservationCoverage)}</td><td>${escapeHtml(line.netShipped)}</td><td>${escapeHtml(line.openToShip)}</td><td>${escapeHtml(line.unit)}</td><td>${escapeHtml(line.unitPrice)}</td></tr>`,
    )
    .join('');
  const stock = section.stock
    .map(
      (row) =>
        `<tr data-stock-identity="${escapeHtml(`${row.item}:${row.location}`)}"><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.location)}</td><td>${escapeHtml(row.onHand)}</td><td>${escapeHtml(row.reserved)}</td><td>${escapeHtml(row.available)}</td></tr>`,
    )
    .join('');
  return `<section class="panel data-panel" data-sales-order-lines><h2>Fulfillment</h2><p><a href="${link('reservation_form')}">Create reservation</a> · <a href="${link('reservation_list')}">View reservations</a> · <a href="${link('shipment_form')}">Create shipment</a> · <a href="${link('shipment_list')}">View shipments and corrections</a></p><p>Reserve a manually selected item, location and exact quantity. Shortages are refused. Ship only against selected live reservations; allocation and unreserved shipping are not available.</p><table><thead><tr><th>Line</th><th>Item</th><th>Ordered</th><th>Reservation coverage</th><th>Net shipped</th><th>Open to ship</th><th>Unit</th><th>Unit price</th></tr></thead><tbody>${rows}</tbody></table>${section.lines.length === 0 ? '<p>No active order lines.</p>' : ''}<h3>Stock coverage</h3><table><thead><tr><th>Item</th><th>Location</th><th>On hand</th><th>Reserved</th><th>Available</th></tr></thead><tbody>${stock}</tbody></table>${section.stock.length === 0 ? '<p>Create a reservation to show its selected stock identity.</p>' : ''}<p>Corrections append compensating movements. A released reservation is never silently resurrected; create a new reservation if more stock must be committed.</p></section>`;
}

function renderPackingDocument(document: ShipmentPackingDocument): string {
  const rows = document.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.lineNumber)}</td><td>${escapeHtml(line.item)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.unit)}</td></tr>`,
    )
    .join('');
  return `<section class="panel data-panel packing-document" data-packing-document><div class="panel__heading"><div><h2>Packing document ${escapeHtml(document.shipmentNumber)}</h2><p>Printable committed shipment facts</p></div></div><dl class="key-fact-grid"><div><dt>Sales order</dt><dd>${escapeHtml(document.orderId)}</dd></div><div><dt>Ship-from location</dt><dd>${escapeHtml(document.location)}</dd></div><div><dt>Shipped at</dt><dd>${escapeHtml(document.effectiveAt)}</dd></div><div><dt>External reference</dt><dd>${escapeHtml(document.externalReference)}</dd></div></dl><table><thead><tr><th>Line</th><th>Item</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table><p class="print-guidance">Use the browser print command to print or save this packing document.</p></section>`;
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
      freeze: renderRelationFreeze(context, authority.relationInputs),
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
    controls: pickerState.pickers
      .map((picker) => renderRelationPicker(context, picker))
      .join(''),
    freeze: '',
    refusal: '',
  };
}

function renderRelationPicker(
  context: SurfaceComponentContext,
  picker: SurfaceRelationPicker,
): string {
  const label = fieldLabel(picker.relationId, surfaceEntityId(context));
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
  context: SurfaceComponentContext,
  relations: readonly CompiledSurfaceRelationInput[],
): string {
  if (relations.length === 0) return '';
  return `<aside class="relation-freeze" data-relation-freeze role="note"><h3>Locked after creation</h3><ul>${relations.map((relation) => `<li data-relation-id="${escapeHtml(relation.relationId)}"><strong>${escapeHtml(fieldLabel(relation.relationId, surfaceEntityId(context)))}</strong> is chosen when this record is created and cannot be changed later.</li>`).join('')}</ul></aside>`;
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
    <p class="eyebrow">Workspace version</p>
    <h2>${escapeHtml(surface.label)} is ready</h2>
    <p class="lede">This view stays consistent while you work. A newly published version appears when you reopen it.</p>
    <dl class="fact-grid">
      <div><dt>Version</dt><dd>${escapeHtml(shortIdentity(view.release.releaseId))}</dd></div>
      <div><dt>Revision</dt><dd>${view.pointer.fence}</dd></div>
      <div><dt>Available statuses</dt><dd>${escapeHtml(roles)}</dd></div>
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
        <p class="eyebrow">Workspace setup</p>
        <h2>${escapeHtml(surface.label)} checklist</h2>
      </div>
      <span class="status-pill">Release ${escapeHtml(shortIdentity(view.release.releaseId))}</span>
    </div>
    <ol class="checklist">
      <li><span aria-hidden="true">01</span><div><strong>Workspace ready</strong><p>${surface.slots.length} area${surface.slots.length === 1 ? '' : 's'} available.</p></div></li>
      <li><span aria-hidden="true">02</span><div><strong>Version confirmed</strong><p>Revision ${view.pointer.fence} remains stable while you work.</p></div></li>
      <li><span aria-hidden="true">03</span><div><strong>Fields ready</strong><p>${surface.fieldIds.length} field${surface.fieldIds.length === 1 ? '' : 's'} available.</p></div></li>
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
  const sourceEntityId = linkContext
    ? readCompiledSurfaceDataBinding(linkContext.view, surface).query
        .sourceEntityId
    : (records[0]?.entityId ?? '');
  if (result?.listCoverage) {
    return renderSharedListSurface(
      surface,
      result,
      sourceEntityId,
      detail,
      linkContext,
    );
  }
  if (records.length === 0) {
    return emptyDataPanel();
  }
  const selectable = hasNamedSlot(surface, 'bulkActions');
  const formId = bulkSelectionFormId(surface);
  const recordLabel = entityLabel(surface);
  return `<section class="panel data-panel" data-data-state="exact"><div class="panel__heading"><div><h2>${escapeHtml(recordLabel)}</h2></div><span class="status-pill">${records.length} visible</span></div><div class="data-table-wrap" data-list-rendering="responsive-single"><table><thead><tr>${selectable ? '<th scope="col">Select</th>' : ''}<th scope="col">${escapeHtml(recordLabel)}</th>${surface.fieldIds.map((fieldId) => `<th scope="col">${escapeHtml(fieldLabel(fieldId, sourceEntityId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${records
    .map((record) => {
      const title = listRecordTitle(surface, record, linkContext);
      return `<tr data-compact-card="true" data-record-id="${escapeHtml(record.recordId)}">${selectable ? selectionCell(formId, record, recordLabel, title) : ''}<td data-column-label="${escapeHtml(recordLabel)}" data-column-priority="0">${detail ? `<a class="record-link" href="${escapeHtml(surfaceHref(detail, record.recordId, record.archived, linkContext))}" aria-label="Open ${escapeHtml(recordLabel)} ${escapeHtml(title)}">${escapeHtml(title)}</a>` : escapeHtml(title)}</td>${surface.fieldIds.map((fieldId, index) => `<td data-column-label="${escapeHtml(fieldLabel(fieldId, sourceEntityId))}" data-column-priority="${String(index + 1)}" data-field-id="${escapeHtml(fieldId)}">${renderValue(record.values[fieldId])}</td>`).join('')}<td data-column-label="Status" data-column-priority="${String(surface.fieldIds.length + 1)}">${record.archived ? 'Archived' : 'Active'}</td></tr>`;
    })
    .join('')}</tbody></table></div></section>`;
}

function renderSharedListSurface(
  surface: CompiledSurfaceDefinition,
  result: SemanticQueryResultEnvelope,
  sourceEntityId: string,
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
  const recordLabel = entityLabel(surface);
  const body =
    view.rows.length === 0
      ? `<div class="data-empty" data-data-state="empty" data-list-zero-input="true"><h3>No records yet</h3><p>This search has zero visible records for the current tenant, environment, and principal.</p></div>`
      : `<div class="data-table-wrap" data-list-rendering="responsive-single"><table><thead><tr>${selectable ? '<th scope="col">Select</th>' : ''}<th scope="col">${escapeHtml(recordLabel)}</th>${columns.map((column) => `<th scope="col">${escapeHtml(fieldLabel(column.columnId, sourceEntityId))}</th>`).join('')}<th scope="col">Status</th></tr></thead><tbody>${view.rows
          .map((row) => {
            const title = listRecordTitle(surface, row.record, linkContext);
            return `<tr data-compact-card="true" data-record-id="${escapeHtml(row.record.recordId)}">${selectable ? selectionCell(formId, row.record, recordLabel, title) : ''}<td data-column-label="${escapeHtml(recordLabel)}" data-column-priority="0">${detail ? `<a class="record-link" href="${escapeHtml(surfaceHref(detail, row.record.recordId, row.archived, linkContext))}" aria-label="Open ${escapeHtml(recordLabel)} ${escapeHtml(title)}">${escapeHtml(title)}</a>` : escapeHtml(title)}</td>${columns.map((column, index) => `<td data-column-label="${escapeHtml(fieldLabel(column.columnId, sourceEntityId))}" data-column-priority="${String(index + 1)}" ${column.kind === 'relation' ? 'data-relation-id' : 'data-field-id'}="${escapeHtml(column.columnId)}">${renderValue(row.cells[column.columnId])}</td>`).join('')}<td data-column-label="Status" data-column-priority="${String(columns.length + 1)}"><span class="status-pill" data-status-role="${row.archived ? 'attention' : 'success'}">${row.archived ? 'Archived' : 'Active'}</span></td></tr>`;
          })
          .join('')}</tbody></table></div>`;
  const search = renderListSearch(surface, view.listCoverage, linkContext);
  const previous = previousPageHref(surface, view.listCoverage, linkContext);
  const next = view.listCoverage.nextCursor
    ? `<a class="list-page-link" href="${escapeHtml(nextPageHref(surface, view.listCoverage.nextCursor, view.listCoverage.search, view.listCoverage.includeArchived, linkContext))}">Next page</a>`
    : '';
  return `<section class="panel data-panel" data-data-state="exact" data-list-result="${escapeHtml(view.listCoverage.schemaVersion)}"><div class="panel__heading"><div><h2>${escapeHtml(recordLabel)}</h2></div><span class="status-pill" data-status-role="${coverageRole}" data-list-coverage="${escapeHtml(coverage)}">${escapeHtml(coverage)} visible</span></div>${search}${body}<nav class="list-pagination surface-heading__actions" aria-label="List pages">${previous}${next}</nav></section>`;
}

function renderListSearch(
  surface: CompiledSurfaceDefinition,
  coverage: NonNullable<SemanticQueryResultEnvelope['listCoverage']>,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): string {
  const parameters = listParameters(
    surface,
    coverage.search,
    coverage.includeArchived,
    linkContext,
  );
  parameters.delete('q');
  const hidden = [...parameters.entries()]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  const clear =
    coverage.search.length > 0
      ? `<a class="secondary-action" href="/?${escapeHtml(parameters.toString())}">Clear</a>`
      : '';
  return `<form class="form-fields" data-list-search method="get" action="/">${hidden}<div class="form-field"><label><span>Search records</span><input type="search" name="q" value="${escapeHtml(coverage.search)}" maxlength="240" autocomplete="off"></label></div><div class="surface-heading__actions"><button type="submit">Search</button>${clear}</div></form>`;
}

function previousPageHref(
  surface: CompiledSurfaceDefinition,
  coverage: NonNullable<SemanticQueryResultEnvelope['listCoverage']>,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): string {
  if (coverage.pageOffset === 0 || !linkContext) return '';
  const previousOffset = Math.max(
    0,
    coverage.pageOffset - coverage.effectivePageSize,
  );
  const parameters = listParameters(
    surface,
    coverage.search,
    coverage.includeArchived,
    linkContext,
  );
  if (previousOffset > 0) {
    const queryId = readCompiledSurfaceDataBinding(linkContext.view, surface)
      .query.queryId;
    parameters.set(
      'cursor',
      encodeSharedListCursor(
        queryId,
        {
          cursor: null,
          effectivePageSize: coverage.effectivePageSize,
          includeArchived: coverage.includeArchived,
          matchMode: coverage.matchMode,
          pageOffset: previousOffset,
          parentScope: null,
          relationLabels: [],
          requestedPageSize: coverage.requestedPageSize,
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: coverage.search,
          sort: coverage.sort,
          truncatedByMaximum: coverage.truncatedByMaximum,
        },
        previousOffset,
      ),
    );
  }
  return `<a class="list-page-link" href="/?${escapeHtml(parameters.toString())}">Previous page</a>`;
}

function listParameters(
  surface: CompiledSurfaceDefinition,
  search: string,
  includeArchived: boolean,
  linkContext?: Pick<SurfaceComponentContext, 'legalEntitySelection' | 'view'>,
): URLSearchParams {
  const parameters = new URLSearchParams({ surface: surface.surfaceId });
  if (search.length > 0) parameters.set('q', search);
  if (includeArchived) parameters.set('archived', 'yes');
  appendLegalEntitySelection(parameters, surface, linkContext);
  return parameters;
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
    ? `<form class="lifecycle-action" method="post" action="${escapeHtml(surfaceHref(context.surface, record.recordId, record.archived, context))}"><input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="recordId" value="${escapeHtml(record.recordId)}"><input type="hidden" name="expectedRevision" value="${record.revision}"><button class="secondary-action" type="submit">${escapeHtml(operation.label)}</button></form>`
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

function fieldLabel(fieldId: string, entityId = ''): string {
  const local = fieldId.slice(fieldId.lastIndexOf('.') + 1);
  const entityPrefix = entityId.slice(entityId.lastIndexOf('.') + 1);
  const withoutEntity =
    entityPrefix.length > 0 && local.startsWith(`${entityPrefix}_`)
      ? local.slice(entityPrefix.length + 1)
      : local;
  return identifierLabel(withoutEntity.replace(/_id$/u, ''));
}

const BUSINESS_ACRONYMS: Readonly<Record<string, string>> = Object.freeze({
  api: 'API',
  erp: 'ERP',
  id: 'ID',
  sku: 'SKU',
  uom: 'UOM',
  url: 'URL',
});

function identifierLabel(value: string): string {
  const words = value
    .trim()
    .replaceAll(/[^A-Za-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return 'Record';
  return words
    .map((word, index) => {
      const acronym = BUSINESS_ACRONYMS[word];
      if (acronym) return acronym;
      return index === 0
        ? word.slice(0, 1).toUpperCase() + word.slice(1)
        : word;
    })
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
  return `<section class="panel data-empty" data-data-state="empty"><h2>No records yet</h2><p class="lede">This view has no visible records for the current tenant, environment, and principal.</p></section>`;
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
    const matches = (candidate: CompiledSurfaceDefinition) => {
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
    };
    if (role !== 'list') return surfaces.find(matches);
    // A worklist may list the same records beside the entity's own List; the
    // way back to "the list" is the one that owns the entity's Record.
    const candidates = surfaces.filter(matches);
    if (candidates.length > 1) {
      const owners = recordWorkspaceOwners(view, surfaces, entityId);
      return (
        candidates.find((candidate) => owners.has(candidate.surfaceId)) ??
        candidates[0]
      );
    }
    return candidates[0];
  } catch {
    return undefined;
  }
}

/**
 * The workspaces that own an entity's active Record surfaces. When more than
 * one List reads an entity -- a worklist beside the entity's own List -- the
 * List named here is the one that stands for the entity: the picker authority,
 * the breadcrumb and the navigation destination of its records.
 */
export function recordWorkspaceOwners(
  view: RuntimeViewContract.RequestRuntimeView,
  surfaces: readonly CompiledSurfaceDefinition[],
  entityId: string,
): ReadonlySet<string> {
  return new Set(
    surfaces.flatMap((candidate) => {
      if (
        candidate.lifecycle !== 'active' ||
        candidate.surfaceRole !== 'record' ||
        !candidate.workspace?.ownerSurfaceId
      )
        return [];
      try {
        return readCompiledSurfaceDataBinding(view, candidate).query
          .sourceEntityId === entityId
          ? [candidate.workspace.ownerSurfaceId]
          : [];
      } catch {
        return [];
      }
    }),
  );
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

function surfaceEntityId(context: SurfaceComponentContext): string {
  return readCompiledSurfaceDataBinding(context.view, context.surface).query
    .sourceEntityId;
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

function selectionCell(
  formId: string,
  record: SemanticRecordDto,
  recordLabel: string,
  title: string,
): string {
  const label = `Select ${recordLabel} ${title}`;
  return `<td class="selection-cell" data-column-label="Select"><label class="record-selector"><span class="sr-only">${escapeHtml(label)}</span><input aria-label="${escapeHtml(label)}" class="record-selector__input" form="${escapeHtml(formId)}" name="recordId" type="checkbox" value="${escapeHtml(record.recordId)}"></label></td>`;
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
  context: SurfaceComponentContext,
  operation: CompiledSurfaceOperationBinding,
  record: SemanticRecordDto | null,
): string {
  const { surface } = context;
  const fieldsById = new Map(
    (surface.fields ?? []).map((field) => [field.fieldId, field]),
  );
  const inputFieldsById = new Map(
    (operation.inputFields ?? []).map((field) => [field.fieldId, field]),
  );
  return surface.fieldIds
    .filter(
      (fieldId) =>
        operation.inputFields === null || inputFieldsById.has(fieldId),
    )
    .map((fieldId, index) => {
      const label = fieldLabel(fieldId, surfaceEntityId(context));
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
        label,
        value,
        record !== null,
        control.storedValueUnavailable,
      );
      const unavailableValue = control.storedValueUnavailable
        ? renderUnavailableStoredValue(fieldId, index, inputField, value)
        : '';
      return `<div class="form-field"><label><span>${escapeHtml(label)}</span>${control.html}</label>${unavailableValue}${emptyIntent}</div>`;
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
  fieldLabelText: string,
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
    `<label class="form-empty-intent"><span>When ${escapeHtml(fieldLabelText)} is blank</span><select name="${FORM_EMPTY_INTENT_PREFIX}${escapeHtml(fieldId)}" data-empty-intent-for="${escapeHtml(fieldId)}" autocomplete="off">${options.join('')}</select></label>`;
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

export interface RenderedFormControl {
  readonly html: string;
  /** The browser will sanitize or de-select this stored value to blank. */
  readonly storedValueUnavailable: boolean;
}

/**
 * The typed control for one field. `control.name` and `control.attributes` let a
 * caller with its own submission naming -- the draft document editor -- reuse
 * the same typed rendering and stored-value preservation instead of keeping a
 * separate text-only renderer. Both default to the record form's own shape.
 */
export function renderFormControl(
  field: CompiledSurfaceField | undefined,
  inputField: CompiledSurfaceInputField | undefined,
  fieldId: string,
  index: number,
  value: unknown,
  control: { readonly name?: string; readonly attributes?: string } = {},
): RenderedFormControl {
  const name =
    control.name === undefined
      ? `value:${escapeHtml(fieldId)}`
      : escapeHtml(control.name);
  const extra = control.attributes ?? '';
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
      html: `<input${describedBy}${extra} name="${name}" value="${renderInputValue(renderedValue)}" autocomplete="off">`,
      storedValueUnavailable,
    };
  }
  const current = renderInputValue(renderedValue);
  const kind = ` data-field-kind="${field.kind}"${describedBy}${extra}`;
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

// Declared List markup (canonical `surface.list`), rendered only from the
// closed registry; list-declaration.ts holds the markup-free request state.
function declaredStatusRole(
  column: DeclaredListColumn,
  record: SemanticRecordDto,
): string | null {
  const raw = record.values[column.field];
  return column.statusRoles?.find((entry) => entry.value === raw)?.role ?? null;
}

interface DeclaredListRenderInput {
  readonly base: URLSearchParams;
  readonly coverage: SharedListCoverage;
  readonly detailHref: (record: SemanticRecordDto) => string | null;
  readonly exportLimit: number | null;
  readonly list: SurfaceList;
  /** The request's instant: overdue dates are judged against its day. */
  readonly now: Date;
  readonly present: FieldPresenter;
  /** The progress query current policy withheld; its figures read "—". */
  readonly progressWithheld: string | null;
  readonly recordLabel: string;
  readonly records: readonly SemanticRecordDto[];
  /** Where a row's action leads, or `null` when it cannot be linked. */
  readonly rowActionHref: (
    record: SemanticRecordDto,
    action: DeclaredListRowAction,
  ) => string | null;
  readonly selectionCell:
    ((record: SemanticRecordDto, title: string) => string) | null;
  readonly state: DeclaredListState;
}

/**
 * Says which figures a List reads without, and which views they would have
 * served: the progress columns, withheld by current policy, and the views
 * that keep only open rows, which are refused while they are.
 */
function progressWithheldNote(list: SurfaceList, withheld: string): string {
  if (!list.progress) return '';
  const outputs = new Set(Object.values(list.progress.outputs));
  const series = (labels: readonly string[]) =>
    labels.length > 1
      ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)!}`
      : (labels[0] ?? '');
  const figures = orderedColumns(list)
    .filter((column) => outputs.has(column.field))
    .map((column) => column.label);
  const views = orderedViews(list)
    .filter((view) => view.open)
    .map((view) => view.label);
  const text = `${figures.length > 0 ? series(figures) : 'Progress figures'} ${figures.length === 1 ? 'is' : 'are'} withheld by current policy${
    views.length > 0
      ? `; ${series(views)} ${views.length === 1 ? 'needs them and is' : 'need them and are'} unavailable`
      : ''
  }.`;
  return `<p class="muted" data-list-progress-withheld="${escapeHtml(withheld)}">${escapeHtml(text)}</p>`;
}

/** Saved-view tabs; counts are server counts of each view under the current search and filters. */
function renderDeclaredListViews(
  list: SurfaceList,
  state: DeclaredListState,
  base: URLSearchParams,
  counts: Readonly<Record<string, number>>,
): string {
  const views = orderedViews(list);
  if (views.length === 0) return '';
  return `<nav class="list-views" aria-label="Views"><ul>${views
    .map((view) => {
      const current = view.viewId === state.viewId;
      const count = counts[view.viewId];
      const href = `/?${declaredListParameters(state, base, { page: 1, viewId: view.viewId }).toString()}`;
      return `<li><a class="list-view" href="${escapeHtml(href)}" data-view-id="${escapeHtml(view.viewId)}"${current ? ' aria-current="page"' : ''}><span>${escapeHtml(view.label)}</span>${count === undefined ? '' : `<span class="list-view__count" data-view-count="${String(count)}">${escapeHtml(String(count))}</span>`}</a></li>`;
    })
    .join('')}</ul></nav>`;
}

function renderDeclaredList(input: DeclaredListRenderInput): string {
  const { list, state, coverage, base } = input;
  const columns = orderedColumns(input.list);
  const pageCount = Math.max(
    1,
    Math.ceil(coverage.totalCount / Math.max(1, coverage.effectivePageSize)),
  );
  const page =
    Math.floor(coverage.pageOffset / Math.max(1, coverage.effectivePageSize)) +
    1;
  const firstVisible =
    coverage.returnedCount === 0 ? 0 : coverage.pageOffset + 1;
  const lastVisible = coverage.pageOffset + coverage.returnedCount;
  const narrowed =
    state.search.length > 0 || Object.keys(state.filterValues).length > 0;
  const formHidden = [
    ...declaredListParameters(state, base, { page: 1 }).entries(),
  ]
    .filter(
      ([name]) =>
        name !== 'q' &&
        name !== 'page' &&
        name !== 'sort' &&
        name !== 'dir' &&
        !list.filters.some((filter) => filter.filterId === name),
    )
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  // A control's accessible name is its label alone: a select nested in its
  // label would be announced with its current option ("Currency All").
  const controlId = (suffix: string) =>
    `list-${String(input.list.columns[0]?.columnId ?? 'list').replaceAll(/[^A-Za-z0-9_-]/gu, '-')}-${suffix}`;
  const filterControls = orderedFilters(list)
    .map(
      (filter, index) =>
        `<div class="form-field"><label for="${controlId(`filter-${String(index)}`)}">${escapeHtml(filter.label)}</label><select id="${controlId(`filter-${String(index)}`)}" name="${escapeHtml(filter.filterId)}"><option value="">All</option>${filter.options
          .map(
            (option) =>
              `<option value="${escapeHtml(option.value)}"${state.filterValues[filter.filterId] === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
          )
          .join('')}</select></div>`,
    )
    .join('');
  const sortable = orderedColumns(list).filter((column) => column.sortable);
  const current = state.sort[0];
  const sortControls =
    sortable.length > 0
      ? `<div class="form-field"><label for="${controlId('sort')}">Sort by</label><select id="${controlId('sort')}" name="sort">${sortable
          .map(
            (column) =>
              `<option value="${escapeHtml(column.columnId)}"${current?.columnId === column.columnId ? ' selected' : ''}>${escapeHtml(column.label)}</option>`,
          )
          .join(
            '',
          )}</select></div><div class="form-field"><label for="${controlId('dir')}">Order</label><select id="${controlId('dir')}" name="dir"><option value="asc"${current?.direction === 'descending' ? '' : ' selected'}>Ascending</option><option value="desc"${current?.direction === 'descending' ? ' selected' : ''}>Descending</option></select></div>`
      : '';
  const clearHref = `/?${declaredListParameters(state, base, { filterValues: {}, page: 1, search: '' }).toString()}`;
  const controls = `<form class="list-controls" data-list-search method="get" action="/">${formHidden}<div class="form-field list-controls__search"><label><span>Search ${escapeHtml(input.recordLabel.toLowerCase())}</span><input type="search" name="q" value="${escapeHtml(state.search)}" maxlength="240" autocomplete="off"></label></div>${filterControls}${sortControls}<div class="list-controls__actions"><button type="submit">Apply</button>${narrowed ? `<a class="secondary-action" href="${escapeHtml(clearHref)}">Clear</a>` : ''}</div></form>`;
  const sortState = new Map(
    state.sort.map((sort) => [sort.columnId, sort.direction]),
  );
  const header = columns
    .map((column) => {
      const direction = sortState.get(column.columnId);
      if (!column.sortable)
        return `<th scope="col">${escapeHtml(column.label)}</th>`;
      const nextDirection =
        direction === 'ascending' ? 'descending' : 'ascending';
      const href = `/?${declaredListParameters(state, base, {
        page: 1,
        sort: [{ columnId: column.columnId, direction: nextDirection }],
        sortIsExplicit: true,
      }).toString()}`;
      const mark =
        direction === 'ascending'
          ? '↑'
          : direction === 'descending'
            ? '↓'
            : '↕';
      return `<th scope="col" aria-sort="${direction ?? 'none'}"><a class="list-sort" href="${escapeHtml(href)}" data-sort-column="${escapeHtml(column.columnId)}">${escapeHtml(column.label)} <span aria-hidden="true">${mark}</span><span class="sr-only">${direction ? `, sorted ${direction}; activate to sort ${nextDirection}` : ', activate to sort ascending'}</span></a></th>`;
    })
    .join('');
  const rowActions = (list.rowActions ?? []).length > 0;
  // The row's one action -- the first whose condition holds -- as a link to
  // its record page at the named section, named with the row it opens.
  const actionCell = (record: SemanticRecordDto, title: string) => {
    if (!rowActions) return '';
    const action = declaredRowAction(list, record);
    const href = action ? input.rowActionHref(record, action) : null;
    return `<td data-column-label="Actions" data-cell-role="actions">${
      action && href
        ? `<a class="secondary-action" href="${escapeHtml(href)}" data-row-action="${escapeHtml(action.actionId)}" aria-label="${escapeHtml(`${action.label} ${title}`)}">${escapeHtml(action.label)}</a>`
        : '<span class="muted">—</span>'
    }</td>`;
  };
  const body = input.records
    .map((record) => {
      const cells = columns
        .map((column) => {
          const text = declaredCellText(column, record, input.present);
          const label = `data-column-label="${escapeHtml(column.label)}" data-column-priority="${String(column.priority)}" data-column-id="${escapeHtml(column.columnId)}"`;
          if (column.role === 'title') {
            const title = text ?? record.recordId.slice(0, 8);
            const href = input.detailHref(record);
            return `<td ${label}>${href ? `<a class="record-link" href="${escapeHtml(href)}" aria-label="Open ${escapeHtml(input.recordLabel)} ${escapeHtml(title)}">${escapeHtml(title)}</a>` : escapeHtml(title)}${record.archived ? ' <span class="status-pill" data-status-role="attention">Archived</span>' : ''}</td>`;
          }
          if (column.role === 'status') {
            const role = declaredStatusRole(column, record);
            return `<td ${label}>${text === null ? '<span class="muted">—</span>' : `<span class="status-pill"${role ? ` data-status-role="${escapeHtml(role)}"` : ''}>${escapeHtml(text)}</span>`}</td>`;
          }
          // A declared overdue date reads "N days late" when the row meets its
          // view's conditions -- the same ones its tab was counted by.
          const late = overdueDays(list, column, record, input.now);
          return `<td ${label}>${text === null ? '<span class="muted">—</span>' : escapeHtml(text)}${late === null ? '' : ` <span class="status-pill" data-status-role="attention" data-overdue-days="${String(late)}">${escapeHtml(`${String(late)} ${late === 1 ? 'day' : 'days'} late`)}</span>`}</td>`;
        })
        .join('');
      const title =
        declaredCellText(
          columns.find((column) => column.role === 'title')!,
          record,
          input.present,
        ) ?? record.recordId.slice(0, 8);
      return `<tr data-compact-card="true" data-record-id="${escapeHtml(record.recordId)}">${input.selectionCell ? input.selectionCell(record, title) : ''}${cells}${actionCell(record, title)}</tr>`;
    })
    .join('');
  const empty =
    coverage.totalCount === 0
      ? `<div class="data-empty" data-data-state="empty" data-list-empty="${narrowed ? 'narrowed' : 'view'}"><h3>${narrowed ? `No ${escapeHtml(input.recordLabel.toLowerCase())} match` : `No ${escapeHtml(input.recordLabel.toLowerCase())} here yet`}</h3><p>${narrowed ? `Nothing in this view matches the search or filters. <a href="${escapeHtml(clearHref)}">Clear them</a> to see every record in the view.` : 'Records appear here as soon as they are saved.'}</p></div>`
      : '';
  const pageLink = (target: number, text: string, rel?: string) =>
    `<a class="list-page-link" href="${escapeHtml(`/?${declaredListParameters(state, base, { page: target }).toString()}`)}"${rel ? ` rel="${rel}"` : ''}>${text}</a>`;
  const paging =
    pageCount > 1
      ? `<nav class="list-pagination" aria-label="List pages">${page > 1 ? `${pageLink(1, 'First')}${pageLink(page - 1, 'Previous', 'prev')}` : ''}<span class="list-page-status" data-list-page="${String(page)}" data-list-page-count="${String(pageCount)}">Page ${String(page)} of ${String(pageCount)}</span>${page < pageCount ? `${pageLink(page + 1, 'Next', 'next')}${pageLink(pageCount, 'Last')}` : ''}<form class="list-page-jump" method="get" action="/">${[
          ...declaredListParameters(state, base, { page: 1 }).entries(),
        ]
          .map(
            ([name, value]) =>
              `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
          )
          .join(
            '',
          )}<label><span class="sr-only">Go to page</span><input type="number" name="page" min="1" max="${String(pageCount)}" value="${String(page)}" inputmode="numeric"></label><button class="secondary-action" type="submit">Go</button></form></nav>`
      : '';
  const exportControl =
    list.export && input.exportLimit !== null
      ? coverage.totalCount > input.exportLimit
        ? `<p class="list-export list-export--refused" data-list-export="over-limit">Export is limited to ${escapeHtml(String(input.exportLimit))} records; narrow the view to export.</p>`
        : coverage.totalCount > 0
          ? `<a class="secondary-action list-export" data-list-export="csv" href="${escapeHtml(`/?${declaredListParameters(state, base, { page: 1 }).toString()}&export=csv`)}" download>Export CSV (${escapeHtml(String(coverage.totalCount))})</a>`
          : ''
      : '';
  const count = `${String(coverage.totalCount)} matching ${coverage.totalCount === 1 ? 'record' : 'records'}`;
  const range =
    coverage.totalCount > 0
      ? `Showing ${String(firstVisible)}–${String(lastVisible)}`
      : '';
  // A List that compares dates with today names the day it was counted on.
  const anchor = list.views.some((view) => view.before)
    ? ` data-list-anchor="${escapeHtml(startOfTodayUtc(input.now).toISOString())}"`
    : '';
  // Figures withheld by current policy are said once, above the rows.
  const withheld = input.progressWithheld
    ? progressWithheldNote(list, input.progressWithheld)
    : '';
  return `<section class="panel data-panel" data-data-state="exact" data-list-result="${escapeHtml(coverage.schemaVersion)}" data-declared-list="true"${anchor}><div class="panel__heading"><div><h2>${escapeHtml(input.recordLabel)}</h2></div><div class="list-summary"><span class="status-pill" data-status-role="success" data-list-total="${String(coverage.totalCount)}">${escapeHtml(count)}</span>${range ? `<span class="muted">${escapeHtml(range)}</span>` : ''}${exportControl}</div></div>${withheld}${controls}${empty}${input.records.length > 0 ? `<div class="data-table-wrap" data-list-rendering="responsive-single"><table><thead><tr>${input.selectionCell ? '<th scope="col">Select</th>' : ''}${header}${rowActions ? '<th scope="col">Actions</th>' : ''}</tr></thead><tbody>${body}</tbody></table></div>` : ''}${paging}</section>`;
}
