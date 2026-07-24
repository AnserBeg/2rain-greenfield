import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createSurfaceRuntimeServer } from '../../../../apps/web/src/app-server.js';

import { PARTY_IDS } from './definition.js';
import {
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from './runtime-harness.js';
import { resolvePartyName } from './resolver-harness.js';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await withRealPartyRuntime('party-browser', async (runtime) => {
    const partyId = randomUUID();
    const created = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_create',
      {
        recordId: partyId,
        values: partyValues('P-WEB-001', 'Browser Party'),
      },
    );
    assert.ok(created.trust);
    for (const localRole of ['supplier', 'customer'] as const) {
      const role = await invokePartyOperation(
        runtime,
        runtime.views.a,
        'party_role_create',
        {
          recordId: randomUUID(),
          relations: { [PARTY_IDS.relationIds.roleParty]: partyId },
          values: {
            [PARTY_IDS.fieldIds.roleKind]:
              `${PARTY_IDS.namespace}:option.${localRole}`,
            [PARTY_IDS.fieldIds.roleStatus]:
              `${PARTY_IDS.namespace}:option.active`,
          },
        },
      );
      assert.ok(role.trust);
    }
    for (const number of ['P-WEB-002', 'P-WEB-003']) {
      await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: randomUUID(),
        values: partyValues(number, 'Browser Duplicate'),
      });
    }
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'P-WEB-001')).outcome,
      'exact',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Browser Duplicate'))
        .outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Browser Duplicte'))
        .outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'No such party'))
        .outcome,
      'not-found',
    );
    const queryDto = (
      await invokePartyQuery(runtime, runtime.views.a, 'party_get', {
        recordId: partyId,
      })
    ).records[0];
    const agentQueryId = (
      runtime.views.a.projections.agent.payload as {
        queries: Array<{ queryId: string }>;
      }
    ).queries.find(
      (query) => query.queryId === `${PARTY_IDS.namespace}:query.party_get`,
    )?.queryId;
    assert.ok(agentQueryId);
    const agentDto = (
      await runtime.queryGateway.invoke(runtime.views.a, {
        arguments: { recordId: partyId },
        queryId: agentQueryId,
        schemaVersion: 'northstar.semantic-query-request/v1',
      })
    ).records[0];
    assert.deepEqual(agentDto, queryDto);

    const server = createSurfaceRuntimeServer(runtime.entry, {
      operationGateway: runtime.operationGateway,
      queryGateway: runtime.queryGateway,
    });
    const baseUrl = await listen(server);
    process.stdout.write(
      `PARTY_BROWSER_READY ${JSON.stringify({ baseUrl, partyId })}\n`,
    );
    await shutdownSignal();
    await close(server);
  });
}

function partyValues(number: string, name: string): Record<string, string> {
  return {
    [PARTY_IDS.fieldIds.contactSummary]: 'browser@example.test',
    [PARTY_IDS.fieldIds.name]: name,
    [PARTY_IDS.fieldIds.number]: number,
  };
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function shutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function close(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
