import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
  MODULE_STORAGE_MIGRATION_LOCK,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
  classifyActivationTransition,
  decisiveActivationOutcomeDimensions,
  digestModuleTransitionElements,
  evaluateModuleGovernanceSeam,
  evaluatePreparedCandidateRetention,
  evaluateTransitionCompatibility,
  evaluateTransitionCompatibilityV2,
  type MintedUuid,
} from '../../packages/platform-runtime/src/index.js';
import { assertNonDestructiveStorageStatements } from '../../packages/postgres-provider/src/module-storage-materializer.js';

const root = new Uint8Array(32).fill(7);
const otherRoot = new Uint8Array(32).fill(9);
const generation = 'a1000000-0000-4000-8000-000000000001' as MintedUuid;

test('transition compatibility v2 adds schema/data dimensions without changing v1', () => {
  const v1 = evaluateTransitionCompatibility({
    compilerExactPair: true,
    compilerFactsVersion: 'northstar.compiler-transition-facts/v1',
    compilerStaticCompatibility: 'SATISFIED',
    compilerTransitionClass: 'NO_STORAGE_TRANSITION',
    executorAppliedState: 'NOT_REQUIRED',
    executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
    executorExactPair: true,
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    sourceManifestRoot: null,
    targetManifestRoot: root,
  });
  assert.equal(v1.verdict, 'ALLOW');
  assert.equal(v1.recoveryMode, 'NO_STORAGE_RECOVERY_REQUIRED');

  const v2 = evaluateTransitionCompatibilityV2({
    compilerExactPair: true,
    compilerFactsVersion: 'northstar.compiler-transition-facts/v1',
    compilerStaticCompatibility: 'SATISFIED',
    dataState: 'PENDING_IN_ATTEMPT',
    executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
    executorExactPair: true,
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
    preparedSubsetDigest: root,
    remainingPlanDigest: otherRoot,
    schemaGeneration: 1,
    schemaState: 'APPLIED',
    sourceManifestRoot: root,
    targetManifestRoot: otherRoot,
  });
  assert.equal(v2.verdict, 'ALLOW');
  assert.equal(
    evaluateTransitionCompatibilityV2({
      compilerExactPair: true,
      compilerFactsVersion: 'northstar.compiler-transition-facts/v1',
      compilerStaticCompatibility: 'SATISFIED',
      dataState: 'PENDING_IN_ATTEMPT',
      executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
      executorExactPair: false,
      policyVersion: TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
      preparedSubsetDigest: root,
      remainingPlanDigest: otherRoot,
      schemaGeneration: 1,
      schemaState: 'APPLIED',
      sourceManifestRoot: root,
      targetManifestRoot: otherRoot,
    }).verdict,
    'DENY',
  );
  assert.throws(
    () =>
      evaluateTransitionCompatibilityV2({
        compilerExactPair: true,
        compilerFactsVersion: 'northstar.compiler-transition-facts/v1',
        compilerStaticCompatibility: 'SATISFIED',
        dataState: 'APPLIED',
        executorEvidenceVersion: EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
        executorExactPair: true,
        policyVersion: TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
        preparedSubsetDigest: new Uint8Array(31),
        remainingPlanDigest: otherRoot,
        schemaGeneration: 1,
        schemaState: 'APPLIED',
        sourceManifestRoot: root,
        targetManifestRoot: otherRoot,
      }),
    /preparedSubsetDigest/,
  );
});

test('prepared and remaining receipts digest exact ordered element identities', () => {
  const first = digestModuleTransitionElements([
    {
      disposition: 'APPLIED',
      elementId: 'b',
      kind: 'createTable',
      physicalObjectName: 'b_table',
    },
    {
      disposition: 'APPLIED',
      elementId: 'a',
      kind: 'addColumn',
      physicalObjectName: 'a_column',
    },
  ]);
  const reordered = digestModuleTransitionElements([
    {
      disposition: 'PENDING_IN_ATTEMPT',
      elementId: 'a',
      kind: 'addColumn',
      physicalObjectName: 'a_column',
    },
    {
      disposition: 'PENDING_DEFERRED',
      elementId: 'b',
      kind: 'createTable',
      physicalObjectName: 'b_table',
    },
  ]);
  assert.deepEqual(first, reordered);
  assert.notDeepEqual(
    first,
    digestModuleTransitionElements([
      {
        disposition: 'APPLIED',
        elementId: 'a',
        kind: 'addColumn',
        physicalObjectName: 'different_column',
      },
    ]),
  );
});

