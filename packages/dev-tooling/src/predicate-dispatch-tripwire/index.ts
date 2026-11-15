export const PREDICATE_DISPATCH_TRIPWIRE_VERSION =
  'northstar.predicate-dispatch-tripwire/v1' as const;

type PredicateKind =
  | 'allPredicate'
  | 'anyPredicate'
  | 'booleanPredicate'
  | 'fieldComparisonPredicate'
  | 'notPredicate';

export interface PredicateDispatchSource {
  readonly path: string;
  readonly source: string;
}

export interface PredicateDispatchDiagnostic {
  readonly code:
    | 'PREDICATE_DISPATCH_INVENTORY_MISSING'
    | 'PREDICATE_DISPATCH_SIGNATURE_CHANGED'
    | 'PREDICATE_DISPATCH_UNREGISTERED';
  readonly kinds: readonly PredicateKind[];
  readonly path: string;
}

export interface PredicateDispatchTripwireOptions {
  readonly requireCompleteInventory?: boolean;
}

function signature(values: readonly PredicateKind[]): readonly PredicateKind[] {
  return Object.freeze(values);
}

/**
 * Model-authored recognition inventory, judged deterministically. The tripwire
 * is deliberately a proxy: it ratchets recognizable kind dispatch and cannot
 * prove semantic uniqueness by itself.
 */
const recognizedDispatches: Readonly<Record<string, readonly PredicateKind[]>> =
  Object.freeze({
    'packages/canonical-model/src/normalize.ts': signature([
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'fieldComparisonPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'fieldComparisonPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
    ]),
    'packages/canonical-model/src/predicate-kernel.ts': signature([
      'booleanPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
      'anyPredicate',
      'notPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'booleanPredicate',
      'booleanPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'allPredicate',
      'booleanPredicate',
    ]),
    'packages/canonical-model/src/schemas.ts': signature([
      'booleanPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
      'anyPredicate',
      'notPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
      'anyPredicate',
      'notPredicate',
    ]),
    'packages/compiler/src/predicate-lowering.ts': signature([
      'booleanPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'fieldComparisonPredicate',
    ]),
    // A definition file CONSTRUCTS predicates rather than dispatching on them,
    // and the tripwire's heuristic -- three or more distinct kinds mentioned in
    // one file -- cannot tell the two apart. `inventory/definition.ts` is
    // registered for exactly the same reason. `PUR-1` authors an
    // `all(not(equals), not(equals), not(equals))` editing guard, which is
    // three kinds.
    'packages/domain/src/purchasing/definition.ts': signature([
      'notPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
      'notPredicate',
    ]),
    // SALES-PARITY's lifecycle and receivables guards add constructed
    // any/not/all terms; the file still builds predicates and evaluates none.
    'packages/domain/src/sales/definition.ts': signature([
      'allPredicate',
      'anyPredicate',
      'notPredicate',
      'allPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
      'notPredicate',
    ]),
    'packages/domain/src/inventory/definition.ts': signature([
      'notPredicate',
      'fieldComparisonPredicate',
      'fieldComparisonPredicate',
      'allPredicate',
    ]),
    'packages/postgres-provider/src/module-runtime-interpreter.ts': signature([
      'booleanPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'allPredicate',
      'allPredicate',
      'fieldComparisonPredicate',
    ]),
    'packages/postgres-provider/src/saved-filter-executor.ts': signature([
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
    ]),
    'packages/runtime/src/semantic-query-gateway.ts': signature([
      'fieldComparisonPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
      'booleanPredicate',
      'fieldComparisonPredicate',
      'notPredicate',
      'allPredicate',
      'anyPredicate',
    ]),
  });

export function checkPredicateDispatchTripwire(
  sources: readonly PredicateDispatchSource[],
  options: PredicateDispatchTripwireOptions = {},
): readonly PredicateDispatchDiagnostic[] {
  const diagnostics: PredicateDispatchDiagnostic[] = [];
  const observed = new Set<string>();
  for (const candidate of sources) {
    const path = candidate.path.replaceAll('\\', '/');
    const kinds = extractPredicateKinds(candidate.source);
    if (new Set(kinds).size < 3) continue;
    observed.add(path);
    const recognized = recognizedDispatches[path];
    if (recognized === undefined) {
      diagnostics.push({
        code: 'PREDICATE_DISPATCH_UNREGISTERED',
        kinds,
        path,
      });
    } else if (!sameKinds(kinds, recognized)) {
      diagnostics.push({
        code: 'PREDICATE_DISPATCH_SIGNATURE_CHANGED',
        kinds,
        path,
      });
    }
  }
  if (options.requireCompleteInventory === true) {
    for (const [path, kinds] of Object.entries(recognizedDispatches)) {
      if (!observed.has(path)) {
        diagnostics.push({
          code: 'PREDICATE_DISPATCH_INVENTORY_MISSING',
          kinds,
          path,
        });
      }
    }
  }
  return Object.freeze(
    diagnostics
      .sort((left, right) =>
        `${left.path}:${left.code}` < `${right.path}:${right.code}` ? -1 : 1,
      )
      .map((diagnostic) => Object.freeze(diagnostic)),
  );
}

function extractPredicateKinds(source: string): readonly PredicateKind[] {
  const pattern =
    /['"](allPredicate|anyPredicate|booleanPredicate|fieldComparisonPredicate|notPredicate)['"]/gu;
  return Object.freeze(
    [...source.matchAll(pattern)].map((match) => match[1] as PredicateKind),
  );
}

function sameKinds(
  left: readonly PredicateKind[],
  right: readonly PredicateKind[],
): boolean {
  return (
    left.length === right.length &&
    left.every((candidate, index) => candidate === right[index])
  );
}
