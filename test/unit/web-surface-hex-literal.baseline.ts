/**
 * Deliberately reviewed literal-colour debt in the web surface source. A count
 * change in either direction requires this artifact to move in the same commit.
 *
 * The unit is occurrences, not source lines: each literal is one future token
 * migration obligation, while formatting can move many literals onto one line.
 */
export const WEB_SURFACE_HEX_LITERAL_BASELINE = Object.freeze({
  occurrenceCount: 69,
  sourceRoot: 'apps/web/src',
  unit: 'occurrence',
} as const);
