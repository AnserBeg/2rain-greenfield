export {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  CONTENT_HASH_DOMAIN,
  IMMUTABLE_DEFAULTS_V0,
  LEGACY_LANGUAGE_VERSION,
  LEGACY_NORMALIZATION_PROFILE_VERSION,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  PREVIOUS_NORMALIZATION_PROFILE_VERSION,
  PROMOTE_STORAGE_CLASS_CAPABILITY_ID,
  STATUS_ROLES,
  STRUCTURAL_LIMITS_V0,
  SUPPORTED_LANGUAGE_VERSIONS,
  SUPPORTED_NORMALIZATION_PROFILE_VERSIONS,
  SURFACE_ARCHETYPES,
  SURFACE_SLOTS,
  type CanonicalLanguageVersion,
} from './constants.js';
export {
  CanonicalModelError,
  type CanonicalDiagnostic,
} from './diagnostics.js';
export {
  AuthoredApplicationPackageSchema,
  CanonicalDecimalStringSchema,
  CanonicalIdSchema,
  CanonicalIntegerStringSchema,
  CanonicalReferenceSchema,
  CanonicalScalarSchema,
  FieldTypeSchema,
  NormalizedApplicationPackageSchema,
  PredicateExpressionSchema,
  type AuthoredApplicationPackage,
  type CanonicalId,
  type CanonicalScalar,
  type NormalizedApplicationPackage,
  type PredicateExpression,
} from './schemas.js';
export {
  canonicalAuthoredProjection,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
} from './normalize.js';
export {
  PREDICATE_KERNEL_RECEIPT_VERSION,
  inspectPredicateForExecution,
  type LiteralTruePredicate,
  type PredicateKernelEntryPoint,
  type PredicateKernelReceipt,
} from './predicate-kernel.js';
export {
  canonicalize,
  canonicalizeAndHash,
  type CanonicalizedContent,
} from './canonicalize.js';
export {
  UNICODE_CASE_FOLD_EXPANSIONS,
  UNICODE_CASE_FOLD_SIMPLE_SOURCES,
  UNICODE_CASE_FOLD_SIMPLE_TARGETS,
  UNICODE_CASE_FOLD_VERSION,
  unicodeCaseFold,
} from './unicode-case-fold.js';

export const platformContract = Object.freeze({
  authority: 'canonical-model',
  product: 'greenfield-north-star-erp',
});
