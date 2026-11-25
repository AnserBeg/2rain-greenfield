import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import type { CustomizationPatch } from '../../packages/customization/src/index.js';
import {
  HASH_ALGORITHM,
  HASH_DOMAINS,
  PROJECTION_FAMILY_IDS,
  type CompileSuccess,
  type ContentAddressedArtifact,
  type ProjectionManifestEnvelope,
} from '../../packages/compiler/src/index.js';
import type {
  MintedUuid,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { compileReportFixture } from '../helpers/reports-preceding-release.js';

// REPORTS-1 s2: release admission with a mocked pool (no database), kept out
// of the catch-all shard. The release helpers mirror test/postgres/releases.test.ts.
const revisionA = 'a3000000-0000-4000-8000-000000000003' as MintedUuid;
const releaseA = 'a4000000-0000-4000-8000-000000000004' as MintedUuid;
function requestEntry(): AuthenticatedRequestEntryAdapter {
  return new AuthenticatedRequestEntryAdapter(async (request) =>
    request.headers?.authorization === 'session-a'
      ? {
          environmentId: 'a1000000-0000-4000-8000-000000000001',
          principalId: 'aa000000-0000-4000-8000-000000000001',
          tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }
      : null,
  );
}
async function contextFor(
  entry: AuthenticatedRequestEntryAdapter,
  session: string,
): Promise<TrustedRequestContext> {
  return entry.enter({ headers: { authorization: session } });
}

test('release admission refuses an analysed report or a named measure whose release understates its reader floor', async (t) => {
  const { applyCustomizationPatches } =
    await import('../../packages/customization/src/index.js');
  const { reportTargets, draftReport } =
    await import('../../packages/customization/src/report-revision.js');
  const { draftMeasure } =
    await import('../../packages/customization/src/measure-revision.js');
  const { readReportsPredecessor } =
    await import('../helpers/reports-preceding-release.js');
  const { reportAnalysisTypes } =
    await import('../helpers/report-analysis-fixture.js');
  const { REPORT_ANALYSIS_READER, REPORT_MEASURE_READER } =
    await import('../../packages/canonical-model/src/declared-report-v2.js');
  const { DEFAULT_AGE_BANDS, ReportChoicesSchema } =
    await import('../../packages/canonical-model/src/index.js');
  const applied = applyCustomizationPatches(
    readReportsPredecessor('apps/web/release/app.authored.json'),
    [reportAnalysisTypes],
  );
  assert.ok(applied.status === 'applied');
  const target = reportTargets(
    applied.authored as unknown as Parameters<typeof reportTargets>[0],
  ).find((r) => r.source.queryId.endsWith(':query.custom_inspection_list'))!;
  const aging = draftReport(
    target,
    'Inspection age',
    ReportChoicesSchema.parse({
      dimensions: [
        {
          kind: 'age',
          fieldId: 'northstar.app:field.custom_inspection_due',
          bands: DEFAULT_AGE_BANDS,
          absentLabel: 'No due date',
        },
      ],
      filters: [],
      measures: [
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_count',
          label: 'Count',
          operator: { kind: 'count' },
        },
      ],
      outputs: [{ kind: 'table' }],
    }),
  );
  const trial = draftMeasure(target, 'Inspections', 'trial', {
    kind: 'count',
  });
  const context = await contextFor(requestEntry(), 'session-a');
  const pool = new pg.Pool();
  t.after(() => pool.end());
  t.mock.method(pool, 'connect', () => {
    throw new Error('Understated candidate reached the staging transaction');
  });
  // One compile carries both (shard 3 is near its limit): floor 51. At 49 the
  // analysed-report check refuses; at 50 that check passes and the measure
  // check refuses.
  const { compiled, normalizedDefinitionBytes: bytes } =
    await compileReportFixture([
      // One ordered change set: the fixture compiles its first step only.
      {
        kind: 'changeSet',
        patches: [
          ...(reportAnalysisTypes as { patches: CustomizationPatch[] }).patches,
          aging,
          trial,
        ],
      } as CustomizationPatch,
    ]);
  assert.equal(
    compiled.bundle.releaseManifest.projections.find(
      (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
    )?.requiredRuntimeCapability.minimumVersion,
    REPORT_MEASURE_READER,
  );
  for (const [floor, code] of [
    [REPORT_ANALYSIS_READER - 1, 'REPORT_ANALYSIS_READER_MISMATCH'],
    [REPORT_MEASURE_READER - 1, 'REPORT_MEASURE_READER_MISMATCH'],
  ] as const) {
    const understated = rewriteProjectionPayload(
      compiled,
      PROJECTION_FAMILY_IDS.surfaceManifest,
      () => {},
      floor,
    );
    const repository = new PostgresImmutableReleaseRepository(pool);
    t.mock.method(repository, 'getAppPackageRevision', async () => ({
      ...revisionCommand(context, revisionA, bytes),
      createdAt: '2026-11-25T00:00:00.000Z',
    }));
    await assert.rejects(
      repository.stageTenantReleaseCandidate(context, {
        appPackageRevisionId: revisionA,
        compiledRelease: understated,
        createdBy: context.principalId,
        environmentId: context.environmentId,
        releaseId: releaseA,
        tenantId: context.tenantId,
      }),
      { code },
    );
  }
});

function rewriteProjectionPayload(
  compiled: CompileSuccess,
  familyId: string,
  mutate: (payload: Record<string, unknown>) => void,
  minimumVersion?: number,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const reference = clone.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const priorManifestRoot = reference.artifactRoot;
  const manifestArtifact = clone.bundle.artifacts.find(
    (candidate) => candidate.contentHash === priorManifestRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  if (minimumVersion !== undefined) {
    reference.requiredRuntimeCapability.minimumVersion = minimumVersion;
    manifest.requiredRuntimeCapability.minimumVersion = minimumVersion;
  }
  const descriptor = manifest.chunks[0];
  assert.ok(descriptor);
  const priorChunkRoot = descriptor.contentHash;
  const chunkArtifact = clone.bundle.artifacts.find(
    (candidate) => candidate.contentHash === priorChunkRoot,
  );
  assert.ok(chunkArtifact);
  const payload = JSON.parse(
    new TextDecoder().decode(chunkArtifact.canonicalBytes),
  ) as Record<string, unknown>;
  mutate(payload);
  const payloadBytes = new TextEncoder().encode(canonicalize(payload));
  const semanticDigest = hashBytes(
    `${HASH_DOMAINS.projectionSemantic}/${familyId}`,
    payloadBytes,
  );
  const chunkReplacement: ContentAddressedArtifact = {
    ...chunkArtifact,
    canonicalBytes: payloadBytes,
    contentHash: hashBytes(
      `${HASH_DOMAINS.projectionChunk}/${familyId}`,
      payloadBytes,
    ),
  };
  descriptor.byteLength = payloadBytes.byteLength;
  descriptor.contentHash = chunkReplacement.contentHash;
  manifest.semanticDigest = semanticDigest;
  const manifestBytes = new TextEncoder().encode(canonicalize(manifest));
  const manifestReplacement: ContentAddressedArtifact = {
    ...manifestArtifact,
    canonicalBytes: manifestBytes,
    contentHash: hashBytes(
      `${HASH_DOMAINS.projectionManifest}/${familyId}`,
      manifestBytes,
    ),
  };
  reference.artifactRoot = manifestReplacement.contentHash;
  reference.semanticDigest = semanticDigest;
  clone.bundle.releaseManifest.artifactClosure =
    clone.bundle.releaseManifest.artifactClosure
      .map((contentHash) =>
        contentHash === priorChunkRoot
          ? chunkReplacement.contentHash
          : contentHash === priorManifestRoot
            ? manifestReplacement.contentHash
            : contentHash,
      )
      .toSorted();
  clone.bundle.artifacts = replaceArtifact(
    replaceArtifact(clone.bundle.artifacts, priorChunkRoot, chunkReplacement),
    priorManifestRoot,
    manifestReplacement,
  );
  clone.stagedArtifacts = replaceArtifact(
    replaceArtifact(clone.stagedArtifacts, priorChunkRoot, chunkReplacement),
    priorManifestRoot,
    manifestReplacement,
  );
  const node = clone.bundle.nodeContracts.find(
    (candidate) => candidate.stableNodeId === `${reference.instanceId}.node`,
  );
  assert.ok(node);
  node.outputFingerprint = hashBytes(
    HASH_DOMAINS.nodeOutput,
    new TextEncoder().encode(
      canonicalize({
        artifactRoot: reference.artifactRoot,
        semanticDigest,
      }),
    ),
  );
  return rebuildReleaseRoot(clone);
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
  return rehashAttestation(compiled);
}

function rehashAttestation(compiled: CompileSuccess): CompileSuccess {
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

function replaceArtifact(
  artifacts: ContentAddressedArtifact[],
  priorHash: string,
  replacement: ContentAddressedArtifact,
): ContentAddressedArtifact[] {
  return artifacts.map((artifact) =>
    artifact.contentHash === priorHash ? replacement : artifact,
  );
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

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalizedDefinition =
    parseNormalizedApplicationPackageJson(desiredState);
  const normalized = canonicalizeAndHash(normalizedDefinition);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: normalized.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: normalizedDefinition.languageVersion,
    normalizationProfileVersion:
      normalizedDefinition.normalizationProfileVersion,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: normalizedDefinition.schemaVersion,
    tenantId: context.tenantId,
  };
}
