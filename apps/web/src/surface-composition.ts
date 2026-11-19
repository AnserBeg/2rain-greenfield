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
import { validationRefusalForOperation } from './validation-refusal.js';
import { messageAttributes, messageBody } from './message-render.js';
import type { SurfaceMessageCode } from './message-catalog.js';
const compositionMessage = (
  code: Extract<SurfaceMessageCode, `COMPOSITION_${string}`>,
  role: 'alert' | 'status' | null = null,
) =>
  `<div ${role ? `role="${role}"` : ''} ${messageAttributes({ code })}>${messageBody({ code }, '', 'h2')}</div>`;
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

/** A review can be omitted only when every declared step is an ordinary,
 * active operation that needs no human confirmation. */
function taskCanApplyDirectly(
  view: RequestRuntimeView,
  action: Action,
): boolean {
  if (action.presentation?.task || action.steps.length === 0) return false;
  const catalog = parsePinnedOperationCatalog(
    view.projections.operation.payload,
  );
  return action.steps.every((step) => {
    const operation = catalog.find(
      (candidate) => candidate.operationId === step.operation.targetId,
    );
    return (
      operation?.lifecycle === 'active' &&
      operation.tier === 'o0' &&
      operation.confirmation === 'none'
    );
  });
}

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
  /** Current-request advisory offers, never authority for a later invocation. */
  offeredActionIds: ReadonlySet<string>;
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
function presentedField(
  view: RequestRuntimeView,
  fieldId: string,
): CompiledSurfaceField | undefined {
  let fields = presentedFields.get(view);
  if (!fields) {
    fields = new Map(
      readCompiledSurfaceManifest(view).surfaces.flatMap((surface) =>
        (surface.fields ?? []).map((field) => [field.fieldId, field] as const),
      ),
    );
    presentedFields.set(view, fields);
  }
  return fields.get(fieldId);
}

/**
 * A referenced record's label: an enumeration by its option's label -- a
 * location's status reads "Quarantine", not its option id (LOCATIONS) --
 * and any other field as the text it holds, as before.
 */
export function referenceLabel(
  view: RequestRuntimeView,
  fieldId: string,
  value: ImmutableJsonValue,
): string {
  const field = presentedField(view, fieldId);
  return field?.kind === 'enumFieldType'
    ? (field.options.find((option) => option.optionId === value)?.label ??
        text(value))
    : text(value);
}

/** Presents a stored value by its compiled field kind; shared with declared Lists. */
export function displayFieldValue(
  view: RequestRuntimeView,
  record: SemanticRecordDto,
  fieldId: string,
  value: ImmutableJsonValue,
): string {
  const field = presentedField(view, fieldId);
  if (field?.kind === 'enumFieldType')
    return (
      field.options.find((option) => option.optionId === value)?.label ??
      text(value)
    );
  // A flag reads as a word, such as a counter sale's.
  if (field?.kind === 'booleanFieldType' && typeof value === 'boolean')
    return value ? 'Yes' : 'No';
  const result = record.displayValues?.[fieldId] ?? text(value);
  if (
    field &&
    ['exactDecimalFieldType', 'quantityFieldType'].includes(field.kind) &&
    /^-?\d+\.\d+$/.test(result)
  )
    return result.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  // A date reads as its date, whether stored as the day or as that day's
  // midnight instant (a tenant's date field, LOOK-1 round 2).
  if (
    field?.kind === 'dateFieldType' &&
    /^\d{4}-\d{2}-\d{2}(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:00)?)?$/.test(
      result,
    )
  )
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(`${result.slice(0, 10)}T00:00:00Z`));
  // A date-only value -- an instant at midnight UTC, as an order's, expected
  // or requested date is -- reads as its plain date, from its UTC date
  // components so nothing shifts (LOOP-1, orchestrator ruling); a real time
  // of day keeps its time and "UTC".
  if (
    field?.kind === 'dateTimeFieldType' &&
    Number.isFinite(Date.parse(result)) &&
    new Date(result).getTime() % 86_400_000 === 0
  )
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(result));
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
    cells[column.columnId] = referenceLabel(
      view,
      column.reference.labelField.targetId,
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
    offeredActionIds: new Set(),
  };
  const offeredActionIds = new Set<string>();
  await Promise.all(
    composition.actions
      .filter((action) => !action.navigate)
      .map(async (action) => {
        try {
          if (
            (await gateways.operationGateway.previewTaskEligibility(
              view,
              action.steps.map((step) => step.operation.targetId),
              scope,
            )) === 'eligible'
          )
            offeredActionIds.add(action.actionId);
        } catch {
          // An unavailable policy decision withholds the offer, not the record.
        }
      }),
  );
  data.offeredActionIds = offeredActionIds;
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
/** A multi-row Task's rows filled from their declared fill column. */
function prefilledRows(
  action: Action,
  data: CompositionData,
): Record<string, Record<string, string>> {
  const filled: Record<string, Record<string, string>> = {};
  const declared = action.rows;
  const child = declared
    ? data.children.find(
        (value) => value.definition.datasetId === declared.datasetId,
      )
    : undefined;
  if (!declared?.fillLabel || !child) return filled;
  for (const row of taskRows(action, data))
    for (const input of action.inputs) {
      const fill = input.perRow?.fillFrom;
      const column = fill
        ? child.definition.columns.find(
            (value) => value.columnId === fill.columnId,
          )
        : undefined;
      if (!column) continue;
      let value: ImmutableJsonValue = null;
      try {
        value = recordValue(row.record, column.field);
      } catch {
        /* An unstated figure fills nothing. */
      }
      if (typeof value === 'string' && POSITIVE_DECIMAL.test(value))
        (filled[row.record.recordId] ??= {})[input.inputId] = value;
    }
  return filled;
}

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
  if (!action.navigate && !data.offeredActionIds.has(action.actionId))
    return false;
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
  /** The status kind the record's own List declares for its state, if any. */
  statusRole: string | null = null,
): string {
  const header = surface.composition?.presentation?.header;
  if (!header) return '';
  if (data.fieldsFailed)
    return compositionMessage('COMPOSITION_CHILD_FAILED', 'alert');
  const cell = (id: string) => h(data.fields.cells[id] ?? '—');
  const step = badgeStep(surface, data);
  // The Ledger page header (LOOK-1): eyebrow, the record's number with its
  // status badge, then the subtitle. A state with no declared kind is the
  // neutral outlined badge.
  // The facts stay in the header's markup and are laid out after the
  // stepper (the header is `display:contents`; see ledger-styles.ts).
  // The eyebrow names the record's type: "Purchase order", not its page.
  return `<header class="composition-header"><div class="composition-title"><p class="eyebrow">${h(surface.label.replace(/ detail$/iu, ''))}</p><div class="composition-heading"><h1>${cell(header.title)}</h1>${header.status ? `<span class="composition-business-status"${statusRole ? ` data-status-role="${h(statusRole)}"` : ''}>${step ? h(step) : cell(header.status)}</span>` : ''}</div><p class="composition-subtitle">${header.subtitle.map(cell).join(' · ')}</p></div>${renderCompositionFacts(surface, data)}</header>`;
}

