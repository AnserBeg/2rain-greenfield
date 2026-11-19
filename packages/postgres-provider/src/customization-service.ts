import { verifiedGenerationsSql } from './verified-release-generation.js';
import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalAuthoredProjection,
  canonicalize,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  compileInSandbox,
  CUSTOMIZATION_PATCH_VERSION,
  parseCustomizationPatch,
  parseSerializedRelease,
  serializeRelease,
  renderedDiffDigest,
  storageElements,
  customizationTargets,
  draftPatchFromRequest,
  type AcknowledgementInput,
  type DraftingModel,
  type CustomizationTargets,
  type CustomizationPatch,
  SandboxFailure,
  type SandboxRunnerOptions,
  type SandboxStep,
} from '@north-star/customization';
import {
  compilerAttestationFromManifest,
  type ReleaseManifestEnvelope,
  type ContentAddressedArtifact,
} from '@north-star/compiler';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import pg from 'pg';

import type { PostgresCapabilityOperationExecutorFactory } from './capability-operation-executor-factory.js';
import {
  activateWithExactSwapTrigger,
  PersistedReleaseConflict,
  reconcileInventoryScopeToPointer,
  withReleaseScopeLock,
  approveModuleRelease,
  approveReleaseWithoutStorageTransition,
  assertExactSwapTriggerEnabled,
  ensurePersistedRelease,
  ensureReleaseAdmitted,
  ensureScope,
  migrate,
  parseCompiledApplication,
  provisionLocalDemoReleaseAuthorization,
  readPointer,
  readVerifiedServing,
  releaseDiffBinding,
  rolePool,
  trustedContext,
  type ParsedRelease,
  type PersistedReleaseIdentity,
  type ScopeIdentities,
} from './composed-application-runtime.js';
import {
  CustomizationLineageError,
  readCustomizationLineage,
} from './customization-lineage.js';
import type { ModuleProviderErrorMapping } from './module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from './module-storage-materializer.js';
import { PostgresReleaseActivationService } from './release-activation-service.js';
import {
  authorizeReverseTransitionIfApplicable,
  ReleaseReverseTransitionRefusal,
} from './release-reverse-transition-policy.js';
import { withTrustedRequestTransaction } from './request-context.js';

/**
 * Tenant customization over the composed application (CUSTOMIZE packet). A
 * typed patch becomes an append-only patch record (ADR-0013), a tenant-authored
 * child revision of the active one, a staged release compiled in the isolated
 * worker, and a plain-language diff. Nothing here activates anything: drafting
 * changes no pointer and no serving state.
 */
export type { CustomizationTargets } from '@north-star/customization';

export const AUTHORING_CHANNELS = [
  'firstPartyAuthoring',
  'visualBuilder',
  'conversationalAi',
  'importTemplate',
  'declarativeEditor',
] as const;
export type AuthoringChannel = (typeof AUTHORING_CHANNELS)[number];

const UPGRADE_PATCH_KINDS: ReadonlySet<string> = new Set([
  'addField',
  'arrangeLayout',
  'saveListView',
  'addMetricCard',
]);

export type CustomizationRefusalCode =
  | 'CUSTOMIZE_NOT_STARTED'
  | 'CUSTOMIZE_BASE_STALE'
  | 'CUSTOMIZE_BASE_MOVED'
  | 'CUSTOMIZE_ACTIVE_RELEASE_UNKNOWN'
  | 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE'
  | 'CUSTOMIZE_CHANGE_NOT_FOUND'
  | 'CUSTOMIZE_DRAFT_STALE'
  | 'CUSTOMIZE_NOT_APPROVED'
  | 'CUSTOMIZE_ALREADY_ACTIVE'
  | 'CUSTOMIZE_NOTHING_TO_ROLL_BACK'
  | 'CUSTOMIZE_ACTIVATION_FAILED'
  | 'CUSTOMIZE_ACTIVATION_UNVERIFIED'
  | 'CUSTOMIZE_RELEASE_REVISION_CONFLICT'
  | 'CUSTOMIZE_ROLLBACK_NOT_REVERSIBLE';

export class CustomizationServiceRefusal extends Error {
  override readonly name = 'CustomizationServiceRefusal';
  constructor(
    readonly code: CustomizationRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CustomizationServiceOptions {
  readonly acknowledgement: AcknowledgementInput;
  /** The checked-in first-party lineage (`app.compiled.json`). */
  readonly compiledApplication: unknown;
  /** The first-party authored package (`app.authored.json`). */
  readonly firstPartyAuthored: Readonly<Record<string, unknown>>;
  readonly sandbox?: SandboxRunnerOptions;
  /** Verification of a candidate runs the same executors serving does. */
  readonly capabilityOperationExecutorFactories?: readonly PostgresCapabilityOperationExecutorFactory[];
  readonly providerErrorMappings?: readonly ModuleProviderErrorMapping[];
  /**
   * The local demo's full-release roles receive a tenant release's new
   * permissions at activation, exactly as boot grants first-party ones.
   */
  readonly localDemoIdentity?: true;
  /**
   * The model a plain-English request is drafted with (slice 4); opened on
   * first use, so a missing key fails only that request.
   */
  readonly draftingModel?: () => Promise<DraftingModel>;
  /**
   * Test seam: runs after a swap and before the inventory scope reconcile,
   * while the release-scope lock is held.
   */
  readonly afterSwapBeforeScope?: () => Promise<void>;
  /**
   * Test seam: the activation kernel a swap runs through (default: the
   * PostgreSQL kernel over the runtime pool). A test cuts it between the
   * pointer swap and its verification.
   */
  readonly activationKernel?: (
    runtimePool: pg.Pool,
  ) => PostgresReleaseActivationService;
}

export interface CustomizationConnection {
  readonly adminPool: pg.Pool;
  readonly identities: ScopeIdentities;
  readonly materializerPool: pg.Pool;
  readonly modulePool: pg.Pool;
  readonly runtimePool: pg.Pool;
}

export interface ApprovalOutcome {
  readonly activationAttemptId: MintedUuid;
  readonly renderedDiff: string;
  readonly status: 'approved';
}

export interface ActivationOutcome {
  readonly releaseId: MintedUuid;
  readonly releaseRoot: string;
  readonly status: 'activated' | 'rolledBack';
}

export type DraftOutcome =
  | {
      readonly canonicalDiffDigest: string;
      readonly patchId: MintedUuid;
      readonly releaseId: MintedUuid;
      readonly releaseRoot: string;
      readonly renderedDigest: string;
      readonly renderedDiff: string;
      readonly revisionId: MintedUuid;
      readonly reused: boolean;
      readonly status: 'drafted';
    }
  | {
      readonly code?: string;
      readonly issues?: readonly string[];
      readonly message: string;
      readonly missingCapability?: string;
      readonly status: 'invalid' | 'refused' | 'rejected' | 'unsupported';
    };

export interface PatchRecord {
  readonly compilerAcknowledgement?: AcknowledgementInput | null;
  readonly baseReleaseRoot: string;
  readonly channel: AuthoringChannel;
  readonly createdAt: string;
  readonly kind: string;
  readonly displayLabel: string | null;
  readonly payloadDigest: string;
  readonly parentRevisionId: MintedUuid;
  readonly patchId: MintedUuid;
  readonly resultingReleaseId: MintedUuid;
  readonly resultingReleaseRoot: string;
  readonly resultingRevisionId: MintedUuid;
}

export type PatchState = 'live' | 'approved' | 'drafted' | 'stale';

export interface UpgradeRecord {
  readonly compilerAcknowledgement?: AcknowledgementInput | null;
  readonly upgradeId: MintedUuid;
  readonly sourceReleaseId: MintedUuid;
  readonly baseReleaseId: MintedUuid;
  readonly candidateReleaseId: MintedUuid;
  readonly candidateRevisionId: MintedUuid;
  readonly patchIds: readonly MintedUuid[];
}

export type UpgradePreparation =
  | { readonly status: 'current' }
  | {
      readonly status: 'drafted';
      readonly upgradeId: MintedUuid;
      readonly renderedDiff: string;
      readonly releaseRoot: string;
    }
  | Exclude<DraftOutcome, { status: 'drafted' }>;

type UpgradeRefusal = Exclude<
  UpgradePreparation,
  { status: 'drafted' | 'current' }
> & {
  readonly code: string;
  readonly sourceReleaseId: MintedUuid;
  readonly baseReleaseRoot: string;
};
/** Only opaque release and change identities leave the tenant review channel. */
export function upgradeLogFields(upgrade: UpgradePreparation) {
  if (upgrade.status === 'drafted')
    return {
      status: upgrade.status,
      upgradeId: upgrade.upgradeId,
      releaseRoot: upgrade.releaseRoot,
    };
  if (upgrade.status === 'current') return { status: upgrade.status };
  return {
    status: upgrade.status,
    code: upgrade.code,
    ...('sourceReleaseId' in upgrade
      ? { sourceReleaseId: upgrade.sourceReleaseId }
      : {}),
    ...('baseReleaseRoot' in upgrade
      ? { baseReleaseRoot: upgrade.baseReleaseRoot }
      : {}),
  };
}

export async function recordUpgradeRefusal(
  pool: pg.Pool,
  context: TrustedRequestContext,
  diagnostic: UpgradeRefusal,
): Promise<UpgradeRefusal> {
  await withTrustedRequestTransaction(pool, context, (client) =>
    client.query(
      `INSERT INTO platform.customization_upgrade_refusals
          (tenant_id, environment_id, source_release_id, base_root, diagnostic) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id, environment_id, source_release_id, base_root)
          DO UPDATE SET diagnostic = EXCLUDED.diagnostic, recorded_at = clock_timestamp(), resolved = false
          WHERE customization_upgrade_refusals.diagnostic IS DISTINCT FROM EXCLUDED.diagnostic OR customization_upgrade_refusals.resolved`,
      [
        context.tenantId,
        context.environmentId,
        diagnostic.sourceReleaseId,
        diagnostic.baseReleaseRoot,
        diagnostic,
      ],
    ),
  );
  return diagnostic;
}

export interface CustomizationStatus {
  readonly failedActivation?: {
    readonly attemptId: MintedUuid;
    readonly fence: string;
  };
  readonly rollbackAvailable: boolean;
  readonly historyUnavailable?: true;
  readonly activeFence: number;
  readonly upgradeRefusal: UpgradeRefusal | null;
  readonly activeReleaseId: MintedUuid;
  readonly activeReleaseRoot: string;
  /** Applied patches of the active release, oldest first. */
  readonly activeChain: readonly PatchRecord[];
  readonly patches: readonly (PatchRecord & { readonly state: PatchState })[];
  readonly upgrades: readonly (UpgradeRecord & {
    readonly state: PatchState;
  })[];
}

interface ReleaseState {
  readonly parentReleaseId: MintedUuid | null;
  readonly upgradeFence: string | null;
  readonly baseReleaseId: MintedUuid;
  readonly upgrade: UpgradeRecord | null;
  readonly chain: readonly PatchRecord[];
  readonly releaseId: MintedUuid;
  readonly releaseRoot: string;
  readonly revisionId: MintedUuid;
}

interface ActiveState extends ReleaseState {
  readonly pointer: Awaited<ReturnType<typeof readPointer>>;
}

export class PostgresCustomizationService {
  readonly #tip: ParsedRelease;

  #runtimeContext: TrustedRequestContext | undefined;

  constructor(
    private readonly connection: CustomizationConnection,
    private readonly options: CustomizationServiceOptions,
  ) {
    this.#tip = parseCompiledApplication(
      options.compiledApplication,
    ).application;
  }

  /** Boot stages a replay against the new base, under the same scope lock as
   * approval and activation. Serving continues on the recorded live pointer. */
  async prepareUpgrade(): Promise<UpgradePreparation> {
    const context = await this.#context();
    return withReleaseScopeLock(
      this.connection.adminPool,
      this.connection.identities.runtime,
      async (admin) => {
        const pointer = await readPointer(this.connection.runtimePool, context);
        if (!pointer.releaseId)
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_NOT_STARTED',
            'there is no live release',
          );
        const sourceReleaseId = pointer.releaseId;
        let result: UpgradePreparation;
        try {
          await this.#repair(admin, context);
          const state = await this.#state(context, sourceReleaseId);
          result = await this.#prepareReplay(context, state);
        } catch (error) {
          const known =
            error instanceof CustomizationServiceRefusal ||
            error instanceof CustomizationLineageError ||
            error instanceof SandboxFailure ||
            error instanceof PersistedReleaseConflict;
          result = {
            status: 'refused',
            code: known ? error.code : 'CUSTOMIZE_UPGRADE_FAILED',
            message: known
              ? error.message
              : 'The platform upgrade could not be prepared.',
          };
        }
        const baseReleaseRoot = this.#tip.compiled.releaseRoot;
        if (result.status === 'current' || result.status === 'drafted') {
          await withTrustedRequestTransaction(
            this.connection.runtimePool,
            context,
            (client) =>
              client.query(
                `UPDATE platform.customization_upgrade_refusals SET resolved = true WHERE tenant_id = $1 AND environment_id = $2 AND source_release_id = $3 AND base_root = $4 AND NOT resolved`,
                [
                  context.tenantId,
                  context.environmentId,
                  sourceReleaseId,
                  baseReleaseRoot,
                ],
              ),
          );
          return result;
        }
        const diagnostic: UpgradeRefusal = {
          ...result,
          code: result.code ?? 'CUSTOMIZE_UPGRADE_FAILED',
          sourceReleaseId,
          baseReleaseRoot,
        };
        return recordUpgradeRefusal(
          this.connection.runtimePool,
          context,
          diagnostic,
        );
      },
    );
  }

