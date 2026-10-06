import {
  compositionRelationTargets,
  loadSurfaceComposition,
  submitCompositionAction,
  displayFieldValue,
  renderCompositionPrintDocument,
} from './surface-composition.js';
import {
  resolveWorkspaceEntry,
  type WorkspaceEntry,
} from './workspace-entry.js';
import { documentEditor } from './document-editor.js';
import {
  launcherTiles,
  resolveLauncherScan,
  type LauncherRenderData,
} from './surface-launcher.js';
import {
  declaredListArguments,
  declaredListCsv,
  exportFileName,
  figureBandLabel,
  readDeclaredListState,
  viewNeedsProgress,
  viewNeedsSupply,
  withheldProgressQuery,
  withheldSupplyQuery,
  type DeclaredListState,
} from './list-declaration.js';
import type { SurfaceList } from '../../../packages/canonical-model/src/index.js';
import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  RECORD_LEGAL_ENTITY_BINDING_ARGUMENT_KEY,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  operationBindsRecordLegalEntity,
  parsePinnedOperationCatalog,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import type {
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryResultEnvelope,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import type { SemanticQueryGateway } from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../../packages/runtime/src/list-behavior/index.js';

import {
  FORM_EMPTY_INTENT_PREFIX,
  recordWorkspaceOwners,
  renderRegisteredSurfaceComponent,
  surfaceSupportsRuntimeIntent,
  type SurfaceDataRenderState,
  type SurfaceFormReferenceChoices,
  type SurfaceOperationFeedback,
  type SurfaceRelationPicker,
  type SurfaceRelationPickerOption,
  type SurfaceRelationPickerState,
} from './component-registry.js';
import { DESIGN_TOKENS } from './design-tokens.js';
import { SURFACE_CLIENT_SCRIPT } from './surface-client.js';
import { escapeHtml, shortIdentity } from './html.js';
import {
  operationMessageRef,
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
  pickerEnumerationQuery,
  formFieldIds,
  readCompiledSurfaceManifest,
  readCompiledSurfaceDataBinding,
  SurfaceProjectionError,
  type CompiledNavigationEntry,
  type CompiledNavigationTree,
  type CompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceInputField,
  type EntityRelationAuthority,
  type SurfaceOperationIntent,
} from './surface-contract.js';

/** Fixture-only shell furniture, never installed by the production composition. */
export function withLocalDemoIdentity(
  response: SurfaceRuntimeResponse,
  actors:
    readonly { key: 'buyer' | 'manager'; label: string }[] | null | undefined,
  selected: 'buyer' | 'manager',
): SurfaceRuntimeResponse {
  if (!actors) return response;
  const bar = `<aside aria-label="Local demo identity"><form method="post"><label>Acting as <select name="localDemoActAs" aria-label="Acting as">${actors.map((actor) => `<option value="${actor.key}"${actor.key === selected ? ' selected' : ''}>${escapeHtml(actor.label)}</option>`).join('')}</select></label><button type="submit">Switch person</button><span>Local demo</span></form></aside>`;
  return { ...response, html: response.html.replace('<body>', `<body>${bar}`) };
}

export interface SurfaceRuntimeResponse {
  readonly html: string;
  readonly statusCode: number;
  readonly location?: string;
  /** A generated file (a declared List's export) instead of a page. */
  readonly download?: {
    readonly body: string;
    readonly contentType: 'text/csv; charset=utf-8';
    readonly fileName: string;
  };
}

export interface SurfaceRuntimeGateways {
  readonly applicationExtension?: SurfaceRuntimeApplicationExtension;
  /**
   * The request clock, read once per request: a List's "before today" views,
   * their counts and its overdue dates all use the same instant, as do a
   * draft editor's declared defaults (a date days from today, or now).
   * Injectable so a test fixes the day; the wall clock when absent.
   */
  readonly clock?: () => Date;
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly operationGateway: SemanticOperationGateway;
  readonly queryGateway: SemanticQueryGateway;
}

type ReadySurfaceData = Extract<SurfaceDataRenderState, { status: 'READY' }>;

export interface SurfaceRuntimeApplicationExtension {
  augmentRecordData(context: {
    readonly binding: CompiledSurfaceDataBinding;
    readonly data: ReadySurfaceData;
    readonly legalEntitySelection: readonly string[];
    readonly queryGateway: SemanticQueryGateway;
    readonly surface: CompiledSurfaceDefinition;
    readonly surfaces: readonly CompiledSurfaceDefinition[];
    readonly view: RuntimeViewContract.RequestRuntimeView;
  }): Promise<ReadySurfaceData>;
  refreshAfterOperation(context: {
    readonly binding: CompiledSurfaceDataBinding;
    readonly intent: SurfaceOperationIntent;
    readonly surface: CompiledSurfaceDefinition;
    readonly surfaces: readonly CompiledSurfaceDefinition[];
  }): boolean;
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
    return Object.freeze({
      html: diagnosticDocument(view, { code: 'INVALID_SURFACE_BINDING' }),
      statusCode: 422,
    });
  }

  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const entry = await resolveWorkspaceEntry(
    view,
    selection.selected,
    url,
    gateways.queryGateway,
  );
  if (entry?.redirect)
    return { html: '', statusCode: 303, location: entry.redirect };
  if (entry?.invalid)
    return renderApplicationDiagnostic(422, {
      code: 'WORKSPACE_COMPANY_UNAVAILABLE',
    });
  const legalEntitySelection = legalEntitySelectionForSurface(binding, url);
  const queryParameterValues = queryParameterValuesForSurface(binding, url);
  const workspaceContext = await loadWorkspaceContextBar(
    view,
    selection,
    binding,
    gateways.queryGateway,
    legalEntitySelection,
    url,
    entry,
  );
  // A record every company shares reads its company-owned sections in the
  // company its entry settled on; its own record and commands stay unscoped.
  const compositionScope = binding.query.legalEntityScope
    ? (legalEntitySelection[0] ?? null)
    : entry?.shared
      ? entry.selected
      : null;
  if (binding.query.legalEntityScope && legalEntitySelection.length === 0) {
    return renderSelectedSurface(
      view,
      selection,
      {
        code:
          entry?.options.length === 0
            ? 'WORKSPACE_COMPANY_UNAVAILABLE'
            : 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED',
        status: 'DIAGNOSTIC',
      },
      feedback,
      binding.operations,
      422,
      legalEntitySelection,
      workspaceContext,
      queryParameterValues,
      binding.relationInputs,
    );
  }
  if (
    selection.selected.documentEditor &&
    selection.selected.surfaceRole === 'form' &&
    legalEntitySelection.length === 1
  ) {
    try {
      const editor = await documentEditor(
        view,
        selection.selected,
        selection.surfaces,
        url,
        legalEntitySelection[0]!,
        gateways,
      );
      if (editor)
        return editor.slots
          ? renderSelectedSurface(
              view,
              selection,
              {
                status: 'READY',
                records: editor.record ? [editor.record] : [],
                documentEditorSlots: editor.slots,
              },
              null,
              binding.operations,
              editor.statusCode,
              legalEntitySelection,
              workspaceContext,
            )
          : editor;
    } catch (error) {
      return renderApplicationDiagnostic(422, {
        code: queryMessageCode(error),
      });
    }
  }
  // A launcher Task (WAREHOUSE-MODE) asks its tiles' List counts and resolves
  // a scanned code; it never asks the lookup its archetype binds.
  const launcher = selection.selected.launcher;
  if (launcher) {
    const company =
      legalEntitySelection.length === 1 ? legalEntitySelection[0]! : null;
    const code = url.searchParams.get('scan') ?? '';
    let scan: LauncherRenderData['scan'] = null;
    if (code.trim() !== '') {
      const resolved = await resolveLauncherScan(
        view,
        launcher,
        selection.surfaces,
        company,
        gateways.queryGateway,
        code,
      );
      if ('location' in resolved)
        return { html: '', statusCode: 303, location: resolved.location };
      scan = { code, outcome: resolved.outcome };
    }
    const scopeParameterId =
      binding.query.legalEntityScope?.operand.parameterId;
    return renderSelectedSurface(
      view,
      selection,
      {
        launcher: {
          scan,
          scope:
            scopeParameterId && company
              ? { parameterId: scopeParameterId, value: company }
              : null,
          tiles: await launcherTiles(
            view,
            launcher,
            selection.surfaces,
            company,
            gateways.queryGateway,
            gateways.clock?.() ?? new Date(),
          ),
        },
        status: 'LAUNCHER_READY',
      },
      feedback,
      binding.operations,
      scan ? 422 : 200,
      legalEntitySelection,
      workspaceContext,
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
        binding.relationInputs,
      );
    }
  }
  const relationPickers = await loadRelationPickers(
    view,
    selection,
    binding,
    gateways.queryGateway,
    legalEntitySelection,
    url,
  );
  const formReferences = await loadFormReferences(
    view,
    selection.selected,
    gateways.queryGateway,
  );
  const declaredList =
    selection.selected.list && binding.query.queryType === 'list'
      ? {
          list: selection.selected.list,
          // One instant for the whole request: the page, each tab count, the
          // export and every overdue date agree on what "today" is.
          now: gateways.clock?.() ?? new Date(),
          state: readDeclaredListState(selection.selected.list, url),
        }
      : null;
  if (declaredList && url.searchParams.get('export') === 'csv') {
    return exportDeclaredList(
      view,
      selection.selected,
      binding,
      declaredList.list,
      declaredList.state,
      url,
      gateways.queryGateway,
      declaredList.now,
    );
  }
  const queryArguments = declaredList
    ? declaredListArguments(declaredList.list, declaredList.state, {
        mode: 'page',
        now: declaredList.now,
        pageOffset: (declaredList.state.page - 1) * declaredList.list.pageSize,
        queryId: binding.query.queryId,
        scopeArguments: legalEntityScopeArguments(binding, url),
      })
    : withCompositionRelations(
        view,
        selection.selected,
        argumentsForSurface(binding, url),
      );
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
      binding.relationInputs,
      relationPickers,
      formReferences,
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
    } else if (declaredList) {
      data = await declaredListData(
        view,
        binding,
        declaredList.list,
        declaredList.state,
        url,
        gateways.queryGateway,
        declaredList.now,
      );
    } else {
      const result = await gateways.queryGateway.invoke(view, request);
      data = dataState(result);
      if (
        data.status === 'READY' &&
        selection.selected.composition &&
        data.records[0]
      ) {
        data = {
          ...data,
          composition: await loadSurfaceComposition(
            view,
            selection.selected,
            data.records[0],
            requestUrl,
            compositionScope,
            gateways,
          ),
        };
        if (
          url.searchParams.get('print') === 'document' &&
          selection.selected.composition.presentation?.print &&
          data.status === 'READY' &&
          data.composition
        ) {
          const printed = renderCompositionPrintDocument(
            selection.selected,
            data.composition,
            new Date(),
          );
          return printDocumentPage(
            view,
            selection.selected.composition.presentation.print.label,
            printed.html,
            printed.complete ? 200 : 422,
          );
        }
      }
      if (
        data.status === 'READY' &&
        !selection.selected.composition &&
        selection.selected.surfaceRole === 'record' &&
        gateways.applicationExtension
      ) {
        data = await gateways.applicationExtension.augmentRecordData({
          binding,
          data,
          legalEntitySelection,
          queryGateway: gateways.queryGateway,
          surface: selection.selected,
          surfaces: selection.surfaces,
          view,
        });
      }
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
    binding.relationInputs,
    relationPickers,
    formReferences,
  );
}

