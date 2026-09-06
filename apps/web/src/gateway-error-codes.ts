import type {
  OperationDiagnosticCode,
  QueryDiagnosticCode,
} from './message-catalog.js';

/**
 * ADR-0048 §2's asymmetry: `keyof typeof` closes *raised but not registered*
 * for codes and leaves it wide open for error classes. Before this module the
 * read path ended in an untyped `: 'QUERY_UNAVAILABLE'`, so six distinct
 * gateway failures were demoted to "Data unavailable" with nothing observing
 * it, and a seventh added later would have joined them in silence.
 *
 * The discriminant is `error.name`, not `error.code`: every gateway error sets
 * `override readonly name`, but `RequestRuntimeViewIntegrityError` carries no
 * `code`, so a code-keyed table would have been closed over a set that is not
 * actually total.
 *
 * **Two halves, and neither works alone.** These records are exhaustive over a
 * union declared here, so deleting a mapping fails compilation — but a class
 * added in `packages/runtime` cannot fail a compile in `apps/web`. The
 * companion is `message-catalog.test.ts`'s enumeration, which reads the two
 * gateway modules' actual exports at runtime and reds when this list and the
 * module disagree. That check is an observation of the loaded module object,
 * not a parse of its source.
 */

export const MAPPED_QUERY_ERROR_NAMES = Object.freeze([
  'InvalidResolveByNameContractError',
  'MalformedLegalEntityScopeArgumentError',
  'MalformedPinnedQueryCatalogError',
  'MalformedQueryPolicyNarrowingError',
  'MalformedSemanticQueryRequestError',
  'NoSuchRegisteredQueryError',
  'SemanticQueryPolicyDeniedError',
  'SharedListContractError',
  'UnsupportedSemanticAggregateQueryError',
] as const);

export type MappedQueryErrorName = (typeof MAPPED_QUERY_ERROR_NAMES)[number];

/**
 * Behaviour is preserved exactly: every entry below renders the code this path
 * already rendered before the catalog existed, so this packet stays a
 * substitution. Four of them are **known-inaccurate and reported as findings
 * rather than corrected here**, because correcting a mapping moves a
 * `data-diagnostic-code` and that is a behaviour change with its own review
 * surface. They are marked `INACCURATE` below with the code they should carry.
 */
const QUERY_ERROR_MESSAGE_CODES: Readonly<
  Record<MappedQueryErrorName, QueryDiagnosticCode>
> = Object.freeze({
  // INACCURATE: a broken resolve-by-name contract is a capability fault, not a
  // transient one. Should be QUERY_UNSUPPORTED.
  InvalidResolveByNameContractError: 'QUERY_UNAVAILABLE',
  MalformedLegalEntityScopeArgumentError: 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED',
  // INACCURATE: an unreadable pinned catalog is a release fault. Should be
  // QUERY_UNSUPPORTED.
  MalformedPinnedQueryCatalogError: 'QUERY_UNAVAILABLE',
  MalformedQueryPolicyNarrowingError: 'QUERY_UNAVAILABLE',
  MalformedSemanticQueryRequestError: 'QUERY_UNAVAILABLE',
  NoSuchRegisteredQueryError: 'QUERY_UNSUPPORTED',
  SemanticQueryPolicyDeniedError: 'QUERY_PERMISSION_DENIED',
  // INACCURATE: a shared-list contract breach is a release fault. Should be
  // QUERY_UNSUPPORTED.
  SharedListContractError: 'QUERY_UNAVAILABLE',
  // INACCURATE: the name says unsupported. Should be QUERY_UNSUPPORTED.
  UnsupportedSemanticAggregateQueryError: 'QUERY_UNAVAILABLE',
});

export const MAPPED_OPERATION_ERROR_NAMES = Object.freeze([
  'MalformedPinnedOperationCatalogError',
  'MalformedSemanticOperationRequestError',
  'NoSuchRegisteredCapabilityError',
  'NoSuchRegisteredOperationError',
  'SemanticOperationConfirmationGrantError',
  'SemanticOperationConfirmationRequiredError',
  'SemanticOperationConfirmationStaleError',
  'SemanticOperationExecutionFailedError',
  'SemanticOperationInvocationContextError',
  'SemanticOperationPolicyDeniedError',
] as const);