test('destructive DDL, delete-capable callbacks, and deletion grants fail closed', () => {
  for (const kind of [
    'deleteCapableRule',
    'deleteCapableTrigger',
    'dropBusinessObject',
    'onDeleteCascade',
    'removePartition',
    'truncateTable',
  ] as const) {
    assert.throws(
      () => assertNonDestructiveStorageStatements([{ kind }]),
      /destructive storage operation rejected/,
    );
  }
  assert.doesNotThrow(() =>
    assertNonDestructiveStorageStatements([
      { kind: 'createTable' },
      { kind: 'addColumn' },
      { kind: 'addForeignKey', onDelete: 'restrict', onUpdate: 'restrict' },
    ]),
  );
});

test('retention and tenant/root governance are typed seams, never root deletion', () => {
  const expired = evaluatePreparedCandidateRetention({
    activeRoot: false,
    ancientRoot: false,
    expiresAt: '2026-01-01T00:00:00.000Z',
    generationId: generation,
    nonTerminalPreparation: false,
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(
    { action: expired.action, reason: expired.reason },
    { action: 'EXPIRE_CANDIDATE', reason: 'EXPIRED' },
  );
  const active = evaluatePreparedCandidateRetention({
    activeRoot: true,
    ancientRoot: false,
    expiresAt: '2026-01-01T00:00:00.000Z',
    generationId: generation,
    nonTerminalPreparation: false,
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(active.action, 'RETAIN');
  for (const tenantLifecycle of ['SUSPENDED', 'DECOMMISSIONED'] as const) {
    const seam = evaluateModuleGovernanceSeam({
      ancientRootIds: ['old-root'],
      environmentId: 'a2000000-0000-4000-8000-000000000002',
      tenantId: 'a1000000-0000-4000-8000-000000000001',
      tenantLifecycle,
    });
    assert.equal(seam.requiredAction, 'ISOLATE');
    assert.equal(seam.rootRemoval, 'FORBIDDEN_WITHOUT_GOVERNED_EXECUTION');
  }
});

test('materializer lock is a finite non-queueing superset of kernel ordering', () => {
  assert.equal(
    MODULE_STORAGE_MIGRATION_LOCK.key,
    'north-star:platform-migrations:v1',
  );
  assert.ok(MODULE_STORAGE_MIGRATION_LOCK.maximumRetries > 0);
  assert.ok(MODULE_STORAGE_MIGRATION_LOCK.timeoutMilliseconds <= 5_000);
  assert.match(
    MODULE_STORAGE_MIGRATION_LOCK.starvationRule,
    /kernel migrations.*priority/,
  );
});

test('materializer runtime SQL reaches the kernel only through scoped readers', () => {
  const source = readFileSync(
    'packages/postgres-provider/src/module-storage-materializer.ts',
    'utf8',
  );
  const migration = readFileSync(
    'db/migrations/0007_module_storage_transitions.sql',
    'utf8',
  );
  assert.doesNotMatch(source, /\b(?:FROM|JOIN)\s+platform\./i);
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*\bON\s+platform\.[^;]*\bTO\s+north_star_module_materializer/i,
  );
  assert.doesNotMatch(
    migration,
    /GRANT SELECT ON platform\.[^;]*TO north_star_module_materializer/i,
  );
});

test('crash classification consumes definitive mismatches and reconciles ambiguity', () => {
  const definitive = classifyActivationTransition(
    'DEFINITIVE_BLOCKING_FAILURE',
  );
  assert.deepEqual(definitive, {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  });
  const ambiguous = classifyActivationTransition('AMBIGUOUS_COMMIT');
  assert.deepEqual(ambiguous, {
    approvalDisposition: 'RETAINED',
    resumable: true,
    terminal: false,
    workflowStatus: 'RECONCILING',
  });
  assert.deepEqual(decisiveActivationOutcomeDimensions('SWAPPED'), {
    outcomeVersion: 'northstar.release-activation-outcome/v1',
    pointerOutcome: 'SWAPPED',
    terminal: false,
    verificationOutcome: 'NOT_RUN',
    workflowDisposition: 'CONSUMED',
    workflowStatus: 'RUNNING',
  });
});