/**
 * A Record form's references (`surface.form`): each field's choices read
 * through its declared list query for this request, labelled by the declared
 * label field and sorted by it. A read the gateway refuses, or one that does
 * not fit a single page, leaves the field `unavailable`: it keeps its plain
 * control, so the stored id is never lost or replaced by a partial choice.
 */
async function loadFormReferences(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  queryGateway: SemanticQueryGateway,
): Promise<Readonly<Record<string, SurfaceFormReferenceChoices>> | null> {
  if (surface.surfaceRole !== 'form' || !surface.form?.references) return null;
  const unavailable = Object.freeze({ status: 'unavailable' as const });
  const choices = await Promise.all(
    surface.form.references.map(async (reference) => {
      const query = registeredSemanticQueryFromPinnedView(
        view,
        reference.query.targetId,
      );
      if (!query || query.queryType !== 'list' || query.legalEntityScope)
        return [reference.field, unavailable] as const;
      try {
        const result = await queryGateway.invoke(view, {
          arguments: {
            includeArchived: false,
            list: {
              cursor: null,
              matchMode: 'substring',
              pageSize: query.maximumResultCount,
              relationLabels: [],
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              search: '',
              sort: [],
            },
          },
          queryId: query.queryId,
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        });
        if (result.outcome !== 'exact')
          return [reference.field, unavailable] as const;
        const shared = requireSharedListResult(result);
        if (shared.listCoverage.hasMore)
          return [reference.field, unavailable] as const;
        const labelFieldId = reference.labelField.targetId;
        const options = shared.records
          .map((record) => {
            const label =
              record.displayValues?.[labelFieldId] ??
              record.values[labelFieldId];
            return Object.freeze({
              label:
                typeof label === 'string' && label.trim() !== ''
                  ? label
                  : shortIdentity(record.recordId),
              recordId: record.recordId,
            });
          })
          .sort((left, right) => left.label.localeCompare(right.label));
        return [
          reference.field,
          Object.freeze({
            options: Object.freeze(options),
            status: 'ready' as const,
          }),
        ] as const;
      } catch {
        return [reference.field, unavailable] as const;
      }
    }),
  );
  return Object.freeze(Object.fromEntries(choices));
}

/**
 * What current policy withheld from a List whose figures are supplementary:
 * its progress (and so its supply, which extends it), or its supply alone.
 */
interface WithheldFigures {
  readonly progress: string | null;
  readonly supply: string | null;
}

/**
 * The withheld figures after one more refusal, or `null` when the refusal
 * names nothing supplementary -- the List's own query, a label, or figures
 * that are the List's purpose -- and must stand.
 */
function withholding(
  list: SurfaceList,
  withheld: WithheldFigures,
  error: unknown,
): WithheldFigures | null {
  if (withheld.progress !== null) return null;
  const progress = withheldProgressQuery(list, error);
  if (progress !== null) return { ...withheld, progress };
  const supply =
    withheld.supply === null ? withheldSupplyQuery(list, error) : null;
  return supply === null ? null : { ...withheld, supply };
}

/** Whether a view can be read with what is withheld: never one needing it. */
function viewServes(
  list: SurfaceList,
  withheld: WithheldFigures,
  viewId: string | null,
): boolean {
  return !(
    (withheld.progress !== null && viewNeedsProgress(list, viewId)) ||
    (withheld.supply !== null && viewNeedsSupply(list, viewId))
  );
}

/** The request options that leave out what is withheld. */
function withoutWithheld(withheld: WithheldFigures) {
  return {
    ...(withheld.progress !== null ? { withoutProgress: true } : {}),
    ...(withheld.supply !== null ? { withoutSupply: true } : {}),
  };
}

/** What the rendered List says it reads without. */
function withheldRenderData(withheld: WithheldFigures) {
  return {
    ...(withheld.progress === null
      ? {}
      : { progressWithheld: withheld.progress }),
    ...(withheld.supply === null ? {} : { supplyWithheld: withheld.supply }),
  };
}

/**
 * A declared List's page, plus a server count for every saved view under the
 * same search and filters. A page number past the end is answered with the
 * last page rather than an empty window that claims records exist. A view
 * count that cannot be read is omitted, never guessed.
 *
 * A List whose progress is supplementary (`whenDenied: 'omit'`) is read
 * without it when current policy withholds either summed query: its figures
 * read "—", its other views still serve and count, and a view that keeps only
 * open rows -- which only the figures can judge -- is refused and uncounted.
 * Its supply (SUPPLY-WARNINGS) is withheld the same way, alone: the progress
 * still serves, and only the views that keep covered or short rows refuse.
 */