  async #prepareReplay(
    context: TrustedRequestContext,
    active: ReleaseState,
  ): Promise<UpgradePreparation> {
    const baseReleaseId = await this.#releaseIdForRoot(
      context,
      this.#tip.compiled.releaseRoot,
    );
    if (active.baseReleaseId === baseReleaseId)
      return { status: 'current' as const };
    if (!baseReleaseId || !active.chain.length)
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_MOVED',
        'The platform upgrade has no recorded base or patch chain.',
      );
    const unsupported = active.chain.find(
      (record) => !UPGRADE_PATCH_KINDS.has(record.kind),
    );
    if (unsupported)
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_MOVED',
        `The platform upgrade cannot replay ${unsupported.kind} (change ${unsupported.patchId}).`,
      );
    this.#assertAuthoredBase();
    const sourceBase = parseNormalizedApplicationPackageJson(
      (await this.#loadRelease(context, active.baseReleaseId))
        .normalizedDefinitionBytes,
    );
    const targetBase = parseNormalizedApplicationPackageJson(
      this.#tip.normalizedDefinitionBytes,
    );
    if (
      sourceBase.package.packageId !== targetBase.package.packageId ||
      sourceBase.languageVersion !== targetBase.languageVersion ||
      sourceBase.normalizationProfileVersion !==
        targetBase.normalizationProfileVersion
    ) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_MOVED',
        'the upgrade changes the package or language identity',
      );
    }
    const source = (await this.#reproduce(context, active)).candidate;
    const replay = await this.#compile(
      await this.#readPatches(context, active.chain),
      this.#tip,
      source,
      0,
      true,
    );
    if (replay.status !== 'compiled') return replay;
    const step = replay.steps[0]!;
    const candidate = parseSerializedRelease(step.release);
    const existing = (await this.#upgrades(context)).find(
      (record) =>
        record.sourceReleaseId === active.releaseId &&
        record.baseReleaseId === baseReleaseId,
    );
    if (existing) {
      if (
        (await this.#root(context, existing.candidateReleaseId)) !==
        candidate.compiled.releaseRoot
      ) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
          'the recorded upgrade no longer reproduces',
        );
      }
      return {
        status: 'drafted' as const,
        upgradeId: existing.upgradeId,
        renderedDiff: step.rendered.text,
        releaseRoot: candidate.compiled.releaseRoot,
      };
    }
    const identity = await ensurePersistedRelease(
      this.connection.runtimePool,
      context,
      candidate,
      active.revisionId,
      'tenantAuthored',
    );
    const upgradeId = randomUUID() as MintedUuid;
    const payload = Buffer.from(
      canonicalize({
        version: 'northstar.customization-upgrade/v1',
        sourceReleaseId: active.releaseId,
        baseReleaseId,
        candidateReleaseId: identity.releaseId,
        candidateRevisionId: identity.revisionId,
        patchIds: active.chain.map((record) => record.patchId),
      }),
    );
    await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        await client.query(
          `INSERT INTO platform.customization_upgrades (
            tenant_id, environment_id, upgrade_id, source_release_id, base_release_id,
            candidate_release_id, candidate_revision_id, payload, payload_digest, authored_by, compiler_acknowledgement
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            context.tenantId,
            context.environmentId,
            upgradeId,
            active.releaseId,
            baseReleaseId,
            identity.releaseId,
            identity.revisionId,
            payload,
            createHash('sha256').update(payload).digest('hex'),
            context.principalId,
            this.options.acknowledgement,
          ],
        );
      },
    );
    return {
      status: 'drafted' as const,
      upgradeId,
      renderedDiff: step.rendered.text,
      releaseRoot: candidate.compiled.releaseRoot,
    };
  }

  async #upgrades(
    context: TrustedRequestContext,
  ): Promise<readonly UpgradeRecord[]> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<UpgradeRow>(
          'SELECT * FROM platform.customization_upgrades WHERE tenant_id = $1 AND environment_id = $2 ORDER BY created_at, upgrade_id',
          [context.tenantId, context.environmentId],
        );
        if (!result.rowCount) return [];
        const patches = await client.query<{ patch_id: MintedUuid }>(
          'SELECT patch_id FROM platform.customization_patches WHERE tenant_id=$1 AND environment_id=$2',
          [context.tenantId, context.environmentId],
        );
        const scoped = new Set(patches.rows.map((patch) => patch.patch_id));
        return result.rows.flatMap((row) => {
          const record = parseUpgradeRecord(row);
          return record?.patchIds.every((id) => scoped.has(id)) ? [record] : [];
        });
      },
    );
  }

  async #currentSwap(context: TrustedRequestContext) {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{
          activation_attempt_id: MintedUuid;
          activated_release_id: MintedUuid;
          previous_release_id: MintedUuid | null;
          pointer_id: MintedUuid;
          fence: string;
          failed: boolean;
          canonical_diff_digest: Buffer;
          target_manifest_root: Buffer;
        }>(
          `SELECT swap.activation_attempt_id, swap.activated_release_id, swap.previous_release_id, swap.pointer_id, swap.fence,
                approval.canonical_diff_digest, approval.target_manifest_root,
                EXISTS (SELECT 1 FROM platform.release_activation_verification_receipts AS v
                    WHERE (v.tenant_id, v.environment_id, v.activation_attempt_id, v.pointer_id, v.activated_release_id, v.fence)
                        = (swap.tenant_id, swap.environment_id, swap.activation_attempt_id, swap.pointer_id, swap.activated_release_id, swap.fence)
                      AND v.status = 'SWAPPED_VERIFICATION_FAILED')
                AND NOT EXISTS (SELECT 1 FROM ${verifiedGenerationsSql} AS generation
                    WHERE generation.tenant_id=swap.tenant_id AND generation.environment_id=swap.environment_id
                      AND generation.activation_attempt_id=swap.activation_attempt_id) AS failed
           FROM platform.active_release_pointers AS physical
           JOIN platform.release_activation_swap_receipts AS swap USING (tenant_id, environment_id, pointer_id, fence)
           JOIN platform.release_approvals AS approval USING (tenant_id, environment_id, approval_id, activation_attempt_id)
          WHERE physical.tenant_id=$1 AND physical.environment_id=$2 AND physical.release_id=swap.activated_release_id`,
          [context.tenantId, context.environmentId],
        );
        return result.rows[0];
      },
    );
  }

  /** Recover the selected physical generation. A stale form cannot select another attempt. */
  async recover(
    mode: 'reverify' | 'revert' = 'reverify',
    expected?: { readonly attemptId: string; readonly fence: string },
  ) {
    const context = await this.#context();
    return withReleaseScopeLock(
      this.connection.adminPool,
      this.connection.identities.runtime,
      async (admin) => {
        const swap = await this.#currentSwap(context);
        if (!swap)
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_ACTIVATION_UNVERIFIED',
            'no swap receipt matches the live pointer and fence',
          );
        if (
          expected &&
          (!swap.failed ||
            expected.attemptId !== swap.activation_attempt_id ||
            expected.fence !== swap.fence)
        )
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_DRAFT_STALE',
            'The activation changed. Open Customize again before recovering.',
          );
        const pointer = {
          pointerId: swap.pointer_id,
          releaseId: swap.activated_release_id,
          fence: Number(swap.fence),
        };
        if (mode === 'revert') {
          const targetReleaseId = swap.previous_release_id;
          if (!swap.failed || !targetReleaseId)
            throw new CustomizationServiceRefusal(
              'CUSTOMIZE_ACTIVATION_UNVERIFIED',
              'reverting requires a failed activation with a verified predecessor',
            );
          const reverse = await withTrustedRequestTransaction(
            this.connection.runtimePool,
            context,
            (client) =>
              authorizeReverseTransitionIfApplicable(client, context, {
                recoveryOfAttemptId: swap.activation_attempt_id,
                expectedFence: pointer.fence,
                expectedPointerId: pointer.pointerId,
                sourceReleaseId: pointer.releaseId,
                targetReleaseId,
              }),
          );
          if (!reverse)
            throw new CustomizationServiceRefusal(
              'CUSTOMIZE_ROLLBACK_NOT_REVERSIBLE',
              'the recovery transition is unavailable',
            );
          // B's manifest may be the unavailable artifact. Its original approval
          // already binds the canonical diff and root of this exact swap.
          const target = await this.#loadRelease(context, targetReleaseId);
          const renderedText = `Restore release ${target.compiled.releaseRoot} after failed activation ${swap.activation_attempt_id} at fence ${swap.fence}.`;
          await assertExactSwapTriggerEnabled(admin);
          const attemptId = await approveReleaseWithoutStorageTransition(
            this.connection.runtimePool,
            context,
            await trustedContext(this.connection.identities.approver),
            pointer,
            swap.target_manifest_root.toString('hex'),
            await this.#identity(context, targetReleaseId),
            target.compiled,
            {
              canonicalDiffDigest: swap.canonical_diff_digest.toString('hex'),
              renderedText,
              renderedDigest: renderedDiffDigest(renderedText),
              transitionPlanDigest: null,
            },
            reverse,
          );
          const restored = await this.#swap(
            admin,
            context,
            attemptId,
            targetReleaseId,
            'rolledBack',
          );
          return {
            ...restored,
            status: 'recovered' as const,
            activationAttemptId: attemptId,
          };
        }
        const verified = await new PostgresReleaseActivationService(
          this.connection.runtimePool,
        ).verifyActivation(
          await trustedContext(this.connection.identities.system),
          { activationAttemptId: swap.activation_attempt_id },
          pointer,
        );
        if (verified.status !== 'SWAPPED_VERIFIED')
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_ACTIVATION_UNVERIFIED',
            `the live activation ended ${verified.status}`,
          );
        const releaseRoot = await reconcileInventoryScopeToPointer(
          admin,
          this.connection.identities.runtime,
          pointer,
        );
        if (!releaseRoot)
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_ACTIVATION_UNVERIFIED',
            'the verified pointer changed during reconciliation',
          );
        return {
          status: 'recovered' as const,
          activationAttemptId: swap.activation_attempt_id,
          releaseId: pointer.releaseId,
          releaseRoot,
        };
      },
    );
  }

  async status(): Promise<CustomizationStatus> {
    const context = await this.#context();
    const pointer = await this.#livePointer(context);
    const swap = await this.#currentSwap(context);
    const recovery = swap?.failed
      ? {
          failedActivation: {
            attemptId: swap.activation_attempt_id,
            fence: swap.fence,
          },
        }
      : {};
    const rollbackAvailable = await this.#rollbackEdge(context, pointer).then(
      (edge) => !!edge,
      (error: unknown) => {
        if (
          error instanceof ReleaseReverseTransitionRefusal ||
          error instanceof CustomizationServiceRefusal
        )
          return false;
        throw error;
      },
    );
    const refusal = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      (client) =>
        client.query<{ diagnostic: UpgradeRefusal }>(
          `SELECT diagnostic FROM platform.customization_upgrade_refusals
        WHERE tenant_id=$1 AND environment_id=$2 AND source_release_id=$3 AND base_root=$4 AND NOT resolved`,
          [
            context.tenantId,
            context.environmentId,
            pointer.releaseId,
            this.#tip.compiled.releaseRoot,
          ],
        ),
    );
    const observed = await this.#state(
      context,
      pointer.releaseId,
      String(pointer.fence + 1),
    ).catch((error: unknown) => {
      if (
        (error instanceof CustomizationLineageError &&
          error.active?.provenance === 'tenantAuthored') ||
        (error instanceof CustomizationServiceRefusal &&
          error.code === 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE')
      )
        return error;
      throw error;
    });
    if (observed instanceof Error)
      return {
        ...recovery,
        historyUnavailable: true,
        rollbackAvailable,
        activeFence: pointer.fence,
        activeChain: [],
        patches: [],
        upgrades: [],
        activeReleaseId: pointer.releaseId,
        activeReleaseRoot: await this.#root(context, pointer.releaseId),
        upgradeRefusal: refusal.rows[0]?.diagnostic ?? {
          status: 'refused',
          code: observed.code,
          message: observed.message,
          sourceReleaseId: pointer.releaseId,
          baseReleaseRoot: this.#tip.compiled.releaseRoot,
        },
      };
    const active = { ...observed, pointer };
    const approved = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{
          target_release_id: string;
          customization_upgrade_id: string | null;
        }>(
          `SELECT DISTINCT target_release_id, customization_upgrade_id
             FROM platform.release_approvals
            WHERE tenant_id = $1 AND environment_id = $2
              AND expected_pointer_id = $3
              AND expected_release_id IS NOT DISTINCT FROM $4
              AND expected_fence = $5
              AND NOT customization_reconciliation_required
              AND expires_at > clock_timestamp()`,
          [
            context.tenantId,
            context.environmentId,
            active.pointer.pointerId,
            active.pointer.releaseId,
            active.pointer.fence,
          ],
        );
        return result.rows;
      },
    );
    const ambiguous = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      (client) =>
        client.query<{ approval_id: string }>(
          `SELECT approval_id FROM platform.release_approvals
        WHERE tenant_id=$1 AND environment_id=$2 AND expected_pointer_id=$3 AND expected_fence=$4
          AND expected_release_id=$5 AND customization_reconciliation_required ORDER BY approval_id LIMIT 1`,
          [
            context.tenantId,
            context.environmentId,
            pointer.pointerId,
            pointer.fence,
            pointer.releaseId,
          ],
        ),
    );
    const state = (record: PatchRecord): PatchState =>
      active.chain.some((applied) => applied.patchId === record.patchId)
        ? 'live'
        : record.parentRevisionId !== active.revisionId
          ? 'stale'
          : approved.some(
                (a) =>
                  !a.customization_upgrade_id &&
                  a.target_release_id === record.resultingReleaseId,
              )
            ? 'approved'
            : 'drafted';
    return Object.freeze({
      ...recovery,
      activeFence: pointer.fence,
      rollbackAvailable,
      upgradeRefusal:
        refusal.rows[0]?.diagnostic ??
        (ambiguous.rows[0]
          ? {
              status: 'refused' as const,
              code: 'CUSTOMIZE_APPROVAL_RECONCILIATION_REQUIRED',
              message: `The original action for approval ${ambiguous.rows[0].approval_id} must be reconciled.`,
              sourceReleaseId: pointer.releaseId,
              baseReleaseRoot: this.#tip.compiled.releaseRoot,
            }
          : null),
      upgrades: Object.freeze(
        (await this.#upgrades(context)).map((upgrade) => ({
          ...upgrade,
          state:
            active.upgrade?.upgradeId === upgrade.upgradeId
              ? ('live' as const)
              : active.releaseId !== upgrade.sourceReleaseId
                ? ('stale' as const)
                : approved.some(
                      (a) => a.customization_upgrade_id === upgrade.upgradeId,
                    )
                  ? ('approved' as const)
                  : ('drafted' as const),
        })),
      ),
      activeChain: active.chain,
      activeReleaseId: active.releaseId,
      activeReleaseRoot: active.releaseRoot,
      patches: Object.freeze(
        (await this.#patches(context)).map((record) =>
          Object.freeze({ ...record, state: state(record) }),
        ),
      ),
    });
  }

  /**
   * Plain English to one typed patch through the drafting model, then the
   * same draft as every other channel. The model never sees records, only the
   * live release's customizable targets; it cannot record or activate.
   */
  async draftFromRequest(
    request: string,
    signal?: AbortSignal,
  ): Promise<DraftOutcome> {
    if (!this.options.draftingModel) {
      return Object.freeze({
        code: 'CUSTOMIZE_AI_NOT_CONFIGURED',
        message:
          'Drafting from plain English needs a model key; describe the change with the forms instead.',
        status: 'refused' as const,
      });
    }
    let model: DraftingModel;
    try {
      model = await this.options.draftingModel();
    } catch (error) {
      return Object.freeze({
        code: 'CUSTOMIZE_AI_NOT_CONFIGURED',
        message: error instanceof Error ? error.message : String(error),
        status: 'refused' as const,
      });
    }
    const drafted = await draftPatchFromRequest(
      model,
      request,
      await this.targets(),
    );
    if (drafted.status === 'parsed') {
      signal?.throwIfAborted();
      return this.draft(drafted.patch, 'conversationalAi', signal);
    }
    if (drafted.status === 'unsupported') {
      return Object.freeze({
        message: drafted.message,
        missingCapability: drafted.missingCapability,
        status: 'unsupported' as const,
      });
    }
    return Object.freeze({
      issues: drafted.issues,
      message: 'the model did not produce a well-formed change',
      status: 'invalid' as const,
    });
  }

  /** What a change may target on the live release (plan §10.6 rules). */
  async targets(): Promise<CustomizationTargets> {
    const context = await this.#context();
    const pointer = await this.#livePointer(context);
    const active = await this.#identity(context, pointer.releaseId);
    const definition = parseNormalizedApplicationPackageJson(
      await this.#desiredState(context, active.revisionId),
    ) as unknown as Parameters<typeof customizationTargets>[0];
    return customizationTargets(definition);
  }

  /**
   * Drafts one patch on the active release. Refused, unsupported and
   * compiler-rejected requests leave nothing behind; a drafted one leaves its
   * patch record, its child revision and its staged release.
   */
  async draft(
    input: unknown,
    channel: AuthoringChannel,
    signal?: AbortSignal,
  ): Promise<DraftOutcome> {
    const parsed = parseCustomizationPatch(input);
    if (parsed.status === 'invalid') {
      return Object.freeze({
        issues: parsed.issues,
        message: 'the change is not well formed',
        status: 'invalid' as const,
      });
    }
    if (parsed.status === 'unsupported') {
      return Object.freeze({
        message: parsed.message,
        missingCapability: parsed.missingCapability,
        status: 'unsupported' as const,
      });
    }
    const context = await this.#context();
    const active = await this.#active(context);
    const patch =
      parsed.patch.kind === 'addField'
        ? { ...parsed.patch, screens: 'record' as const }
        : parsed.patch;
    await this.#assertCurrentBase(context, active);
    const reproduced = await this.#reproduce(context, active);
    const compiled = await this.#compile(
      [...(await this.#readPatches(context, active.chain)), patch],
      await this.#loadRelease(context, active.baseReleaseId),
      reproduced.candidate,
      active.chain.length,
    );
    if (compiled.status !== 'compiled') return compiled;
    const { steps } = compiled;
    const step = steps.at(-1)!;
    const candidate = parseSerializedRelease(step.release);
    const payload = new TextEncoder().encode(canonicalize(patch));
    const payloadDigest = createHash('sha256').update(payload).digest('hex');
    const normalized = parseNormalizedApplicationPackageJson(
      candidate.normalizedDefinitionBytes,
    );
    const firstParty = parseNormalizedApplicationPackageJson(
      this.#tip.normalizedDefinitionBytes,
    );
    const baseRevisionId = (await this.#identity(context, active.baseReleaseId))
      .revisionId;
    // Recording runs under the release-scope lock (review R4): two identical
    // drafts are serialized, so the second finds the first's patch and
    // returns the release and revision that patch recorded.
    const recorded = await this.#locked(async (_admin, _context, locked) => {
      if (locked.revisionId !== active.revisionId) {
        return Object.freeze({
          code: 'CUSTOMIZE_DRAFT_STALE',
          message:
            'the live application changed while this change was drafted; draft it again',
          status: 'refused' as const,
        });
      }
      const existing = await withTrustedRequestTransaction(
        this.connection.runtimePool,
        context,
        async (client) =>
          client.query<{
            patch_id: MintedUuid;
            resulting_release_id: MintedUuid;
            resulting_revision_id: MintedUuid;
          }>(
            // The table's append-only rules rule out ON CONFLICT, so a
            // re-draft is found first.
            `SELECT patch_id, resulting_release_id, resulting_revision_id
               FROM platform.customization_patches
              WHERE tenant_id = $1 AND environment_id = $2
                AND parent_revision_id = $3 AND payload_digest = $4`,
            [
              context.tenantId,
              context.environmentId,
              active.revisionId,
              payloadDigest,
            ],
          ),
      );
      const reusedRow = existing.rows[0];
      if (reusedRow) {
        return {
          patchId: reusedRow.patch_id,
          releaseId: reusedRow.resulting_release_id,
          reused: true,
          revisionId: reusedRow.resulting_revision_id,
          status: 'recorded' as const,
        };
      }
      let identity: PersistedReleaseIdentity;
      try {
        signal?.throwIfAborted();
        identity = await ensurePersistedRelease(
          this.connection.runtimePool,
          context,
          candidate,
          active.revisionId,
          'tenantAuthored',
        );
      } catch (error) {
        if (error instanceof PersistedReleaseConflict) {
          return Object.freeze({
            code: error.code,
            message: error.message,
            status: 'refused' as const,
          });
        }
        throw error;
      }
      const patchId = randomUUID() as MintedUuid;
      await withTrustedRequestTransaction(
        this.connection.runtimePool,
        context,
        async (client) => {
          signal?.throwIfAborted();
          await client.query(
            `INSERT INTO platform.customization_patches (
             tenant_id, environment_id, patch_id, patch_version, patch_kind,
             payload, payload_digest, channel, authored_by, base_package_id,
             base_package_version, base_revision_id, base_release_root,
             parent_revision_id, resulting_revision_id, resulting_release_id,
             language_version, normalization_profile_version, display_label, compiler_acknowledgement
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
           )`,
            [
              context.tenantId,
              context.environmentId,
              patchId,
              CUSTOMIZATION_PATCH_VERSION,
              parsed.patch.kind,
              Buffer.from(payload),
              payloadDigest,
              channel,
              context.principalId,
              firstParty.package.packageId,
              firstParty.package.version,
              baseRevisionId,
              this.#tip.compiled.releaseRoot,
              active.revisionId,
              identity.revisionId,
              identity.releaseId,
              normalized.languageVersion,
              normalized.normalizationProfileVersion,
              patchDisplayLabel(patch),
              this.options.acknowledgement,
            ],
          );
          signal?.throwIfAborted();
        },
      );
      return {
        patchId,
        releaseId: identity.releaseId,
        reused: false,
        revisionId: identity.revisionId,
        status: 'recorded' as const,
      };
    });
    if (recorded.status === 'refused') return recorded;
    return Object.freeze({
      canonicalDiffDigest: step.diff.canonicalDiffDigest,
      patchId: recorded.patchId,
      releaseId: recorded.releaseId,
      releaseRoot: candidate.compiled.releaseRoot,
      renderedDigest: step.rendered.renderedDigest,
      renderedDiff: step.rendered.text,
      revisionId: recorded.revisionId,
      reused: recorded.reused,
      status: 'drafted' as const,
    });
  }

  /**
   * The human approval of one drafted change on the release it was drafted
   * on. The approval binds the canonical diff digest and the digest of the
   * plain-language text returned here (the approver's view); for a storage
   * change the prepared plan must be the plan that diff names.
   */
  async approve(patchId: string): Promise<ApprovalOutcome> {
    return this.#locked(async (admin, context, active) => {
      const upgrade = (await this.#upgrades(context)).find(
        (entry) => entry.upgradeId === patchId,
      );
      const record = upgrade
        ? {
            resultingReleaseId: upgrade.candidateReleaseId,
            resultingRevisionId: upgrade.candidateRevisionId,
            parentRevisionId: (
              await this.#identity(context, upgrade.sourceReleaseId)
            ).revisionId,
          }
        : await this.#patch(context, patchId);
      if (active.releaseId === record.resultingReleaseId) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_ALREADY_ACTIVE',
          'this change is already live',
        );
      }
      if (
        record.parentRevisionId !== active.revisionId ||
        (upgrade && upgrade.sourceReleaseId !== active.releaseId)
      ) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_DRAFT_STALE',
          'the live application changed after this change was drafted; draft it again',
        );
      }
      const { parent, candidate } = upgrade
        ? await this.#reproduce(context, {
            ...active,
            releaseId: upgrade.candidateReleaseId,
            revisionId: upgrade.candidateRevisionId,
            baseReleaseId: upgrade.baseReleaseId,
            upgrade,
            upgradeFence: null,
            parentReleaseId: active.releaseId,
          })
        : await this.#reproduce(
            context,
            active,
            await this.#patch(context, patchId),
          );
      await this.#assertUpgradeBase(context, upgrade);
      const identity = await this.#identity(context, record.resultingReleaseId);
      const admit = () =>
        ensureReleaseAdmitted(
          this.connection.runtimePool,
          context,
          identity,
          candidate,
          this.options.providerErrorMappings ?? [],
          this.options.capabilityOperationExecutorFactories ?? [],
        );
      const binding = releaseDiffBinding(parent, candidate);
      const approver = await trustedContext(
        this.connection.identities.approver,
      );
      await assertExactSwapTriggerEnabled(admin);
      let activationAttemptId: MintedUuid;
      if (storageElements(candidate.compiled).length === 0) {
        await admit();
        activationAttemptId = await approveReleaseWithoutStorageTransition(
          this.connection.runtimePool,
          context,
          approver,
          active.pointer,
          parent.compiled.releaseRoot,
          identity,
          candidate.compiled,
          binding,
          undefined,
          undefined,
          upgrade?.upgradeId,
        );
      } else {
        // As at boot: the inert part of the plan (a new table) is prepared
        // first, so the candidate's verification scenarios run against it.
        const preparationId = randomUUID() as MintedUuid;
        const prepared = await this.#materializer().prepare({
          context,
          // Inside the approval's own default window (24 hours).
          expiresAt: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: context.principalId,
          preparationId,
          targetReleaseId: identity.releaseId,
        });
        await admit();
        activationAttemptId = await approveModuleRelease(
          this.connection.runtimePool,
          context,
          approver,
          active.pointer,
          identity,
          candidate.compiled,
          prepared,
          preparationId,
          binding,
          undefined,
          upgrade?.upgradeId,
        );
      }
      return Object.freeze({
        activationAttemptId,
        renderedDiff: binding.renderedText,
        status: 'approved' as const,
      });
    });
  }

  /**
   * Activates an approved change through the activation kernel's CAS, fence
   * and verification. A running server serves it from its next request.
   */
  async activate(patchId: string): Promise<ActivationOutcome> {
    return this.#locked(async (admin, context, active) => {
      const upgrade = (await this.#upgrades(context)).find(
        (entry) => entry.upgradeId === patchId,
      );
      const record = upgrade
        ? {
            resultingReleaseId: upgrade.candidateReleaseId,
            resultingRevisionId: upgrade.candidateRevisionId,
          }
        : await this.#patch(context, patchId);
      if (
        (active.releaseId === record.resultingReleaseId &&
          (!upgrade || active.upgrade?.upgradeId === upgrade.upgradeId)) ||
        (!upgrade &&
          active.chain.some((applied) => applied.patchId === patchId))
      ) {
        // Already live, and `#locked` has proved its activation verified and
        // set the scopes to it (review R2): a cut-off activation is finished.
        return Object.freeze({
          releaseId: active.releaseId,
          releaseRoot: active.releaseRoot,
          status: 'activated' as const,
        });
      }
      const approval = await withTrustedRequestTransaction(
        this.connection.runtimePool,
        context,
        async (client) =>
          client.query<{
            activation_attempt_id: MintedUuid;
            preparation_id: MintedUuid;
            transition_plan_digest: Uint8Array | null;
          }>(
            `SELECT activation_attempt_id, preparation_id, transition_plan_digest
             FROM platform.release_approvals
            WHERE tenant_id = $1 AND environment_id = $2
              AND target_release_id = $3
              AND expected_pointer_id = $4
              AND expected_release_id IS NOT DISTINCT FROM $5
              AND expected_fence = $6
              AND customization_upgrade_id IS NOT DISTINCT FROM $7::uuid
              AND NOT customization_reconciliation_required
              AND expires_at > clock_timestamp()
            ORDER BY decided_at DESC
            LIMIT 1`,
            [
              context.tenantId,
              context.environmentId,
              record.resultingReleaseId,
              active.pointer.pointerId,
              active.pointer.releaseId,
              active.pointer.fence,
              upgrade?.upgradeId ?? null,
            ],
          ),
      );
      const approved = approval.rows[0];
      if (!approved) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_NOT_APPROVED',
          'this change has no current approval; approve it first',
        );
      }
      await this.#assertUpgradeBase(context, upgrade);
      if (approved.transition_plan_digest !== null) {
        const generation = await admin.query<{
          generation_id: string;
        }>(
          `SELECT generation_id
           FROM north_star_internal.module_storage_generations
          WHERE tenant_id = $1 AND environment_id = $2 AND preparation_id = $3`,
          [context.tenantId, context.environmentId, approved.preparation_id],
        );
        const generationId = generation.rows[0]?.generation_id;
        if (!generationId) {
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_NOT_APPROVED',
            'the approved storage change has no prepared plan; approve it again',
          );
        }
        const executed = await this.#materializer().executeApprovedAttempt({
          activationAttemptId: approved.activation_attempt_id,
          context,
          coordinatorId: randomUUID() as MintedUuid,
          generationId,
        });
        if (executed.disposition !== 'READY_TO_SWAP') {
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_ACTIVATION_FAILED',
            `the storage change did not become ready: ${executed.disposition}`,
          );
        }
      }
      if (this.options.localDemoIdentity) {
        await provisionLocalDemoReleaseAuthorization(
          admin,
          this.connection.identities,
          await this.#desiredState(context, record.resultingRevisionId),
        );
      }
      return this.#swap(
        admin,
        context,
        approved.activation_attempt_id,
        record.resultingReleaseId,
        'activated',
      );
    });
  }

  /**
   * One click: the active change is reversed to the release its activation
   * came from, through the reverse-transition policy. Storage stays: the rows
   * entered under the change are kept and return if it is activated again.
   */
  async rollback(
    expectedReleaseId?: string,
    expectedFence?: string,
  ): Promise<ActivationOutcome> {
    const context = await this.#context();
    return withReleaseScopeLock(
      this.connection.adminPool,
      this.connection.identities.runtime,
      async (admin) => {
        const pointer = await this.#repair(admin, context);
        if (
          (expectedReleaseId !== undefined &&
            expectedReleaseId !== pointer.releaseId) ||
          (expectedFence !== undefined &&
            expectedFence !== String(pointer.fence))
        )
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_DRAFT_STALE',
            'The live release changed. Open Customize again before rolling back.',
          );
        const reverse = await this.#rollbackEdge(context, pointer);
        if (!reverse)
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_NOTHING_TO_ROLL_BACK',
            'the live application has no customization to roll back',
          );
        const targetReleaseId = reverse.targetReleaseId;
        const parent = await this.#loadRelease(context, targetReleaseId);
        const candidate = await this.#loadRelease(context, pointer.releaseId);
        const target = await this.#identity(context, targetReleaseId);
        await assertExactSwapTriggerEnabled(admin);
        const attemptId = await approveReleaseWithoutStorageTransition(
          this.connection.runtimePool,
          context,
          await trustedContext(this.connection.identities.approver),
          pointer,
          candidate.compiled.releaseRoot,
          target,
          parent.compiled,
          releaseDiffBinding(candidate, parent, 'reverse'),
          reverse,
        );
        return this.#swap(
          admin,
          context,
          attemptId,
          targetReleaseId,
          'rolledBack',
        );
      },
    );
  }

  async #rollbackEdge(
    context: TrustedRequestContext,
    pointer: { releaseId: MintedUuid; pointerId: MintedUuid; fence: number },
  ) {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{ previous_release_id: MintedUuid }>(
          `SELECT swap.previous_release_id FROM ${verifiedGenerationsSql} AS swap
           JOIN platform.active_release_pointers AS physical
             ON physical.tenant_id=swap.tenant_id AND physical.environment_id=swap.environment_id
            AND physical.pointer_id=swap.pointer_id AND physical.release_id=swap.activated_release_id AND physical.fence=swap.fence
           JOIN platform.tenant_releases AS release ON release.tenant_id=swap.tenant_id AND release.environment_id=swap.environment_id AND release.release_id=swap.activated_release_id
           JOIN platform.app_package_revisions AS revision ON revision.tenant_id=release.tenant_id AND revision.revision_id=release.app_package_revision_id
          WHERE swap.tenant_id=$1 AND swap.environment_id=$2 AND swap.pointer_id=$3 AND swap.activated_release_id=$4 AND swap.fence=$5
            AND revision.provenance='tenantAuthored' AND swap.previous_release_id IS NOT NULL`,
          [
            context.tenantId,
            context.environmentId,
            pointer.pointerId,
            pointer.releaseId,
            pointer.fence,
          ],
        );
        const predecessor = result.rows[0];
        if (!predecessor) return null;
        const edge = await authorizeReverseTransitionIfApplicable(
          client,
          context,
          {
            expectedPointerId: pointer.pointerId,
            expectedFence: pointer.fence,
            sourceReleaseId: pointer.releaseId,
            targetReleaseId: predecessor.previous_release_id,
          },
        );
        if (!edge)
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_ROLLBACK_NOT_REVERSIBLE',
            'this release was restored by a rollback; rolling back past it is not supported',
          );
        return edge;
      },
    );
  }

  /**
   * The one shape every customization state change takes (review R1-R3): on
   * one admin connection holding the release-scope lock, first prove the live
   * release's activation verified and set the inventory scopes to it, then
   * read the live state and decide. Inside, admin work goes through the held
   * connection only; the admin pool may be exhausted by callers queued on the
   * same lock.
   */
  async #locked<T>(
    run: (
      admin: pg.PoolClient,
      context: TrustedRequestContext,
      active: ActiveState,
    ) => Promise<T>,
  ): Promise<T> {
    const context = await this.#context();
    return withReleaseScopeLock(
      this.connection.adminPool,
      this.connection.identities.runtime,
      async (admin) => {
        const pointer = await this.#repair(admin, context);
        const state = await this.#state(
          context,
          pointer.releaseId,
          String(pointer.fence + 1),
        );
        return run(admin, context, { ...state, pointer });
      },
    );
  }

  /**
   * Refuses unless the activation that put the live pointer where it is
   * verified (the kernel commits the swap before it verifies, so a cut
   * between them leaves an unverified pointer); then sets every inventory
   * scope to the live release. A retry after any cut lands here first.
   */
  async #repair(admin: pg.PoolClient, context: TrustedRequestContext) {
    const observed = await readPointer(this.connection.runtimePool, context);
    if (!observed.releaseId)
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_NOT_STARTED',
        'there is no live release',
      );
    const pointer = { ...observed, releaseId: observed.releaseId };
    if (
      !(await reconcileInventoryScopeToPointer(
        admin,
        this.connection.identities.runtime,
        pointer,
      ))
    )
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ACTIVATION_UNVERIFIED',
        'the verified pointer changed during reconciliation',
      );
    return pointer;
  }

  /**
   * Swap, re-read the pointer and reconcile the inventory scopes to it, inside
   * `#locked` and through its connection: a concurrent swap waits, so a scope
   * is never set to a root another swap has already replaced (review F1).
   */
  async #swap(
    admin: pg.PoolClient,
    context: TrustedRequestContext,
    activationAttemptId: MintedUuid,
    expectedReleaseId: MintedUuid,
    status: ActivationOutcome['status'],
  ): Promise<ActivationOutcome> {
    const activated = await activateWithExactSwapTrigger(
      admin,
      this.options.activationKernel?.(this.connection.runtimePool) ??
        new PostgresReleaseActivationService(this.connection.runtimePool),
      await trustedContext(this.connection.identities.system),
      activationAttemptId,
    );
    if (activated.status !== 'SWAPPED_VERIFIED') {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ACTIVATION_FAILED',
        `activation did not verify: ${activated.status}`,
      );
    }
    const pointer = await readPointer(this.connection.runtimePool, context);
    if (
      pointer.releaseId !== expectedReleaseId ||
      activated.releaseId !== expectedReleaseId ||
      pointer.pointerId !== activated.pointerId ||
      pointer.fence !== activated.fence
    ) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ACTIVATION_FAILED',
        'the verified activation no longer names the current generation',
      );
    }
    await this.options.afterSwapBeforeScope?.();
    const releaseRoot = await reconcileInventoryScopeToPointer(
      admin,
      this.connection.identities.runtime,
      pointer,
    );
    if (!releaseRoot)
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ACTIVATION_UNVERIFIED',
        'the verified pointer changed during reconciliation',
      );
    return Object.freeze({
      releaseId: expectedReleaseId,
      releaseRoot,
      status,
    });
  }

  async #releaseIdForRoot(
    context: TrustedRequestContext,
    releaseRoot: string,
  ): Promise<MintedUuid | null> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{ release_id: MintedUuid }>(
          `SELECT release_id FROM platform.tenant_releases
            WHERE tenant_id = $1 AND environment_id = $2 AND content_hash = $3
            ORDER BY created_at LIMIT 1`,
          [context.tenantId, context.environmentId, releaseRoot],
        );
        return result.rows[0]?.release_id ?? null;
      },
    );
  }

  /**
   * Re-applies a recorded chain in the isolated worker and checks every link
   * against the release recorded for it; returns the last link and its parent.
   */
  async #reproduce(
    context: TrustedRequestContext,
    state: ReleaseState,
    extra?: PatchRecord,
  ): Promise<{
    readonly candidate: ParsedRelease;
    readonly parent: ParsedRelease;
  }> {
    const base = await this.#loadRelease(context, state.baseReleaseId);
    const chain = [...state.chain, ...(extra ? [extra] : [])];
    let parent = base;
    let offset = 0;
    if (state.upgrade) {
      const upgrade = state.upgrade;
      const source = await this.#state(
        context,
        upgrade.sourceReleaseId,
        state.upgradeFence,
      );
      if (
        canonicalize(source.chain.map((record) => record.patchId)) !==
        canonicalize(upgrade.patchIds)
      ) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
          'the upgrade patch chain differs from its source release',
        );
      }
      const reproduced = await this.#reproduce(context, source);
      const replay = await this.#compile(
        await this.#readPatches(context, source.chain),
        base,
        reproduced.candidate,
        0,
        true,
        [upgrade.compilerAcknowledgement],
      );
      if (replay.status !== 'compiled') {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
          replay.message,
        );
      }
      parent = parseSerializedRelease(replay.steps[0]!.release);
      if (
        parent.compiled.releaseRoot !==
        (await this.#root(context, upgrade.candidateReleaseId))
      ) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
          'replaying the upgrade did not reproduce its recorded release',
        );
      }
      offset = upgrade.patchIds.length;
      if (chain.length === offset)
        return { parent: reproduced.candidate, candidate: parent };
    }
    if (chain.length === 0) return { parent, candidate: parent };
    const compiled = await this.#compile(
      await this.#readPatches(context, chain),
      base,
      parent,
      offset,
      false,
      chain.slice(offset).map((record) => record.compilerAcknowledgement),
    );
    if (compiled.status !== 'compiled') {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        compiled.message,
      );
    }
    this.#assertReproduced(chain.slice(offset), compiled.steps);
    const releases = compiled.steps.map((step) =>
      parseSerializedRelease(step.release),
    );
    return { candidate: releases.at(-1)!, parent: releases.at(-2) ?? parent };
  }

  /** Read the immutable package and artifacts for an exact, scoped release. */
  async #loadRelease(
    context: TrustedRequestContext,
    releaseId: MintedUuid,
  ): Promise<ParsedRelease> {
    const root = await this.#root(context, releaseId);
    const parsed = parseCompiledApplication(this.options.compiledApplication);
    const checkedIn = [parsed.bootstrap, ...parsed.applications].find(
      (release) => release.compiled.releaseRoot === root,
    );
    if (checkedIn) return checkedIn;
    const stored = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const metadata = await client.query<{
          desired_state: Buffer;
          compiler_attestation_digest: string;
        }>(
          `SELECT revision.desired_state, release.compiler_attestation_digest
           FROM platform.tenant_releases AS release
           JOIN platform.app_package_revisions AS revision
             ON revision.tenant_id = release.tenant_id AND revision.revision_id = release.app_package_revision_id
          WHERE release.tenant_id = $1 AND release.environment_id = $2 AND release.release_id = $3`,
          [context.tenantId, context.environmentId, releaseId],
        );
        const artifacts = await client.query<{
          artifact_kind: ContentAddressedArtifact['artifactKind'];
          content_hash: string;
          domain_tag: string;
          media_type: ContentAddressedArtifact['mediaType'];
          canonical_bytes: Buffer;
        }>('SELECT * FROM platform.read_tenant_release_artifacts($1)', [
          releaseId,
        ]);
        return { metadata: metadata.rows[0], artifacts: artifacts.rows };
      },
    );
    if (!stored.metadata) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        'the recorded release is missing',
      );
    }
    const artifacts: ContentAddressedArtifact[] = stored.artifacts.map(
      (artifact) => ({
        artifactKind: artifact.artifact_kind,
        contentHash: artifact.content_hash,
        domainTag: artifact.domain_tag,
        mediaType: artifact.media_type,
        canonicalBytes: artifact.canonical_bytes,
        kind: 'contentAddressedArtifact',
      }),
    );
    const manifest = artifacts.find(
      (artifact) => artifact.contentHash === root,
    );
    if (!manifest)
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        'the recorded release has no manifest',
      );
    const releaseManifest = JSON.parse(
      new TextDecoder().decode(manifest.canonicalBytes),
    ) as ReleaseManifestEnvelope;
    const attestation = compilerAttestationFromManifest(releaseManifest, root);
    if (
      attestation.attestationDigest !==
      stored.metadata.compiler_attestation_digest
    )
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        'the immutable manifest does not match its registered compiler attestation',
      );
    return {
      normalizedDefinitionBytes: stored.metadata.desired_state,
      compiled: {
        attestation,
        bundle: {
          artifacts,
          releaseManifest,
          releaseManifestBytes: manifest.canonicalBytes,
          outputProtocolVersion: releaseManifest.outputProtocolVersion,
          nodeContracts: [],
          kind: 'compiledReleaseBundle',
        },
        stagedArtifacts: artifacts,
        status: 'compiled',
        diagnostics: [],
        releaseRoot: root,
      },
    };
  }

  async #patch(
    context: TrustedRequestContext,
    patchId: string,
  ): Promise<PatchRecord> {
    const record = (await this.#patches(context)).find(
      (candidate) => candidate.patchId === patchId,
    );
    if (!record) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_CHANGE_NOT_FOUND',
        `no recorded change ${patchId}`,
      );
    }
    return record;
  }

  async #identity(
    context: TrustedRequestContext,
    releaseId: MintedUuid,
  ): Promise<PersistedReleaseIdentity> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{
          app_package_revision_id: MintedUuid;
          verification_evidence_id: MintedUuid;
        }>(
          `SELECT app_package_revision_id, verification_evidence_id
             FROM platform.tenant_releases
            WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
          [context.tenantId, context.environmentId, releaseId],
        );
        const row = result.rows[0];
        if (!row) {
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_CHANGE_NOT_FOUND',
            `release ${releaseId} is not visible`,
          );
        }
        return Object.freeze({
          evidenceId: row.verification_evidence_id,
          releaseId,
          revisionId: row.app_package_revision_id,
        });
      },
    );
  }

  async #root(
    context: TrustedRequestContext,
    releaseId: MintedUuid,
  ): Promise<string> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{ content_hash: string }>(
          `SELECT content_hash FROM platform.tenant_releases
            WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
          [context.tenantId, context.environmentId, releaseId],
        );
        return result.rows[0]?.content_hash ?? '';
      },
    );
  }

  async #desiredState(
    context: TrustedRequestContext,
    revisionId: MintedUuid,
  ): Promise<Uint8Array> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{ desired_state: Uint8Array }>(
          `SELECT desired_state FROM platform.app_package_revisions
            WHERE tenant_id = $1 AND revision_id = $2`,
          [context.tenantId, revisionId],
        );
        return new Uint8Array(result.rows[0]!.desired_state);
      },
    );
  }

  #materializer(): PostgresModuleStorageMaterializer {
    return new PostgresModuleStorageMaterializer(
      this.connection.materializerPool,
      this.connection.modulePool,
    );
  }

  async #compile(
    chain: readonly CustomizationPatch[],
    base: ParsedRelease = this.#tip,
    parent: ParsedRelease = base,
    startAt = 0,
    upgrade = false,
    pins?: readonly (AcknowledgementInput | null | undefined)[],
  ): Promise<
    | { readonly status: 'compiled'; readonly steps: readonly SandboxStep[] }
    | Exclude<DraftOutcome, { status: 'drafted' }>
  > {
    const missing = pins?.some((pin) => !pin);
    if (missing)
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        'The historical compile has no recorded permission acknowledgement.',
      );
    const response = await compileInSandbox(
      {
        acknowledgement: this.options.acknowledgement,
        ...(pins
          ? { stepAcknowledgements: pins as readonly AcknowledgementInput[] }
          : {}),
        base:
          base.compiled.releaseRoot === this.#tip.compiled.releaseRoot
            ? this.options.firstPartyAuthored
            : (canonicalAuthoredProjection(
                parseNormalizedApplicationPackageJson(
                  base.normalizedDefinitionBytes,
                ),
              ) as unknown as Record<string, unknown>),
        chain,
        tip: serializeRelease(parent),
        startAt,
        ...(upgrade ? { upgradeBaseRoot: base.compiled.releaseRoot } : {}),
      },
      this.options.sandbox,
    );
    if (response.status === 'compiled') return response;
    return Object.freeze({
      ...(response.code ? { code: response.code } : {}),
      ...(response.missingCapability
        ? { missingCapability: response.missingCapability }
        : {}),
      ...(response.diagnostics
        ? {
            issues: response.diagnostics.map((diagnostic) =>
              JSON.stringify(diagnostic),
            ),
          }
        : {}),
      message: response.message,
      status: response.status,
    });
  }

  /** ADR-0013's determinism gate: re-applying the chain reproduces it. */
  #assertReproduced(
    chain: readonly PatchRecord[],
    steps: readonly SandboxStep[],
  ): void {
    chain.forEach((record, index) => {
      if (steps[index]?.release.releaseRoot !== record.resultingReleaseRoot) {
        throw new CustomizationServiceRefusal(
          'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
          `re-applying the recorded patch ${record.patchId} to its base did not reproduce release ${record.resultingReleaseRoot}`,
        );
      }
    });
  }

  async #context(): Promise<TrustedRequestContext> {
    this.#runtimeContext ??= await trustedContext(
      this.connection.identities.runtime,
    );
    return this.#runtimeContext;
  }

  /**
   * The active release and the patch chain that produced it. The first-party
   * base must be the checked-in lineage tip, and the checked-in authored file
   * must still normalize to it, or no patch can be applied honestly.
   */
  async #livePointer(context: TrustedRequestContext) {
    const pointer = await readVerifiedServing(
      this.connection.runtimePool,
      context,
    );
    if (!pointer) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_NOT_STARTED',
        'the application has never started in this database; run corepack pnpm dev once',
      );
    }
    return { ...pointer, releaseId: pointer.releaseId };
  }

  async #active(context: TrustedRequestContext): Promise<ActiveState> {
    const pointer = await this.#livePointer(context);
    return {
      ...(await this.#state(
        context,
        pointer.releaseId,
        String(pointer.fence + 1),
      )),
      pointer,
    };
  }

  #assertAuthoredBase(): void {
    if (
      !Buffer.from(
        canonicalize(
          normalizeApplicationPackage(this.options.firstPartyAuthored),
        ),
      ).equals(Buffer.from(this.#tip.normalizedDefinitionBytes))
    ) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_STALE',
        'app.authored.json no longer compiles to the checked-in release; run corepack pnpm --filter @north-star/web build:app-release',
      );
    }
  }

  async #assertUpgradeBase(
    context: TrustedRequestContext,
    upgrade: UpgradeRecord | undefined,
  ) {
    if (
      upgrade &&
      upgrade.baseReleaseId !==
        (await this.#releaseIdForRoot(context, this.#tip.compiled.releaseRoot))
    )
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_MOVED',
        'the upgrade targets a different first-party base',
      );
  }

  async #assertCurrentBase(
    context: TrustedRequestContext,
    state: ReleaseState,
  ): Promise<void> {
    this.#assertAuthoredBase();
    if (
      (await this.#root(context, state.baseReleaseId)) !==
      this.#tip.compiled.releaseRoot
    ) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_MOVED',
        'approve and activate the pending platform upgrade before drafting another change',
      );
    }
  }

  async #state(
    context: TrustedRequestContext,
    releaseId: MintedUuid,
    beforeFence?: string | null,
  ): Promise<ReleaseState> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const lineage = await readCustomizationLineage(client, {
          ...context,
          releaseId,
          beforeFence: beforeFence ?? null,
        });
        const base = lineage.at(-1)!;
        const selected = base.via_upgrade
          ? await client.query<UpgradeRow>(
              'SELECT * FROM platform.customization_upgrades WHERE tenant_id=$1 AND environment_id=$2 AND upgrade_id=$3',
              [context.tenantId, context.environmentId, base.via_upgrade],
            )
          : null;
        const upgrade = selected?.rows[0]
          ? upgradeRecord(selected.rows[0])
          : null;
        const patchReleases = lineage.slice(0, upgrade ? -2 : -1).reverse();
        const records = await client.query<PatchRow>(
          `${PATCH_SELECT} WHERE patch.tenant_id=$1 AND patch.environment_id=$2
           AND (patch.patch_id = ANY($3::uuid[]) OR patch.resulting_release_id = ANY($4::uuid[]))
         ORDER BY patch.created_at, patch.patch_id`,
          [
            context.tenantId,
            context.environmentId,
            upgrade?.patchIds ?? [],
            patchReleases.map((step) => step.release_id),
          ],
        );
        const chain = [
          ...(upgrade?.patchIds ?? []).map((id) =>
            records.rows.find((p) => p.patch_id === id),
          ),
          ...patchReleases.map((step) =>
            records.rows.find(
              (p) =>
                p.resulting_release_id === step.release_id &&
                p.resulting_revision_id === step.revision_id,
            ),
          ),
        ].map((row) => {
          if (!row)
            throw new CustomizationServiceRefusal(
              'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
              'the recorded release has a missing patch',
            );
          return patchRecord(row);
        });
        return {
          releaseId,
          releaseRoot: lineage[0]!.content_hash,
          revisionId: lineage[0]!.revision_id,
          baseReleaseId: base.release_id,
          chain,
          upgrade,
          upgradeFence: base.fence_limit,
          parentReleaseId:
            upgrade?.candidateReleaseId === releaseId
              ? upgrade.sourceReleaseId
              : (lineage[1]?.release_id ?? null),
        };
      },
    );
  }

  async #readPatches(
    context: TrustedRequestContext,
    records: readonly PatchRecord[],
  ): Promise<CustomizationPatch[]> {
    if (!records.length) return [];
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<{
          patch_id: string;
          payload: Buffer;
        }>(
          'SELECT patch_id, payload FROM platform.customization_patches WHERE tenant_id=$1 AND environment_id=$2 AND patch_id=ANY($3::uuid[])',
          [
            context.tenantId,
            context.environmentId,
            records.map((record) => record.patchId),
          ],
        );
        const bytes = new Map(
          result.rows.map((row) => [row.patch_id, row.payload]),
        );
        return records.map((record) => {
          const payload = bytes.get(record.patchId);
          if (
            payload &&
            createHash('sha256').update(payload).digest('hex') ===
              record.payloadDigest
          ) {
            try {
              const parsed = parseCustomizationPatch(
                JSON.parse(payload.toString('utf8')),
              );
              if (
                parsed.status === 'parsed' &&
                parsed.patch.kind === record.kind
              )
                return parsed.patch.kind === 'addField' && !parsed.patch.screens
                  ? { ...parsed.patch, legacy: true as const }
                  : parsed.patch;
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
            }
          }
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
            `patch ${record.patchId} cannot be read with its recorded kind and digest`,
          );
        });
      },
    );
  }

  async #patches(
    context: TrustedRequestContext,
  ): Promise<readonly PatchRecord[]> {
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const result = await client.query<PatchRow>(
          `${PATCH_SELECT}
            WHERE patch.tenant_id = $1 AND patch.environment_id = $2
            ORDER BY patch.created_at, patch.patch_id`,
          [context.tenantId, context.environmentId],
        );
        return Object.freeze(result.rows.map(patchRecord));
      },
    );
  }
}

