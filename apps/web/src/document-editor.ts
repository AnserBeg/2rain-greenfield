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
import type {
  SurfaceDocumentEditor,
  SurfaceEditorCreate as CreateFlow,
} from '../../../packages/canonical-model/src/schemas.js';
import {
  readCompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceField,
  type CompiledSurfaceInputField,
  type CompiledSurfaceOperationBinding,
} from './surface-contract.js';
import type {
  SurfaceRuntimeGateways,
  SurfaceRuntimeSubmission,
} from './surface-runtime.js';
import {
  resolveWorkspaceEntry,
  workspaceGet,
  workspaceList,
  workspacePrincipalKey,
  workspaceSearch,
} from './workspace-entry.js';
import {
  DECIMAL_KINDS,
  admitsChoice,
  canonicalDecimal,
  choiceAdmits,
  controlId,
  decimalProblem,
  declaredDefault,
  referenceKey,
  renderCreatePanel,
  renderReferenceControl,
  renderValueControl,
  sameValue,
  type CreateTask,
  type LookupState,
  type ReferenceLookup,
} from './editor-controls.js';
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
  /** Search results per row and field, bound to this buffer's principal and scope. */
  lookups: Map<string, LookupState>;
  /** At most one in-context create; the draft pauses while it is open. */
  create: CreateTask | null;
  /** The control to focus after the next render, such as a field a create returned to. */
  focus: string | null;
  /** Save-time problems by control id, shown beside each control until the next action. */
  errors: Map<string, string>;
};
const buffers = new Map<string, Buffer>();
const expiry = 60 * 60 * 1000;
/** Pages a field's search may accumulate; each is re-read on every response. */
const maximumLookupPages = 10;
/** A catalog message; the eyebrow names the action it answers, Save by default. */
const warning = (ref: SurfaceMessageRef, action = 'Save') =>
  `<div role="alert" ${messageAttributes(ref)}>${messageBody(ref, action, 'h2')}</div>`;
const editable = (
  definition: SurfaceDocumentEditor,
  record: SemanticRecordDto,
) =>
  definition.editableStateIds.some(
    (value) => value === record.values[definition.stateFieldId],
  );
const inputName = (row: DraftRow, field: string) => `draft:${row.id}:${field}`;

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
/**
 * A never-saved row takes each field's DECLARED default. A persisted row keeps
 * whatever it stores, including a value outside a choice set, so a default can
 * never overwrite existing data during an unrelated edit.
 */
