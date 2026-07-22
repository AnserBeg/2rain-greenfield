export {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  CONTENT_HASH_DOMAIN,
  IMMUTABLE_DEFAULTS_V0,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  STATUS_ROLES,
  STRUCTURAL_LIMITS_V0,
  SURFACE_ARCHETYPES,
  SURFACE_SLOTS,
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
  canonicalize,
  canonicalizeAndHash,
  type CanonicalizedContent,
} from './canonicalize.js';

export const platformContract = Object.freeze({
  authority: 'canonical-model',
  product: 'greenfield-north-star-erp',
});
