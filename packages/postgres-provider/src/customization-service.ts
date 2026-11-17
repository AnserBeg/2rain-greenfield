import { createHash } from 'node:crypto';

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
  type AcknowledgementInput,
  type CustomizationPatch,
  type SandboxRunnerOptions,
  type SandboxStep,
} from '@north-star/customization';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import pg from 'pg';

import {
  ensurePersistedRelease,
  ensureScope,
  migrate,
  parseCompiledApplication,
  readPointer,
  rolePool,
  trustedContext,
  type ParsedRelease,
  type ScopeIdentities,
} from './composed-application-runtime.js';
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
  | 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE';

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
}

export interface CustomizationConnection {
  readonly adminPool: pg.Pool;
  readonly identities: ScopeIdentities;
  readonly runtimePool: pg.Pool;
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
        const inserted = await client.query<{ patch_id: MintedUuid }>(
          `INSERT INTO platform.customization_patches (
             tenant_id, environment_id, patch_id, patch_version, patch_kind,
             payload, payload_digest, channel, authored_by, base_package_id,
             base_package_version, base_revision_id, base_release_root,
             parent_revision_id, resulting_revision_id, resulting_release_id,
             language_version, normalization_profile_version
           ) VALUES (
             $1,$2,gen_random_uuid(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15,$16,$17
           )
           ON CONFLICT (tenant_id, environment_id, parent_revision_id,
                        payload_digest) DO NOTHING
           RETURNING patch_id`,
          [
            context.tenantId,
            context.environmentId,
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
        if (inserted.rows[0]) {
          return { patchId: inserted.rows[0].patch_id, reused: false };
        }
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
        return { patchId: existing.rows[0]!.patch_id, reused: true };
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
  try {
    await migrate(adminPool, options.migrationsDirectory);
    const identities = await ensureScope(
      adminPool,
      options.tenantSlug,
      options.environmentSlug ?? 'production',
    );
    runtimePool = rolePool(options.databaseUrl, 'north_star_runtime', 4);
    const service = new PostgresCustomizationService(
      { adminPool, identities, runtimePool },
      options,
    );
    const pools = [adminPool, runtimePool];
    return Object.freeze({
      async close() {
        await Promise.all(pools.map((pool) => pool.end()));
      },
      service,
    });
  } catch (error) {
    await Promise.all(
      [adminPool, runtimePool]
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
