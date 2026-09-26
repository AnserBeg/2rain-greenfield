import type { ImmutableJsonValue } from '../../../packages/runtime/src/request-runtime-view.js';
import type { SemanticRecordDto } from '../../../packages/runtime/src/semantic-query-gateway.js';
import type {
  SurfaceEditorCreate,
  SurfaceEditorField,
  SurfaceEditorPresentation,
} from '../../../packages/canonical-model/src/schemas.js';
import type {
  CompiledSurfaceField,
  CompiledSurfaceInputField,
} from './surface-contract.js';
import { renderFormControl } from './component-registry.js';
import { escapeHtml as h } from './html.js';

/**
 * Draft-editor controls, driven entirely by the declared editor field.
 *
 * Nothing here decides business meaning. A `choice` is the editor's offered set
 * over a text field; a `derived` value is read from the record the sibling
 * reference selected; a reference is searched and created only through the
 * declared list, get and governed create operations. The server remains the
 * authority for every value on save.
 */

export type EditorValues = Record<string, ImmutableJsonValue>;

export interface EditorRow {
  readonly id: string;
  readonly record: SemanticRecordDto | null;
  values: EditorValues;
  removed: boolean;
}

/**
 * What one field's search asked for -- never what it returned. The buffer keeps
 * the term, how many pages were requested, and which record ids were last
 * offered (for the own-field selection check). Results are re-read under each
 * response's own authority; nothing an earlier response disclosed is replayed.
 */
export interface LookupState {
  readonly term: string;
  pages: number;
  offered: ReadonlySet<string>;
  /**
   * Which request asked for this term. Every search for the field takes a
   * higher number, so a slower answer to an older request can neither replace
   * the offered set nor be selected from once a newer one has been asked.
   */
  readonly seq: number;
}

/** The results a field shows in this response, read in this request. */
export interface ReferenceLookup {
  readonly term: string;
  readonly records: readonly SemanticRecordDto[];
  /** This request's authorized read found further matches after its pages. */
  readonly queryContinues: boolean;
  /** The pages read reached the editor's display limit. */
  readonly displayLimitReached: boolean;
  readonly nextCursor: string | null;
}

/**
 * An in-context create. Its idempotency keys are minted once when the flow is
 * opened and reused by every retry, so a lost response can never create a
 * second master. Collected values freeze once any step has been attempted.
 */
export interface CreateTask {
  readonly id: string;
  readonly rowId: string;
  readonly fieldId: string;
  /** The field's value when the flow opened; a return may not overwrite a newer one. */
  readonly openedValue: ImmutableJsonValue | null;
  values: EditorValues;
  readonly steps: {
    readonly operationId: string;
    /** Minted once when the flow opens; every retry reuses it. */
    readonly key: string;
    /** The record id this step creates, also minted once. */
    readonly recordId: string;
    done: boolean;
  }[];
  attempted: boolean;
  notice: string;
  /** Problems found before any step ran, by collected field id. */
  errors: Map<string, string>;
  /**
   * Current policy refused a step when it ran. Retrying the same request
   * cannot succeed, so the flow offers only Cancel -- which reports anything
   * already created -- instead of a futile Retry loop.
   */
  denied: boolean;
  /** A step is running; a second submission of the same flow waits for it. */
  busy: boolean;
}

export const referenceKey = (rowId: string, fieldId: string) =>
  `${rowId}|${fieldId}`;
export const controlId = (rowId: string, fieldId: string) =>
  `editor-${rowId}-${fieldId.replace(/[^a-z0-9]/giu, '-')}`;
export const draftInputName = (rowId: string, fieldId: string) =>
  `draft:${rowId}:${fieldId}`;

const text = (value: ImmutableJsonValue | undefined) =>
  value === null || value === undefined ? '' : String(value);

/** Label and detail text for one record, from the declared label fields only. */
export function referenceText(
  field: SurfaceEditorField,
  record: SemanticRecordDto,
): { label: string; detail: string } {
  const pick = (ids: readonly string[]) =>
    ids
      .map((id) => record.values[id])
      .filter((value) => typeof value === 'string' && value.trim())
      .join(' · ');
  return {
    label: pick(field.reference!.labelFieldIds) || record.recordId,
    detail: pick(field.reference!.detailFieldIds ?? []),
  };
}

