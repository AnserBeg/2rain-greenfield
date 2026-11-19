import {
  compositionRelationTargets,
  loadSurfaceComposition,
  submitCompositionAction,
  displayFieldValue,
  renderCompositionPrintDocument,
  taskTransportError,
} from './surface-composition.js';
import {
  workspaceList,
  resolveWorkspaceEntry,
  type WorkspaceEntry,
} from './workspace-entry.js';
import { documentEditor } from './document-editor.js';
import {
  companyParameterFor,
  launcherTiles,
  loadDeclaredListCounts,
  resolveLauncherScan,
  type LauncherRenderData,
} from './surface-launcher.js';
import {
  declaredListArguments,
  declaredViewFilters,
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
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../../packages/runtime/src/semantic-operation-gateway.js';
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
import { LEDGER_STYLES } from './ledger-styles.js';
import { SURFACE_CLIENT_SCRIPT } from './surface-client.js';
import { FONT_STYLESHEET_HREF, registerStaticAsset } from './surface-assets.js';
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
  surfaceSourceEntityId,
  SurfaceProjectionError,
  type CompiledNavigationEntry,
  type CompiledNavigationTree,
  type CompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceInputField,
  type EntityRelationAuthority,
  type SurfaceOperationIntent,
} from './surface-contract.js';
import { NAVIGATION_ICONS, declaredIcon, svgIcon } from './navigation-icons.js';

