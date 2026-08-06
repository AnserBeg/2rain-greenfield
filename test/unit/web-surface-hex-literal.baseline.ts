/**
 * Deliberately reviewed literal-colour debt in the web surface source. A count
 * change in either direction requires this artifact to move in the same commit.
 *
 * The unit is occurrences, not source lines: each literal is one future token
 * migration obligation, while formatting can move many literals onto one line.
 *
 * **Packet `U2` moved this from 69 to 38 and changed what the number means.**
 * Before `U2` every literal was debt, scattered through the `surface-runtime.ts`
 * style blob, and the target was zero. After `U2` the remaining 38 are the
 * ADR-0035 token-definition block itself — the brand ramp, the neutrals, the
 * light and dark status roles and the two dark-only accent tints — and the
 * target is *not* zero, because a token layer has to state its palette
 * somewhere. What replaced the count as the real gate is
 * `tokenBlock`: every occurrence must fall inside the delimited block in
 * `sourceFile`, so a literal reintroduced on any render path fails whether or
 * not the total happens to match.
 */
export const WEB_SURFACE_HEX_LITERAL_BASELINE = Object.freeze({
  occurrenceCount: 38,
  sourceRoot: 'apps/web/src',
  tokenBlock: Object.freeze({
    end: '/* token-definition-block:end */',
    sourceFile: 'apps/web/src/design-tokens.ts',
    start: '/* token-definition-block:start */',
  } as const),
  unit: 'occurrence',
} as const);
