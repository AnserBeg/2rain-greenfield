import { closeFixtureApp } from './close-fixture-app.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  startComposedApplication,
  openCustomizeService,
} from '../../apps/api/src/composition-root.js';
import { draftMapRevision } from '../../packages/customization/src/map-revision.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { LINEAGE_INSTALL_VOLUME, withEphemeralPostgres } from './postgres.js';

export const stopEntity = 'northstar.app:entity.custom_stop';
export const stopAddress = 'northstar.app:field.custom_stop_address';
export const stopName = 'northstar.app:field.custom_stop_name';
export const stopRoute = 'northstar.app:field.custom_stop_route';
export const stopSequence = 'northstar.app:field.custom_stop_sequence';
export const stopDay = 'northstar.app:field.custom_stop_day';
export const northRoute = 'northstar.app:option.custom_stop_route_north';
export const southRoute = 'northstar.app:option.custom_stop_route_south';
export const dispatchDay = '2026-11-21';
export const stopScope =
  'northstar.app:parameter.custom_stop_list_legal_entity_scope';
export const stopSetup = {
  kind: 'changeSet',
  patches: [
    {
      kind: 'addRecordType',
      companyOwnership: 'entityOwned',
      label: 'Stop',
      fields: [
        { type: 'text', label: 'Name', required: true },
        { type: 'choice', label: 'Route', options: ['North', 'South'] },
        { type: 'number', label: 'Sequence' },
        { type: 'date', label: 'Day' },
      ],
    },
    {
      kind: 'addAddressField',
      schemaVersion: 'v6',
      entity: stopEntity,
      fieldId: stopAddress,
      label: 'Address',
      required: false,
    },
  ],
};

export async function activateMapFixtureChange(
  service: Awaited<ReturnType<typeof openCustomizeService>>['service'],
  change: unknown,
) {
  const draft = await service.draft(change, 'visualBuilder');
  assert.ok(draft.status === 'drafted', JSON.stringify(draft));
  await service.approve(draft.patchId);
  await service.activate(draft.patchId);
}
export async function fixtureMapRevision(
  service: Awaited<ReturnType<typeof openCustomizeService>>['service'],
) {
  const target = (await service.targets()).maps?.find(
    (t) => t.frame.entityId === stopEntity,
  );
  assert.ok(target);
  return draftMapRevision(target, {
    kind: 'addMapViewRevision',
    label: 'Dispatch map',
    surface: target.frame.listSurfaceId,
    addressFieldId: stopAddress,
    orderFieldId: stopSequence,
    groupFieldId: stopRoute,
    dayFieldId: stopDay,
    timeZone: 'America/Edmonton',
    direction: 'asc',
  });
}
async function serve() {
  await withEphemeralPostgres(
    'planner-map-browser',
    async ({ connection }) => {
      const options = {
        databaseUrl: `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
        tenantSlug: 'planner-map-browser',
      };
      const app = await startComposedApplication({ ...options, port: 0 }),
        opened = await openCustomizeService(options);
      try {
        await activateMapFixtureChange(opened.service, stopSetup);
        const map = await fixtureMapRevision(opened.service);
        await activateMapFixtureChange(opened.service, map);
        await app.runtime.entry.run(
          { headers: { cookie: 'northstar-demo-actor=manager' } },
          async (view) => {
            assert.ok(
              await app.runtime.addresses.configure(view, COMPANY, {
                provider: 'fake',
                account: 'dispatch',
                enabled: true,
                enrichment: true,
                calls: 100,
                budgetMicros: 0,
              }),
            );
          },
        );
        const world = worldOver(app.runtime, String(connection.database));
        for (const [label, lat] of [
          ['Warehouse', '53.51'],
          ['Pickup', '53.52'],
        ] as const) {
          const r = await world.invoke('custom_stop_create', {
            legalEntityId: COMPANY,
            recordId: randomUUID(),
            values: {
              [stopName]: label,
              [stopDay]: dispatchDay,
              [stopRoute]: northRoute,
              [stopSequence]: label === 'Warehouse' ? '2' : '10',
              [stopAddress]: {
                schemaVersion: 'northstar.address-value/v1',
                text: label,
                pin: { kind: 'user', latitude: lat, longitude: '-113.53' },
              },
            },
          });
          assert.equal(r.outcome, 'succeeded');
        }
        const url = new URL('/', app.baseUrl);
        url.searchParams.set('surface', map.surfaceId);
        url.searchParams.set(stopScope, COMPANY);
        url.searchParams.set('day', dispatchDay);
        process.stdout.write('PLANNER_MAP_URL=' + url.href + '\n');
        process.stdin.resume();
        await once(process.stdin, 'end');
      } finally {
        await opened.close();
        await closeFixtureApp(app, 'planner-map');
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
}
if (process.argv.includes('--serve'))
  void serve().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
