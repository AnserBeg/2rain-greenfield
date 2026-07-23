import { createHash } from 'node:crypto';

import type {
  MintedUuid,
  TenantEnvironmentIdentity,
} from './release-records.js';

export const TRANSITION_PREPARATION_RECEIPT_V2_VERSION =
  'northstar.transition-preparation-receipt/v2' as const;
export const EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION =
  'northstar.executor-applied-state-evidence/v2' as const;
export const TRANSITION_COMPATIBILITY_POLICY_V2_VERSION =
  'northstar.transition-compatibility-policy/v2' as const;
export const ACTIVATION_VERIFICATION_RECEIPT_V2_VERSION =
  'northstar.release-activation-verification/v2' as const;
export const MODULE_STORAGE_GENERATION_VERSION =
  'northstar.module-storage-generation/v1' as const;
export const MODULE_STORAGE_CATALOG_RECEIPT_VERSION =
  'northstar.module-storage-catalog-receipt/v1' as const;
export const MODULE_STORAGE_RENDERED_DIFF_VERSION =
  'northstar.module-storage-rendered-diff/v1' as const;
export const MODULE_STORAGE_RETENTION_POLICY_VERSION =
  'northstar.module-storage-prepared-retention/v1' as const;
export const MODULE_STORAGE_GOVERNANCE_SEAM_VERSION =
  'northstar.module-storage-governance-seam/v1' as const;

/** Shared exactly with kernel migrations. Materializer waiters never queue. */
export const MODULE_STORAGE_MIGRATION_LOCK = Object.freeze({
  key: 'north-star:platform-migrations:v1',
  maximumRetries: 5,
  retryDelayMilliseconds: 50,
  starvationRule:
    'a materializer contender releases its transaction and retries; queued kernel migrations therefore take priority after a running lock holder',
  timeoutMilliseconds: 5_000,
});

export type ModuleSchemaState = 'APPLIED' | 'NOT_REQUIRED';
export type ModuleDataState = 'APPLIED' | 'NOT_REQUIRED' | 'PENDING_IN_ATTEMPT';

export interface TransitionCompatibilityV2Input {
  readonly compilerExactPair: boolean;
  readonly compilerFactsVersion: string;
  readonly compilerStaticCompatibility: 'BLOCKED' | 'SATISFIED';
  readonly dataState: ModuleDataState;
  readonly executorEvidenceVersion: string;
  readonly executorExactPair: boolean;
  readonly policyVersion: string;
  readonly preparedSubsetDigest: Uint8Array;
  readonly remainingPlanDigest: Uint8Array;
  readonly schemaGeneration: number;
  readonly schemaState: ModuleSchemaState;
  readonly sourceManifestRoot: Uint8Array;
  readonly targetManifestRoot: Uint8Array;
}

export interface TransitionCompatibilityV2Decision {
  readonly policyVersion: typeof TRANSITION_COMPATIBILITY_POLICY_V2_VERSION;
  readonly recoveryMode: 'REVERSIBLE';
  readonly verdict: 'ALLOW' | 'DENY';
}

/**
 * Approval admission for a module transition. READY_TO_SWAP is deliberately
 * absent: it is fresh provider evidence evaluated by the later pointer CAS.
 */
export function evaluateTransitionCompatibilityV2(
  input: TransitionCompatibilityV2Input,
): TransitionCompatibilityV2Decision {
  if (
    input.policyVersion !== TRANSITION_COMPATIBILITY_POLICY_V2_VERSION ||
    input.executorEvidenceVersion !== EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION
  ) {
    throw new Error('unsupported transition compatibility v2 contract');
  }
  for (const [name, digest] of [
    ['sourceManifestRoot', input.sourceManifestRoot],
    ['targetManifestRoot', input.targetManifestRoot],
    ['preparedSubsetDigest', input.preparedSubsetDigest],
    ['remainingPlanDigest', input.remainingPlanDigest],
  ] as const) {
    if (digest.byteLength !== 32) {
      throw new Error(`${name} must be an exact SHA-256 digest`);
    }
  }
  if (
    !Number.isSafeInteger(input.schemaGeneration) ||
    input.schemaGeneration < 1
  ) {
    throw new Error('schemaGeneration must be a positive safe integer');
  }
  const verdict =
    input.compilerExactPair &&
    input.executorExactPair &&
    input.compilerStaticCompatibility === 'SATISFIED' &&
    input.schemaState === 'APPLIED' &&
    (input.dataState === 'PENDING_IN_ATTEMPT' ||
      input.dataState === 'APPLIED' ||
      input.dataState === 'NOT_REQUIRED')
      ? 'ALLOW'
      : 'DENY';
  return Object.freeze({
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
    recoveryMode: 'REVERSIBLE',
    verdict,
  });
}

export type ModuleTransitionElementDisposition =
  'APPLIED' | 'PENDING_DEFERRED' | 'PENDING_IN_ATTEMPT';

