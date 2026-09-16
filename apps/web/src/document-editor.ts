import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  RequestRuntimeView,
  ImmutableJsonValue,
} from '../../../packages/runtime/src/request-runtime-view.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  registeredSemanticQueryFromPinnedView,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type SemanticOperationResultEnvelope,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import type { SurfaceDocumentEditor } from '../../../packages/canonical-model/src/schemas.js';
import {
  readCompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceOperationBinding,
} from './surface-contract.js';
import type {
  SurfaceRuntimeGateways,
  SurfaceRuntimeSubmission,
} from './surface-runtime.js';
import {
  resolveWorkspaceEntry,
  workspaceList,
  workspacePrincipalKey,
} from './workspace-entry.js';
import { escapeHtml as h } from './html.js';
import { operationMessageRef } from './gateway-error-codes.js';
import {
  messageBody,
  messageAttributes,
  type SurfaceMessageRef,
} from './message-render.js';

type Values = Record<string, ImmutableJsonValue>;
type DraftRow = {
  id: string;
  record: SemanticRecordDto | null;
  values: Values;
  removed: boolean;
};
type SaveStep = {
  label: string;
  operation: CompiledSurfaceOperationBinding;
  input: Values;
  key: string;
  grant: string | null;
  row: DraftRow;
  done: boolean;
};
type AcknowledgedStep = {
  key: string;
  receipt: SemanticOperationResultEnvelope['trust'];
};
type Buffer = {
  id: string;
  owner: string;
  release: string;
  scope: string;
  definition: SurfaceDocumentEditor;
  recordId: string | null;
  openedRecordId: string | null;
  completedLocation: string | null;
  header: DraftRow;
  lines: DraftRow[];
  pending: SaveStep[] | null;
  acknowledged: AcknowledgedStep[];
  busy: boolean;
  version: number;
  touched: number;
  notice: string;
  withheld: 'none' | 'operation' | 'partial';
};
const buffers = new Map<string, Buffer>();
const expiry = 60 * 60 * 1000;
const warning = (ref: SurfaceMessageRef) =>
  `<div role="alert" ${messageAttributes(ref)}>${messageBody(ref, 'Save', 'h2')}</div>`;
const editable = (
  definition: SurfaceDocumentEditor,
  record: SemanticRecordDto,
) =>
  definition.editableStateIds.some(
    (value) => value === record.values[definition.stateFieldId],
  );
const inputName = (row: DraftRow, field: string) => `draft:${row.id}:${field}`;
const string = (value: ImmutableJsonValue | undefined) =>
  value == null ? '' : String(value);

async function getRecord(
  view: RequestRuntimeView,
  gateways: SurfaceRuntimeGateways,
  surface: CompiledSurfaceDefinition,
  id: string,
  scope: string,
) {
  const definition = registeredSemanticQueryFromPinnedView(
    view,
    surface.dataSourceQueryId,
  );
  if (!definition?.legalEntityScope)
    throw new Error('Explicit document scope unavailable');
  const result = await gateways.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: surface.dataSourceQueryId,
    arguments: {
      recordId: id,
      includeArchived: false,
      [definition.legalEntityScope.operand.parameterId]: scope,
    },
  });
  if (result.outcome !== 'exact' || result.records.length !== 1)
    throw new Error('Document unavailable');
  return result.records[0]!;
}
function surfaceFor(
  surfaces: readonly CompiledSurfaceDefinition[],
  id: string,
) {
  const surface = surfaces.find((value) => value.surfaceId === id);
  if (!surface) throw new Error('Declared editor surface unavailable');
  return surface;
}
function operationFor(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  intent: 'create' | 'update' | 'archive',
) {
  const operations = readCompiledSurfaceDataBinding(
    view,
    surface,
  ).operations.filter((value) => value.intent === intent);
  if (operations.length !== 1)
    throw new Error('Declared editor operation unavailable');
  return operations[0]!;
}
const row = (record: SemanticRecordDto | null = null): DraftRow => ({
  id: record?.recordId ?? randomUUID(),
  record,
  values: { ...record?.values },
  removed: false,
});

