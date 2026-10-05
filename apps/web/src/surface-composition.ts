import { randomUUID } from 'node:crypto';
import type { SurfaceComposition } from '../../../packages/canonical-model/src/index.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
  type SemanticQueryGateway,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type SemanticOperationGateway,
  type SemanticOperationMediationAuthority,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SHARED_LIST_QUERY_VERSION,
  requireSharedListResult,
} from '../../../packages/runtime/src/list-behavior/index.js';
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../../packages/runtime/src/request-runtime-view.js';

import {
  readCompiledSurfaceManifest,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceField,
  type CompiledSurfaceInputField,
} from './surface-contract.js';
import { escapeHtml as h } from './html.js';
import { moneyText } from './list-declaration.js';
import {
  DECIMAL_KINDS,
  admitsChoice,
  canonicalDecimal,
  decimalProblem,
  renderChoice,
} from './control-semantics.js';
import { operationMessageRef } from './gateway-error-codes.js';
import { messageAttributes, messageBody } from './message-render.js';
import type { SurfaceMessageCode } from './message-catalog.js';
const compositionMessage = (
  code: Extract<SurfaceMessageCode, `COMPOSITION_${string}`>,
  role: 'alert' | 'status' | null = null,
) =>
  `<div ${role ? `role="${role}"` : ''} ${messageAttributes({ code })}>${messageBody({ code }, 'Workspace', 'h2')}</div>`;
/**
 * A section that did not load. One company's rows on a record every company
 * shares say which choice is missing; any other failure stays the section
 * failure, never an empty table.
 */
const childFailure = (error: CompositionData['children'][number]['error']) =>
  error === 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED'
    ? `<div role="status" ${messageAttributes({ code: error })}>${messageBody({ code: error }, 'Workspace', 'h2')}</div>`
    : compositionMessage('COMPOSITION_CHILD_FAILED', 'alert');

type Column = SurfaceComposition['fields'][number];
type Action = SurfaceComposition['actions'][number];
type Value = Action['steps'][number]['bindings'][number]['value'];
type Row = {
  record: SemanticRecordDto;
  cells: Readonly<Record<string, string>>;
};
export interface CompositionData {
  record: SemanticRecordDto;
  fields: Row;
  fieldsFailed: boolean;
  children: {
    definition: SurfaceComposition['children'][number];
    rows: Row[];
    status: 'ready' | 'empty' | 'failed';
    /** Why a section did not load: a failed read, or no company chosen yet. */
    error?: 'COMPOSITION_CHILD_FAILED' | 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED';
  }[];
  selections: Record<string, SemanticRecordDto>;
  selected: SemanticRecordDto | null;
  selectedDatasetId: string | null;
  url: string;
  scope: string | null;
}
const ordered = <T extends { orderKey: number }>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => a.orderKey - b.orderKey);
const recordValue = (
  record: SemanticRecordDto | null,
  field: string,
): ImmutableJsonValue => {
  if (!record) throw new Error('COMPOSITION_RECORD_REQUIRED');
  if (field === 'recordId') return record.recordId;
  if (field === 'revision') return record.revision;
  if (Object.hasOwn(record.values, field)) return record.values[field]!;
  const relation = record.relationLabels?.[field];
  if (relation) return relation.recordId;
  throw new Error('The declared record value is unavailable.');
};
const text = (value: ImmutableJsonValue): string =>
  value === null ? '—' : String(value);
/** A positive exact decimal, as a governed figure states one. */
const POSITIVE_DECIMAL = /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/;

/**
 * The relations of its record a composition names -- a column labelled
 * through the related record's get, or a link that opens it -- which the
 * record's get is asked to state (`relationTargets`). The validator admits a
 * name outside the record query's results only as a relation of the record.
 */
export function compositionRelationTargets(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
): readonly string[] {
  const composition = surface.composition;
  const definition = registeredSemanticQueryFromPinnedView(
    view,
    surface.dataSourceQueryId,
  );
  if (!composition || !definition || definition.queryType !== 'get') return [];
  const results = new Set<string>([
    'recordId',
    'revision',
    ...definition.selections.map((selection) => selection.fieldId),
    ...Object.values(definition.readModel?.resultFields ?? {}),
  ]);
  return [
    ...new Set(
      [
        ...composition.fields.map((column) => column.field),
        ...composition.actions.flatMap((action) =>
          action.navigate?.record.source === 'record'
            ? [action.navigate.record.field]
            : [],
        ),
      ].filter((field) => !results.has(field)),
    ),
  ];
}

/** The record read a composition page and its Tasks make: the record, with the relations it names. */
function recordArguments(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  recordId: string | null,
): Record<string, ImmutableJsonValue> {
  const relationTargets = compositionRelationTargets(view, surface);
  return {
    recordId,
    includeArchived: false,
    ...(relationTargets.length
      ? { relationTargets: [...relationTargets] }
      : {}),
  };
}

/** The page seen from one row of a dataset: that row selected there. */
function withRow(
  data: CompositionData,
  datasetId: string,
  record: SemanticRecordDto,
): CompositionData {
  return {
    ...data,
    selected: record,
    selectedDatasetId: datasetId,
    selections: { ...data.selections, [datasetId]: record },
  };
}

async function query(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  queryId: string,
  scope: string | null,
  args: Record<string, ImmutableJsonValue>,
) {
  const definition = registeredSemanticQueryFromPinnedView(view, queryId);
  if (!definition || definition.queryType === 'aggregate')
    throw new Error('The declared record query is unavailable.');
  if (definition.legalEntityScope && !scope)
    throw new Error('Choose a legal entity.');
  return gateways.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId,
    arguments: {
      ...args,
      ...(definition.legalEntityScope
        ? { [definition.legalEntityScope.operand.parameterId]: scope }
        : {}),
    },
  });
}

const presentedFields = new WeakMap<
  RequestRuntimeView,
  Map<string, CompiledSurfaceField>
>();
/** Presents a stored value by its compiled field kind; shared with declared Lists. */
export function displayFieldValue(
  view: RequestRuntimeView,
  record: SemanticRecordDto,
  fieldId: string,
  value: ImmutableJsonValue,
): string {
  let fields = presentedFields.get(view);
  if (!fields) {
    fields = new Map(
      readCompiledSurfaceManifest(view).surfaces.flatMap((surface) =>
        (surface.fields ?? []).map((field) => [field.fieldId, field] as const),
      ),
    );
    presentedFields.set(view, fields);
  }
  const field = fields.get(fieldId);
  if (field?.kind === 'enumFieldType')
    return (
      field.options.find((option) => option.optionId === value)?.label ??
      text(value)
    );
  const result = record.displayValues?.[fieldId] ?? text(value);
  if (
    field &&
    ['exactDecimalFieldType', 'quantityFieldType'].includes(field.kind) &&
    /^-?\d+\.\d+$/.test(result)
  )
    return result.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  if (field?.kind === 'dateFieldType' && /^\d{4}-\d{2}-\d{2}$/.test(result))
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(`${result}T00:00:00Z`));
  if (
    field?.kind === 'dateTimeFieldType' &&
    Number.isFinite(Date.parse(result))
  )
    return (
      new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(result)) + ' UTC'
    );
  return result;
}

async function present(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  scope: string | null,
  record: SemanticRecordDto,
  columns: readonly Column[],
  /**
   * Columns naming a relation of the record, such as an invoice's order. The
   * related record is read through its own get under current policy; one it
   * withholds, or one that is gone, reads "—" rather than failing the page
   * that can itself be read.
   */
  related: ReadonlySet<string> = new Set(),
  /**
   * The record's own fields that hold another record's id, such as an item's
   * preferred location (REPLENISHMENT). One whose record is gone -- archived
   * or removed -- reads "—"; one current policy withholds still fails the
   * fields, as a Task's re-check of its context requires.
   */
  absent: ReadonlySet<string> = new Set(),
): Promise<Row> {
  const cells: Record<string, string> = {};
  for (const column of columns) {
    const value = recordValue(record, column.field);
    if (!column.reference || value === null) {
      cells[column.columnId] =
        column.format === 'money' && typeof value === 'string'
          ? moneyText(value)
          : related.has(column.field)
            ? text(null)
            : displayFieldValue(view, record, column.field, value);
      continue;
    }
    let result: Awaited<ReturnType<typeof query>>;
    try {
      result = await query(
        view,
        gateways,
        column.reference.query.targetId,
        scope,
        { recordId: value, includeArchived: false },
      );
    } catch (error) {
      if (
        related.has(column.field) &&
        error instanceof SemanticQueryPolicyDeniedError
      ) {
        cells[column.columnId] = text(null);
        continue;
      }
      throw error;
    }
    if (
      (related.has(column.field) &&
        (result.outcome !== 'exact' || result.records.length !== 1)) ||
      (absent.has(column.field) &&
        (result.outcome === 'not-found' ||
          (result.outcome === 'exact' && result.records.length === 0)))
    ) {
      cells[column.columnId] = text(null);
      continue;
    }
    if (result.outcome !== 'exact' || result.records.length !== 1)
      throw new Error('A referenced record is unavailable.');
    cells[column.columnId] = text(
      recordValue(result.records[0]!, column.reference.labelField.targetId),
    );
  }
  return { record, cells };
}

