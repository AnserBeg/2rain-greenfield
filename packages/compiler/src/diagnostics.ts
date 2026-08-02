import {
  COMPILER_DIAGNOSTIC_VERSION,
  type CompilerDiagnostic,
  type CompilerPhase,
} from './protocol.js';

export const COMPILER_DIAGNOSTIC_COPY = Object.freeze({
  COMPILER_BACKFILL_INADMISSIBLE: {
    acceptedAlternative:
      'declare a default or coalesce-at-read rule that keeps every residual unbackfilled row correct',
    rule: 'v1 backfill completeness is never load-bearing for new-release reads',
  },
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
  COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED: {
    acceptedAlternative:
      'use archive or restore; separately governed retention purge has no launch capability',
    rule: 'ordinary module operations never delete, purge, or destroy business data',
  },
  COMPILER_DESTRUCTIVE_STORAGE_DDL_UNSUPPORTED: {
    acceptedAlternative:
      'render only the versioned additive allowlist with restrict-only foreign keys',
    rule: 'storage rendering rejects ON DELETE CASCADE, delete-capable triggers or rules, TRUNCATE, partition removal, and destructive business-data DDL',
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
  MODULE_CLASSIFICATION_UNSUPPORTED: {
    acceptedAlternative:
      'use public or internal until the policy engine and trust read model enforce confidential and restricted fields',
    rule: 'active fields compile only when every declared classification is enforced on both write and read paths',
  },
  COMPILER_OUTPUT_LIMIT_EXCEEDED: {
    acceptedAlternative:
      'reduce the package within v0 bounds or adopt a new reviewed output-limit profile',
    rule: 'the complete emitted artifact closure stays within explicit compiler limits',
  },
  COMPILER_ENTITY_PROJECTION_MISSING: {
    acceptedAlternative:
      'add the required entity-specific query, operation, surface, agent, reporting, or verification definition',
    rule: 'compiler-derived conformance requires every applicable active entity in every mandatory projection family',
  },
  COMPILER_GENERATED_STORAGE_UNSUPPORTED: {
    acceptedAlternative:
      'use dedicatedTable storage until generated typed storage has provider and runtime evidence',
    rule: 'generatedTyped is representable but intentionally unsupported by the Freeze F candidate',
  },
  COMPILER_PHYSICAL_NAME_COLLISION: {
    acceptedAlternative:
      'use the compiler-owned domain-separated SHA-256/base32 physical mapping without overrides',
    rule: 'one physical identifier maps to exactly one canonical storage object',
  },
  COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE: {
    acceptedAlternative:
      'preserve the prior object shape or mint a distinct compiler-derived physical identifier',
    rule: 'a physical identifier cannot be reused for an incompatible canonical storage shape',
  },
  COMPILER_PHYSICAL_NAME_TOO_LONG: {
    acceptedAlternative:
      'use the versioned compiler-derived digest name bounded to 63 UTF-8 bytes',
    rule: 'every emitted PostgreSQL identifier fits the 63-byte identifier limit',
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
  COMPILER_RENDERER_FORM_UNSUPPORTED: {
    acceptedAlternative:
      'bind list, record, and form roles through the closed SurfaceDefinition registry',
    rule: 'module definitions cannot introduce executable renderer forms',
  },
  COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED: {
    acceptedAlternative:
      'declare one or more resolveMatchKeys and mark every key as identifier or advisory',
    rule: 'v2 resolve queries fail closed unless their match authority is explicit in canonical definition data',
  },
  COMPILER_RESOLVE_MATCH_KEY_STORAGE_UNSUPPORTED: {
    acceptedAlternative:
      'select a match key whose lowered storage column is text-backed, or omit resolve when the entity has no such column',
    rule: 'every declared resolve key executes against a text-backed lowered storage column',
  },
  COMPILER_RESOLVE_QUERY_REQUIRED: {
    acceptedAlternative:
      'declare a resolve query with an explicit match authority over a text-backed lowered storage column',
    rule: 'every entity with a text-backed lowered storage column exposes resolve',
  },
  COMPILER_STORAGE_CLASS_REQUIRED: {
    acceptedAlternative:
      'declare dedicatedTable explicitly for every active entity storage mapping',
    rule: 'storageClass is non-null and explicit at v1 compile time',
  },
  COMPILER_STORAGE_PROMOTION_UNSUPPORTED: {
    acceptedAlternative:
      'retain the promotion capability ID and invariant as a non-executable reserve',
    rule: 'storage-class promotion is representable but has no executable phase topology in v1',
  },
  COMPILER_STORAGE_RENAME_AS_ADD_UNSUPPORTED: {
    acceptedAlternative:
      'preserve canonical field identity; a future governed evolution family must own renames',
    rule: 'v1 does not reinterpret a removed field and added field as a rename',
  },
  COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED: {
    acceptedAlternative:
      'preserve the complete existing physical relation shape or add a distinct optional relation through the v1 additive path',
    rule: 'v1 rejects mutation or removal of an existing relation physical shape, requiredness, ownership, target, or referential action',
  },
  COMPILER_STORAGE_RETYPE_UNSUPPORTED: {
    acceptedAlternative:
      'preserve the existing field type or defer retyping to a future governed evolution family',
    rule: 'v1 storage transitions do not retype existing physical columns',
  },
  COMPILER_STORAGE_TRANSITION_UNSUPPORTED: {
    acceptedAlternative:
      'use a closed v1 additive element or defer the change to its governed evolution family',
    rule: 'the selected compiler profile lowers only its versioned evidenced storage transition kinds',
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
  COMPILER_VERIFICATION_ASSERTION_INVOCATION_UNRESOLVED: {
    acceptedAlternative:
      'reference a query or entity-backed operation that can produce a verification scenario, or add a governed per-scenario derivation',
    rule: 'every active assertion resolves to exactly one compiler-emitted verification scenario subject',
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
