/**
 * A request runtime view over the checked-in compiled application release,
 * for unit tests that read the pinned projections without a database. Only
 * the projections and release identity are real; there is no principal.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';

interface CompiledArtifact {
  readonly contentHash: string;
  readonly canonicalBytesBase64: string;
}

interface CompiledApplication {
  readonly artifacts: readonly CompiledArtifact[];
  readonly releaseRoot: string;
  readonly releaseManifest: {
    readonly projections: readonly {
      familyId: string;
      artifactRoot: string;
    }[];
  };
}

let loaded: RequestRuntimeView | undefined;

export function compiledAppView(
  principalId = 'test-principal',
): RequestRuntimeView {
  if (!loaded) {
    const file = JSON.parse(
      readFileSync(resolve('apps/web/release/app.compiled.json'), 'utf8'),
    ) as {
      application?: CompiledApplication;
      applications?: CompiledApplication[];
    };
    const application = file.applications?.at(-1) ?? file.application;
    if (!application) throw new Error('missing compiled application head');
    loaded = compiledProjectionView(application);
  }
  return { ...loaded, principalId } as RequestRuntimeView;
}

export function compiledProjectionView(
  application: CompiledApplication,
): RequestRuntimeView {
  const artifacts = new Map(
    application.artifacts.map((artifact) => [artifact.contentHash, artifact]),
  );
  const decode = (hash: string): unknown => {
    const artifact = artifacts.get(hash);
    if (!artifact) throw new Error(`missing artifact ${hash}`);
    return JSON.parse(
      Buffer.from(artifact.canonicalBytesBase64, 'base64').toString('utf8'),
    ) as unknown;
  };
  const payload = (family: string): ImmutableJsonValue => {
    const reference = application.releaseManifest.projections.find(
      (candidate) =>
        candidate.familyId === `northstar.compiler:projection-family.${family}`,
    );
    if (!reference) throw new Error(`missing projection ${family}`);
    const manifest = decode(reference.artifactRoot) as {
      chunks: readonly { contentHash: string }[];
    };
    return decode(manifest.chunks[0]!.contentHash) as ImmutableJsonValue;
  };
  const projection = (family: string) => ({ payload: payload(family) });
  return {
    projections: {
      agent: projection('agent-discovery'),
      catalog: projection('semantic-model'),
      operation: projection('operation-catalog'),
      query: projection('query-catalog'),
      surface: projection('surface-manifest'),
    },
    release: {
      contentHash: application.releaseRoot,
      releaseId: `release-${application.releaseRoot.slice(0, 12)}`,
    },
  } as unknown as RequestRuntimeView;
}

export async function authenticatedCompiledAppEntry() {
  const { AuthenticatedRequestEntryAdapter } =
    await import('../../packages/runtime/src/request-context.js');
  const {
    AuthenticatedRequestRuntimeEntryAdapter,
    CURRENT_POLICY_DECISION_VERSION,
    REQUEST_RUNTIME_PROJECTION_FAMILIES,
  } = await import('../../packages/runtime/src/request-runtime-view.js');
  const identity = {
    tenantId: 'c1000000-0000-4000-8000-000000000001',
    environmentId: 'c2000000-0000-4000-8000-000000000002',
    principalId: 'c3000000-0000-4000-8000-000000000003',
  };
  const view = compiledAppView();
  const family = REQUEST_RUNTIME_PROJECTION_FAMILIES;
  const projection = <Key extends keyof typeof family>(key: Key) => ({
    artifactRoot: 'c'.repeat(64),
    familyId: family[key],
    instanceId: `northstar.test:projection.${key}`,
    payload: view.projections[key].payload,
    payloadSchemaVersion: 'test-payload/v1',
    semanticDigest: 'd'.repeat(64),
  });
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    {
      load: async () => ({
        ...identity,
        pointer: { fence: 1, pointerId: 'test-pointer' },
        projections: {
          agent: projection('agent'),
          catalog: projection('catalog'),
          operation: projection('operation'),
          query: projection('query'),
          surface: projection('surface'),
        },
        release: view.release,
      }),
    },
    {
      authorize: async () => ({
        decision: 'DENY',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'test-policy',
      }),
      readCurrentVersion: async () => ({ policyVersion: 'test-policy' }),
    },
  );
}