export async function loadSurfaceComposition(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  record: SemanticRecordDto,
  requestUrl: string,
  scope: string | null,
  gateways: CompositionGateways,
): Promise<CompositionData> {
  const composition = surface.composition!;
  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const data: CompositionData = {
    record,
    fields: { record, cells: {} },
    fieldsFailed: false,
    children: [],
    selections: {},
    selected: null,
    selectedDatasetId: null,
    url: url.pathname + url.search,
    scope,
  };
  try {
    data.fields = await present(
      view,
      gateways,
      scope,
      record,
      composition.fields,
      new Set(compositionRelationTargets(view, surface)),
      new Set(
        composition.fields.flatMap((column) =>
          column.reference ? [column.field] : [],
        ),
      ),
    );
  } catch {
    data.fieldsFailed = true;
  }
  for (const definition of ordered(composition.children)) {
    const child: CompositionData['children'][number] = {
      definition,
      rows: [],
      status: 'empty',
    };
    data.children.push(child);
    try {
      const parent = definition.parent;
      if (!parent === !definition.fieldScope)
        throw new Error('Child queries require one exact record scope.');
      if (
        parent?.value.source === 'selected' &&
        !(parent.value.datasetId
          ? data.selections[parent.value.datasetId]
          : data.selected)
      )
        continue;
      const registered = registeredSemanticQueryFromPinnedView(
        view,
        definition.query.targetId,
      );
      if (!registered || registered.queryType !== 'list')
        throw new Error('Child query must be a registered list.');
      // One company's rows on a record every company shares wait for the
      // company to be chosen; that is not a failed read.
      if (registered.legalEntityScope && !scope) {
        child.status = 'failed';
        child.error = 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED';
        continue;
      }
      // A declared relation to the record, or the record's own id held in a
      // field of the dataset's entity: either way an exact restriction the
      // executor applies before the count and the page, and must echo.
      const restriction = parent
        ? {
            key:
              parent.ownership === 'reference'
                ? ('referenceScope' as const)
                : ('parentScope' as const),
            value: {
              recordId: String(resolveValue(parent.value, data, {}, {}, {})),
              relationId: parent.relationId,
            },
          }
        : null;
      const fieldFilters = definition.fieldScope
        ? [
            {
              fieldId: definition.fieldScope.fieldId,
              value: String(
                resolveValue(definition.fieldScope.value, data, {}, {}, {}),
              ),
            },
          ]
        : null;
      let cursor: string | null = null;
      do {
        const result: ReturnType<
          typeof requireSharedListResult<SemanticRecordDto>
        > = requireSharedListResult(
          await query(view, gateways, definition.query.targetId, scope, {
            includeArchived: false,
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor,
              matchMode: 'substring',
              pageSize: registered.maximumResultCount,
              search: '',
              sort: definition.sort ?? [],
              relationLabels: [],
              ...(restriction ? { [restriction.key]: restriction.value } : {}),
              ...(fieldFilters ? { fieldFilters } : {}),
            },
          }),
        );
        if (restriction) {
          const applied = result.listCoverage[restriction.key];
          if (
            applied?.recordId !== restriction.value.recordId ||
            applied.relationId !== restriction.value.relationId
          )
            throw new Error('The query did not apply its exact record scope.');
        }
        // An executor that ignored the field scope cannot echo it, so a
        // broader list -- every record's rows -- is refused, never shown as
        // this record's.
        const echoed = result.listCoverage.fieldFilters;
        if (
          fieldFilters &&
          (echoed?.length !== fieldFilters.length ||
            fieldFilters.some(
              (filter, index) =>
                echoed[index]?.fieldId !== filter.fieldId ||
                echoed[index]?.value !== filter.value,
            ))
        )
          throw new Error('The query did not apply its exact field scope.');
        for (const row of result.records)
          child.rows.push(
            await present(view, gateways, scope, row, definition.columns),
          );
        if (
          result.listCoverage.hasMore &&
          (!result.records.length ||
            result.listCoverage.nextCursor === cursor ||
            child.rows.length > 1000)
        )
          throw new Error('The child list is incomplete.');
        cursor = result.listCoverage.nextCursor;
      } while (cursor !== null);
      child.status = child.rows.length ? 'ready' : 'empty';
      const chosen = child.rows.find(
        (row) =>
          row.record.recordId ===
          url.searchParams.get(`select:${definition.datasetId}`),
      )?.record;
      if (chosen) {
        data.selections[definition.datasetId] = chosen;
        data.selected = chosen;
        data.selectedDatasetId = definition.datasetId;
      }
    } catch {
      child.rows = [];
      child.status = 'failed';
      child.error = 'COMPOSITION_CHILD_FAILED';
    }
  }
  const activeDataset = url.searchParams.get('dataset');
  data.selectedDatasetId =
    activeDataset && data.selections[activeDataset] ? activeDataset : null;
  data.selected = data.selectedDatasetId
    ? data.selections[data.selectedDatasetId]!
    : null;
  return data;
}

function resolveValue(
  value: Value,
  data: CompositionData,
  inputs: Readonly<Record<string, string>>,
  results: Readonly<Record<string, SemanticRecordDto>>,
  generated: Record<string, string>,
  key = '',
): ImmutableJsonValue {
  switch (value.source) {
    case 'literal':
      return value.value;
    case 'record':
      return recordValue(data.record, value.field);
    case 'selected':
      return recordValue(
        value.datasetId
          ? (data.selections[value.datasetId] ?? null)
          : data.selected,
        value.field,
      );
    case 'input': {
      const input = inputs[value.inputId];
      if (input === undefined) throw new Error('A task input is missing.');
      // Admission refuses an empty required input, so an empty one here is an
      // optional input left blank: it is no value, never an empty string --
      // which a decimal, enumeration or date field would refuse.
      return input === '' ? null : input;
    }
    case 'step':
      return recordValue(results[value.stepId] ?? null, value.field);
    case 'generated': {
      if (value.value === 'scope') {
        if (!data.scope) throw new Error('Choose a legal entity.');
        return data.scope;
      }
      return (generated[key] ??=
        value.value === 'instant' ? new Date().toISOString() : randomUUID());
    }
  }
}
type Condition = Action['conditions'][number];
/** A declared condition over governed values; an unavailable value never holds. */
function holds(condition: Condition, data: CompositionData): boolean {
  try {
    const actual = resolveValue(condition.value, data, {}, {}, {});
    if (condition.operator === 'positive')
      return typeof actual === 'string' && POSITIVE_DECIMAL.test(actual);
    return condition.operator === 'equals'
      ? actual === condition.compare
      : actual !== condition.compare;
  } catch {
    return false;
  }
}
/**
 * The rows a multi-row Task works through: the loaded rows of its dataset
 * whose conditions hold, each judged as that row's `selected` values, in the
 * dataset's order. A dataset that failed to load offers none.
 */
function taskRows(action: Action, data: CompositionData): Row[] {
  const rows = action.rows;
  if (!rows) return [];
  const child = data.children.find(
    (value) => value.definition.datasetId === rows.datasetId,
  );
  if (!child || child.status !== 'ready') return [];
  return child.rows.filter((row) =>
    rows.conditions.every((condition) =>
      holds(condition, withRow(data, rows.datasetId, row.record)),
    ),
  );
}
function applicable(action: Action, data: CompositionData): boolean {
  if (
    action.datasetId &&
    (!data.selected || action.datasetId !== data.selectedDatasetId)
  )
    return false;
  if (!action.conditions.every((condition) => holds(condition, data)))
    return false;
  // A link opens a stated record; a multi-row Task needs a row to work on.
  if (action.navigate) {
    try {
      const target = resolveValue(action.navigate.record, data, {}, {}, {});
      if (typeof target !== 'string' || !target) return false;
    } catch {
      return false;
    }
  }
  return !action.rows || taskRows(action, data).length > 0;
}