export type MappedOperationErrorName =
  (typeof MAPPED_OPERATION_ERROR_NAMES)[number];

export type OperationMessageRef =
  | {
      readonly code: Exclude<
        OperationDiagnosticCode,
        'OPERATION_LEGAL_ENTITY_INACTIVE' | 'OPERATION_REFUSED'
      >;
      readonly subject?: undefined;
    }
  | {
      readonly code: 'OPERATION_LEGAL_ENTITY_INACTIVE' | 'OPERATION_REFUSED';
      readonly subject: string;
    };

type SubjectlessOperationDiagnosticCode = Exclude<
  OperationDiagnosticCode,
  'OPERATION_LEGAL_ENTITY_INACTIVE' | 'OPERATION_REFUSED'
>;

const OPERATION_ERROR_MESSAGE_CODES: Readonly<
  Record<MappedOperationErrorName, SubjectlessOperationDiagnosticCode>
> = Object.freeze({
  // INACCURATE: an unreadable pinned catalog is a release fault. Should be
  // OPERATION_UNSUPPORTED.
  MalformedPinnedOperationCatalogError: 'OPERATION_UNAVAILABLE',
  MalformedSemanticOperationRequestError: 'OPERATION_UNAVAILABLE',
  // INACCURATE: an unregistered capability is unsupported, not unavailable.
  NoSuchRegisteredCapabilityError: 'OPERATION_UNAVAILABLE',
  NoSuchRegisteredOperationError: 'OPERATION_UNSUPPORTED',
  SemanticOperationConfirmationGrantError: 'OPERATION_CONFIRMATION_STALE',
  // Reached only outside the submit path's own confirmation branch, which
  // answers this case before invoking.
  SemanticOperationConfirmationRequiredError: 'OPERATION_CONFIRMATION_REQUIRED',
  SemanticOperationConfirmationStaleError: 'OPERATION_CONFIRMATION_STALE',
  SemanticOperationExecutionFailedError: 'OPERATION_UNAVAILABLE',
  SemanticOperationInvocationContextError: 'OPERATION_UNAVAILABLE',
  SemanticOperationPolicyDeniedError: 'OPERATION_PERMISSION_DENIED',
});

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * The residual is deliberate and narrow. It catches a genuine defect — a
 * `TypeError` from a bug, say — which must render something. What it may no
 * longer catch silently is a *new gateway error class*: the enumeration gate
 * reds when one appears without a mapping here.
 */
export function queryMessageCode(error: unknown): QueryDiagnosticCode {
  const name = errorName(error);
  return isMappedQueryErrorName(name)
    ? QUERY_ERROR_MESSAGE_CODES[name]
    : 'QUERY_UNAVAILABLE';
}

export function operationMessageCode(error: unknown): OperationDiagnosticCode {
  return operationMessageRef(error).code;
}

/**
 * Provider refusal codes are intentionally open to module extensions. Unknown
 * provider refusals therefore stay refusals and carry their stable code to the
 * operator; only failures with no provider refusal identity use unavailable.
 */
export function operationMessageRef(error: unknown): OperationMessageRef {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'ModuleRuntimeInterpreterError' ||
      error.name === 'InventoryPostingError') &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    if (
      error.code === 'MODULE_LEGAL_ENTITY_CREATE_INACTIVE' &&
      'subjectId' in error &&
      typeof error.subjectId === 'string'
    ) {
      return {
        code: 'OPERATION_LEGAL_ENTITY_INACTIVE',
        subject: error.subjectId,
      };
    }
    return { code: 'OPERATION_REFUSED', subject: error.code };
  }
  const name = errorName(error);
  const code = isMappedOperationErrorName(name)
    ? OPERATION_ERROR_MESSAGE_CODES[name]
    : 'OPERATION_UNAVAILABLE';
  return { code };
}

function isMappedQueryErrorName(value: string): value is MappedQueryErrorName {
  return (MAPPED_QUERY_ERROR_NAMES as readonly string[]).includes(value);
}

function isMappedOperationErrorName(
  value: string,
): value is MappedOperationErrorName {
  return (MAPPED_OPERATION_ERROR_NAMES as readonly string[]).includes(value);
}
