import { canonicalize } from '@north-star/canonical-model';
import { createHash } from 'node:crypto';

import {
  VERIFICATION_DERIVATION_VERSION,
  VERIFICATION_PARTITIONED_RESULT_SET_VERSION,
  VERIFICATION_RESULT_SET_VERSION,
  VERIFICATION_RESULT_VERSION,
} from './protocol.js';
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

export interface FullyExecutedVerificationResultSet {
  readonly artifactClosureDigest: string;
  readonly provider: 'realPostgresql';
  readonly providerRunId: string;
  readonly releaseRoot: string;
  readonly resultSetDigest: string;
  readonly results: readonly ExecutedVerificationResult[];
  readonly schemaVersion: typeof VERIFICATION_RESULT_SET_VERSION;
  readonly verificationPlanArtifactRoot: string;
  readonly verificationPlanDigest: string;
  readonly verificationPlanSemanticDigest: string;
}

export type VerificationDerivationReason =
  | Readonly<{
      code: 'VERIFICATION_NO_GENERIC_CREATE_OPERATION';
      entityId: string;
      message: string;
    }>
  | Readonly<{
      code: 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE';
      entityId: string;
      message: string;
      operationId: string;
      requiredStorageColumn: string;
    }>;

export interface VerificationScenarioDerivation {
  readonly reason: VerificationDerivationReason;
  readonly scenarioFingerprint: string;
  readonly scenarioId: string;
  readonly schemaVersion: typeof VERIFICATION_DERIVATION_VERSION;
}

export interface PartitionedVerificationResultSet {
  readonly artifactClosureDigest: string;
  readonly derivations: readonly VerificationScenarioDerivation[];
  readonly provider: 'realPostgresql';
  readonly providerRunId: string;
  readonly releaseRoot: string;
  readonly resultSetDigest: string;
  readonly results: readonly ExecutedVerificationResult[];
  readonly schemaVersion: typeof VERIFICATION_PARTITIONED_RESULT_SET_VERSION;
  readonly verificationPlanArtifactRoot: string;
  readonly verificationPlanDigest: string;
  readonly verificationPlanSemanticDigest: string;
}

export type ExecutedVerificationResultSet =
  FullyExecutedVerificationResultSet | PartitionedVerificationResultSet;

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

export type VerificationScenarioDeriver = (
  scenario: VerificationScenario,
) =>
  | Promise<VerificationDerivationReason | null>
  | VerificationDerivationReason
  | null;

export interface VerificationConformanceDiagnostic {
  readonly code:
    | 'VERIFICATION_EXECUTED_RESULT_DUPLICATE'
    | 'VERIFICATION_EXECUTED_RESULT_INVALID'
    | 'VERIFICATION_EXECUTED_RESULT_MISSING'
    | 'VERIFICATION_EXECUTED_RESULT_UNDECLARED'
    | 'VERIFICATION_DERIVATION_DUPLICATE'
    | 'VERIFICATION_DERIVATION_INVALID'
    | 'VERIFICATION_DERIVATION_UNDECLARED'
    | 'VERIFICATION_RESULT_SET_INVALID'
    | 'VERIFICATION_SCENARIO_DISPOSITION_MISSING'
    | 'VERIFICATION_SCENARIO_DISPOSITION_OVERLAP';
  readonly scenarioId: string;
}

export interface VerificationConformanceResult {
  readonly diagnostics: readonly VerificationConformanceDiagnostic[];
  readonly status: 'failed' | 'passed';
}

const sha256Pattern = /^[0-9a-f]{64}$/u;

