import type { ImmutableJsonValue } from '../../../packages/runtime/src/request-runtime-view.js';
import type { CompiledSurfaceInputField } from './surface-contract.js';
import { escapeHtml as h } from './html.js';

/**
 * Control semantics shared by every surface family that collects a value: the
 * draft document editor, its quick-create forms and composed Task inputs. One
 * choice renderer and admission rule, one declared-default rule, one exact
 * decimal rule -- so an offered set, a default or a decimal bound means the
 * same thing wherever it is declared. None of this decides business meaning;
 * the server's operation contract still admits every value on invoke.
 */

/** A declared offered set, whether an editor field or a Task input declares it. */
export interface ChoicePresentation {
  readonly kind: 'choice';
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly defaultValue?: string | undefined;
}
export type Presented = {
  readonly presentation?:
    ChoicePresentation | { readonly kind: 'multiline' | 'derived' } | undefined;
};

/**
 * The declared default for a value nobody has entered yet: a field on a new,
 * never-saved row, or a field of a freshly opened create flow. Never applied
 * over an entered, stored, frozen or retried value. `now` is the request's
 * clock, so a test fixes the instant.
 */
export function declaredDefault(
  field: Presented & {
    readonly defaultDaysFromToday?: number | undefined;
    readonly defaultNow?: true | undefined;
  },
  now: Date = new Date(),
): ImmutableJsonValue | undefined {
  if (field.defaultDaysFromToday !== undefined) {
    // Midnight UTC of the day that many days out: a date shown as its UTC
    // calendar date everywhere else in the application.
    const day = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + field.defaultDaysFromToday,
    );
    return new Date(day).toISOString();
  }
  if (field.defaultNow)
    // The instant itself, to the second the editor's control shows: a stock
    // document dated now is not dated before stock that arrived today.
    return new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
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
