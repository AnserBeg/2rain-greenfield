import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalize,
  canonicalizeAndHash,
} from '../../packages/canonical-model/src/index.js';
import {
  HASH_ALGORITHM,
  HASH_DOMAINS,
  compileApplication,
  type CompileSuccess,
  type ContentAddressedArtifact,
} from '../../packages/compiler/src/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  ReleaseActivationAttemptIdentity,
  ReleaseApprovalIdentity,
  StoreAppPackageRevisionCommand,
  VerificationEvidenceIdentity,
} from '../../packages/platform-runtime/src/index.js';
import {
  PostgresImmutableReleaseRepository,
  ReleasePersistenceIdentityError,
  ReleasePersistenceIntegrityError,
} from '../../packages/postgres-provider/src/release-repository.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { compilerInput, fixtureBytes } from '../compiler/helpers.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentAPreview = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const principalA = 'aa000000-0000-4000-8000-000000000001';
const principalB = 'bb000000-0000-4000-8000-000000000001';

const revisionA = minted('a3000000-0000-4000-8000-000000000003');
const revisionB = minted('b3000000-0000-4000-8000-000000000003');
const verticalRevisionA = minted('a3000000-0000-4000-8000-000000000004');
const releaseA = minted('a4000000-0000-4000-8000-000000000004');
const releaseB = minted('b4000000-0000-4000-8000-000000000004');
const verticalReleaseA = minted('a4000000-0000-4000-8000-000000000005');
const evidenceA = minted('a5000000-0000-4000-8000-000000000005');
const evidenceB = minted('b5000000-0000-4000-8000-000000000005');
const verticalEvidenceA = minted('a5000000-0000-4000-8000-000000000006');

const identities = new Map<string, AuthenticatedIdentity>([
  [
    'session-a',
    {
      environmentId: environmentA,
      principalId: principalA,
      tenantId: tenantA,
    },
  ],
  [
    'session-a-preview',
    {
      environmentId: environmentAPreview,
      principalId: principalA,
      tenantId: tenantA,
    },
  ],
  [
    'session-b',
    {
      environmentId: environmentB,
      principalId: principalB,
      tenantId: tenantB,
    },
  ],
]);