/**
 * The record's facts grid (LOOK-1): the header's declared facts, label over
 * value, in definition order; an empty value reads "—".
 */
function renderCompositionFacts(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string {
  const header = surface.composition?.presentation?.header;
  if (!header?.facts.length || data.fieldsFailed) return '';
  const label = (id: string) =>
    h(
      surface.composition!.fields.find((column) => column.columnId === id)!
        .label,
    );
  return `<section class="panel composition-facts" aria-label="Key facts"><dl class="composition-header-facts">${header.facts.map((id) => `<div><dt>${label(id)}</dt><dd>${h(data.fields.cells[id] ?? '—')}</dd></div>`).join('')}</dl></section>`;
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
/**
 * The progression's states with one current step (LOOK-1 round 2): a later
 * step whose conditions also hold reads as upcoming until the earlier one
 * is complete.
 */
function oneCurrentStep(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): ReturnType<typeof compositionProgressionStates> {
  const reached = compositionProgressionStates(surface, data);
  const firstCurrent = reached.findIndex(
    (state) => state === 'current' || state === 'attention',
  );
  return reached.map((state, index) =>
    state === 'current' && firstCurrent >= 0 && index > firstCurrent
      ? ('upcoming' as const)
      : state,
  );
}

/**
 * The step the record's badge names (LOOK-1 round 3): the stepper's current
 * step, or its last once every step is complete -- so the badge and the
 * stepper never disagree. Null without a declared progression, or when no
 * step applies (the badge then reads the record's state).
 */
function badgeStep(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string | null {
  const progression = surface.composition?.presentation?.progression;
  if (!progression || data.fieldsFailed) return null;
  const states = oneCurrentStep(surface, data);
  const current = states.findIndex(
    (state) => state === 'current' || state === 'attention',
  );
  if (current >= 0) return progression.steps[current]!.label;
  return states.every((state) => state === 'complete')
    ? (progression.steps.at(-1)?.label ?? null)
    : null;
}

export function renderCompositionProgression(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
  view: RequestRuntimeView,
  operationControl: (operationId: string, name: string) => string | null,
  offerNext = true,
): string {
  const progression = surface.composition?.presentation?.progression;
  if (!progression || data.fieldsFailed) return '';
  const states = oneCurrentStep(surface, data);
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
        nextActions.set(data, action.actionId);
        next = `<div class="composition-progression-next" data-next-action="${h(action.actionId)}"><div><p class="eyebrow">Next step</p><strong>${h(nextSentence(surface, action, data))}</strong></div>${actionLink(action, data, view, `Next action: ${action.label}`, nextButtonText(surface, action, data))}</div>`;
        break;
      }
    } else {
      const control = operationControl(entry.operation.targetId, 'Next action');
      if (control) {
        next = `<div class="composition-progression-next" data-next-operation="${h(entry.operation.targetId)}"><div><p class="eyebrow">Next step</p><strong>${h(recordSentence(surface, data))}</strong></div>${control}</div>`;
        break;
      }
    }
  }
  // At phone width the stepper's labels give way to this one line.
  const currentIndex = states.findIndex(
    (state) => state === 'current' || state === 'attention',
  );
  const stepLine =
    currentIndex >= 0
      ? `Step ${String(currentIndex + 1)} of ${String(states.length)} · ${progression.steps[currentIndex]!.label}`
      : null;
  return `<section class="panel composition-progression" aria-labelledby="composition-progression-heading" data-composition-progression><header class="composition-progression-heading"><p class="eyebrow">Record progression</p><h2 id="composition-progression-heading">${h(progression.title)}</h2></header><ol class="composition-progression-steps">${steps}</ol>${stepLine ? `<p class="composition-progression-phone" aria-hidden="true">${h(stepLine)}</p>` : ''}${next}</section>`;
}

/**
 * The next step's sentence (LOOK-1, spec §6), from the record's own figures
 * only. A Task over rows that fills each row from a declared column states
 * what is still open: "{open} of {total} {item} still open." for one line,
 * "{units} units still open on {lines} lines." for several -- the total read
 * from the dataset's declared line progress. Any other next step states the
 * record and where it stands.
 */
function nextSentence(
  surface: CompiledSurfaceDefinition,
  action: Action,
  data: CompositionData,
): string {
  const fill = action.inputs.find((input) => input.perRow?.fillFrom)?.perRow
    ?.fillFrom;
  const child = data.children.find(
    (value) => value.definition.datasetId === action.rows?.datasetId,
  );
  const column = child?.definition.columns.find(
    (value) => value.columnId === fill?.columnId,
  );
  if (!fill || !child || child.status !== 'ready' || !column)
    return recordSentence(surface, data);
  const open = taskRows(action, data)
    .map((row) => ({ row, value: decimalOf(row.record, column.field) }))
    .filter(
      (entry): entry is { row: Row; value: string } =>
        entry.value !== null && POSITIVE_DECIMAL.test(entry.value),
    );
  if (!open.length) return recordSentence(surface, data);
  if (open.length === 1) {
    const { row, value } = open[0]!;
    const progress = child.definition.presentation?.progress;
    const total = child.definition.columns.find(
      (candidate) => candidate.columnId === progress?.total,
    );
    // Figures read as the row's own cells show them.
    const shown = row.cells[column.columnId] ?? plainDecimal(value);
    const of = total ? row.cells[total.columnId] : undefined;
    return `${shown}${of ? ` of ${of}` : ''} ${rowName(child.definition, row)} still open.`;
  }
  return `${plainDecimal(sumDecimals(open.map((entry) => entry.value)))} units still open on ${String(open.length)} lines.`;
}