async function declaredListData(
  view: RuntimeViewContract.RequestRuntimeView,
  binding: CompiledSurfaceDataBinding,
  list: SurfaceList,
  state: DeclaredListState,
  url: URL,
  queryGateway: SemanticQueryGateway,
  now: Date,
): Promise<SurfaceDataRenderState> {
  const scopeArguments = legalEntityScopeArguments(binding, url);
  const read = (
    mode: 'count' | 'page',
    listState: DeclaredListState,
    withheld: WithheldFigures,
    viewId?: string,
  ) =>
    queryGateway.invoke(view, {
      arguments: declaredListArguments(list, listState, {
        mode,
        now,
        ...(mode === 'page'
          ? { pageOffset: (listState.page - 1) * list.pageSize }
          : {}),
        queryId: binding.query.queryId,
        scopeArguments,
        ...(viewId === undefined ? {} : { viewId }),
        ...withoutWithheld(withheld),
      }),
      queryId: binding.query.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
  const viewCounts = async (withheld: WithheldFigures) => {
    const counts: Record<string, number> = {};
    for (const listView of list.views) {
      // A view needing withheld figures is never counted without them: its
      // tab shows no count, and its own page refuses.
      if (!viewServes(list, withheld, listView.viewId)) continue;
      try {
        const counted = await read('count', state, withheld, listView.viewId);
        if (counted.listCoverage)
          counts[listView.viewId] = counted.listCoverage.totalCount;
      } catch {
        // Omitted: the tab still navigates, and its own page reports its count.
      }
    }
    return counts;
  };
  let withheld: WithheldFigures = { progress: null, supply: null };
  let result: SemanticQueryResultEnvelope | undefined;
  while (result === undefined) {
    try {
      result = await read('page', state, withheld);
    } catch (error) {
      const next = withholding(list, withheld, error);
      if (next === null) throw error;
      withheld = next;
      if (!viewServes(list, withheld, state.viewId))
        return {
          code: 'QUERY_PERMISSION_DENIED',
          declaredList: {
            counts: await viewCounts(withheld),
            now,
            ...withheldRenderData(withheld),
            state,
          },
          status: 'DIAGNOSTIC',
        };
    }
  }
  const coverage = result.listCoverage;
  if (
    coverage &&
    coverage.returnedCount === 0 &&
    coverage.totalCount > 0 &&
    coverage.pageOffset > 0
  ) {
    const lastPage = Math.ceil(coverage.totalCount / list.pageSize);
    state = { ...state, page: lastPage };
    result = await read('page', state, withheld);
  }
  const counts = await viewCounts(withheld);
  const data = dataState(result);
  return data.status === 'READY'
    ? {
        ...data,
        declaredList: {
          counts,
          now,
          ...withheldRenderData(withheld),
          state,
        },
      }
    : data;
}

/**
 * One export statement, bounded by the query's declared export limit. A set
 * larger than the limit is refused with a page, never written as a partial
 * file, and nothing is fetched page by page.
 */
async function exportDeclaredList(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  binding: CompiledSurfaceDataBinding,
  list: SurfaceList,
  state: DeclaredListState,
  url: URL,
  queryGateway: SemanticQueryGateway,
  now: Date,
): Promise<SurfaceRuntimeResponse> {
  const exportMaximumResultCount =
    'exportMaximumResultCount' in binding.query
      ? binding.query.exportMaximumResultCount
      : undefined;
  if (!list.export || exportMaximumResultCount === undefined)
    return renderApplicationDiagnostic(404, { code: 'QUERY_UNSUPPORTED' });
  const exported = (withheld: WithheldFigures) =>
    queryGateway.invoke(view, {
      arguments: declaredListArguments(list, state, {
        exportMaximumResultCount,
        mode: 'export',
        now,
        queryId: binding.query.queryId,
        scopeArguments: legalEntityScopeArguments(binding, url),
        ...withoutWithheld(withheld),
      }),
      queryId: binding.query.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
  let result: SemanticQueryResultEnvelope | undefined;
  try {
    let withheld: WithheldFigures = { progress: null, supply: null };
    while (result === undefined) {
      try {
        result = await exported(withheld);
      } catch (error) {
        // Supplementary figures withheld: the file keeps their columns empty,
        // as the page reads "—"; a view only they judge refuses.
        const next = withholding(list, withheld, error);
        if (next === null || !viewServes(list, next, state.viewId)) throw error;
        withheld = next;
      }
    }
  } catch (error) {
    return renderApplicationDiagnostic(422, { code: queryMessageCode(error) });
  }
  const coverage = result.listCoverage;
  if (!coverage || coverage.outputMode !== 'export')
    return renderApplicationDiagnostic(422, { code: 'QUERY_UNAVAILABLE' });
  if (coverage.hasMore || coverage.returnedCount !== coverage.totalCount)
    return renderApplicationDiagnostic(422, { code: 'LIST_EXPORT_OVER_LIMIT' });
  return Object.freeze({
    download: Object.freeze({
      body: declaredListCsv(list, result.records, (record, fieldId, value) => {
        // A band's value is a code; its declared label is what it means.
        const band = figureBandLabel(list, fieldId, value);
        if (band !== null) return band;
        const presented = displayFieldValue(view, record, fieldId, value);
        // Only an enumeration's label replaces its stored value in a file.
        return typeof value === 'string' &&
          presented !== value &&
          !Number.isFinite(Date.parse(value)) &&
          !/^-?\d+(\.\d+)?$/u.test(value)
          ? presented
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      }),
      contentType: 'text/csv; charset=utf-8' as const,
      fileName: exportFileName(surface.label, now),
    }),
    html: '',
    statusCode: 200,
  });
}

/** Sent by the owned script only; a cross-site form cannot set a header. */
export const FRAGMENT_REQUEST_HEADER = 'x-rain-fragment';

export interface SurfaceRuntimeFragmentResponse extends SurfaceRuntimeResponse {
  /** Repeat the action as the ordinary full-page submit instead. */
  readonly fallback?: true;
}

/**
 * ADR-0036 behaviour 7: one draft-editor reference field answered in place.
 * The same selection, binding, company scope and continuation checks as the
 * page decide it; the answer is escaped server HTML naming the one element it
 * replaces. Anything that is not an in-place answer -- an unknown surface, no
 * draft session, an expired buffer, a withheld save -- becomes `fallback`, and
 * the script then performs the ordinary submit, which answers it as a page.
 */
export async function submitSurfaceRuntimeFragment(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
  submission: SurfaceRuntimeSubmission,
  gateways: SurfaceRuntimeGateways,
): Promise<SurfaceRuntimeFragmentResponse> {
  assertRequestRuntimeView(view);
  const fallback = Object.freeze({
    html: '',
    statusCode: 409,
    fallback: true as const,
  });
  const selection = selectSurface(view, requestUrl);
  if (
    'statusCode' in selection ||
    !selection.selected.documentEditor ||
    !submission.draftSession
  )
    return fallback;
  let binding: CompiledSurfaceDataBinding;
  try {
    binding = readCompiledSurfaceDataBinding(view, selection.selected);
  } catch {
    return fallback;
  }
  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const scope = legalEntitySelectionForSurface(binding, url);
  if (scope.length !== 1) return fallback;
  try {
    const editor = await documentEditor(
      view,
      selection.selected,
      selection.surfaces,
      url,
      scope[0]!,
      gateways,
      submission,
      'fragment',
    );
    return editor?.fragment
      ? Object.freeze({ html: editor.html, statusCode: editor.statusCode })
      : fallback;
  } catch {
    return fallback;
  }
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
  // Existing continuations carry their own pinned authority and reauthorization.
  // Entry must not turn a committed, redacted Task/draft replay into a new failure.
  const entry =
    (selection.selected.composition &&
      submission.compositionAction &&
      submission.taskToken) ||
    (selection.selected.documentEditor && submission.draftSession)
      ? null
      : await resolveWorkspaceEntry(
          view,
          selection.selected,
          new URL(requestUrl, 'http://surface-runtime.local'),
          gateways.queryGateway,
        );
  if (entry?.invalid)
    return renderApplicationDiagnostic(422, {
      code: 'WORKSPACE_COMPANY_UNAVAILABLE',
    });
  if (selection.selected.composition && submission.compositionAction) {
    const workspaceContext = await loadWorkspaceContextBar(
      view,
      selection,
      binding,
      gateways.queryGateway,
      legalEntitySelectionForSurface(
        binding,
        new URL(requestUrl, 'http://surface-runtime.local'),
      ),
      new URL(requestUrl, 'http://surface-runtime.local'),
    );
    return submitCompositionAction(
      view,
      selection.selected,
      requestUrl,
      submission,
      gateways,
      (html, data, statusCode) =>
        data
          ? renderSelectedSurface(
              view,
              selection,
              {
                status: 'READY',
                records: [data.record],
                composition: data,
                compositionTask: html,
              },
              null,
              binding.operations,
              statusCode,
              data.scope ? [data.scope] : [],
              workspaceContext,
            )
          : {
              statusCode,
              html: shellDocument(
                view,
                selection.surfaces,
                selection.navigation,
                selection.selected,
                html,
              ),
            },
    );
  }
  if (selection.selected.documentEditor && submission.draftSession) {
    const url = new URL(requestUrl, 'http://surface-runtime.local');
    const scope = legalEntitySelectionForSurface(binding, url);
    if (scope.length !== 1)
      return operationDiagnostic('OPERATION_INPUT_INVALID', 422);
    try {
      const editor = await documentEditor(
        view,
        selection.selected,
        selection.surfaces,
        url,
        scope[0]!,
        gateways,
        submission,
      );
      if (!editor) return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
      const context = await loadWorkspaceContextBar(
        view,
        selection,
        binding,
        gateways.queryGateway,
        scope,
        url,
      );
      return editor.slots
        ? renderSelectedSurface(
            view,
            selection,
            {
              status: 'READY',
              records: editor.record ? [editor.record] : [],
              documentEditorSlots: editor.slots,
            },
            null,
            binding.operations,
            editor.statusCode,
            scope,
            context,
          )
        : editor;
    } catch (error) {
      return renderApplicationDiagnostic(422, {
        code: queryMessageCode(error),
      });
    }
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
    input = operationInput(
      view,
      selection.selected,
      operation,
      intent,
      submission,
      legalEntitySelectionForSurface(
        binding,
        new URL(requestUrl, 'http://surface-runtime.local'),
      ),
    );
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
        requestUrl,
      );
    } catch {
      return operationDiagnostic('OPERATION_CONFIRMATION_REQUIRED', 422);
    }
  }

  let result;
  try {
    result = await gateways.operationGateway.invoke(
      view,
      semanticOperationRequestFor(
        operation,
        input,
        submission.confirmationGrant ?? null,
        submission.idempotencyKey ?? '',
      ),
      gateways.operationMediation.issueInvocation(view, 'UI'),
    );
  } catch (error) {
    const ref = operationMessageRef(error);
    return renderApplicationDiagnostic(
      ref.code === 'OPERATION_PERMISSION_DENIED' ? 403 : 422,
      ref,
    );
  }
  if (result.outcome !== 'succeeded') {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }
  if (!result.readBack) {
    const ref = { code: 'OPERATION_COMMITTED_READBACK_WITHHELD' } as const;
    const evidence = result.trust
      ? Object.entries(result.trust)
          .map(
            ([name, id]) =>
              `<dt>${escapeHtml(name)}</dt><dd><code>${escapeHtml(id)}</code></dd>`,
          )
          .join('')
      : '';
    // A committed result with withheld data is not a failed command. Render
    // neither stale record values nor a form that could resubmit the effect.
    return Object.freeze({
      statusCode: 200,
      html: shellDocument(
        view,
        selection.surfaces,
        selection.navigation,
        selection.selected,
        `<section class="panel operation-feedback" role="status" data-operation-committed="true" ${messageAttributes(ref)}>${messageBody(ref, operation.label, 'h1')}<dl data-operation-trust>${evidence}</dl></section>`,
      ),
    });
  }

  if (
    gateways.applicationExtension?.refreshAfterOperation({
      binding,
      intent,
      surface: selection.selected,
      surfaces: selection.surfaces,
    }) === true
  )
    // An explicitly composed application contribution may request an
    // authoritative refresh. Ordinary lifecycle results retain their read-back
    // below: an archive must not query its now-inactive record as active.
    return renderSurfaceRuntimeWithData(view, requestUrl, gateways, {
      intent,
      label: operation.label,
      record: result.readBack,
      trustLinked: result.trust !== null,
    });

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
    Object.freeze({}),
    binding.relationInputs,
  );
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
  relationInputs: EntityRelationAuthority | null = null,
  relationPickers: SurfaceRelationPickerState | null = null,
  formReferences: Readonly<
    Record<string, SurfaceFormReferenceChoices>
  > | null = null,
): SurfaceRuntimeResponse {
  // Compact and full layouts are alternative renderings of these same slots;
  // a responsive implementation must never mount both at once.
  const renderedSlots = selected.slots.map((slot) =>
    renderRegisteredSurfaceComponent({
      data,
      feedback,
      ...(formReferences ? { formReferences } : {}),
      legalEntitySelection,
      operations,
      queryParameterValues,
      ...(relationInputs ? { relationInputs } : {}),
      ...(relationPickers ? { relationPickers } : {}),
      slot,
      surface: selected,
      surfaces,
      view,
    }),
  );
  const pageHeading =
    selected.archetype === 'list' || selected.archetype === 'record'
      ? ''
      : `<header class="surface-heading">
      <div>
        <h1>${escapeHtml(selected.label)}</h1>
      </div>
      <div class="surface-status" aria-label="Surface status roles">
        ${selected.statusRoles.map((role) => `<span data-status-role="${escapeHtml(role)}">${escapeHtml(role)}</span>`).join('')}
      </div>
    </header>`;
  const body = `${pageHeading}
    <div class="surface-grid" data-surface-archetype="${escapeHtml(selected.archetype)}">
      ${renderedSlots.map((result) => result.html).join('')}
    </div>`;
  // The one hash-pinned script also enhances draft-editor reference controls and
  // their create dialog, and is emitted only when this response renders one.
  // Matched inside a tag: escaped record text can never form `<... data-...`.
  const enhanceTaskDialog =
    /<[a-z]+\s[^>]*\bdata-(?:reference-control|editor-create)\b/u.test(body) ||
    (data.status === 'READY' &&
      selected.composition?.presentation?.task?.mode === 'nativeDialog' &&
      data.compositionTask?.includes('<dialog ') === true &&
      data.compositionTask.includes('data-composition-task'));

  return Object.freeze({
    html: shellDocument(
      view,
      surfaces,
      navigation,
      selected,
      body,
      workspaceContext,
      enhanceTaskDialog,
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

/**
 * A composed record page's get also states the relations its composition
 * names -- an invoice's sales order -- so a column can label it and a link
 * open it (`relationTargets`); a page naming none asks for none.
 */
function withCompositionRelations(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  args: RuntimeViewContract.ImmutableJsonValue | null,
): RuntimeViewContract.ImmutableJsonValue | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const relationTargets = compositionRelationTargets(view, surface);
  return relationTargets.length
    ? { ...args, relationTargets: [...relationTargets] }
    : args;
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
  /** The entry the page already resolved, so it is not proved twice. */
  resolved?: WorkspaceEntry | null,
): Promise<WorkspaceContextBar | null> {
  if (!selectedBinding.query.legalEntityScope) {
    // A record every company shares (an item) offers the companies its entry
    // admits; each choice opens the same record in that company.
    const recordId = currentUrl.searchParams.get('record');
    if (
      !recordId ||
      selection.selected.surfaceRole !== 'record' ||
      !selection.selected.workspace?.entry
    )
      return null;
    const entry =
      resolved !== undefined
        ? resolved
        : await resolveWorkspaceEntry(
            view,
            selection.selected,
            new URL(currentUrl),
            queryGateway,
          );
    if (!entry?.shared) return null;
    return Object.freeze({
      options: entry.options,
      parameterId: entry.parameter,
      preservedParameters: Object.freeze([['record', recordId] as const]),
      selectedRecordId: entry.selected,
      targetSurfaceId: selection.selected.surfaceId,
    });
  }
  const entityNamespace = selectedBinding.query.sourceEntityId.split(
    ':entity.',
    1,
  )[0];
  if (!entityNamespace) return null;
  const legalEntityId = `${entityNamespace}:entity.legal_entity`;
  const legalEntityList = pickerListSurfaceFor(
    view,
    selection.surfaces,
    legalEntityId,
  );
  if (!legalEntityList || legalEntityList.binding.query.legalEntityScope) {
    return null;
  }
  const owner = selection.selected.workspace?.ownerSurfaceId
    ? selection.surfaces.find(
        (surface) =>
          surface.surfaceId === selection.selected.workspace!.ownerSurfaceId,
      )
    : null;
  const targetSurface = owner
    ? { surface: owner, binding: readCompiledSurfaceDataBinding(view, owner) }
    : selection.selected.surfaceRole === 'list' ||
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

  const entry = await resolveWorkspaceEntry(
    view,
    selection.selected,
    currentUrl,
    queryGateway,
  );
  const enumeration = entry
    ? { options: entry.options }
    : await recordPickerOptions(view, legalEntityList, queryGateway, []);
  if (!enumeration) return null;
  return Object.freeze({
    options: enumeration.options,
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

interface PickerListSurface {
  readonly binding: CompiledSurfaceDataBinding;
  readonly surface: CompiledSurfaceDefinition;
}

interface RecordPickerEnumeration {
  readonly hasMore: boolean;
  readonly options: readonly SurfaceRelationPickerOption[];
}

/**
 * Exactly one active list surface is the candidate authority for one entity.
 * A worklist may read the same records beside the entity's own List; the
 * authority is then the List that owns the entity's Record workspace, and two
 * Lists with no such owner still refuse rather than one being chosen by order.
 */
function pickerListSurfaceFor(
  view: RuntimeViewContract.RequestRuntimeView,
  surfaces: readonly CompiledSurfaceDefinition[],
  targetEntityId: string,
): PickerListSurface | null {
  const candidates = surfaces.flatMap((surface) => {
    if (surface.surfaceRole !== 'list') return [];
    try {
      const binding = readCompiledSurfaceDataBinding(view, surface);
      return binding.query.lifecycle === 'active' &&
        binding.query.queryType === 'list' &&
        binding.query.sourceEntityId === targetEntityId
        ? [{ binding, surface }]
        : [];
    } catch {
      return [];
    }
  });
  if (candidates.length <= 1) return candidates[0] ?? null;
  const owners = recordWorkspaceOwners(view, surfaces, targetEntityId);
  const owned = candidates.filter((candidate) =>
    owners.has(candidate.surface.surfaceId),
  );
  return owned.length === 1 ? owned[0]! : null;
}

async function recordPickerOptions(
  view: RuntimeViewContract.RequestRuntimeView,
  target: PickerListSurface,
  queryGateway: SemanticQueryGateway,
  legalEntitySelection: readonly string[],
): Promise<RecordPickerEnumeration | null> {
  if (target.binding.query.queryType === 'aggregate') return null;
  // Labels only: a List read with per-row figures is enumerated through the
  // entity's plain list query, under that query's own company operand.
  const query = pickerEnumerationQuery(
    view,
    target.surface,
    target.binding.query,
  );
  const scope = query.legalEntityScope;
  if (scope && legalEntitySelection.length !== 1) return null;
  try {
    const result = await queryGateway.invoke(view, {
      arguments: {
        includeArchived: false,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: query.maximumResultCount,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: '',
          sort: [],
        },
        ...(scope
          ? { [scope.operand.parameterId]: legalEntitySelection[0]! }
          : {}),
      },
      queryId: query.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
    if (result.outcome !== 'exact') return null;
    const shared = requireSharedListResult(result);
    const displayFieldId = target.binding.displayFieldId;
    const options = shared.records
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
      hasMore: shared.listCoverage.hasMore,
      options: Object.freeze(options),
    });
  } catch {
    return null;
  }
}

async function loadRelationPickers(
  view: RuntimeViewContract.RequestRuntimeView,
  selection: SelectedSurface,
  selectedBinding: CompiledSurfaceDataBinding,
  queryGateway: SemanticQueryGateway,
  legalEntitySelection: readonly string[],
  currentUrl: URL,
): Promise<SurfaceRelationPickerState | null> {
  if (
    selection.selected.surfaceRole !== 'form' ||
    currentUrl.searchParams.has('record')
  ) {
    return null;
  }
  const authority = selectedBinding.relationInputs;
  if (authority.status === 'unavailable') {
    return Object.freeze({ status: 'unavailable' });
  }
  const pickers: SurfaceRelationPicker[] = [];
  for (const relation of authority.relationInputs) {
    // A generation-1 optional relation without a target cannot offer a false
    // choice. A required one makes the form unsatisfiable and refuses by name.
    if (relation.targetEntityId === null) {
      if (relation.required) {
        return Object.freeze({
          relationId: relation.relationId,
          status: 'refused',
        });
      }
      continue;
    }
    const target = pickerListSurfaceFor(
      view,
      selection.surfaces,
      relation.targetEntityId,
    );
    if (!target) {
      return Object.freeze({
        relationId: relation.relationId,
        status: 'refused',
      });
    }
    const enumeration = await recordPickerOptions(
      view,
      target,
      queryGateway,
      legalEntitySelection,
    );
    // `hasMore` is the completeness boundary. `truncatedByMaximum` is not an
    // independent refusal: a complete result remains complete even where the
    // request was clamped to the list's declared maximum.
    if (!enumeration || enumeration.hasMore) {
      return Object.freeze({
        relationId: relation.relationId,
        status: 'refused',
      });
    }
    pickers.push(
      Object.freeze({
        options: enumeration.options,
        relationId: relation.relationId,
        required: relation.required,
      }),
    );
  }
  return Object.freeze({ pickers: Object.freeze(pickers), status: 'ready' });
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
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  operation: CompiledSurfaceDataBinding['operations'][number],
  intent: SurfaceOperationIntent,
  submission: SurfaceRuntimeSubmission,
  legalEntitySelection: readonly string[],
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
    const systemInput = createSystemInput(operation, legalEntitySelection);
    return {
      recordId: submission.recordId ?? '',
      relations: relationInput(submission),
      ...systemInput,
      values,
    };
  }
  const recordId = submission.recordId ?? '';
  const expectedRevision = Number.parseInt(
    submission.expectedRevision ?? '',
    10,
  );
  const binding = recordLegalEntityBinding(
    view,
    operation.operationId,
    legalEntitySelection,
  );
  return intent === 'update'
    ? { expectedRevision, ...binding, patch: values, recordId }
    : { expectedRevision, ...binding, recordId };
}

/**
 * COMPANY-BOUND-WRITES. An update, archive, restore or transition of a
 * company-owned record carries the company the page was entered in, so the
 * provider acts only if the record is that company's. The record id and
 * revision are the caller's to choose; the company is the URL's, the same
 * operand the page read the record under. A company-owned write entered in no
 * single company is refused before invocation rather than sent unbound.
 */
function recordLegalEntityBinding(
  view: RuntimeViewContract.RequestRuntimeView,
  operationId: string,
  legalEntitySelection: readonly string[],
): Readonly<Record<string, string>> {
  const definition = parsePinnedOperationCatalog(
    view.projections.operation.payload,
  ).find((candidate) => candidate.operationId === operationId);
  if (!definition || !operationBindsRecordLegalEntity(view, definition))
    return Object.freeze({});
  if (legalEntitySelection.length !== 1) {
    throw new InvalidSurfaceSubmissionError(
      'a company-owned record write requires exactly one legal-entity operand',
    );
  }
  return Object.freeze({
    [RECORD_LEGAL_ENTITY_BINDING_ARGUMENT_KEY]: legalEntitySelection[0]!,
  });
}

function createSystemInput(
  operation: CompiledSurfaceDataBinding['operations'][number],
  legalEntitySelection: readonly string[],
): Readonly<Record<string, string>> {
  const argumentKey = operation.systemInputArgumentKey;
  if (argumentKey === null) {
    if (legalEntitySelection.length !== 0) {
      throw new InvalidSurfaceSubmissionError(
        'an unscoped create cannot accept a legal-entity operand',
      );
    }
    return Object.freeze({});
  }
  if (legalEntitySelection.length !== 1) {
    throw new InvalidSurfaceSubmissionError(
      'a scoped create requires exactly one legal-entity operand',
    );
  }
  return Object.freeze({ [argumentKey]: legalEntitySelection[0]! });
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
  // An omitted field is never rendered and never read: a submission naming
  // one changes nothing, as a key naming no form field never does.
  for (const fieldId of formFieldIds(surface)) {
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
  code: Exclude<
    OperationDiagnosticCode,
    'OPERATION_LEGAL_ENTITY_INACTIVE' | 'OPERATION_REFUSED'
  >,
  statusCode: number,
): SurfaceRuntimeResponse {
  return renderApplicationDiagnostic(statusCode, { code });
}

function renderConfirmationTransition(
  surface: CompiledSurfaceDefinition,
  operation: CompiledSurfaceDataBinding['operations'][number],
  submission: SurfaceRuntimeSubmission,
  grant: string,
  requestUrl: string,
): SurfaceRuntimeResponse {
  const requestLocation = new URL(requestUrl, 'http://surface-runtime.local');
  const action = `${requestLocation.pathname}${requestLocation.search}`;
  const preserved = Object.entries(submission)
    .filter(([key]) => key !== 'confirmationGrant' && key !== 'confirmed')
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm ${escapeHtml(operation.label)} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card" data-confirmation-step="preview"><p class="eyebrow">Operation preview</p><h1>Confirm ${escapeHtml(operation.label)}</h1><p>Review this ${escapeHtml(surface.label)} operation before it is executed.</p>${operation.capabilityId ? `<section data-predicted-effects="registered-capability"><strong>Predicted effects</strong><p>The registered capability <code>${escapeHtml(operation.capabilityId)}</code> will validate this draft and append its declared business facts. The screen will wait for the committed result.</p></section>` : ''}<form method="post" action="${escapeHtml(action)}">${preserved}<input type="hidden" name="confirmationGrant" value="${escapeHtml(grant)}"><button type="submit">Confirm ${escapeHtml(operation.label)}</button></form></main></body></html>`,
    statusCode: 200,
  });
}

/**
 * Every message renderer in this file takes a `SurfaceMessageRef` and nothing
 * else — no title, no message, no free code string. That is ADR-0048 §5's
 * structural companion: a hardcoded sentence is not caught after the fact, it
 * has nowhere to be passed.
 */
/**
 * A declared printable document as its own page: no navigation, commands or
 * script, only the document and a print stylesheet. The browser's Print command
 * prints it or saves it as PDF (owner ruling G).
 */
/** A printable document; it names the release that printed it. */
function printDocumentPage(
  view: RuntimeViewContract.RequestRuntimeView,
  title: string,
  body: string,
  statusCode: number,
): SurfaceRuntimeResponse {
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 2rain</title><style>${styles}</style></head><body class="standalone print-page"><main class="print-shell" data-release-id="${escapeHtml(view.release.releaseId)}" data-release-content-hash="${escapeHtml(view.release.contentHash)}" data-pointer-fence="${view.pointer.fence}">${body}</main></body></html>`,
    statusCode,
  });
}

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
  enhanceTaskDialog = false,
): string {
  const title = selected?.label ?? 'Release diagnostic';
  const navigation = navigationEntries(surfaces, compiledNavigation);
  const activeDestination = currentNavigationDestination(
    view,
    navigation,
    surfaces,
    selected,
  );
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
      </aside>
      <div class="workspace">
        <header class="topbar">
          <strong class="topbar__context">${escapeHtml(activeDestination ?? selected?.label ?? 'Workspace')}</strong>
          ${workspaceContext ? renderWorkspaceContextBar(workspaceContext) : ''}
          <div class="principal" aria-label="Signed-in principal">Signed in</div>
          <details class="shell-diagnostics"><summary>Diagnostics</summary><dl><dt>Tenant</dt><dd>${escapeHtml(view.tenantId)}</dd><dt>Environment</dt><dd>${escapeHtml(view.environmentId)}</dd><dt>Principal</dt><dd>${escapeHtml(view.principalId)}</dd><dt>Pinned release</dt><dd>${escapeHtml(view.release.releaseId)}</dd><dt>Release root</dt><dd>${escapeHtml(view.release.contentHash)}</dd><dt>Fence</dt><dd>${view.pointer.fence}</dd></dl></details>
        </header>
        <main id="surface-content" tabindex="-1">${body}</main>
      </div>
    </div>
    ${enhanceTaskDialog ? `<script>${SURFACE_CLIENT_SCRIPT}</script>` : ''}
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
    const destination = currentNavigationDestination(
      view,
      entry.children,
      surfaces,
      selected,
    );
    if (
      entry.children.length === 1 &&
      entry.children[0]?.kind === 'navigationSurface'
    ) {
      const surface = surfaceForNavigation(surfaces, entry.children[0]);
      return `<li class="navigation-node navigation-node--direct">${navigationLink(view, surface, selected, entry.label, workspaceContext, surfaces)}</li>`;
    }
    return `<li class="navigation-node navigation-node--group"><details class="navigation-group"${current ? ' data-current="true"' : ''}><summary><span class="nav-icon" aria-hidden="true">${escapeHtml(entry.label.slice(0, 1).toUpperCase())}</span><span class="nav-text"><span class="nav-group-label">${escapeHtml(entry.label)}</span>${destination && destination !== entry.label ? `<small>${escapeHtml(destination)}</small>` : ''}</span><span class="nav-arrow" aria-hidden="true">›</span></summary><ul class="navigation-children">${entry.children.map((child) => navigationItem(view, child, surfaces, selected, workspaceContext)).join('')}</ul></details></li>`;
  }
  const surface = surfaceForNavigation(surfaces, entry);
  return `<li class="navigation-node navigation-node--surface">${navigationLink(view, surface, selected, navigationLabel(surface), workspaceContext, surfaces)}</li>`;
}

function navigationLink(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition | null,
  label: string,
  workspaceContext: WorkspaceContextBar | null,
  surfaces: readonly CompiledSurfaceDefinition[],
): string {
  const current = selected?.workspace?.ownerSurfaceId
    ? selected.workspace.ownerSurfaceId === surface.surfaceId
    : selected
      ? surface.surfaceId === selected.surfaceId ||
        sharesSurfaceEntity(view, surface, selected, surfaces)
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
  return `<nav class="workspace-context-bar" aria-label="Company" data-shell-region="workspace-context-bar" data-scope-parameter-id="${escapeHtml(context.parameterId)}">
    <span class="workspace-context-bar__label">Company</span>
    <span class="workspace-context-bar__options">${
      context.options.length === 0
        ? '<span class="muted">No authorized active companies available. Contact your administrator for access or setup.</span>'
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

function currentNavigationDestination(
  view: RuntimeViewContract.RequestRuntimeView,
  entries: readonly CompiledNavigationEntry[],
  surfaces: readonly CompiledSurfaceDefinition[],
  selected: CompiledSurfaceDefinition | null,
): string | null {
  for (const entry of entries) {
    if (entry.kind === 'navigationGroup') {
      const label = currentNavigationDestination(
        view,
        entry.children,
        surfaces,
        selected,
      );
      if (label) return label;
    } else if (navigationEntryIsCurrent(view, entry, surfaces, selected))
      return navigationLabel(surfaceForNavigation(surfaces, entry));
  }
  return null;
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
        surfaces,
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
  return surface.workspace
    ? surface.workspace.membership !== 'contextual'
    : surface.surfaceRole === 'list' ||
        (surface.surfaceRole === null &&
          (surface.archetype === 'list' ||
            surface.archetype === 'home' ||
            surface.archetype === 'task'));
}

/**
 * Whether a navigation List stands for the selected surface's records. A
 * selected List is its own destination, so a worklist over the same records
 * beside it is not current; and where several Lists read one entity, only the
 * List that owns the entity's Record workspace stands for its records.
 */
function sharesSurfaceEntity(
  view: RuntimeViewContract.RequestRuntimeView,
  navigation: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
): boolean {
  if (navigation.surfaceRole !== 'list') return false;
  try {
    const entityId = readCompiledSurfaceDataBinding(view, selected).query
      .sourceEntityId;
    if (
      readCompiledSurfaceDataBinding(view, navigation).query.sourceEntityId !==
      entityId
    )
      return false;
    if (selected.surfaceRole === 'list')
      return navigation.surfaceId === selected.surfaceId;
    const lists = surfaces.filter((candidate) => {
      if (candidate.surfaceRole !== 'list') return false;
      try {
        return (
          readCompiledSurfaceDataBinding(view, candidate).query
            .sourceEntityId === entityId
        );
      } catch {
        return false;
      }
    });
    return (
      lists.length <= 1 ||
      recordWorkspaceOwners(view, surfaces, entityId).has(navigation.surfaceId)
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
.nav-text small{display:block;font-size:var(--text-micro);font-weight:var(--weight-body)}
.release-card{display:flex;gap:var(--space-2);align-items:flex-start;margin-top:auto;padding:var(--space-3);border:1px solid var(--line-on-rail);border-radius:var(--radius-container)}
.release-card__pulse{width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--brand)}
.release-card small,.release-card strong,.release-card span{display:block}
.release-card small{color:var(--ink-on-rail-muted);font-size:var(--text-micro);text-transform:uppercase;letter-spacing:.08em}
.release-card strong{margin:var(--space-1) 0;color:var(--ink-on-rail)}
.release-card span{color:var(--ink-on-rail-muted);font-size:var(--text-micro)}
.workspace{min-width:0}
.topbar{position:relative;min-height:56px;display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-2) var(--page-padding);border-bottom:1px solid var(--line);background:var(--surface-panel);color:var(--ink-muted);font-size:var(--text-body)}
.shell-diagnostics summary{display:flex;align-items:center;min-height:44px;cursor:pointer;font-size:var(--text-micro)}
.shell-diagnostics dl{position:absolute;z-index:5;top:100%;right:var(--page-padding);width:min(36rem,calc(100vw - 32px));max-height:70dvh;overflow:auto;background:var(--surface-panel);border:1px solid var(--line);border-radius:var(--radius-container);padding:var(--space-4);box-shadow:var(--elevation-overlay);margin:0}
.shell-diagnostics dt{font-weight:var(--weight-emphasis)}
.shell-diagnostics dd{font-family:var(--font-mono);font-size:var(--text-micro);margin:0 0 var(--space-2);overflow-wrap:anywhere}
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
.command-bar:has([data-save-boundary]){flex-wrap:wrap}
.command-bar [data-save-boundary]{flex-basis:100%;margin:0}
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
/* WAREHOUSE-MODE: a launcher's tiles and scan box are large targets read at arm's length on a warehouse tablet. */
.launcher-tiles ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3);margin:0;padding:0;list-style:none}
.launcher-tile{display:flex;flex-direction:column;gap:var(--space-1);min-height:144px;height:100%;padding:var(--space-4);border:1px solid var(--line-strong);border-radius:var(--radius-container);background:var(--surface-panel);color:var(--ink);text-decoration:none}
.launcher-tile:hover{background:var(--accent-soft)}
.launcher-tile:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.launcher-tile__label{color:var(--accent-ink);font-size:var(--text-section)}
.launcher-tile__count{font-size:var(--text-title);font-weight:var(--weight-emphasis);font-variant-numeric:tabular-nums}
.launcher-tile__view{color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);text-transform:uppercase;letter-spacing:.07em}
.launcher-tile__description{margin-top:auto;color:var(--ink-muted);font-size:var(--text-body)}
.launcher-scan__field{display:grid;gap:var(--space-2);font-size:var(--text-section)}
.launcher-scan__field input{min-height:56px;padding:0 var(--space-3);font-size:var(--text-section);font-family:var(--font-mono)}
.launcher-scan__message{margin-top:var(--space-3)}
.launcher-action button{min-height:56px}
@media(max-width:800px){.launcher-tiles ul{grid-template-columns:minmax(0,1fr)}.launcher-tile{min-height:96px}.launcher-action button{width:100%}}
.data-table-wrap{margin-top:var(--space-4);overflow-x:auto}
.data-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:var(--text-body)}
.data-table-wrap th{height:var(--row-header-height);padding:0 var(--space-3);border-bottom:1px solid var(--line);color:var(--ink-muted);font-size:var(--text-micro);text-transform:uppercase;letter-spacing:.08em;vertical-align:middle}
.data-table-wrap td{height:var(--row-height);padding:0 var(--space-3);border-bottom:1px solid var(--line);vertical-align:middle}
.data-table-wrap tbody tr:hover{background:var(--accent-soft)}
.data-table-wrap td:has(.cell-numeric){text-align:right}
.record-link{color:var(--accent-ink);font-weight:var(--weight-emphasis)}
.list-pagination{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:var(--space-2);margin-top:var(--space-3)}
.list-views{grid-column:span 12}
.list-views ul{display:flex;flex-wrap:wrap;gap:var(--space-1);padding:0;margin:0 0 var(--space-3);list-style:none;border-bottom:1px solid var(--line)}
.list-view{display:inline-flex;align-items:center;gap:var(--space-2);min-height:44px;padding:0 var(--space-3);border-bottom:3px solid transparent;color:var(--ink-muted);font-weight:var(--weight-emphasis);text-decoration:none}
.list-view:hover{color:var(--ink)}
.list-view[aria-current=page]{border-bottom-color:var(--accent-ground);color:var(--ink)}
.list-view:focus-visible,.list-sort:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.list-view__count{padding:0 var(--space-2);border-radius:999px;background:var(--surface-sunken);color:var(--ink-muted);font-size:var(--text-micro)}
.list-controls{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:flex-end;margin-bottom:var(--space-3)}
.list-controls .form-field{margin:0}
.list-controls__search{flex:1 1 16rem}
.list-controls__actions{display:flex;gap:var(--space-2);align-items:center;min-height:44px}
.list-summary{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center;justify-content:flex-end}
.list-sort{display:inline-flex;gap:var(--space-1);align-items:center;min-height:44px;color:inherit;text-decoration:none}
.list-page-status{color:var(--ink-muted);font-size:var(--text-body)}
.list-page-jump{display:inline-flex;gap:var(--space-2);align-items:center}
.list-pagination .list-page-jump input{width:5rem;min-height:44px}
.list-export--refused{margin:0;color:var(--ink-muted);font-size:var(--text-body)}
.list-controls .form-field>label{display:grid;gap:var(--space-1)}
.list-controls .form-field>label[for]{font-weight:var(--weight-emphasis)}
.data-table-wrap td[data-column-priority="0"] .record-link{white-space:nowrap}
@media(max-width:800px){.list-views ul{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin}.list-view{white-space:nowrap}.list-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}.list-controls__search{grid-column:1/-1}.list-controls__actions{align-self:end}.list-summary{justify-content:flex-start}}
.list-page-link{display:inline-grid;place-items:center;min-height:44px;padding:var(--space-2) var(--space-4);border-radius:var(--radius-control);background:var(--accent-ground);color:var(--ink-on-accent);font-size:var(--text-body);font-weight:var(--weight-emphasis);text-decoration:none}
.list-page-link:hover{background:var(--accent-ground-hover)}
.list-page-link:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.record-fields,.key-fact-grid{display:grid;gap:var(--space-2);margin:var(--space-4) 0}
.record-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
.key-fact-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.key-facts-panel{grid-column:span 12}
.record-fields dd{margin:var(--space-1) 0 0}
.form-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);margin:var(--space-4) 0}
/* Draft document editor. The line table and create form sit inside .form-fields so their controls use the already-measured focus rings; this block declares no new focus-ring selectors. */
table.draft-lines.form-fields{display:table;width:100%;margin:0;border-collapse:separate;border-spacing:0 var(--space-2);table-layout:fixed}
.draft-lines th{padding:0 var(--space-2) var(--space-1);text-align:left;font-size:var(--text-body);font-weight:600;color:var(--ink-muted)}
.draft-lines__heading--reference{width:46%}.draft-lines__heading--value{width:17%}.draft-lines__heading--derived{width:10%}.draft-lines__heading--remove{width:6.5rem}
.draft-line__cell{padding:var(--space-2);vertical-align:top;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--surface-panel)}
.draft-line__cell:first-child{border-left:1px solid var(--line);border-radius:var(--radius-control) 0 0 var(--radius-control)}
.draft-line__cell:last-child{border-right:1px solid var(--line);border-radius:0 var(--radius-control) var(--radius-control) 0;text-align:right}
.draft-line__cell input,.draft-line__cell select{width:100%;min-width:0}
.draft-line--removed td{padding:var(--space-2);color:var(--ink-muted)}
.derived-value{display:inline-flex;align-items:center;min-height:44px;font-weight:600;color:var(--ink-strong)}.derived-empty{font-weight:400;color:var(--ink-muted)}
.reference-control{display:grid;gap:var(--space-2)}.reference-search{position:relative;display:flex;flex-wrap:wrap;gap:var(--space-2)}.reference-search input{flex:1 1 12rem;min-width:0}.reference-lookup{display:grid;flex-basis:100%;gap:var(--space-2)}.reference-status:empty{display:none}.reference-status p{margin:0}.reference-selected-detail{color:var(--ink-muted)}
/* Enhanced (ADR-0036 behaviour 7): the lookup becomes a bounded popup under the box; Search is the no-script path. */
body[data-reference-enhanced] [data-reference-submit]{display:none}
body[data-reference-enhanced] .reference-lookup{display:none}
body[data-reference-enhanced] [data-reference-open] .reference-lookup{display:grid;position:absolute;z-index:6;top:calc(100% + 2px);left:0;right:0;gap:0;padding:var(--space-1);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);box-shadow:var(--elevation-overlay)}
body[data-reference-enhanced] [data-reference-open] .reference-results{max-height:18rem;padding:0;border:0}
body[data-reference-enhanced] [data-reference-field][aria-busy="true"] .reference-search input{cursor:progress}
.reference-option[aria-selected="true"],.reference-create[aria-selected="true"],.reference-more[aria-selected="true"]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent-ground)}
.reference-results{display:grid;gap:2px;max-height:16rem;margin:0;padding:var(--space-1);overflow:auto;list-style:none;border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel)}
.reference-option{display:grid;gap:2px;width:100%;min-height:44px;padding:var(--space-2);text-align:left;border:0;border-radius:var(--radius-control);background:transparent;color:var(--ink);cursor:pointer}
.reference-option:hover{background:var(--surface-sunken)}.reference-option small,.reference-selected small{color:var(--ink-muted)}
.reference-empty{padding:var(--space-2);color:var(--ink-muted)}.reference-limit{margin:0}
.reference-create{display:block;width:100%;min-height:44px;padding:var(--space-2);border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;color:var(--accent-ink);font-weight:600;text-align:left;cursor:pointer}.reference-create:hover{background:var(--surface-sunken)}.reference-more{width:100%;text-align:left}
.reference-selected{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-height:44px;padding:var(--space-1) var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-sunken)}.reference-selected__text{display:grid}
.link-action{min-height:44px;padding:var(--space-1);border:0;background:transparent;color:var(--accent-ink);text-decoration:underline;cursor:pointer}
.form-field--wide{grid-column:1/-1}.draft-header textarea,.editor-create__fields textarea{width:100%;resize:vertical}
.field-error{display:block;margin-top:var(--space-1);color:var(--status-blocked-ink);font-size:var(--text-body);font-weight:600;letter-spacing:normal;text-transform:none}
.draft-lines [aria-invalid="true"],.draft-header [aria-invalid="true"]{border-color:var(--status-blocked-ink)}
.draft-note{margin:0 0 var(--space-3);padding:var(--space-2) var(--space-3);border-left:3px solid var(--status-attention-ink);border-radius:var(--radius-control);background:var(--status-attention-ground);color:var(--status-attention-ink)}.draft-note p{margin:0}
.draft-note--done{border-left-color:var(--status-success-ink);background:var(--status-success-ground);color:var(--status-success-ink)}.draft-note--problem{border-left-color:var(--status-blocked-ink);background:var(--status-blocked-ground);color:var(--status-blocked-ink)}
.editor-create__fields input:disabled,.editor-create__fields textarea:disabled,.draft-header input:disabled,.draft-header select:disabled,.draft-header textarea:disabled,.draft-lines input:disabled{background:var(--surface-sunken);color:var(--ink-muted);cursor:not-allowed}
.draft-create-resume{grid-column:1/-1;margin:0 0 var(--space-3)}.draft-create-resume[hidden]{display:none}
.draft-paused{margin:0 0 var(--space-3);padding:var(--space-2) var(--space-3);border-left:3px solid var(--accent-ground);background:var(--surface-sunken)}
.editor-create{width:calc(100% - 2 * var(--space-4));max-width:42rem;margin:var(--space-4) auto;padding:var(--space-5);border:1px solid var(--line-strong);border-radius:var(--radius-container);background:var(--surface-panel);color:var(--ink)}
.editor-create::backdrop{background:rgb(0 0 0 / 35%)}.editor-create__header{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)}.editor-create__header h2{margin:0}
.editor-create__explanation{color:var(--ink-muted)}
/* The house .form-fields span rule styles labels as micro caps. Editor labels stay readable sentence case, and record data inside the editor is never transformed. */
.draft-header .form-field__label,.draft-lines th{font-size:var(--text-body);font-weight:600;letter-spacing:normal;text-transform:none;color:var(--ink)}
.draft-lines .derived-empty,.draft-lines .derived-value,.reference-control span,.reference-selected span{font-size:inherit;letter-spacing:normal;text-transform:none}
.draft-header textarea,.editor-create__fields textarea{padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--ink);font:inherit;font-weight:400}
/* Without JavaScript the create form stays in the page flow rather than overlapping it. */
.editor-create[open]:not(:modal){position:static;inset:auto;grid-column:1/-1;box-sizing:border-box;width:100%;max-width:none;margin:0 0 var(--space-4)}.editor-create__footer{display:flex;justify-content:flex-start;gap:var(--space-2);margin-top:var(--space-4)}
.form-field{display:grid;align-content:start;gap:var(--space-2)}
.form-fields label{display:grid;gap:var(--space-1)}
[data-document-editor] fieldset,[data-draft-line]{min-width:0;margin:var(--space-4) 0;padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius-control)}
.form-fields .form-empty-intent{padding-top:var(--space-1)}
.form-unavailable-value{display:block;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-sunken);color:var(--ink-muted);font-size:var(--text-body);line-height:1.45}
.form-unavailable-value code{color:var(--ink);overflow-wrap:anywhere}
.form-fields input,.form-fields select,.list-controls input,.list-controls select,.list-page-jump input{width:100%;min-height:44px;padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--ink);font:inherit}
.form-fields input[type="checkbox"]{width:24px;height:24px;min-height:24px;padding:0;justify-self:start;margin:10px 0}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
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
@media print{body *{visibility:hidden}.packing-document,.packing-document *{visibility:visible}.packing-document{position:absolute;inset:0;width:100%;border:0;box-shadow:none}.print-guidance{display:none}}
.print-page main{width:min(900px,100%);margin:0 auto;padding:var(--space-6) var(--page-padding)}
.print-document{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-5);color:var(--ink);background:var(--surface-panel);padding:var(--space-6);border:1px solid var(--line);border-radius:var(--radius-container)}
.print-header h1{margin:var(--space-1) 0}
.print-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:var(--space-3);margin:var(--space-3) 0 0}
.print-facts dt{color:var(--ink-muted);font-size:var(--text-micro);text-transform:uppercase;letter-spacing:.08em}
.print-facts dd{margin:0;font-weight:var(--weight-emphasis)}
.print-section table{width:100%;border-collapse:collapse;font-size:var(--text-body)}
.print-section th,.print-section td{padding:var(--space-2);border-bottom:1px solid var(--line);text-align:left}
.print-count,.print-footer{color:var(--ink-muted);font-size:var(--text-micro)}
.print-note{white-space:pre-wrap}
.print-table{overflow-x:auto}
@media print{.print-table{overflow:visible}}
.print-block h2{margin:0 0 var(--space-1);color:var(--ink-muted);font-size:var(--text-micro);text-transform:uppercase;letter-spacing:.08em}
.print-block p{margin:0}
.print-totals{display:grid;gap:var(--space-1);justify-self:end;min-width:16rem;margin:0}
.print-totals div{display:flex;justify-content:space-between;gap:var(--space-4)}
.print-totals dt{color:var(--ink-muted)}
.print-totals dd{margin:0;font-variant-numeric:tabular-nums}
.print-totals div:last-child{border-top:1px solid var(--line);padding-top:var(--space-1);font-weight:var(--weight-emphasis)}
@media print{.print-page main{padding:0}.print-page .print-document,.print-page .print-document *{visibility:visible}.print-page .print-document{border:0;padding:0}}
@media(max-width:800px){table.draft-lines.form-fields,.draft-lines tbody,.draft-lines tr,.draft-lines td{display:block;width:auto}.draft-lines thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.draft-line{margin-bottom:var(--space-3);padding:var(--space-2) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}.draft-line__cell,.draft-line__cell:first-child,.draft-line__cell:last-child{padding:var(--space-1) 0;border:0;border-radius:0;background:transparent;text-align:left}.draft-line__cell::before{content:attr(data-label);display:block;margin-bottom:var(--space-1);font-weight:600;color:var(--ink-muted)}.draft-line__cell--remove::before{content:none}.editor-create__fields{grid-template-columns:minmax(0,1fr)}
body{padding-bottom:72px}
.app-shell{display:block}
.sidebar{position:fixed;z-index:4;top:auto;right:0;bottom:0;left:0;width:100%;height:auto;padding:var(--space-1);border-top:1px solid var(--line-on-rail);background:var(--surface-rail)}
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
.composition-actions{width:100%;min-width:0}
.composition-actions .command-bar{flex-wrap:wrap;position:static;box-shadow:none}
.composition-actions a.button{display:inline-flex;align-items:center;min-height:44px;padding:var(--space-2) var(--space-4);border:1px solid var(--line);border-radius:var(--radius-control)}
.composition-inputs{display:grid;gap:var(--space-4);max-width:40rem}
.composition-inputs label{display:grid;gap:var(--space-2)}
[data-composition-task] button,[data-composition-task] input,[data-composition-task] select,[data-composition-dataset] a{min-height:44px}
[data-composition-dataset] td{overflow-wrap:anywhere}
[data-composition-dataset] a{display:inline-flex;align-items:center}
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

.composition-task-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
.composition-task-layout .record-fields div{padding:var(--space-2)}
.composition-task-layout .record-fields{margin:var(--space-2) 0}
.composition-task-layout pre{white-space:pre-wrap;overflow-wrap:anywhere}
.composition-section-links summary{min-height:44px;display:flex;align-items:center;cursor:pointer}
.composition-section-links summary::before{content:'▸';margin-right:var(--space-2)}
.composition-section-links[open] summary::before{content:'▾'}
@media(max-width:800px){.composition-task-layout{grid-template-columns:minmax(0,1fr)}.composition-task-layout .record-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* Canonical composition presentation; shared across every Record module. */
.composition-header{grid-column:1/-1;padding:var(--space-5);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.composition-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}
.composition-heading h1{margin:0;font-size:var(--text-title);overflow-wrap:anywhere}
.composition-business-status{border:1px solid var(--line);border-radius:var(--radius-control);padding:var(--space-1) var(--space-2);font-weight:var(--weight-emphasis)}
.composition-business-status::before{content:'●';margin-right:var(--space-2);color:var(--ink-muted)}
.composition-subtitle{margin:var(--space-2) 0;font-size:var(--text-body)}
.composition-header-facts{display:flex;flex-wrap:wrap;gap:var(--space-3);margin:0}
.composition-header-facts div{display:flex;gap:var(--space-2);flex-wrap:wrap}
.composition-header-facts dt,.composition-cell-label{color:var(--ink-muted)}
.composition-header-facts dd{margin:0;overflow-wrap:anywhere}
.composition-context{grid-column:1/-1;padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.composition-context h2{font-size:var(--text-section);margin:0}
.composition-context p{margin:var(--space-1) 0}
.composition-context nav{display:flex;flex-wrap:wrap;gap:var(--space-3)}
.composition-context-links{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-3)}
.composition-context-overflow summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--ink-muted)}
.composition-context-overflow[open]{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control)}
.composition-back{grid-column:1/-1;width:fit-content}
.composition-context a,.composition-back{display:inline-flex;align-items:center;min-height:44px}
.composition-record-actions{grid-column:1/-1}
.composition-record-actions>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--ink-muted)}
.composition-record-actions>summary::before{content:'▸';margin-right:var(--space-2)}
.composition-record-actions[open]>summary::before{content:'▾'}
.composition-collection{margin-bottom:var(--space-3);scroll-margin-top:var(--space-3)}
.composition-collection table{width:100%;table-layout:auto}
.composition-collection th,.composition-collection td{white-space:normal;overflow-wrap:anywhere}
.composition-cell-secondary{display:flex;gap:var(--space-2);flex-wrap:wrap;font-size:var(--text-body);font-weight:var(--weight-body);margin-top:var(--space-1)}
.composition-cell-secondary>span{display:block}
.composition-quantity,.composition-collection td[data-cell-role=quantity]{text-align:right;font-variant-numeric:tabular-nums}
.composition-description{color:var(--ink-muted);margin:var(--space-2) 0}
.composition-context-heading,.composition-collection-heading{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap}
.composition-local-actions{display:flex;flex-wrap:wrap;gap:var(--space-2)}
.composition-local-actions>div{flex:1 1 16rem}
.composition-local-actions p{margin:var(--space-2) 0;color:var(--ink-muted)}
.composition-collection td[data-cell-role=actions] a,.composition-collection summary{display:inline-flex;align-items:center;min-height:44px}
.composition-collection tr[data-selected=true]{background:var(--surface-sunken)}
.composition-collection [data-resolution=empty] h2{font-size:var(--text-body)}
.composition-collection{padding:var(--space-4)}
.composition-collection .data-table-wrap{margin:var(--space-2) calc(-1 * var(--space-4)) calc(-1 * var(--space-4));padding-bottom:var(--space-2)}
.composition-collection td[data-cell-role=primary]{min-width:12rem}
.composition-collection th,.composition-collection td{white-space:nowrap;overflow-wrap:normal}
.composition-cell-secondary{font-size:var(--text-micro);color:var(--ink-muted)}
.composition-task-resume{grid-column:1/-1;display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.composition-task-resume[hidden]{display:none}
.composition-task-resume>div{flex:1}.composition-task-resume span{display:block;color:var(--ink-muted)}
.composition-task-dialog{grid-column:1/-1;position:static;width:100%;max-width:44rem;box-sizing:border-box;margin:0 auto;padding:0;color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel)}
.composition-task-dialog:modal{position:fixed;margin:auto;max-height:calc(100dvh - 32px);width:calc(100vw - 32px);overflow-y:auto;overscroll-behavior:contain;box-shadow:var(--elevation-overlay)}
.composition-task-dialog::backdrop{background:rgba(0,0,0,.45)}
.composition-task-header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;gap:var(--space-3);padding:var(--space-4);border-bottom:1px solid var(--line);background:var(--surface-panel)}
.composition-task-header p{margin:0 0 var(--space-1);font-size:var(--text-micro);color:var(--ink-muted)}
.composition-task-header h2{margin:0 0 var(--space-1);font-size:var(--text-section)}
.composition-task-header button{flex:none;align-self:flex-start;font-size:var(--text-section)}
.composition-task-header button[hidden]{display:none}
.composition-task-body{padding:var(--space-4)}
.composition-task-context{padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-sunken);margin-bottom:var(--space-4)}
.composition-task-context h3{font-size:var(--text-micro);margin:0 0 var(--space-2);color:var(--ink-muted)}
.composition-task-context .record-fields{display:flex;flex-wrap:wrap;gap:var(--space-3);margin:0}
.composition-task-context .record-fields div{padding:0;background:transparent;min-width:5rem}
.composition-task-context .record-fields dt{font-size:var(--text-micro);letter-spacing:0;text-transform:none;font-weight:var(--weight-body)}
.composition-task-context .record-fields dd{font-size:var(--text-body)}
.composition-task-context section+section{margin-top:var(--space-3);padding-top:var(--space-3);border-top:1px solid var(--line)}
.composition-task-consequence{margin:var(--space-3) 0;color:var(--ink-muted)}
.composition-task-result{margin-bottom:var(--space-4);padding:var(--space-3);border-left:3px solid var(--status-success-ink);border-radius:var(--radius-control);background:var(--status-success-ground);color:var(--status-success-ink)}.composition-task-result h3{margin:0 0 var(--space-2);font-size:var(--text-section)}.composition-task-result dd,.composition-task-result dt{color:var(--status-success-ink)}
.composition-task-summary,.composition-task-confirmation{margin-bottom:var(--space-4);padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-sunken)}
.composition-task-summary>strong{margin-right:var(--space-2)}
.composition-task-summary p,.composition-task-confirmation p{margin:var(--space-2) 0 0}
.composition-task-confirmation h3{font-size:var(--text-title);margin:0}
.composition-task-support{margin-top:var(--space-3)}
.composition-task-support>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--ink-muted)}
.composition-task-support .record-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.composition-inputs{display:grid;gap:var(--space-4)}
.composition-inputs .field{display:grid;gap:var(--space-2);font-weight:var(--weight-emphasis)}
.composition-inputs .composition-input{display:grid;gap:var(--space-1)}
.composition-task-dialog:modal{scroll-padding-bottom:7rem}
.composition-inputs input,.composition-inputs select,.composition-inputs textarea{scroll-margin-bottom:7rem}
.draft-header>.form-field:not(.form-field--reference){gap:var(--space-1)}
.editor-create__duplicates{margin:var(--space-3) 0;padding:var(--space-3);border-left:4px solid var(--status-attention-ink);border-radius:var(--radius-control);background:var(--status-attention-ground);color:var(--ink)}
.editor-create__duplicates p{margin:0 0 var(--space-2)}.editor-create__duplicates ul{margin:0 0 var(--space-2);padding-left:var(--space-5)}
.composition-inputs .derived-value{min-height:auto}.composition-inputs .field-error{font-weight:600}
.composition-inputs textarea{width:100%;box-sizing:border-box;padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--ink);font:inherit}
.composition-inputs input,.composition-inputs select{width:100%;box-sizing:border-box;min-height:44px;padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--ink);font:inherit}
.composition-reviewed-inputs{display:flex;gap:var(--space-5);flex-wrap:wrap;margin:var(--space-4) 0}
.composition-reviewed-inputs dt{color:var(--ink-muted);font-size:var(--text-micro)}
.composition-reviewed-inputs dd{margin:var(--space-1) 0;font-weight:var(--weight-emphasis)}
.composition-task-footer{position:sticky;bottom:0;z-index:1;display:flex;justify-content:flex-end;gap:var(--space-2);padding:var(--space-3) 0;background:var(--surface-panel);flex-wrap:wrap}
.composition-task-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--text-micro)}
/* A record's exception banner and its progression (ORDER-PARITY). */
.composition-alert{grid-column:1/-1;display:flex;gap:var(--space-3);align-items:flex-start;padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-left:4px solid var(--status-attention-ink);border-radius:var(--radius-container);background:var(--status-attention-ground);color:var(--ink)}
.composition-alert h2{margin:0;font-size:var(--text-section)}
.composition-alert p{margin:var(--space-1) 0}
.composition-alert ul{margin:var(--space-2) 0 0;padding-left:var(--space-5)}
.composition-alert li{overflow-wrap:anywhere}
.composition-alert-marker,.composition-progression-marker{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;font-weight:var(--weight-emphasis)}
.composition-alert-marker{background:var(--status-attention-ink);color:var(--surface-panel)}
.composition-progression{grid-column:1/-1;padding:var(--space-4)}
.composition-progression h2{margin:0;font-size:var(--text-section)}
.composition-progression .eyebrow{margin:0}
.composition-progression-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:var(--space-2);margin:var(--space-3) 0 0;padding:0;list-style:none}
.composition-progression-steps>li{display:flex;gap:var(--space-2);align-items:flex-start;min-width:0;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control)}
.composition-progression-steps>li[data-step-state=current]{border-color:var(--accent-edge);background:var(--accent-soft)}
.composition-progression-steps>li[data-step-state=attention]{border-color:var(--status-attention-ink);background:var(--status-attention-ground)}
.composition-progression-steps>li[data-step-state=stopped],.composition-progression-steps>li[data-step-state=upcoming]{color:var(--ink-muted)}
.composition-progression-marker{border:1px solid var(--line-strong)}
.composition-progression-steps>li[data-step-state=complete] .composition-progression-marker{border-color:var(--status-success-ink);background:var(--status-success-ground);color:var(--status-success-ink)}
.composition-progression-steps>li[data-step-state=attention] .composition-progression-marker{border-color:var(--status-attention-ink);color:var(--status-attention-ink)}
.composition-progression-state{display:block;font-size:var(--text-micro);color:var(--ink-muted)}
.composition-progression-steps strong{display:block;overflow-wrap:anywhere}
.composition-progression-documents{display:flex;flex-wrap:wrap;gap:0 var(--space-2);margin:var(--space-1) 0 0;padding:0;list-style:none}
.composition-progression-documents a{display:inline-flex;align-items:center;min-height:44px}
.composition-progression-next{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:var(--space-3);margin-top:var(--space-3);padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-sunken)}
.composition-progression-next>div{flex:1 1 16rem;min-width:0}
.composition-progression-next p{margin:var(--space-1) 0}
.composition-progression-next form{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.composition-progression-next button{min-height:44px}
.composition-task-rows{min-width:0;margin:0;padding:0;border:0}
.composition-task-rows legend{padding:0;font-weight:var(--weight-emphasis)}
.composition-task-rows>button{margin-top:var(--space-2)}
.composition-task-rows td input{min-width:6rem}
.composition-task-rows-review caption{padding:var(--space-2) 0;text-align:left;font-weight:var(--weight-emphasis)}
@media(max-width:800px){
.composition-heading{gap:var(--space-2)}
.composition-heading h1{font-size:var(--text-title)}
.composition-header-facts{font-size:var(--text-body)}
.composition-context nav{gap:var(--space-2);flex-wrap:wrap}
.composition-record-actions .command-bar{position:static;flex-wrap:wrap;box-shadow:none}
.data-table-wrap tr[data-presented-row=true]{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.data-table-wrap tr[data-presented-row=true] td{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-width:0}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=primary]{grid-column:1/-1}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=primary]::before{display:none}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=detail],.data-table-wrap tr[data-presented-row=true] td[data-cell-role=actions]{grid-column:1/-1}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=detail]::before,.data-table-wrap tr[data-presented-row=true] td[data-cell-role=actions]::before{display:none}
.composition-collection .data-table-wrap:not([data-compact=scrollTable]) td{white-space:normal;overflow-wrap:anywhere}
.composition-collection .data-table-wrap:not([data-compact=scrollTable]) td[data-cell-role=actions]{display:flex;flex-direction:row;justify-content:space-between;align-items:center;flex-wrap:wrap}
.composition-collection .data-table-wrap:not([data-compact=scrollTable]) td[data-cell-role=actions] form{flex:1}
.composition-local-actions{display:flex;align-items:center}
.composition-local-actions button{width:100%;min-height:44px}
.composition-task-dialog:modal{max-height:calc(100dvh - 16px);width:calc(100vw - 16px)}
.composition-task-footer button{flex:1;min-height:44px}
.composition-task-dialog:not(:modal) .composition-task-footer{bottom:80px}
.data-table-wrap[data-compact=scrollTable]{overflow-x:auto}
.data-table-wrap[data-compact=scrollTable] table{display:table;width:100%}
.data-table-wrap[data-compact=scrollTable] tbody{display:table-row-group}
.data-table-wrap[data-compact=scrollTable] thead{display:table-header-group;position:static;width:auto;height:auto;overflow:visible;clip:auto}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true]{display:table-row;margin:0;padding:0;border:0;background:transparent}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true] td{display:table-cell;height:var(--row-height);padding:0 var(--space-3);border-bottom:1px solid var(--line);text-align:left}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true] td[data-cell-role=quantity]{text-align:right}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true] td::before{display:none}
}
`;
