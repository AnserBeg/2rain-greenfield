import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';

import {
  openCustomizeService,
  openComposedApplicationRuntime,
} from '../../apps/api/src/composition-root.js';
import type { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
} from '../../packages/compiler/src/index.js';
import {
  parseSerializedRelease,
  serializeRelease,
  type SerializedRelease,
} from '../../packages/customization/src/release-envelope.js';
import { worldOver } from '../agent/agent-world.js';
import { compilerInput, normalizedBytes } from '../compiler/helpers.js';
import {
  archivedItemQuery,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const precedingReader = '630e2aa690906af9256c5964c398ba90585515d2';
const ordinaryChange = {
  kind: 'addField',
  entity: 'northstar.app:entity.item',
  field: { label: 'Inspection notes', type: 'text' },
  screens: 'record',
};

interface Comparison {
  authored: Record<string, unknown>;
  acknowledgement: ReturnType<typeof readUnboundPermissionAcknowledgementFor>;
  bootstrap: SerializedRelease;
  applications: SerializedRelease[];
  tenant: SerializedRelease;
}

// Read the real first-party lineage and run the preceding tenant compiler with
// the exact same author choices. Both inputs come from the pinned tree so a
// subsequent, unrelated application release does not change this comparison.
const historicalReleases = `
import { readFile } from 'node:fs/promises';
import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
import { compileInSandbox } from './packages/customization/src/sandbox.ts';
const patch = JSON.parse(await readFile(process.argv[2], 'utf8'));
const authoredPath = 'apps/web/release/app.authored.json';
const authored = JSON.parse(await readFile(authoredPath, 'utf8'));
const { bootstrap, applications } = JSON.parse(await readFile('apps/web/release/app.compiled.json', 'utf8'));
const acknowledgement = readUnboundPermissionAcknowledgementFor(authoredPath, authored.package.packageId);
const result = await compileInSandbox({ acknowledgement, base: authored, chain: [patch], tip: applications.at(-1) });
if (result.status !== 'compiled') throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ authored, acknowledgement, bootstrap, applications, tenant: result.steps[0].release }));
`;

async function assertPersistedRelease(
  pool: pg.Pool,
  root: string,
  expected: SerializedRelease,
  provenance: 'firstParty' | 'tenantAuthored',
) {
  const { rows } = await pool.query<{
    desired_state: Buffer;
    canonical_bytes: Buffer;
    provenance: string;
  }>(
    `SELECT p.desired_state, m.canonical_bytes, p.provenance
       FROM platform.tenant_releases r
       JOIN platform.app_package_revisions p
         ON (p.tenant_id, p.revision_id) = (r.tenant_id, r.app_package_revision_id)
       JOIN platform.release_artifact_blobs m
         ON m.content_hash = r.content_hash AND m.artifact_kind = r.release_manifest_kind
      WHERE r.content_hash = $1`,
    [root],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provenance, provenance);
  assert.equal(root, expected.releaseRoot);
  assert.ok(
    rows[0]!.desired_state.equals(
      Buffer.from(expected.normalizedDefinitionBytesBase64, 'base64'),
    ),
    provenance + ' persisted definition bytes changed',
  );
  // The manifest stores the per-projection reader floors as well as the roots.
  assert.ok(
    rows[0]!.canonical_bytes.equals(
      Buffer.from(expected.releaseManifestBytesBase64, 'base64'),
    ),
    provenance + ' persisted release manifest changed',
  );
  const artifacts = await pool.query<{
    content_hash: string;
    canonical_bytes: Buffer;
  }>(
    `SELECT b.content_hash, b.canonical_bytes
       FROM platform.tenant_releases r
       JOIN platform.tenant_release_artifact_links l USING (tenant_id, environment_id, release_id)
       JOIN platform.release_artifact_blobs b
         ON b.content_hash = l.content_hash AND b.artifact_kind = l.artifact_kind
      WHERE r.content_hash = $1`,
    [root],
  );
  const stored = new Map(
    artifacts.rows.map((row) => [row.content_hash, row.canonical_bytes]),
  );
  const expectedArtifacts = expected.artifacts.filter(
    (artifact) => artifact.artifactKind !== 'releaseManifest',
  );
  assert.equal(stored.size, expectedArtifacts.length);
  for (const artifact of expectedArtifacts)
    assert.ok(
      stored
        .get(String(artifact.contentHash))
        ?.equals(Buffer.from(String(artifact.canonicalBytesBase64), 'base64')),
      provenance +
        ' persisted artifact differs at ' +
        String(artifact.contentHash),
    );
}

test(
  'releases without Discussion preserve stored first-party and tenant bytes and answer a query on the preceding reader',
  { timeout: 600_000 },
  async () => {
    await withArchivedCustomizationRuntime(precedingReader, async (run) => {
      const prior = (await run(
        historicalReleases,
        ordinaryChange,
      )) as Comparison;
      const expected = prior.applications.at(-1)!;
      const ancestors = prior.applications.slice(0, -1);
      const parent = parseSerializedRelease(
        ancestors.at(-1) ?? prior.bootstrap,
      );
      const bytes = normalizedBytes(prior.authored);
      const input = compilerInput(
        bytes,
        expectedActiveReleaseFrom(parent.compiled),
      );
      const compiled = compileApplicationRelease(
        {
          ...input,
          profile: {
            ...MODULE_COMPILER_PROFILE,
            languageVersion: input.profile.languageVersion,
            normalizationProfileVersion:
              input.profile.normalizationProfileVersion,
          },
        },
        prior.acknowledgement,
      );
      assert.ok(
        compiled.status === 'compiled',
        JSON.stringify(compiled.diagnostics),
      );
      const release = {
        schemaVersion: 'northstar.web:compiled-application-release/v2',
        bootstrap: prior.bootstrap,
        applications: [
          ...ancestors,
          serializeRelease({ compiled, normalizedDefinitionBytes: bytes }),
        ],
      };
      await withEphemeralPostgres(
        'discussion-compatibility',
        async ({ connection, pool }) => {
          const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
          const options = {
            databaseUrl,
            tenantSlug: 'discussion-compatibility',
            compiledApplication: release,
          };
          const runtime = await openComposedApplicationRuntime(options);
          try {
            const world = worldOver(runtime, String(connection.database));
            const item = await world.create('item', {
              sku: 'COMPAT-1',
              name: 'Reader check',
              base_unit: 'EA',
            });
            await assertPersistedRelease(
              pool,
              runtime.releaseRoot,
              expected,
              'firstParty',
            );
            assert.deepEqual(
              await run(archivedItemQuery, {
                databaseUrl,
                identity: runtime.identity,
                recordId: item.recordId,
              }),
              {
                outcome: 'exact',
                id: item.recordId,
                root: expected.releaseRoot,
              },
            );
            const opened = await openCustomizeService(options);
            try {
              const draft = await opened.service.draft(
                ordinaryChange,
                'visualBuilder',
              );
              assert.ok(draft.status === 'drafted', JSON.stringify(draft));
              await assertPersistedRelease(
                pool,
                draft.releaseRoot,
                prior.tenant,
                'tenantAuthored',
              );
            } finally {
              await opened.close();
            }
          } finally {
            await runtime.close();
          }
        },
        LINEAGE_INSTALL_VOLUME,
      );
    });
  },
);