/**
 * The next step's button (LOOK-1 round 2): its label and the figure it acts
 * on, all declared -- what its rows still have open ("Receive 10"), what its
 * rows' positive condition sums ("Record payment 26.25"), or the record value
 * its offer is conditioned on ("Invoice 26.25"). No figure, the label alone.
 */
function nextButtonText(
  surface: CompiledSurfaceDefinition,
  action: Action,
  data: CompositionData,
): string {
  const figure = nextFigure(surface, action, data);
  return figure ? `${action.label} ${figure}` : action.label;
}

function nextFigure(
  surface: CompiledSurfaceDefinition,
  action: Action,
  data: CompositionData,
): string | null {
  const child = data.children.find(
    (value) => value.definition.datasetId === action.rows?.datasetId,
  );
  if (action.rows && child?.status === 'ready') {
    const fill = action.inputs.find((input) => input.perRow?.fillFrom)?.perRow
      ?.fillFrom;
    const counted =
      child.definition.columns.find(
        (column) => column.columnId === fill?.columnId,
      ) ??
      // Else the field the rows' own positive condition reads, such as an
      // invoice's balance still to be paid.
      child.definition.columns.find((column) =>
        action.rows!.conditions?.some(
          (condition) =>
            condition.operator === 'positive' &&
            condition.value.source === 'selected' &&
            condition.value.field === column.field,
        ),
      );
    if (!counted) return null;
    const values = taskRows(action, data)
      .map((row) => decimalOf(row.record, counted.field))
      .filter(
        (value): value is string =>
          value !== null && POSITIVE_DECIMAL.test(value),
      );
    if (!values.length) return null;
    const sum = sumDecimals(values);
    return counted.format === 'money' ? moneyText(sum) : plainDecimal(sum);
  }
  const condition = action.conditions.find(
    (value) => value.operator === 'positive' && value.value.source === 'record',
  );
  if (!condition || condition.value.source !== 'record') return null;
  const field = condition.value.field;
  const column = surface.composition!.fields.find(
    (value) => value.field === field,
  );
  const cell = column ? data.fields.cells[column.columnId] : undefined;
  if (cell && cell !== '—') return cell;
  const raw = decimalOf(data.record, field);
  return raw && POSITIVE_DECIMAL.test(raw) ? plainDecimal(raw) : null;
}

/** "{title} is {status}." -- the record and where it stands. */
function recordSentence(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string {
  const header = surface.composition?.presentation?.header;
  const title = header ? data.fields.cells[header.title] : undefined;
  const status = header?.status ? data.fields.cells[header.status] : undefined;
  return title && status && status !== '—'
    ? `${title} is ${status}.`
    : (title ?? surface.label);
}

/** A row's stored decimal at a field, or null when it states none. */
function decimalOf(record: SemanticRecordDto, field: string): string | null {
  try {
    const value = recordValue(record, field);
    return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A decimal without trailing fractional zeros: 10.000 reads 10. */
function plainDecimal(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}

/** Compares two non-negative decimal strings exactly. */
function compareDecimals(left: string, right: string): number {
  const scale = Math.max(
    left.split('.')[1]?.length ?? 0,
    right.split('.')[1]?.length ?? 0,
  );
  const units = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  };
  const delta = units(left) - units(right);
  return delta > 0n ? 1 : delta < 0n ? -1 : 0;
}

/** The exact sum of decimal strings, never through a float. */
function sumDecimals(values: readonly string[]): string {
  const scale = Math.max(
    0,
    ...values.map((value) => value.split('.')[1]?.length ?? 0),
  );
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ''] = value.split('.');
    return sum + BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }, 0n);
  const negative = total < 0n;
  const text = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const integer = scale ? text.slice(0, -scale) : text;
  const decimals = scale ? text.slice(-scale).replace(/0+$/u, '') : '';
  return `${negative ? '-' : ''}${decimals ? `${integer}.${decimals}` : integer}`;
}