test('immutable release persistence verifies bytes, identities, links, RLS, and deduplication', async (t) => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const verticalBytes = fixtureBytes('vertical-v1');
  const bootstrap = mustCompile(bootstrapBytes);
  const vertical = mustCompile(verticalBytes);

  await withEphemeralPostgres(
    'release-persistence',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedTenants(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const repository = new PostgresImmutableReleaseRepository(runtimePool);
        const entry = requestEntry();
        const contextA = await contextFor(entry, 'session-a');
        const contextAPreview = await contextFor(entry, 'session-a-preview');
        const contextB = await contextFor(entry, 'session-b');

        await t.test(
          'round trips bootstrap and vertical bytes exactly',
          async () => {
            await repository.storeAppPackageRevision(
              contextA,
              revisionCommand(contextA, revisionA, bootstrapBytes),
            );
            await repository.storeAppPackageRevision(
              contextB,
              revisionCommand(contextB, revisionB, bootstrapBytes),
            );
            await repository.storeAppPackageRevision(
              contextA,
              revisionCommand(contextA, verticalRevisionA, verticalBytes),
            );

            const storedA = await repository.registerTenantRelease(
              contextA,
              releaseCommand(
                contextA,
                releaseA,
                revisionA,
                evidenceA,
                bootstrap,
              ),
            );
            const storedB = await repository.registerTenantRelease(
              contextB,
              releaseCommand(
                contextB,
                releaseB,
                revisionB,
                evidenceB,
                bootstrap,
              ),
            );
            const storedVertical = await repository.registerTenantRelease(
              contextA,
              releaseCommand(
                contextA,
                verticalReleaseA,
                verticalRevisionA,
                verticalEvidenceA,
                vertical,
              ),
            );

            assertReleaseBytes(storedA.artifacts, bootstrap);
            assertReleaseBytes(storedB.artifacts, bootstrap);
            assertReleaseBytes(storedVertical.artifacts, vertical);
            assert.equal(storedA.release.contentHash, bootstrap.releaseRoot);
            assert.equal(
              storedVertical.release.contentHash,
              vertical.releaseRoot,
            );
            assert.equal(
              storedA.release.compilerAttestationDigest,
              bootstrap.attestation.attestationDigest,
            );
            assert.deepEqual(
              [
                ...(await repository.getAppPackageRevision(
                  contextA,
                  revisionA,
                ))!.desiredState,
              ],
              [...bootstrapBytes],
            );
          },
        );

        await t.test(
          'two-tenant collision matrix mints identities and shares only policy-free blobs',
          async () => {
            assert.notEqual(revisionA, revisionB);
            assert.notEqual(releaseA, releaseB);
            assert.notEqual(evidenceA, evidenceB);
            assert.notEqual(releaseA, bootstrap.releaseRoot);
            assert.notEqual(releaseB, bootstrap.releaseRoot);
            assert.equal(releaseA.length, 36);
            assert.equal(bootstrap.releaseRoot.length, 64);

            const approvalA: ReleaseApprovalIdentity = {
              approvalId: minted('a6000000-0000-4000-8000-000000000006'),
              environmentId: environmentA,
              releaseId: releaseA,
              tenantId: tenantA,
              verificationEvidenceId: evidenceA,
            };
            const approvalB: ReleaseApprovalIdentity = {
              approvalId: minted('b6000000-0000-4000-8000-000000000006'),
              environmentId: environmentB,
              releaseId: releaseB,
              tenantId: tenantB,
              verificationEvidenceId: evidenceB,
            };
            const attemptA: ReleaseActivationAttemptIdentity = {
              activationAttemptId: minted(
                'a7000000-0000-4000-8000-000000000007',
              ),
              approvalId: approvalA.approvalId,
              environmentId: environmentA,
              tenantId: tenantA,
            };
            const verificationA: VerificationEvidenceIdentity = {
              environmentId: environmentA,
              releaseId: releaseA,
              tenantId: tenantA,
              verificationEvidenceId: evidenceA,
            };
            assert.notEqual(approvalA.approvalId, approvalB.approvalId);
            assert.notEqual(attemptA.activationAttemptId, approvalA.approvalId);
            assert.equal(verificationA.verificationEvidenceId, evidenceA);

            await assert.rejects(
              repository.storeAppPackageRevision(
                contextB,
                revisionCommand(contextB, revisionA, bootstrapBytes),
              ),
              /duplicate key/,
            );
            await assert.rejects(
              repository.registerTenantRelease(
                contextB,
                releaseCommand(
                  contextB,
                  releaseA,
                  revisionB,
                  minted('b5000000-0000-4000-8000-000000000099'),
                  bootstrap,
                ),
              ),
              /duplicate key/,
            );

            const admin = await pool.connect();
            try {
              const physical = await admin.query<{ count: string }>(
                'SELECT count(*) FROM platform.release_artifact_blobs',
              );
              const expected = new Set(
                [
                  ...bootstrap.bundle.artifacts,
                  ...vertical.bundle.artifacts,
                ].map((artifact) => artifact.contentHash),
              );
              assert.equal(physical.rows[0]?.count, String(expected.size));
              const tenantColumns = await admin.query<{ count: string }>(`
              SELECT count(*)
                FROM information_schema.columns
               WHERE table_schema = 'platform'
                 AND table_name = 'release_artifact_blobs'
                 AND column_name IN (
                   'tenant_id',
                   'environment_id',
                   'principal_id',
                   'coordinator_id'
                 )
            `);
              assert.equal(tenantColumns.rows[0]?.count, '0');
            } finally {
              admin.release();
            }
          },
        );

        await t.test(
          'tenant and environment reads fail closed on one reused connection',
          async () => {
            assert.equal(
              await repository.getAppPackageRevision(contextA, revisionB),
              null,
            );
            assert.equal(
              await repository.getTenantRelease(contextA, releaseB),
              null,
            );
            assert.equal(
              await repository.getTenantRelease(contextB, releaseA),
              null,
            );
            assert.equal(
              await repository.getTenantRelease(contextAPreview, releaseA),
              null,
            );

            const backendA = await backendPid(runtimePool, contextA);
            const backendB = await backendPid(runtimePool, contextB);
            assert.equal(backendA, backendB);

            const noContext = await runtimePool.connect();
            try {
              const settings = await noContext.query<{
                environment_id: string | null;
                principal_id: string | null;
                tenant_id: string | null;
              }>(`
              SELECT nullif(current_setting('north_star.tenant_id', true), '') AS tenant_id,
                     nullif(current_setting('north_star.environment_id', true), '') AS environment_id,
                     nullif(current_setting('north_star.principal_id', true), '') AS principal_id
            `);
              assert.deepEqual(settings.rows[0], {
                environment_id: null,
                principal_id: null,
                tenant_id: null,
              });
              const hidden = await noContext.query<{ count: string }>(
                'SELECT count(*) FROM platform.tenant_releases',
              );
              assert.equal(hidden.rows[0]?.count, '0');
              await assert.rejects(
                noContext.query(
                  'SELECT count(*) FROM platform.release_artifact_blobs',
                ),
                /permission denied/,
              );
            } finally {
              noContext.release();
            }
          },
        );

        await t.test(
          'corrupt, missing, mislinked, wrong-domain, closure, attestation, and scope inputs register no root',
          async () => {
            const initialRoots = await releaseCount(pool);
            const cases: Array<{ code: string; compiled: CompileSuccess }> = [
              {
                code: 'ARTIFACT_CONTENT_HASH_MISMATCH',
                compiled: corruptArtifactByte(bootstrap),
              },
              {
                code: 'PROJECTION_CHUNK_MISSING',
                compiled: removeArtifact(bootstrap),
              },
              {
                code: 'PROJECTION_MANIFEST_MISSING',
                compiled: wrongProjectionLink(bootstrap),
              },
              {
                code: 'ARTIFACT_CONTENT_HASH_MISMATCH',
                compiled: wrongArtifactDomain(bootstrap),
              },
              {
                code: 'ARTIFACT_CLOSURE_MISMATCH',
                compiled: wrongArtifactClosure(bootstrap),
              },
              {
                code: 'COMPILER_ATTESTATION_MISMATCH',
                compiled: wrongAttestation(bootstrap),
              },
            ];

            for (const [index, fixture] of cases.entries()) {
              await assert.rejects(
                repository.registerTenantRelease(
                  contextA,
                  releaseCommand(
                    contextA,
                    minted(
                      `c4000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                    ),
                    revisionA,
                    minted(
                      `c5000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                    ),
                    fixture.compiled,
                  ),
                ),
                (error: unknown) =>
                  error instanceof ReleasePersistenceIntegrityError &&
                  error.code === fixture.code,
              );
              assert.equal(await releaseCount(pool), initialRoots);
            }

            await assert.rejects(
              repository.registerTenantRelease(contextA, {
                ...releaseCommand(
                  contextA,
                  minted('c4000000-0000-4000-8000-000000000010'),
                  revisionA,
                  minted('c5000000-0000-4000-8000-000000000010'),
                  bootstrap,
                ),
                environmentId: environmentAPreview,
              }),
              ReleasePersistenceIdentityError,
            );
            await assert.rejects(
              repository.registerTenantRelease(
                contextA,
                releaseCommand(
                  contextA,
                  minted('c4000000-0000-4000-8000-000000000011'),
                  revisionB,
                  minted('c5000000-0000-4000-8000-000000000011'),
                  bootstrap,
                ),
              ),
              (error: unknown) =>
                error instanceof ReleasePersistenceIntegrityError &&
                error.code === 'REVISION_NOT_FOUND',
            );
            assert.equal(await releaseCount(pool), initialRoots);
          },
        );

        await t.test(
          'database privileges and rules deny mutation and hash-oracle reads',
          async () => {
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                contextA,
                async (client) =>
                  client.query(
                    `UPDATE platform.tenant_releases
                      SET compiler_version = 'changed'
                    WHERE release_id = $1`,
                    [releaseA],
                  ),
              ),
              /permission denied/,
            );
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                contextA,
                async (client) =>
                  client.query(
                    'DELETE FROM platform.tenant_releases WHERE release_id = $1',
                    [releaseA],
                  ),
              ),
              /permission denied/,
            );

            const admin = await pool.connect();
            try {
              const privileges = await admin.query<{
                blob_select: boolean;
                release_delete: boolean;
                release_insert: boolean;
                release_select: boolean;
                release_update: boolean;
              }>(`
              SELECT has_table_privilege(
                       'north_star_runtime',
                       'platform.release_artifact_blobs',
                       'SELECT'
                     ) AS blob_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'SELECT'
                     ) AS release_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'INSERT'
                     ) AS release_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'UPDATE'
                     ) AS release_update,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'DELETE'
                     ) AS release_delete
            `);
              assert.deepEqual(privileges.rows[0], {
                blob_select: false,
                release_delete: false,
                release_insert: true,
                release_select: true,
                release_update: false,
              });
              const policyCommands = await admin.query<{
                command: string;
              }>(`
              SELECT cmd AS command
                FROM pg_catalog.pg_policies
               WHERE schemaname = 'platform'
                 AND tablename IN (
                   'app_package_revisions',
                   'tenant_releases',
                   'tenant_release_artifact_links',
                   'tenant_release_projection_links',
                   'tenant_release_chunk_links'
                 )
               ORDER BY tablename, policyname
            `);
              assert.deepEqual(
                policyCommands.rows.map(({ command }) => command),
                [
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                ],
              );

              for (const statement of [
                `UPDATE platform.app_package_revisions
                  SET provenance = 'changed'
                WHERE revision_id = '${revisionA}'`,
                `DELETE FROM platform.tenant_releases
                WHERE release_id = '${releaseA}'`,
                `UPDATE platform.release_artifact_blobs
                  SET domain_tag = 'changed'
                WHERE content_hash = '${bootstrap.releaseRoot}'`,
                `DELETE FROM platform.tenant_release_artifact_links
                WHERE release_id = '${releaseA}'`,
              ]) {
                await assert.rejects(
                  admin.query(statement),
                  /immutable_release_write_guard_reject|violates check constraint/,
                );
              }
              const rules = await admin.query<{ count: string }>(`
              SELECT count(*)
                FROM pg_catalog.pg_rewrite rewrite
                JOIN pg_catalog.pg_class relation
                  ON relation.oid = rewrite.ev_class
                JOIN pg_catalog.pg_namespace namespace
                  ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'platform'
                 AND rewrite.rulename ~ '_reject_(update|delete)$'
            `);
              assert.equal(rules.rows[0]?.count, '12');
            } finally {
              admin.release();
            }
          },
        );

        await t.test(
          'database collision guard compares bytes and metadata',
          async () => {
            const artifact = bootstrap.bundle.artifacts[0];
            assert.ok(artifact);
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                contextA,
                async (client) =>
                  client.query(
                    'SELECT platform.stage_release_artifact($1, $2, $3, $4, $5)',
                    [
                      artifact.contentHash,
                      artifact.artifactKind,
                      artifact.domainTag,
                      artifact.mediaType,
                      Buffer.from([...artifact.canonicalBytes, 0]),
                    ],
                  ),
              ),
              /content-address collision/,
            );
          },
        );
      } finally {
        await runtimePool.end();
      }
    },
  );
});