const withDefaults = (
  draft: DraftRow,
  fields: SurfaceDocumentEditor['headerFields'],
): DraftRow => {
  if (draft.record) return draft;
  for (const field of fields) {
    const fallback = declaredDefault(field);
    if (fallback !== undefined && draft.values[field.fieldId] === undefined)
      draft.values[field.fieldId] = fallback;
  }
  return draft;
};
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
      header: withDefaults(row(current), definition.headerFields),
      lines: [],
      pending: null,
      acknowledged: [],
      busy: false,
      version: 0,
      touched: performance.now(),
      notice: '',
      withheld: 'none',
      lookups: new Map(),
      create: null,
      focus: null,
      errors: new Map(),
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
    else buffer.lines.push(withDefaults(row(), definition.lineFields));
    buffers.set(buffer.id, buffer);
  }
  const rowsOf = (fieldId: string) =>
    definition.headerFields.some((value) => value.fieldId === fieldId)
      ? { rows: [buffer.header], fields: definition.headerFields }
      : { rows: buffer.lines, fields: definition.lineFields };
  const findRow = (rowId: string) =>
    buffer.header.id === rowId
      ? buffer.header
      : buffer.lines.find((value) => value.id === rowId && !value.removed);
  /**
   * Re-reads the record a reference now selects and updates every field derived
   * from it. The read is the declared exact get; if it is refused the dependent
   * is cleared rather than left describing the previous record.
   */
  const derive = async (rowId: string, referenceFieldId: string) => {
    const { fields } = rowsOf(referenceFieldId);
    const draft = findRow(rowId);
    const source = fields.find((value) => value.fieldId === referenceFieldId);
    const dependents = fields.filter(
      (value) =>
        value.presentation?.kind === 'derived' &&
        value.presentation.referenceFieldId === referenceFieldId,
    );
    if (!draft || !dependents.length || !source?.reference?.getQueryId) return;
    const selected = draft.values[referenceFieldId];
    let record: SemanticRecordDto | null = null;
    if (typeof selected === 'string' && selected)
      try {
        record = await workspaceGet(
          view,
          gateways.queryGateway,
          source.reference.getQueryId,
          scope,
          selected,
        );
      } catch {
        record = null;
      }
    for (const dependent of dependents) {
      if (dependent.presentation?.kind !== 'derived') continue;
      const value = record?.values[dependent.presentation.sourceFieldId];
      draft.values[dependent.fieldId] =
        typeof value === 'string' && value ? value : null;
    }
  };
  /**
   * A create flow is offered when every step is a bound create in the pinned
   * release and none needs a human confirmation grant. This is availability,
   * not authority: the operation gateway still decides each step at invoke time
   * against the submitted values, and a refusal is reported without a write.
   */
  const createOffered = (create: CreateFlow) =>
    create.steps.every((step) => {
      const operation = operationById(view, surfaces, step.operationId);
      return (
        operation?.intent === 'create' &&
        operation.confirmation !== 'humanRequired'
      );
    });
  const referenceFields = [
    ...definition.headerFields,
    ...definition.lineFields,
  ].filter((field) => field.reference);
  /**
   * Lookup results read in THIS request. An action's read is reused by the
   * render that follows it; a later request reads again under its own current
   * authority, so a withdrawn read discloses nothing from earlier responses.
   */
  const lookupReads = new Map<string, ReferenceLookup>();
  const readLookup = async (
    field: SurfaceDocumentEditor['headerFields'][number],
    key: string,
  ): Promise<ReferenceLookup | null> => {
    const known = lookupReads.get(key);
    if (known) return known;
    const state = buffer.lookups.get(key);
    if (!state || !field.reference) return null;
    const records: SemanticRecordDto[] = [];
    let cursor: string | null = null;
    let hasMore = false;
    for (let page = 0; page < state.pages; page++) {
      const result = await workspaceSearch(
        view,
        gateways.queryGateway,
        field.reference.queryId,
        scope,
        state.term,
        cursor,
      );
      records.push(...result.records);
      cursor = result.nextCursor;
      hasMore = result.hasMore && cursor !== null;
      if (!hasMore) {
        state.pages = page + 1;
        break;
      }
    }
    const lookup = {
      term: state.term,
      records,
      hasMore: hasMore && state.pages < maximumLookupPages,
      nextCursor: cursor,
    };
    state.offered = new Set(records.map((record) => record.recordId));
    lookupReads.set(key, lookup);
    return lookup;
  };
  /** A lookup that cannot be read now is dropped, never shown from before. */
  const dropLookup = (key: string) => {
    buffer.lookups.delete(key);
    lookupReads.delete(key);
  };
  const parseReferenceAction = (value: string | undefined) => {
    const match =
      /^(search|more|select|clear|create):([0-9a-f-]{36}):(.+)$/u.exec(
        value ?? '',
      );
    if (!match) return null;
    const [, verb, rowId, rest] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    for (const field of referenceFields) {
      if (rest === field.fieldId)
        return { verb, rowId, field, recordId: null as string | null };
      if (verb === 'select' && rest.startsWith(`${field.fieldId}:`))
        return {
          verb,
          rowId,
          field,
          recordId: rest.slice(field.fieldId.length + 1),
        };
    }
    return null;
  };
  /** The create operation's declared inputs for one of the editor's surfaces. */
  const inputsOf = (surfaceId: string) =>
    new Map(
      (
        operationFor(view, surfaceFor(surfaces, surfaceId), 'create')
          .inputFields ?? []
      ).map((value) => [value.fieldId, value]),
    );
  /**
   * Required values still empty and decimals the contract cannot hold, named
   * the way the editor labels them. Save reports these together, beside each
   * control, before any step commits -- rather than committing the header and
   * then having the provider refuse a line.
   */
  const problems = () => {
    const found: { label: string; control: string; message: string }[] = [];
    const check = (
      draft: DraftRow,
      fields: SurfaceDocumentEditor['headerFields'],
      surfaceId: string,
      prefix: string,
    ) => {
      const inputs = inputsOf(surfaceId);
      for (const field of fields) {
        const input = inputs.get(field.fieldId);
        const value = draft.values[field.fieldId];
        const label = prefix
          ? `${prefix} ${field.label.toLowerCase()}`
          : field.label;
        const control = controlId(draft.id, field.fieldId);
        if ((value ?? '') === '') {
          if (!input?.required) continue;
          // A derived value follows its reference; the empty reference is named.
          if (
            field.presentation?.kind === 'derived' &&
            (draft.values[field.presentation.referenceFieldId] ?? '') === ''
          )
            continue;
          found.push({
            label,
            control,
            message: field.reference
              ? `Select a ${field.label.toLowerCase()}.`
              : 'Required.',
          });
        } else if (
          input &&
          DECIMAL_KINDS.includes(input.kind) &&
          typeof value === 'string'
        ) {
          const message = decimalProblem(value, input);
          if (message) found.push({ label, control, message });
        }
      }
    };
    check(
      buffer.header,
      definition.headerFields,
      definition.headerFormSurfaceId,
      '',
    );
    for (const [index, line] of buffer.lines.entries())
      if (!line.removed)
        check(
          line,
          definition.lineFields,
          definition.lineFormSurfaceId,
          `Line ${index + 1}`,
        );
    return found;
  };
  const invalidTarget = () => {
    buffer.notice = warning({ code: 'OPERATION_INPUT_INVALID' });
    statusCode = 422;
  };
  /** Search, page, select, clear or open create for one row's reference field. */
  const referenceAction = async (value: string | undefined) => {
    const parsed = parseReferenceAction(value);
    if (!parsed) return false;
    const { verb, rowId, field, recordId } = parsed;
    const draft = findRow(rowId);
    const { rows, fields } = rowsOf(field.fieldId);
    // The row and field must belong together; a header field cannot be aimed at
    // a line, and a removed or foreign row is refused rather than re-targeted.
    if (!draft || !rows.includes(draft) || !fields.includes(field)) {
      invalidTarget();
      return true;
    }
    const reference = field.reference!;
    const key = referenceKey(rowId, field.fieldId);
    if (verb === 'search' || verb === 'more') {
      if (verb === 'search')
        buffer.lookups.set(key, {
          term: (submission?.[`draftSearch:${rowId}:${field.fieldId}`] ?? '')
            .trim()
            .slice(0, 240),
          pages: 1,
          offered: new Set(),
        });
      else {
        const state = buffer.lookups.get(key);
        if (!state) {
          invalidTarget();
          return true;
        }
        state.pages = Math.min(state.pages + 1, maximumLookupPages);
      }
      lookupReads.delete(key);
      try {
        await readLookup(field, key);
      } catch (error) {
        // A failed search shows no earlier results beside its notice.
        dropLookup(key);
        buffer.notice = warning(operationMessageRef(error), field.label);
        statusCode = 422;
      }
      buffer.focus = `${controlId(rowId, field.fieldId)}-results`;
      return true;
    }
    if (verb === 'select') {
      // Only a record this field's own search offered, re-read through the exact
      // get so the selection is one the principal can currently read.
      if (!recordId || !buffer.lookups.get(key)?.offered.has(recordId)) {
        invalidTarget();
        return true;
      }
      try {
        const record = reference.getQueryId
          ? await workspaceGet(
              view,
              gateways.queryGateway,
              reference.getQueryId,
              scope,
              recordId,
            )
          : null;
        if (!record) {
          buffer.notice = warning(
            { code: 'OPERATION_INPUT_INVALID' },
            field.label,
          );
          statusCode = 422;
          return true;
        }
        draft.values[field.fieldId] = record.recordId;
        buffer.lookups.delete(key);
        await derive(rowId, field.fieldId);
        buffer.focus = controlId(rowId, field.fieldId);
      } catch (error) {
        buffer.notice = warning(operationMessageRef(error), field.label);
        statusCode = 422;
      }
      return true;
    }
    if (verb === 'clear') {
      draft.values[field.fieldId] = null;
      buffer.lookups.delete(key);
      await derive(rowId, field.fieldId);
      buffer.focus = controlId(rowId, field.fieldId);
      return true;
    }
    const create = reference.create;
    if (!create || !createOffered(create)) {
      invalidTarget();
      return true;
    }
    // A name typed into the search box carries into the create form's label
    // field, so an operator does not retype what they were looking for.
    const typed = (
      submission?.[`draftSearch:${rowId}:${field.fieldId}`] ??
      buffer.lookups.get(key)?.term ??
      ''
    ).trim();
    // A fresh flow takes each collected field's declared default, once. The
    // typed search term fills the label field only where that field admits it.
    const values: Values = {};
    for (const collected of create.fields) {
      const fallback = declaredDefault(collected);
      if (fallback !== undefined) values[collected.fieldId] = fallback;
    }
    const labelField = create.fields.find((collected) =>
      reference.labelFieldIds.includes(collected.fieldId),
    );
    if (labelField && typed && admitsChoice(labelField, typed))
      values[labelField.fieldId] = typed;
    buffer.create = {
      id: randomUUID(),
      rowId,
      fieldId: field.fieldId,
      openedValue: draft.values[field.fieldId] ?? null,
      values,
      steps: create.steps.map((step) => ({
        operationId: step.operationId,
        key: randomUUID(),
        recordId: randomUUID(),
        done: false,
      })),
      attempted: false,
      notice: '',
      errors: new Map(),
    };
    return true;
  };
  /**
   * Completes, retries or cancels the open create. Each step reuses the key and
   * record id minted when the flow opened, so a lost response replays instead of
   * creating a second master. Outcomes are reported as they are: a refusal
   * writes nothing further, a partial create is named as partial and not
   * selected, and a record that cannot be read back is not selected either.
   */
  const runCreate = async () => {
    const task = buffer.create;
    if (!task || task.id !== submission?.draftCreateTask) {
      invalidTarget();
      return;
    }
    const field = referenceFields.find(
      (value) => value.fieldId === task.fieldId,
    );
    const create = field?.reference?.create;
    const draft = findRow(task.rowId);
    if (!field?.reference || !create || !draft) {
      buffer.create = null;
      invalidTarget();
      return;
    }
    if (submission.draftCreate === 'cancel') {
      const committed = task.steps.some((step) => step.done);
      buffer.notice = committed
        ? `<div role="status" class="draft-note" data-editor-create-kept><p>${h(create.label)}: what was already created is kept and was not selected. Cancelling does not undo it.</p></div>`
        : '';
      buffer.create = null;
      buffer.focus = controlId(task.rowId, task.fieldId);
      return;
    }
    if (submission.draftCreate !== 'submit') {
      invalidTarget();
      return;
    }
    if (!task.attempted) {
      // Every collected value is admitted before the first step runs, so a
      // refused or missing value commits nothing, not even an earlier step.
      // Values freeze only once they are admitted and a step is attempted.
      const inputs = new Map(
        create.steps.flatMap((step) =>
          (
            operationById(view, surfaces, step.operationId)?.inputFields ?? []
          ).map((value) => [value.fieldId, value] as const),
        ),
      );
      task.errors = new Map();
      for (const collected of create.fields) {
        const submitted = submission[`create:${collected.fieldId}`];
        if (submitted !== undefined)
          task.values[collected.fieldId] =
            submitted.trim() === '' ? null : submitted;
        const value = task.values[collected.fieldId] ?? null;
        if (!admitsChoice(collected, typeof value === 'string' ? value : '')) {
          task.errors.set(
            collected.fieldId,
            'Choose one of the offered values.',
          );
          // The refused value is dropped, and the default is not reapplied:
          // the operator chooses again from the offered set.
          task.values[collected.fieldId] = null;
        } else if (value === null && inputs.get(collected.fieldId)?.required)
          task.errors.set(collected.fieldId, 'Required.');
      }
      if (task.errors.size) {
        const problems = create.fields.flatMap((collected) => {
          const message = task.errors.get(collected.fieldId);
          return message
            ? [
                `${collected.label}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`,
              ]
            : [];
        });
        task.notice = `<div role="alert" class="draft-note draft-note--problem" data-editor-create-problems><p>${h(`Nothing was created. ${problems.join(' ')}`)}</p></div>`;
        statusCode = 422;
        return;
      }
    }
    task.attempted = true;
    task.notice = '';
    for (const [index, step] of task.steps.entries()) {
      if (step.done) continue;
      const declared = create.steps[index]!;
      const operation = operationById(view, surfaces, step.operationId);
      if (!operation) {
        task.notice = warning(
          { code: 'OPERATION_INPUT_INVALID' },
          create.label,
        );
        statusCode = 422;
        return;
      }
      const accepted = new Set(
        (operation.inputFields ?? []).map((value) => value.fieldId),
      );
      const values: Values = {};
      for (const collected of create.fields) {
        const value = task.values[collected.fieldId];
        if (
          accepted.has(collected.fieldId) &&
          value !== null &&
          value !== undefined
        )
          values[collected.fieldId] = value;
      }
      for (const fixed of declared.fixed ?? [])
        values[fixed.fieldId] = fixed.value;
      const relations: Values = {};
      for (const bound of declared.relations ?? [])
        relations[bound.relationId] = task.steps[bound.step]!.recordId;
      try {
        const result = await gateways.operationGateway.invoke(
          view,
          {
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
            operationId: step.operationId,
            input: {
              recordId: step.recordId,
              values,
              ...(operation.systemInputArgumentKey
                ? { [operation.systemInputArgumentKey]: buffer.scope }
                : {}),
              ...(Object.keys(relations).length ? { relations } : {}),
            },
            idempotencyKey: step.key,
            confirmationGrant: null,
          },
          gateways.operationMediation.issueInvocation(view, 'UI'),
        );
        if (result.outcome !== 'succeeded')
          throw new Error('Create step returned non-success');
        step.done = true;
      } catch (error) {
        const done = task.steps.filter((value) => value.done).length;
        task.notice = `${warning(operationMessageRef(error), create.label)}${
          done
            ? `<p data-editor-create-partial>${done} of ${task.steps.length} create steps committed. The record is not ready and was not selected. Retry finishes it with the same request.</p>`
            : ''
        }`;
        statusCode = 422;
        return;
      }
    }
    const created = task.steps[create.selectStep]!.recordId;
    let record: SemanticRecordDto | null = null;
    try {
      record = field.reference.getQueryId
        ? await workspaceGet(
            view,
            gateways.queryGateway,
            field.reference.getQueryId,
            scope,
            created,
          )
        : null;
    } catch {
      record = null;
    }
    buffer.create = null;
    buffer.focus = controlId(task.rowId, task.fieldId);
    if (!record) {
      buffer.notice = `<div role="status" class="draft-note" data-editor-create-withheld><p>${h(create.label)} was created but cannot be read with your current access, so it was not selected.</p></div>`;
      return;
    }
    if ((draft.values[task.fieldId] ?? null) !== task.openedValue) {
      buffer.notice = `<div role="status" class="draft-note" data-editor-create-stale><p>${h(create.label)} was created, but this field changed meanwhile, so it was not selected.</p></div>`;
      return;
    }
    draft.values[task.fieldId] = record.recordId;
    buffer.lookups.delete(referenceKey(task.rowId, task.fieldId));
    await derive(task.rowId, task.fieldId);
    buffer.notice = `<div role="status" class="draft-note draft-note--done" data-editor-create-selected><p>${h(create.label)} created and selected. It is its own record; saving or discarding this order does not undo it.</p></div>`;
  };
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
      // A notice describes the action that produced it and is shown once; state
      // that must persist (save progress, withheld outcomes, the open create) is
      // rendered from the buffer itself on every request.
      buffer.notice = '';
      buffer.errors.clear();
      // A refused choice keeps the draft's previous value, so this action may
      // not go on to save a value other than the one the operator submitted.
      let refused = false;
      try {
        if (!buffer.pending && buffer.withheld === 'none' && !buffer.create) {
          const sources = referenceSources(definition);
          const before = snapshot(buffer, sources);
          const headerInputs = inputsOf(definition.headerFormSurfaceId);
          const lineInputs = inputsOf(definition.lineFormSurfaceId);
          const refusedLabels = [
            ...capture(
              buffer.header,
              definition.headerFields,
              headerInputs,
              submission,
            ),
          ];
          for (const line of buffer.lines)
            if (!line.removed)
              refusedLabels.push(
                ...capture(line, definition.lineFields, lineInputs, submission),
              );
          if (refusedLabels.length) {
            refused = true;
            buffer.notice = `<div role="alert" class="draft-note draft-note--problem" data-editor-refused><p>${h(
              [...new Set(refusedLabels)].join(', '),
            )}: choose one of the offered values.</p></div>`;
            statusCode = 422;
          }
          // A reference changed by the form itself -- not by select or create
          // -- is accepted only if the principal can read that exact record
          // now. The hidden input is a carrier, never an authority.
          for (const [key, value] of snapshot(buffer, sources)) {
            if (before.get(key) === value) continue;
            const [rowId, fieldId] = key.split('|') as [string, string];
            const draft = findRow(rowId)!;
            const field = rowsOf(fieldId).fields.find(
              (candidate) => candidate.fieldId === fieldId,
            )!;
            const getQueryId = field.reference?.getQueryId;
            if (getQueryId && typeof value === 'string' && value) {
              let readable = false;
              try {
                readable =
                  (await workspaceGet(
                    view,
                    gateways.queryGateway,
                    getQueryId,
                    scope,
                    value,
                  )) !== null;
              } catch {
                readable = false;
              }
              if (!readable) {
                draft.values[fieldId] = before.get(key) ?? null;
                refused = true;
                buffer.notice += `<div role="alert" class="draft-note draft-note--problem" data-editor-reference-refused><p>${h(field.label)}: choose a record from the search results.</p></div>`;
                statusCode = 422;
                continue;
              }
            }
            await derive(rowId, fieldId);
          }
        }
        if (
          !buffer.pending &&
          current &&
          buffer.header.record?.revision !== current.revision
        ) {
          buffer.notice = warning({ code: 'DRAFT_EDITOR_CONFLICT' });
          statusCode = 409;
        } else if (buffer.withheld === 'none') {
          if (submission.draftCreateTask !== undefined) {
            await runCreate();
          } else if (buffer.create) {
            // The order is paused while a create is open, so nothing reaching
            // it by another route -- another tab, a replayed form -- may change it.
            buffer.notice =
              '<div role="alert" class="draft-note draft-note--problem" data-editor-paused><p>Finish or cancel the new record first. The order is kept as it was.</p></div>';
            statusCode = 409;
          } else if (!buffer.pending) {
            if (await referenceAction(submission.draftAction)) {
              // A reference action has already captured the whole draft and
              // changed only its own field.
            } else if (
              submission.draftAction === 'add' &&
              buffer.lines.length < 40
            ) {
              const added = withDefaults(row(), definition.lineFields);
              buffer.lines.push(added);
              const first = definition.lineFields[0];
              if (first) buffer.focus = controlId(added.id, first.fieldId);
            } else if (submission.draftAction?.startsWith('remove:')) {
              const line = buffer.lines.find(
                (value) => value.id === submission.draftAction!.slice(7),
              );
              if (line?.record) line.removed = true;
              else if (line)
                buffer.lines = buffer.lines.filter((value) => value !== line);
            } else if (submission.draftAction === 'save' && !refused) {
              const found = problems();
              if (found.length) {
                for (const problem of found)
                  buffer.errors.set(problem.control, problem.message);
                buffer.notice = `<div role="alert" class="draft-note draft-note--problem" data-editor-problems><p>Nothing was saved. Correct ${found.length === 1 ? 'this field' : `these ${found.length} fields`} first: ${h(
                  found.map((value) => value.label).join(', '),
                )}.</p></div>`;
                buffer.focus = found[0]!.control;
                statusCode = 422;
              } else buffer.pending = plan(view, surfaces, buffer);
            }
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
    // While a create is open the order is paused: shown, but not editable, so
    // nothing entered before leaving it can change until the create returns.
    const paused = buffer.create !== null;
    const frozen =
      buffer.pending !== null || buffer.withheld !== 'none' || paused;
    const focus = buffer.focus;
    buffer.focus = null;
    const shapes = new Map<
      string,
      {
        compiled: Map<string, CompiledSurfaceField>;
        inputs: Map<string, CompiledSurfaceInputField>;
      }
    >();
    const shape = (surfaceId: string) => {
      let known = shapes.get(surfaceId);
      if (!known) {
        const target = surfaceFor(surfaces, surfaceId);
        const operation = operationFor(view, target, 'create');
        known = {
          compiled: new Map(
            (target.fields ?? []).map((value) => [value.fieldId, value]),
          ),
          inputs: new Map(
            (operation.inputFields ?? []).map((value) => [
              value.fieldId,
              value,
            ]),
          ),
        };
        shapes.set(surfaceId, known);
      }
      return known;
    };
    // One exact read per selected record per render, however many lines share it.
    const reads = new Map<string, Promise<SemanticRecordDto | null>>();
    const selectedFor = (
      field: SurfaceDocumentEditor['headerFields'][number],
      draft: DraftRow,
    ) => {
      const value = draft.values[field.fieldId];
      const getQueryId = field.reference?.getQueryId;
      if (typeof value !== 'string' || !value || !getQueryId)
        return Promise.resolve(null);
      const key = `${getQueryId}|${value}`;
      let read = reads.get(key);
      if (!read) {
        read = workspaceGet(
          view,
          gateways.queryGateway,
          getQueryId,
          scope,
          value,
        ).catch(() => null);
        reads.set(key, read);
      }
      return read;
    };
    const control = async (
      surfaceId: string,
      draft: DraftRow,
      field: SurfaceDocumentEditor['headerFields'][number],
      index: number,
      locked: boolean,
      accessibleName: string | null,
    ) => {
      const { compiled, inputs } = shape(surfaceId);
      const input = inputs.get(field.fieldId);
      if (!input) throw new Error('Editor field unavailable');
      const base = {
        row: draft,
        field,
        compiled: compiled.get(field.fieldId),
        input,
        frozen: locked,
        index,
        accessibleName,
        focus,
        error: buffer.errors.get(controlId(draft.id, field.fieldId)) ?? null,
      };
      if (field.reference?.getQueryId) {
        // Results are shown only as read in this request, under its authority.
        const key = referenceKey(draft.id, field.fieldId);
        let lookup: ReferenceLookup | null = null;
        if (!locked && buffer.lookups.has(key))
          try {
            lookup = await readLookup(field, key);
          } catch (error) {
            dropLookup(key);
            buffer.notice += warning(operationMessageRef(error), field.label);
          }
        return renderReferenceControl({
          ...base,
          selected: await selectedFor(field, draft),
          lookup,
          createOffered:
            !!field.reference.create && createOffered(field.reference.create),
          noun: field.label,
        });
      }
      if (field.reference) return legacyReference(draft, field, locked);
      return renderValueControl(base);
    };
    /**
     * An older release in the lineage may declare a reference without an exact
     * get. It keeps the behaviour it was released with rather than failing, so
     * a rollback still renders; every current declaration uses the picker.
     */
    const legacyReference = async (
      draft: DraftRow,
      field: SurfaceDocumentEditor['headerFields'][number],
      locked: boolean,
    ) => {
      const value = draft.values[field.fieldId];
      const records = await workspaceList(
        view,
        gateways.queryGateway,
        field.reference!.queryId,
        scope,
      );
      return `<select form="draft-editor-form" name="${h(inputName(draft, field.fieldId))}"${locked ? ' disabled' : ''}><option value="">Select ${h(field.label.toLowerCase())}</option>${records
        .map((record) => {
          const label = field
            .reference!.labelFieldIds.map((id) => record.values[id])
            .filter((part) => typeof part === 'string' && part.trim())
            .join(' · ');
          return label
            ? `<option value="${h(record.recordId)}"${value === record.recordId ? ' selected' : ''}>${h(label)}</option>`
            : '';
        })
        .join('')}</select>`;
    };
    const required = (surfaceId: string, fieldId: string) =>
      shape(surfaceId).inputs.get(fieldId)?.required ? ' *' : '';
    const header = (
      await Promise.all(
        definition.headerFields.map(async (field, index) => {
          const html = await control(
            definition.headerFormSurfaceId,
            buffer.header,
            field,
            index,
            frozen,
            null,
          );
          const label = `${h(field.label)}${
            field.presentation?.kind !== 'derived' &&
            shape(definition.headerFormSurfaceId).inputs.get(field.fieldId)
              ?.temporal?.timezoneSemantics === 'utcInstant'
              ? ' (UTC)'
              : ''
          }${required(definition.headerFormSurfaceId, field.fieldId)}`;
          const wide =
            field.presentation?.kind === 'multiline' ? ' form-field--wide' : '';
          return field.reference
            ? `<div class="form-field form-field--reference${wide}" role="group" aria-labelledby="${h(controlId(buffer.header.id, field.fieldId))}-label"><span class="form-field__label" id="${h(controlId(buffer.header.id, field.fieldId))}-label">${label}</span>${html}</div>`
            : `<label class="form-field${wide}" for="${h(controlId(buffer.header.id, field.fieldId))}"><span class="form-field__label">${label}</span>${html}</label>`;
        }),
      )
    ).join('');
    // One aligned row per line under shared column headings. Each control keeps
    // an accessible name of its own ("Line 2 quantity"), so the headings are a
    // visual aid, never the only label.
    const lineRows = await Promise.all(
      buffer.lines.map(async (line, index) => {
        const number = index + 1;
        if (line.removed)
          return `<tr data-draft-line="${h(line.id)}" class="draft-line draft-line--removed"><td colspan="${definition.lineFields.length + 1}">Line ${number} · removed · pending governed archive</td></tr>`;
        const cells = await Promise.all(
          definition.lineFields.map(async (field, position) => {
            const html = await control(
              definition.lineFormSurfaceId,
              line,
              field,
              index * 100 + position,
              frozen,
              `Line ${number} ${field.label.toLowerCase()}`,
            );
            return `<td data-label="${h(field.label)}" class="draft-line__cell draft-line__cell--${field.reference ? 'reference' : field.presentation?.kind === 'derived' ? 'derived' : 'value'}">${html}</td>`;
          }),
        );
        const remove = frozen
          ? ''
          : `<button form="draft-editor-form" class="link-action draft-line__remove" name="draftAction" value="remove:${h(line.id)}" formnovalidate aria-label="Remove line ${number}">Remove</button>`;
        return `<tr data-draft-line="${h(line.id)}" class="draft-line">${cells.join('')}<td class="draft-line__cell draft-line__cell--remove">${remove}</td></tr>`;
      }),
    );
    const lines = [
      `<table class="draft-lines form-fields"><thead><tr>${definition.lineFields
        .map(
          (field) =>
            `<th scope="col" class="draft-lines__heading draft-lines__heading--${field.reference ? 'reference' : field.presentation?.kind === 'derived' ? 'derived' : 'value'}">${h(field.label)}${field.presentation?.kind === 'derived' ? '' : required(definition.lineFormSurfaceId, field.fieldId)}</th>`,
        )
        .join(
          '',
        )}<th scope="col" class="draft-lines__heading--remove"><span class="sr-only">Remove</span></th></tr></thead><tbody>${lineRows.join('')}</tbody></table>`,
    ];
    const openCreate = buffer.create;
    const createField = openCreate
      ? [...definition.headerFields, ...definition.lineFields].find(
          (value) => value.fieldId === openCreate.fieldId,
        )
      : undefined;
    const createFlow = createField?.reference?.create;
    const createPanel =
      openCreate && createFlow
        ? renderCreatePanel({
            task: openCreate,
            create: createFlow,
            session: buffer.id,
            version: buffer.version,
            action: action.pathname + action.search,
            fieldInputs: new Map(
              createFlow.steps.flatMap((step) =>
                (
                  operationById(view, surfaces, step.operationId)
                    ?.inputFields ?? []
                ).map((value) => [value.fieldId, value] as const),
              ),
            ),
            compiledFields: new Map(),
          })
        : '';
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
        keyFacts: `${createPanel}<section class="panel">${buffer.notice}${
          paused
            ? '<p class="draft-paused" role="status">This order is paused while you create a record. Nothing you entered has changed.</p>'
            : ''
        }${steps}<form id="draft-editor-form" method="post" action="${h(action.pathname + action.search)}" data-document-editor>
      <button class="sr-only" name="draftAction" value="refresh" tabindex="-1" data-draft-default>Update draft</button>
      <input type="hidden" name="draftSession" value="${h(buffer.id)}"><input type="hidden" name="draftVersion" value="${buffer.version}">
      <fieldset><legend>${h(definition.headerLabel ?? 'Document details')}</legend><div class="form-fields draft-header">${header}</div></fieldset></form></section>`,
        sections: `<section class="panel draft-lines-panel" aria-label="${h(definition.linesLabel ?? 'Lines')}"><div class="panel__heading"><h2>${h(definition.linesLabel ?? 'Lines')}</h2>${!frozen ? '<button form="draft-editor-form" class="secondary-action" name="draftAction" value="add" formnovalidate>Add line</button>' : ''}</div>${lines.join('')}</section>`,
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
/**
 * Copies submitted values into the draft. A derived field is never read from the
 * form -- the server sets it from the selected record -- and a choice outside
 * the offered set (and not already stored) is refused rather than accepted, so
 * a stale or altered form cannot introduce a value the editor never offered.
 * Returns the labels of refused fields.
 */
function capture(
  row: DraftRow,
  fields: SurfaceDocumentEditor['headerFields'],
  inputs: ReadonlyMap<string, CompiledSurfaceInputField>,
  submission: SurfaceRuntimeSubmission,
): string[] {
  const refused: string[] = [];
  for (const field of fields) {
    if (field.presentation?.kind === 'derived') continue;
    const value = submission[inputName(row, field.fieldId)];
    if (value === undefined) continue;
    if (!choiceAdmits(field, row, value)) {
      refused.push(field.label);
      continue;
    }
    // A decimal is kept in canonical spelling when it is one; anything else is
    // kept exactly as typed so the operator sees it, and save refuses it.
    const kind = inputs.get(field.fieldId)?.kind ?? '';
    const decimal = DECIMAL_KINDS.includes(kind)
      ? canonicalDecimal(value)
      : null;
    row.values[field.fieldId] = value === '' ? null : (decimal ?? value);
  }
  return refused;
}
/**
 * The pinned binding of an operation, wherever a surface binds it. A create flow
 * names governed operations by id; this is how the editor finds each one's
 * declared input fields, system scope argument and confirmation policy.
 */
function operationById(
  view: RequestRuntimeView,
  surfaces: readonly CompiledSurfaceDefinition[],
  operationId: string,
): CompiledSurfaceOperationBinding | null {
  for (const candidate of surfaces) {
    let binding;
    try {
      binding = readCompiledSurfaceDataBinding(view, candidate);
    } catch {
      continue;
    }
    const operation = binding.operations.find(
      (value) => value.operationId === operationId,
    );
    if (operation) return operation;
  }
  return null;
}
/** Every reference field, per row list: each is verified and derived from. */
function referenceSources(definition: SurfaceDocumentEditor) {
  const sources = (fields: SurfaceDocumentEditor['headerFields']) =>
    new Set(
      fields.flatMap((field) => (field.reference ? [field.fieldId] : [])),
    );
  return {
    header: sources(definition.headerFields),
    lines: sources(definition.lineFields),
  };
}
function snapshot(
  buffer: Buffer,
  sources: ReturnType<typeof referenceSources>,
): Map<string, ImmutableJsonValue | undefined> {
  const values = new Map<string, ImmutableJsonValue | undefined>();
  for (const fieldId of sources.header)
    values.set(
      referenceKey(buffer.header.id, fieldId),
      buffer.header.values[fieldId],
    );
  for (const line of buffer.lines)
    if (!line.removed)
      for (const fieldId of sources.lines)
        values.set(referenceKey(line.id, fieldId), line.values[fieldId]);
  return values;
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
      if (
        typeof value === 'string' &&
        DECIMAL_KINDS.includes(allowed.get(field.fieldId)!.kind)
      )
        value = canonicalDecimal(value) ?? value;
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
      fields.every((field) =>
        sameValue(
          allowed.get(field.fieldId)!.kind,
          row.record!.values[field.fieldId],
          values[field.fieldId],
        ),
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