/** The action each rendered record offers as its next step, if any. */
const nextActions = new WeakMap<CompositionData, string>();

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
  /** The visible text, when it says more than the label (the next step's figure). */
  text?: string,
): string {
  const named = name ? ` aria-label="${h(name)}"` : '';
  const shown = h(text ?? action.label);
  if (action.navigate)
    return `<a class="button" href="${h(navigateHref(action, data, view))}"${named}>${shown}</a>`;
  return `<form method="post" action="${h(data.url)}"><input type="hidden" name="compositionAction" value="${h(action.actionId)}"><button type="submit"${named}>${shown}</button></form>`;
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
  // Per-line progress (LOOK-1): a bar and "{done} of {total}" beside the
  // row's name, from the two quantity columns the dataset declares.
  const progress = definition.presentation?.progress;
  const progressTotal = definition.columns.find(
    (column) => column.columnId === progress?.total,
  );
  const progressDone = definition.columns.find(
    (column) => column.columnId === progress?.done,
  );
  const progressHeading =
    progressTotal && progressDone
      ? `<th scope="col" class="composition-progress-heading">Progress</th>`
      : '';
  const progressCell = (row: Row) => {
    if (!progressTotal || !progressDone) return '';
    const total = decimalOf(row.record, progressTotal.field);
    const done = decimalOf(row.record, progressDone.field);
    if (total === null || done === null)
      return `<td data-cell-role="progress" data-column-label="Progress">—</td>`;
    const state =
      !POSITIVE_DECIMAL.test(done) || !POSITIVE_DECIMAL.test(total)
        ? 'none'
        : compareDecimals(done, total) >= 0
          ? 'complete'
          : 'partial';
    return `<td data-cell-role="progress" data-column-label="Progress"><span class="line-progress" data-progress="${state}">${POSITIVE_DECIMAL.test(total) ? `<progress value="${h(done)}" max="${h(total)}">${h(done)} of ${h(total)}</progress>` : ''}<span><b>${h(row.cells[progressDone.columnId] ?? done)}</b> of ${h(row.cells[progressTotal.columnId] ?? total)}</span></span></td>`;
  };
  const cells = (row: Row, values: Column[]) =>
    values
      .map(
        (column) =>
          `<span><span class="composition-cell-label">${h(column.label)}</span> ${h(row.cells[column.columnId] ?? '—')}</span>`,
      )
      .join('');
  const hasActions =
    definition.presentation?.selection !== 'none' || rowActions.length > 0;
  // On a sheet with totals, keep the amounts at the end of the row. Its
  // actions follow the product instead, preserving their links and forms.
  const print = surface.composition?.presentation?.print;
  const actionsAfter =
    print?.totals?.length &&
    print.datasets[0] === definition.datasetId &&
    primary
      ? primary
      : displayed.at(-1);
  const body =
    child.status === 'failed'
      ? childFailure(child.error)
      : child.status === 'empty'
        ? compositionMessage('COMPOSITION_CHILD_EMPTY')
        : `<div class="data-table-wrap"${definition.presentation?.compact ? ` data-compact="${h(definition.presentation.compact)}" tabindex="0" role="region" aria-label="${h(definition.label)} table; scroll for all columns"` : ''}><table><thead><tr>${displayed.map((column) => `<th scope="col" class="${column.presentation?.role === 'quantity' ? 'composition-quantity' : ''}">${h(column.label)}</th>${column === actionsAfter && hasActions ? '<th scope="col">Actions</th>' : ''}${column === primary ? progressHeading : ''}`).join('')}</tr></thead><tbody>${child.rows
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
              const actionCell = hasActions
                ? `<td data-cell-role="actions" data-column-label="Actions">${selectedActions.map((action) => actionLink(action, rowData, view)).join('')}${definition.presentation?.selection !== 'none' ? `<a href="${h(url.pathname + url.search + url.hash)}" ${active ? 'aria-current="true"' : ''}>${active ? 'Selected' : 'Select'}</a>` : ''}${rowActions
                    .filter((action) => applicable(action, rowData))
                    .map((action) => actionLink(action, rowData, view))
                    .join('')}</td>`
                : '';
              return `<tr data-compact-card="true" data-presented-row="true" data-record-id="${h(row.record.recordId)}" ${selected ? 'data-selected="true"' : ''}>${displayed.map((column) => `<td data-column-label="${h(column.label)}" data-column-priority="${column.presentation?.priority ?? column.orderKey}" data-cell-role="${column.presentation?.role ?? 'value'}">${column === primary ? `<strong>${h(row.cells[column.columnId] ?? '—')}</strong><div class="composition-cell-secondary">${cells(row, secondary)}</div>${detail.length ? `<details class="composition-cell-details" data-cell-role="detail"><summary>Supporting details</summary><div class="composition-cell-secondary">${cells(row, detail)}</div></details>` : ''}` : h(row.cells[column.columnId] ?? '—')}</td>${column === actionsAfter ? actionCell : ''}${column === primary ? progressCell(row) : ''}`).join('')}</tr>`;
            })
            .join('')}</tbody></table></div>`;
  return `<section id="${h(definition.datasetId)}" class="panel data-panel composition-collection" data-composition-dataset="${h(definition.datasetId)}" data-resolution="${child.status}"${definition.presentation?.rail ? ' data-composition-rail' : ''}><div class="composition-collection-heading"><h2>${h(definition.label)}</h2>${definition.presentation?.description ? `<details><summary>About these quantities</summary><p class="composition-description">${h(definition.presentation.description)}</p></details>` : ''}</div>${body}</section>`;
}
/**
 * The totals block (LOOK-1) under the lines its printed document totals: the
 * declared print totals, each a label and its amount, the last the grand
 * total over a double rule. Shown only with the first printed dataset, when
 * it loaded.
 */
