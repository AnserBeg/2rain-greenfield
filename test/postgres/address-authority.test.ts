import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type pg from 'pg';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  AddressProjectionSchema,
  SavedAddressSchema,
} from '@north-star/canonical-model';
import { PostgresAddresses } from '../../packages/postgres-provider/src/address-geocodes.js';
import {
  AddressProviderError,
  FakeAddressProvider,
} from '../../packages/postgres-provider/src/address-provider.js';
import { rolePool } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import {
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { COMPANY, worldOver, type DemoActor } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const ITEM_FIELD = 'northstar.app:field.custom_item_location';
const SITE_ENTITY = 'northstar.app:entity.custom_site';
const SITE_FIELD = 'northstar.app:field.custom_site_location';
const value = (
  text: string,
  locateFor?: { companyId: string; installationId: string },
): Record<string, string | Record<string, string>> => ({
  schemaVersion: 'northstar.address-value/v1',
  text,
  ...(locateFor && { locateFor }),
});

// CONNECT-1 fix round: each subtest isolates one guard and states its own
// failure message, so each expected-red control kills exactly one subtest.
test(
  'Address connector authority, isolation, quota, expiry and late-reply guards',
  { timeout: 1_800_000 },
  async (t) => {
    await withEphemeralPostgres(
      'address-authority',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'address-authority' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        const runtimePool = rolePool(databaseUrl, 'north_star_runtime', 4);
        try {
          const draft = await opened.service.draft(
            {
              kind: 'changeSet',
              patches: [
                {
                  kind: 'addAddressField',
                  schemaVersion: 'v6',
                  entity: 'northstar.app:entity.item',
                  fieldId: ITEM_FIELD,
                  label: 'Location',
                  required: false,
                },
                {
                  kind: 'addRecordType',
                  label: 'Site',
                  companyOwnership: 'entityOwned',
                  fields: [{ label: 'Name', type: 'text' }],
                },
                {
                  kind: 'addAddressField',
                  schemaVersion: 'v6',
                  entity: SITE_ENTITY,
                  fieldId: SITE_FIELD,
                  label: 'Location',
                  required: false,
                },
              ],
            },
            'visualBuilder',
          );
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);

          const world = worldOver(app.runtime, String(connection.database));
          const gateway = app.runtime.addresses as PostgresAddresses;
          const as = <T>(
            actor: DemoActor,
            work: (view: RequestRuntimeView) => Promise<T>,
          ) =>
            app.runtime.entry.run(
              { headers: { cookie: `northstar-demo-actor=${actor}` } },
              work,
            );
          const sql = <R extends pg.QueryResultRow>(
            actor: DemoActor,
            text: string,
            params: unknown[] = [],
          ) =>
            as(actor, (view) =>
              withTrustedRequestTransaction(
                runtimePool,
                trustedContextForRequestRuntimeView(view),
                async (c) => (await c.query<R>(text, params)).rows,
              ),
            );
          const bindingOf = (view: RequestRuntimeView, fieldId: string) =>
            AddressProjectionSchema.parse(
              view.projections.connector?.payload,
            ).bindings.find((b) => b.fieldId === fieldId)!;
          const configure = (
            company: string,
            account: string,
            settings: Partial<{
              provider: 'fake' | 'google';
              enrichment: boolean;
              calls: number;
              budgetMicros: number;
              enabled: boolean;
            }> = {},
            actor: DemoActor = 'manager',
          ) =>
            as(actor, (view) =>
              gateway.configure(view, company, {
                provider: 'fake',
                account,
                enrichment: true,
                calls: 1000,
                budgetMicros: 0,
                enabled: true,
                ...settings,
              }),
            );
          const newItem = async (text: string) => {
            const recordId = randomUUID();
            const created = await world.invoke('item_create', {
              recordId,
              relations: {},
              values: {
                'northstar.app:field.item_sku': 'ADDR-' + recordId.slice(0, 8),
                'northstar.app:field.item_name': text,
                'northstar.app:field.item_base_unit': 'EA',
                // Locating saves a different text: an unchanged address keeps its
                // revision and queues nothing.
                [ITEM_FIELD]: value('Draft ' + text),
              },
            });
            assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
            return { recordId, revision: created.readBack!.revision };
          };
          const save = async (
            item: { recordId: string; revision: number },
            text: string,
            locateFor?: { companyId: string; installationId: string },
            actor: DemoActor = 'manager',
            local = 'item',
            fieldId = ITEM_FIELD,
          ) => {
            const changed = await world.invoke(
              `${local}_update`,
              {
                recordId: item.recordId,
                expectedRevision: item.revision,
                patch: { [fieldId]: value(text, locateFor) },
              },
              { actor },
            );
            assert.equal(changed.outcome, 'succeeded', JSON.stringify(changed));
            item.revision = changed.readBack!.revision;
            return SavedAddressSchema.parse(changed.readBack!.values[fieldId])
              .revision;
          };
          const jobs = async (recordId: string) =>
            (
              await pool.query<{
                company_id: string;
                installation_id: string;
                address_revision: string;
                state: string;
                latitude: string | null;
                reason: string | null;
              }>(
                'SELECT company_id,installation_id,address_revision,state,latitude::text,reason FROM platform.address_geocodes WHERE record_id=$1 ORDER BY created_at',
                [recordId],
              )
            ).rows;
          const pin = (
            actor: DemoActor,
            recordId: string,
            companyId: string = COMPANY,
          ) =>
            as(actor, (view) =>
              gateway.pin(
                view,
                { fieldId: ITEM_FIELD, recordId, companyId },
                bindingOf(view, ITEM_FIELD).mapQueryId,
              ),
            );
          const suggest = (companyId: string, recordId: string) =>
            as('manager', (view) =>
              gateway.suggest(
                view,
                { fieldId: ITEM_FIELD, recordId, companyId },
                bindingOf(view, ITEM_FIELD).suggestQueryId,
                'Jasper Avenue',
                randomUUID(),
              ),
            );
          const work = (actor: DemoActor = 'manager') =>
            as(actor, (view) => gateway.workOne(view));
          // Work every job that is due, so the next claim is the caller's own.
          const drain = async (actor: DemoActor = 'manager') => {
            while (await work(actor));
          };
          const located = async (
            text: string,
            company: string = COMPANY,
            installationId: string = dispatch,
          ) => {
            await drain();
            const item = await newItem(text);
            const revision = await save(item, text, {
              companyId: company,
              installationId,
            });
            await drain();
            const [job] = (await jobs(item.recordId)).filter(
              (j) => j.address_revision === revision,
            );
            assert.equal(job?.state, 'ready', JSON.stringify(job));
            return { ...item, addressRevision: revision };
          };
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const buyerRole = (
            await pool.query<{ role_id: string }>(
              'SELECT role_id FROM platform.current_policy_memberships WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL',
              [tenantId, environmentId, principalId],
            )
          ).rows[0]!.role_id;
          const grantBuyerConfigure = async (granted: boolean) => {
            await pool.query(
              `INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id,revoked_at)
               VALUES ($1,$2,$3,'northstar.runtime:permission.connector_configure','northstar.runtime:connector.address',$4)
               ON CONFLICT (tenant_id,environment_id,role_id,permission_id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at`,
              [tenantId, environmentId, buyerRole, granted ? null : new Date()],
            );
          };
          const scopeBuyer = async (company: string | null) => {
            const scoped = await pool.query<{ legal_entity_id: string | null }>(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL RETURNING legal_entity_id',
              [tenantId, environmentId, principalId, company],
            );
            assert.deepEqual(
              scoped.rows.map((r) => r.legal_entity_id),
              [company],
            );
          };

          const OTHER = randomUUID();
          const otherEntity = await world.invoke('legal_entity_create', {
            recordId: OTHER,
            values: {
              'northstar.app:field.legal_entity_code': 'ADDR-B',
              'northstar.app:field.legal_entity_name': 'Address B',
              'northstar.app:field.legal_entity_is_default': false,
              'northstar.app:field.legal_entity_status':
                'northstar.app:option.legal_entity_status_active',
            },
          });
          assert.equal(otherEntity.outcome, 'succeeded');
          let dispatch = (await configure(COMPANY, 'dispatch'))!;
          const otherDispatch = (await configure(OTHER, 'other-dispatch'))!;
          assert.ok(dispatch && otherDispatch && dispatch !== otherDispatch);
          // Re-enabling the same account keeps its identity (D4); its own
          // subtest asserts that, so the others only follow the current one.
          const restoreDispatch = async () => {
            dispatch = (await configure(COMPANY, 'dispatch'))!;
          };

          await t.test(
            'configuring a provider needs the declared write permission, checked live',
            async () => {
              await assert.rejects(
                configure(COMPANY, 'dispatch', {}, 'buyer'),
                (error: unknown) =>
                  error instanceof AddressProviderError &&
                  error.reason === 'unconfigured',
                'a principal without the configure permission enabled a provider',
              );
              await grantBuyerConfigure(true);
              try {
                assert.ok(await configure(COMPANY, 'dispatch', {}, 'buyer'));
              } finally {
                await grantBuyerConfigure(false);
              }
              await assert.rejects(
                configure(COMPANY, 'dispatch', {}, 'buyer'),
                AddressProviderError,
                'a revoked configure grant still enabled a provider',
              );
            },
          );

          await t.test(
            'a non-manager buyer locates, reads pins and gets suggestions',
            async () => {
              const item = await newItem('Buyer site');
              const revision = await save(
                item,
                'Buyer site',
                { companyId: COMPANY, installationId: dispatch },
                'buyer',
              );
              assert.equal(await work('buyer'), true);
              assert.deepEqual(
                (await jobs(item.recordId)).map((j) => [
                  j.address_revision,
                  j.state,
                ]),
                [[revision, 'ready']],
                'a non-manager job was held instead of located',
              );
              assert.equal(
                (await pin('buyer', item.recordId)).status,
                'ready',
                'a non-manager could not read a located pin',
              );
              const offered = await as('buyer', (view) =>
                gateway.suggest(
                  view,
                  {
                    fieldId: ITEM_FIELD,
                    recordId: item.recordId,
                    companyId: COMPANY,
                  },
                  bindingOf(view, ITEM_FIELD).suggestQueryId,
                  'Buyer site',
                  randomUUID(),
                ),
              );
              assert.ok(offered.suggestions.length > 0);
              assert.ok(
                (await as('buyer', (view) => gateway.installations(view))).some(
                  (i) => i.installationId === dispatch,
                ),
              );
            },
          );

          await t.test(
            'an unrelated activation keeps a located pin visible',
            async () => {
              const item = await located('Pinned before activation');
              const before = await pin('manager', item.recordId);
              assert.equal(before.status, 'ready');
              const unrelated = await opened.service.draft(
                {
                  kind: 'addField',
                  entity: 'northstar.app:entity.party',
                  field: { label: 'Dispatch note', type: 'text' },
                },
                'visualBuilder',
              );
              assert.ok(unrelated.status === 'drafted');
              await opened.service.approve(unrelated.patchId);
              await opened.service.activate(unrelated.patchId);
              assert.deepEqual(
                await pin('manager', item.recordId),
                before,
                'an unrelated activation hid a located pin',
              );
              assert.deepEqual(await pin('buyer', item.recordId), before);
            },
          );

          // A pin located for the other company on a shared Item.
          await drain();
          const shared = await newItem('Shared depot');
          const sharedRevision = await save(shared, 'Shared depot', {
            companyId: OTHER,
            installationId: otherDispatch,
          });
          assert.equal(await work(), true);
          assert.equal(
            (await pin('manager', shared.recordId, OTHER)).status,
            'ready',
          );
          assert.ok(
            (await suggest(OTHER, shared.recordId)).suggestions.length > 0,
          );

          await t.test(
            'a company-scoped principal reaches no other company through the address functions',
            async () => {
              await grantBuyerConfigure(true);
              await scopeBuyer(COMPANY);
              try {
                const visible = await sql<{ company_id: string }>(
                  'buyer',
                  'SELECT company_id FROM platform.address_installations()',
                );
                assert.deepEqual(
                  [...new Set(visible.map((r) => r.company_id))],
                  [COMPANY],
                  'a company-scoped principal listed another company installation',
                );
                assert.deepEqual(
                  await sql(
                    'buyer',
                    'SELECT * FROM platform.address_installation($1)',
                    [OTHER],
                  ),
                  [],
                );
                assert.deepEqual(
                  await sql(
                    'buyer',
                    'SELECT * FROM platform.address_usage($1)',
                    [OTHER],
                  ),
                  [],
                );
                assert.deepEqual(
                  await sql(
                    'buyer',
                    'SELECT * FROM platform.address_pin($1,$2,$3,$4,$5,$6)',
                    [
                      OTHER,
                      otherDispatch,
                      'northstar.app:entity.item',
                      shared.recordId,
                      ITEM_FIELD,
                      sharedRevision,
                    ],
                  ),
                  [],
                );
                await assert.rejects(
                  sql(
                    'buyer',
                    'SELECT platform.address_configure($1,$2,$3,$4,$5,$6,$7)',
                    [OTHER, 'fake', 'other-dispatch', true, 10, 0, true],
                  ),
                  { code: '42501' },
                );
                const enqueue = await as('buyer', (view) =>
                  withTrustedRequestTransaction(
                    runtimePool,
                    trustedContextForRequestRuntimeView(view),
                    async (c) =>
                      (
                        await c.query<{ ok: boolean }>(
                          'SELECT platform.address_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS ok',
                          [
                            OTHER,
                            otherDispatch,
                            randomUUID(),
                            ITEM_FIELD,
                            'northstar.app:entity.item',
                            shared.recordId,
                            randomUUID(),
                            view.release.releaseId,
                            view.release.contentHash,
                            view.pointer.fence,
                            'a'.repeat(64),
                          ],
                        )
                      ).rows[0]!.ok,
                  ),
                );
                assert.equal(enqueue, false);
                // The same principal still reaches its own company.
                assert.equal(
                  (
                    await sql(
                      'buyer',
                      'SELECT * FROM platform.address_installation($1)',
                      [COMPANY],
                    )
                  ).length,
                  1,
                );
              } finally {
                await scopeBuyer(null);
                await grantBuyerConfigure(false);
              }
            },
          );

          await t.test(
            'the pin read matches its own company, not only the installation named',
            async () => {
              await scopeBuyer(COMPANY);
              try {
                assert.deepEqual(
                  await sql(
                    'buyer',
                    'SELECT state FROM platform.address_pin($1,$2,$3,$4,$5,$6)',
                    [
                      COMPANY,
                      otherDispatch,
                      'northstar.app:entity.item',
                      shared.recordId,
                      ITEM_FIELD,
                      sharedRevision,
                    ],
                  ),
                  [],
                  'company A read company B pin by naming its installation',
                );
              } finally {
                await scopeBuyer(null);
              }
            },
          );

          await t.test(
            'the pin read matches the current installation',
            async () => {
              const item = await located('Installation pin');
              try {
                const relay = await configure(COMPANY, 'relay');
                assert.ok(relay && relay !== dispatch);
                assert.notEqual(
                  (await pin('manager', item.recordId)).status,
                  'ready',
                  'a replaced installation still supplied the pin',
                );
              } finally {
                await restoreDispatch();
              }
            },
          );

          await t.test(
            'an owned record is read only for its stored company',
            async () => {
              const siteId = randomUUID();
              const site = await world.invoke('custom_site_create', {
                recordId: siteId,
                legalEntityId: OTHER,
                values: {
                  'northstar.app:field.custom_site_name': 'B yard',
                  [SITE_FIELD]: value('B yard'),
                },
              });
              assert.equal(site.outcome, 'succeeded', JSON.stringify(site));
              // Let the SQL predicate be the only refusal: a query layer that
              // returns any record.
              const permissive = Object.assign(
                Object.create(PostgresAddresses.prototype) as PostgresAddresses,
                gateway,
                {
                  queries: {
                    invoke: (
                      _view: unknown,
                      request: { arguments: { recordId: string } },
                    ) =>
                      Promise.resolve({
                        outcome: 'exact',
                        records: [
                          {
                            recordId: request.arguments.recordId,
                            archived: false,
                          },
                        ],
                      }),
                  },
                },
              );
              const read = (via: PostgresAddresses, companyId: string) =>
                as('manager', (view) =>
                  via.pin(
                    view,
                    { fieldId: SITE_FIELD, recordId: siteId, companyId },
                    bindingOf(view, SITE_FIELD).mapQueryId,
                  ),
                );
              await assert.rejects(
                read(permissive, COMPANY),
                AddressProviderError,
                'the owned-record predicate let company A read company B record',
              );
              assert.equal(
                (await read(permissive, OTHER)).status,
                'unavailable',
              );
              await assert.rejects(
                read(gateway, COMPANY),
                AddressProviderError,
              );
            },
          );

          await t.test(
            'saving an owned record queues only for its stored company',
            async () => {
              const siteId = randomUUID();
              const site = await world.invoke('custom_site_create', {
                recordId: siteId,
                legalEntityId: OTHER,
                values: {
                  'northstar.app:field.custom_site_name': 'B depot',
                  [SITE_FIELD]: value('B depot'),
                },
              });
              assert.equal(site.outcome, 'succeeded', JSON.stringify(site));
              const record = {
                recordId: siteId,
                revision: site.readBack!.revision,
              };
              await save(
                record,
                'B depot north',
                { companyId: COMPANY, installationId: dispatch },
                'manager',
                'custom_site',
                SITE_FIELD,
              );
              assert.deepEqual(
                (await jobs(siteId)).map((j) => j.company_id),
                [],
                'a save queued a geocode for a company that does not own the record',
              );
              await save(
                record,
                'B depot south',
                { companyId: OTHER, installationId: otherDispatch },
                'manager',
                'custom_site',
                SITE_FIELD,
              );
              assert.deepEqual(
                (await jobs(siteId)).map((j) => j.company_id),
                [OTHER],
              );
            },
          );

          await t.test(
            'expired provider coordinates are scrubbed in bounded batches',
            async () => {
              const items = [
                await located('Expiry one'),
                await located('Expiry two'),
                await located('Expiry three'),
              ];
              await pool.query(
                "UPDATE platform.address_geocodes SET expires_at=clock_timestamp()-interval '1 day' WHERE record_id = ANY($1::uuid[])",
                [items.slice(0, 2).map((i) => i.recordId)],
              );
              assert.equal(
                await as('manager', (view) => gateway.sweep(view, 1)),
                1,
                'the sweeper exceeded its batch',
              );
              assert.equal(
                await as('manager', (view) => gateway.sweep(view, 100)),
                1,
                'the sweeper scrubbed unexpired coordinates',
              );
              for (const [index, item] of items.entries()) {
                const [job] = await jobs(item.recordId);
                assert.deepEqual(
                  [job?.state, job?.latitude === null, job?.reason],
                  index < 2
                    ? ['failed', true, 'expired']
                    : ['ready', false, null],
                );
              }
              assert.equal(
                (await pin('manager', items[0]!.recordId)).status,
                'unavailable',
              );
            },
          );

          const quotaTest = async (
            account: string,
            settings: {
              provider: 'fake' | 'google';
              calls: number;
              budgetMicros: number;
            },
            allowed: number,
            message: string,
          ) => {
            const previous = process.env.CI;
            process.env.CI = '1';
            const item = await newItem('Quota ' + account);
            try {
              await configure(COMPANY, account, settings);
              for (let call = 0; call < allowed; call += 1)
                await suggest(COMPANY, item.recordId);
              await assert.rejects(
                suggest(COMPANY, item.recordId),
                (error: unknown) =>
                  error instanceof AddressProviderError &&
                  error.reason === 'quota',
                message,
              );
            } finally {
              if (previous === undefined) delete process.env.CI;
              else process.env.CI = previous;
              await restoreDispatch();
            }
          };
          await t.test('the call limit refuses once spent', () =>
            quotaTest(
              'quota-calls',
              { provider: 'fake', calls: 2, budgetMicros: 0 },
              2,
              'a call beyond the period limit was reserved',
            ),
          );
          await t.test('the budget refuses a call it cannot cover', () =>
            quotaTest(
              'quota-budget',
              { provider: 'google', calls: 10, budgetMicros: 150000 },
              1,
              'a call beyond the period budget was reserved',
            ),
          );
          await t.test('a budget below one call refuses the first', () =>
            quotaTest(
              'quota-first',
              { provider: 'google', calls: 10, budgetMicros: 50000 },
              0,
              'a first call costing more than the budget was reserved',
            ),
          );

          await t.test(
            'quota follows the provider account through pause and switching',
            async () => {
              const item = await newItem('Quota account');
              try {
                const kept = await configure(COMPANY, 'quota-keep', {
                  calls: 5,
                });
                const pinned = await located('Kept pin', COMPANY, kept!);
                await suggest(COMPANY, item.recordId);
                await suggest(COMPANY, item.recordId);
                assert.equal(
                  await configure(COMPANY, 'quota-keep', { enabled: false }),
                  kept,
                );
                assert.equal(
                  await configure(COMPANY, 'quota-keep', { calls: 5 }),
                  kept,
                  'pausing and re-enabling one account minted a new installation',
                );
                const other = await configure(COMPANY, 'quota-other');
                assert.notEqual(other, kept);
                assert.equal(
                  await configure(COMPANY, 'quota-keep', { calls: 5 }),
                  kept,
                );
                await suggest(COMPANY, item.recordId);
                assert.equal(
                  (await pin('manager', pinned.recordId)).status,
                  'ready',
                  'a returning account lost its located pins',
                );
                const usage = await sql<{
                  installation_id: string;
                  calls: number;
                }>(
                  'manager',
                  'SELECT installation_id, calls FROM platform.address_usage($1)',
                  [COMPANY],
                );
                assert.equal(
                  usage.find((u) => u.installation_id === kept)?.calls,
                  3,
                );
              } finally {
                await restoreDispatch();
              }
            },
          );

          const lateReply = async (
            label: string,
            during: (item: {
              recordId: string;
              revision: number;
            }) => Promise<void>,
            message: string,
          ) => {
            await drain();
            const item = await newItem(label);
            const revision = await save(item, label, {
              companyId: COMPANY,
              installationId: dispatch,
            });
            const fake = new FakeAddressProvider();
            const geocode = t.mock.method(
              FakeAddressProvider.prototype,
              'geocode',
              async (text: string) => {
                await during(item);
                return fake.geocode(text);
              },
            );
            try {
              assert.equal(await work(), true);
              assert.equal(geocode.mock.callCount(), 1);
            } finally {
              geocode.mock.restore();
              await restoreDispatch();
            }
            const [job] = (await jobs(item.recordId)).filter(
              (j) => j.address_revision === revision,
            );
            assert.deepEqual(
              [job?.state, job?.latitude],
              ['held', null],
              message,
            );
          };
          await t.test('a late geocode rechecks the address revision', () =>
            lateReply(
              'Revision A',
              async (item) => {
                // Same text, so the source digest matches; only the revision moved.
                await save(item, 'Revision B');
                await save(item, 'Revision A');
              },
              'a late geocode was accepted for a superseded revision',
            ),
          );
          await t.test('a late geocode rechecks the installation', () =>
            lateReply(
              'Installation switch',
              async () => {
                assert.notEqual(await configure(COMPANY, 'relay'), dispatch);
              },
              'a late geocode was accepted after the installation changed',
            ),
          );
          await t.test('a late geocode rechecks enrichment', () =>
            lateReply(
              'Enrichment off',
              async () => {
                assert.ok(
                  await configure(COMPANY, 'dispatch', { enrichment: false }),
                );
              },
              'a late geocode was accepted after enrichment was switched off',
            ),
          );

          await t.test(
            'concurrent configure calls for one company serialize',
            async () => {
              // The relay installation exists, disabled. Hold its row so both
              // callers reach the same point before either can finish.
              const admin = await pool.connect();
              try {
                await admin.query('BEGIN');
                const held = await admin.query(
                  "SELECT 1 FROM platform.address_installations WHERE company_id=$1 AND account='relay' FOR UPDATE",
                  [COMPANY],
                );
                assert.equal(held.rowCount, 1);
                let pending = 2;
                const calls = [
                  configure(COMPANY, 'relay', { calls: 7 }),
                  configure(COMPANY, 'relay', { calls: 8 }),
                ].map((call) =>
                  call.finally(() => {
                    pending -= 1;
                  }),
                );
                const deadline = Date.now() + 20000;
                while (pending > 0) {
                  const waiting = await pool.query<{ n: number }>(
                    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>$1",
                    [
                      (
                        await admin.query<{ pid: number }>(
                          'SELECT pg_backend_pid() AS pid',
                        )
                      ).rows[0]!.pid,
                    ],
                  );
                  if (waiting.rows[0]!.n >= 2) break;
                  assert.ok(
                    Date.now() < deadline,
                    'both configure calls never waited',
                  );
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
                await admin.query('COMMIT');
                const settled = await Promise.allSettled(calls);
                assert.deepEqual(
                  settled.map((s) => s.status),
                  ['fulfilled', 'fulfilled'],
                  'concurrent configure calls deadlocked: ' +
                    JSON.stringify(
                      settled.map((s) =>
                        s.status === 'rejected'
                          ? (s.reason as { code?: string }).code
                          : null,
                      ),
                    ),
                );
              } finally {
                await admin.query('ROLLBACK').catch(() => undefined);
                admin.release();
                await restoreDispatch();
              }
            },
          );

          await t.test(
            'a replaced installation gets its own history row',
            async () => {
              const since = new Date();
              try {
                const audit = await configure(COMPANY, 'audit');
                assert.ok(audit && audit !== dispatch);
                const history = await pool.query<{
                  installation_id: string;
                  change: string;
                }>(
                  'SELECT installation_id, change FROM platform.address_installation_history WHERE company_id=$1 AND recorded_at>=$2 ORDER BY recorded_at, change',
                  [COMPANY, since],
                );
                assert.deepEqual(
                  history.rows.filter((r) => r.installation_id === dispatch),
                  [{ installation_id: dispatch, change: 'paused' }],
                  'the replaced installation has no history row',
                );
                assert.deepEqual(
                  history.rows.filter((r) => r.installation_id === audit),
                  [{ installation_id: audit, change: 'enabled' }],
                );
              } finally {
                await restoreDispatch();
              }
            },
          );

          await t.test(
            'a canary provider key never reaches errors, rows, tool results or output',
            async () => {
              const canary = 'CANARY' + randomUUID().replaceAll('-', '');
              const keyFile = join(
                tmpdir(),
                `address-canary-${randomUUID()}.json`,
              );
              const saved = {
                CI: process.env.CI,
                NORTH_STAR_CONNECTOR_DEMO:
                  process.env.NORTH_STAR_CONNECTOR_DEMO,
                NORTH_STAR_GOOGLE_MAPS_TERMS:
                  process.env.NORTH_STAR_GOOGLE_MAPS_TERMS,
                NORTH_STAR_CONNECTOR_KEY_FILE:
                  process.env.NORTH_STAR_CONNECTOR_KEY_FILE,
              };
              const output: string[] = [];
              const streams = [process.stdout, process.stderr] as const;
              const writers = streams.map((stream) => stream.write);
              const capture = () =>
                streams.forEach((stream, index) => {
                  stream.write = function (
                    this: NodeJS.WriteStream,
                    chunk: unknown,
                    ...rest: unknown[]
                  ) {
                    output.push(String(chunk));
                    return (
                      writers[index] as (...a: unknown[]) => boolean
                    ).call(this, chunk, ...rest);
                  } as typeof stream.write;
                });
              const requests: string[] = [];
              let failing = false;
              const fetch = t.mock.method(
                globalThis,
                'fetch',
                async (input: string | URL, init?: RequestInit) => {
                  const url = String(input);
                  requests.push(
                    url + ' ' + JSON.stringify(init?.headers ?? {}),
                  );
                  if (failing)
                    throw new TypeError(
                      'fetch failed: ' +
                        url +
                        ' ' +
                        JSON.stringify(init?.headers ?? {}),
                    );
                  const body = url.includes('autocomplete')
                    ? {
                        suggestions: [
                          {
                            placePrediction: {
                              placeId: 'canaryPlace',
                              text: { text: '10 Canary Row' },
                            },
                          },
                        ],
                      }
                    : {
                        status: 'OK',
                        results: [
                          {
                            geometry: {
                              location: { lat: 53.5461245, lng: -113.4938229 },
                              location_type: 'ROOFTOP',
                            },
                          },
                        ],
                      };
                  return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  });
                },
              );
              capture();
              try {
                delete process.env.CI;
                process.env.NORTH_STAR_CONNECTOR_DEMO = '1';
                process.env.NORTH_STAR_GOOGLE_MAPS_TERMS = 'non-eea';
                const google = (await configure(COMPANY, 'canary', {
                  provider: 'google',
                  calls: 50,
                  budgetMicros: 1000000,
                }))!;
                await writeFile(
                  keyFile,
                  JSON.stringify([
                    {
                      tenantId,
                      environmentId,
                      companyId: COMPANY,
                      installationId: google,
                      account: 'canary',
                      purpose: 'maps',
                      key: canary,
                    },
                  ]),
                  { mode: 0o600 },
                );
                await chmod(keyFile, 0o600);
                process.env.NORTH_STAR_CONNECTOR_KEY_FILE = keyFile;
                const item = await newItem('Canary site');
                const offered = await suggest(COMPANY, item.recordId);
                failing = true;
                const refused = await suggest(COMPANY, item.recordId).then(
                  () => assert.fail('the failed provider call resolved'),
                  (error: unknown) => error,
                );
                failing = false;
                const leaked = (text: string) => text.includes(canary);
                assert.ok(
                  refused instanceof AddressProviderError &&
                    !leaked(
                      String(refused) +
                        String((refused as Error).stack) +
                        JSON.stringify(refused),
                    ),
                  'a provider error carried the canary key',
                );
                await drain();
                await save(item, 'Canary site', {
                  companyId: COMPANY,
                  installationId: google,
                });
                assert.equal(await work(), true);
                const map = await pin('manager', item.recordId);
                assert.equal(map.status, 'ready', JSON.stringify(map));
                assert.ok(map.status === 'ready' && map.image === null);
                const session = new OperationsAgentSession({
                  runtime: app.runtime,
                  companyId: COMPANY,
                  personHeaders: { cookie: 'northstar-demo-actor=manager' },
                  approve: () => Promise.resolve(true),
                });
                const tool = await session.call('erp_query', {
                  queryId: 'northstar.app:query.item_get',
                  arguments: { recordId: item.recordId },
                  selection: [ITEM_FIELD],
                });
                assert.equal(tool.isError, false, JSON.stringify(tool.content));
                // The key did reach the provider, and only the provider.
                assert.ok(requests.some(leaked));
                assert.ok(
                  !leaked(JSON.stringify(offered) + JSON.stringify(map)),
                  'a suggestion or map carried the canary key',
                );
                assert.ok(
                  !leaked(JSON.stringify(tool)),
                  'the assistant tool result carried the canary key',
                );
                const hex = Buffer.from(canary).toString('hex');
                const tables = await pool.query<{ name: string }>(
                  "SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname IN ('platform','north_star_module','north_star_internal')",
                );
                const rows: string[] = [];
                for (const { name } of tables.rows) {
                  const found = await pool.query<{ n: number }>(
                    `SELECT count(*)::int AS n FROM ${name} AS t WHERE strpos(t::text, $1) > 0 OR strpos(t::text, $2) > 0`,
                    [canary, hex],
                  );
                  if (found.rows[0]!.n) rows.push(name);
                }
                assert.deepEqual(
                  rows,
                  [],
                  'a persisted row carried the canary key',
                );
                assert.ok(
                  !output.some(leaked),
                  'process output carried the canary key',
                );
              } finally {
                streams.forEach((stream, index) => {
                  stream.write = writers[index]!;
                });
                fetch.mock.restore();
                for (const [name, previous] of Object.entries(saved)) {
                  if (previous === undefined) delete process.env[name];
                  else process.env[name] = previous;
                }
                await rm(keyFile, { force: true });
                await restoreDispatch();
              }
            },
          );
        } finally {
          await runtimePool.end();
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
