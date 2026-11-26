/**
 * Rule 13 for the recordCreated member (ADR-0073 A1, rung 50). The preceding
 * serving binary is run from its own unmodified tree. It must answer a query on
 * a release it supports, compiled from the change exactly as the service
 * RECORDED it, and then refuse a release carrying a general workflow trigger by
 * name, through its own production loader.
 */
import assert from 'node:assert/strict';
import type pg from 'pg';

import {
  CustomizationPatchSchema,
  preparePatchForRecording,
} from '../../packages/customization/src/index.js';
import { LOGICAL_FIELD_READER } from '../../packages/canonical-model/src/logical-field.js';
import { RECORD_CREATED_TRIGGER_READER } from '../../packages/canonical-model/src/workflows.js';
import {
  assertArchivedTenantEnvelopeForChange,
  withArchivedCustomizationRuntime,
} from './archived-customization-runtime.js';
import { assertPersisted } from './record-template-reader.js';

// The preceding main tip when the slice merged (TRAIN-Q, e112d58f, reader 49).
export const workflowTriggerPredecessor =
  'e112d58ff799912d7b743d5eb7fbd79f796c5318';

/** The preceding binary's request path, issuing one governed query. */
const probe = `
import { readFile } from 'node:fs/promises';
import { ObservabilityMetrics } from './packages/observability/src/index.ts';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
import { composeServingGateways, readVerifiedServing, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
const i = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pool = rolePool(i.databaseUrl, 'north_star_runtime', 2);
const ctx = await trustedContext(i.identity);
try {
  const pointer = await readVerifiedServing(pool, ctx);
  try {
    const serving = await loadServingRelease(pool, ctx, pointer.releaseId);
    const gates = composeServingGateways(pool, pool, ctx, serving, new ObservabilityMetrics(), { providerErrorMappings: [], writeInvariants: [] });
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => i.identity),
      new PostgresRequestRuntimeViewService(pool),
      gates.policy,
    );
    const result = await entry.run({ headers: {} }, (v) => gates.queryGateway.invoke(v, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION, queryId: i.queryId, arguments: i.args,
    }));
    console.log(JSON.stringify({ outcome: 'served', releaseId: pointer.releaseId, records: result.records.map((r) => r.recordId) }));
  } catch (error) {
    // The loader names the refusal; read it from the production loader itself.
    let loader;
    try { await new PostgresRequestRuntimeViewService(pool).load(ctx); } catch (e) { loader = { code: e.code, message: e.message }; }
    console.log(JSON.stringify({ outcome: 'refused', releaseId: pointer.releaseId, code: error.code, message: error.message, loader }));
  }
} finally {
  await pool.end();
}
`;

interface ProbeResult {
  readonly outcome: 'served' | 'refused';
  readonly releaseId: string;
  readonly records?: readonly string[];
  readonly code?: string;
  readonly message?: string;
  readonly loader?: { readonly code: string; readonly message: string };
}

export async function exerciseWorkflowTriggerReader(input: {
  readonly pool: pg.Pool;
  readonly databaseUrl: string;
  readonly identity: unknown;
  /** The active release the preceding binary supports. */
  readonly compatibleId: string;
  /** The change that produced it, as given to the service. */
  readonly compatiblePatch: unknown;
  readonly queryId: string;
  readonly args: Record<string, string>;
  readonly recordId: string;
  /** Activates the release with a recordCreated workflow; returns its ID. */
  readonly declare: () => Promise<string>;
}): Promise<void> {
  await withArchivedCustomizationRuntime(
    workflowTriggerPredecessor,
    async (run) => {
      // Byte identity of persisted rows: the archived compiler, fed the change
      // as the service recorded it, reproduces the persisted release.
      await assertPersisted(
        input.pool,
        input.compatibleId,
        await assertArchivedTenantEnvelopeForChange(
          run,
          preparePatchForRecording(
            CustomizationPatchSchema.parse(input.compatiblePatch),
          ),
        ),
      );
      const request = {
        databaseUrl: input.databaseUrl,
        identity: input.identity,
        queryId: input.queryId,
        args: input.args,
      };
      const served = (await run(probe, request)) as ProbeResult;
      assert.deepEqual(
        served,
        {
          outcome: 'served',
          releaseId: input.compatibleId,
          records: [input.recordId],
        },
        'the preceding binary answers a query on the release it supports',
      );
      const activated = await input.declare();
      const refused = (await run(probe, request)) as ProbeResult;
      assert.equal(refused.outcome, 'refused', JSON.stringify(refused));
      assert.equal(refused.releaseId, activated);
      const named =
        'runtime capability northstar.runtime:capability.surface-manifest requires version ' +
        String(RECORD_CREATED_TRIGGER_READER) +
        ' and this runtime supports ' +
        String(LOGICAL_FIELD_READER);
      assert.equal(refused.loader?.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
      assert.ok(
        refused.loader.message.includes(named),
        JSON.stringify(refused.loader),
      );
    },
  );
}