/** Fixture-only shell furniture, never installed by the production composition. */
export function withLocalDemoIdentity(
  response: SurfaceRuntimeResponse,
  actors:
    readonly { key: 'buyer' | 'manager'; label: string }[] | null | undefined,
  selected: 'buyer' | 'manager',
): SurfaceRuntimeResponse {
  if (!actors) return response;
  const bar = `<aside class="demo-identity" aria-label="Local demo identity"><form method="post"><label>Acting as <select name="localDemoActAs" aria-label="Acting as">${actors.map((actor) => `<option value="${actor.key}"${actor.key === selected ? ' selected' : ''}>${escapeHtml(actor.label)}</option>`).join('')}</select></label><button type="submit">Switch person</button><span>Local demo</span></form></aside>`;
  // Inside the shell the switch sits in the avatar's menu, and the footer
  // names the person and their role (LOOK-1 round 3); a page without the
  // shell keeps it at the top of the body.
  const menu = '<div class="shell-account__menu">';
  const who = '<span class="side-foot__who"><strong>Signed in</strong></span>';
  const person = actors.find((actor) => actor.key === selected)?.label;
  if (!response.html.includes(menu))
    return {
      ...response,
      html: response.html.replace('<body>', `<body>${bar}`),
    };
  return {
    ...response,
    html: response.html
      .replace(menu, `${menu}${bar}`)
      .replace(
        who,
        person
          ? `<span class="side-foot__who"><strong>${escapeHtml(person)}</strong><small>Local demo</small></span>`
          : who,
      ),
  };
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
  /**
   * SPEED-1: the page's read snapshot. Its reads are finished before the
   * page is rendered, so the snapshot is never held across rendering.
   */
  reads: { readonly finishReads: () => Promise<void> } | null = null,
): Promise<SurfaceRuntimeResponse> {
  assertRequestRuntimeView(view);
  const rendered = async (
    render: () => SurfaceRuntimeResponse,
  ): Promise<SurfaceRuntimeResponse> => {
    await reads?.finishReads();
    return render();
  };
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
  const pageContext = await loadWorkspaceContextBar(
    view,
    selection,
    binding,
    gateways.queryGateway,
    legalEntitySelection,
    url,
    entry,
  );
  // A page with no company of its own -- a record every company shares, a
  // tenant's record type -- keeps the company the day's work is in (LOOK-1
  // round 4): resolved by the landing launcher's declared entry, so the
  // sidebar's head, its links and its queues stay in that company.
  const landingContext =
    pageContext || legalEntitySelection.length > 0 || entry
      ? null
      : await landingCompanyContext(
          view,
          selection,
          gateways.queryGateway,
          url,
        );
  const workspaceContext = pageContext ?? landingContext;
  // The sidebar's queue counts, read with the page's other reads (SPEED-1).
  await loadQueueCounts(
    view,
    selection.navigation,
    selection.surfaces,
    gateways.queryGateway,
    legalEntitySelection.length === 1
      ? legalEntitySelection[0]!
      : (entry?.selected ?? landingContext?.selectedRecordId ?? null),
    gateways.clock?.() ?? new Date(),
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
    legalEntitySelection.length ===
      (selection.selected.documentEditor.scope === 'tenantShared' ? 0 : 1)
  ) {
    let editor: Awaited<ReturnType<typeof documentEditor>>;
    try {
      editor = await documentEditor(
        view,
        selection.selected,
        selection.surfaces,
        url,
        legalEntitySelection[0] ?? null,
        gateways,
      );
    } catch (error) {
      return renderApplicationDiagnostic(422, {
        code: queryMessageCode(error),
      });
    }
    // Finishing the reads is outside the editor's catch: a policy change seen
    // then is the page's to retry or refuse, never an editor diagnostic
    // (SPEED-1 S7).
    if (editor) {
      const slots = editor.slots;
      const record = editor.record;
      const statusCode = editor.statusCode;
      return slots
        ? await rendered(() =>
            renderSelectedSurface(
              view,
              selection,
              {
                status: 'READY',
                records: record ? [record] : [],
                documentEditorSlots: slots,
              },
              null,
              binding.operations,
              statusCode,
              legalEntitySelection,
              workspaceContext,
            ),
          )
        : editor;
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
    // Today (the landing launcher) leaves out a queue the person may not
    // open; another launcher keeps its tile, uncounted. Neither reads it.
    const tiles = await launcherTiles(
      view,
      launcher,
      selection.surfaces,
      company,
      gateways.queryGateway,
      gateways.clock?.() ?? new Date(),
      null,
      landingSurface(selection.navigation, selection.surfaces)?.surfaceId ===
        selection.selected.surfaceId,
    );
    return rendered(() =>
      renderSelectedSurface(
        view,
        selection,
        {
          launcher: {
            scan,
            scope:
              scopeParameterId && company
                ? { parameterId: scopeParameterId, value: company }
                : null,
            tiles,
          },
          status: 'LAUNCHER_READY',
        },
        feedback,
        binding.operations,
        scan ? 422 : 200,
        legalEntitySelection,
        workspaceContext,
      ),
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
    return rendered(() =>
      renderSelectedSurface(
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
      ),
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
  return rendered(() =>
    renderSelectedSurface(
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
    ),
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
  const argumentsFor = (
    mode: 'count' | 'page',
    listState: DeclaredListState,
    withheld: WithheldFigures,
    viewId?: string | null,
    viewCounts?: Parameters<typeof declaredListArguments>[2]['viewCounts'],
  ) =>
    declaredListArguments(list, listState, {
      mode,
      now,
      ...(mode === 'page'
        ? { pageOffset: (listState.page - 1) * list.pageSize }
        : {}),
      queryId: binding.query.queryId,
      scopeArguments,
      ...(viewId === undefined ? {} : { viewId }),
      ...(viewCounts ? { viewCounts } : {}),
      ...withoutWithheld(withheld),
    });
  const readPage = (listState: DeclaredListState, withheld: WithheldFigures) =>
    queryGateway.invoke(view, {
      arguments: argumentsFor('page', listState, withheld),
      queryId: binding.query.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
  const viewCounts = async (withheld: WithheldFigures) => {
    const counts: Record<string, number> = {};
    const savedViews = list.views.filter((candidate) => candidate.layout);
    if (savedViews.length > 0) {
      try {
        const groups = savedViews.map((candidate) => ({
          viewId: candidate.viewId,
          filters: declaredViewFilters(list, state, candidate),
        }));
        const args = argumentsFor(
          'count',
          { ...state, filterValues: {} },
          withheld,
          null,
          groups,
        );
        const counted = await loadDeclaredListCounts(
          view,
          queryGateway,
          binding.query.queryId,
          args,
        );
        for (const count of counted?.viewCounts ?? [])
          counts[count.viewId] = count.totalCount;
      } catch {
        // An unavailable batch leaves the tabs navigable, without a guessed count.
      }
    }
    for (const listView of list.views) {
      // A view needing withheld figures is never counted without them: its
      // tab shows no count, and its own page refuses.
      if (listView.layout || !viewServes(list, withheld, listView.viewId))
        continue;
      try {
        const args = argumentsFor('count', state, withheld, listView.viewId);
        const counted = await loadDeclaredListCounts(
          view,
          queryGateway,
          binding.query.queryId,
          args,
        );
        if (counted) counts[listView.viewId] = counted.totalCount;
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
      result = await readPage(state, withheld);
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
    result = await readPage(state, withheld);
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
      body: declaredListCsv(
        list,
        result.records,
        (record, fieldId, value) => {
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
        },
        state.viewId,
      ),
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
  if (
    scope.length !==
    (selection.selected.documentEditor.scope === 'tenantShared' ? 0 : 1)
  )
    return fallback;
  try {
    const editor = await documentEditor(
      view,
      selection.selected,
      selection.surfaces,
      url,
      scope[0] ?? null,
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
  transport: 'page' | 'task-fragment' = 'page',
): Promise<SurfaceRuntimeResponse> {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  const fragment = transport === 'task-fragment';
  if (
    fragment &&
    (!submission.compositionAction ||
      selection.selected.composition?.presentation?.task?.mode !==
        'nativeDialog')
  )
    return { statusCode: 409, html: '' };
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
    // The step's page is rendered after the step's reads and writes, with
    // the sidebar's queue counts read last (SPEED-1): after a Confirm they
    // count what it committed.
    const renderStep = (
      html: string,
      data: Parameters<Parameters<typeof submitCompositionAction>[5]>[1],
      statusCode: number,
      outcome?: Parameters<Parameters<typeof submitCompositionAction>[5]>[3],
    ) => {
      if (fragment && (!data || outcome === undefined))
        return { statusCode, html: recordTaskRegion(html) };
      return data
        ? renderSelectedSurface(
            view,
            selection,
            {
              status: 'READY',
              records: [data.record],
              composition: data,
              ...(fragment && outcome?.inline ? {} : { compositionTask: html }),
            },
            null,
            binding.operations,
            statusCode,
            data.scope ? [data.scope] : [],
            workspaceContext,
            undefined,
            null,
            null,
            null,
            fragment
              ? { outcome: outcome?.inline ? outcome.html : '' }
              : undefined,
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
          };
    };
    const step: { render?: () => ReturnType<typeof renderStep> } = {};
    const deferred = Object.freeze({ html: '', statusCode: 0 });
    const answered = await submitCompositionAction(
      view,
      selection.selected,
      requestUrl,
      submission,
      gateways,
      (html, data, statusCode, outcome) => {
        step.render = () => renderStep(html, data, statusCode, outcome);
        return deferred;
      },
    );
    if (answered !== deferred || !step.render) return answered;
    await loadPostedQueueCounts(view, selection, binding, requestUrl, gateways);
    return step.render();
  }
  if (selection.selected.documentEditor && submission.draftSession) {
    const url = new URL(requestUrl, 'http://surface-runtime.local');
    const scope = legalEntitySelectionForSurface(binding, url);
    if (
      scope.length !==
      (selection.selected.documentEditor.scope === 'tenantShared' ? 0 : 1)
    )
      return operationDiagnostic('OPERATION_INPUT_INVALID', 422);
    try {
      const editor = await documentEditor(
        view,
        selection.selected,
        selection.surfaces,
        url,
        scope[0] ?? null,
        gateways,
        submission,
      );
      if (!editor) return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
      await loadPostedQueueCounts(
        view,
        selection,
        binding,
        requestUrl,
        gateways,
      );
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
  fragment?: { readonly outcome: string },
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
  const nativeTask =
    selected.composition?.presentation?.task?.mode === 'nativeDialog';
  const body = `${nativeTask ? recordTaskRegion(fragment?.outcome ?? '') : ''}${pageHeading}
    <div class="surface-grid" data-surface-archetype="${escapeHtml(selected.archetype)}">
      ${renderedSlots.map((result) => result.html).join('')}
    </div>`;
  // The one hash-pinned script also enhances draft-editor reference controls and
  // their create dialog, and is emitted only when this response renders one.
  // Matched inside a tag: escaped record text can never form `<... data-...`.
  if (fragment) {
    const launcher = landingSurface(navigation, surfaces);
    const queues = launcher
      ? renderWorkQueues(
          view,
          launcher,
          surfaces,
          selected,
          workspaceContext,
          queueCountsFor(view),
        )
      : '';
    return { statusCode, html: surfaceContent(body) + queues };
  }
  const enhanceTaskDialog =
    /<[a-z]+\s[^>]*\bdata-(?:reference-control|editor-create)\b/u.test(body) ||
    (data.status === 'READY' && nativeTask);

  // The launcher page already read its tiles' counts; the sidebar's queues
  // show them rather than asking again.
  // Only the landing launcher's own page (Today) answers for its queues; the
  // Warehouse's tiles are other queues (SPEED-1).
  const queueCounts =
    data.status === 'LAUNCHER_READY' &&
    landingSurface(navigation, surfaces)?.surfaceId === selected.surfaceId
      ? new Map(data.launcher.tiles.map((tile) => [tile.tileId, tile.count]))
      : null;

  return Object.freeze({
    html: shellDocument(
      view,
      surfaces,
      navigation,
      selected,
      body,
      workspaceContext,
      enhanceTaskDialog,
      queueCounts,
    ),
    statusCode,
  });
}

function recordTaskRegion(body: string): string {
  return `<div id="record-task-region">${taskTransportError}${body}</div>`;
}

function surfaceContent(body: string): string {
  return `<main id="surface-content" tabindex="-1">${body}</main>`;
}

/**
 * Where a person lands with no page asked for (LOOP-1): the first launcher in
 * navigation order -- a page of the day's work with its counts, never an
 * empty list -- else navigation's first destination, else the first surface.
 */
function landingSurface(
  navigation: CompiledNavigationTree | null,
  surfaces: readonly CompiledSurfaceDefinition[],
): CompiledSurfaceDefinition | undefined {
  const destinations: CompiledSurfaceDefinition[] = [];
  const visit = (entry: CompiledNavigationEntry): void => {
    if (entry.kind === 'navigationGroup') entry.children.forEach(visit);
    else {
      const surface = surfaces.find(
        (candidate) => candidate.surfaceId === entry.surfaceId,
      );
      if (surface) destinations.push(surface);
    }
  };
  navigation?.entries.forEach(visit);
  return (
    destinations.find((surface) => surface.launcher) ??
    destinations[0] ??
    surfaces[0]
  );
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
    : landingSurface(navigation, surfaces);
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

/** The landing launcher's company, for a page that has none of its own. */
async function landingCompanyContext(
  view: RuntimeViewContract.RequestRuntimeView,
  selection: SelectedSurface,
  queryGateway: SemanticQueryGateway,
  currentUrl: URL,
): Promise<WorkspaceContextBar | null> {
  const landing = landingSurface(selection.navigation, selection.surfaces);
  if (!landing?.launcher || !landing.workspace?.entry) return null;
  if (landing.surfaceId === selection.selected.surfaceId) return null;
  const resolved = await resolveWorkspaceEntry(
    view,
    landing,
    new URL(currentUrl),
    queryGateway,
  );
  if (!resolved?.selected) return null;
  return Object.freeze({
    options: resolved.options,
    parameterId: resolved.parameter,
    preservedParameters: Object.freeze([]),
    selectedRecordId: resolved.selected,
    targetSurfaceId: landing.surfaceId,
  });
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
  return intent === 'update'
    ? { expectedRevision, patch: values, recordId }
    : { expectedRevision, recordId };
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
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm ${escapeHtml(operation.label)} · 2rain</title><link rel="stylesheet" href="${FONT_STYLESHEET_HREF}"><link rel="stylesheet" href="${SURFACE_STYLESHEET.href}"></head><body class="standalone"><main class="standalone__card" data-confirmation-step="preview"><p class="eyebrow">Operation preview</p><h1>Confirm ${escapeHtml(operation.label)}</h1><p>Review this ${escapeHtml(surface.label)} operation before it is executed.</p>${operation.capabilityId ? `<section data-predicted-effects="registered-capability"><strong>Predicted effects</strong><p>The registered capability <code>${escapeHtml(operation.capabilityId)}</code> will validate this draft and append its declared business facts. The screen will wait for the committed result.</p></section>` : ''}<form method="post" action="${escapeHtml(action)}">${preserved}<input type="hidden" name="confirmationGrant" value="${escapeHtml(grant)}"><button type="submit">Confirm ${escapeHtml(operation.label)}</button></form></main></body></html>`,
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
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 2rain</title><link rel="stylesheet" href="${FONT_STYLESHEET_HREF}"><link rel="stylesheet" href="${SURFACE_STYLESHEET.href}"></head><body class="standalone print-page"><main class="print-shell" data-release-id="${escapeHtml(view.release.releaseId)}" data-release-content-hash="${escapeHtml(view.release.contentHash)}" data-pointer-fence="${view.pointer.fence}">${body}</main></body></html>`,
    statusCode,
  });
}

export function renderApplicationDiagnostic(
  statusCode: number,
  ref: SurfaceMessageRef,
): SurfaceRuntimeResponse {
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(surfaceMessage(ref.code).sentence)} · 2rain</title><link rel="stylesheet" href="${FONT_STYLESHEET_HREF}"><link rel="stylesheet" href="${SURFACE_STYLESHEET.href}"></head><body class="standalone"><main class="standalone__card" role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Application diagnostic', 'h1')}</main></body></html>`,
    statusCode,
  });
}

/**
 * SPEED-1 (fix read 3): a task's Confirm or retry stopped by a policy change
 * after some of its steps may have committed. Nothing of the record is shown
 * (the page it was assembled under is no longer current); the notice names
 * the uncertainty and offers the session's own retry, which reuses its inputs
 * and request keys and is bound to the session's actor.
 */
export function taskRecoveryNotice(
  requestUrl: string,
  submission: Readonly<Record<string, string>>,
  fragment = false,
): SurfaceRuntimeResponse {
  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const ref: SurfaceMessageRef = { code: 'COMPOSITION_UNCERTAIN' };
  const keep = (name: string) =>
    typeof submission[name] === 'string'
      ? `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(submission[name])}">`
      : '';
  const content = `${messageBody(ref, 'Task', 'h1')}<form method="post" action="${escapeHtml(url.pathname + url.search)}">${keep('taskToken')}${keep('compositionAction')}<button name="taskStage" value="retry">Retry same request</button></form>`;
  return Object.freeze({
    html: fragment
      ? surfaceContent(
          recordTaskRegion(
            `<section class="panel" role="alert" data-task-recovery ${messageAttributes(ref)}>${content}</section>`,
          ),
        )
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(surfaceMessage(ref.code).sentence)} · 2rain</title><link rel="stylesheet" href="${FONT_STYLESHEET_HREF}"><link rel="stylesheet" href="${SURFACE_STYLESHEET.href}"></head><body class="standalone"><main class="standalone__card" role="alert" data-task-recovery ${messageAttributes(ref)}>${content}</main></body></html>`,
    statusCode: 409,
  });
}

function diagnosticDocument(
  view: RuntimeViewContract.RequestRuntimeView,
  ref: SurfaceMessageRef,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(surfaceMessage(ref.code).sentence)} · 2rain</title><link rel="stylesheet" href="${FONT_STYLESHEET_HREF}"><link rel="stylesheet" href="${SURFACE_STYLESHEET.href}"></head><body class="standalone"><main class="standalone__card" role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Pinned release diagnostic', 'h1')}<p class="diagnostic-release">Release ${escapeHtml(shortIdentity(view.release.releaseId))} · fence ${view.pointer.fence}</p></main></body></html>`;
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
  queueCounts: ReadonlyMap<string, number | null> | null = null,
): string {
  const title = selected?.label ?? 'Release diagnostic';
  const navigation = navigationEntries(surfaces, compiledNavigation);
  const activeDestination = currentNavigationDestination(
    view,
    navigation,
    surfaces,
    selected,
  );
  const landing = landingSurface(compiledNavigation, surfaces);
  const launcher = landing?.launcher ? landing : null;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(title)} · 2rain</title>
    <link rel="stylesheet" href="${FONT_STYLESHEET_HREF}"><link rel="stylesheet" href="${SURFACE_STYLESHEET.href}">
  </head>
  <body>
    <a class="skip-link" href="#surface-content">Skip to content</a>
    <div class="app-shell" data-release-id="${escapeHtml(view.release.releaseId)}" data-release-content-hash="${escapeHtml(view.release.contentHash)}" data-pointer-fence="${view.pointer.fence}">
      <aside class="sidebar" id="shell-sidebar">
        <details class="shell-menu"><summary aria-label="Menu" aria-controls="shell-sidebar">${svgIcon('<path d="M4 7h16M4 12h16M4 17h16"/>')}</summary></details>
        ${workspaceContext ? renderWorkspaceContextBar(workspaceContext) : '<div class="brand"><span class="brand__mark" aria-hidden="true">2</span><span><strong>2rain</strong></span></div>'}
        <div class="sidebar-scroll">
        ${launcher ? renderWorkQueues(view, launcher, surfaces, selected, workspaceContext, queueCounts ?? queueCountsFor(view)) : ''}
        <nav aria-label="Release navigation">${renderSidebarNavigation(view, sidebarNavigation(navigation, launcher), surfaces, selected, workspaceContext)}</nav>
        </div>
        <div class="side-foot" data-shell-region="principal"><span class="principal__avatar" aria-hidden="true">${escapeHtml(initials('Signed in'))}</span><span class="side-foot__who"><strong>Signed in</strong></span></div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <strong class="topbar__context">${escapeHtml(activeDestination ?? selected?.label ?? 'Workspace')}</strong>
          ${launcher ? renderShellSearch(view, launcher, workspaceContext) : ''}
          <details class="shell-account"><summary aria-label="Account and diagnostics"><span class="principal__avatar" aria-hidden="true">${escapeHtml(initials('Signed in'))}</span></summary><div class="shell-account__menu">
          <div class="principal" aria-label="Signed-in principal">Signed in</div>
          <details class="shell-diagnostics"><summary>Diagnostics</summary><dl><dt>Tenant</dt><dd>${escapeHtml(view.tenantId)}</dd><dt>Environment</dt><dd>${escapeHtml(view.environmentId)}</dd><dt>Principal</dt><dd>${escapeHtml(view.principalId)}</dd><dt>Pinned release</dt><dd>${escapeHtml(view.release.releaseId)}</dd><dt>Release root</dt><dd>${escapeHtml(view.release.contentHash)}</dd><dt>Fence</dt><dd>${view.pointer.fence}</dd></dl></details>
          </div></details>
        </header>
        ${surfaceContent(body)}
      </div>
    </div>
    ${enhanceTaskDialog ? `<script>${SURFACE_CLIENT_SCRIPT}</script>` : ''}
  </body>
</html>`;
}

/** Up to two capitals from a name's first words: the sidebar's mark. */
function initials(name: string): string {
  const letters = name
    .split(/\s+/u)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
  return letters || '2';
}

/**
 * The work queues at the top of the sidebar (LOOK-1, owner ruling): the
 * landing launcher itself ("Today"), then each of its declared tiles in their
 * fixed order -- a List at its view, in the page's company -- with that view's
 * count when the page's loader read it. A zero stays visible so positions
 * never move; an unread count renders no chip, never a guess.
 */
function renderWorkQueues(
  view: RuntimeViewContract.RequestRuntimeView,
  launcher: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  selected: CompiledSurfaceDefinition | null,
  workspaceContext: WorkspaceContextBar | null,
  counts: ReadonlyMap<string, number | null> | null,
): string {
  const currentView =
    workspaceContext?.preservedParameters.find(
      ([name]) => name === 'view',
    )?.[1] ?? null;
  const tiles = [...(launcher.launcher?.tiles ?? [])].sort(
    (left, right) =>
      left.orderKey - right.orderKey ||
      (left.tileId < right.tileId ? -1 : left.tileId > right.tileId ? 1 : 0),
  );
  const items = tiles
    .map((tile) => {
      const surface = surfaces.find(
        (candidate) => candidate.surfaceId === tile.surface,
      );
      if (!surface) return '';
      // Read counts list the queues the person may open (SPEED-1): one left
      // out is not shown.
      if (counts && !counts.has(tile.tileId)) return '';
      const href = scopedSurfaceHref(view, surface, workspaceContext, {
        ...(tile.view ? { view: tile.view } : {}),
      });
      const current =
        selected?.surfaceId === tile.surface && currentView === tile.view;
      const count = counts?.get(tile.tileId);
      return `<li><a href="${escapeHtml(href)}" data-queue="${escapeHtml(tile.tileId)}"${current ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${declaredIcon(tile.icon) ?? NAVIGATION_ICONS.queue}</span><span>${escapeHtml(tile.label)}</span>${typeof count === 'number' ? `<span class="queue-count">${String(count)}</span>` : ''}</a></li>`;
    })
    .join('');
  const home = `<li><a href="${escapeHtml(scopedSurfaceHref(view, launcher, workspaceContext, {}))}"${selected?.surfaceId === launcher.surfaceId ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${navigationIcon(launcher)}</span><span>${escapeHtml(launcher.label)}</span></a></li>`;
  return `<nav class="work-queues" id="shell-work-queues" aria-label="Work queues"><ul>${home}${items}</ul></nav>`;
}

/**
 * The top bar's search: the landing launcher's declared scan, submitted to
 * that launcher as its own scan box submits it (a GET with the code), so a
 * number or SKU typed here opens what the launcher would open.
 */
function renderShellSearch(
  view: RuntimeViewContract.RequestRuntimeView,
  launcher: CompiledSurfaceDefinition,
  workspaceContext: WorkspaceContextBar | null,
): string {
  const scan = launcher.launcher?.scan;
  if (!scan) return '';
  const href = new URL(
    scopedSurfaceHref(view, launcher, workspaceContext, {}),
    'http://shell.local',
  );
  const hidden = [...href.searchParams.entries()]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return `<form class="shell-search" method="get" action="/" role="search">${hidden}<label><span class="sr-only">${escapeHtml(scan.label)}</span><span class="nav-icon" aria-hidden="true">${NAVIGATION_ICONS.search}</span><input name="scan" type="text" placeholder="${escapeHtml(scan.label)}" autocomplete="off" spellcheck="false" enterkeyhint="go" maxlength="120"></label></form>`;
}

/** A surface's link in the page's company, as navigation builds it. */
function scopedSurfaceHref(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  workspaceContext: WorkspaceContextBar | null,
  extra: Readonly<Record<string, string>>,
): string {
  const parameters = new URLSearchParams({ surface: surface.surfaceId });
  for (const [name, value] of Object.entries(extra))
    parameters.set(name, value);
  if (workspaceContext?.selectedRecordId) {
    try {
      const scope = surface.launcher
        ? companyParameterFor(view, surface)
        : readCompiledSurfaceDataBinding(view, surface).query.legalEntityScope
            ?.operand.parameterId;
      if (scope) parameters.set(scope, workspaceContext.selectedRecordId);
    } catch {
      // The binding validator renders the destination diagnostic; the shell
      // never guesses a parameter id when the pinned artifact is malformed.
    }
  }
  return `/?${parameters.toString()}`;
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
    // A one-destination group is shown as that destination, by the group's
    // name -- unless the destination was placed in the group from another
    // module (the Custom group's one record type): the group then keeps its
    // heading and the destination its own name (LOOK-1 round 2).
    const only =
      entry.children.length === 1 &&
      entry.children[0]?.kind === 'navigationSurface'
        ? surfaceForNavigation(surfaces, entry.children[0])
        : null;
    if (only && only.workspace?.navigationModuleId !== entry.navigationId)
      return `<li class="navigation-node navigation-node--direct">${navigationLink(view, only, selected, entry.label, workspaceContext, surfaces)}</li>`;
    const items = entry.children
      .map((child) =>
        navigationItem(view, child, surfaces, selected, workspaceContext),
      )
      .join('');
    return `<li class="navigation-node navigation-node--group"><details class="navigation-group"${current ? ' data-current="true"' : ''}><summary><span class="nav-icon" aria-hidden="true">${declaredIcon(entry.icon) ?? NAVIGATION_ICONS.group}</span><span class="nav-text"><span class="nav-group-label">${escapeHtml(entry.label)}</span>${destination && destination !== entry.label ? `<small>${escapeHtml(destination)}</small>` : ''}</span><span class="nav-arrow" aria-hidden="true">›</span></summary><ul class="navigation-children">${items}</ul></details></li>`;
  }
  const surface = surfaceForNavigation(surfaces, entry);
  return `<li class="navigation-node navigation-node--surface">${navigationLink(view, surface, selected, navigationLabel(surface), workspaceContext, surfaces)}</li>`;
}

/**
 * The navigation tree, and one "Settings" disclosure (LOOK-1 round 3) for
 * the occasional destinations -- declared `setup` members -- of groups that
 * also list day-to-day work, so the groups show the day's work. A group of
 * masters only (Contacts, Catalog) keeps its own. Outside the tree, so the
 * five-entry budget is unchanged.
 */
function renderSidebarNavigation(
  view: RuntimeViewContract.RequestRuntimeView,
  entries: readonly CompiledNavigationEntry[],
  surfaces: readonly CompiledSurfaceDefinition[],
  selected: CompiledSurfaceDefinition | null,
  workspaceContext: WorkspaceContextBar | null,
): string {
  const occasional = (entry: CompiledNavigationEntry): boolean =>
    entry.kind === 'navigationSurface' &&
    surfaceForNavigation(surfaces, entry).workspace?.membership === 'setup';
  const settings: CompiledNavigationEntry[] = [];
  const read = (
    list: readonly CompiledNavigationEntry[],
  ): CompiledNavigationEntry[] =>
    list.map((entry) => {
      if (entry.kind !== 'navigationGroup') return entry;
      const daily = entry.children.filter(
        (child) => child.kind === 'navigationSurface' && !occasional(child),
      );
      if (daily.length === 0)
        return { ...entry, children: read(entry.children) };
      settings.push(...entry.children.filter(occasional));
      return {
        ...entry,
        children: read(entry.children.filter((child) => !occasional(child))),
      };
    });
  const tree = read(entries);
  const item = (entry: CompiledNavigationEntry) =>
    navigationItem(view, entry, surfaces, selected, workspaceContext);
  const open = settings.some((entry) =>
    navigationEntryIsCurrent(view, entry, surfaces, selected),
  );
  return `<ul class="navigation-tree">${tree.map(item).join('')}</ul>${
    settings.length > 0
      ? `<details class="navigation-settings"${open ? ' open' : ''}><summary><span class="nav-icon" aria-hidden="true">${declaredIcon('settings') ?? NAVIGATION_ICONS.group}</span><span>Settings</span></summary><ul class="navigation-children">${settings.map(item).join('')}</ul></details>`
      : ''
  }`;
}

/**
 * The sidebar's reading of the compiled tree (LOOK-1 round 2): the landing
 * launcher heads the work queues, so its group does not repeat it.
 */
function sidebarNavigation(
  entries: readonly CompiledNavigationEntry[],
  launcher: CompiledSurfaceDefinition | null,
): readonly CompiledNavigationEntry[] {
  const read = (
    list: readonly CompiledNavigationEntry[],
  ): CompiledNavigationEntry[] =>
    list.flatMap((entry): CompiledNavigationEntry[] => {
      if (entry.kind === 'navigationSurface')
        return entry.surfaceId === launcher?.surfaceId ? [] : [entry];
      const children = read(entry.children);
      return children.length > 0 ? [{ ...entry, children }] : [];
    });
  return read(entries);
}

function navigationIcon(surface: CompiledSurfaceDefinition): string {
  const declared = declaredIcon(surface.workspace?.icon);
  return declared
    ? declared
    : surface.launcher
      ? NAVIGATION_ICONS.launcher
      : surface.surfaceRole === 'list'
        ? NAVIGATION_ICONS.list
        : NAVIGATION_ICONS.page;
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
  return `<a href="/?${parameters.toString()}"${current ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${navigationIcon(surface)}</span><span>${escapeHtml(label)}</span><span class="nav-arrow" aria-hidden="true">›</span></a>`;
}

function renderWorkspaceContextBar(context: WorkspaceContextBar): string {
  // The sidebar's head (LOOK-1 round 3): the page's company as the brand,
  // any other authorized company a link beneath it -- the same links, so
  // switching is unchanged.
  const current = context.options.find(
    (option) => option.recordId === context.selectedRecordId,
  );
  const ordered = current
    ? [current, ...context.options.filter((option) => option !== current)]
    : context.options;
  return `<nav class="workspace-context-bar" aria-label="Company" data-shell-region="workspace-context-bar" data-scope-parameter-id="${escapeHtml(context.parameterId)}"><span class="brand__mark" aria-hidden="true">${escapeHtml(initials(current?.label ?? '2rain'))}</span><span class="workspace-context-bar__options">${
    context.options.length === 0
      ? '<span class="muted">No authorized active companies available. Contact your administrator for access or setup.</span>'
      : ordered
          .map((option) => {
            const parameters = new URLSearchParams(
              context.preservedParameters.map(([key, value]) => [key, value]),
            );
            parameters.set('surface', context.targetSurfaceId);
            parameters.set(context.parameterId, option.recordId);
            const selected = option.recordId === context.selectedRecordId;
            return `<a class="workspace-company" title="${escapeHtml(option.label)}" href="/?${parameters.toString()}" data-legal-entity-id="${escapeHtml(option.recordId)}"${selected ? ' aria-current="true"' : ''}>${escapeHtml(option.label)}</a>`;
          })
          .join('')
  }</span></nav>`;
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
  // A launcher is a destination of its own, not a page of the records its
  // Task happens to read (LOOP-1: Today and Warehouse read stock movements).
  if (selected.launcher) return false;
  const entityId = surfaceSourceEntityId(view, selected);
  if (entityId === null || surfaceSourceEntityId(view, navigation) !== entityId)
    return false;
  if (selected.surfaceRole === 'list')
    return navigation.surfaceId === selected.surfaceId;
  const lists = surfaces.filter(
    (candidate) =>
      candidate.surfaceRole === 'list' &&
      surfaceSourceEntityId(view, candidate) === entityId,
  );
  return (
    lists.length <= 1 ||
    recordWorkspaceOwners(view, surfaces, entityId).has(navigation.surfaceId)
  );
}

const styles = `${DESIGN_TOKENS}${LEDGER_STYLES}`;

/** The runtime's own stylesheet, for standalone pages served beside it. */
export function surfaceRuntimeStyles(): string {
  return styles;
}

/**
 * SPEED-1: the stylesheet is served once from a same-origin route named by its
 * content hash (`app-server.ts`), so a page links it instead of carrying 58 KB,
 * and the CSP admits `style-src 'self'` with no inline style.
 */
export const SURFACE_STYLESHEET = Object.freeze({
  css: surfaceRuntimeStyles(),
  href: registerStaticAsset(
    'surface',
    'css',
    'text/css; charset=utf-8',
    Buffer.from(surfaceRuntimeStyles(), 'utf8'),
    true,
  ),
});

/**
 * The work queues' counts on every page (SPEED-1, owner ruling (a)): the
 * landing launcher's first three tiles -- Today's To receive, To ship and Not
 * yet paid -- each its declared List view's count, read with the page's other
 * reads (inside its read snapshot) and under current policy, keyed by tile.
 * LOOK-1's `renderWorkQueues` shows them; the launcher page shows its own
 * tiles' counts instead (the same reads, answered once). A count that could
 * not be read is `null` and shows no chip, never a guess. The map lists only
 * the queues the person may open: a tile current policy would refuse, asked
 * without reading or recording a denial, is absent and not shown.
 */
const QUEUE_COUNT_LIMIT = 3;

/** Each request view's queue counts, read once while the page reads. */
const loadedQueueCounts = new WeakMap<
  object,
  ReadonlyMap<string, number | null>
>();

async function loadQueueCounts(
  view: RuntimeViewContract.RequestRuntimeView,
  navigation: CompiledNavigationTree | null,
  surfaces: readonly CompiledSurfaceDefinition[],
  queryGateway: SemanticQueryGateway,
  company: string | null,
  now: Date,
): Promise<void> {
  // The landing launcher (the first in navigation order: Today) declares the
  // day's queues. Without one, a page shows none.
  const launcher = landingSurface(navigation, surfaces)?.launcher;
  if (!launcher) return;
  const counted = new Set(
    [...launcher.tiles]
      .sort(
        (left, right) =>
          left.orderKey - right.orderKey ||
          (left.tileId < right.tileId
            ? -1
            : left.tileId > right.tileId
              ? 1
              : 0),
      )
      .slice(0, QUEUE_COUNT_LIMIT)
      .map((tile) => tile.tileId),
  );
  // Every tile is checked for eligibility (without a read or a denial); the
  // first three are counted. A tile left out is a queue not shown.
  const tiles = await launcherTiles(
    view,
    launcher,
    surfaces,
    company,
    queryGateway,
    now,
    counted,
  );
  loadedQueueCounts.set(
    view,
    new Map(tiles.map((tile) => [tile.tileId, tile.count])),
  );
}

/** The queue counts of a posted step's page, in the company its URL names. */
async function loadPostedQueueCounts(
  view: RuntimeViewContract.RequestRuntimeView,
  selection: SelectedSurface,
  binding: CompiledSurfaceDataBinding,
  requestUrl: string,
  gateways: SurfaceRuntimeGateways,
): Promise<void> {
  const scope = legalEntitySelectionForSurface(
    binding,
    new URL(requestUrl, 'http://surface-runtime.local'),
  );
  await loadQueueCounts(
    view,
    selection.navigation,
    selection.surfaces,
    gateways.queryGateway,
    scope.length === 1 ? scope[0]! : null,
    gateways.clock?.() ?? new Date(),
  );
}

function queueCountsFor(
  view: object,
): ReadonlyMap<string, number | null> | null {
  return loadedQueueCounts.get(view) ?? null;
}

/**
 * The company an assistant conversation works in (end review X9): the one the
 * person's page settled on, proved the way the page proves it. The page's
 * own workspace entry decides when it declares one; a page without a
 * company of its own (a shared record, the Customize screen) takes the
 * landing launcher's, as its sidebar does. A company is accepted only when
 * it is one of the companies the entry offers this person now; the URL's
 * parameter alone is never trusted.
 */
export interface AssistantCompany {
  readonly companyId: string;
  /** The company's name as the entry offers it. */
  readonly label: string;
}

export async function assistantCompany(
  view: RuntimeViewContract.RequestRuntimeView,
  queryGateway: SemanticQueryGateway,
  page: { readonly surfaceId: string | null; readonly search: string },
): Promise<AssistantCompany | null> {
  const manifest = readCompiledSurfaceManifest(view);
  // A fresh URL per resolution: resolving may write the default into it.
  const url = () =>
    new URL(
      `/${page.search.startsWith('?') ? page.search : `?${page.search}`}`,
      'http://assistant.local',
    );
  const settle = async (surface: CompiledSurfaceDefinition) => {
    const entry = await resolveWorkspaceEntry(
      view,
      surface,
      url(),
      queryGateway,
    );
    if (!entry) return undefined;
    if (entry.invalid) return null;
    const offered = entry.options.find(
      (option) => option.recordId === entry.selected,
    );
    return offered
      ? { companyId: offered.recordId, label: offered.label }
      : undefined;
  };
  const own = page.surfaceId
    ? manifest.surfaces.find((surface) => surface.surfaceId === page.surfaceId)
    : undefined;
  const landing = landingSurface(manifest.navigation, manifest.surfaces);
  if (page.surfaceId && !own) return null;
  if (own) {
    const query = registeredSemanticQueryFromPinnedView(
      view,
      own.dataSourceQueryId,
    );
    if (own.workspace?.entry) {
      const entry = await resolveWorkspaceEntry(view, own, url(), queryGateway);
      if (entry) {
        const offered = entry.options.find(
          (option) => option.recordId === entry.selected,
        );
        return !entry.invalid && offered
          ? { companyId: offered.recordId, label: offered.label }
          : null;
      }
    }
    if (query?.legalEntityScope) {
      const ids = url().searchParams.getAll(
        query.legalEntityScope.operand.parameterId,
      );
      const companyId = ids[0];
      const policy = landing?.workspace?.entry;
      if (
        ids.length !== 1 ||
        !companyId ||
        !policy ||
        (await queryGateway.previewEligibility(
          view,
          query.queryId,
          companyId,
        )) !== 'eligible'
      )
        return null;
      const companies = await workspaceList(
        view,
        queryGateway,
        policy.companyQueryId,
        null,
      );
      const row = companies.find(
        (r) =>
          r.recordId === companyId &&
          r.values[policy.companyStateFieldId] === policy.activeStateId,
      );
      const label = row?.values[policy.companyNameFieldId];
      return typeof label === 'string' && label.trim()
        ? { companyId, label }
        : null;
    }
  }
  if (!landing?.launcher || !landing.workspace?.entry) return null;
  return (await settle(landing)) ?? null;
}
