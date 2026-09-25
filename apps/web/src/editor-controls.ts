import type { ImmutableJsonValue } from '../../../packages/runtime/src/request-runtime-view.js';
import type { SemanticRecordDto } from '../../../packages/runtime/src/semantic-query-gateway.js';
import type {
  SurfaceEditorCreate,
  SurfaceEditorField,
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

/** One authorized page of results for one field, bound to the row and field. */
export interface ReferenceLookup {
  readonly term: string;
  readonly records: readonly SemanticRecordDto[];
  readonly hasMore: boolean;
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

/** The declared default for a field on a new, never-saved row. */
export function declaredDefault(
  field: SurfaceEditorField,
): ImmutableJsonValue | undefined {
  return field.presentation?.kind === 'choice'
    ? field.presentation.defaultValue
    : undefined;
}

/**
 * Whether a submitted choice may be accepted. The offered set plus the value
 * already persisted on the record: a stored value outside the set is kept, but
 * a tampered or stale form cannot introduce a value the editor never offered.
 */
export function choiceAdmits(
  field: SurfaceEditorField,
  row: EditorRow,
  submitted: string,
): boolean {
  if (field.presentation?.kind !== 'choice') return true;
  if (submitted === '') return true;
  return (
    field.presentation.options.some((option) => option.value === submitted) ||
    row.record?.values[field.fieldId] === submitted
  );
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
  if (presentation?.kind === 'choice') {
    const current = text(value);
    const offered = presentation.options.some(
      (option) => option.value === current,
    );
    // A stored value outside the offered set is shown and kept, never replaced
    // by the first option during an unrelated edit.
    const kept =
      current && !offered
        ? `<option value="${h(current)}" selected>${h(current)} (current value)</option>`
        : '';
    const blank = input.required
      ? ''
      : `<option value=""${current ? '' : ' selected'}>Not set</option>`;
    return `<select${shared} name="${h(name)}">${blank}${kept}${presentation.options
      .map(
        (option) =>
          `<option value="${h(option.value)}"${option.value === current ? ' selected' : ''}>${h(option.label)}</option>`,
      )
      .join('')}</select>${error.html}`;
  }
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
}

/**
 * The reusable reference control. Without JavaScript it is a complete search,
 * select and create path made of ordinary submit buttons, each of which first
 * captures the whole draft. The hidden input carries the selected record id, so
 * no text typed into the search box can ever replace a selection.
 */
export function renderReferenceControl(
  context: ReferenceRenderContext,
): string {
  const { row, field, frozen, selected, lookup, noun } = context;
  const name = draftInputName(row.id, field.fieldId);
  const id = controlId(row.id, field.fieldId);
  const value = text(row.values[field.fieldId]);
  const action = (verb: string, extra = '') =>
    `form="draft-editor-form" name="draftAction" value="${h(`${verb}:${row.id}:${field.fieldId}${extra}`)}" formnovalidate`;
  const hidden = `<input type="hidden" form="draft-editor-form" name="${h(name)}" value="${h(value)}">`;
  const label = context.accessibleName ?? field.label;
  if (frozen) {
    const shown = selected ? referenceText(field, selected) : null;
    return `${hidden}<div class="reference-selected" id="${h(id)}">${shown ? `<strong>${h(shown.label)}</strong>${shown.detail ? `<small>${h(shown.detail)}</small>` : ''}` : '<span>Not selected</span>'}</div>`;
  }
  const resultsId = `${id}-results`;
  const here = context.focus === id ? ' autofocus' : '';
  if (value && selected) {
    const shown = referenceText(field, selected);
    return `${hidden}<div class="reference-selected" id="${h(id)}" data-reference-selected><div class="reference-selected__text"><strong>${h(shown.label)}</strong>${shown.detail ? `<small>${h(shown.detail)}</small>` : ''}</div><button class="link-action" ${action('clear')} aria-label="Change ${h(label.toLowerCase())}"${here}>Change</button></div>`;
  }
  const error = errorFor(id, context.error);
  const searchName = `draftSearch:${row.id}:${field.fieldId}`;
  // After a search, focus lands on the first result; with none, back on the box.
  const toResults =
    context.focus === resultsId && (lookup?.records.length ?? 0) > 0;
  const searchFocus =
    context.focus === id || (context.focus === resultsId && !toResults)
      ? ' autofocus'
      : '';
  const results = lookup
    ? `<ul class="reference-results" id="${h(resultsId)}" role="list" aria-label="${h(`${noun} results`)}">${
        lookup.records.length
          ? lookup.records
              .map((record, position) => {
                const shown = referenceText(field, record);
                const first = toResults && position === 0 ? ' autofocus' : '';
                return `<li><button class="reference-option" ${action('select', `:${record.recordId}`)}${first}><strong>${h(shown.label)}</strong>${shown.detail ? `<small>${h(shown.detail)}</small>` : ''}</button></li>`;
              })
              .join('')
          : `<li class="reference-empty" role="status">No ${h(noun.toLowerCase())} matches “${h(lookup.term)}”.</li>`
      }${lookup.hasMore ? `<li><button class="link-action" ${action('more')}>More results</button></li>` : ''}</ul>`
    : '';
  const create =
    context.createOffered && field.reference?.create
      ? `<button class="reference-create" ${action('create')}>+ ${h(field.reference.create.label)}</button>`
      : '';
  return `${hidden}<div class="reference-control" id="${h(id)}" data-reference-control data-reference-results="${h(resultsId)}"><div class="reference-search"><input type="search" form="draft-editor-form" name="${h(searchName)}" value="${h(lookup?.term ?? '')}" placeholder="${h(`Search ${noun.toLowerCase()} by name or number`)}" aria-label="${h(`Search ${label.toLowerCase()}`)}" autocomplete="off" data-reference-search${searchFocus}${error.attributes}><button class="secondary-action" ${action('search')} data-reference-submit>Search</button></div>${error.html}${results}${create}</div>`;
}

/**
 * The quick-create form. It is its own form, never nested in the draft form,
 * and it carries the draft session and version so it is bound to the same
 * principal, release, company and document buffer as the order it returns to.
 */
export function renderCreatePanel(context: {
  readonly task: CreateTask;
  readonly create: SurfaceEditorCreate;
  readonly session: string;
  readonly version: number;
  readonly action: string;
  readonly fieldInputs: ReadonlyMap<string, CompiledSurfaceInputField>;
  readonly compiledFields: ReadonlyMap<string, CompiledSurfaceField>;
}): string {
  const { task, create } = context;
  const frozen = task.attempted;
  const fields = create.fields
    .map((collected, index) => {
      const name = `create:${collected.fieldId}`;
      const input = context.fieldInputs.get(collected.fieldId);
      const required = input?.required ? ' required' : '';
      const disabled = frozen ? ' disabled' : '';
      const value = text(task.values[collected.fieldId]);
      const autofocus = index === 0 ? ' data-task-initial-focus' : '';
      const control =
        collected.presentation?.kind === 'multiline'
          ? `<textarea name="${h(name)}" rows="2"${required}${disabled}${autofocus}>${h(value)}</textarea>`
          : `<input name="${h(name)}" value="${h(value)}" autocomplete="off"${required}${disabled}${autofocus}>`;
      // A frozen retry must resend exactly what was attempted, so the frozen
      // values ride along as hidden inputs rather than disappearing.
      const kept = frozen
        ? `<input type="hidden" name="${h(name)}" value="${h(value)}">`
        : '';
      return `<label class="field">${h(collected.label)}${input?.required ? ' *' : ''}${control}</label>${kept}`;
    })
    .join('');
  const pending = task.steps.some((step) => !step.done);
  return `<dialog class="editor-create" open data-composition-task aria-labelledby="editor-create-heading"><form method="post" action="${h(context.action)}" class="editor-create__form" data-editor-create>
  <input type="hidden" name="draftSession" value="${h(context.session)}"><input type="hidden" name="draftVersion" value="${context.version}"><input type="hidden" name="draftCreateTask" value="${h(task.id)}">
  <header class="editor-create__header"><h2 id="editor-create-heading" data-task-heading tabindex="-1">${h(create.label)}</h2><button type="button" class="link-action" data-task-close hidden aria-label="Hide ${h(create.label.toLowerCase())}">Hide</button></header>
  <p class="editor-create__explanation">${h(create.explanation)}</p>
  ${task.notice}
  <div class="form-fields editor-create__fields">${fields}</div>
  <footer class="editor-create__footer"><button type="submit" name="draftCreate" value="cancel" formnovalidate class="secondary-action">Cancel</button><button type="submit" name="draftCreate" value="submit">${frozen && pending ? 'Retry' : `Create and use`}</button></footer>
</form></dialog><p class="draft-create-resume" data-task-resume data-task-resume-closed-only hidden><button type="button" class="secondary-action" data-task-open>Show ${h(create.label.toLowerCase())}</button></p>`;
}
