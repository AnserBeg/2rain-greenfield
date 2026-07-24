import { canonicalize } from '@north-star/canonical-model';
import { createHash } from 'node:crypto';

import { VERIFICATION_RESULT_VERSION } from './protocol.js';
import type {
  VERIFICATION_PLAN_PAYLOAD_VERSION,
  VERIFICATION_SCENARIO_VERSION,
} from './protocol.js';

export interface VerificationScenario {
  readonly entityId: string;
  readonly kind:
    | 'archiveRestrict'
    | 'declaredEvidence'
    | 'enumReject'
    | 'resolverAuthority'
    | 'searchableExclusion'
    | 'typedErrorSurface'
    | 'uniquenessFold';
  readonly probePolarity: 'declaredOutcome' | 'positiveAndNegative';
  readonly provider: 'realPostgresql';
  readonly scenarioFingerprint: string;
  readonly scenarioId: string;
  readonly schemaVersion: typeof VERIFICATION_SCENARIO_VERSION;
  readonly subjectId: string;
  readonly [key: string]: unknown;
}

export interface VerificationPlanPayloadV1 {
  readonly kind: 'verificationPlanPayload';
  readonly scenarios: readonly VerificationScenario[];
  readonly schemaVersion: typeof VERIFICATION_PLAN_PAYLOAD_VERSION;
}

export interface ExecutedVerificationResult {
  readonly negativeProbeDigest: string | null;
  readonly positiveProbeDigest: string;
  readonly provider: 'realPostgresql';
  readonly scenarioFingerprint: string;
  readonly scenarioId: string;
  readonly schemaVersion: typeof VERIFICATION_RESULT_VERSION;
}

export interface VerificationConformanceDiagnostic {
  readonly code:
    | 'VERIFICATION_EXECUTED_RESULT_DUPLICATE'
    | 'VERIFICATION_EXECUTED_RESULT_INVALID'
    | 'VERIFICATION_EXECUTED_RESULT_MISSING'
    | 'VERIFICATION_EXECUTED_RESULT_UNDECLARED';
  readonly scenarioId: string;
}

export interface VerificationConformanceResult {
  readonly diagnostics: readonly VerificationConformanceDiagnostic[];
  readonly status: 'failed' | 'passed';
}

export function executedVerificationResult(
  scenario: VerificationScenario,
  proof: {
    readonly negativeProbe?: unknown;
    readonly positiveProbe: unknown;
  },
): ExecutedVerificationResult {
  return Object.freeze({
    negativeProbeDigest:
      scenario.probePolarity === 'positiveAndNegative'
        ? digestProof(proof.negativeProbe)
        : null,
    positiveProbeDigest: digestProof(proof.positiveProbe),
    provider: 'realPostgresql',
    scenarioFingerprint: scenario.scenarioFingerprint,
    scenarioId: scenario.scenarioId,
    schemaVersion: VERIFICATION_RESULT_VERSION,
  });
}

export function validateExecutedVerificationPlan(
  plan: VerificationPlanPayloadV1,
  results: readonly ExecutedVerificationResult[],
): VerificationConformanceResult {
  const diagnostics: VerificationConformanceDiagnostic[] = [];
  const scenarios = new Map(
    plan.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const resultById = new Map<string, ExecutedVerificationResult>();
  for (const result of results) {
    if (resultById.has(result.scenarioId)) {
      diagnostics.push({
        code: 'VERIFICATION_EXECUTED_RESULT_DUPLICATE',
        scenarioId: result.scenarioId,
      });
      continue;
    }
    resultById.set(result.scenarioId, result);
    if (!scenarios.has(result.scenarioId)) {
      diagnostics.push({
        code: 'VERIFICATION_EXECUTED_RESULT_UNDECLARED',
        scenarioId: result.scenarioId,
      });
    }
  }
  for (const scenario of plan.scenarios) {
    const result = resultById.get(scenario.scenarioId);
    if (!result) {
      diagnostics.push({
        code: 'VERIFICATION_EXECUTED_RESULT_MISSING',
        scenarioId: scenario.scenarioId,
      });
      continue;
    }
    const valid =
      result.schemaVersion === VERIFICATION_RESULT_VERSION &&
      result.provider === 'realPostgresql' &&
      result.scenarioFingerprint === scenario.scenarioFingerprint &&
      isDigest(result.positiveProbeDigest) &&
      (scenario.probePolarity === 'positiveAndNegative'
        ? isDigest(result.negativeProbeDigest)
        : result.negativeProbeDigest === null);
    if (!valid) {
      diagnostics.push({
        code: 'VERIFICATION_EXECUTED_RESULT_INVALID',
        scenarioId: scenario.scenarioId,
      });
    }
  }
  diagnostics.sort(
    (left, right) =>
      compare(left.scenarioId, right.scenarioId) ||
      compare(left.code, right.code),
  );
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    status: diagnostics.length === 0 ? 'passed' : 'failed',
  });
}

function digestProof(value: unknown): string {
  if (value === undefined) return '';
  return createHash('sha256')
    .update('northstar.verification-proof/v1', 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalize(value), 'utf8')
    .digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
