import {
  COMPILER_DIAGNOSTIC_VERSION,
  type CompilerDiagnostic,
  type CompilerPhase,
} from './protocol.js';

export const COMPILER_DIAGNOSTIC_COPY = Object.freeze({
  COMPILER_CAPABILITY_NOT_SUPPORTED: {
    acceptedAlternative:
      'use a supported capability or leave the construct planned and out of the active package',
    rule: 'active compilation lowers only capabilities marked supported',
  },
  COMPILER_DEFINITION_INVALID: {
    acceptedAlternative:
      'supply canonical normalized bytes accepted by the frozen application language',
    rule: 'compiler input must be a valid normalized application package',
  },
  COMPILER_DEPENDENCY_INVALID: {
    acceptedAlternative:
      'provide one uniquely identified dependency with a lowercase SHA-256 content digest',
    rule: 'compiler dependencies are explicit, unique, versioned, and content bound',
  },
  COMPILER_DIAGNOSTIC_LIMIT_REACHED: {
    acceptedAlternative:
      'resolve the emitted diagnostics and compile again to reveal any remaining issues',
    rule: 'compiler diagnostics stop at the versioned deterministic limit',
  },
  COMPILER_INPUT_NOT_CANONICAL: {
    acceptedAlternative:
      'persist and compile the exact normalized canonical bytes produced by Freeze A',
    rule: 'the compiler accepts one canonical normalized byte representation',
  },
  COMPILER_INPUT_NOT_SERIALIZABLE: {
    acceptedAlternative:
      'provide only process-serializable data values and Uint8Array byte fields',
    rule: 'the compiler boundary contains no functions, closures, or ambient handles',
  },
  COMPILER_OUTPUT_LIMIT_EXCEEDED: {
    acceptedAlternative:
      'reduce the package within v0 bounds or adopt a new reviewed output-limit profile',
    rule: 'the complete emitted artifact closure stays within explicit compiler limits',
  },
  COMPILER_PROFILE_UNSUPPORTED: {
    acceptedAlternative:
      'use the exact supported compiler semantic, output, hash, and policy profile',
    rule: 'compiler semantics are selected only by an explicit supported profile',
  },
  COMPILER_REFERENCE_UNRESOLVED: {
    acceptedAlternative:
      'reference a canonical ID present in the complete normalized package',
    rule: 'every compiler reference resolves through the collected symbol table',
  },
  COMPILER_SYMBOL_DUPLICATE: {
    acceptedAlternative:
      'give every declared construct one globally unique canonical ID',
    rule: 'symbol collection admits one owner for each canonical ID',
  },
  COMPILER_PROJECTION_INVARIANT_FAILED: {
    acceptedAlternative:
      'fix the lowering so every projection agrees with the normalized semantic model',
    rule: 'cross-projection identities and required constructs must agree',
  },
  COMPILER_PROJECTION_REQUIRED_MISSING: {
    acceptedAlternative:
      'implement and verify the required projection family before claiming support',
    rule: 'every declared supported capability lowers through every required projection',
  },
  COMPILER_STORAGE_TRANSITION_UNSUPPORTED: {
    acceptedAlternative:
      'use the admitted optional-field addition or defer the storage change to its owning packet',
    rule: 'Freeze B lowers only the evidenced additive optional-field storage transition',
  },
  COMPILER_TRANSITION_BASE_INVALID: {
    acceptedAlternative:
      'supply a verified expected-active release root and storage-target artifact',
    rule: 'a transition plan binds one verified expected-active target to one candidate target',
  },
  COMPILER_TYPE_INVALID: {
    acceptedAlternative:
      'use references whose resolved semantic types agree with their owning construct',
    rule: 'resolved references must satisfy compiler semantic type constraints',
  },
  COMPILER_UNTRUSTED_INPUT_GATE_REQUIRED: {
    acceptedAlternative:
      'compile first-party input only until the tracked sandbox release gate is satisfied',
    rule: 'tenant-authored or AI-authored definitions require the deferred sandbox release gate',
  },
} as const);

export type CompilerDiagnosticCode = keyof typeof COMPILER_DIAGNOSTIC_COPY;

export function compilerDiagnostic(
  code: CompilerDiagnosticCode,
  phase: CompilerPhase,
  path: string,
  subjectId: string | null,
  occurrenceIndex = 0,
): CompilerDiagnostic {
  const copy = COMPILER_DIAGNOSTIC_COPY[code];
  return {
    acceptedAlternative: copy.acceptedAlternative,
    code,
    diagnosticVersion: COMPILER_DIAGNOSTIC_VERSION,
    occurrenceIndex,
    path,
    phase,
    rule: copy.rule,
    severity: 'error',
    subjectId,
  };
}

export function finalizeDiagnostics(
  diagnostics: CompilerDiagnostic[],
  maximumDiagnostics: number,
): CompilerDiagnostic[] {
  const byIdentity = new Map<string, CompilerDiagnostic>();
  for (const entry of diagnostics) {
    const identity = [
      entry.subjectId ?? '',
      entry.path,
      entry.phase,
      entry.code,
      String(entry.occurrenceIndex),
    ].join('\u0000');
    if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
  }
  const ordered = [...byIdentity.values()].sort(compareDiagnostics);
  if (ordered.length <= maximumDiagnostics) return ordered;
  const kept = ordered.slice(0, Math.max(0, maximumDiagnostics - 1));
  return [
    ...kept,
    compilerDiagnostic(
      'COMPILER_DIAGNOSTIC_LIMIT_REACHED',
      'wholeModelValidation',
      '$',
      null,
      maximumDiagnostics - 1,
    ),
  ].sort(compareDiagnostics);
}

function compareDiagnostics(
  left: CompilerDiagnostic,
  right: CompilerDiagnostic,
): number {
  return (
    compareCodeUnits(left.subjectId ?? '', right.subjectId ?? '') ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.phase, right.phase) ||
    compareCodeUnits(left.code, right.code) ||
    left.occurrenceIndex - right.occurrenceIndex
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