/** One typed draft editor in existing Record slots, using only semantic gateways. */
export async function documentEditor(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  url: URL,
  scope: string,
  gateways: SurfaceRuntimeGateways,
  submission: SurfaceRuntimeSubmission | null = null,
): Promise<{
  html: string;
  statusCode: number;
  location?: string;
  slots?: Record<string, string>;
  record?: SemanticRecordDto;
} | null> {
  const definition = surface.documentEditor!;
  const recordSurface = surfaceFor(surfaces, definition.recordSurfaceId);
  const recordId = url.searchParams.get('record');
  for (const [key, value] of buffers)
    if (!value.busy && performance.now() - value.touched > expiry)
      buffers.delete(key);
  const continuation = submission?.draftSession
    ? buffers.get(submission.draftSession)
    : null;
  if (
    submission?.draftSession &&
    (!continuation ||
      continuation.owner !== workspacePrincipalKey(view) ||
      continuation.release !== view.release.contentHash ||
      continuation.scope !== scope ||
      (continuation.recordId !== recordId &&
        continuation.openedRecordId !== recordId) ||
      continuation.definition.recordSurfaceId !== definition.recordSurfaceId)
  )
    return {
      html: warning({ code: 'OPERATION_INPUT_INVALID' }),
      statusCode: 422,
    };
  const committed = () => ({
    html: warning({ code: 'OPERATION_COMMITTED_READBACK_WITHHELD' }),
    statusCode: 200,
  });
  const partialCommitted = () => ({
    html: warning({ code: 'DRAFT_EDITOR_PARTIAL_COMMIT_WITHHELD' }),
    statusCode: 200,
  });
  const redactAcknowledgedReadFailure = (buffer: Buffer | null | undefined) => {
    if (!buffer || buffer.acknowledged.length === 0) return null;
    buffer.withheld = 'partial';
    return partialCommitted();
  };
  const requiredRead = async <T>(
    buffer: Buffer | null | undefined,
    read: () => Promise<T>,
  ): Promise<
    | { outcome: 'available'; value: T }
    | {
        outcome: 'redacted';
        response: ReturnType<typeof partialCommitted>;
      }
  > => {
    try {
      return { outcome: 'available', value: await read() };
    } catch (error) {
      const response = redactAcknowledgedReadFailure(buffer);
      if (response) return { outcome: 'redacted', response };
      throw error;
    }
  };
  if (continuation?.withheld === 'operation') return committed();
  if (continuation?.withheld === 'partial') return partialCommitted();
  if (continuation?.completedLocation) {
    try {
      const entry = await resolveWorkspaceEntry(
        view,
        surface,
        url,
        gateways.queryGateway,
      );
      if (entry?.invalid) return committed();
      await getRecord(
        view,
        gateways,
        recordSurface,
        continuation.header.id,
        scope,
      );
      await workspaceList(
        view,
        gateways.queryGateway,
        definition.lineQueryId,
        scope,
        {
          relationId: definition.parentRelationId,
          recordId: continuation.header.id,
        },
      );
      return {
        html: '',
        statusCode: 303,
        location: continuation.completedLocation,
      };
    } catch {
      return committed();
    }
  }
  const initialRead = await requiredRead(continuation, async () =>
    recordId
      ? await getRecord(view, gateways, recordSurface, recordId, scope)
      : null,
  );
  if (initialRead.outcome === 'redacted') return initialRead.response;
  let current = initialRead.value;
  if (current && !editable(definition, current)) {
    return {
      html: warning({ code: 'DRAFT_EDITOR_LOCKED' }),
      statusCode: 422,
    };
  }
  let buffer: Buffer;
  if (submission?.draftSession) {
    buffer = continuation!;
  } else {
    buffer = {
      id: randomUUID(),
      owner: workspacePrincipalKey(view),
      release: view.release.contentHash,
      scope,
      definition,
      recordId,
      openedRecordId: recordId,
      completedLocation: null,
      header: row(current),
      lines: [],
      pending: null,
      acknowledged: [],
      busy: false,
      version: 0,
      touched: performance.now(),
      notice: '',
      withheld: 'none',
    };
    if (current)
      buffer.lines = (
        await workspaceList(
          view,
          gateways.queryGateway,
          definition.lineQueryId,
          scope,
          {
            relationId: definition.parentRelationId,
            recordId: current.recordId,
          },
          [{ fieldId: definition.lineNumberFieldId, direction: 'ascending' }],
        )
      ).map((value) => row(value));
    else buffer.lines.push(row());
    buffers.set(buffer.id, buffer);
  }
  const workspaceEntry = await requiredRead(buffer, () =>
    resolveWorkspaceEntry(view, surface, url, gateways.queryGateway),
  );
  if (workspaceEntry.outcome === 'redacted') return workspaceEntry.response;
  const entry = workspaceEntry.value;
  if (entry?.invalid) {
    const redacted = redactAcknowledgedReadFailure(buffer);
    if (redacted) return redacted;
    return {
      html: warning({ code: 'WORKSPACE_COMPANY_UNAVAILABLE' }),
      statusCode: 422,
    };
  }
  const authorizePersisted = async () => {
    const authorization = await requiredRead(buffer, async () => {
      if (!buffer.recordId) return;
      current = await getRecord(
        view,
        gateways,
        recordSurface,
        buffer.recordId,
        scope,
      );
      await workspaceList(
        view,
        gateways.queryGateway,
        definition.lineQueryId,
        scope,
        {
          relationId: definition.parentRelationId,
          recordId: buffer.recordId,
        },
      );
    });
    return authorization.outcome === 'redacted' ? authorization.response : null;
  };
  const authorization = await authorizePersisted();
  if (authorization) return authorization;
  let statusCode = 200;
  if (submission) {
    if (buffer.busy)
      return {
        html: warning({ code: 'OPERATION_INPUT_INVALID' }),
        statusCode: 409,
      };
    if (submission.draftVersion !== String(buffer.version)) {
      buffer.notice = warning({ code: 'DRAFT_EDITOR_CONFLICT' });
      statusCode = 409;
    } else {
      buffer.busy = true;
      try {
        if (!buffer.pending && buffer.withheld === 'none') {
          capture(buffer.header, definition.headerFields, submission);
          for (const line of buffer.lines)
            if (!line.removed) capture(line, definition.lineFields, submission);
        }
        if (
          !buffer.pending &&
          current &&
          buffer.header.record?.revision !== current.revision
        ) {
          buffer.notice = warning({ code: 'DRAFT_EDITOR_CONFLICT' });
          statusCode = 409;
        } else if (buffer.withheld === 'none') {
          if (!buffer.pending) {
            if (submission.draftAction === 'add' && buffer.lines.length < 40)
              buffer.lines.push(row());
            else if (submission.draftAction?.startsWith('remove:')) {
              const line = buffer.lines.find(
                (value) => value.id === submission.draftAction!.slice(7),
              );
              if (line?.record) line.removed = true;
              else if (line)
                buffer.lines = buffer.lines.filter((value) => value !== line);
            } else if (submission.draftAction === 'save')
              buffer.pending = plan(view, surfaces, buffer);
          }
          if (buffer.pending) {
            const removal = buffer.pending.some(
              (step) =>
                step.operation.confirmation === 'humanRequired' && !step.done,
            );
            if (removal && submission.draftAction !== 'confirm') {
              for (const step of buffer.pending)
                if (
                  step.operation.confirmation === 'humanRequired' &&
                  !step.grant
                )
                  step.grant =
                    gateways.operationMediation.issueConfirmationGrant(
                      view,
                      step.operation.operationId,
                      step.input,
                    );
              buffer.notice =
                '<p>Review the removed persisted lines below. Confirm removal and save to archive them through their governed lifecycle.</p>';
            } else if (
              ['save', 'confirm', 'retry'].includes(
                submission.draftAction ?? '',
              )
            ) {
              for (const step of buffer.pending) {
                if (step.done) continue;
                try {
                  const result = await gateways.operationGateway.invoke(
                    view,
                    {
                      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                      operationId: step.operation.operationId,
                      input: step.input,
                      idempotencyKey: step.key,
                      confirmationGrant: step.grant,
                    },
                    gateways.operationMediation.issueInvocation(view, 'UI'),
                  );
                  if (result.outcome !== 'succeeded')
                    throw new Error('Save step returned non-success');
                  step.done = true;
                  acknowledge(buffer, step, result.trust);
                  if (
                    !result.readBack ||
                    result.readBack.recordId !== step.row.id
                  ) {
                    buffer.withheld = 'operation';
                    buffer.notice = warning({
                      code: 'OPERATION_COMMITTED_READBACK_WITHHELD',
                    });
                    break;
                  }
                  step.row.record = result.readBack;
                  if (step.row === buffer.header) {
                    buffer.recordId = result.readBack.recordId;
                  }
                } catch (error) {
                  buffer.notice = warning(operationMessageRef(error));
                  statusCode = 422;
                  if (
                    error instanceof Error &&
                    error.name === 'ModuleRuntimeInterpreterError' &&
                    'code' in error &&
                    [
                      'MODULE_FIELD_VALUE_INVALID',
                      'MODULE_ENUM_VALUE_INVALID',
                      'MODULE_REQUIRED_FIELD_MISSING',
                    ].includes(String(error.code))
                  ) {
                    const completed = buffer.pending.filter(
                      (value) => value.done,
                    );
                    buffer.notice += `<p>${completed.length} save operations committed. Correct the invalid values and save the remaining changes.</p>`;
                    reconcileCompletedRemovals(buffer, completed);
                    buffer.pending = null;
                  }
                  break;
                }
              }
              if (
                buffer.withheld === 'none' &&
                buffer.pending?.every((step) => step.done)
              ) {
                buffer.pending = null;
                buffer.lines = buffer.lines.filter((line) => !line.removed);
                const params = new URLSearchParams({
                  surface: definition.recordSurfaceId,
                  record: buffer.header.id,
                });
                const binding = readCompiledSurfaceDataBinding(
                  view,
                  recordSurface,
                );
                params.set(
                  binding.query.legalEntityScope!.operand.parameterId,
                  scope,
                );
                buffer.completedLocation = `/?${params}`;
                return {
                  html: '',
                  statusCode: 303,
                  location: buffer.completedLocation,
                };
              }
            }
          }
        }
      } catch (error) {
        buffer.notice = warning(operationMessageRef(error));
        statusCode = 422;
      } finally {
        buffer.busy = false;
        buffer.version++;
        buffer.touched = performance.now();
      }
    }
  }
  if (buffer.withheld === 'operation')
    return {
      html: warning({ code: 'OPERATION_COMMITTED_READBACK_WITHHELD' }),
      statusCode: 200,
    };
  if (buffer.withheld === 'partial') return partialCommitted();
  try {
    const authorization = await authorizePersisted();
    if (authorization) return authorization;
    // After partial creation the URL owns the committed parent, so retries cannot
    // silently retarget or recreate it. Form action uses that exact context.
    const action = new URL(url);
    if (buffer.recordId) action.searchParams.set('record', buffer.recordId);
    const scopeQuery = readCompiledSurfaceDataBinding(view, surface).query
      .legalEntityScope!;
    action.searchParams.set(scopeQuery.operand.parameterId, scope);
    const frozen = buffer.pending !== null || buffer.withheld !== 'none';
    const header = await fieldsHtml(
      view,
      gateways,
      surfaces,
      definition.headerFormSurfaceId,
      buffer.header,
      definition.headerFields,
      scope,
      frozen,
    );
    const lines = await Promise.all(
      buffer.lines.map(
        async (
          line,
          index,
        ) => `<fieldset data-draft-line="${h(line.id)}"><legend>Line ${index + 1}${line.removed ? ' · removed' : ''}</legend>
    ${line.removed ? '<p>Pending governed archive</p>' : ''}<div class="form-fields">${await fieldsHtml(view, gateways, surfaces, definition.lineFormSurfaceId, line.removed && line.record ? { ...line, values: { ...line.record.values } } : line, definition.lineFields, scope, frozen || line.removed)}</div>
    ${!frozen && !line.removed ? `<button form="draft-editor-form" class="secondary-action" name="draftAction" value="remove:${h(line.id)}" formnovalidate>Remove line ${index + 1}</button>` : ''}</fieldset>`,
      ),
    );
    const steps = buffer.pending
      ? `<ol data-save-progress>${buffer.pending.map((step) => `<li>${h(step.label)} · ${step.done ? 'committed' : 'pending'}</li>`).join('')}</ol>`
      : '';
    const commands = buffer.pending
      ? `<button form="draft-editor-form" name="draftAction" value="${buffer.pending.some((step) => step.grant && !step.done) ? 'confirm' : 'retry'}">${buffer.pending.some((step) => step.grant && !step.done) ? 'Confirm removal and save' : 'Retry save'}</button>`
      : '<button form="draft-editor-form" name="draftAction" value="save">Save draft</button>';
    return {
      statusCode,
      html: '',
      ...(current ? { record: current } : {}),
      slots: {
        titleStatus: `<header class="surface-heading surface-heading--slot"><h1>${current ? 'Edit' : 'New'} ${h(recordSurface.label.replace(/ detail$/i, ''))}</h1><span class="status-pill" data-status-role="inProgress">Draft</span></header>`,
        keyFacts: `<section class="panel">${buffer.notice}${steps}<form id="draft-editor-form" method="post" action="${h(action.pathname + action.search)}" data-document-editor>
      <input type="hidden" name="draftSession" value="${h(buffer.id)}"><input type="hidden" name="draftVersion" value="${buffer.version}">
      <fieldset><legend>${h(definition.headerLabel ?? 'Document details')}</legend><div class="form-fields">${header}</div></fieldset></form></section>`,
        sections: `<section class="panel" aria-label="${h(definition.linesLabel ?? 'Lines')}"><div class="panel__heading"><h2>${h(definition.linesLabel ?? 'Lines')}</h2>${!frozen ? '<button form="draft-editor-form" class="secondary-action" name="draftAction" value="add" formnovalidate>Add line</button>' : ''}</div>${lines.join('')}</section>`,
        commandBar: `<section class="panel"><div class="command-bar"><p data-save-boundary>${h(definition.saveDescription ?? 'Save commits this document and each line in sequence.')}</p>${commands}</div></section>`,
      },
    };
  } catch (error) {
    const redacted = redactAcknowledgedReadFailure(buffer);
    if (redacted) return redacted;
    throw error;
  }
}