/** Presentation consumes refreshed, governed cells; it never derives business quantities. */
export function renderCompositionHeader(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string {
  const header = surface.composition?.presentation?.header;
  if (!header) return '';
  if (data.fieldsFailed)
    return compositionMessage('COMPOSITION_CHILD_FAILED', 'alert');
  const cell = (id: string) => h(data.fields.cells[id] ?? '—');
  const label = (id: string) =>
    h(
      surface.composition!.fields.find((column) => column.columnId === id)!
        .label,
    );
  return `<header class="composition-header"><p class="eyebrow">${h(surface.label)}</p><div class="composition-heading"><div><h1>${cell(header.title)}</h1><p class="composition-subtitle">${header.subtitle.map(cell).join(' · ')}</p></div>${header.status ? `<span class="composition-business-status">${cell(header.status)}</span>` : ''}</div><dl class="composition-header-facts">${header.facts.map((id) => `<div><dt>${label(id)}</dt><dd>${cell(id)}</dd></div>`).join('')}</dl></header>`;
}
/** A dataset's row name: its primary cell, else its first column's. */
function rowName(
  definition: SurfaceComposition['children'][number],
  row: Row,
): string {
  const named =
    definition.columns.find(
      (column) => column.presentation?.role === 'primary',
    ) ?? ordered(definition.columns)[0];
  return named ? (row.cells[named.columnId] ?? '—') : row.record.recordId;
}

/**
 * Declared exception banners (`presentation.alerts`): each shows while any
 * loaded row of its dataset states a positive value in its column, and names
 * those rows by their primary cell with that value -- an order's lines that
 * are short. A presence test over governed cells, never a derived total; a
 * dataset that failed to load states nothing. Not a live region, so it never
 * competes with an outcome's status.
 */
export function renderCompositionAlerts(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string {
  return (surface.composition?.presentation?.alerts ?? [])
    .map((alert, index) => {
      const child = data.children.find(
        (value) => value.definition.datasetId === alert.datasetId,
      );
      const column = child?.definition.columns.find(
        (value) => value.columnId === alert.columnId,
      );
      if (!child || !column || child.status !== 'ready') return '';
      const flagged = child.rows.filter((row) => {
        try {
          const value = recordValue(row.record, column.field);
          return typeof value === 'string' && POSITIVE_DECIMAL.test(value);
        } catch {
          return false;
        }
      });
      if (!flagged.length) return '';
      const heading = `composition-alert-${String(index)}`;
      return `<section class="composition-alert" aria-labelledby="${heading}" data-composition-alert="${h(alert.columnId)}"><span class="composition-alert-marker" aria-hidden="true">!</span><div><h2 id="${heading}">${h(alert.label)}</h2><p>${h(alert.description)}</p><ul>${flagged.map((row) => `<li data-record-id="${h(row.record.recordId)}"><strong>${h(rowName(child.definition, row))}</strong> <span>${h(column.label)} ${h(row.cells[column.columnId] ?? '—')}</span></li>`).join('')}</ul></div></section>`;
    })
    .join('');
}

type ProgressionStepState =
  'complete' | 'current' | 'attention' | 'stopped' | 'upcoming';

/** Each step's state: stopped, needing attention, complete, current, or upcoming. */
export function compositionProgressionStates(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): readonly ProgressionStepState[] {
  const all = (conditions: readonly Condition[] | undefined) =>
    !!conditions?.length &&
    conditions.every((condition) => holds(condition, data));
  return (surface.composition?.presentation?.progression?.steps ?? []).map(
    (step) =>
      all(step.stopped)
        ? 'stopped'
        : all(step.attention)
          ? 'attention'
          : all(step.complete)
            ? 'complete'
            : all(step.current)
              ? 'current'
              : 'upcoming',
  );
}

const PROGRESSION_STATE_LABELS: Readonly<Record<ProgressionStepState, string>> =
  Object.freeze({
    attention: 'Needs attention',
    complete: 'Complete',
    current: 'Current',
    stopped: 'Stopped',
    upcoming: 'Upcoming',
  });

/**
 * The record's progression (`presentation.progression`): its steps in order,
 * each with its state from the record's own values and its connected
 * documents, and the first next entry offered now -- an action of this page
 * by its own conditions, or an operation the record page offers now (the
 * caller renders that, as its command bar does). Each next control carries
 * its own accessible name, so it never doubles a control elsewhere on the
 * page; none is offered while a Task is open.
 */
export function renderCompositionProgression(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
  view: RequestRuntimeView,
  operationControl: (operationId: string, name: string) => string | null,
  offerNext = true,
): string {
  const progression = surface.composition?.presentation?.progression;
  if (!progression || data.fieldsFailed) return '';
  const states = compositionProgressionStates(surface, data);
  const documents = (datasetId: string, label: string) => {
    const child = data.children.find(
      (value) => value.definition.datasetId === datasetId,
    );
    if (!child || child.status !== 'ready') return '';
    const opener = surface.composition!.actions.find(
      (action) =>
        action.datasetId === datasetId &&
        action.presentation?.placement === 'row' &&
        action.navigate,
    );
    const shown = child.rows.slice(0, 6);
    return `<ul class="composition-progression-documents" aria-label="${h(`${label} documents`)}">${shown
      .map((row) => {
        const rowData = withRow(data, datasetId, row.record);
        const name = h(rowName(child.definition, row));
        return `<li>${opener && applicable(opener, rowData) ? `<a href="${h(navigateHref(opener, rowData, view))}">${name}</a>` : `<span>${name}</span>`}</li>`;
      })
      .join(
        '',
      )}${child.rows.length > shown.length ? `<li><a href="#${h(datasetId)}">${h(`${String(child.rows.length - shown.length)} more in ${child.definition.label}`)}</a></li>` : ''}</ul>`;
  };
  const steps = progression.steps
    .map((step, index) => {
      const state = states[index]!;
      const marker =
        state === 'complete'
          ? '✓'
          : state === 'attention'
            ? '!'
            : state === 'stopped'
              ? '✕'
              : String(index + 1);
      return `<li data-step-state="${state}"${state === 'current' || state === 'attention' ? ' aria-current="step"' : ''}><span class="composition-progression-marker" aria-hidden="true">${marker}</span><div><span class="composition-progression-state">${PROGRESSION_STATE_LABELS[state]}</span><strong>${h(step.label)}</strong>${step.documents ? documents(step.documents, step.label) : ''}</div></li>`;
    })
    .join('');
  // A stopped record (a cancelled order) has no next step.
  let next = '';
  const offered = offerNext && !states.includes('stopped');
  for (const entry of offered ? progression.next : []) {
    if ('action' in entry) {
      const action = surface.composition!.actions.find(
        (value) => value.actionId === entry.action,
      );
      if (action && applicable(action, data)) {
        next = `<div class="composition-progression-next" data-next-action="${h(action.actionId)}"><div><p class="eyebrow">Next action</p><strong>${h(action.label)}</strong><p>${h(action.description)}</p></div>${actionLink(action, data, view, `Next action: ${action.label}`)}</div>`;
        break;
      }
    } else {
      const control = operationControl(entry.operation.targetId, 'Next action');
      if (control) {
        next = `<div class="composition-progression-next" data-next-operation="${h(entry.operation.targetId)}"><div><p class="eyebrow">Next action</p></div>${control}</div>`;
        break;
      }
    }
  }
  return `<section class="panel composition-progression" aria-labelledby="composition-progression-heading" data-composition-progression><header><p class="eyebrow">Record progression</p><h2 id="composition-progression-heading">${h(progression.title)}</h2></header><ol class="composition-progression-steps">${steps}</ol>${next}</section>`;
}

function selectionUrl(
  data: CompositionData,
  datasetId: string,
  recordId: string,
): URL {
  const url = new URL(data.url, 'http://surface-runtime.local');
  url.searchParams.set('dataset', datasetId);
  url.searchParams.set('selected', recordId);
  url.searchParams.set(`select:${datasetId}`, recordId);
  url.hash = datasetId;
  return url;
}
/**
 * Where a navigate action leads: its target page for the resolved record, in
 * the page's company. A document opened from this one (a row's receipt) comes
 * back here; the record this one refers to (an invoice's order) is opened as
 * itself, with no way "back" to a page that is not its own.
 */
function navigateHref(
  action: Action,
  data: CompositionData,
  view: RequestRuntimeView,
): string {
  const navigate = action.navigate!;
  const url = new URL(data.url, 'http://surface-runtime.local');
  url.hash = '';
  for (const name of [...url.searchParams.keys()])
    if (
      navigate.record.source === 'record' &&
      (name === 'dataset' || name === 'selected' || name.startsWith('select:'))
    )
      url.searchParams.delete(name);
  url.searchParams.set('surface', navigate.surface.targetId);
  url.searchParams.set(
    'record',
    String(resolveValue(navigate.record, data, {}, {}, {})),
  );
  if (navigate.record.source === 'record') url.searchParams.delete('returnTo');
  else url.searchParams.set('returnTo', data.url);
  const target = registeredSemanticQueryFromPinnedView(
    view,
    navigate.query.targetId,
  );
  if (target?.legalEntityScope && data.scope)
    url.searchParams.set(
      target.legalEntityScope.operand.parameterId,
      data.scope,
    );
  return url.pathname + url.search;
}
function actionLink(
  action: Action,
  data: CompositionData,
  view: RequestRuntimeView,
  /** An accessible name that differs from a control of the same label elsewhere on the page. */
  name?: string,
): string {
  const named = name ? ` aria-label="${h(name)}"` : '';
  if (action.navigate)
    return `<a class="button" href="${h(navigateHref(action, data, view))}"${named}>${h(action.label)}</a>`;
  return `<form method="post" action="${h(data.url)}"><input type="hidden" name="compositionAction" value="${h(action.actionId)}"><button type="submit"${named}>${h(action.label)}</button></form>`;
}
function renderPresentedChild(
  child: CompositionData['children'][number],
  data: CompositionData,
  surface: CompiledSurfaceDefinition,
  view: RequestRuntimeView,
): string {
  const definition = child.definition;
  const columns = [...definition.columns].sort(
    (a, b) =>
      (a.presentation?.priority ?? a.orderKey) -
      (b.presentation?.priority ?? b.orderKey),
  );
  const primary = columns.find(
    (column) => column.presentation?.role === 'primary',
  );
  const secondary = primary
    ? columns.filter((column) => column.presentation?.role === 'secondary')
    : [];
  const detail = columns.filter(
    (column) => column.presentation?.role === 'detail',
  );
  const displayed = primary
    ? columns.filter(
        (column) => !secondary.includes(column) && !detail.includes(column),
      )
    : columns;
  const actions = ordered(surface.composition!.actions).filter(
    (action) => action.datasetId === definition.datasetId,
  );
  const rowActions = actions.filter(
    (action) => action.presentation?.placement === 'row',
  );
  const cells = (row: Row, values: Column[]) =>
    values
      .map(
        (column) =>
          `<span><span class="composition-cell-label">${h(column.label)}</span> ${h(row.cells[column.columnId] ?? '—')}</span>`,
      )
      .join('');
  const body =
    child.status === 'failed'
      ? childFailure(child.error)
      : child.status === 'empty'
        ? compositionMessage('COMPOSITION_CHILD_EMPTY')
        : `<div class="data-table-wrap"${definition.presentation?.compact ? ` data-compact="${h(definition.presentation.compact)}" tabindex="0" role="region" aria-label="${h(definition.label)} table; scroll for all columns"` : ''}><table><thead><tr>${displayed.map((column) => `<th scope="col" class="${column.presentation?.role === 'quantity' ? 'composition-quantity' : ''}">${h(column.label)}</th>`).join('')}${detail.length ? '<th scope="col">Details</th>' : ''}${definition.presentation?.selection !== 'none' || rowActions.length ? '<th scope="col">Actions</th>' : ''}</tr></thead><tbody>${child.rows
            .map((row) => {
              const selected =
                data.selections[definition.datasetId]?.recordId ===
                row.record.recordId;
              const active =
                selected && data.selectedDatasetId === definition.datasetId;
              const url = selectionUrl(
                data,
                definition.datasetId,
                row.record.recordId,
              );
              const rowData: CompositionData = {
                ...data,
                // A Task POST keeps selection in its query, without a fragment
                // that could override the dialog's initial focus after navigation.
                url: url.pathname + url.search,
                selected: row.record,
                selectedDatasetId: definition.datasetId,
                selections: {
                  ...data.selections,
                  [definition.datasetId]: row.record,
                },
              };
              const selectedActions =
                active && definition.presentation?.selectedActions === 'row'
                  ? actions.filter(
                      (action) =>
                        action.presentation?.placement === 'selection' &&
                        applicable(action, rowData),
                    )
                  : [];
              return `<tr data-compact-card="true" data-presented-row="true" data-record-id="${h(row.record.recordId)}" ${selected ? 'data-selected="true"' : ''}>${displayed.map((column) => `<td data-column-label="${h(column.label)}" data-column-priority="${column.presentation?.priority ?? column.orderKey}" data-cell-role="${column.presentation?.role ?? 'value'}">${column === primary ? `<strong>${h(row.cells[column.columnId] ?? '—')}</strong><div class="composition-cell-secondary">${cells(row, secondary)}</div>` : h(row.cells[column.columnId] ?? '—')}</td>`).join('')}${detail.length ? `<td data-cell-role="detail" data-column-label="Details"><details><summary>Supporting details</summary><div class="composition-cell-secondary">${cells(row, detail)}</div></details></td>` : ''}${
                definition.presentation?.selection !== 'none' ||
                rowActions.length
                  ? `<td data-cell-role="actions" data-column-label="Actions">${selectedActions.map((action) => actionLink(action, rowData, view)).join('')}${definition.presentation?.selection !== 'none' ? `<a href="${h(url.pathname + url.search + url.hash)}" ${active ? 'aria-current="true"' : ''}>${active ? 'Selected' : 'Select'}</a>` : ''}${rowActions
                      .filter((action) => applicable(action, rowData))
                      .map((action) => actionLink(action, rowData, view))
                      .join('')}</td>`
                  : ''
              }</tr>`;
            })
            .join('')}</tbody></table></div>`;
  return `<section id="${h(definition.datasetId)}" class="panel data-panel composition-collection" data-composition-dataset="${h(definition.datasetId)}" data-resolution="${child.status}"><div class="composition-collection-heading"><h2>${h(definition.label)}</h2>${definition.presentation?.description ? `<details><summary>About these quantities</summary><p class="composition-description">${h(definition.presentation.description)}</p></details>` : ''}</div>${body}</section>`;
}
/** The URL of this record's printable document, preserving its scope. */
export function compositionPrintHref(data: CompositionData): string {
  const url = new URL(data.url, 'http://surface-runtime.local');
  for (const name of [...url.searchParams.keys()])
    if (name === 'dataset' || name === 'selected' || name.startsWith('select:'))
      url.searchParams.delete(name);
  url.searchParams.set('print', 'document');
  return url.pathname + url.search;
}

/**
 * A declared printable document (composition `presentation.print`): the header,
 * each named dataset IN FULL and the note, from the same governed load as the
 * record page. A dataset that failed or stopped short refuses the document --
 * a printed order is never the first page of one.
 */
export function renderCompositionPrintDocument(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
  generatedAt: Date,
): { readonly complete: boolean; readonly html: string } {
  const print = surface.composition?.presentation?.print;
  const header = surface.composition?.presentation?.header;
  if (!print || !header) return { complete: false, html: '' };
  const printed = print.datasets.map((id) =>
    data.children.find((child) => child.definition.datasetId === id),
  );
  if (
    data.fieldsFailed ||
    printed.some((child) => !child || child.status === 'failed')
  )
    return {
      complete: false,
      html: compositionMessage('COMPOSITION_CHILD_FAILED', 'alert'),
    };
  const cell = (id: string) => h(data.fields.cells[id] ?? '—');
  const label = (id: string) =>
    h(
      surface.composition!.fields.find((column) => column.columnId === id)
        ?.label ?? '',
    );
  const tables = printed
    .map((child) => {
      const columns = ordered(child!.definition.columns);
      return `<section class="print-section"><h2>${h(child!.definition.label)}</h2>${
        child!.rows.length === 0
          ? '<p>None.</p>'
          : `<div class="print-table"><table><thead><tr>${columns.map((column) => `<th scope="col">${h(column.label)}</th>`).join('')}</tr></thead><tbody>${child!.rows
              .map(
                (row) =>
                  `<tr>${columns.map((column) => `<td>${h(row.cells[column.columnId] ?? '—')}</td>`).join('')}</tr>`,
              )
              .join(
                '',
              )}</tbody></table></div><p class="print-count">${String(child!.rows.length)} ${child!.rows.length === 1 ? 'line' : 'lines'}</p>`
      }</section>`;
    })
    .join('');
  const note = print.note ? data.fields.cells[print.note] : undefined;
  // Totals print as a labelled list under the lines: subtotal, tax, total.
  const totals = print.totals?.length
    ? `<dl class="print-totals">${print.totals.map((id) => `<div><dt>${label(id)}</dt><dd>${cell(id)}</dd></div>`).join('')}</dl>`
    : '';
  // A block prints its present lines in order, such as a ship-to address.
  const blocks = (surface.composition!.presentation?.blocks ?? [])
    .map((block) => {
      const lines = block.columns
        .map((id) => data.fields.cells[id])
        .filter((value): value is string => !!value && value !== '—');
      return `<section class="print-block"><h2>${h(block.label)}</h2>${lines.length ? `<p>${lines.map((line) => h(line)).join('<br>')}</p>` : '<p>None.</p>'}</section>`;
    })
    .join('');
  return {
    complete: true,
    html: `<article class="print-document" data-print-document="${h(surface.surfaceId)}"><header class="print-header"><p class="eyebrow">${h(print.label)}</p><h1>${cell(header.title)}</h1><p>${header.subtitle.map(cell).join(' · ')}</p>${header.status ? `<p class="print-status">${cell(header.status)}</p>` : ''}<dl class="print-facts">${header.facts.map((id) => `<div><dt>${label(id)}</dt><dd>${cell(id)}</dd></div>`).join('')}</dl></header>${blocks}${tables}${totals}${note && note !== '—' ? `<section class="print-section"><h2>${label(print.note!)}</h2><p class="print-note">${h(note)}</p></section>` : ''}<footer class="print-footer"><p>Printed ${h(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC from the current record.</p><p class="print-guidance">Use your browser's Print command to print this document or save it as PDF.</p></footer></article>`,
  };
}

export function renderCompositionFields(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string {
  if (data.fieldsFailed)
    return compositionMessage('COMPOSITION_CHILD_FAILED', 'alert');
  const header = surface.composition!.presentation?.header;
  const assigned = header
    ? [
        header.title,
        ...header.subtitle,
        ...header.facts,
        ...(header.status ? [header.status] : []),
      ]
    : [];
  const blocks = surface.composition!.presentation?.blocks ?? [];
  const blocked = new Set(blocks.flatMap((block) => block.columns));
  const fields = surface.composition!.fields.filter(
    (column) =>
      !assigned.includes(column.columnId) && !blocked.has(column.columnId),
  );
  if (!fields.length && !blocks.length) return '';
  // A block reads as one card of its present lines, such as a ship-to
  // address, placed where its first column would be.
  const place = (columnId: string) =>
    surface.composition!.fields.find((column) => column.columnId === columnId)
      ?.orderKey ?? 0;
  const cards = [
    ...fields.map((column) => ({
      orderKey: column.orderKey,
      html: `<div><dt>${h(column.label)}</dt><dd>${h(data.fields.cells[column.columnId] ?? '—')}</dd></div>`,
    })),
    ...blocks.map((block) => {
      const lines = block.columns
        .map((id) => data.fields.cells[id])
        .filter((value): value is string => !!value && value !== '—');
      return {
        orderKey: place(block.columns[0]!),
        // One compact line on screen; printed documents keep one per line.
        html: `<div data-composition-block><dt>${h(block.label)}</dt><dd>${lines.length ? lines.map((line) => h(line)).join(', ') : '—'}</dd></div>`,
      };
    }),
  ].sort((left, right) => left.orderKey - right.orderKey);
  // Stored fields the header does not carry, read back as saved. Under a
  // declared header the label is already the page's identity, so it is not
  // repeated as this panel's heading.
  return `<section class="panel" data-composition-fields><h2>${h(header ? 'Details' : surface.label)}</h2><dl class="record-fields">${cards.map((card) => card.html).join('')}</dl></section>`;
}
export function renderCompositionChildren(
  data: CompositionData,
  surface?: CompiledSurfaceDefinition,
  view?: RequestRuntimeView,
): string {
  const children = data.children
    .map((child) => {
      if (child.definition.presentation && surface && view)
        return renderPresentedChild(child, data, surface, view);
      const columns = ordered(child.definition.columns);
      return `<section class="panel data-panel" data-composition-dataset="${h(child.definition.datasetId)}" data-resolution="${child.status}"><h2>${h(child.definition.label)}</h2>${
        child.status === 'failed'
          ? childFailure(child.error)
          : child.status === 'empty'
            ? compositionMessage('COMPOSITION_CHILD_EMPTY')
            : `<div class="data-table-wrap"><table><thead><tr><th>Select</th>${columns.map((column) => `<th scope="col">${h(column.label)}</th>`).join('')}</tr></thead><tbody>${child.rows
                .map((row) => {
                  const url = new URL(data.url, 'http://surface-runtime.local');
                  url.searchParams.set('dataset', child.definition.datasetId);
                  url.searchParams.set('selected', row.record.recordId);
                  url.searchParams.set(
                    `select:${child.definition.datasetId}`,
                    row.record.recordId,
                  );
                  return `<tr data-compact-card="true" data-record-id="${h(row.record.recordId)}"><td data-column-label="Select" data-column-priority="0"><a href="${h(url.pathname + url.search)}" ${data.selected?.recordId === row.record.recordId ? 'aria-current="true"' : ''}>${data.selected?.recordId === row.record.recordId ? 'Selected' : 'Select'}</a></td>${columns.map((column, index) => `<td data-column-label="${h(column.label)}" data-column-priority="${index + 1}">${h(row.cells[column.columnId] ?? '—')}</td>`).join('')}</tr>`;
                })
                .join('')}</tbody></table></div>`
      }</section>`;
    })
    .join('');
  return children;
}

export function renderCompositionActions(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
  view: RequestRuntimeView,
): string {
  const presentation = surface.composition!.presentation;
  if (presentation) {
    const returnTo = new URL(
      data.url,
      'http://surface-runtime.local',
    ).searchParams.get('returnTo');
    const back = returnTo?.startsWith('/?')
      ? `<a class="composition-back" href="${h(returnTo)}">Back to order</a>`
      : '';
    const printLink = presentation.print
      ? `<a class="secondary-action composition-print" href="${h(compositionPrintHref(data))}">Print ${h(presentation.print.label.toLowerCase())}</a>`
      : '';
    const context = presentation.context;
    const actions = ordered(surface.composition!.actions).filter(
      (value) =>
        value.presentation?.placement === 'selection' &&
        data.children.find(
          (child) => child.definition.datasetId === value.datasetId,
        )?.definition.presentation?.selectedActions !== 'row' &&
        applicable(value, data),
    );
    const selectedChild = data.children.find(
      (child) => child.definition.datasetId === data.selectedDatasetId,
    );
    const selectedRow = selectedChild?.rows.find(
      (row) => row.record.recordId === data.selected?.recordId,
    );
    const primary = selectedChild?.definition.columns.find(
      (column) => column.presentation?.role === 'primary',
    );
    const selection =
      primary && selectedRow
        ? data.children
            .flatMap((child) => {
              const row = child.rows.find(
                (row) =>
                  row.record.recordId ===
                  data.selections[child.definition.datasetId]?.recordId,
              );
              const identity = child.definition.columns.find(
                (column) => column.presentation?.role === 'primary',
              );
              return row && identity ? [row.cells[identity.columnId]] : [];
            })
            .join(' · ')
        : null;
    // Record-level tasks (no dataset to select from) are offered together,
    // beside the context they change, such as a customer's order defaults.
    const recordTasks = ordered(surface.composition!.actions).filter(
      (value) =>
        !value.presentation && !value.datasetId && applicable(value, data),
    );
    const controls = actions.length
      ? actionLink(actions[0]!, data, view) +
        (actions.length > 1
          ? `<details class="composition-context-overflow"><summary>More actions (${actions.length - 1})</summary>${actions
              .slice(1)
              .map((action) => actionLink(action, data, view))
              .join('')}</details>`
          : '')
      : '';
    // The printable document is offered beside the section links, so it adds
    // no row above the document's first lines.
    const tasks = recordTasks.length
      ? `<div class="composition-local-actions" aria-label="Record tasks">${recordTasks.map((action) => actionLink(action, data, view)).join('')}</div>`
      : '';
    return `${back}${context ? '' : printLink}${context ? `<section class="composition-context">${controls || tasks ? `<div class="composition-context-heading"><div><h2>${h(context.label)}</h2><p>${h(selection ?? context.description)}</p></div>${controls ? `<div class="composition-local-actions" aria-label="Selected record actions">${controls}</div>` : ''}${tasks}</div>` : ''}<div class="composition-context-links"><nav aria-label="Document sections">${data.children.map((child) => `<a href="#${h(child.definition.datasetId)}">${h(child.definition.label)}</a>`).join('')}</nav>${printLink}</div></section>` : ''}`;
  }
  const actions = ordered(surface.composition!.actions)
    .filter((action) => applicable(action, data))
    .map((action) => actionLink(action, data, view))
    .join('');
  const returnTo = new URL(
    data.url,
    'http://surface-runtime.local',
  ).searchParams.get('returnTo');
  const back = returnTo?.startsWith('/?')
    ? `<p><a href="${h(returnTo)}">Back to order</a></p>`
    : '';
  return `<div class="composition-actions">${back}${surface.composition!.actions.length ? `<section class="panel command-bar" aria-label="Selected record actions">${actions || compositionMessage('COMPOSITION_SELECTION_REQUIRED')}</section>` : ''}</div>`;
}

type TaskInput = Action['inputs'][number];

/**
 * The operation field a Task input is bound to by its steps, read from the
 * pinned operation contract. A text input bound to a decimal field takes the
 * shared exact-decimal semantics and that field's bounds; nothing is inferred
 * from the input's label or id.
 */
function boundInputField(
  view: RequestRuntimeView,
  action: Action,
  inputId: string,
): CompiledSurfaceInputField | null {
  const catalog = parsePinnedOperationCatalog(
    view.projections.operation.payload,
  );
  for (const step of action.steps)
    for (const binding of step.bindings) {
      if (
        binding.value.source !== 'input' ||
        binding.value.inputId !== inputId ||
        binding.path.length !== 2 ||
        (binding.path[0] !== 'values' && binding.path[0] !== 'patch')
      )
        continue;
      const field = catalog
        .find((operation) => operation.operationId === step.operation.targetId)
        ?.inputContract?.fields.find(
          (candidate) => candidate.fieldId === binding.path[1],
        );
      if (field)
        return {
          fieldId: field.fieldId,
          kind: field.fieldKind,
          bounds: field.bounds,
          required: field.required,
          temporal: field.temporal,
        } as unknown as CompiledSurfaceInputField;
    }
  return null;
}

/**
 * A derived input's value, read on the server from the row the action
 * selected: the declared column's field, through its declared exact get where
 * the column names one. It is never taken from the submission, so an operator
 * cannot type a unit that disagrees with the selected product.
 */
async function derivedInputValue(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  data: CompositionData,
  column: TaskColumn,
): Promise<string | null> {
  const declared = data.children
    .find((child) => child.definition.datasetId === column.datasetId)
    ?.definition.columns.find((value) => value.columnId === column.columnId);
  const selected = data.selections[column.datasetId];
  if (!declared || !selected) return null;
  const value = recordValue(selected, declared.field);
  if (declared.reference && typeof value === 'string' && value) {
    const result = await query(
      view,
      gateways,
      declared.reference.query.targetId,
      data.scope,
      { recordId: value, includeArchived: false },
    );
    if (result.outcome !== 'exact' || result.records.length !== 1) return null;
    const derived = recordValue(
      result.records[0]!,
      declared.reference.labelField.targetId,
    );
    return typeof derived === 'string' && derived ? derived : null;
  }
  return typeof value === 'string' && value ? value : null;
}

/** How a reviewed input reads: a choice by its offered label, anything else as entered. */
function shownInput(input: TaskInput, value: string): string {
  return input.presentation?.kind === 'choice'
    ? (input.presentation.options.find((option) => option.value === value)
        ?.label ?? value)
    : value;
}

/** A choice input's initial value: a stored record value it offers, else its declared default. */
function choiceDefault(input: TaskInput, data: CompositionData | null): string {
  const presentation = input.presentation;
  if (presentation?.kind !== 'choice') return '';
  if (presentation.defaultFrom && data) {
    try {
      const stored = recordValue(data.record, presentation.defaultFrom.field);
      if (
        typeof stored === 'string' &&
        presentation.options.some((option) => option.value === stored)
      )
        return stored;
    } catch {
      /* An unavailable record value is simply no default. */
    }
  }
  return presentation.defaultValue ?? '';
}

/** A reference input's initial choice: the record's stored value, when it is offered. */
function referenceDefault(
  input: TaskInput,
  data: CompositionData | null,
  choices: readonly SemanticRecordDto[],
): string {
  if (!input.defaultFrom || !data) return '';
  try {
    const stored = recordValue(data.record, input.defaultFrom.field);
    return typeof stored === 'string' &&
      choices.some((choice) => choice.recordId === stored)
      ? stored
      : '';
  } catch {
    /* An unavailable record value is simply no default. */
    return '';
  }
}

type TaskPresentation = NonNullable<
  NonNullable<Action['presentation']>['task']
>;
type TaskColumn = TaskPresentation['summary']['identity'];
interface TaskConfirmationSnapshot {
  readonly identity: string;
  readonly secondary: string | null;
  readonly quantity: string;
  readonly unit: string;
  readonly context: string | null;
}
function taskColumnText(data: CompositionData, reference: TaskColumn): string {
  const child = data.children.find(
    (child) => child.definition.datasetId === reference.datasetId,
  );
  const row = child?.rows.find(
    (row) =>
      row.record.recordId === data.selections[reference.datasetId]?.recordId,
  );
  return row?.cells[reference.columnId] ?? '—';
}
function renderTaskSummary(
  data: CompositionData,
  task: TaskPresentation,
): string {
  const summary = task.summary;
  return `<section class="composition-task-summary" aria-label="Task selection"><strong>${h(taskColumnText(data, summary.identity))}</strong>${summary.secondary ? `<span class="muted">${h(taskColumnText(data, summary.secondary))}</span>` : ''}${summary.context ? `<p>${h(taskColumnText(data, summary.context))}</p>` : ''}${summary.quantity ? `<p><strong>${h(taskColumnText(data, summary.quantity.value))} ${h(taskColumnText(data, summary.quantity.unit))}</strong> ${h(summary.quantity.label)}</p>` : ''}</section>`;
}
function renderTaskConfirmation(
  task: TaskPresentation,
  snapshot: TaskConfirmationSnapshot,
): string {
  return `<section class="composition-task-confirmation" aria-label="Proposed action"><h3>${h(task.confirmation.title)} <strong>${h(snapshot.quantity)} ${h(snapshot.unit)}</strong></h3><p><strong>${h(snapshot.identity)}</strong>${snapshot.secondary ? ` <span class="muted">${h(snapshot.secondary)}</span>` : ''}</p>${snapshot.context ? `<p>${h(snapshot.context)}</p>` : ''}</section>`;
}
/** One run of a step: a step once, or a per-row step once for its row. */
interface TaskRun {
  readonly step: number;
  readonly row: string | null;
}
interface TaskSession {
  action: Action;
  surfaceId: string;
  data: CompositionData;
  identity: string;
  inputs: Record<string, string>;
  /**
   * A multi-row Task's rows, frozen with the context when the Task started,
   * in the dataset's order, and what was entered on each (per-row inputs).
   */
  rowIds: readonly string[];
  rowInputs: Record<string, Record<string, string>>;
  results: Record<string, SemanticRecordDto>;
  generated: Record<string, string>;
  /**
   * The runs to make, in order, with one request key each: fixed when a
   * multi-row Task is first confirmed (its included rows expand its per-row
   * steps), at creation otherwise. A retry replays the same runs and keys.
   */
  plan: readonly TaskRun[] | null;
  keys: string[];
  stepInputs: Record<string, ImmutableJsonValue>[];
  next: number;
  confirmed: boolean;
  preparation: number;
  prepared: {
    readonly id: string;
    readonly inputs: Readonly<Record<string, string>>;
    readonly presentation: TaskConfirmationSnapshot | null;
    /** The rows the plan includes, in order, with their canonical values. */
    readonly rows: readonly string[];
    readonly rowInputs: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
  } | null;
  receipt: string | null;
  created: number;
  busy: boolean;
  committedWithheld: boolean;
}
/** Every run of the Task has committed and was read back. */
const finished = (session: TaskSession) =>
  session.plan !== null && session.next === session.plan.length;
/** The most rows one multi-row Task confirms at once. */
const MAXIMUM_TASK_ROWS = 100;
// Tokens retain the exact plan and retry inputs. They are not business authority:
// each step still goes through current policy, confirmation and the registered gateway.
const sessions = new Map<string, TaskSession>();
const identity = (view: RequestRuntimeView) =>
  JSON.stringify([
    view.tenantId,
    view.environmentId,
    view.principalId,
    view.release.releaseId,
  ]);
export async function submitCompositionAction(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  requestUrl: string,
  submission: Readonly<Record<string, string>>,
  gateways: CompositionGateways,
  renderTask: (
    html: string,
    data: CompositionData | null,
    statusCode: number,
  ) => CompositionResponse,
): Promise<CompositionResponse> {
  let renderData: CompositionData | null = null;
  let displayInputs: Record<string, string> = {};
  let displayChoices: Record<string, SemanticRecordDto[]> = {};
  // Presentation is reloaded through governed reads at every response boundary.
  // Never refresh the frozen execution context, step inputs, keys or outcomes.
  const taskDocument = async (
    html: () => string,
    inputs = session?.inputs ?? {},
    preparation: TaskSession['prepared'] = null,
  ) => {
    renderData = null;
    displayInputs = { ...inputs };
    displayChoices = {};
    if (session) {
      try {
        const result = await query(
          view,
          gateways,
          surface.dataSourceQueryId,
          session.data.scope,
          recordArguments(view, surface, session.data.record.recordId),
        );
        if (
          result.outcome !== 'exact' ||
          result.records.length !== 1 ||
          result.records[0]!.recordId !== session.data.record.recordId
        )
          throw new Error('Task record is unavailable');
        const fresh = await loadSurfaceComposition(
          view,
          surface,
          result.records[0]!,
          session.data.url,
          session.data.scope,
          gateways,
        );
        if (
          fresh.fieldsFailed ||
          fresh.children.some((child) => child.status === 'failed') ||
          Object.entries(session.data.selections).some(
            ([key, selected]) =>
              fresh.selections[key]?.recordId !== selected.recordId,
          )
        )
          throw new Error('Task context is unavailable');
        for (const input of session.action.inputs.filter(
          (input) => input.type === 'reference',
        )) {
          const choices = await referenceChoices(
            view,
            gateways,
            session.data.scope,
            input,
            session.data.record.recordId,
          );
          displayChoices[input.inputId] = choices;
          if (inputs[input.inputId]) {
            const selected = choices.find(
              (choice) => choice.recordId === inputs[input.inputId],
            );
            if (!selected) throw new Error('Task reference is unavailable');
            displayInputs[input.inputId] = text(
              recordValue(selected, input.labelField!.targetId),
            );
          }
        }
        renderData = fresh;
      } catch {
        // Receipts are gateway-issued recovery information, never cached business DTOs.
        const code = session.committedWithheld
          ? 'COMPOSITION_COMMITTED_WITHHELD'
          : finished(session)
            ? 'COMPOSITION_COMPLETE'
            : session.confirmed
              ? 'COMPOSITION_UNCERTAIN'
              : 'COMPOSITION_TASK_UNAVAILABLE';
        return renderTask(
          `<section class="panel" data-composition-task>${compositionMessage(code, 'status')}${session.receipt ? `<pre>${h(session.receipt)}</pre>` : ''}</section>`,
          null,
          session.receipt ? 200 : 422,
        );
      }
    }
    if (preparation && session?.prepared !== preparation)
      return renderTask(
        compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
        renderData,
        422,
      );
    const dialogPolicy = surface.composition?.presentation?.task;
    const taskPolicy = session?.action.presentation?.task;
    const mainReferences = taskPolicy
      ? [
          taskPolicy.summary.identity,
          taskPolicy.summary.secondary,
          taskPolicy.summary.context,
          taskPolicy.summary.quantity?.value,
          taskPolicy.summary.quantity?.unit,
          taskPolicy.confirmation.unit,
          taskPolicy.confirmation.context?.source === 'column'
            ? taskPolicy.confirmation.context
            : undefined,
        ].filter((value): value is TaskColumn => Boolean(value))
      : [];
    const selection =
      renderData?.children
        .flatMap((child) => {
          const selected = renderData?.selections[child.definition.datasetId];
          const row = child.rows.find(
            (row) => row.record.recordId === selected?.recordId,
          );
          return row
            ? [
                `<section><h3>${h(child.definition.label)}</h3><dl class="record-fields">${ordered(
                  child.definition.columns,
                )
                  .filter((column) =>
                    taskPolicy
                      ? !mainReferences.some(
                          (reference) =>
                            reference.datasetId ===
                              child.definition.datasetId &&
                            reference.columnId === column.columnId,
                        )
                      : !dialogPolicy ||
                        ['primary', 'secondary', 'quantity'].includes(
                          column.presentation?.role ?? '',
                        ),
                  )
                  .map(
                    (column) =>
                      `<div><dt>${h(column.label)}</dt><dd>${h(row.cells[column.columnId] ?? '—')}</dd></div>`,
                  )
                  .join('')}</dl></section>`,
              ]
            : [];
        })
        .join('') ?? '';
    if (dialogPolicy && renderData && session) {
      const header = surface.composition!.presentation!.header;
      const phase = session.committedWithheld
        ? 'recovery'
        : finished(session)
          ? 'result'
          : session.confirmed
            ? 'recovery'
            : session.prepared && submission.taskStage !== 'edit'
              ? 'review'
              : 'entry';
      const title = renderData.fields.cells[header.title] ?? surface.label;
      const context = header.subtitle
        .map((id) => renderData!.fields.cells[id])
        .filter(Boolean)
        .join(' · ');
      return renderTask(
        `<section class="composition-task-resume" data-task-resume hidden><div><strong>${h(session.action.label)}</strong><span>Closing dismisses the dialog; it does not cancel submitted work.</span></div><button type="button" data-task-open>${phase === 'result' || phase === 'recovery' ? 'View task outcome' : 'Continue task'}</button><a href="${h(renderData.url)}">Refresh record</a></section><dialog open id="composition-task" class="composition-task-dialog" data-composition-task data-task-fallback="${h(dialogPolicy.fallback)}" data-task-phase="${phase}" aria-labelledby="composition-task-heading"><header class="composition-task-header"><div><p>${h(title)}${context ? ` · ${h(context)}` : ''}</p><h2 id="composition-task-heading" data-task-heading tabindex="-1"${phase === 'entry' ? '' : ' data-task-initial-focus'}>${h(session.action.label)}</h2><span class="muted">${phase === 'entry' ? '1 · Enter details' : phase === 'review' ? '2 · Review and confirm' : phase === 'result' ? '3 · Result' : 'Outcome and recovery'}</span></div><button type="button" class="secondary-action" data-task-close hidden aria-label="Close task">×</button></header><div class="composition-task-body">${taskPolicy && phase === 'entry' ? renderTaskSummary(renderData, taskPolicy) : ''}${!taskPolicy && selection ? `<section class="composition-task-context" aria-label="Current selection">${selection}</section>` : ''}${html()}${taskPolicy && selection ? `<details class="composition-task-support"><summary>Supporting details</summary>${selection}</details>` : ''}</div></dialog>`,
        renderData,
        200,
      );
    }
    return renderTask(
      `<section class="panel" data-composition-task>${session ? `<h1>${h(session.action.label)}</h1>` : ''}${taskPolicy && renderData && !session?.prepared ? renderTaskSummary(renderData, taskPolicy) : ''}<div class="composition-task-layout"><div>${html()}${taskPolicy && selection ? `<details class="composition-task-support"><summary>Supporting details</summary>${selection}</details>` : ''}</div>${!taskPolicy && selection ? `<section class="composition-task-context"><h2>Current selection</h2>${selection}</section>` : ''}</div></section>`,
      renderData,
      renderData ? 200 : 422,
    );
  };
  const now = performance.now();
  for (const [key, session] of sessions)
    if (!session.busy && now - session.created > 3_600_000)
      sessions.delete(key);
  let token = submission.taskToken;
  let session = token ? sessions.get(token) : undefined;
  if (
    token &&
    (!session ||
      session.identity !== identity(view) ||
      session.surfaceId !== surface.surfaceId ||
      new URL(requestUrl, 'http://surface-runtime.local').searchParams.get(
        'record',
      ) !== session.data.record.recordId)
  ) {
    session = undefined;
    return taskDocument(() =>
      compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
    );
  }
  if (!session) {
    if (sessions.size >= 500)
      return taskDocument(() =>
        compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
      );
    const action = surface.composition!.actions.find(
      (candidate) => candidate.actionId === submission.compositionAction,
    );
    const url = new URL(requestUrl, 'http://surface-runtime.local');
    const definition = registeredSemanticQueryFromPinnedView(
      view,
      surface.dataSourceQueryId,
    );
    // A record every company shares (an item) has no company of its own: its
    // page carries the company its entry names under the authorization
    // List's operand, as `resolveWorkspaceEntry` reads it, and its Tasks read
    // their company sections there too (CATALOG-EXTRAS).
    const operand =
      definition?.legalEntityScope ??
      (surface.surfaceRole === 'record' && surface.workspace?.entry
        ? registeredSemanticQueryFromPinnedView(
            view,
            surface.workspace.entry.authorizationQueryId,
          )?.legalEntityScope
        : undefined);
    const scope = operand
      ? url.searchParams.get(operand.operand.parameterId)
      : null;
    const result = await query(
      view,
      gateways,
      surface.dataSourceQueryId,
      scope,
      recordArguments(view, surface, url.searchParams.get('record')),
    );
    if (!action || !result.records[0])
      return taskDocument(() =>
        compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
      );
    const data = await loadSurfaceComposition(
      view,
      surface,
      result.records[0],
      requestUrl,
      scope,
      gateways,
    );
    if (!applicable(action, data) || !action.steps.length)
      return taskDocument(() =>
        compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
      );
    token = randomUUID();
    session = {
      action,
      surfaceId: surface.surfaceId,
      data,
      identity: identity(view),
      inputs: {},
      rowIds: Object.freeze(
        taskRows(action, data).map((row) => row.record.recordId),
      ),
      rowInputs: {},
      results: {},
      generated: {},
      // A multi-row Task's runs depend on the rows it confirms.
      plan: action.rows
        ? null
        : Object.freeze(action.steps.map((_, step) => ({ step, row: null }))),
      keys: action.rows ? [] : action.steps.map(() => randomUUID()),
      stepInputs: [],
      next: 0,
      confirmed: false,
      preparation: 0,
      prepared: null,
      receipt: null,
      created: now,
      busy: false,
      committedWithheld: false,
    };
    sessions.set(token, session);
  }
  const current = session;
  const url = current.data.url;
  const back = `<p><a href="${h(url)}">Back to order</a></p>`;
  // A multi-row Task: its rows as they were when it started, the inputs asked
  // once per row and those the operator types (a derived one is read).
  const taskRowsDeclared = current.action.rows;
  const rowsDataset = taskRowsDeclared
    ? current.data.children.find(
        (child) => child.definition.datasetId === taskRowsDeclared.datasetId,
      )
    : undefined;
  const frozenRow = (rowId: string) =>
    rowsDataset?.rows.find((row) => row.record.recordId === rowId);
  const headerInputs = current.action.inputs.filter((input) => !input.perRow);
  const perRowInputs = ordered(current.action.inputs).filter(
    (input) => input.perRow,
  );
  const typedPerRow = perRowInputs.filter(
    (input) => input.presentation?.kind !== 'derived',
  );
  const rowField = (inputId: string, rowId: string) => `${inputId}@${rowId}`;
  const rowColumns = () => {
    const columns = rowsDataset ? ordered(rowsDataset.definition.columns) : [];
    return {
      primary:
        columns.find((column) => column.presentation?.role === 'primary') ??
        columns[0],
      secondary: columns.filter(
        (column) => column.presentation?.role === 'secondary',
      ),
      quantities: columns.filter(
        (column) => column.presentation?.role === 'quantity',
      ),
    };
  };
  /** Each row's typed per-row values, as submitted (trimmed). */
  const enteredRows = () =>
    Object.fromEntries(
      current.rowIds.map((rowId) => [
        rowId,
        Object.fromEntries(
          typedPerRow.map((input) => [
            input.inputId,
            (submission[rowField(input.inputId, rowId)] ?? '').trim(),
          ]),
        ),
      ]),
    ) as Record<string, Record<string, string>>;
  // Rows the reviewed plan includes, with what each run will write.
  const previewRows = () => {
    const prepared = current.prepared;
    if (!taskRowsDeclared || !prepared || !rowsDataset) return '';
    const { primary, quantities } = rowColumns();
    return `<div class="data-table-wrap composition-task-rows-review"><table><caption>${h(`${rowsDataset.definition.label} (${String(prepared.rows.length)})`)}</caption><thead><tr><th scope="col">${h(primary?.label ?? '')}</th>${quantities.map((column) => `<th scope="col" class="composition-quantity">${h(column.label)}</th>`).join('')}${perRowInputs.map((input) => `<th scope="col">${h(input.label)}</th>`).join('')}</tr></thead><tbody>${prepared.rows
      .map((rowId) => {
        const row = frozenRow(rowId);
        return `<tr data-compact-card="true" data-task-row="${h(rowId)}"><td data-cell-role="primary" data-column-label="${h(primary?.label ?? '')}"><strong>${h(row ? rowName(rowsDataset.definition, row) : '—')}</strong></td>${quantities.map((column) => `<td data-cell-role="quantity" data-column-label="${h(column.label)}">${h(row?.cells[column.columnId] ?? '—')}</td>`).join('')}${perRowInputs.map((input) => `<td data-column-label="${h(input.label)}">${h(prepared.rowInputs[rowId]?.[input.inputId] || '—')}</td>`).join('')}</tr>`;
      })
      .join('')}</tbody></table></div>`;
  };
  const previewInputs = () =>
    current.action.presentation?.task && current.prepared?.presentation
      ? renderTaskConfirmation(
          current.action.presentation.task,
          current.prepared.presentation,
        )
      : `<dl class="composition-reviewed-inputs">${headerInputs.map((input) => `<div><dt>${h(input.label)}</dt><dd>${h(shownInput(input, displayInputs[input.inputId] ?? ''))}</dd></div>`).join('')}</dl>${previewRows()}`;
  const hidden = `<input type="hidden" name="taskToken" value="${h(token!)}"><input type="hidden" name="compositionAction" value="${h(current.action.actionId)}">`;
  if (current.busy)
    return taskDocument(
      () => `${compositionMessage('COMPOSITION_BUSY', 'status')}${back}`,
    );
  if (current.committedWithheld)
    return taskDocument(
      () =>
        `${compositionMessage('COMPOSITION_COMMITTED_WITHHELD', 'status')}${back}`,
    );
  let error = '';
  // Problems with the entered values, named beside each input.
  const fieldErrors = new Map<string, string>();
  // Problems with a row's entered values, keyed by the row's own input.
  const rowErrors = new Map<string, string>();
  let rowsError = '';
  if (
    submission.taskStage === 'fill' &&
    taskRowsDeclared?.fillLabel &&
    !current.confirmed
  ) {
    // Fill each row from its declared column -- what is still open -- and keep
    // everything else as entered. A row whose figure is not stated stays as it
    // was: nothing is filled on a guess.
    ++current.preparation;
    current.prepared = null;
    current.inputs = Object.fromEntries(
      headerInputs
        .filter((input) => input.presentation?.kind !== 'derived')
        .map((input) => [
          input.inputId,
          (submission[input.inputId] ?? '').trim(),
        ]),
    );
    current.rowInputs = enteredRows();
    for (const rowId of current.rowIds)
      for (const input of typedPerRow) {
        const fill = input.perRow?.fillFrom;
        const column = fill
          ? rowsDataset?.definition.columns.find(
              (value) => value.columnId === fill.columnId,
            )
          : undefined;
        const row = frozenRow(rowId);
        if (!column || !row) continue;
        let value: ImmutableJsonValue = null;
        try {
          value = recordValue(row.record, column.field);
        } catch {
          /* An unstated figure fills nothing. */
        }
        if (typeof value === 'string' && POSITIVE_DECIMAL.test(value))
          current.rowInputs[rowId]![input.inputId] = value;
      }
  }
  if (submission.taskStage === 'prepare' && !current.confirmed) {
    const generation = ++current.preparation;
    current.prepared = null;
    const collected: Record<string, string> = {};
    for (const input of headerInputs) {
      const presentation = input.presentation;
      let value = (submission[input.inputId] ?? '').trim();
      if (presentation?.kind === 'derived') {
        // Read on the server from the selected row; the submission is ignored.
        value =
          (await derivedInputValue(
            view,
            gateways,
            current.data,
            presentation.column,
          ).catch(() => null)) ?? '';
        if (!value)
          fieldErrors.set(
            input.inputId,
            'Not available for the selected line.',
          );
      } else if (!admitsChoice(input, value)) {
        fieldErrors.set(input.inputId, 'Choose one of the offered values.');
        value = '';
      } else if (value && input.type === 'text') {
        const bound = boundInputField(view, current.action, input.inputId);
        if (bound && DECIMAL_KINDS.includes(bound.kind)) {
          const problem = decimalProblem(value, bound);
          if (problem) fieldErrors.set(input.inputId, problem);
          else value = canonicalDecimal(value) ?? value;
        }
      }
      if (input.type === 'quantity' && value && !POSITIVE_DECIMAL.test(value))
        fieldErrors.set(input.inputId, 'Enter a positive exact quantity.');
      if (input.required && !value && !fieldErrors.has(input.inputId))
        fieldErrors.set(input.inputId, 'Required.');
      collected[input.inputId] = value;
    }
    // Each row the operator entered something on is included; a row left
    // empty is skipped. Without inputs to type, every row is included.
    const includedRows: string[] = [];
    const preparedRows: Record<string, Record<string, string>> = {};
    if (taskRowsDeclared) {
      const entered = enteredRows();
      for (const rowId of current.rowIds) {
        const row = frozenRow(rowId);
        const values = entered[rowId]!;
        if (
          !row ||
          (typedPerRow.length &&
            typedPerRow.every((input) => !values[input.inputId]))
        )
          continue;
        const canonical: Record<string, string> = {};
        for (const input of perRowInputs) {
          const key = rowField(input.inputId, rowId);
          const presentation = input.presentation;
          let value = values[input.inputId] ?? '';
          if (presentation?.kind === 'derived') {
            // Read on the server from this row; never from the submission.
            value =
              (await derivedInputValue(
                view,
                gateways,
                withRow(current.data, taskRowsDeclared.datasetId, row.record),
                presentation.column,
              ).catch(() => null)) ?? '';
            if (!value) rowErrors.set(key, 'Not available for this line.');
          } else if (value && input.type === 'text') {
            const bound = boundInputField(view, current.action, input.inputId);
            if (bound && DECIMAL_KINDS.includes(bound.kind)) {
              const problem = decimalProblem(value, bound);
              if (problem) rowErrors.set(key, problem);
              else value = canonicalDecimal(value) ?? value;
            }
          }
          if (
            input.type === 'quantity' &&
            value &&
            !POSITIVE_DECIMAL.test(value)
          )
            rowErrors.set(key, 'Enter a positive exact quantity.');
          if (input.required && !value && !rowErrors.has(key))
            rowErrors.set(key, 'Required.');
          canonical[input.inputId] = value;
        }
        includedRows.push(rowId);
        preparedRows[rowId] = canonical;
      }
      current.rowInputs = entered;
      if (!includedRows.length) rowsError = 'Enter at least one line.';
      else if (includedRows.length > MAXIMUM_TASK_ROWS)
        rowsError = `Enter at most ${String(MAXIMUM_TASK_ROWS)} lines at a time.`;
    }
    const inputs = Object.freeze(collected);
    const referenceLabels: Record<string, string> = { ...inputs };
    if (fieldErrors.size || rowErrors.size || rowsError)
      error = 'Complete the required inputs.';
    try {
      for (const input of current.action.inputs.filter(
        (input) => input.type === 'reference',
      )) {
        const choices = await referenceChoices(
          view,
          gateways,
          current.data.scope,
          input,
          current.data.record.recordId,
        );
        const choice = choices.find(
          (choice) => choice.recordId === inputs[input.inputId],
        );
        if (!choice) error = 'Choose an available reference.';
        else
          referenceLabels[input.inputId] = text(
            recordValue(choice, input.labelField!.targetId),
          );
      }
    } catch {
      error = 'Choose an available reference.';
    }
    // An older asynchronous validation cannot overwrite a later preparation or
    // a plan that has already crossed its synchronous confirmation boundary.
    if (generation !== current.preparation || current.confirmed)
      return taskDocument(() =>
        compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
      );
    current.inputs = inputs;
    if (!error) {
      const task = current.action.presentation?.task;
      const previewValue = (
        value: TaskPresentation['confirmation']['quantity'],
      ) =>
        value.source === 'input'
          ? (referenceLabels[value.inputId] ?? '')
          : taskColumnText(current.data, value);
      // Display copy is captured with the reviewed plan, never reconstructed from
      // mutable edits or fresh background DTOs. Current governed reads still gate disclosure.
      const presentation = task
        ? Object.freeze({
            identity: taskColumnText(current.data, task.summary.identity),
            secondary: task.summary.secondary
              ? taskColumnText(current.data, task.summary.secondary)
              : null,
            quantity: previewValue(task.confirmation.quantity),
            unit: taskColumnText(current.data, task.confirmation.unit),
            context: task.confirmation.context
              ? previewValue(task.confirmation.context)
              : null,
          })
        : null;
      const prepared = Object.freeze({
        id: randomUUID(),
        inputs,
        presentation,
        rows: Object.freeze(includedRows),
        rowInputs: Object.freeze(
          Object.fromEntries(
            Object.entries(preparedRows).map(([rowId, values]) => [
              rowId,
              Object.freeze(values),
            ]),
          ),
        ),
      });
      current.prepared = prepared;
      return taskDocument(
        () =>
          `${previewInputs()}<p class="composition-task-consequence">${h(current.action.description)}</p><form class="composition-task-footer" method="post" action="${h(url)}">${hidden}<input type="hidden" name="preparedId" value="${h(prepared.id)}"><button class="secondary-action" name="taskStage" value="edit">Edit inputs</button><button name="taskStage" value="confirm">${h(current.action.presentation?.task?.confirmation.confirmLabel ?? `Confirm ${current.action.label}`)}</button></form>${back}`,
        inputs,
        prepared,
      );
    }
  }
  if (
    submission.taskStage === 'confirm' &&
    (!current.prepared || submission.preparedId !== current.prepared.id)
  )
    return taskDocument(() =>
      compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
    );
  if (
    submission.taskStage === 'confirm' ||
    (submission.taskStage === 'retry' && current.confirmed)
  ) {
    current.inputs = current.prepared!.inputs;
    if (!current.plan) {
      // Fixed once, at the first confirmation: each per-row step runs once for
      // every included row, in order, and every run keeps its own request key,
      // so a retry replays exactly the runs that were reviewed.
      const prepared = current.prepared!;
      current.rowInputs = Object.fromEntries(
        prepared.rows.map((rowId) => [rowId, { ...prepared.rowInputs[rowId] }]),
      );
      const runs: TaskRun[] = current.action.steps.flatMap(
        (step, index): TaskRun[] =>
          step.each
            ? prepared.rows.map((row) => ({ step: index, row }))
            : [{ step: index, row: null }],
      );
      current.plan = Object.freeze(runs);
      current.keys = runs.map(() => randomUUID());
    }
    current.confirmed = true;
    current.busy = true;
    try {
      const catalog = parsePinnedOperationCatalog(
        view.projections.operation.payload,
      );
      const plan = current.plan!;
      for (; current.next < plan.length; current.next++) {
        const run = plan[current.next]!;
        const step = current.action.steps[run.step]!;
        const operation = catalog.find(
          (candidate) => candidate.operationId === step.operation.targetId,
        );
        if (!operation)
          throw new Error('The declared operation is unavailable.');
        let input = current.stepInputs[current.next];
        if (!input) {
          // A per-row run reads its row as the selection and its row's values.
          const row = run.row === null ? undefined : frozenRow(run.row);
          if (run.row !== null && (!row || !taskRowsDeclared))
            throw new Error('A task row is unavailable.');
          const context = row
            ? withRow(current.data, taskRowsDeclared!.datasetId, row.record)
            : current.data;
          const values =
            run.row === null
              ? current.inputs
              : { ...current.inputs, ...current.rowInputs[run.row] };
          const object: Record<string, ImmutableJsonValue> = {};
          for (const binding of step.bindings) {
            let target = object;
            for (const part of binding.path.slice(0, -1)) {
              if (['__proto__', 'constructor', 'prototype'].includes(part))
                throw new Error('Invalid input path');
              target[part] ??= {};
              target = target[part] as Record<string, ImmutableJsonValue>;
            }
            const key = binding.path.at(-1)!;
            if (['__proto__', 'constructor', 'prototype'].includes(key))
              throw new Error('Invalid input path');
            const value = resolveValue(
              binding.value,
              context,
              values,
              current.results,
              current.generated,
              `${step.stepId}${run.row === null ? '' : `@${run.row}`}:${binding.path.join('.')}`,
            );
            // An integer field's value is its canonical decimal string; a
            // bound record revision arrives as a number and is written as one.
            const boundKind =
              binding.path.length === 2 &&
              (binding.path[0] === 'values' || binding.path[0] === 'patch')
                ? operation.inputContract?.fields.find(
                    (field) => field.fieldId === key,
                  )?.fieldKind
                : undefined;
            // A decimal field takes its canonical form, as a typed one does:
            // a stored decimal read back from a record -- a receipt line's
            // cost -- arrives at its column's scale ("2.500000000000000000"),
            // which the provider refuses as input.
            target[key] =
              boundKind === 'integerFieldType' &&
              typeof value === 'number' &&
              Number.isSafeInteger(value)
                ? String(value)
                : boundKind &&
                    DECIMAL_KINDS.includes(boundKind) &&
                    typeof value === 'string'
                  ? (canonicalDecimal(value) ?? value)
                  : value;
          }
          input = object;
          current.stepInputs[current.next] = input;
        }
        const grant =
          operation.confirmation === 'humanRequired'
            ? gateways.operationMediation.issueConfirmationGrant(
                view,
                operation.operationId,
                input,
              )
            : null;
        const result = await gateways.operationGateway.invoke(
          view,
          {
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
            operationId: operation.operationId,
            input,
            confirmationGrant: grant,
            idempotencyKey: current.keys[current.next]!,
          },
          gateways.operationMediation.issueInvocation(view, 'UI'),
        );
        if (result.outcome !== 'succeeded')
          throw new Error('The operation was refused.');
        current.receipt = JSON.stringify(result.trust);
        if (!result.readBack) {
          current.committedWithheld = true;
          return taskDocument(
            () =>
              `${compositionMessage('COMPOSITION_COMMITTED_WITHHELD', 'status')}<pre>${h(JSON.stringify(result.trust))}</pre>${back}`,
          );
        }
        // A per-row run's read-back is its row's alone; no later step reads it.
        if (run.row === null) current.results[step.stepId] = result.readBack;
      }
      return taskDocument(
        () =>
          // Every step committed and was read back: the business result is
          // what was reviewed and confirmed. The generic status and receipt stay
          // below it, and a withheld or uncertain outcome never reaches here.
          `<section class="composition-task-result" data-task-result role="status" aria-label="Result"><h3>${h(current.action.label)}: done</h3>${previewInputs()}</section><p>Closing this task does not undo submitted work.</p><details class="composition-task-support"><summary>Status and recovery receipt</summary>${compositionMessage('COMPOSITION_COMPLETE')}${current.receipt ? `<pre>${h(current.receipt)}</pre>` : ''}</details>${back}`,
      );
    } catch (failure) {
      const ref = operationMessageRef(failure);
      error =
        'The operation could not be verified. Earlier steps may have committed. Retry uses the same inputs and request keys; inspect the order if needed.';
      return taskDocument(
        () =>
          `<div role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Operation', 'h2')}</div>${compositionMessage('COMPOSITION_UNCERTAIN', 'alert')}${previewInputs()}<form class="composition-task-footer" method="post" action="${h(url)}">${hidden}<button name="taskStage" value="retry">Retry same request</button></form>${back}`,
      );
    } finally {
      current.busy = false;
    }
  }
  if (current.confirmed)
    return taskDocument(
      () =>
        `${compositionMessage('COMPOSITION_UNCERTAIN', 'alert')}${previewInputs()}<form class="composition-task-footer" method="post" action="${h(url)}">${hidden}<button name="taskStage" value="retry">Retry same request</button></form>${back}`,
    );
  return taskDocument(() => {
    // Focus opens on the first input with a problem (autofocus without the
    // script), so the operator lands where the correction is needed.
    let focusTaken = false;
    const focus = (problem: string | undefined) => {
      const takes = !!problem && !focusTaken;
      if (takes) focusTaken = true;
      return takes;
    };
    const controls = ordered(headerInputs).map((input) => {
      const presentation = input.presentation;
      const problem = fieldErrors.get(input.inputId);
      const takesFocus = presentation?.kind !== 'derived' && focus(problem);
      const invalid = problem
        ? ` aria-invalid="true" aria-describedby="${h(input.inputId)}-error"${takesFocus ? ' data-task-initial-focus autofocus' : ''}`
        : '';
      const required = input.required ? ' required' : '';
      const value = current.inputs[input.inputId] ?? '';
      let control: string;
      if (input.type === 'reference' && input.query && input.labelField) {
        const choices = displayChoices[input.inputId] ?? [];
        // A declared record default preselects only until a value is submitted.
        const chosen =
          current.inputs[input.inputId] ??
          referenceDefault(input, renderData, choices);
        control = `<select name="${h(input.inputId)}"${required}${invalid}><option value="">Select…</option>${choices.map((record) => `<option value="${h(record.recordId)}" ${chosen === record.recordId ? 'selected' : ''}>${h(text(recordValue(record, input.labelField!.targetId)))}</option>`).join('')}</select>`;
      } else if (presentation?.kind === 'derived')
        // Read-only: taken from the selected row, never from the submission.
        control = `<output class="derived-value" data-derived-input>${h(renderData ? taskColumnText(renderData, presentation.column) : '—')}</output>`;
      else if (presentation?.kind === 'choice')
        control = renderChoice(
          presentation,
          ` name="${h(input.inputId)}"${required}${invalid}`,
          value || choiceDefault(input, renderData),
          { required: input.required, keepCurrent: false, label: input.label },
        );
      else if (presentation?.kind === 'multiline')
        control = `<textarea name="${h(input.inputId)}" rows="3"${required}${invalid}>${h(value)}</textarea>`;
      else {
        const bound =
          input.type === 'text'
            ? boundInputField(view, current.action, input.inputId)
            : null;
        const numeric =
          input.type === 'quantity' ||
          (bound !== null && DECIMAL_KINDS.includes(bound.kind));
        control = `<input name="${h(input.inputId)}" value="${h(displayInputs[input.inputId] ?? '')}"${required}${numeric ? ' inputmode="decimal" autocomplete="off"' : ''}${invalid}>`;
      }
      // The problem describes the input (aria-describedby); it is not part of
      // its accessible name, so it sits after the label.
      return `<div class="composition-input"><label class="field">${h(input.label)}${control}</label>${problem ? `<small class="field-error" id="${h(input.inputId)}-error">${h(problem)}</small>` : ''}</div>`;
    });
    // A multi-row Task's rows: one line each, its figures for context and an
    // input for each value asked per row, named with the line it belongs to.
    // Rows start empty; the fill control fills them on the server, so it works
    // without script, and a hidden default keeps Enter reviewing the Task.
    let rows = '';
    if (taskRowsDeclared && rowsDataset) {
      const fresh = renderData?.children.find(
        (child) => child.definition.datasetId === taskRowsDeclared.datasetId,
      );
      const { primary, secondary, quantities } = rowColumns();
      const errorId = 'composition-task-rows-error';
      rows = `<fieldset class="composition-task-rows" data-task-rows="${h(taskRowsDeclared.datasetId)}"${rowsError ? ` aria-describedby="${errorId}"` : ''}><legend>${h(rowsDataset.definition.label)}</legend>${taskRowsDeclared.fillLabel ? `<button type="submit" class="secondary-action" name="taskStage" value="fill" formnovalidate>${h(taskRowsDeclared.fillLabel)}</button>` : ''}${rowsError ? `<small class="field-error" id="${errorId}">${h(rowsError)}</small>` : ''}<div class="data-table-wrap"><table><thead><tr><th scope="col">${h(primary?.label ?? '')}</th>${quantities.map((column) => `<th scope="col" class="composition-quantity">${h(column.label)}</th>`).join('')}${perRowInputs.map((input) => `<th scope="col">${h(input.label)}</th>`).join('')}</tr></thead><tbody>${current.rowIds
        .map((rowId) => {
          const cells =
            (
              fresh?.rows.find((row) => row.record.recordId === rowId) ??
              frozenRow(rowId)
            )?.cells ?? {};
          const name = primary ? (cells[primary.columnId] ?? '—') : '—';
          const context = secondary[0]
            ? `, ${secondary[0].label} ${cells[secondary[0].columnId] ?? '—'}`
            : '';
          return `<tr data-compact-card="true" data-task-row="${h(rowId)}"><td data-cell-role="primary" data-column-label="${h(primary?.label ?? '')}"><strong>${h(name)}</strong>${secondary.length ? `<div class="composition-cell-secondary">${secondary.map((column) => `<span><span class="composition-cell-label">${h(column.label)}</span> ${h(cells[column.columnId] ?? '—')}</span>`).join('')}</div>` : ''}</td>${quantities.map((column) => `<td data-cell-role="quantity" data-column-label="${h(column.label)}">${h(cells[column.columnId] ?? '—')}</td>`).join('')}${perRowInputs
            .map((input) => {
              const key = rowField(input.inputId, rowId);
              const problem = rowErrors.get(key);
              const described = `${key}-error`;
              const message = problem
                ? `<small class="field-error" id="${h(described)}">${h(problem)}</small>`
                : '';
              if (input.presentation?.kind === 'derived')
                return `<td data-column-label="${h(input.label)}"><output class="derived-value" data-derived-input>${h(cells[input.presentation.column.columnId] ?? '—')}</output>${message}</td>`;
              const bound =
                input.type === 'text'
                  ? boundInputField(view, current.action, input.inputId)
                  : null;
              const numeric =
                input.type === 'quantity' ||
                (bound !== null && DECIMAL_KINDS.includes(bound.kind));
              return `<td data-column-label="${h(input.label)}"><input name="${h(key)}" value="${h(current.rowInputs[rowId]?.[input.inputId] ?? '')}" aria-label="${h(`${input.label}, ${name}${context}`)}"${numeric ? ' inputmode="decimal" autocomplete="off"' : ''}${problem ? ` aria-invalid="true" aria-describedby="${h(described)}"${focus(problem) ? ' data-task-initial-focus autofocus' : ''}` : ''}>${message}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('')}</tbody></table></div></fieldset>`;
    }
    const reviewLabel =
      current.action.presentation?.task?.confirmation.reviewLabel ??
      `Review ${current.action.label}`;
    return `${error ? compositionMessage('COMPOSITION_INPUT_INVALID', 'alert') : ''}<form class="composition-inputs" method="post" action="${h(url)}">${hidden}${taskRowsDeclared?.fillLabel ? '<button type="submit" class="sr-only" name="taskStage" value="prepare" tabindex="-1" aria-hidden="true" data-task-default></button>' : ''}${controls.join('')}${rows}<p class="composition-task-consequence">${h(current.action.description)}</p><footer class="composition-task-footer"><button name="taskStage" value="prepare">${h(reviewLabel)}</button></footer></form>${back}`;
  });
}

async function referenceChoices(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  scope: string | null,
  input: Action['inputs'][number],
  /** The page's own record, which an `excludeRecord` input never offers. */
  recordId: string,
): Promise<SemanticRecordDto[]> {
  if (!input.query || !input.labelField)
    throw new Error('Reference input is undeclared');
  const definition = registeredSemanticQueryFromPinnedView(
    view,
    input.query.targetId,
  );
  if (!definition || definition.queryType !== 'list')
    throw new Error('Reference input requires a list');
  const records: SemanticRecordDto[] = [];
  let cursor: string | null = null;
  // Declared eligibility narrows the list before paging, as a draft editor
  // picker's does; an executor that did not apply it cannot echo it.
  const relatedFilter = input.eligibility
    ? {
        queryId: input.eligibility.queryId,
        relationId: input.eligibility.relationId,
        fieldFilters: input.eligibility.filters.map((filter) => ({
          fieldId: filter.fieldId,
          value: filter.value,
        })),
      }
    : undefined;
  do {
    const page: ReturnType<typeof requireSharedListResult<SemanticRecordDto>> =
      requireSharedListResult(
        await query(view, gateways, input.query.targetId, scope, {
          includeArchived: false,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: definition.maximumResultCount,
            search: '',
            sort: [],
            relationLabels: [],
            ...(relatedFilter ? { relatedFilter } : {}),
          },
        }),
      );
    const applied = page.listCoverage.relatedFilter;
    if (
      relatedFilter &&
      (applied?.queryId !== relatedFilter.queryId ||
        applied.relationId !== relatedFilter.relationId ||
        applied.fieldFilters?.length !== relatedFilter.fieldFilters.length ||
        relatedFilter.fieldFilters.some(
          (filter, index) =>
            applied.fieldFilters?.[index]?.fieldId !== filter.fieldId ||
            applied.fieldFilters[index]?.value !== filter.value,
        ))
    )
      throw new Error('Reference eligibility was not applied');
    records.push(...page.records);
    if (
      page.listCoverage.hasMore &&
      (!page.records.length ||
        cursor === page.listCoverage.nextCursor ||
        records.length > 1000)
    )
      throw new Error('Reference choices are incomplete');
    cursor = page.listCoverage.nextCursor;
  } while (cursor !== null);
  // A duplicate is never merged into itself (CATALOG-EXTRAS): the record is
  // not offered, so a submitted choice of it is refused as unavailable.
  return input.excludeRecord
    ? records.filter((record) => record.recordId !== recordId)
    : records;
}

interface CompositionGateways {
  readonly queryGateway: SemanticQueryGateway;
  readonly operationGateway: SemanticOperationGateway;
  readonly operationMediation: SemanticOperationMediationAuthority;
}
interface CompositionResponse {
  readonly html: string;
  readonly statusCode: number;
}
