import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { createSurfaceRuntimeServer } from '../../../../apps/web/src/app-server.js';
import { PARTY_IDS } from '../party/definition.js';
import {
  invokePartyOperation,
  withRealPartyRuntime,
} from '../party/runtime-harness.js';

const targetId = 'f0000000-0000-4000-8000-000000000001';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await withRealPartyRuntime('table-behavior-browser', async (runtime) => {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        invokePartyOperation(runtime, runtime.views.a, 'party_create', {
          recordId: fillerId(index + 1),
          values: partyValues(
            `P-FILLER-${String(index + 1).padStart(3, '0')}`,
            `Page filler ${String(index + 1).padStart(3, '0')}`,
          ),
        }),
      ),
    );
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: targetId,
      values: partyValues('P-TARGET', 'Page Two Needle'),
    });

    const archivedId = 'e0000000-0000-4000-8000-000000000001';
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: archivedId,
      values: partyValues('P-ARCHIVED', 'Archived Needle'),
    });
    await invokePartyOperation(runtime, runtime.views.a, 'party_archive', {
      expectedRevision: 1,
      recordId: archivedId,
    });

    const rolePartyId = 'd0000000-0000-4000-8000-000000000001';
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: rolePartyId,
      values: partyValues('P-ROLE-PARENT', 'Role Parent'),
    });
    for (const [index, roleKind] of ['supplier', 'customer'].entries()) {
      await invokePartyOperation(
        runtime,
        runtime.views.a,
        'party_role_create',
        {
          recordId: `c0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          relations: { [PARTY_IDS.relationIds.roleParty]: rolePartyId },
          values: {
            [PARTY_IDS.fieldIds.roleKind]:
              `${PARTY_IDS.namespace}:option.${roleKind}`,
            [PARTY_IDS.fieldIds.roleStatus]:
              `${PARTY_IDS.namespace}:option.active`,
          },
        },
      );
    }

    const server = createSurfaceRuntimeServer(runtime.entry, {
      operationGateway: runtime.operationGateway,
      operationMediation: runtime.operationMediation,
      queryGateway: runtime.queryGateway,
    });
    const baseUrl = await listen(server);
    process.stdout.write(
      `TABLE_BEHAVIOR_BROWSER_READY ${JSON.stringify({ baseUrl })}\n`,
    );
    await shutdownSignal();
    await close(server);
  });
}

function fillerId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function partyValues(number: string, name: string): Record<string, string> {
  return {
    [PARTY_IDS.fieldIds.contactSummary]: `${number.toLowerCase()}@example.test`,
    [PARTY_IDS.fieldIds.name]: name,
    [PARTY_IDS.fieldIds.number]: number,
  };
}

async function listen(server: Server): Promise<string> {
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

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