export interface RenderedModuleTransitionElement {
  readonly disposition: ModuleTransitionElementDisposition;
  readonly elementId: string;
  readonly kind: string;
  readonly physicalObjectName: string;
}

export interface RenderedModuleTransitionDiff {
  readonly elements: readonly RenderedModuleTransitionElement[];
  readonly version: typeof MODULE_STORAGE_RENDERED_DIFF_VERSION;
}

export function digestModuleTransitionElements(
  elements: readonly RenderedModuleTransitionElement[],
): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      [...elements]
        .map(({ elementId, kind, physicalObjectName }) => ({
          elementId,
          kind,
          physicalObjectName,
        }))
        .toSorted((left, right) =>
          left.elementId.localeCompare(right.elementId),
        ),
    ),
  );
  return new Uint8Array(
    createHash('sha256')
      .update('northstar.module-storage-element-set/v1')
      .update('\0')
      .update(bytes)
      .digest(),
  );
}

export interface ModuleStorageCatalogReceipt extends TenantEnvironmentIdentity {
  readonly catalogDigest: Uint8Array;
  readonly catalogVerified: boolean;
  readonly createdAt: string;
  readonly generationId: MintedUuid;
  readonly preparedSubsetDigest: Uint8Array;
  readonly receiptId: MintedUuid;
  readonly receiptVersion: typeof MODULE_STORAGE_CATALOG_RECEIPT_VERSION;
  readonly remainingPlanDigest: Uint8Array;
  readonly sourceManifestRoot: Uint8Array;
  readonly sourceReleaseId: MintedUuid;
  readonly state: 'DRIFT' | 'PREPARED' | 'READY_TO_SWAP' | 'RECONCILED';
  readonly targetManifestRoot: Uint8Array;
  readonly targetReleaseId: MintedUuid;
}

export interface ModulePreparedCandidateRetention {
  readonly action: 'EXPIRE_CANDIDATE' | 'RETAIN';
  readonly expiresAt: string;
  readonly generationId: MintedUuid;
  readonly reason: 'ACTIVE' | 'ANCIENT_ROOT' | 'EXPIRED' | 'NON_TERMINAL';
  readonly version: typeof MODULE_STORAGE_RETENTION_POLICY_VERSION;
}

export interface ModulePreparedCandidateRetentionInput {
  readonly activeRoot: boolean;
  readonly ancientRoot: boolean;
  readonly expiresAt: string;
  readonly generationId: MintedUuid;
  readonly nonTerminalPreparation: boolean;
  readonly observedAt: string;
}

export function evaluatePreparedCandidateRetention(
  input: ModulePreparedCandidateRetentionInput,
): ModulePreparedCandidateRetention {
  const expiresAt = Date.parse(input.expiresAt);
  const observedAt = Date.parse(input.observedAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(observedAt)) {
    throw new Error('retention timestamps must be valid ISO-8601 instants');
  }
  const reason = input.activeRoot
    ? 'ACTIVE'
    : input.nonTerminalPreparation
      ? 'NON_TERMINAL'
      : input.ancientRoot
        ? 'ANCIENT_ROOT'
        : expiresAt <= observedAt
          ? 'EXPIRED'
          : 'NON_TERMINAL';
  return Object.freeze({
    action: reason === 'EXPIRED' ? 'EXPIRE_CANDIDATE' : 'RETAIN',
    expiresAt: input.expiresAt,
    generationId: input.generationId,
    reason,
    version: MODULE_STORAGE_RETENTION_POLICY_VERSION,
  });
}

export type ModuleTenantLifecycle = 'ACTIVE' | 'DECOMMISSIONED' | 'SUSPENDED';

export interface ModuleStorageGovernanceSeam extends TenantEnvironmentIdentity {
  readonly ancientRootIds: readonly string[];
  readonly requiredAction: 'ISOLATE' | 'MIGRATE' | 'NONE';
  readonly rootRemoval: 'FORBIDDEN_WITHOUT_GOVERNED_EXECUTION';
  readonly tenantLifecycle: ModuleTenantLifecycle;
  readonly version: typeof MODULE_STORAGE_GOVERNANCE_SEAM_VERSION;
}

export function evaluateModuleGovernanceSeam(
  input: Omit<
    ModuleStorageGovernanceSeam,
    'requiredAction' | 'rootRemoval' | 'version'
  >,
): ModuleStorageGovernanceSeam {
  const requiredAction =
    input.tenantLifecycle === 'DECOMMISSIONED' ||
    input.tenantLifecycle === 'SUSPENDED'
      ? 'ISOLATE'
      : input.ancientRootIds.length > 0
        ? 'MIGRATE'
        : 'NONE';
  return Object.freeze({
    ...input,
    ancientRootIds: Object.freeze([...input.ancientRootIds]),
    requiredAction,
    rootRemoval: 'FORBIDDEN_WITHOUT_GOVERNED_EXECUTION',
    version: MODULE_STORAGE_GOVERNANCE_SEAM_VERSION,
  });
}
