import { randomUUID } from 'node:crypto';
import type { SurfaceComposition } from '../../../packages/canonical-model/src/index.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
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
} from './surface-contract.js';
import { escapeHtml as h } from './html.js';
import { operationMessageRef } from './gateway-error-codes.js';
import { messageAttributes, messageBody } from './message-render.js';
import type { SurfaceMessageCode } from './message-catalog.js';
const compositionMessage = (
  code: Extract<SurfaceMessageCode, `COMPOSITION_${string}`>,
  role: 'alert' | 'status' | null = null,
) =>
  `<div ${role ? `role="${role}"` : ''} ${messageAttributes({ code })}>${messageBody({ code }, 'Workspace', 'h2')}</div>`;

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
    error?: string;
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
function displayFieldValue(
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
  return result;
}

async function present(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  scope: string | null,
  record: SemanticRecordDto,
  columns: readonly Column[],
): Promise<Row> {
  const cells: Record<string, string> = {};
  for (const column of columns) {
    const value = recordValue(record, column.field);
    if (!column.reference || value === null) {
      cells[column.columnId] = displayFieldValue(
        view,
        record,
        column.field,
        value,
      );
      continue;
    }
    const result = await query(
      view,
      gateways,
      column.reference.query.targetId,
      scope,
      { recordId: value, includeArchived: false },
    );
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
      if (!definition.parent)
        throw new Error('Child queries require an exact relation scope.');
      if (
        definition.parent.value.source === 'selected' &&
        !(definition.parent.value.datasetId
          ? data.selections[definition.parent.value.datasetId]
          : data.selected)
      )
        continue;
      const parentId = resolveValue(definition.parent.value, data, {}, {}, {});
      const registered = registeredSemanticQueryFromPinnedView(
        view,
        definition.query.targetId,
      );
      if (!registered || registered.queryType !== 'list')
        throw new Error('Child query must be a registered list.');
      let cursor: string | null = null;
      do {
        const scopeKey =
          definition.parent.ownership === 'reference'
            ? 'referenceScope'
            : 'parentScope';
        const restriction = {
          recordId: String(parentId),
          relationId: definition.parent.relationId,
        };
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
              sort: [],
              relationLabels: [],
              [scopeKey]: restriction,
            },
          }),
        );
        const applied = result.listCoverage[scopeKey];
        if (
          applied?.recordId !== restriction.recordId ||
          applied.relationId !== restriction.relationId
        )
          throw new Error('The query did not apply its exact record scope.');
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
      return input;
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
function applicable(action: Action, data: CompositionData): boolean {
  if (
    action.datasetId &&
    (!data.selected || action.datasetId !== data.selectedDatasetId)
  )
    return false;
  try {
    return action.conditions.every((condition) => {
      const actual = resolveValue(condition.value, data, {}, {}, {});
      if (condition.operator === 'positive')
        return (
          typeof actual === 'string' &&
          /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/.test(actual)
        );
      return condition.operator === 'equals'
        ? actual === condition.compare
        : actual !== condition.compare;
    });
  } catch {
    return false;
  }
}

