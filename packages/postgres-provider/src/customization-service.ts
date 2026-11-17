import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  compileInSandbox,
  CUSTOMIZATION_PATCH_VERSION,
  parseCustomizationPatch,
  parseSerializedRelease,
  serializeRelease,
  storageElements,
  type AcknowledgementInput,
  type CustomizationPatch,
  type SandboxRunnerOptions,
  type SandboxStep,
} from '@north-star/customization';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import pg from 'pg';

import type { PostgresCapabilityOperationExecutorFactory } from './capability-operation-executor-factory.js';
import {
  activateWithExactSwapTrigger,
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
  releaseDiffBinding,
  rolePool,
  trustedContext,
  type ParsedRelease,
  type PersistedReleaseIdentity,
  type ScopeIdentities,
} from './composed-application-runtime.js';
import type { ModuleProviderErrorMapping } from './module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from './module-storage-materializer.js';
import { PostgresReleaseActivationService } from './release-activation-service.js';
import { authorizeReverseTransitionIfApplicable } from './release-reverse-transition-policy.js';
import { withTrustedRequestTransaction } from './request-context.js';

/**
 * Tenant customization over the composed application (CUSTOMIZE packet). A
 * typed patch becomes an append-only patch record (ADR-0013), a tenant-authored
 * child revision of the active one, a staged release compiled in the isolated
 * worker, and a plain-language diff. Nothing here activates anything: drafting
 * changes no pointer and no serving state.
 */
export const AUTHORING_CHANNELS = [
  'firstPartyAuthoring',
  'visualBuilder',
  'conversationalAi',
  'importTemplate',
  'declarativeEditor',
] as const;
export type AuthoringChannel = (typeof AUTHORING_CHANNELS)[number];

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
  | 'CUSTOMIZE_ACTIVATION_FAILED';

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
  readonly channel: AuthoringChannel;
  readonly createdAt: string;
  readonly kind: CustomizationPatch['kind'];
  readonly parentRevisionId: MintedUuid;
  readonly patch: CustomizationPatch;
  readonly patchId: MintedUuid;
  readonly resultingReleaseId: MintedUuid;
  readonly resultingReleaseRoot: string;
  readonly resultingRevisionId: MintedUuid;
}

export interface CustomizationStatus {
  readonly activeReleaseId: MintedUuid;
  readonly activeReleaseRoot: string;
  /** Applied patches of the active release, oldest first. */
  readonly activeChain: readonly PatchRecord[];
  readonly patches: readonly PatchRecord[];
}

interface ActiveState {
  readonly chain: readonly PatchRecord[];
  readonly pointer: Awaited<ReturnType<typeof readPointer>>;
  readonly releaseId: MintedUuid;
  readonly releaseRoot: string;
  readonly revisionId: MintedUuid;
}

export class PostgresCustomizationService {
  readonly #tip: ParsedRelease;
  readonly #baseBytes: Uint8Array;
  #runtimeContext: TrustedRequestContext | undefined;