type Presented = {
  readonly presentation?: SurfaceEditorPresentation | undefined;
};
type ChoicePresentation = Extract<
  SurfaceEditorPresentation,
  { kind: 'choice' }
>;

/**
 * The declared default for a value nobody has entered yet: a field on a new,
 * never-saved row, or a field of a freshly opened create flow. Never applied
 * over an entered, stored, frozen or retried value.
 */
export function declaredDefault(
  field: Presented,
): ImmutableJsonValue | undefined {
  return field.presentation?.kind === 'choice'
    ? field.presentation.defaultValue
    : undefined;
}

/**
 * Whether a submitted choice may be accepted: the offered set, plus a value the
 * record already stores. A stored value outside the set is kept, but a tampered
 * or stale form cannot introduce a value the editor never offered. Editor policy
 * over a text field, not a domain enum.
 */
export function admitsChoice(
  field: Presented,
  submitted: string,
  stored?: ImmutableJsonValue,
): boolean {
  if (field.presentation?.kind !== 'choice') return true;
  if (submitted === '') return true;
  return (
    field.presentation.options.some((option) => option.value === submitted) ||
    stored === submitted
  );
}

export function choiceAdmits(
  field: SurfaceEditorField,
  row: EditorRow,
  submitted: string,
): boolean {
  return admitsChoice(field, submitted, row.record?.values[field.fieldId]);
}

/**
 * A declared choice as a native select, shared by the document editor and its
 * create forms. An optional choice offers "Not set"; a required one with no
 * value shows an explicit prompt rather than silently preselecting an option;
 * `keepCurrent` shows a stored value outside the set so it is not replaced.
 */
export function renderChoice(
  presentation: ChoicePresentation,
  attributes: string,
  current: string,
  context: {
    readonly required: boolean;
    readonly keepCurrent: boolean;
    readonly label: string;
  },
): string {
  const offered = presentation.options.some(
    (option) => option.value === current,
  );
  const kept =
    context.keepCurrent && current && !offered
      ? `<option value="${h(current)}" selected>${h(current)} (current value)</option>`
      : '';
  const blank = !context.required
    ? `<option value=""${current ? '' : ' selected'}>Not set</option>`
    : current
      ? ''
      : `<option value="" selected>Choose ${h(context.label.toLowerCase())}</option>`;
  return `<select${attributes}>${blank}${kept}${presentation.options
    .map(
      (option) =>
        `<option value="${h(option.value)}"${option.value === current ? ' selected' : ''}>${h(option.label)}</option>`,
    )
    .join('')}</select>`;
}

export const DECIMAL_KINDS: readonly string[] = [
  'quantityFieldType',
  'exactDecimalFieldType',
  'moneyFieldType',
];

type DecimalBounds = CompiledSurfaceInputField['bounds'];

/**
 * Exact decimal text in the provider's canonical form -- no leading or trailing
 * zeros, no `+`, no `-0` -- or null when the text is not a plain decimal inside
 * the declared precision and scale. String work only: the value is never
 * parsed into a float, so `12.50` becomes `12.5` and nothing else changes.
 */