function renderCompositionTotals(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
  child: CompositionData['children'][number],
): string {
  const print = surface.composition?.presentation?.print;
  if (
    !print?.totals?.length ||
    print.datasets[0] !== child.definition.datasetId ||
    child.status !== 'ready' ||
    data.fieldsFailed
  )
    return '';
  const label = (id: string) =>
    surface.composition!.fields.find((column) => column.columnId === id)
      ?.label ?? '';
  // A charge with nothing in it is not a line of the totals (round 3); the
  // grand total always is.
  const totals = print.totals;
  const shown = totals.filter(
    (id, index) =>
      index === totals.length - 1 || (data.fields.cells[id] ?? '—') !== '—',
  );
  // The grand total names its declared currency: "Total CAD" (round 3).
  const currency = print.currency
    ? data.fields.cells[print.currency]
    : undefined;
  const last = totals.at(-1);
  return `<dl class="composition-totals">${shown.map((id) => `<div><dt>${h(label(id))}${id === last && currency && currency !== '—' ? ` <span class="composition-totals__currency">${h(currency)}</span>` : ''}</dt><dd>${h(data.fields.cells[id] ?? '—')}</dd></div>`).join('')}</dl>`;
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
  data: Pick<CompositionData, 'fields' | 'fieldsFailed'>,
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
        // The totals block shows these under the lines (LOOK-1 round 2).
        ...(surface.composition!.presentation?.print?.totals ?? []),
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
  // A record can explicitly keep an empty field visible in Details.
  const present = (columnId: string) => {
    const value = data.fields.cells[columnId];
    return !!value && value !== '—';
  };
  const cards = [
    ...fields
      .filter(
        (column) => !header || column.showWhenEmpty || present(column.columnId),
      )
      .map((column) => ({
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
  if (!cards.length) return '';
  // The first facts show; the rest wait under More details (round 3).
  const shown = header ? cards.slice(0, 8) : cards;
  const rest = header ? cards.slice(8) : [];
  return `<section class="panel" data-composition-fields><h2>${h(header ? 'Details' : surface.label)}</h2><dl class="record-fields">${shown.map((card) => card.html).join('')}</dl>${rest.length ? `<details class="draft-more composition-more-fields"><summary>More details</summary><dl class="record-fields">${rest.map((card) => card.html).join('')}</dl></details>` : ''}</section>`;
}
export function renderCompositionChildren(
  data: CompositionData,
  surface?: CompiledSurfaceDefinition,
  view?: RequestRuntimeView,
): string {
  const rail: string[] = [];
  const children = data.children
    .map((child) => {
      if (child.definition.presentation && surface && view) {
        // The declared rail's datasets stack in one column beside the sheet
        // (LOOK-1 round 2), in their declared order.
        if (child.definition.presentation.rail) {
          rail.push(renderPresentedChild(child, data, surface, view));
          return '';
        }
        const presented = renderPresentedChild(child, data, surface, view);
        const totals = renderCompositionTotals(surface, data, child);
        return totals
          ? `${presented.slice(0, -'</section>'.length)}${totals}</section>`
          : presented;
      }
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
  return rail.length > 0
    ? `${children}<section class="panel composition-rail" aria-labelledby="composition-rail-title"><h2 id="composition-rail-title" class="composition-rail__title">Linked documents</h2>${rail.join('')}</section>`
    : children;
}

/**
 * The record-level tasks a document offers besides its next step: on a
 * document with a progression they sit in the Record actions menu with its
 * print link (LOOK-1 round 2: no task row and no prose above the lines);
 * elsewhere -- a customer's order defaults -- beside the context they change.
 */
function recordTasksOf(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
) {
  return ordered(surface.composition!.actions).filter(
    (value) =>
      !value.presentation &&
      !value.datasetId &&
      applicable(value, data) &&
      nextActions.get(data) !== value.actionId,
  );
}

/** What the Record actions menu adds for a document: its other tasks, then print. */
export function renderCompositionMenu(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
  view: RequestRuntimeView,
): string {
  const presentation = surface.composition!.presentation;
  if (!presentation) return '';
  const tasks = presentation.progression ? recordTasksOf(surface, data) : [];
  const printLink = presentation.print
    ? `<a class="secondary-action composition-print" href="${h(compositionPrintHref(data))}">Print ${h(presentation.print.label.toLowerCase())}</a>`
    : '';
  return `${tasks.map((action) => actionLink(action, data, view)).join('')}${printLink}`;
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
    const context = presentation.context;
    const actions = ordered(surface.composition!.actions).filter(
      (value) =>
        value.presentation?.placement === 'selection' &&
        data.children.find(
          (child) => child.definition.datasetId === value.datasetId,
        )?.definition.presentation?.selectedActions !== 'row' &&
        applicable(value, data),
    );
    const selection = data.children
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
      .join(' · ');
    // A document's other tasks are in its Record actions menu; elsewhere they
    // stay beside the context they change (a customer's order defaults).
    const recordTasks = presentation.progression
      ? []
      : recordTasksOf(surface, data);
    const controls = actions.length
      ? actionLink(actions[0]!, data, view) +
        (actions.length > 1
          ? `<details class="composition-context-overflow"><summary>More actions (${actions.length - 1})</summary>${actions
              .slice(1)
              .map((action) => actionLink(action, data, view))
              .join('')}</details>`
          : '')
      : '';
    const tasks = recordTasks.length
      ? `<div class="composition-local-actions" aria-label="Record tasks">${recordTasks.map((action) => actionLink(action, data, view)).join('')}</div>`
      : '';
    // No prose and no section links: the heading names the context and, when
    // a row is selected, that row (LOOK-1 round 2).
    return `${back}${context && (controls || tasks) ? `<section class="composition-context"><div class="composition-context-heading"><div><h2>${h(context.label)}</h2>${selection ? `<p>${h(selection)}</p>` : ''}</div>${controls ? `<div class="composition-local-actions" aria-label="Selected record actions">${controls}</div>` : ''}${tasks}</div></section>` : ''}`;
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
 * An instant input bound to a UTC date-time field: offered as the explicit-UTC
 * date-and-time picker the draft editor uses, to the second, and sent in the
 * field's own canonical spelling. Any other instant input keeps its text box.
 */
function utcInstantInput(
  view: RequestRuntimeView,
  action: Action,
  input: TaskInput,
): CompiledSurfaceInputField | null {
  if (input.type !== 'instant') return null;
  const bound = boundInputField(view, action, input.inputId);
  return bound?.kind === 'dateTimeFieldType' &&
    bound.temporal?.timezoneSemantics === 'utcInstant'
    ? bound
    : null;
}

/**
 * The picker's value as the bound field stores it -- `2026-09-30T23:59` or
 * `...:59` becomes `2026-09-30T23:59:59.000Z` at millisecond precision -- or
 * null when it is no date and time. The instant is the one shown: UTC.
 */
function canonicalUtcInstant(
  value: string,
  field: CompiledSurfaceInputField,
): string | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?$/u.exec(
      value,
    );
  if (!match) return null;
  const fraction = (match[5] ?? '').padEnd(3, '0');
  if (field.temporal?.precision !== 'millisecond' && Number(fraction) !== 0)
    return null;
  const canonical = `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}${field.temporal?.precision === 'millisecond' ? `.${fraction}` : ''}Z`;
  const parsed = new Date(canonical);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === canonical.slice(0, 19)
    ? canonical
    : null;
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
  /**
   * Each row's own read-backs of its per-row steps, read by its later
   * per-row steps only -- a line's reservation, then reserving it.
   */
  rowResults: Record<string, Record<string, SemanticRecordDto>>;
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

/** Advisory changes are calculated from current governed stock reads. */
async function stockImpactRows(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  session: TaskSession,
  data: CompositionData,
  inputs: Readonly<Record<string, string>>,
  prepared: TaskSession['prepared'],
): Promise<string> {
  const impacts = session.action.stockImpacts;
  if (!impacts || session.confirmed) return '';
  const planned = new Map<
    string,
    {
      onHand: string;
      reserved: string;
      available: string;
      usable: boolean;
      location: string;
    }
  >();
  const sections: string[] = [];
  try {
    for (const impact of impacts) {
      const datasetId =
        impact.datasetId ??
        session.action.rows?.datasetId ??
        session.action.datasetId;
      const child = data.children.find(
        (value) => value.definition.datasetId === datasetId,
      );
      const rowIds = impact.datasetId
        ? (child?.rows.map((row) => row.record.recordId) ?? [])
        : session.action.rows
          ? (prepared?.rows ?? session.rowIds)
          : [data.selected?.recordId ?? data.record.recordId];
      for (const rowId of rowIds) {
        const row = child?.rows.find(
          (value) => value.record.recordId === rowId,
        );
        const context =
          row && datasetId ? withRow(data, datasetId, row.record) : data;
        const values = {
          ...inputs,
          ...(prepared?.rowInputs[rowId] ?? session.rowInputs[rowId] ?? {}),
        };
        const item = resolveValue(impact.item, context, values, {}, {});
        const location = resolveValue(impact.location, context, values, {}, {});
        const quantity = resolveValue(impact.quantity, context, values, {}, {});
        if (
          typeof item !== 'string' ||
          typeof location !== 'string' ||
          !location ||
          typeof quantity !== 'string' ||
          !/^-?\d+(?:\.\d+)?$/u.test(quantity)
        )
          continue;
        const key = JSON.stringify([impact.query.targetId, item, location]);
        let before = planned.get(key);
        if (!before) {
          const fields = impact.fields;
          const filters = [
            { fieldId: fields.item, value: item },
            { fieldId: fields.location, value: location },
          ];
          const result = requireSharedListResult(
            await query(view, gateways, impact.query.targetId, data.scope, {
              includeArchived: false,
              list: {
                schemaVersion: SHARED_LIST_QUERY_VERSION,
                cursor: null,
                matchMode: 'substring',
                pageSize: 2,
                search: '',
                sort: [],
                relationLabels: [],
                fieldFilters: filters,
              },
            }),
          );
          if (
            result.listCoverage.hasMore ||
            result.records.length > 1 ||
            filters.some(
              (filter) =>
                !result.listCoverage.fieldFilters?.some(
                  (echoed) =>
                    echoed.fieldId === filter.fieldId &&
                    echoed.value === filter.value,
                ),
            )
          )
            throw new Error('Stock preview requires one exact stock identity');
          const stock = result.records[0];
          if (
            stock &&
            (recordValue(stock, fields.item) !== item ||
              recordValue(stock, fields.location) !== location)
          )
            throw new Error('Stock identity differs');
          const status = await query(
            view,
            gateways,
            impact.locationStatus.query.targetId,
            data.scope,
            { recordId: location, includeArchived: false },
          );
          const place = status.records[0];
          if (
            status.outcome !== 'exact' ||
            status.records.length !== 1 ||
            place?.recordId !== location
          )
            throw new Error('Location unavailable');
          const figure = (field: string) => {
            const value = stock ? recordValue(stock, field) : '0';
            if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value))
              throw new Error('Stock figure unavailable');
            return plainDecimal(value);
          };
          const name = recordValue(place, impact.locationStatus.label);
          before = {
            onHand: figure(fields.onHand),
            reserved: figure(fields.reserved),
            available: figure(fields.available),
            usable:
              recordValue(place, impact.locationStatus.field) ===
              impact.locationStatus.usable,
            location: String(name),
          };
        }
        const delta = (direction: 'increase' | 'decrease' | 'unchanged') =>
          direction === 'unchanged'
            ? '0'
            : direction === 'increase'
              ? quantity
              : quantity.startsWith('-')
                ? quantity.slice(1)
                : `-${quantity}`;
        const onHandDelta = delta(impact.onHand);
        const reservedDelta = delta(impact.reserved);
        const after = {
          ...before,
          onHand: sumDecimals([before.onHand, onHandDelta]),
          reserved: sumDecimals([before.reserved, reservedDelta]),
          available: before.usable
            ? sumDecimals([
                before.available,
                onHandDelta,
                delta(
                  impact.reserved === 'increase'
                    ? 'decrease'
                    : impact.reserved === 'decrease'
                      ? 'increase'
                      : 'unchanged',
                ),
              ])
            : '0',
        };
        planned.set(key, after);
        const measures = [
          ['onHand', 'On hand'],
          ['reserved', 'Reserved'],
          ['available', 'Available'],
        ] as const;
        sections.push(
          `<section class="composition-impact-line"><h4>${h(row && child ? rowName(child.definition, row) : session.action.label)} · ${h(before.location)}</h4><dl>${measures.map(([measure, label]) => `<div data-stock-impact="${measure}"><dt>${label}</dt><dd><span data-impact-before>${h(before![measure])}</span> → <strong data-impact-after>${h(after[measure])}</strong></dd></div>`).join('')}</dl></section>`,
        );
      }
    }
  } catch {
    return '<p role="status">Stock impact is unavailable. Refresh the document to try again.</p>';
  }
  return (
    sections.join('') || '<p>Enter the line details to see stock impact.</p>'
  );
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
    outcome?: { readonly inline: boolean; readonly html: string },
  ) => CompositionResponse,
): Promise<CompositionResponse> {
  let renderData: CompositionData | null = null;
  let displayInputs: Record<string, string> = {};
  let displayChoices: Record<string, SemanticRecordDto[]> = {};
  let impactRows = '';
  // Presentation is reloaded through governed reads at every response boundary.
  // Never refresh the frozen execution context, step inputs, keys or outcomes.
  const taskDocument = async (
    html: () => string,
    inputs = session?.inputs ?? {},
    preparation: TaskSession['prepared'] = null,
    outcome?: () => string,
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
        const defaults = { ...inputs };
        for (const input of session.action.inputs)
          if (!(input.inputId in defaults) && input.type === 'reference')
            defaults[input.inputId] = referenceDefault(
              input,
              fresh,
              displayChoices[input.inputId] ?? [],
            );
        impactRows = await stockImpactRows(
          view,
          gateways,
          session,
          fresh,
          defaults,
          preparation,
        );
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
        `<section class="composition-task-resume" data-task-resume hidden><div><strong>${h(session.action.label)}</strong><span>Closing dismisses the dialog; it does not cancel submitted work.</span></div><button type="button" data-task-open>${phase === 'result' || phase === 'recovery' ? 'View task outcome' : 'Continue task'}</button><a href="${h(renderData.url)}">Refresh record</a></section><dialog open id="composition-task" class="composition-task-dialog" data-composition-task data-task-fallback="${h(dialogPolicy.fallback)}" data-task-phase="${phase}" aria-labelledby="composition-task-heading"><header class="composition-task-header"><div><p>${h(title)}${context ? ` · ${h(context)}` : ''}</p><h2 id="composition-task-heading" data-task-heading tabindex="-1"${phase === 'entry' ? '' : ' data-task-initial-focus'}>${h(session.action.label)}</h2><span class="muted">${phase === 'entry' ? '1 · Enter details' : phase === 'review' ? '2 · Review and confirm' : phase === 'result' ? '3 · Result' : 'Outcome and recovery'}</span></div><button type="button" class="secondary-action" data-task-close hidden aria-label="Close task">×</button></header><div class="composition-task-body">${taskTransportError}${taskPolicy && phase === 'entry' ? renderTaskSummary(renderData, taskPolicy) : ''}${!taskPolicy && selection ? `<section class="composition-task-context" aria-label="Current selection">${selection}</section>` : ''}${html()}${taskPolicy && selection ? `<details class="composition-task-support"><summary>Supporting details</summary>${selection}</details>` : ''}</div></dialog>`,
        renderData,
        200,
        outcome ? { inline: true, html: outcome() } : undefined,
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
  // Direct apply still starts from a form the server issued to this actor.
  if (!token && submission.taskStage === 'apply')
    return taskDocument(() =>
      compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
    );
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
      // Each row starts with what is still open (LOOK-1 round 3, ruling):
      // the declared fill, applied as the Task opens; nothing is filled on
      // a guess.
      rowInputs: prefilledRows(action, data),
      results: {},
      rowResults: {},
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
  const direct = taskCanApplyDirectly(view, current.action);
  const apply =
    submission.taskStage === 'apply' && direct && !current.confirmed;
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
  // A Task that fills its rows from one declared column (what is still
  // open) shows that column as its figure; the rest of the line's figures
  // stay for readers but out of the grid's way, as does a derived per-row
  // value (LOOK-1 round 4: Item · Open · Receive · Unit cost).
  const fillColumns = new Set<string>(
    current.action.inputs.flatMap((input) =>
      input.perRow?.fillFrom ? [input.perRow.fillFrom.columnId] : [],
    ),
  );
  const figureClass = (column: { columnId: string }) =>
    fillColumns.size > 0 && !fillColumns.has(column.columnId)
      ? ' composition-task-context'
      : '';
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
  // Rows the reviewed plan includes, with what each run will write. After the
  // work is done the figures read before it (Received 0) are no longer true,
  // so the result shows only what was written (LOOP-1).
  const previewRows = (figures = true) => {
    const prepared = current.prepared;
    if (!taskRowsDeclared || !prepared || !rowsDataset) return '';
    const { primary } = rowColumns();
    const quantities = figures ? rowColumns().quantities : [];
    return `<div class="data-table-wrap composition-task-rows-review"><table><caption>${h(`${rowsDataset.definition.label} (${String(prepared.rows.length)})`)}</caption><thead><tr><th scope="col">${h(primary?.label ?? '')}</th>${quantities.map((column) => `<th scope="col" class="composition-quantity${figureClass(column)}">${h(column.label)}</th>`).join('')}${perRowInputs.map((input) => `<th scope="col"${input.presentation?.kind === 'derived' ? ' class="composition-task-derived"' : ''}>${h(input.label)}</th>`).join('')}</tr></thead><tbody>${prepared.rows
      .map((rowId) => {
        const row = frozenRow(rowId);
        return `<tr data-compact-card="true" data-task-row="${h(rowId)}"><td data-cell-role="primary" data-column-label="${h(primary?.label ?? '')}"><strong>${h(row ? rowName(rowsDataset.definition, row) : '—')}</strong></td>${quantities.map((column) => `<td data-cell-role="quantity" class="${figureClass(column).trim()}" data-column-label="${h(column.label)}">${h(row?.cells[column.columnId] ?? '—')}</td>`).join('')}${perRowInputs.map((input) => `<td data-column-label="${h(input.label)}">${h(prepared.rowInputs[rowId]?.[input.inputId] || '—')}</td>`).join('')}</tr>`;
      })
      .join('')}</tbody></table></div>`;
  };
  const previewInputs = (figures = true) =>
    current.action.presentation?.task && current.prepared?.presentation
      ? renderTaskConfirmation(
          current.action.presentation.task,
          current.prepared.presentation,
        )
      : `<dl class="composition-reviewed-inputs">${headerInputs.map((input) => `<div><dt>${h(input.label)}</dt><dd>${h(shownInput(input, displayInputs[input.inputId] ?? ''))}</dd></div>`).join('')}</dl>${previewRows(figures)}`;
  const confirmLabel = () => {
    const declared =
      current.action.presentation?.task?.confirmation.confirmLabel;
    if (declared) return declared;
    const quantities = perRowInputs.filter(
      (input) => input.type === 'quantity',
    );
    if (
      taskRowsDeclared?.fillLabel &&
      quantities.length === 1 &&
      current.prepared
    ) {
      const quantity = quantities[0]!;
      return `${current.action.label} ${plainDecimal(sumDecimals(current.prepared.rows.map((row) => current.prepared!.rowInputs[row]![quantity.inputId]!)))}`;
    }
    return `Confirm ${current.action.label}`;
  };
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
  if (submission.taskStage === 'apply' && !direct)
    return taskDocument(() =>
      compositionMessage('COMPOSITION_TASK_UNAVAILABLE', 'alert'),
    );
  let error = '';
  // Problems with the entered values, named beside each input.
  const fieldErrors = new Map<string, string>();
  // Problems with a row's entered values, keyed by the row's own input.
  const rowErrors = new Map<string, string>();
  let rowsError = '';
  let applyPrepared = false;
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
  if ((submission.taskStage === 'prepare' && !current.confirmed) || apply) {
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
      } else if (value && input.type === 'instant') {
        const bound = utcInstantInput(view, current.action, input);
        if (bound) {
          const canonical = canonicalUtcInstant(value, bound);
          if (canonical === null)
            fieldErrors.set(input.inputId, 'Enter a date and time.');
          else value = canonical;
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
      if (apply) applyPrepared = true;
      else
        return taskDocument(
          () =>
            `<section data-task-prepared><div data-task-review-summary${taskRowsDeclared && current.action.stockImpacts ? ' data-task-row-review' : ''}>${previewInputs()}</div>${current.action.stockImpacts ? `<section class="composition-task-after" aria-label="After you post"><p class="eyebrow">After you post</p>${impactRows}</section>` : `<p class="composition-task-consequence">${h(current.action.description)}</p>`}<form class="composition-task-footer" method="post" action="${h(url)}">${hidden}<input type="hidden" name="preparedId" value="${h(prepared.id)}"><button class="secondary-action" name="taskStage" value="edit">Edit inputs</button><button name="taskStage" value="confirm">${h(confirmLabel())}</button></form></section>${back}`,
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
    applyPrepared ||
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
    let runningOperationId: string | null = null;
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
              run.row === null
                ? current.results
                : { ...current.results, ...current.rowResults[run.row] },
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
        runningOperationId = operation.operationId;
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
        // A per-row run's read-back is its row's alone: only that row's later
        // per-row steps read it.
        if (run.row === null) current.results[step.stepId] = result.readBack;
        else
          (current.rowResults[run.row] ??= {})[step.stepId] = result.readBack;
      }
      // Only a wholly verified Task can put its outcome on the record.
      const outcome = () =>
        `<section class="composition-task-result" data-task-result role="status" aria-label="Result" tabindex="-1"><h3>${h(current.action.label)}: done</h3>${previewInputs(false)}</section><details class="composition-task-support"><summary>Status and recovery receipt</summary>${compositionMessage('COMPOSITION_COMPLETE')}${current.receipt ? `<pre>${h(current.receipt)}</pre>` : ''}</details>`;
      return taskDocument(
        () =>
          `${outcome()}<p>Closing this task does not undo submitted work.</p>${back}`,
        current.inputs,
        null,
        outcome,
      );
    } catch (failure) {
      const ref = operationMessageRef(failure);
      const rule = runningOperationId
        ? validationRefusalForOperation(view, runningOperationId, failure)
        : undefined;
      error =
        'The operation could not be verified. Earlier steps may have committed. Retry uses the same inputs and request keys; inspect the order if needed.';
      return taskDocument(
        () =>
          `<div role="alert" ${rule ? 'data-form-validation-refusal' : messageAttributes(ref)}>${rule ? `<p>${h(rule.message)}</p>` : messageBody(ref, 'Operation', 'h2')}</div>${rule && current.next === 0 ? '' : compositionMessage('COMPOSITION_UNCERTAIN', 'alert')}${previewInputs()}${rule ? '' : `<form class="composition-task-footer" method="post" action="${h(url)}">${hidden}<button name="taskStage" value="retry">Retry same request</button></form>`}${back}`,
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
      else if (utcInstantInput(view, current.action, input)) {
        // The explicit-UTC picker, to the second; a reviewed value shows as
        // it was entered, without the zone the label already names.
        const shown = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/u.exec(
          displayInputs[input.inputId] ?? '',
        );
        control = `<input type="datetime-local" step="1" name="${h(input.inputId)}" value="${h(shown?.[1] ?? '')}"${required}${invalid}>`;
      } else {
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
      const utc = utcInstantInput(view, current.action, input) ? ' (UTC)' : '';
      return `<div class="composition-input"><label class="field">${h(input.label)}${utc}${control}</label>${problem ? `<small class="field-error" id="${h(input.inputId)}-error">${h(problem)}</small>` : ''}</div>`;
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
      const numericRowInput = (input: (typeof perRowInputs)[number]) =>
        input.type === 'quantity' ||
        (input.type === 'text' &&
          DECIMAL_KINDS.includes(
            boundInputField(view, current.action, input.inputId)?.kind ?? '',
          ));
      rows = `<fieldset class="composition-task-rows" data-task-rows="${h(taskRowsDeclared.datasetId)}"${rowsError ? ` aria-describedby="${errorId}"` : ''}><legend>${h(rowsDataset.definition.label)}</legend>${taskRowsDeclared.fillLabel ? `<button type="submit" class="secondary-action" name="taskStage" value="fill" formnovalidate>${h(taskRowsDeclared.fillLabel)}</button>` : ''}${rowsError ? `<small class="field-error" id="${errorId}">${h(rowsError)}</small>` : ''}<div class="data-table-wrap"><table><thead><tr><th scope="col">${h(primary?.label ?? '')}</th>${quantities.map((column) => `<th scope="col" class="composition-quantity${figureClass(column)}">${h(column.label)}</th>`).join('')}${perRowInputs.map((input) => `<th scope="col"${input.presentation?.kind === 'derived' ? ' class="composition-task-derived"' : numericRowInput(input) ? ' data-cell-kind="number"' : ''}>${h(input.label)}</th>`).join('')}</tr></thead><tbody>${current.rowIds
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
          return `<tr data-compact-card="true" data-task-row="${h(rowId)}"><td data-cell-role="primary" data-column-label="${h(primary?.label ?? '')}"><strong>${h(name)}</strong>${secondary.length ? `<div class="composition-cell-secondary">${secondary.map((column) => `<span><span class="composition-cell-label">${h(column.label)}</span> ${h(cells[column.columnId] ?? '—')}</span>`).join('')}</div>` : ''}</td>${quantities.map((column) => `<td data-cell-role="quantity" class="${figureClass(column).trim()}" data-column-label="${h(column.label)}">${h(cells[column.columnId] ?? '—')}</td>`).join('')}${perRowInputs
            .map((input) => {
              const key = rowField(input.inputId, rowId);
              const problem = rowErrors.get(key);
              const described = `${key}-error`;
              const message = problem
                ? `<small class="field-error" id="${h(described)}">${h(problem)}</small>`
                : '';
              if (input.presentation?.kind === 'derived')
                return `<td class="composition-task-derived" data-column-label="${h(input.label)}"><output class="derived-value" data-derived-input>${h(cells[input.presentation.column.columnId] ?? '—')}</output>${message}</td>`;
              const numeric = numericRowInput(input);
              return `<td data-column-label="${h(input.label)}"${numeric ? ' data-cell-kind="number"' : ''}><input name="${h(key)}" value="${h(current.rowInputs[rowId]?.[input.inputId] ?? '')}" aria-label="${h(`${input.label}, ${name}${context}`)}"${numeric ? ' inputmode="decimal" autocomplete="off"' : ''}${problem ? ` aria-invalid="true" aria-describedby="${h(described)}"${focus(problem) ? ' data-task-initial-focus autofocus' : ''}` : ''}>${message}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('')}</tbody></table></div></fieldset>`;
    }
    const stage = direct ? 'apply' : 'prepare';
    const label = direct
      ? current.action.label
      : (current.action.presentation?.task?.confirmation.reviewLabel ??
        `Review ${current.action.label}`);
    const liveReview = !direct;
    return `${error ? `<div data-task-input-error>${compositionMessage('COMPOSITION_INPUT_INVALID', 'alert')}</div>` : ''}<form class="composition-inputs" method="post" action="${h(url)}" novalidate${liveReview ? ' data-task-live-review' : ''}>${hidden}${taskRowsDeclared?.fillLabel ? `<button type="submit" class="sr-only" name="taskStage" value="${stage}" tabindex="-1" aria-hidden="true" data-task-default></button>` : ''}${controls.join('')}${rows}<section class="composition-task-after" aria-label="After you post"${current.action.stockImpacts ? ' data-task-entry-impact' : ''}><p class="eyebrow">After you post</p>${current.action.stockImpacts ? impactRows : `<p class="composition-task-consequence">${h(current.action.description)}</p>`}</section><footer class="composition-task-footer"><a class="secondary-action" href="${h(url)}">Cancel</a><button name="taskStage" value="${stage}">${h(label)}</button></footer></form>${liveReview ? '<section data-task-inline-review hidden aria-label="Review and confirm"></section>' : ''}`;
  });
}

export const taskTransportError =
  '<p role="alert" data-task-transport-error hidden>The task response is unavailable. You can retry this step or refresh the page.</p>';

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