  constructor(
    private readonly connection: CustomizationConnection,
    private readonly options: CustomizationServiceOptions,
  ) {
    this.#tip = parseCompiledApplication(
      options.compiledApplication,
    ).application;
    this.#baseBytes = new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(options.firstPartyAuthored)),
    );
  }

  async status(): Promise<CustomizationStatus> {
    const context = await this.#context();
    const active = await this.#active(context);
    return Object.freeze({
      activeChain: active.chain,
      activeReleaseId: active.releaseId,
      activeReleaseRoot: active.releaseRoot,
      patches: await this.#patches(context),
    });
  }

  /**
   * Drafts one patch on the active release. Refused, unsupported and
   * compiler-rejected requests leave nothing behind; a drafted one leaves its
   * patch record, its child revision and its staged release.
   */
  async draft(
    input: unknown,
    channel: AuthoringChannel,
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
    const compiled = await this.#compile([
      ...active.chain.map((record) => record.patch),
      parsed.patch,
    ]);
    if (compiled.status !== 'compiled') return compiled;
    const { steps } = compiled;
    this.#assertReproduced(active.chain, steps);
    const step = steps.at(-1)!;
    const candidate = parseSerializedRelease(step.release);
    const identity = await ensurePersistedRelease(
      this.connection.runtimePool,
      context,
      candidate,
      active.revisionId,
      'tenantAuthored',
    );
    const payload = new TextEncoder().encode(canonicalize(parsed.patch));
    const payloadDigest = createHash('sha256').update(payload).digest('hex');
    const normalized = parseNormalizedApplicationPackageJson(
      candidate.normalizedDefinitionBytes,
    );
    const firstParty = parseNormalizedApplicationPackageJson(this.#baseBytes);
    const baseRevisionId =
      active.chain[0]?.parentRevisionId ?? active.revisionId;
    const row = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        // The table's append-only rules rule out ON CONFLICT, so a re-draft
        // is found first; two identical drafts racing meet the unique key.
        const existing = await client.query<{ patch_id: MintedUuid }>(
          `SELECT patch_id FROM platform.customization_patches
            WHERE tenant_id = $1 AND environment_id = $2
              AND parent_revision_id = $3 AND payload_digest = $4`,
          [
            context.tenantId,
            context.environmentId,
            active.revisionId,
            payloadDigest,
          ],
        );
        if (existing.rows[0]) {
          return { patchId: existing.rows[0].patch_id, reused: true };
        }
        const patchId = randomUUID() as MintedUuid;
        await client.query(
          `INSERT INTO platform.customization_patches (
             tenant_id, environment_id, patch_id, patch_version, patch_kind,
             payload, payload_digest, channel, authored_by, base_package_id,
             base_package_version, base_revision_id, base_release_root,
             parent_revision_id, resulting_revision_id, resulting_release_id,
             language_version, normalization_profile_version
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
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
          ],
        );
        return { patchId, reused: false };
      },
    );
    return Object.freeze({
      canonicalDiffDigest: step.diff.canonicalDiffDigest,
      patchId: row.patchId,
      releaseId: identity.releaseId,
      releaseRoot: candidate.compiled.releaseRoot,
      renderedDigest: step.rendered.renderedDigest,
      renderedDiff: step.rendered.text,
      revisionId: identity.revisionId,
      reused: row.reused,
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
    const context = await this.#context();
    const active = await this.#active(context);
    const record = await this.#patch(context, patchId);
    if (active.chain.some((applied) => applied.patchId === record.patchId)) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ALREADY_ACTIVE',
        'this change is already live',
      );
    }
    if (record.parentRevisionId !== active.revisionId) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_DRAFT_STALE',
        'the live application changed after this change was drafted; draft it again',
      );
    }
    const { parent, candidate } = await this.#reproduce([
      ...active.chain,
      record,
    ]);
    const identity = await this.#identity(context, record.resultingReleaseId);
    await ensureReleaseAdmitted(
      this.connection.runtimePool,
      context,
      identity,
      candidate,
      this.options.providerErrorMappings ?? [],
      this.options.capabilityOperationExecutorFactories ?? [],
    );
    const binding = releaseDiffBinding(parent, candidate);
    const approver = await trustedContext(this.connection.identities.approver);
    await assertExactSwapTriggerEnabled(this.connection.adminPool);
    let activationAttemptId: MintedUuid;
    if (storageElements(candidate.compiled).length === 0) {
      activationAttemptId = await approveReleaseWithoutStorageTransition(
        this.connection.runtimePool,
        context,
        approver,
        active.pointer,
        parent,
        identity,
        candidate.compiled,
        binding,
      );
    } else {
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
      );
    }
    return Object.freeze({
      activationAttemptId,
      renderedDiff: binding.renderedText,
      status: 'approved' as const,
    });
  }

  /**
   * Activates an approved change through the activation kernel's CAS, fence
   * and verification. A running server serves it from its next request.
   */
  async activate(patchId: string): Promise<ActivationOutcome> {
    const context = await this.#context();
    const active = await this.#active(context);
    const record = await this.#patch(context, patchId);
    if (active.chain.some((applied) => applied.patchId === record.patchId)) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ALREADY_ACTIVE',
        'this change is already live',
      );
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
    if (approved.transition_plan_digest !== null) {
      const generation = await this.connection.adminPool.query<{
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
        this.connection.adminPool,
        this.connection.identities,
        await this.#desiredState(context, record.resultingRevisionId),
      );
    }
    return this.#swap(
      context,
      approved.activation_attempt_id,
      record,
      'activated',
    );
  }

  /**
   * One click: the active change is reversed to the release its activation
   * came from, through the reverse-transition policy. Storage stays: the rows
   * entered under the change are kept and return if it is activated again.
   */
  async rollback(): Promise<ActivationOutcome> {
    const context = await this.#context();
    const active = await this.#active(context);
    const record = active.chain.at(-1);
    if (!record) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_NOTHING_TO_ROLL_BACK',
        'the live application has no customization to roll back',
      );
    }
    const targetReleaseId = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const swap = await client.query<{ previous_release_id: MintedUuid }>(
          `SELECT previous_release_id
             FROM platform.release_activation_swap_receipts
            WHERE tenant_id = $1 AND environment_id = $2
              AND activated_release_id = $3 AND fence = $4`,
          [
            context.tenantId,
            context.environmentId,
            active.releaseId,
            active.pointer.fence,
          ],
        );
        return swap.rows[0]?.previous_release_id ?? null;
      },
    );
    if (!targetReleaseId) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_NOTHING_TO_ROLL_BACK',
        'the live customization has no recorded activation to reverse',
      );
    }
    const reverse = await withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) =>
        authorizeReverseTransitionIfApplicable(client, context, {
          expectedFence: active.pointer.fence,
          sourceReleaseId: active.releaseId,
          targetReleaseId,
        }),
    );
    if (!reverse) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_NOTHING_TO_ROLL_BACK',
        'the previous release is not the exact parent of the live customization',
      );
    }
    const { parent, candidate } = await this.#reproduce(active.chain);
    const target = await this.#identity(context, targetReleaseId);
    if (
      parent.compiled.releaseRoot !==
      (await this.#root(context, targetReleaseId))
    ) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        'the release to roll back to is not the parent the customization was built on',
      );
    }
    await assertExactSwapTriggerEnabled(this.connection.adminPool);
    const attemptId = await approveReleaseWithoutStorageTransition(
      this.connection.runtimePool,
      context,
      await trustedContext(this.connection.identities.approver),
      active.pointer,
      candidate,
      target,
      parent.compiled,
      releaseDiffBinding(candidate, parent, 'reverse'),
      reverse,
    );
    return this.#swap(
      context,
      attemptId,
      record,
      'rolledBack',
      targetReleaseId,
    );
  }

  async #swap(
    context: TrustedRequestContext,
    activationAttemptId: MintedUuid,
    record: PatchRecord,
    status: ActivationOutcome['status'],
    expectedReleaseId: MintedUuid = record.resultingReleaseId,
  ): Promise<ActivationOutcome> {
    const activated = await activateWithExactSwapTrigger(
      this.connection.adminPool,
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
    if (pointer.releaseId !== expectedReleaseId) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_ACTIVATION_FAILED',
        'activation selected another release',
      );
    }
    return Object.freeze({
      releaseId: expectedReleaseId,
      releaseRoot: await this.#root(context, expectedReleaseId),
      status,
    });
  }

  /**
   * Re-applies a recorded chain in the isolated worker and checks every link
   * against the release recorded for it; returns the last link and its parent.
   */
  async #reproduce(chain: readonly PatchRecord[]): Promise<{
    readonly candidate: ParsedRelease;
    readonly parent: ParsedRelease;
  }> {
    const compiled = await this.#compile(chain.map((record) => record.patch));
    if (compiled.status !== 'compiled') {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
        `a recorded change no longer compiles: ${compiled.message}`,
      );
    }
    this.#assertReproduced(chain, compiled.steps);
    const releases = compiled.steps.map((step) =>
      parseSerializedRelease(step.release),
    );
    return {
      candidate: releases.at(-1)!,
      parent: releases.at(-2) ?? this.#tip,
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
  ): Promise<
    | { readonly status: 'compiled'; readonly steps: readonly SandboxStep[] }
    | Exclude<DraftOutcome, { status: 'drafted' }>
  > {
    const response = await compileInSandbox(
      {
        acknowledgement: this.options.acknowledgement,
        base: this.options.firstPartyAuthored,
        chain,
        tip: serializeRelease(this.#tip),
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
  async #active(context: TrustedRequestContext): Promise<ActiveState> {
    if (
      !Buffer.from(this.#baseBytes).equals(
        Buffer.from(this.#tip.normalizedDefinitionBytes),
      )
    ) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_BASE_STALE',
        'app.authored.json no longer compiles to the checked-in release; run corepack pnpm --filter @north-star/web build:app-release',
      );
    }
    const pointer = await readPointer(this.connection.runtimePool, context);
    if (pointer.releaseId === null) {
      throw new CustomizationServiceRefusal(
        'CUSTOMIZE_NOT_STARTED',
        'the application has never started in this database; run corepack pnpm dev once',
      );
    }
    const releaseId = pointer.releaseId;
    return withTrustedRequestTransaction(
      this.connection.runtimePool,
      context,
      async (client) => {
        const release = await client.query<{
          content_hash: string;
          provenance: string;
          revision_id: MintedUuid;
        }>(
          `SELECT release.content_hash, revision.provenance,
                  revision.revision_id
             FROM platform.tenant_releases AS release
             JOIN platform.app_package_revisions AS revision
               ON revision.tenant_id = release.tenant_id
              AND revision.revision_id = release.app_package_revision_id
            WHERE release.tenant_id = $1 AND release.environment_id = $2
              AND release.release_id = $3`,
          [context.tenantId, context.environmentId, releaseId],
        );
        const row = release.rows[0];
        if (!row) {
          throw new CustomizationServiceRefusal(
            'CUSTOMIZE_ACTIVE_RELEASE_UNKNOWN',
            'the active release is not visible',
          );
        }
        const chain: PatchRecord[] = [];
        let revisionId = row.revision_id;
        let provenance = row.provenance;
        while (provenance === 'tenantAuthored') {
          const patch = await client.query<PatchRow>(
            `${PATCH_SELECT}
              WHERE patch.tenant_id = $1 AND patch.environment_id = $2
                AND patch.resulting_revision_id = $3
              ORDER BY patch.created_at, patch.patch_id LIMIT 1`,
            [context.tenantId, context.environmentId, revisionId],
          );
          const record = patch.rows[0];
          if (!record) {
            throw new CustomizationServiceRefusal(
              'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
              `tenant revision ${revisionId} has no recorded patch`,
            );
          }
          chain.unshift(patchRecord(record));
          revisionId = record.parent_revision_id;
          const parent = await client.query<{ provenance: string }>(
            `SELECT provenance FROM platform.app_package_revisions
              WHERE tenant_id = $1 AND revision_id = $2`,
            [context.tenantId, revisionId],
          );
          provenance = parent.rows[0]?.provenance ?? 'firstParty';
        }
        const base = await client.query<{ content_hash: string }>(
          `SELECT content_hash FROM platform.app_package_revisions
            WHERE tenant_id = $1 AND revision_id = $2`,
          [context.tenantId, revisionId],
        );
        const tipHash = canonicalizeAndHash(
          parseNormalizedApplicationPackageJson(
            this.#tip.normalizedDefinitionBytes,
          ),
        ).contentHash;
        if (base.rows[0]?.content_hash !== tipHash) {
          throw new CustomizationServiceRefusal(
            chain.length > 0
              ? 'CUSTOMIZE_BASE_MOVED'
              : 'CUSTOMIZE_ACTIVE_RELEASE_UNKNOWN',
            chain.length > 0
              ? 'the first-party application moved under this customization; pre-tenant remedy: corepack pnpm --filter @north-star/api dev:reset'
              : 'the active release is not the checked-in application; restart corepack pnpm dev',
          );
        }
        return Object.freeze({
          chain: Object.freeze(chain),
          pointer,
          releaseId,
          releaseRoot: row.content_hash,
          revisionId: row.revision_id,
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
  channel: AuthoringChannel;
  created_at: Date | string;
  parent_revision_id: MintedUuid;
  patch_id: MintedUuid;
  patch_kind: CustomizationPatch['kind'];
  payload: Uint8Array;
  payload_digest: string;
  resulting_release_id: MintedUuid;
  resulting_release_root: string;
  resulting_revision_id: MintedUuid;
}

const PATCH_SELECT = `SELECT patch.patch_id, patch.patch_kind, patch.payload,
       patch.payload_digest, patch.channel, patch.parent_revision_id,
       patch.resulting_revision_id, patch.resulting_release_id,
       release.content_hash AS resulting_release_root, patch.created_at
  FROM platform.customization_patches AS patch
  JOIN platform.tenant_releases AS release
    ON release.tenant_id = patch.tenant_id
   AND release.environment_id = patch.environment_id
   AND release.release_id = patch.resulting_release_id`;

/** A stored patch is re-read through the same schema; tampering fails closed. */
function patchRecord(row: PatchRow): PatchRecord {
  const payload = Buffer.from(row.payload);
  if (
    createHash('sha256').update(payload).digest('hex') !== row.payload_digest
  ) {
    throw new CustomizationServiceRefusal(
      'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
      `patch ${row.patch_id} does not match its recorded digest`,
    );
  }
  const parsed = parseCustomizationPatch(JSON.parse(payload.toString('utf8')));
  if (parsed.status !== 'parsed' || parsed.patch.kind !== row.patch_kind) {
    throw new CustomizationServiceRefusal(
      'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
      `patch ${row.patch_id} no longer reads as a supported patch`,
    );
  }
  return Object.freeze({
    channel: row.channel,
    createdAt: new Date(row.created_at).toISOString(),
    kind: parsed.patch.kind,
    parentRevisionId: row.parent_revision_id,
    patch: parsed.patch,
    patchId: row.patch_id,
    resultingReleaseId: row.resulting_release_id,
    resultingReleaseRoot: row.resulting_release_root,
    resultingRevisionId: row.resulting_revision_id,
  });
}
