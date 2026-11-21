import { canonicalize } from '@north-star/canonical-model';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type { PoolClient } from 'pg';
import {
  WorkflowBodyBundleSchema,
  WorkflowVerificationResultSchema,
  type WorkflowBodyBundle,
} from '../../customization/src/workflow-draft.js';
import { fileURLToPath } from 'node:url';
import {
  runSandboxRequest,
  type SandboxRunnerOptions,
} from '../../customization/src/sandbox.js';
import type { WorkflowVerificationRequest } from './workflow-draft-worker.js';
import { sha256 } from './workflow-execution.js';
import { MAXIMUM_WORKFLOW_SOURCE_BYTES } from './workflow-isolate.js';
import { generateWorkflowSdk, type WorkflowGrants } from './workflow-sdk.js';

export async function storeWorkflowBundle(
  client: PoolClient,
  context: TrustedRequestContext,
  bundle: WorkflowBodyBundle,
): Promise<string> {
  const bytes = Buffer.from(canonicalize(bundle));
  if (bytes.length > MAXIMUM_WORKFLOW_SOURCE_BYTES)
    throw new Error('Workflow source and fixtures exceed the bundle limit');
  const digest = sha256(bytes);
  const scope = [context.tenantId, context.environmentId, digest] as const;
  // PostgreSQL rejects ON CONFLICT on tables with immutable UPDATE rules.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `workflow-bundle:${scope.join(':')}`,
  ]);
  await client.query(
    `INSERT INTO platform.workflow_body_blobs (tenant_id, environment_id, body_digest, bundle)
      SELECT $1::uuid, $2::uuid, $3::text, $4::bytea WHERE NOT EXISTS (
        SELECT 1 FROM platform.workflow_body_blobs
         WHERE (tenant_id, environment_id, body_digest) = ($1, $2, $3)
      )`,
    [...scope, bytes],
  );
  return digest;
}

export async function readWorkflowBundle(
  client: PoolClient,
  context: TrustedRequestContext,
  digest: string,
): Promise<WorkflowBodyBundle> {
  const { rows } = await client.query<{ bundle: Buffer }>(
    `SELECT bundle FROM platform.workflow_body_blobs
      WHERE tenant_id = $1 AND environment_id = $2 AND body_digest = $3`,
    [context.tenantId, context.environmentId, digest],
  );
  const bytes = rows[0]?.bundle;
  if (!bytes || sha256(bytes) !== digest)
    throw new Error('Workflow bundle is missing or does not match its digest');
  const bundle = WorkflowBodyBundleSchema.parse(JSON.parse(bytes.toString()));
  if (canonicalize(bundle) !== bytes.toString())
    throw new Error('Workflow bundle bytes are not canonical');
  return bundle;
}

export async function verifyWorkflowBundle(
  view: RequestRuntimeView,
  grants: WorkflowGrants,
  bundle: Pick<WorkflowBodyBundle, 'body' | 'fixtures'>,
  options: SandboxRunnerOptions = {},
) {
  const sdk = generateWorkflowSdk(view, grants);
  const request: WorkflowVerificationRequest = {
    body: bundle.body,
    declarations: sdk.declarations,
    release: sdk.release,
    fixtures: bundle.fixtures.map(({ event, effects }) => ({
      event,
      effects: effects.map(({ call, result }) => ({
        call: sdk.admitCall(call),
        result,
      })),
    })),
  };
  const result = await runSandboxRequest(
    fileURLToPath(new URL('./workflow-draft-worker.ts', import.meta.url)),
    'verifyWorkflowDraft',
    request,
    options,
    { heapLimitMegabytes: 512, wallClockLimitMilliseconds: 30_000 },
    (response) => {
      if (
        typeof response !== 'string' ||
        Buffer.byteLength(response) > 1024 * 1024
      )
        throw new Error('Invalid workflow verification response');
      return WorkflowVerificationResultSchema.parse(JSON.parse(response));
    },
  );
  if (result.status === 'refused') throw new Error(result.message);
  return { sdk, executable: result.executable, journals: result.journals };
}
