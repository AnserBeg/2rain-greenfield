import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_TRANSITION_CLASSIFICATIONS,
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  classifyActivationTransition,
  evaluateTransitionCompatibility,
} from '../../packages/platform-runtime/src/release-activation.js';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

test('P4a exports approval contracts and no callable activation kernel', () => {
  const contracts = read('packages/platform-runtime/src/release-activation.ts');
  const service = read(
    'packages/postgres-provider/src/release-approval-service.ts',
  );
  const manifest = JSON.parse(
    read('packages/postgres-provider/package.json'),
  ) as { exports: Record<string, string> };
  const command = contracts.match(
    /export interface CreateReleaseApprovalCommand \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(command);
  assert.doesNotMatch(
    command,
    /tenantId|environmentId|pointerId|expectedFence|expectedReleaseId|manifestRoot|Digest|policyVersion|authority|verdict/i,
  );
  assert.match(command, /approvalId: MintedUuid/);
  assert.match(command, /activationAttemptId: MintedUuid/);
  assert.match(command, /preparationId: MintedUuid/);
  assert.match(command, /targetReleaseId: MintedUuid/);
  assert.equal(
    manifest.exports['./release-approval-service'],
    './src/release-approval-service.ts',
  );
  assert.deepEqual(
    Object.keys(manifest.exports).filter((key) =>
      /activat|rollback|reconcil|compare|cas/i.test(key),
    ),
    [],
  );
  assert.match(service, /async createApproval\(/);
  assert.doesNotMatch(
    service,
    /\b(?:activateRelease|rollbackRelease|compareAndSwap|reconcileActivation|dispatchActivation)\b/,
  );
  assert.doesNotMatch(service, /UPDATE\s+platform\.active_release_pointers/i);
});

test('initial activation is a separate null-base contract and policy verdict', () => {
  const contracts = read('packages/platform-runtime/src/release-activation.ts');
  const compilerProtocol = read('packages/compiler/src/protocol.ts');
  const initial = contracts.match(
    /export interface InitialActivationBinding \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(initial);
  assert.match(initial, /sourceManifestRoot: null/);
  assert.match(initial, /sourceReleaseId: null/);
  assert.match(initial, /releaseDiffVersion: null/);
  assert.match(initial, /releaseDiffAlgorithmVersion: null/);
  assert.match(
    compilerProtocol,
    /interface ReleaseDiffEnvelope[\s\S]*fromManifestRoot: string/,
  );

  const digest = new Uint8Array(32);
  const allowed = evaluateTransitionCompatibility({
    compilerExactPair: true,
    compilerFactsVersion: COMPILER_TRANSITION_FACTS_VERSION,
    compilerStaticCompatibility: 'SATISFIED',
    compilerTransitionClass: 'NO_STORAGE_TRANSITION',
    executorAppliedState: 'NOT_REQUIRED',
    executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
    executorExactPair: true,
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    sourceManifestRoot: null,
    targetManifestRoot: digest,
  });
  assert.deepEqual(allowed, {
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    recoveryMode: 'NO_STORAGE_RECOVERY_REQUIRED',
    verdict: 'ALLOW',
  });

  const noOpIsNotSufficient = evaluateTransitionCompatibility({
    compilerExactPair: true,
    compilerFactsVersion: COMPILER_TRANSITION_FACTS_VERSION,
    compilerStaticCompatibility: 'SATISFIED',
    compilerTransitionClass: 'NO_STORAGE_TRANSITION',
    executorAppliedState: 'UNKNOWN',
    executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
    executorExactPair: true,
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    sourceManifestRoot: null,
    targetManifestRoot: digest,
  });
  assert.equal(noOpIsNotSufficient.verdict, 'DENY');

  const irreversibleCanBeCompatible = evaluateTransitionCompatibility({
    compilerExactPair: true,
    compilerFactsVersion: COMPILER_TRANSITION_FACTS_VERSION,
    compilerStaticCompatibility: 'SATISFIED',
    compilerTransitionClass: 'IRREVERSIBLE',
    executorAppliedState: 'APPLIED',
    executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
    executorExactPair: true,
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    sourceManifestRoot: digest,
    targetManifestRoot: digest,
  });
  assert.deepEqual(irreversibleCanBeCompatible, {
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    recoveryMode: 'FORWARD_RECOVERY_ONLY',
    verdict: 'ALLOW',
  });
});

test('transition classification is exhaustive and keeps outcome dimensions orthogonal', () => {
  assert.equal(Object.keys(ACTIVATION_TRANSITION_CLASSIFICATIONS).length, 13);
  for (const condition of [
    'STALE_POINTER',
    'EXPIRED_APPROVAL',
    'INVALID_BINDING',
    'OBSOLETE_POLICY',
    'DEFINITIVE_BLOCKING_FAILURE',
    'CANCELLATION',
    'APPROVER_REVOCATION',
    'PRE_CAS_POLICY_DENY',
  ] as const) {
    assert.deepEqual(classifyActivationTransition(condition), {
      approvalDisposition: 'CONSUMED',
      resumable: false,
      terminal: true,
      workflowStatus: condition === 'CANCELLATION' ? 'CANCELLED' : 'FAILED',
    });
  }
  for (const condition of [
    'INFRASTRUCTURE_ERROR',
    'TIMEOUT',
    'AMBIGUOUS_COMMIT',
    'EXECUTOR_UNAVAILABLE',
    'ROLLOUT_PAUSE',
  ] as const) {
    const classification = classifyActivationTransition(condition);
    assert.equal(classification.approvalDisposition, 'RETAINED');
    assert.equal(classification.resumable, true);
    assert.equal(classification.terminal, false);
  }
  assert.equal(
    classifyActivationTransition('ROLLOUT_PAUSE').workflowStatus,
    'PAUSED',
  );

  const contracts = read('packages/platform-runtime/src/release-activation.ts');
  assert.match(
    contracts,
    /type PointerOutcome =[\s\S]*'SWAPPED_THEN_SUPERSEDED'/,
  );
  assert.match(contracts, /type VerificationOutcome =/);
  assert.match(contracts, /type WorkflowDisposition =/);
  assert.match(contracts, /SYSTEM_EXECUTION_PRINCIPAL/);
  assert.match(contracts, /DenyOnlyRolloutControlResult/);
  assert.match(contracts, /ReleaseActivationOutboxEnvelope/);
});

test('production package SQL contains no pointer mutation path', () => {
  const providerDirectory = resolve('packages/postgres-provider/src');
  const productionSources = readdirSync(providerDirectory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => read(`packages/postgres-provider/src/${name}`))
    .join('\n');
  assert.doesNotMatch(
    productionSources,
    /(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+platform\.active_release_pointers/i,
  );
  assert.doesNotMatch(
    productionSources,
    /\b(?:activateRelease|rollbackRelease|compareAndSwapRelease|reconcileRelease)\b/,
  );

  const migration = read('db/migrations/0004_release_activation_contracts.sql');
  assert.match(migration, /CREATE TRIGGER active_release_pointer_exact_swap/);
  assert.match(migration, /NEW\.fence IS DISTINCT FROM OLD\.fence \+ 1/);
  assert.doesNotMatch(migration, /UPDATE\s+platform\.active_release_pointers/i);
  assert.match(
    migration,
    /GRANT SELECT, UPDATE ON platform\.active_release_pointers TO north_star_runtime/,
  );
  assert.doesNotMatch(
    migration,
    /GRANT[^;]*(?:INSERT|DELETE)[^;]*active_release_pointers/i,
  );
  assert.doesNotMatch(
    migration,
    /GRANT EXECUTE ON FUNCTION platform\.set_release_approver_eligibility/,
  );
});