/** Opens the service against a database the composed application has started. */
export async function openCustomizationService(
  options: CustomizationServiceOptions & {
    readonly databaseUrl: string;
    readonly environmentSlug?: string;
    readonly migrationsDirectory: string;
    readonly tenantSlug: string;
  },
): Promise<{
  readonly service: PostgresCustomizationService;
  close(): Promise<void>;
}> {
  const adminPool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
  });
  adminPool.on('error', () => undefined);
  let runtimePool: pg.Pool | undefined;
  let materializerPool: pg.Pool | undefined;
  let modulePool: pg.Pool | undefined;
  try {
    await migrate(adminPool, options.migrationsDirectory);
    const identities = await ensureScope(
      adminPool,
      options.tenantSlug,
      options.environmentSlug ?? 'production',
    );
    runtimePool = rolePool(options.databaseUrl, 'north_star_runtime', 4);
    materializerPool = rolePool(
      options.databaseUrl,
      'north_star_module_materializer',
      2,
    );
    modulePool = rolePool(options.databaseUrl, 'north_star_module_runtime', 2);
    const service = new PostgresCustomizationService(
      { adminPool, identities, materializerPool, modulePool, runtimePool },
      options,
    );
    const pools = [adminPool, runtimePool, materializerPool, modulePool];
    return Object.freeze({
      async close() {
        await Promise.all(pools.map((pool) => pool.end()));
      },
      service,
    });
  } catch (error) {
    await Promise.all(
      [adminPool, runtimePool, materializerPool, modulePool]
        .filter((pool): pool is pg.Pool => pool !== undefined)
        .map((pool) => pool.end().catch(() => undefined)),
    );
    throw error;
  }
}