export function canonicalDecimal(
  value: string,
  bounds?: DecimalBounds,
): string | null {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/u.exec(value.trim());
  if (!match || (!match[2] && !match[3])) return null;
  const integer = match[2]!.replace(/^0+(?=\d)/u, '') || '0';
  const fraction = (match[3] ?? '').replace(/0+$/u, '');
  const negative = match[1] === '-' && (integer !== '0' || fraction !== '');
  if (bounds && (bounds.precision === null || bounds.scale === null))
    return null;
  if (bounds?.precision != null && bounds.scale != null) {
    const integerDigits = integer === '0' ? 0 : integer.length;
    if (
      fraction.length > bounds.scale ||
      integerDigits > bounds.precision - bounds.scale ||
      Math.max(1, integerDigits + fraction.length) > bounds.precision
    )
      return null;
  }
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

/** Why a decimal entry cannot be saved, in the operator's terms, or null. */
export function decimalProblem(
  value: string,
  input: CompiledSurfaceInputField,
): string | null {
  if (canonicalDecimal(value) === null)
    return 'Enter a plain number, such as 12.5.';
  if (!input.bounds || canonicalDecimal(value, input.bounds) !== null)
    return null;
  const { precision, scale } = input.bounds;
  if (precision === null || scale === null)
    return 'This value cannot be saved.';
  return scale === 0
    ? `Enter a whole number of at most ${precision} digits.`
    : `Use at most ${scale} digits after the decimal point and ${precision - scale} before it.`;
}

/** Equality as the field compares it: decimals by exact value, not by spelling. */
export function sameValue(
  kind: string,
  left: ImmutableJsonValue | undefined,
  right: ImmutableJsonValue | undefined,
): boolean {
  if (
    DECIMAL_KINDS.includes(kind) &&
    typeof left === 'string' &&
    typeof right === 'string'
  ) {
    const a = canonicalDecimal(left);
    const b = canonicalDecimal(right);
    if (a !== null && b !== null) return a === b;
  }
  return (left ?? null) === (right ?? null);
}

const errorFor = (id: string, error: string | null) =>
  error
    ? {
        attributes: ` aria-invalid="true" aria-describedby="${h(id)}-error"`,
        html: `<small class="field-error" id="${h(id)}-error">${h(error)}</small>`,
      }
    : { attributes: '', html: '' };

interface RenderContext {
  readonly row: EditorRow;
  readonly field: SurfaceEditorField;
  readonly compiled: CompiledSurfaceField | undefined;
  readonly input: CompiledSurfaceInputField;
  readonly frozen: boolean;
  readonly index: number;
  /** Accessible name when the visible label is a shared column heading. */
  readonly accessibleName: string | null;
  /**
   * The control id the last action asked to focus. The matching control gets
   * `autofocus`, so focus returns to the exact field without JavaScript.
   */
  readonly focus: string | null;
  /** A save-time problem with this control, shown beside it. */
  readonly error: string | null;
}

/** A non-reference field, routed through the platform's typed controls. */
export function renderValueControl(context: RenderContext): string {
  const { row, field, compiled, input, frozen, index } = context;
  const name = draftInputName(row.id, field.fieldId);
  const id = controlId(row.id, field.fieldId);
  const value = row.values[field.fieldId];
  const named = context.accessibleName
    ? ` aria-label="${h(context.accessibleName)}"`
    : '';
  const focused = context.focus === id && !frozen ? ' autofocus' : '';
  const error = errorFor(id, context.error);
  const shared = ` id="${h(id)}" form="draft-editor-form"${named}${input.required ? ' required' : ''}${frozen ? ' disabled' : ''}${focused}${error.attributes}`;
  const presentation = field.presentation;
  if (presentation?.kind === 'multiline')
    return `<textarea${shared} name="${h(name)}" rows="3">${h(text(value))}</textarea>${error.html}`;
  if (presentation?.kind === 'choice')
    // A stored value outside the offered set is shown and kept, never replaced
    // by the first option during an unrelated edit.
    return `${renderChoice(presentation, `${shared} name="${h(name)}"`, text(value), { required: input.required, keepCurrent: true, label: field.label })}${error.html}`;
  if (presentation?.kind === 'derived') {
    // Read-only: the server sets this from the selected record and never takes
    // it from the submission, so it cannot drift from the product it describes.
    const shown = text(value);
    return `<output id="${h(id)}" class="derived-value" data-derived-from="${h(presentation.referenceFieldId)}"${named}>${shown ? h(shown) : '<span class="derived-empty">Select a product</span>'}</output>`;
  }
  if (input.kind === 'dateTimeFieldType') {
    // Kept deliberately: an explicit-UTC native picker with second precision,
    // whose value regains its `Z` when the save is planned. The shared carrier
    // for this kind is a text box, which is what this editor is replacing.
    const utc = input.temporal?.timezoneSemantics === 'utcInstant';
    let current = text(value);
    if (utc && current.endsWith('Z')) current = current.slice(0, 19);
    return `<input type="datetime-local" step="1"${shared} name="${h(name)}" value="${h(current)}">${error.html}`;
  }
  const decimal = DECIMAL_KINDS.includes(input.kind);
  // A stored decimal is shown in canonical spelling -- `3`, not
  // `3.000000000000000000` -- which is the same exact value.
  const shown =
    decimal && typeof value === 'string'
      ? (canonicalDecimal(value) ?? value)
      : value;
  const control = renderFormControl(
    compiled,
    input,
    field.fieldId,
    index,
    shown,
    {
      name,
      attributes: shared,
    },
  );
  if (!control.storedValueUnavailable) return `${control.html}${error.html}`;
  // The typed control cannot display the stored value, so keep it losslessly
  // rather than let the browser blank it and a later save clear it.
  return `<input type="text"${shared} name="${h(name)}" value="${h(text(value))}"><small class="form-unavailable-value">Stored value kept exactly as saved.</small>${error.html}`;
}

interface ReferenceRenderContext extends RenderContext {
  readonly selected: SemanticRecordDto | null;
  readonly lookup: ReferenceLookup | null;
  readonly createOffered: boolean;
  readonly noun: string;
  /** Selection generation: a select or create based on another is stale. */
  readonly generation: number;
  /** The field's latest lookup request number, from which a client continues. */
  readonly seq: number;
}

/**
 * The reusable reference control: a combobox over the declared list query.
 *
 * Without JavaScript it is a complete search, select and create path made of
 * ordinary submit buttons, each of which first captures the whole draft. With
 * the owned script it becomes an in-place popup: the same server renders only
 * this field's lookup region or this field's control, never the document. The
 * hidden carrier holds the selected record id, so text typed into the box can
 * never replace a selection by itself; the box shows the selected label.
 */
export function renderReferenceControl(
  context: ReferenceRenderContext,
): string {
  const { row, field, frozen, selected } = context;
  const name = draftInputName(row.id, field.fieldId);
  const id = controlId(row.id, field.fieldId);
  const value = text(row.values[field.fieldId]);
  const hidden = `<input type="hidden" form="draft-editor-form" name="${h(name)}" value="${h(value)}" data-reference-value>`;
  const label = context.accessibleName ?? field.label;
  const shown = value && selected ? referenceText(field, selected) : null;
  if (frozen)
    return `<div class="reference-field" id="${h(id)}-field">${hidden}<div class="reference-selected" id="${h(id)}">${shown ? `<strong>${h(shown.label)}</strong>${shown.detail ? `<small>${h(shown.detail)}</small>` : ''}` : '<span>Not selected</span>'}</div></div>`;
  const action = referenceAction(row.id, field.fieldId);
  const error = errorFor(id, context.error);
  const searchName = `draftSearch:${row.id}:${field.fieldId}`;
  // After a search, focus lands on the first result; with none, back on the box.
  const resultsId = `${id}-results`;
  const toResults =
    context.focus === resultsId && (context.lookup?.records.length ?? 0) > 0;
  const searchFocus =
    context.focus === id || (context.focus === resultsId && !toResults)
      ? ' autofocus'
      : '';
  const describedBy = [
    ...(context.error ? [`${id}-error`] : []),
    `${id}-status`,
  ];
  // The box shows what it searches for; with a selection and no open search,
  // it shows the selected label so the field reads like a filled field.
  const term = context.lookup?.term ?? shown?.label ?? '';
  const clear = shown
    ? `<button class="link-action reference-clear" ${action('clear')} data-reference-clear aria-label="${h(`Clear ${label.toLowerCase()}`)}">Clear</button>`
    : '';
  return `<div class="reference-field" id="${h(id)}-field" data-reference-field data-reference-row="${h(row.id)}" data-reference-generation="${context.generation}">${hidden}<div class="reference-control" id="${h(id)}" data-reference-control data-reference-results="${h(resultsId)}"><div class="reference-search"><input type="text" role="combobox" id="${h(id)}-input" form="draft-editor-form" name="${h(searchName)}" value="${h(term)}" placeholder="${h(`Search ${context.noun.toLowerCase()} by name or number`)}" aria-label="${h(label)}" aria-autocomplete="list" aria-expanded="${context.lookup ? 'true' : 'false'}" aria-controls="${h(resultsId)}" autocomplete="off" enterkeyhint="search" data-reference-search${shown ? ` data-selected-label="${h(shown.label)}"` : ''}${searchFocus}${context.error ? ' aria-invalid="true"' : ''} aria-describedby="${h(describedBy.join(' '))}"><button class="secondary-action" ${action('search')} data-reference-submit>Search</button>${clear}${renderReferenceLookup({ ...context, focusResults: toResults })}</div>${shown?.detail ? `<small class="reference-selected-detail">${h(shown.detail)}</small>` : ''}${error.html}</div></div>`;
}

const referenceAction =
  (rowId: string, fieldId: string) =>
  (verb: string, extra = '') =>
    `form="draft-editor-form" name="draftAction" value="${h(`${verb}:${rowId}:${fieldId}${extra}`)}" formnovalidate`;

/**
 * The part of a reference control that one lookup changes: its status line
 * and its popup. The owned script replaces exactly this element when a search
 * answers, so what the user is typing is never re-rendered under them.
 *
 * Three truthful endings: the query is exhausted (nothing more is shown), it
 * continues below the display limit (More), or it continues past it (a refine
 * message beside the box, and no More that cannot move). "+ New" is the last
 * row of the popup, and exists only when the create may start.
 */
export function renderReferenceLookup(
  context: ReferenceRenderContext & {
    readonly focusResults?: boolean;
    /** A refusal from this request's read, shown in place of any results. */
    readonly notice?: string;
  },
): string {
  const { row, field, lookup, noun } = context;
  const id = controlId(row.id, field.fieldId);
  const resultsId = `${id}-results`;
  const action = referenceAction(row.id, field.fieldId);
  const continues = lookup?.queryContinues === true;
  const limited = continues && lookup.displayLimitReached;
  const status = context.notice
    ? context.notice
    : limited
      ? `<p class="reference-empty reference-limit" id="${h(resultsId)}-limit">More matches exist. Refine your search.</p>`
      : lookup && lookup.records.length === 0
        ? `<p class="reference-empty">No ${h(noun.toLowerCase())} matches “${h(lookup.term)}”.</p>`
        : '';
  const options = (lookup?.records ?? [])
    .map((record, position) => {
      const shown = referenceText(field, record);
      const first = context.focusResults && position === 0 ? ' autofocus' : '';
      return `<li role="presentation"><button class="reference-option" role="option" id="${h(id)}-option-${position}" aria-selected="false" ${action('select', `:${record.recordId}`)}${first}><strong>${h(shown.label)}</strong>${shown.detail ? `<small>${h(shown.detail)}</small>` : ''}</button></li>`;
    })
    .join('');
  const more =
    continues && !limited
      ? `<li role="presentation"><button class="link-action reference-more" role="option" id="${h(id)}-option-more" aria-selected="false" ${action('more')} data-reference-more>More results</button></li>`
      : '';
  const create =
    context.createOffered && field.reference?.create
      ? `<li role="presentation"><button class="reference-create" role="option" id="${h(id)}-option-create" aria-selected="false" ${action('create')} data-reference-create>+ ${h(field.reference.create.label)}</button></li>`
      : '';
  const popup =
    options || more || create
      ? `<div class="reference-popup" id="${h(id)}-popup" data-reference-popup><ul class="reference-results" id="${h(resultsId)}" role="listbox" aria-label="${h(`${noun} results`)}">${options}${more}${create}</ul></div>`
      : '';
  return `<div class="reference-lookup" id="${h(id)}-lookup" data-reference-lookup data-reference-seq="${context.seq}" data-reference-shown="${lookup ? 'true' : 'false'}"><div class="reference-status" id="${h(id)}-status" role="status">${status}</div>${popup}</div>`;
}

/**
 * The quick-create form. It is its own form, never nested in the draft form,
 * and it carries the draft session and version so it is bound to the same
 * principal, release, company and document buffer as the order it returns to.
 * The primary submit is the form's first submit button, so the browser's own
 * Enter submission creates (after required-field validation) and never cancels;
 * Cancel is explicit and is the only control that skips validation.
 */
export function renderCreatePanel(context: {
  readonly task: CreateTask;
  readonly create: SurfaceEditorCreate;
  readonly session: string;
  readonly version: number;
  readonly action: string;
  readonly fieldInputs: ReadonlyMap<string, CompiledSurfaceInputField>;
  readonly compiledFields: ReadonlyMap<string, CompiledSurfaceField>;
  /**
   * `fragment`: opened in place by the owned script as a modal over the live
   * order. It has no Hide -- the order stays paused on the server until the
   * flow is created or cancelled, so a hidden flow would only strand it.
   */
  readonly mode?: 'page' | 'fragment';
}): string {
  const { task, create } = context;
  const fragment = context.mode === 'fragment';
  const frozen = task.attempted;
  const fields = create.fields
    .map((collected, index) => {
      const name = `create:${collected.fieldId}`;
      const input = context.fieldInputs.get(collected.fieldId);
      const required = input?.required ? ' required' : '';
      const disabled = frozen ? ' disabled' : '';
      const value = text(task.values[collected.fieldId]);
      const autofocus = index === 0 ? ' data-task-initial-focus' : '';
      const error = errorFor(
        `editor-create-${index}`,
        task.errors.get(collected.fieldId) ?? null,
      );
      const attributes = `${required}${disabled}${autofocus}${error.attributes}`;
      const presentation = collected.presentation;
      const control =
        presentation?.kind === 'multiline'
          ? `<textarea name="${h(name)}" rows="2"${attributes}>${h(value)}</textarea>`
          : presentation?.kind === 'choice'
            ? renderChoice(
                presentation,
                ` name="${h(name)}"${attributes}`,
                value,
                {
                  required: input?.required ?? false,
                  keepCurrent: false,
                  label: collected.label,
                },
              )
            : `<input name="${h(name)}" value="${h(value)}" autocomplete="off"${attributes}>`;
      // A frozen retry must resend exactly what was attempted, so the frozen
      // values ride along as hidden inputs rather than disappearing.
      const kept = frozen
        ? `<input type="hidden" name="${h(name)}" value="${h(value)}">`
        : '';
      return `<label class="field">${h(collected.label)}${input?.required ? ' *' : ''}${control}${error.html}</label>${kept}`;
    })
    .join('');
  const pending = task.steps.some((step) => !step.done);
  // A refusal by current policy cannot be retried into success: offer Cancel
  // only, which reports anything already created, rather than a Retry loop.
  const primary = task.denied
    ? ''
    : `<button type="submit" name="draftCreate" value="submit">${frozen && pending ? 'Retry' : `Create and use`}</button>`;
  const denied = task.denied
    ? `<p class="draft-note" data-editor-create-denied>You cannot create this record with your current access. Cancel returns to the order${pending && task.steps.some((step) => step.done) ? '; what was already created is kept' : ''}.</p>`
    : '';
  const hide = fragment
    ? ''
    : `<button type="button" class="link-action" data-task-close hidden aria-label="Hide ${h(create.label.toLowerCase())}">Hide</button>`;
  const resume = fragment
    ? ''
    : `<p class="draft-create-resume" data-task-resume data-task-resume-closed-only hidden><button type="button" class="secondary-action" data-task-open>Show ${h(create.label.toLowerCase())}</button></p>`;
  return `<dialog class="editor-create"${fragment ? ' data-editor-create-fragment' : ' open data-composition-task'} aria-labelledby="editor-create-heading"><form method="post" action="${h(context.action)}" class="editor-create__form" data-editor-create>
  <input type="hidden" name="draftSession" value="${h(context.session)}"><input type="hidden" name="draftVersion" value="${context.version}"><input type="hidden" name="draftCreateTask" value="${h(task.id)}">
  <header class="editor-create__header"><h2 id="editor-create-heading" data-task-heading tabindex="-1">${h(create.label)}</h2>${hide}</header>
  <p class="editor-create__explanation">${h(create.explanation)}</p>
  ${task.notice}${denied}
  <div class="form-fields editor-create__fields">${fields}</div>
  <footer class="editor-create__footer">${primary}<button type="submit" name="draftCreate" value="cancel" formnovalidate class="secondary-action">Cancel</button></footer>
</form></dialog>${resume}`;
}