function requestEntry(): AuthenticatedRequestEntryAdapter {
  return new AuthenticatedRequestEntryAdapter(async (request) => {
    const authorization = request.headers?.authorization;
    return typeof authorization === 'string'
      ? (identities.get(authorization) ?? null)
      : null;
  });
}

async function contextFor(
  entry: AuthenticatedRequestEntryAdapter,
  session: string,
): Promise<TrustedRequestContext> {
  return entry.enter({ headers: { authorization: session } });
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalized = canonicalizeAndHash(
    JSON.parse(new TextDecoder().decode(desiredState)) as unknown,
  );
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: normalized.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: LANGUAGE_VERSION,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: LANGUAGE_VERSION,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  appPackageRevisionId: MintedUuid,
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
  };
}

function mustCompile(bytes: Uint8Array): CompileSuccess {
  const compiled = compileApplication(compilerInput(bytes));
  if (compiled.status !== 'compiled') {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }
  return compiled;
}

function assertReleaseBytes(
  stored: readonly {
    artifactKind: string;
    canonicalBytes: Uint8Array;
    contentHash: string;
    domainTag: string;
    mediaType: string;
  }[],
  compiled: CompileSuccess,
): void {
  const summary = (
    artifacts: readonly {
      artifactKind: string;
      canonicalBytes: Uint8Array;
      contentHash: string;
      domainTag: string;
      mediaType: string;
    }[],
  ) =>
    artifacts
      .map((artifact) => ({
        artifactKind: artifact.artifactKind,
        canonicalBytes: [...artifact.canonicalBytes],
        contentHash: artifact.contentHash,
        domainTag: artifact.domainTag,
        mediaType: artifact.mediaType,
      }))
      .toSorted((left, right) =>
        left.contentHash.localeCompare(right.contentHash),
      );
  assert.deepEqual(summary(stored), summary(compiled.bundle.artifacts));
}

