import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_INVALIDATION_EVENT_CODE,
  ACTIVATION_INVALIDATION_EVENT_VERSION,
  ACTIVATION_TRANSITION_CLASSIFICATIONS,
  COMPILER_TRANSITION_FACTS_VERSION,
  DECISIVE_ACTIVATION_OUTCOME_CODES,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  ReleaseInvalidationFenceState,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  classifyActivationTransition,
  decisiveActivationOutcomeDimensions,
  evaluateTransitionCompatibility,
  shouldDiscardFenceTaggedCache,
} from '../../packages/platform-runtime/src/release-activation.js';
import type { MintedUuid } from '../../packages/platform-runtime/src/release-records.js';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

test('P4b exposes one attempt-only activation kernel with its reconciler', () => {
  const contracts = read('packages/platform-runtime/src/release-activation.ts');
  const approvalService = read(
    'packages/postgres-provider/src/release-approval-service.ts',
  );
  const activationService = read(
    'packages/postgres-provider/src/release-activation-service.ts',
  );
  const manifest = JSON.parse(
    read('packages/postgres-provider/package.json'),
  ) as { exports: Record<string, string> };
  const command = contracts.match(
    /export interface ActivateReleaseCommand \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(command);
  const commandShape = command.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    commandShape,
    /tenantId|environmentId|pointerId|releaseId|expectedFence|manifestRoot|Digest|policyVersion|authority|verdict/i,
  );
  assert.match(commandShape, /activationAttemptId: MintedUuid/);
  assert.equal(
    manifest.exports['./release-activation-service'],
    './src/release-activation-service.ts',
  );
  assert.equal(
    manifest.exports['./release-approval-service'],
    './src/release-approval-service.ts',
  );
  assert.deepEqual(
    Object.keys(manifest.exports).filter((key) =>
      /activat|rollback|reconcil|compare|cas/i.test(key),
    ),
    ['./release-activation-service'],
  );
  assert.match(approvalService, /async createApproval\(/);
  assert.match(activationService, /async activate\(/);
  assert.match(activationService, /async reconcileActivation\(/);
  assert.match(activationService, /async cancelActivation\(/);
  assert.match(activationService, /async verifyActivation\(/);
  assert.match(activationService, /readInvalidationEvent\(/);
  assert.match(activationService, /loadAttemptRecord/);
  assert.match(activationService, /loadSwapReceipt/);
  assert.match(activationService, /insertCommittedSwapFacts/);
  assert.doesNotMatch(activationService, /rollbackRelease|dispatchActivation/);
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
  assert.equal(Object.keys(ACTIVATION_TRANSITION_CLASSIFICATIONS).length, 14);
  for (const condition of [
    'STALE_POINTER',
    'EXPIRED_APPROVAL',
    'INVALID_BINDING',
    'LOST_RACE',
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

  assert.deepEqual(DECISIVE_ACTIVATION_OUTCOME_CODES, [
    'SWAPPED',
    'STALE_POINTER',
    'EXPIRED_APPROVAL',
    'INVALID_BINDING',
    'LOST_RACE',
    'OBSOLETE_POLICY',
    'DEFINITIVE_BLOCKING_FAILURE',
    'CANCELLATION',
    'APPROVER_REVOCATION',
    'PRE_CAS_POLICY_DENY',
  ]);
  assert.deepEqual(decisiveActivationOutcomeDimensions('SWAPPED'), {
    outcomeVersion: 'northstar.release-activation-outcome/v1',
    pointerOutcome: 'SWAPPED',
    terminal: false,
    verificationOutcome: 'NOT_RUN',
    workflowDisposition: 'CONSUMED',
    workflowStatus: 'RUNNING',
  });
  assert.deepEqual(decisiveActivationOutcomeDimensions('CANCELLATION'), {
    outcomeVersion: 'northstar.release-activation-outcome/v1',
    pointerOutcome: 'NOT_SWAPPED',
    terminal: true,
    verificationOutcome: 'NOT_RUN',
    workflowDisposition: 'CONSUMED',
    workflowStatus: 'CANCELLED',
  });
  for (const outcomeCode of DECISIVE_ACTIVATION_OUTCOME_CODES.filter(
    (code) => code !== 'SWAPPED' && code !== 'CANCELLATION',
  )) {
    assert.deepEqual(decisiveActivationOutcomeDimensions(outcomeCode), {
      outcomeVersion: 'northstar.release-activation-outcome/v1',
      pointerOutcome: 'NOT_SWAPPED',
      terminal: true,
      verificationOutcome: 'NOT_RUN',
      workflowDisposition: 'CONSUMED',
      workflowStatus: 'FAILED',
    });
  }
  for (const resumableCondition of [
    'INFRASTRUCTURE_ERROR',
    'TIMEOUT',
    'AMBIGUOUS_COMMIT',
    'EXECUTOR_UNAVAILABLE',
    'ROLLOUT_PAUSE',
  ]) {
    assert.equal(
      DECISIVE_ACTIVATION_OUTCOME_CODES.includes(
        resumableCondition as (typeof DECISIVE_ACTIVATION_OUTCOME_CODES)[number],
      ),
      false,
    );
  }

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

test('P5 invalidation consumer is monotonic and cache fill remains fence-tagged', () => {
  const state = new ReleaseInvalidationFenceState();
  const pointerId = 'aa000000-0000-4000-8000-000000000001' as MintedUuid;
  const baseEvent = {
    activationAttemptId: 'aa000000-0000-4000-8000-000000000002' as MintedUuid,
    deduplicationKey: 'activation:1',
    environmentId: 'aa000000-0000-4000-8000-000000000003',
    eventCode: ACTIVATION_INVALIDATION_EVENT_CODE,
    fence: 1,
    historyId: 'aa000000-0000-4000-8000-000000000004' as MintedUuid,
    newReleaseId: 'aa000000-0000-4000-8000-000000000005' as MintedUuid,
    oldReleaseId: null,
    outboxId: 'aa000000-0000-4000-8000-000000000006' as MintedUuid,
    pointerId,
    schemaVersion: ACTIVATION_INVALIDATION_EVENT_VERSION,
    tenantId: 'aa000000-0000-4000-8000-000000000007',
  } as const;

  assert.deepEqual(state.consume(baseEvent), {
    decision: 'ACCEPTED_CONTIGUOUS',
    highestFence: 1,
    requestPointerReread: false,
  });
  assert.deepEqual(state.consume(baseEvent), {
    decision: 'REJECTED_STALE_OR_DUPLICATE',
    highestFence: 1,
    requestPointerReread: false,
  });
  assert.deepEqual(
    state.consume({
      ...baseEvent,
      deduplicationKey: 'activation:3',
      fence: 3,
    }),
    {
      decision: 'ACCEPTED_GAP_REREAD_REQUIRED',
      highestFence: 3,
      requestPointerReread: true,
    },
  );
  assert.deepEqual(
    state.consume(
      { ...baseEvent, deduplicationKey: 'activation:2', fence: 2 },
      { doubt: true },
    ),
    {
      decision: 'REJECTED_STALE_OR_DUPLICATE',
      highestFence: 3,
      requestPointerReread: true,
    },
  );
  assert.equal(
    shouldDiscardFenceTaggedCache({ filledAtFence: 2, pointerId }, 3),
    true,
  );
  assert.equal(
    shouldDiscardFenceTaggedCache({ filledAtFence: 3, pointerId }, 3),
    false,
  );
});

test('raw pointer mutation is confined to the trusted kernel and migration privilege', () => {
  const providerDirectory = resolve('packages/postgres-provider/src');
  const providerFiles = readdirSync(providerDirectory).filter((name) =>
    name.endsWith('.ts'),
  );
  const activationService = read(
    'packages/postgres-provider/src/release-activation-service.ts',
  );
  const otherProductionSources = providerFiles
    .filter((name) => name !== 'release-activation-service.ts')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => read(`packages/postgres-provider/src/${name}`))
    .join('\n');
  assert.doesNotMatch(
    otherProductionSources,
    /(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+platform\.active_release_pointers/i,
  );
  assert.equal(
    [
      ...activationService.matchAll(
        /UPDATE\s+platform\.active_release_pointers/g,
      ),
    ].length,
    1,
  );
  assert.doesNotMatch(
    activationService,
    /(?:DELETE\s+FROM|INSERT\s+INTO)\s+platform\.active_release_pointers/i,
  );

  const substrate = read('db/migrations/0004_release_activation_contracts.sql');
  const kernel = read('db/migrations/0005_release_activation_kernel.sql');
  assert.match(substrate, /CREATE TRIGGER active_release_pointer_exact_swap/);
  assert.match(substrate, /NEW\.fence IS DISTINCT FROM OLD\.fence \+ 1/);
  assert.doesNotMatch(substrate, /UPDATE\s+platform\.active_release_pointers/i);
  assert.match(
    kernel,
    /GRANT UPDATE ON platform\.active_release_pointers TO north_star_runtime/,
  );
  assert.match(kernel, /release_activation_swap_receipts/);
  assert.match(kernel, /lock_release_activation_authority_epoch/);
  assert.match(kernel, /clock_timestamp\(\)/);
  assert.match(kernel, /release_executor_authority_events/);
  assert.match(kernel, /release_activation_verification_receipts/);
  assert.match(kernel, /release_activation_reconciliation_starts/);
  assert.match(kernel, /release_activation_reconciliation_alarms/);
  assert.doesNotMatch(
    kernel,
    /GRANT EXECUTE ON FUNCTION platform\.set_release_(?:approver_eligibility|executor_authority|activation_control)/,
  );
});