export function renderCompositionFields(
  surface: CompiledSurfaceDefinition,
  data: CompositionData,
): string {
  if (data.fieldsFailed)
    return compositionMessage('COMPOSITION_CHILD_FAILED', 'alert');
  return `<section class="panel"><h2>${h(surface.label)}</h2><dl class="record-fields">${ordered(
    surface.composition!.fields,
  )
    .map(
      (column) =>
        `<div><dt>${h(column.label)}</dt><dd>${h(data.fields.cells[column.columnId] ?? '—')}</dd></div>`,
    )
    .join('')}</dl></section>`;
}
export function renderCompositionChildren(data: CompositionData): string {
  const children = data.children
    .map((child) => {
      const columns = ordered(child.definition.columns);
      return `<section class="panel data-panel" data-composition-dataset="${h(child.definition.datasetId)}" data-resolution="${child.status}"><h2>${h(child.definition.label)}</h2>${
        child.status === 'failed'
          ? compositionMessage('COMPOSITION_CHILD_FAILED', 'alert')
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
  const actions = ordered(surface.composition!.actions)
    .filter((action) => applicable(action, data))
    .map((action) => {
      if (action.navigate) {
        const url = new URL(data.url, 'http://surface-runtime.local');
        url.searchParams.set('surface', action.navigate.surface.targetId);
        url.searchParams.set(
          'record',
          String(resolveValue(action.navigate.record, data, {}, {}, {})),
        );
        url.searchParams.set('returnTo', data.url);
        const targetQuery = registeredSemanticQueryFromPinnedView(
          view,
          action.navigate.query.targetId,
        );
        if (targetQuery?.legalEntityScope && data.scope)
          url.searchParams.set(
            targetQuery.legalEntityScope.operand.parameterId,
            data.scope,
          );
        return `<a class="button" href="${h(url.pathname + url.search)}">${h(action.label)}</a>`;
      }
      return `<form method="post" action="${h(data.url)}"><input type="hidden" name="compositionAction" value="${h(action.actionId)}"><button type="submit">${h(action.label)}</button></form>`;
    })
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

interface TaskSession {
  action: Action;
  surfaceId: string;
  data: CompositionData;
  identity: string;
  inputs: Record<string, string>;
  results: Record<string, SemanticRecordDto>;
  generated: Record<string, string>;
  keys: string[];
  stepInputs: Record<string, ImmutableJsonValue>[];
  next: number;
  confirmed: boolean;
  preparation: number;
  prepared: {
    readonly id: string;
    readonly inputs: Readonly<Record<string, string>>;
  } | null;
  receipt: string | null;
  created: number;
  busy: boolean;
  committedWithheld: boolean;
}
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
          { recordId: session.data.record.recordId, includeArchived: false },
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
          : session.next === session.action.steps.length
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
                  .map(
                    (column) =>
                      `<div><dt>${h(column.label)}</dt><dd>${h(row.cells[column.columnId] ?? '—')}</dd></div>`,
                  )
                  .join('')}</dl></section>`,
              ]
            : [];
        })
        .join('') ?? '';
    return renderTask(
      `<section class="panel" data-composition-task>${html()}${selection ? `<details open><summary>Current selection</summary>${selection}</details>` : ''}</section>`,
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
    const scope = definition?.legalEntityScope
      ? url.searchParams.get(definition.legalEntityScope.operand.parameterId)
      : null;
    const result = await query(
      view,
      gateways,
      surface.dataSourceQueryId,
      scope,
      { recordId: url.searchParams.get('record'), includeArchived: false },
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
      results: {},
      generated: {},
      keys: action.steps.map(() => randomUUID()),
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
  const previewInputs = () =>
    `<dl>${current.action.inputs.map((input) => `<dt>${h(input.label)}</dt><dd>${h(displayInputs[input.inputId] ?? '')}</dd>`).join('')}</dl>`;
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
  if (submission.taskStage === 'prepare' && !current.confirmed) {
    const generation = ++current.preparation;
    current.prepared = null;
    const inputs = Object.freeze(
      Object.fromEntries(
        current.action.inputs.map((input) => [
          input.inputId,
          (submission[input.inputId] ?? '').trim(),
        ]),
      ),
    );
    if (
      current.action.inputs.some(
        (input) => input.required && !inputs[input.inputId],
      )
    )
      error = 'Complete the required inputs.';
    if (
      current.action.inputs.some(
        (input) =>
          input.type === 'quantity' &&
          !/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/.test(
            inputs[input.inputId] ?? '',
          ),
      )
    )
      error = 'Enter a positive exact quantity.';
    try {
      for (const input of current.action.inputs.filter(
        (input) => input.type === 'reference',
      )) {
        const choices = await referenceChoices(
          view,
          gateways,
          current.data.scope,
          input,
        );
        if (
          !choices.some((choice) => choice.recordId === inputs[input.inputId])
        )
          error = 'Choose an available reference.';
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
      const prepared = Object.freeze({ id: randomUUID(), inputs });
      current.prepared = prepared;
      return taskDocument(
        () =>
          `<h1>Confirm ${h(current.action.label)}</h1><p>${h(current.action.description)}</p>${previewInputs()}<form method="post" action="${h(url)}">${hidden}<input type="hidden" name="preparedId" value="${h(prepared.id)}"><button name="taskStage" value="confirm">Confirm ${h(current.action.label)}</button><button name="taskStage" value="edit">Edit inputs</button></form>${back}`,
        inputs,
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
    current.confirmed = true;
    current.busy = true;
    try {
      const catalog = parsePinnedOperationCatalog(
        view.projections.operation.payload,
      );
      for (; current.next < current.action.steps.length; current.next++) {
        const step = current.action.steps[current.next]!;
        const operation = catalog.find(
          (candidate) => candidate.operationId === step.operation.targetId,
        );
        if (!operation)
          throw new Error('The declared operation is unavailable.');
        let input = current.stepInputs[current.next];
        if (!input) {
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
            target[key] = resolveValue(
              binding.value,
              current.data,
              current.inputs,
              current.results,
              current.generated,
              `${step.stepId}:${binding.path.join('.')}`,
            );
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
        current.results[step.stepId] = result.readBack;
      }
      return taskDocument(
        () =>
          `<h1>${h(current.action.label)}</h1>${compositionMessage('COMPOSITION_COMPLETE', 'status')}${back}`,
      );
    } catch (failure) {
      const ref = operationMessageRef(failure);
      error =
        'The operation could not be verified. Earlier steps may have committed. Retry uses the same inputs and request keys; inspect the order if needed.';
      return taskDocument(
        () =>
          `<h1>${h(current.action.label)}</h1><div role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Operation', 'h2')}</div>${compositionMessage('COMPOSITION_UNCERTAIN', 'alert')}${previewInputs()}<form method="post" action="${h(url)}">${hidden}<button name="taskStage" value="retry">Retry same request</button></form>${back}`,
      );
    } finally {
      current.busy = false;
    }
  }
  if (current.confirmed)
    return taskDocument(
      () =>
        `<h1>${h(current.action.label)}</h1>${compositionMessage('COMPOSITION_UNCERTAIN', 'alert')}${previewInputs()}<form method="post" action="${h(url)}">${hidden}<button name="taskStage" value="retry">Retry same request</button></form>${back}`,
    );
  return taskDocument(() => {
    const controls = ordered(current.action.inputs).map((input) => {
      const control =
        input.type === 'reference' && input.query && input.labelField
          ? `<select name="${h(input.inputId)}" ${input.required ? 'required' : ''}><option value="">Select…</option>${(displayChoices[input.inputId] ?? []).map((record) => `<option value="${h(record.recordId)}" ${current.inputs[input.inputId] === record.recordId ? 'selected' : ''}>${h(text(recordValue(record, input.labelField!.targetId)))}</option>`).join('')}</select>`
          : `<input name="${h(input.inputId)}" value="${h(displayInputs[input.inputId] ?? '')}" ${input.required ? 'required' : ''} ${input.type === 'quantity' ? 'inputmode="decimal"' : ''}>`;
      return `<label class="field">${h(input.label)}${control}</label>`;
    });
    return `<h1>${h(current.action.label)}</h1><p>${h(current.action.description)}</p>${error ? compositionMessage('COMPOSITION_INPUT_INVALID', 'alert') : ''}<form class="composition-inputs" method="post" action="${h(url)}">${hidden}${controls.join('')}<button name="taskStage" value="prepare">Review ${h(current.action.label)}</button></form>${back}`;
  });
}

async function referenceChoices(
  view: RequestRuntimeView,
  gateways: CompositionGateways,
  scope: string | null,
  input: Action['inputs'][number],
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
          },
        }),
      );
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
  return records;
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