function corruptArtifactByte(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const artifact = clone.bundle.artifacts.find(
    (candidate) => candidate.artifactKind === 'projectionChunk',
  );
  assert.ok(artifact);
  artifact.canonicalBytes[0] = (artifact.canonicalBytes[0] ?? 0) ^ 1;
  return clone;
}

function removeArtifact(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const removed = clone.bundle.artifacts.find(
    (artifact) => artifact.artifactKind === 'projectionChunk',
  );
  assert.ok(removed);
  clone.bundle.artifacts = clone.bundle.artifacts.filter(
    (artifact) => artifact.contentHash !== removed.contentHash,
  );
  clone.stagedArtifacts = clone.stagedArtifacts.filter(
    (artifact) => artifact.contentHash !== removed.contentHash,
  );
  return clone;
}

function wrongProjectionLink(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const projection = clone.bundle.releaseManifest.projections[0];
  assert.ok(projection);
  projection.artifactRoot = '0'.repeat(64);
  return rebuildReleaseRoot(clone);
}

function wrongArtifactDomain(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const artifact = clone.bundle.artifacts.find(
    (candidate) => candidate.artifactKind === 'projectionManifest',
  );
  assert.ok(artifact);
  artifact.domainTag = HASH_DOMAINS.projectionChunk;
  return clone;
}

