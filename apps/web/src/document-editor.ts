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
  workspaceEligible,
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
  renderReferenceLookup,
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
  /** Highest lookup request number seen per row|field; a lower one is stale. */
  seqs: Map<string, number>;
  /** Selection generation per row|field; every change of selection bumps it. */
  generations: Map<string, number>;
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

type EditorResponse = {
  html: string;
  statusCode: number;
  location?: string;
  slots?: Record<string, string>;
  record?: SemanticRecordDto;
  /** An in-place answer for the owned script; absent on every page answer. */
  fragment?: true;
  /** The script must repeat the action as the ordinary full-page submit. */
  fallback?: true;
};

/**
 * One typed draft editor in existing Record slots, using only semantic
 * gateways. `fragment` answers one reference field in place for the owned
 * script (ADR-0036 behaviour 7): a lookup region, a field and its declared
 * dependents, or the create flow -- never the document. It shares every
 * binding, authority and continuation check with the page.
 */
export async function documentEditor(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  url: URL,
  scope: string,
  gateways: SurfaceRuntimeGateways,
  submission: SurfaceRuntimeSubmission | null = null,
  mode: 'page' | 'fragment' = 'page',
): Promise<EditorResponse | null> {
  const response = await editorResponse(
    view,
    surface,
    surfaces,
    url,
    scope,
    gateways,
    submission,
    mode,
  );
  // A fragment request is answered only by a fragment. Any other outcome -- an
  // expired or foreign session, a withheld or completed save, a locked or
  // unreadable document -- is repeated as the ordinary full-page submit,
  // which reports it under the page's own rules.
  if (mode === 'fragment' && (!response || !response.fragment))
    return { html: '', statusCode: 409, fallback: true };
  return response;
}

