import assert from 'node:assert/strict';
import {
  FakeAddressProvider,
  AddressProviderError,
} from '../../packages/postgres-provider/src/address-provider.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  ADDRESS_FIELD_READER,
  ADDRESS_MAP_READER,
  AddressProjectionSchema,
  SavedAddressSchema,
} from '@north-star/canonical-model';
import { provisionInventoryScope } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  archivedRuntimeRead,
  assertArchivedTenantEnvelope,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const previousReader = 'eda6d12f';
const address = {
  kind: 'addAddressField',
  schemaVersion: 'v6',
  entity: 'northstar.app:entity.item',
  fieldId: 'northstar.app:field.custom_item_site',
  label: 'Site',
  required: false,
} as const;

test(
  'Address publication preserves the old envelope, stops the prior reader, and serves governed user text without a provider',
  { timeout: 600000 },
  async (testContext) => {
    await withEphemeralPostgres(
      'address-connector',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'address-connector' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const draft = await opened.service.draft(address, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await withArchivedCustomizationRuntime(
            previousReader,
            async (run) => {
              await assertArchivedTenantEnvelope(run);
              const parse = (await run(
                `import {readFileSync} from 'node:fs';import {parseCustomizationPatch} from './packages/customization/src/patch.ts';console.log(JSON.stringify(parseCustomizationPatch(JSON.parse(readFileSync(process.argv[2],'utf8')))));`,
                address,
              )) as { status: string };
              assert.equal(parse.status, 'unsupported');
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              await opened.service.activate(draft.patchId);
              const refusal = await read();
              assert.equal(refusal.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refusal.message ?? '',
                new RegExp(
                  `surface-manifest requires version ${ADDRESS_FIELD_READER}`,
                ),
              );
            },
          );
          const headers = { cookie: 'northstar-demo-actor=manager' };
          const world = worldOver(app.runtime, String(connection.database));
          const recordId = randomUUID();
          const result = await world.invoke(
            'item_create',
            {
              recordId,
              relations: {},
              values: {
                'northstar.app:field.item_sku': 'ADDRESS-SITE',
                'northstar.app:field.item_name': 'Site',
                'northstar.app:field.item_base_unit': 'EA',
                [address.fieldId]: {
                  schemaVersion: 'northstar.address-value/v1',
                  text: '15 Jasper Street',
                },
              },
            },
            { actor: 'manager' },
          );
          assert.equal(
            SavedAddressSchema.parse(result.readBack?.values[address.fieldId])
              .text,
            '15 Jasper Street',
          );
          const session = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: headers,
            approve: () => Promise.resolve(true),
          });
          const response = await session.call('erp_query', {
            queryId: 'northstar.app:query.item_get',
            arguments: { recordId },
            selection: [address.fieldId],
          });
          assert.equal(
            response.isError,
            false,
            JSON.stringify(response.content),
          );
          assert.match(JSON.stringify(response.content), /15 Jasper Street/u);
          const before = await app.runtime.entry.run(
            { headers },
            async (view) => {
              const b = AddressProjectionSchema.parse(
                view.projections.connector?.payload,
              ).bindings[0]!;
              const t = { fieldId: b.fieldId, recordId, companyId: COMPANY };
              assert.deepEqual(
                await app.runtime.addresses.pin(view, t, b.mapQueryId),
                { status: 'unavailable' },
              );
              const gateway = app.runtime.addresses;
              let install = await gateway.configure(view, COMPANY, {
                provider: 'fake',
                account: 'dispatch',
                enrichment: true,
                calls: 50,
                budgetMicros: 0,
                enabled: true,
              });
              assert.ok(install);
              const write = async (text: string, revision: number) => {
                const changed = await world.invoke('item_update', {
                  recordId,
                  expectedRevision: revision,
                  patch: {
                    [address.fieldId]: {
                      schemaVersion: 'northstar.address-value/v1',
                      text,
                      locateFor: {
                        companyId: COMPANY,
                        installationId: install!,
                      },
                    },
                  },
                });
                assert.equal(
                  changed.outcome,
                  'succeeded',
                  JSON.stringify(changed),
                );
                assert.equal(
                  SavedAddressSchema.parse(
                    changed.readBack?.values[address.fieldId],
                  ).text,
                  text,
                );
                return changed.readBack!.revision;
              };
              let revision = await write(
                'Address A',
                result.readBack!.revision,
              );
              const unavailable = testContext.mock.method(
                FakeAddressProvider.prototype,
                'geocode',
                async () => {
                  throw new AddressProviderError('unavailable');
                },
              );
              assert.equal(await gateway.workOne(view), true);
              assert.equal(unavailable.mock.callCount(), 1);
              const originalRead = await world.read('item', recordId);
              assert.equal(
                SavedAddressSchema.parse(originalRead.values[address.fieldId])
                  .text,
                'Address A',
              );
              unavailable.mock.restore();

              // Resolve B only after C has committed, in the real worker's I/O window.
              revision = await write('Address B', revision);
              const fake = new FakeAddressProvider();
              const geocode = fake.geocode.bind(fake);
              const delayed = testContext.mock.method(
                FakeAddressProvider.prototype,
                'geocode',
                async (text: string) => {
                  assert.equal(text, 'Address B');
                  revision = await write('Address C', revision);
                  return geocode(text);
                },
              );
              // A's retry is still queued; identify B without depending on elapsed time.
              await pool.query(
                "UPDATE platform.address_geocodes SET available_at='infinity' WHERE attempts>0 AND record_id=$1",
                [recordId],
              );
              assert.equal(await gateway.workOne(view), true);
              assert.equal(delayed.mock.callCount(), 1);
              delayed.mock.restore();
              const late = await pool.query(
                "SELECT state,latitude,longitude FROM platform.address_geocodes WHERE record_id=$1 AND attempts=1 AND state='held'",
                [recordId],
              );
              assert.deepEqual(
                late.rows,
                [{ state: 'held', latitude: null, longitude: null }],
                'the late geocode was accepted after the source address changed',
              );
              assert.deepEqual(await gateway.pin(view, t, b.mapQueryId), {
                status: 'locating',
              });
              assert.equal(await gateway.workOne(view), true);
              const pin = await gateway.pin(view, t, b.mapQueryId);
              assert.equal(pin.status, 'ready');
              assert.ok(pin.status === 'ready');
              const current = await geocode('Address C');
              assert.equal(Number(pin.pin.latitude), Number(current.latitude));
              assert.equal(
                Number(pin.pin.longitude),
                Number(current.longitude),
              );
              // A shared master's text is the same while installation-specific coordinates stay private.
              const otherCompany = randomUUID();
              await provisionInventoryScope(
                pool,
                app.runtime.identity,
                view.release.contentHash,
                {
                  ...COMPOSED_APPLICATION_INVENTORY_SCOPE,
                  legalEntityId: otherCompany,
                  entityCode: 'OTHER-SITE',
                  entityName: 'Other company',
                },
              );
              const otherInstallation = await gateway.configure(
                view,
                otherCompany,
                {
                  provider: 'fake',
                  account: 'other-dispatch',
                  enrichment: true,
                  calls: 50,
                  budgetMicros: 0,
                  enabled: true,
                },
              );
              assert.ok(otherInstallation && otherInstallation !== install);
              assert.deepEqual(
                await gateway.pin(
                  view,
                  { ...t, companyId: otherCompany },
                  b.mapQueryId,
                ),
                {
                  status: 'unavailable',
                },
                'the other company received a provider pin for this shared record',
              );
              assert.equal(
                (await gateway.pin(view, t, b.mapQueryId)).status,
                'ready',
              );
              for (const change of ['installation', 'release'] as const) {
                revision = await write('Change ' + change, revision);
                const saved = (await world.read('item', recordId)).values;
                const savedRevision = SavedAddressSchema.parse(
                  saved[address.fieldId],
                ).revision;
                const interrupted = testContext.mock.method(
                  FakeAddressProvider.prototype,
                  'geocode',
                  async (text: string) => {
                    if (change === 'installation') {
                      install = await gateway.configure(view, COMPANY, {
                        provider: 'fake',
                        account: 'replacement',
                        enrichment: true,
                        calls: 50,
                        budgetMicros: 0,
                        enabled: true,
                      });
                      assert.ok(install);
                    } else {
                      await opened.service.rollback();
                    }
                    return geocode(text);
                  },
                );
                assert.equal(await gateway.workOne(view), true);
                assert.equal(interrupted.mock.callCount(), 1);
                interrupted.mock.restore();
                const rejected = await pool.query(
                  'SELECT state,latitude,longitude FROM platform.address_geocodes WHERE record_id=$1 AND address_revision=$2',
                  [recordId, savedRevision],
                );
                assert.deepEqual(rejected.rows, [
                  { state: 'held', latitude: null, longitude: null },
                ]);
                if (change === 'release') return saved;
              }
              throw new Error(
                'Expected the rollback during the provider response',
              );
            },
          );
          // All scalar components disappear from the logical record and return together.
          const rolledBack = (await world.read('item', recordId)).values;
          assert.deepEqual(
            Object.keys(before).filter((key) => !(key in rolledBack)),
            [address.fieldId],
          );
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          const restored = await world.read('item', recordId);
          assert.deepEqual(restored.values, before);
          const manual = {
            schemaVersion: 'northstar.address-value/v1',
            text: 'Surveyed site',
            city: 'Edmonton',
            pin: {
              kind: 'user',
              latitude: '53.54612450',
              longitude: '-113.49382290',
            },
          };
          await world.invoke('item_update', {
            recordId,
            expectedRevision: restored.revision,
            patch: { [address.fieldId]: manual },
          });
          const stored = await world.read('item', recordId);
          const value = SavedAddressSchema.parse(
            stored.values[address.fieldId],
          );
          assert.deepEqual(value, { ...manual, revision: value.revision });
          const invalid = {
            ...manual,
            text: 'Invalid pin',
            pin: { ...manual.pin, latitude: '91' },
          };
          await assert.rejects(
            world.invoke('item_update', {
              recordId,
              expectedRevision: stored.revision,
              patch: { [address.fieldId]: invalid },
            }),
            { code: 'MODULE_FIELD_VALUE_INVALID' },
          );
          assert.deepEqual(
            (await world.read('item', recordId)).values[address.fieldId],
            value,
          );

          // Reader 32. No commit ever carried a reader capped at 31, so build
          // one: this tree's production loader with its surface cap lowered to
          // the Address field rung. It serves the Address field release and
          // refuses the release that adds a map placement.
          const authored = JSON.parse(
            readFileSync('apps/web/release/app.authored.json', 'utf8'),
          ) as {
            surfaces: {
              surfaceId: string;
              slots: { slot: string; slotId: string }[];
            }[];
          };
          const surfaceId = 'northstar.app:surface.item_detail';
          const sections = authored.surfaces
            .find((s) => s.surfaceId === surfaceId)!
            .slots.find((s) => s.slot === 'sections')!;
          const mapDraft = await opened.service.draft(
            {
              kind: 'addMapPlacement',
              schemaVersion: 'v6',
              placementId: 'northstar.app:placement.custom_item_site_map',
              surfaceId,
              sectionId: [surfaceId, 'detail', sections.slotId, 'details'].join(
                '/',
              ),
              fieldId: address.fieldId,
            },
            'visualBuilder',
          );
          assert.ok(mapDraft.status === 'drafted', JSON.stringify(mapDraft));
          await opened.service.approve(mapDraft.patchId);
          await withArchivedCustomizationRuntime(
            'HEAD',
            async (run) => {
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal(
                (await read()).outcome,
                'loaded',
                'a reader 31 build refused the Address field release',
              );
              await opened.service.activate(mapDraft.patchId);
              const refusal = await read();
              assert.equal(
                refusal.code,
                'UNSUPPORTED_RUNTIME_CAPABILITY',
                'a reader 31 build did not refuse a map placement release by its floor',
              );
              assert.match(
                refusal.message ?? '',
                new RegExp(
                  `surface-manifest requires version ${ADDRESS_MAP_READER}`,
                ),
              );
            },
            async (workspace) => {
              const file = join(
                workspace,
                'packages/runtime/src/request-runtime-view.ts',
              );
              const source = await readFile(file, 'utf8');
              const capped = source.replace(
                /(capability\.surface-manifest',[\s\S]*?maximumSupportedVersion: )[\w]+,/u,
                `$1${ADDRESS_FIELD_READER},`,
              );
              assert.notEqual(capped, source, 'the surface cap moved');
              await writeFile(file, capped);
            },
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