function wrongArtifactClosure(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  clone.bundle.releaseManifest.artifactClosure.pop();
  return rebuildReleaseRoot(clone);
}

function wrongAttestation(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  clone.attestation.inputDefinitionDigest = '0'.repeat(64);
  return clone;
}

function rebuildReleaseRoot(compiled: CompileSuccess): CompileSuccess {
  const bytes = new TextEncoder().encode(
    canonicalize(compiled.bundle.releaseManifest),
  );
  const root = hashBytes(HASH_DOMAINS.releaseManifest, bytes);
  const replacement: ContentAddressedArtifact = {
    artifactKind: 'releaseManifest',
    canonicalBytes: bytes,
    contentHash: root,
    domainTag: HASH_DOMAINS.releaseManifest,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  compiled.bundle.releaseManifestBytes = bytes;
  compiled.releaseRoot = root;
  compiled.bundle.artifacts = replaceRootArtifact(
    compiled.bundle.artifacts,
    replacement,
  );
  compiled.stagedArtifacts = replaceRootArtifact(
    compiled.stagedArtifacts,
    replacement,
  );
  compiled.attestation.releaseRoot = root;
  const attestationBody: Record<string, unknown> = {
    ...compiled.attestation,
  };
  delete attestationBody.attestationDigest;
  compiled.attestation.attestationDigest = hashBytes(
    HASH_DOMAINS.compilerAttestation,
    new TextEncoder().encode(canonicalize(attestationBody)),
  );
  return compiled;
}

function replaceRootArtifact(
  artifacts: ContentAddressedArtifact[],
  replacement: ContentAddressedArtifact,
): ContentAddressedArtifact[] {
  return artifacts.map((artifact) =>
    artifact.artifactKind === 'releaseManifest' ? replacement : artifact,
  );
}

function hashBytes(domain: string, bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM)
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

async function backendPid(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<number> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    return result.rows[0]!.pid;
  });
}

async function releaseCount(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) FROM platform.tenant_releases',
  );
  return result.rows[0]!.count;
}

async function seedTenants(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'),
            ($1, $3, 'preview'),
            ($4, $5, 'production')`,
    [tenantA, environmentA, environmentAPreview, tenantB, environmentB],
  );
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