interface PatchRow {
  compiler_acknowledgement: AcknowledgementInput | null;
  base_release_root: string;
  channel: AuthoringChannel;
  created_at: Date | string;
  parent_revision_id: MintedUuid;
  patch_id: MintedUuid;
  patch_kind: string;
  display_label: string | null;
  payload_digest: string;
  resulting_release_id: MintedUuid;
  resulting_release_root: string;
  resulting_revision_id: MintedUuid;
}

const PATCH_SELECT = `SELECT patch.compiler_acknowledgement, patch.base_release_root, patch.patch_id, patch.patch_kind, patch.display_label,
       patch.payload_digest, patch.channel, patch.parent_revision_id,
       patch.resulting_revision_id, patch.resulting_release_id,
       release.content_hash AS resulting_release_root, patch.created_at
  FROM platform.customization_patches AS patch
  JOIN platform.tenant_releases AS release
    ON release.tenant_id = patch.tenant_id
   AND release.environment_id = patch.environment_id
   AND release.release_id = patch.resulting_release_id`;

function patchDisplayLabel(patch: CustomizationPatch): string | null {
  switch (patch.kind) {
    case 'addField':
      return patch.field.label;
    case 'addChoice':
      return patch.option;
    case 'addRecordType':
    case 'saveListView':
    case 'addMetricCard':
      return patch.label;
    case 'arrangeLayout':
      return 'upFront' in patch ? 'form' : 'list';
    default:
      return null;
  }
}