function acknowledge(
  buffer: Buffer,
  step: SaveStep,
  receipt: SemanticOperationResultEnvelope['trust'],
) {
  if (buffer.acknowledged.some((value) => value.key === step.key)) return;
  buffer.acknowledged.push({
    key: step.key,
    receipt,
  });
}

function reconcileCompletedRemovals(
  buffer: Buffer,
  completed: readonly SaveStep[],
) {
  const archived = new Set(
    completed
      .filter((step) => step.operation.intent === 'archive')
      .map((step) => step.row.id),
  );
  if (archived.size > 0)
    buffer.lines = buffer.lines.filter((line) => !archived.has(line.id));
}
function capture(
  row: DraftRow,
  fields: SurfaceDocumentEditor['headerFields'],
  submission: SurfaceRuntimeSubmission,
) {
  for (const field of fields) {
    const value = submission[inputName(row, field.fieldId)];
    if (value !== undefined)
      row.values[field.fieldId] = value === '' ? null : value;
  }
}
function plan(
  view: RequestRuntimeView,
  surfaces: readonly CompiledSurfaceDefinition[],
  buffer: Buffer,
): SaveStep[] {
  const definition = buffer.definition;
  const steps: SaveStep[] = [];
  const append = (
    row: DraftRow,
    surfaceId: string,
    fields: SurfaceDocumentEditor['headerFields'],
    label: string,
  ) => {
    const operation = operationFor(
      view,
      surfaceFor(surfaces, surfaceId),
      row.removed ? 'archive' : row.record ? 'update' : 'create',
    );
    const allowed = new Map(
      operation.inputFields?.map((field) => [field.fieldId, field]),
    );
    const values: Values = {};
    for (const field of row.removed ? [] : fields) {
      if (!allowed.has(field.fieldId))
        throw new Error('Editor field unavailable');
      let value = row.values[field.fieldId] ?? null;
      if (allowed.get(field.fieldId)!.required && value === null)
        throw new Error('Required editor field absent');
      const temporal = allowed.get(field.fieldId)!.temporal;
      if (
        typeof value === 'string' &&
        temporal?.timezoneSemantics === 'utcInstant'
      ) {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) value += ':00';
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))
          value += temporal.precision === 'millisecond' ? '.000Z' : 'Z';
      }
      values[field.fieldId] = value;
    }
    const input: Values = row.record
      ? {
          recordId: row.id,
          expectedRevision: row.record.revision,
          ...(row.removed ? {} : { patch: values }),
        }
      : {
          recordId: row.id,
          values,
          ...(operation.systemInputArgumentKey
            ? { [operation.systemInputArgumentKey]: buffer.scope }
            : {}),
          ...(row !== buffer.header
            ? { relations: { [definition.parentRelationId]: buffer.header.id } }
            : {}),
        };
    if (
      row.record &&
      !row.removed &&
      fields.every(
        (field) => row.record!.values[field.fieldId] === values[field.fieldId],
      )
    )
      return;
    steps.push({
      label,
      operation,
      input,
      key: randomUUID(),
      grant: null,
      row,
      done: false,
    });
  };
  append(
    buffer.header,
    definition.headerFormSurfaceId,
    definition.headerFields,
    'Order details',
  );
  let number = Math.max(
    0,
    ...buffer.lines.map((value) =>
      Number(value.record?.values[definition.lineNumberFieldId] ?? 0),
    ),
  );
  for (const [index, line] of buffer.lines.entries()) {
    if (line.removed && !line.record) continue;
    if (!line.record)
      line.values[definition.lineNumberFieldId] = String(++number);
    append(
      line,
      definition.lineFormSurfaceId,
      [
        ...definition.lineFields,
        { fieldId: definition.lineNumberFieldId, label: 'Line number' },
      ],
      `Line ${index + 1}${line.removed ? ' removal' : ''}`,
    );
  }
  return steps;
}
async function fieldsHtml(
  view: RequestRuntimeView,
  gateways: SurfaceRuntimeGateways,
  surfaces: readonly CompiledSurfaceDefinition[],
  surfaceId: string,
  row: DraftRow,
  fields: SurfaceDocumentEditor['headerFields'],
  scope: string,
  frozen: boolean,
) {
  const operation = operationFor(
    view,
    surfaceFor(surfaces, surfaceId),
    'create',
  );
  return (
    await Promise.all(
      fields.map(async (field) => {
        const input = operation.inputFields?.find(
          (value) => value.fieldId === field.fieldId,
        );
        if (!input) throw new Error('Editor field unavailable');
        let value = string(row.values[field.fieldId]);
        const attrs = `form="draft-editor-form" name="${h(inputName(row, field.fieldId))}" ${input.required ? 'required' : ''} ${frozen ? 'disabled' : ''}`;
        let control: string;
        if (field.reference) {
          const records = await workspaceList(
            view,
            gateways.queryGateway,
            field.reference.queryId,
            scope,
          );
          control = `<select ${attrs}><option value="">Select ${h(field.label.toLowerCase())}</option>${records
            .map((record) => {
              const labels = field
                .reference!.labelFieldIds.map((id) => record.values[id])
                .filter((label) => typeof label === 'string' && label.trim());
              if (!labels.length) return '';
              return `<option value="${h(record.recordId)}"${value === record.recordId ? ' selected' : ''}>${h(labels.join(' · '))}</option>`;
            })
            .join('')}</select>`;
        } else {
          const dateTime =
            input.kind === 'dateTimeFieldType' &&
            input.temporal?.timezoneSemantics === 'utcInstant';
          if (dateTime && value.endsWith('Z')) value = value.slice(0, 19);
          control = `<input type="${dateTime ? 'datetime-local' : input.kind === 'dateFieldType' ? 'date' : 'text'}" ${attrs} value="${h(value)}" ${dateTime ? 'step="1"' : ''} ${['quantityFieldType', 'exactDecimalFieldType'].includes(input.kind) ? 'inputmode="decimal"' : ''}>`;
        }
        return `<label>${h(field.label)}${input.temporal?.timezoneSemantics === 'utcInstant' ? ' (UTC)' : ''}${input.required ? ' *' : ''}${control}</label>`;
      }),
    )
  ).join('');
}
