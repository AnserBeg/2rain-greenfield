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
  readonly providerRunId: string;
  readonly scenarioFingerprint: string;
  readonly scenarioId: string;
  readonly schemaVersion: typeof VERIFICATION_RESULT_VERSION;
}

export interface ExecutedVerificationResultSet {
  readonly artifactClosureDigest: string;
  readonly provider: 'realPostgresql';
  readonly providerRunId: string;
  readonly releaseRoot: string;
  readonly resultSetDigest: string;
  readonly results: readonly ExecutedVerificationResult[];
  readonly schemaVersion: 'northstar.verification-result-set/v1';
  readonly verificationPlanArtifactRoot: string;
  readonly verificationPlanDigest: string;
  readonly verificationPlanSemanticDigest: string;
}

export interface VerificationExecutionCommand {
  readonly artifactClosureDigest: string;
  readonly providerRunId: string;
  readonly releaseRoot: string;
  readonly verificationPlanArtifactRoot: string;
  readonly verificationPlanSemanticDigest: string;
}

export interface ExecutedVerificationProbe {
  readonly negativeProbe?: unknown;
  readonly positiveProbe: unknown;
}

export type VerificationScenarioExecutor = (
  scenario: VerificationScenario,
) => ExecutedVerificationProbe | Promise<ExecutedVerificationProbe>;

export interface VerificationConformanceDiagnostic {
  readonly code:
    | 'VERIFICATION_EXECUTED_RESULT_DUPLICATE'
    | 'VERIFICATION_EXECUTED_RESULT_INVALID'
    | 'VERIFICATION_EXECUTED_RESULT_MISSING'
    | 'VERIFICATION_EXECUTED_RESULT_UNDECLARED'
    | 'VERIFICATION_RESULT_SET_INVALID';
  readonly scenarioId: string;
}

export interface VerificationConformanceResult {
  readonly diagnostics: readonly VerificationConformanceDiagnostic[];
  readonly status: 'failed' | 'passed';
}

const resultSetVersion = 'northstar.verification-result-set/v1' as const;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export async function executeVerificationPlan(
  plan: VerificationPlanPayloadV1,
  command: VerificationExecutionCommand,
  execute: VerificationScenarioExecutor,
): Promise<ExecutedVerificationResultSet> {
  assertClosedExecutionCommand(command);
  if (command.providerRunId.trim() === '') {
    throw new TypeError('providerRunId must identify a real PostgreSQL run');
  }
  for (const [name, value] of Object.entries({
    artifactClosureDigest: command.artifactClosureDigest,
    releaseRoot: command.releaseRoot,
    verificationPlanArtifactRoot: command.verificationPlanArtifactRoot,
    verificationPlanSemanticDigest: command.verificationPlanSemanticDigest,
  })) {
    if (!isDigest(value))
      throw new TypeError(`${name} must be a SHA-256 digest`);
  }
  const results: ExecutedVerificationResult[] = [];
  for (const scenario of plan.scenarios) {
    const probe = await execute(scenario);
    const result = Object.freeze({
      negativeProbeDigest:
        scenario.probePolarity === 'positiveAndNegative'
          ? digestProof(probe.negativeProbe)
          : null,
      positiveProbeDigest: digestProof(probe.positiveProbe),
      provider: 'realPostgresql' as const,
      providerRunId: command.providerRunId,
      scenarioFingerprint: scenario.scenarioFingerprint,
      scenarioId: scenario.scenarioId,
      schemaVersion: VERIFICATION_RESULT_VERSION,
    });
    results.push(result);
  }
  results.sort((left, right) => compare(left.scenarioId, right.scenarioId));
  const payload = {
    artifactClosureDigest: command.artifactClosureDigest,
    provider: 'realPostgresql' as const,
    providerRunId: command.providerRunId,
    releaseRoot: command.releaseRoot,
    results: Object.freeze(results),
    schemaVersion: resultSetVersion,
    verificationPlanArtifactRoot: command.verificationPlanArtifactRoot,
    verificationPlanDigest: digestPlan(plan),
    verificationPlanSemanticDigest: command.verificationPlanSemanticDigest,
  };
  return Object.freeze({
    ...payload,
    resultSetDigest: digestResultSet(payload),
  });
}

export function validateExecutedVerificationPlan(
  plan: VerificationPlanPayloadV1,
  resultSet: ExecutedVerificationResultSet,
  expectedBinding?: Readonly<
    Omit<VerificationExecutionCommand, 'providerRunId'>
  >,
): VerificationConformanceResult {
  const diagnostics: VerificationConformanceDiagnostic[] = [];
  const validSet =
    resultSet.schemaVersion === resultSetVersion &&
    resultSet.provider === 'realPostgresql' &&
    resultSet.providerRunId.trim() !== '' &&
    isDigest(resultSet.artifactClosureDigest) &&
    isDigest(resultSet.releaseRoot) &&
    isDigest(resultSet.verificationPlanArtifactRoot) &&
    isDigest(resultSet.verificationPlanSemanticDigest) &&
    resultSet.verificationPlanDigest === digestPlan(plan) &&
    resultSet.resultSetDigest ===
      digestResultSet({
        artifactClosureDigest: resultSet.artifactClosureDigest,
        provider: resultSet.provider,
        providerRunId: resultSet.providerRunId,
        releaseRoot: resultSet.releaseRoot,
        results: resultSet.results,
        schemaVersion: resultSet.schemaVersion,
        verificationPlanArtifactRoot: resultSet.verificationPlanArtifactRoot,
        verificationPlanDigest: resultSet.verificationPlanDigest,
        verificationPlanSemanticDigest:
          resultSet.verificationPlanSemanticDigest,
      }) &&
    (!expectedBinding ||
      (resultSet.artifactClosureDigest ===
        expectedBinding.artifactClosureDigest &&
        resultSet.releaseRoot === expectedBinding.releaseRoot &&
        resultSet.verificationPlanArtifactRoot ===
          expectedBinding.verificationPlanArtifactRoot &&
        resultSet.verificationPlanSemanticDigest ===
          expectedBinding.verificationPlanSemanticDigest));
  if (!validSet) {
    diagnostics.push({
      code: 'VERIFICATION_RESULT_SET_INVALID',
      scenarioId: '$',
    });
  }
  const scenarios = new Map(
    plan.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const resultById = new Map<string, ExecutedVerificationResult>();
  for (const result of resultSet.results) {
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
      result.providerRunId.trim() !== '' &&
      result.providerRunId === resultSet.providerRunId &&
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

function assertClosedExecutionCommand(
  command: VerificationExecutionCommand,
): void {
  const expected = [
    'artifactClosureDigest',
    'providerRunId',
    'releaseRoot',
    'verificationPlanArtifactRoot',
    'verificationPlanSemanticDigest',
  ];
  const actual = Object.keys(command).sort(compare);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      'verification execution command is closed; skip, sampling, time-box, and unknown parameters are forbidden',
    );
  }
}

function digestPlan(plan: VerificationPlanPayloadV1): string {
  return digestCanonical('northstar.verification-plan-binding/v1', plan);
}

function digestResultSet(value: unknown): string {
  return digestCanonical('northstar.verification-result-set/v1', value);
}

function digestCanonical(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalize(value), 'utf8')
    .digest('hex');
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
  return typeof value === 'string' && sha256Pattern.test(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
