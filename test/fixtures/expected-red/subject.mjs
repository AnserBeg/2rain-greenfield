// A stand-in for production, used only by the expected-red gate's own negative
// controls. It exists so each control can vary ONE property of a manifest entry
// against a subject whose real behaviour is known, without mutating a real
// packet's source to prove the gate can fail.

export function admitQuantity(value) {
  if (!Number.isInteger(value)) throw new Error('SUBJECT_NOT_AN_INTEGER');
  if (value <= 0) throw new Error('SUBJECT_NOT_POSITIVE');
  return value;
}

// No test asserts this, so a mutation of it must SURVIVE. That is control C2.
export const UNMEASURED_LABEL = 'nothing asserts this';

// Two identical literals, so `original: "'ambiguous'"` matches twice. That is
// control A2: String.replace would silently mutate only the first.
export const FIRST_MARKER = 'ambiguous';
export const SECOND_MARKER = 'ambiguous';
