export interface CanonicalDiagnostic {
  acceptedAlternative: string;
  code: string;
  objectId: string | null;
  occurrenceIndex: number;
  path: string;
  phase: string;
  rule: string;
}

export class CanonicalModelError extends Error {
  readonly diagnostics: readonly CanonicalDiagnostic[];

  constructor(diagnostics: CanonicalDiagnostic[]) {
    const ordered = [...diagnostics].sort(compareDiagnostics);
    super(ordered.map((diagnostic) => diagnostic.code).join(', '));
    this.name = 'CanonicalModelError';
    this.diagnostics = Object.freeze(ordered);
  }
}

export function diagnostic(
  code: string,
  path: string,
  rule: string,
  acceptedAlternative: string,
  objectId: string | null = null,
  phase = 'canonicalModel',
  occurrenceIndex = 0,
): CanonicalDiagnostic {
  return {
    acceptedAlternative,
    code,
    objectId,
    occurrenceIndex,
    path,
    phase,
    rule,
  };
}

function compareDiagnostics(
  left: CanonicalDiagnostic,
  right: CanonicalDiagnostic,
): number {
  return (
    compareCodeUnits(left.objectId ?? '', right.objectId ?? '') ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.phase, right.phase) ||
    compareCodeUnits(left.code, right.code) ||
    left.occurrenceIndex - right.occurrenceIndex
  );
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