export function executeVerificationPlan(
  plan: VerificationPlanPayloadV1,
  command: VerificationExecutionCommand,
  execute: VerificationScenarioExecutor,
  derive: VerificationScenarioDeriver,
): Promise<PartitionedVerificationResultSet>;
export function executeVerificationPlan(
  plan: VerificationPlanPayloadV1,
  command: VerificationExecutionCommand,
  execute: VerificationScenarioExecutor,
): Promise<FullyExecutedVerificationResultSet>;
export async function executeVerificationPlan(
  plan: VerificationPlanPayloadV1,
  command: VerificationExecutionCommand,
  execute: VerificationScenarioExecutor,
  derive?: VerificationScenarioDeriver,
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
  const derivations: VerificationScenarioDerivation[] = [];
  for (const scenario of plan.scenarios) {
    if (derive) {
      const reason = await derive(scenario);
      if (reason !== null) {
        derivations.push(verificationDerivation(scenario, reason));
        continue;
      }
    }
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
  derivations.sort((left, right) => compare(left.scenarioId, right.scenarioId));
  const common = {
    artifactClosureDigest: command.artifactClosureDigest,
    provider: 'realPostgresql' as const,
    providerRunId: command.providerRunId,
    releaseRoot: command.releaseRoot,
    results: Object.freeze(results),
    verificationPlanArtifactRoot: command.verificationPlanArtifactRoot,
    verificationPlanDigest: digestPlan(plan),
    verificationPlanSemanticDigest: command.verificationPlanSemanticDigest,
  };
  if (derive) {
    if (derivations.length === 0) {
      throw new TypeError(
        'partitioned verification requires at least one per-scenario derivation; use full execution when every scenario executes',
      );
    }
    const payload = {
      ...common,
      derivations: Object.freeze(derivations),
      schemaVersion: VERIFICATION_PARTITIONED_RESULT_SET_VERSION,
    };
    return Object.freeze({
      ...payload,
      resultSetDigest: digestResultSet(payload),
    });
  }
  const payload = {
    ...common,
    schemaVersion: VERIFICATION_RESULT_SET_VERSION,
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
  const partitioned =
    resultSet.schemaVersion === VERIFICATION_PARTITIONED_RESULT_SET_VERSION;
  const results = Array.isArray(resultSet.results) ? resultSet.results : [];
  const derivations =
    partitioned && Array.isArray(resultSet.derivations)
      ? resultSet.derivations
      : [];
  const digestPayload = partitioned
    ? {
        artifactClosureDigest: resultSet.artifactClosureDigest,
        derivations,
        provider: resultSet.provider,
        providerRunId: resultSet.providerRunId,
        releaseRoot: resultSet.releaseRoot,
        results,
        schemaVersion: resultSet.schemaVersion,
        verificationPlanArtifactRoot: resultSet.verificationPlanArtifactRoot,
        verificationPlanDigest: resultSet.verificationPlanDigest,
        verificationPlanSemanticDigest:
          resultSet.verificationPlanSemanticDigest,
      }
    : {
        artifactClosureDigest: resultSet.artifactClosureDigest,
        provider: resultSet.provider,
        providerRunId: resultSet.providerRunId,
        releaseRoot: resultSet.releaseRoot,
        results,
        schemaVersion: resultSet.schemaVersion,
        verificationPlanArtifactRoot: resultSet.verificationPlanArtifactRoot,
        verificationPlanDigest: resultSet.verificationPlanDigest,
        verificationPlanSemanticDigest:
          resultSet.verificationPlanSemanticDigest,
      };
  const validSet =
    hasExactKeys(
      resultSet,
      partitioned
        ? [
            'artifactClosureDigest',
            'derivations',
            'provider',
            'providerRunId',
            'releaseRoot',
            'resultSetDigest',
            'results',
            'schemaVersion',
            'verificationPlanArtifactRoot',
            'verificationPlanDigest',
            'verificationPlanSemanticDigest',
          ]
        : [
            'artifactClosureDigest',
            'provider',
            'providerRunId',
            'releaseRoot',
            'resultSetDigest',
            'results',
            'schemaVersion',
            'verificationPlanArtifactRoot',
            'verificationPlanDigest',
            'verificationPlanSemanticDigest',
          ],
    ) &&
    (partitioned ||
      resultSet.schemaVersion === VERIFICATION_RESULT_SET_VERSION) &&
    Array.isArray(resultSet.results) &&
    (!partitioned ||
      (Array.isArray(resultSet.derivations) && derivations.length > 0)) &&
    resultSet.provider === 'realPostgresql' &&
    resultSet.providerRunId.trim() !== '' &&
    isDigest(resultSet.artifactClosureDigest) &&
    isDigest(resultSet.releaseRoot) &&
    isDigest(resultSet.verificationPlanArtifactRoot) &&
    isDigest(resultSet.verificationPlanSemanticDigest) &&
    resultSet.verificationPlanDigest === digestPlan(plan) &&
    resultSet.resultSetDigest === digestResultSet(digestPayload) &&
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
  const derivationById = new Map<string, VerificationScenarioDerivation>();
  for (const derivation of derivations) {
    if (derivationById.has(derivation.scenarioId)) {
      diagnostics.push({
        code: 'VERIFICATION_DERIVATION_DUPLICATE',
        scenarioId: derivation.scenarioId,
      });
      continue;
    }
    derivationById.set(derivation.scenarioId, derivation);
    if (!scenarios.has(derivation.scenarioId)) {
      diagnostics.push({
        code: 'VERIFICATION_DERIVATION_UNDECLARED',
        scenarioId: derivation.scenarioId,
      });
    }
  }
  for (const scenario of plan.scenarios) {
    const result = resultById.get(scenario.scenarioId);
    const derivation = derivationById.get(scenario.scenarioId);
    if (!partitioned && !result) {
      diagnostics.push({
        code: 'VERIFICATION_EXECUTED_RESULT_MISSING',
        scenarioId: scenario.scenarioId,
      });
      continue;
    }
    if (partitioned && result && derivation) {
      diagnostics.push({
        code: 'VERIFICATION_SCENARIO_DISPOSITION_OVERLAP',
        scenarioId: scenario.scenarioId,
      });
    } else if (partitioned && !result && !derivation) {
      diagnostics.push({
        code: 'VERIFICATION_SCENARIO_DISPOSITION_MISSING',
        scenarioId: scenario.scenarioId,
      });
    }
    if (result && !validExecutedResult(result, scenario, resultSet)) {
      diagnostics.push({
        code: 'VERIFICATION_EXECUTED_RESULT_INVALID',
        scenarioId: scenario.scenarioId,
      });
    }
    if (derivation && !validDerivation(derivation, scenario)) {
      diagnostics.push({
        code: 'VERIFICATION_DERIVATION_INVALID',
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

function verificationDerivation(
  scenario: VerificationScenario,
  reason: VerificationDerivationReason,
): VerificationScenarioDerivation {
  if (!validDerivationReason(reason, scenario.entityId)) {
    throw new TypeError(
      `verification derivation is invalid for scenario ${scenario.scenarioId}`,
    );
  }
  return Object.freeze({
    reason: Object.freeze({ ...reason }),
    scenarioFingerprint: scenario.scenarioFingerprint,
    scenarioId: scenario.scenarioId,
    schemaVersion: VERIFICATION_DERIVATION_VERSION,
  });
}

function validExecutedResult(
  result: ExecutedVerificationResult,
  scenario: VerificationScenario,
  resultSet: ExecutedVerificationResultSet,
): boolean {
  return (
    result.schemaVersion === VERIFICATION_RESULT_VERSION &&
    result.provider === 'realPostgresql' &&
    result.providerRunId.trim() !== '' &&
    result.providerRunId === resultSet.providerRunId &&
    result.scenarioFingerprint === scenario.scenarioFingerprint &&
    isDigest(result.positiveProbeDigest) &&
    (scenario.probePolarity === 'positiveAndNegative'
      ? isDigest(result.negativeProbeDigest)
      : result.negativeProbeDigest === null)
  );
}

function validDerivation(
  derivation: VerificationScenarioDerivation,
  scenario: VerificationScenario,
): boolean {
  return (
    hasExactKeys(derivation, [
      'reason',
      'scenarioFingerprint',
      'scenarioId',
      'schemaVersion',
    ]) &&
    derivation.schemaVersion === VERIFICATION_DERIVATION_VERSION &&
    derivation.scenarioId === scenario.scenarioId &&
    derivation.scenarioFingerprint === scenario.scenarioFingerprint &&
    validDerivationReason(derivation.reason, scenario.entityId)
  );
}

function validDerivationReason(
  reason: unknown,
  scenarioEntityId: string,
): reason is VerificationDerivationReason {
  if (
    typeof reason !== 'object' ||
    reason === null ||
    !('code' in reason) ||
    !('entityId' in reason) ||
    !('message' in reason) ||
    reason.entityId !== scenarioEntityId ||
    typeof reason.message !== 'string' ||
    reason.message.trim() === ''
  ) {
    return false;
  }
  if (reason.code === 'VERIFICATION_NO_GENERIC_CREATE_OPERATION') {
    return hasExactKeys(reason, ['code', 'entityId', 'message']);
  }
  return (
    reason.code === 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE' &&
    'operationId' in reason &&
    'requiredStorageColumn' in reason &&
    hasExactKeys(reason, [
      'code',
      'entityId',
      'message',
      'operationId',
      'requiredStorageColumn',
    ]) &&
    typeof reason.operationId === 'string' &&
    reason.operationId.trim() !== '' &&
    typeof reason.requiredStorageColumn === 'string' &&
    reason.requiredStorageColumn.trim() !== ''
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compare);
  const orderedExpected = [...expected].sort(compare);
  return (
    actual.length === orderedExpected.length &&
    actual.every((key, index) => key === orderedExpected[index])
  );
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

function digestResultSet(value: Readonly<{ schemaVersion: string }>): string {
  return digestCanonical(value.schemaVersion, value);
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