async function editorResponse(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  url: URL,
  scope: string,
  gateways: SurfaceRuntimeGateways,
  submission: SurfaceRuntimeSubmission | null,
  mode: 'page' | 'fragment',
): Promise<EditorResponse | null> {
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
      seqs: new Map(),
      generations: new Map(),
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
  const dependentsOf = (referenceFieldId: string) =>
    rowsOf(referenceFieldId).fields.filter(
      (value) =>
        value.presentation?.kind === 'derived' &&
        value.presentation.referenceFieldId === referenceFieldId,
    );
  /** Sets every field derived from a reference from the record it now selects. */
  const applyDerived = (
    draft: DraftRow,
    referenceFieldId: string,
    record: SemanticRecordDto | null,
  ) => {
    for (const dependent of dependentsOf(referenceFieldId)) {
      if (dependent.presentation?.kind !== 'derived') continue;
      const value = record?.values[dependent.presentation.sourceFieldId];
      draft.values[dependent.fieldId] =
        typeof value === 'string' && value ? value : null;
    }
  };
  const derive = async (rowId: string, referenceFieldId: string) => {
    const { fields } = rowsOf(referenceFieldId);
    const draft = findRow(rowId);
    const source = fields.find((value) => value.fieldId === referenceFieldId);
    if (
      !draft ||
      !dependentsOf(referenceFieldId).length ||
      !source?.reference?.getQueryId
    )
      return;
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
    applyDerived(draft, referenceFieldId, record);
  };
  /** Every change of a field's selection moves its generation on. */
  const nextGeneration = (key: string) =>
    buffer.generations.set(key, (buffer.generations.get(key) ?? 0) + 1);
  /**
   * A create flow is offered when every step is a bound create in the pinned
   * release, none needs a human confirmation grant, and current policy would
   * let this principal start every step -- asked through the gateway's
   * side-effect-free eligibility preview, never by trying a write. Eligibility
   * is not authority: the operation gateway still decides each step at invoke
   * time against the submitted values, and a refusal is reported without a
   * write. A preview that cannot be answered withholds the offer. Answers are
   * reused only within this request.
   */
  const eligibility = new Map<CreateFlow, Promise<boolean>>();
  const createOffered = (create: CreateFlow): Promise<boolean> => {
    let known = eligibility.get(create);
    if (!known) {
      const operations = create.steps.map((step) =>
        operationById(view, surfaces, step.operationId),
      );
      known = operations.every(
        (operation) =>
          operation?.intent === 'create' &&
          operation.confirmation !== 'humanRequired',
      )
        ? gateways.operationGateway
            .previewEligibility(
              view,
              operations.map((operation) => operation!.operationId),
              operations.some((operation) => operation!.systemInputArgumentKey)
                ? scope
                : null,
            )
            .then(
              (answer) => answer === 'eligible',
              () => false,
            )
        : Promise.resolve(false);
      eligibility.set(create, known);
    }
    return known;
  };
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
    // Query continuation and the display limit are separate facts: only this
    // request's authorized read says whether the query continues.
    let queryContinues = false;
    for (let page = 0; page < state.pages; page++) {
      const result = await workspaceSearch(
        view,
        gateways.queryGateway,
        field.reference.queryId,
        scope,
        state.term,
        cursor,
        field.reference.eligibility,
      );
      records.push(...result.records);
      cursor = result.nextCursor;
      queryContinues = result.hasMore && cursor !== null;
      if (!queryContinues) {
        state.pages = page + 1;
        break;
      }
    }
    const lookup = {
      term: state.term,
      records,
      queryContinues,
      displayLimitReached: state.pages >= maximumLookupPages,
      nextCursor: cursor,
    };
    state.offered = new Set(records.map((record) => record.recordId));
    lookupReads.set(key, lookup);
    return lookup;
  };
  /**
   * The exact read of a record this field may select now: readable through
   * the declared get AND, where the picker declares eligibility, still
   * eligible (for example still an active customer). `null` for either
   * failure; a denied or failed read throws.
   */
  const readSelectable = async (
    field: SurfaceDocumentEditor['headerFields'][number],
    recordId: string,
  ): Promise<SemanticRecordDto | null> => {
    const reference = field.reference!;
    if (!reference.getQueryId) return null;
    const record = await workspaceGet(
      view,
      gateways.queryGateway,
      reference.getQueryId,
      scope,
      recordId,
    );
    if (!record) return null;
    if (
      reference.eligibility &&
      !(await workspaceEligible(
        view,
        gateways.queryGateway,
        reference.eligibility,
        record.recordId,
      ))
    )
      return null;
    return record;
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
      if (!claimLookup(key, verb, rowId, field, nextSeq(key))) {
        invalidTarget();
        return true;
      }
      let lookup: ReferenceLookup | null = null;
      try {
        lookup = await readLookup(field, key);
      } catch (error) {
        // A failed search shows no earlier results beside its notice.
        dropLookup(key);
        buffer.notice = warning(operationMessageRef(error), field.label);
        statusCode = 422;
      }
      // At the display limit the next useful step is a narrower search, so the
      // search box takes focus; otherwise focus lands on the results.
      buffer.focus =
        lookup?.queryContinues && lookup.displayLimitReached
          ? controlId(rowId, field.fieldId)
          : `${controlId(rowId, field.fieldId)}-results`;
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
        const record = await readSelectable(field, recordId);
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
        applyDerived(draft, field.fieldId, record);
        nextGeneration(key);
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
      applyDerived(draft, field.fieldId, null);
      nextGeneration(key);
      buffer.focus = controlId(rowId, field.fieldId);
      return true;
    }
    const create = reference.create;
    if (!create || !(await createOffered(create))) {
      invalidTarget();
      return true;
    }
    openCreateTask(draft, field, create);
    return true;
  };
  /**
   * Opens the field's governed create flow. A name typed into the search box
   * carries into the create form's label field, so an operator does not retype
   * what they were looking for; each collected field takes its declared
   * default once. Keys and record ids are minted here and never again.
   */
  const openCreateTask = (
    draft: DraftRow,
    field: SurfaceDocumentEditor['headerFields'][number],
    create: CreateFlow,
  ) => {
    const reference = field.reference!;
    const typed = (
      submission?.[`draftSearch:${draft.id}:${field.fieldId}`] ??
      buffer.lookups.get(referenceKey(draft.id, field.fieldId))?.term ??
      ''
    ).trim();
    const values: Values = {};
    for (const collected of create.fields) {
      const fallback = declaredDefault(collected);
      if (fallback !== undefined) values[collected.fieldId] = fallback;
    }
    const labelField = create.fields.find((collected) =>
      reference.labelFieldIds.includes(collected.fieldId),
    );
    // The typed term fills the label field only where that field admits it.
    if (labelField && typed && admitsChoice(labelField, typed))
      values[labelField.fieldId] = typed;
    buffer.create = {
      id: randomUUID(),
      rowId: draft.id,
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
      denied: false,
      busy: false,
    };
  };
  /** The next lookup request number for a field whose request carries none. */
  const nextSeq = (key: string) => (buffer.seqs.get(key) ?? 0) + 1;
  /**
   * Records a search or More as the field's newest request and resets what
   * this request will read. The previous offered set stays until this read
   * completes, so an answer to an older request can never be selected from
   * after a newer one was asked. `false` for a More with nothing to continue.
   */
  const claimLookup = (
    key: string,
    verb: string,
    rowId: string,
    field: SurfaceDocumentEditor['headerFields'][number],
    seq: number,
  ) => {
    const previous = buffer.lookups.get(key);
    if (verb === 'more' && !previous) return false;
    buffer.seqs.set(key, seq);
    buffer.lookups.set(
      key,
      verb === 'search'
        ? {
            term: (submission?.[`draftSearch:${rowId}:${field.fieldId}`] ?? '')
              .trim()
              .slice(0, 240),
            pages: 1,
            offered: new Set(),
            seq,
          }
        : {
            term: previous!.term,
            pages: Math.min(previous!.pages + 1, maximumLookupPages),
            offered: previous!.offered,
            seq,
          },
    );
    lookupReads.delete(key);
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
        const ref = operationMessageRef(error);
        // Current policy refused this step: a retry of the same request cannot
        // succeed, so the flow stops offering one.
        task.denied = ref.code === 'OPERATION_PERMISSION_DENIED';
        task.notice = `${warning(ref, create.label)}${
          done
            ? `<p data-editor-create-partial>${done} of ${task.steps.length} create steps committed. The record is not ready and was not selected.${task.denied ? '' : ' Retry finishes it with the same request.'}</p>`
            : ''
        }`;
        statusCode = 422;
        return;
      }
    }
    const created = task.steps[create.selectStep]!.recordId;
    let record: SemanticRecordDto | null = null;
    try {
      record = await readSelectable(field, created);
    } catch {
      record = null;
    }
    buffer.create = null;
    buffer.focus = controlId(task.rowId, task.fieldId);
    if (!record) {
      buffer.notice = `<div role="status" class="draft-note" data-editor-create-withheld><p>${h(create.label)} was created but cannot be selected with your current access, so it was not selected.</p></div>`;
      return;
    }
    if ((draft.values[task.fieldId] ?? null) !== task.openedValue) {
      buffer.notice = `<div role="status" class="draft-note" data-editor-create-stale><p>${h(create.label)} was created, but this field changed meanwhile, so it was not selected.</p></div>`;
      return;
    }
    draft.values[task.fieldId] = record.recordId;
    buffer.lookups.delete(referenceKey(task.rowId, task.fieldId));
    applyDerived(draft, task.fieldId, record);
    nextGeneration(referenceKey(task.rowId, task.fieldId));
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
  /**
   * After partial creation the URL owns the committed parent, so retries
   * cannot silently retarget or recreate it. Every form and fragment of this
   * buffer posts to that exact context.
   */
  const formAction = () => {
    const action = new URL(url);
    if (buffer.recordId) action.searchParams.set('record', buffer.recordId);
    const scopeQuery = readCompiledSurfaceDataBinding(view, surface).query
      .legalEntityScope!;
    action.searchParams.set(scopeQuery.operand.parameterId, scope);
    return action.pathname + action.search;
  };
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
          (operation.inputFields ?? []).map((value) => [value.fieldId, value]),
        ),
      };
      shapes.set(surfaceId, known);
    }
    return known;
  };
  // One exact read per selected record per response, however many lines share it.
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
  /** The declared control context of one field in one row. */
  const valueContext = (
    surfaceId: string,
    draft: DraftRow,
    field: SurfaceDocumentEditor['headerFields'][number],
    index: number,
    locked: boolean,
    accessibleName: string | null,
    focus: string | null,
  ) => {
    const { compiled, inputs } = shape(surfaceId);
    const input = inputs.get(field.fieldId);
    if (!input) throw new Error('Editor field unavailable');
    return {
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
  };
  const referenceContext = async (
    base: ReturnType<typeof valueContext>,
    draft: DraftRow,
    field: SurfaceDocumentEditor['headerFields'][number],
    lookup: ReferenceLookup | null,
  ) => {
    const key = referenceKey(draft.id, field.fieldId);
    return {
      ...base,
      selected: await selectedFor(field, draft),
      lookup,
      createOffered:
        !!field.reference!.create &&
        (await createOffered(field.reference!.create)),
      noun: field.label,
      generation: buffer.generations.get(key) ?? 0,
      seq: buffer.seqs.get(key) ?? 0,
    };
  };
  /** One field of one row as the page renders it, for an in-place answer. */
  const fieldContext = (
    draft: DraftRow,
    field: SurfaceDocumentEditor['headerFields'][number],
  ) =>
    valueContext(
      draft === buffer.header
        ? definition.headerFormSurfaceId
        : definition.lineFormSurfaceId,
      draft,
      field,
      0,
      false,
      draft === buffer.header
        ? null
        : `Line ${buffer.lines.indexOf(draft) + 1} ${field.label.toLowerCase()}`,
      null,
    );
  const createDialog = (fragment: boolean) => {
    const task = buffer.create!;
    const create = referenceFields.find(
      (value) => value.fieldId === task.fieldId,
    )!.reference!.create!;
    return renderCreatePanel({
      task,
      create,
      session: buffer.id,
      version: buffer.version,
      action: formAction(),
      fieldInputs: new Map(
        create.steps.flatMap((step) =>
          (
            operationById(view, surfaces, step.operationId)?.inputFields ?? []
          ).map((value) => [value.fieldId, value] as const),
        ),
      ),
      compiledFields: new Map(),
      mode: fragment ? 'fragment' : 'page',
    });
  };
  /**
   * The in-place answer (ADR-0036 behaviour 7). Each part names the one element
   * it replaces: this field's lookup region, this field, a declared dependent
   * in the same row, or the create slot. Nothing else in the document -- in
   * particular no neighbouring input the user is typing -- is touched. It never
   * captures the whole form and never advances the page's draft version; a
   * select is bound instead to the field's own generation and lookup request.
   */
  const fragmentResponse = async (): Promise<EditorResponse | null> => {
    const answer = (
      parts: readonly (readonly [string, string])[],
      notice = '',
      status = 200,
    ): EditorResponse => ({
      html: `${parts
        .map(
          ([target, html]) =>
            `<template data-fragment-target="${h(target)}">${html}</template>`,
        )
        .join(
          '',
        )}${notice ? `<template data-fragment-live>${notice}</template>` : ''}`,
      statusCode: status,
      fragment: true,
    });
    const note = (text: string) =>
      `<p class="draft-note draft-note--problem">${h(text)}</p>`;
    if (!submission) return null;
    if (buffer.busy || buffer.pending || buffer.withheld !== 'none')
      return answer(
        [],
        note('The order is being saved. Try again in a moment.'),
        409,
      );
    const field = (draft: DraftRow, fieldId: string) =>
      rowsOf(fieldId).fields.find((value) => value.fieldId === fieldId)!;
    const fieldParts = async (draft: DraftRow, fieldId: string) => {
      const declared = field(draft, fieldId);
      const base = fieldContext(draft, declared);
      const parts: [string, string][] = [
        [
          `${controlId(draft.id, fieldId)}-field`,
          renderReferenceControl(
            await referenceContext(base, draft, declared, null),
          ),
        ],
      ];
      for (const dependent of dependentsOf(fieldId))
        parts.push([
          controlId(draft.id, dependent.fieldId),
          renderValueControl(fieldContext(draft, dependent)),
        ]);
      return parts;
    };
    const slot = (html: string) =>
      `<div id="editor-create-slot" data-editor-create-slot>${html}</div>`;
    if (submission.draftCreateTask !== undefined) {
      const task = buffer.create;
      if (!task || task.id !== submission.draftCreateTask)
        return answer(
          [['editor-create-slot', slot('')]],
          warning({ code: 'OPERATION_INPUT_INVALID' }, 'Create'),
          422,
        );
      if (task.busy)
        return answer([], note('Still creating. Wait for the result.'), 409);
      task.busy = true;
      try {
        await runCreate();
      } finally {
        task.busy = false;
      }
      buffer.touched = performance.now();
      if (buffer.create)
        return answer(
          [['editor-create-slot', slot(createDialog(true))]],
          '',
          statusCode,
        );
      const notice = buffer.notice;
      buffer.notice = '';
      buffer.focus = null;
      const draft = findRow(task.rowId);
      return answer(
        [
          ['editor-create-slot', slot('')],
          ...(draft ? await fieldParts(draft, task.fieldId) : []),
        ],
        notice,
        statusCode,
      );
    }
    if (buffer.create)
      return answer(
        [],
        note(
          'Finish or cancel the new record first. The order is kept as it was.',
        ),
        409,
      );
    const parsed = parseReferenceAction(submission.draftAction);
    if (!parsed) return null;
    const { verb, rowId, recordId } = parsed;
    const draft = findRow(rowId);
    const { rows, fields } = rowsOf(parsed.field.fieldId);
    if (!draft || !rows.includes(draft) || !fields.includes(parsed.field))
      return answer([], warning({ code: 'OPERATION_INPUT_INVALID' }), 422);
    const declared = parsed.field;
    const key = referenceKey(rowId, declared.fieldId);
    const id = controlId(rowId, declared.fieldId);
    buffer.touched = performance.now();
    if (verb === 'search' || verb === 'more') {
      const seq = Number(submission.draftLookupSeq ?? '');
      if (!Number.isSafeInteger(seq) || seq < 1)
        return answer([], warning({ code: 'OPERATION_INPUT_INVALID' }), 422);
      // An older request is answered with nothing: the newer one owns the field.
      if (seq <= (buffer.seqs.get(key) ?? 0)) return answer([], '', 409);
      if (!claimLookup(key, verb, rowId, declared, seq))
        return answer([], warning({ code: 'OPERATION_INPUT_INVALID' }), 422);
      let lookup: ReferenceLookup | null = null;
      let failure = '';
      try {
        lookup = await readLookup(declared, key);
      } catch (error) {
        // A failed read drops the lookup; nothing read before is shown again.
        if (buffer.seqs.get(key) === seq) dropLookup(key);
        failure = warning(operationMessageRef(error), declared.label);
      }
      if (buffer.seqs.get(key) !== seq) return answer([], '', 409);
      const context = await referenceContext(
        fieldContext(draft, declared),
        draft,
        declared,
        lookup,
      );
      return answer(
        [
          [
            `${id}-lookup`,
            renderReferenceLookup({ ...context, notice: failure }),
          ],
        ],
        '',
        failure ? 422 : 200,
      );
    }
    if (verb === 'select' || verb === 'clear') {
      const generation = buffer.generations.get(key) ?? 0;
      const resync = async (status: number, message: string) =>
        answer(await fieldParts(draft, declared.fieldId), message, status);
      if (submission.draftFieldGeneration !== String(generation))
        return resync(
          409,
          note('This field changed meanwhile. It shows its current value.'),
        );
      let record: SemanticRecordDto | null = null;
      if (verb === 'select') {
        const state = buffer.lookups.get(key);
        // Only a record this field's newest search offered.
        if (
          !recordId ||
          !state ||
          String(state.seq) !== submission.draftLookupSeq ||
          !state.offered.has(recordId)
        )
          return resync(409, note('Those results changed. Search again.'));
        const version = buffer.version;
        try {
          record = await readSelectable(declared, recordId);
        } catch (error) {
          dropLookup(key);
          return resync(
            422,
            warning(operationMessageRef(error), declared.label),
          );
        }
        if (!record)
          return resync(
            422,
            warning({ code: 'OPERATION_INPUT_INVALID' }, declared.label),
          );
        // Nothing may have moved while the record was read: not the field, not
        // its row, not the draft, and no create may have opened.
        if (
          buffer.busy ||
          buffer.version !== version ||
          buffer.create ||
          findRow(rowId) !== draft ||
          (buffer.generations.get(key) ?? 0) !== generation
        )
          return resync(
            409,
            note('This field changed meanwhile. It shows its current value.'),
          );
        reads.set(
          `${declared.reference!.getQueryId}|${record.recordId}`,
          Promise.resolve(record),
        );
      }
      draft.values[declared.fieldId] = record?.recordId ?? null;
      applyDerived(draft, declared.fieldId, record);
      buffer.lookups.delete(key);
      nextGeneration(key);
      return answer(await fieldParts(draft, declared.fieldId));
    }
    // verb === 'create'
    const create = declared.reference?.create;
    if (!create || !(await createOffered(create)))
      return answer(
        [],
        note('You cannot create this record with your current access.'),
        422,
      );
    openCreateTask(draft, declared, create);
    return answer([['editor-create-slot', slot(createDialog(true))]]);
  };
  let statusCode = 200;
  if (mode === 'fragment') return fragmentResponse();
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
                readable = (await readSelectable(field, value)) !== null;
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
            nextGeneration(key);
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
    const action = formAction();
    // While a create is open the order is paused: shown, but not editable, so
    // nothing entered before leaving it can change until the create returns.
    const paused = buffer.create !== null;
    const frozen =
      buffer.pending !== null || buffer.withheld !== 'none' || paused;
    const focus = buffer.focus;
    buffer.focus = null;
    const control = async (
      surfaceId: string,
      draft: DraftRow,
      field: SurfaceDocumentEditor['headerFields'][number],
      index: number,
      locked: boolean,
      accessibleName: string | null,
    ) => {
      const base = valueContext(
        surfaceId,
        draft,
        field,
        index,
        locked,
        accessibleName,
        focus,
      );
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
        return renderReferenceControl(
          await referenceContext(base, draft, field, lookup),
        );
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
    // A flow opened by a full-page submit renders in the page; one opened in
    // place by the script arrives as a fragment into the empty slot below.
    const createPanel = buffer.create ? createDialog(false) : '';
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
        keyFacts: `${createPanel}<div id="editor-create-slot" data-editor-create-slot></div><section class="panel"><div class="draft-live" id="draft-editor-live" role="status" aria-live="polite" data-editor-live>${buffer.notice}</div>${
          paused
            ? '<p class="draft-paused" role="status">This order is paused while you create a record. Nothing you entered has changed.</p>'
            : ''
        }${steps}<form id="draft-editor-form" method="post" action="${h(action)}" data-document-editor>
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
