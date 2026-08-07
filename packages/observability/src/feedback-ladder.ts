/**
 * The ADR-0032 feedback ladder, expressed as a measurement rather than prose.
 *
 * [ADR-0032](../../../docs/decisions/ADR-0032-feedback-ladder-and-loading-states.md)
 * §1 fixes six duration bands and the treatment each one earns, and §2 rules
 * that a loading treatment "is admitted only where a **measured** operation
 * exceeds the Doherty threshold". Both statements are about a number that
 * something has to produce; this module is where that number is turned into a
 * band, so the ladder can be observed instead of asserted.
 *
 * The band ids are the ADR's own boundaries rather than its treatment names.
 * Treatment vocabulary belongs to the `ux-grammar` skill, and a metric label is
 * not the place to coin any.
 */

/** ADR-0032 §1 boundaries, ascending, in milliseconds. */
export const FEEDBACK_LADDER_BOUNDARIES_MILLISECONDS = Object.freeze([
  100, 400, 1_000, 3_000, 10_000,
] as const);

/**
 * Doherty & Thadani's productivity cliff, and therefore plan §15.1's registered
 * query budget after ADR-0032 §7 tightened it from an uncited 500 ms.
 */
export const DOHERTY_THRESHOLD_MILLISECONDS = 400;

/**
 * The six bands, ascending. Lower-inclusive and exhaustive: every finite,
 * non-negative duration lands in exactly one, which is what lets a band
 * counter's total be compared against an invocation count.
 *
 * ADR-0032 §1 writes the last two rows as "3 s – 10 s" and "> 10 s", which
 * leaves exactly 10,000 ms unclaimed. It is resolved here in the direction that
 * owes the user more: 10,000 ms exactly is `over_10s`, the band that requires
 * progress plus cancel or background-handoff.
 */
export const FEEDBACK_LADDER_BANDS = Object.freeze([
  'under_100ms',
  '100ms_400ms',
  '400ms_1s',
  '1s_3s',
  '3s_10s',
  'over_10s',
] as const);

export type FeedbackLadderBand = (typeof FEEDBACK_LADDER_BANDS)[number];

/**
 * Why a sample was not a measurement. A monotonic source cannot produce either
 * of these, so each one names a broken clock rather than a slow query, and
 * counting them as a band would file that defect under "fast".
 */
export const LATENCY_SAMPLE_REJECTIONS = Object.freeze([
  'negative',
  'not_finite',
] as const);

export type LatencySampleRejection = (typeof LATENCY_SAMPLE_REJECTIONS)[number];

export type FeedbackLadderClassification =
  | { readonly band: FeedbackLadderBand; readonly kind: 'band' }
  | { readonly kind: 'rejected'; readonly reason: LatencySampleRejection };

/**
 * Total function: a duration is either a band or a named rejection, never a
 * silent drop and never a clamp. A clamp would report a backward clock step —
 * which AGENTS.md §6 records this machine's WSL2 kernel doing under load — as
 * an instantaneous response.
 */
export function classifyFeedbackLadder(
  durationMilliseconds: number,
): FeedbackLadderClassification {
  if (!Number.isFinite(durationMilliseconds)) {
    return Object.freeze({ kind: 'rejected', reason: 'not_finite' } as const);
  }
  if (durationMilliseconds < 0) {
    return Object.freeze({ kind: 'rejected', reason: 'negative' } as const);
  }
  const index = FEEDBACK_LADDER_BOUNDARIES_MILLISECONDS.filter(
    (boundary) => durationMilliseconds >= boundary,
  ).length;
  return Object.freeze({
    band: FEEDBACK_LADDER_BANDS[index]!,
    kind: 'band',
  } as const);
}

/**
 * ADR-0032 §2 as an executable predicate: a loading treatment is admitted only
 * above the Doherty threshold, so the two bands at or under it answer `false`.
 * A surface that wants a treatment for a band this refuses is reporting a
 * performance defect the treatment would hide.
 */
export function loadingTreatmentAdmitted(band: FeedbackLadderBand): boolean {
  return band !== 'under_100ms' && band !== '100ms_400ms';
}

const monotonicOriginNanoseconds = process.hrtime.bigint();

/**
 * Elapsed milliseconds from a monotonic source, per AGENTS.md §6. The origin is
 * captured once and subtracted in `bigint` so the `number` conversion carries
 * sub-microsecond resolution instead of nanoseconds-since-boot, which would
 * lose precision past 2^53.
 */
export function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint() - monotonicOriginNanoseconds) / 1e6;
}