function patchRecord(row: PatchRow): PatchRecord {
  return Object.freeze({
    compilerAcknowledgement: row.compiler_acknowledgement,
    baseReleaseRoot: row.base_release_root,
    channel: row.channel,
    createdAt: new Date(row.created_at).toISOString(),
    kind: row.patch_kind,
    displayLabel: row.display_label,
    payloadDigest: row.payload_digest,
    parentRevisionId: row.parent_revision_id,
    patchId: row.patch_id,
    resultingReleaseId: row.resulting_release_id,
    resultingReleaseRoot: row.resulting_release_root,
    resultingRevisionId: row.resulting_revision_id,
  });
}

interface UpgradeRow {
  compiler_acknowledgement: AcknowledgementInput | null;
  upgrade_id: MintedUuid;
  source_release_id: MintedUuid;
  base_release_id: MintedUuid;
  candidate_release_id: MintedUuid;
  candidate_revision_id: MintedUuid;
  payload: Uint8Array;
  payload_digest: string;
}

function upgradeRecord(row: UpgradeRow): UpgradeRecord {
  const record = parseUpgradeRecord(row);
  if (!record)
    throw new CustomizationServiceRefusal(
      'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
      'the upgrade does not match its recorded binding',
    );
  return record;
}

function parseUpgradeRecord(row: UpgradeRow): UpgradeRecord | null {
  const bytes = Buffer.from(row.payload);
  let payload: Record<string, unknown> | null;
  try {
    payload = JSON.parse(bytes.toString('utf8')) as Record<
      string,
      unknown
    > | null;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const patchIds = payload.patchIds;
  if (
    createHash('sha256').update(bytes).digest('hex') !== row.payload_digest ||
    payload.version !== 'northstar.customization-upgrade/v1' ||
    payload.sourceReleaseId !== row.source_release_id ||
    payload.baseReleaseId !== row.base_release_id ||
    payload.candidateReleaseId !== row.candidate_release_id ||
    payload.candidateRevisionId !== row.candidate_revision_id ||
    !Array.isArray(patchIds) ||
    patchIds.length === 0 ||
    patchIds.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id),
    ) ||
    new Set(patchIds).size !== patchIds.length
  )
    return null;
  return {
    compilerAcknowledgement: row.compiler_acknowledgement,
    upgradeId: row.upgrade_id,
    sourceReleaseId: row.source_release_id,
    baseReleaseId: row.base_release_id,
    candidateReleaseId: row.candidate_release_id,
    candidateRevisionId: row.candidate_revision_id,
    patchIds: patchIds as MintedUuid[],
  };
}
