import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg, { type Client, type QueryResult } from 'pg';
import {
  startComposedApplication,
  openCustomizeService,
} from '../../apps/api/src/composition-root.js';
import {
  activateMapFixtureChange,
  fixtureMapRevision,
  stopAddress as address,
  stopDay,
  stopRoute,
  stopSequence,
  stopEntity,
  northRoute,
  southRoute,
  dispatchDay,
  stopName as name,
  stopScope as scope,
  stopSetup as setup,
} from '../helpers/planner-map-fixture.js';
import { parseServerTiming } from '../../packages/postgres-provider/src/request-work-meter.js';
import { catalogParseCount } from '../../packages/runtime/src/catalog-parse-count.js';
import { readCompiledSurfaceManifest } from '../../apps/web/src/surface-contract.js';
import { physicalNameFor } from '../../packages/compiler/src/storage.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { fitMap } from '../../packages/canonical-model/src/map-viewport.js';
import { COMPANY, seededId, worldOver } from '../agent/agent-world.js';
import { draftMapRevision } from '../../packages/customization/src/map-revision.js';
import {
  archivedStockCountQuery,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-runtime-process.js';
import {
  withEphemeralPostgres,
  LINEAGE_INSTALL_VOLUME,
} from '../helpers/postgres.js';

// This is the serving binary at the preceding main tip. Refresh it when assigning the merge rungs.
const predecessor = '44c4b6aca1bd03fa44038188f72c6764a56da2dc';
test(
  'serve a published Map through the dispatcher’s collection, connector and preceding reader',
  { timeout: 900_000 },
  async (t) => {
    // Count rows returned by PostgreSQL, before the application applies its work ceiling.
    const query = pg.Client.prototype.query;
    const candidateReads: number[] = [];
    t.mock.method(
      pg.Client.prototype,
      'query',
      function (this: Client, ...args: unknown[]) {
        const response = Reflect.apply(query, this, args);
        if (typeof args[0] !== 'string' || !args[0].includes('AS map_ordinal'))
          return response;
        return (response as Promise<QueryResult>).then((result) => {
          candidateReads.push(result.rows.length);
          return result;
        });
      },
    );
    await withEphemeralPostgres(
      'planner-map',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'planner-map' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const customize = await openCustomizeService(options);
        const activate = (change: unknown) =>
          activateMapFixtureChange(customize.service, change);
        try {
          await activate(setup);
          const revision = await fixtureMapRevision(customize.service);
          const world = worldOver(app.runtime, String(connection.database)),
            other = randomUUID();
          const created = await world.invoke('legal_entity_create', {
            recordId: other,
            values: {
              'northstar.app:field.legal_entity_code': 'MAP-B',
              'northstar.app:field.legal_entity_name': 'Map company B',
              'northstar.app:field.legal_entity_is_default': false,
              'northstar.app:field.legal_entity_status':
                'northstar.app:option.legal_entity_status_active',
            },
          });
          assert.equal(created.outcome, 'succeeded');
          async function stop(
            company: string,
            label: string,
            latitude: string,
            sequence = '2',
            route = northRoute,
            day = dispatchDay,
          ) {
            const recordId = randomUUID(),
              saved = await world.invoke('custom_stop_create', {
                recordId,
                legalEntityId: company,
                values: {
                  [name]: label,
                  [stopSequence]: sequence,
                  [stopRoute]: route,
                  [stopDay]: day,
                  [address]: {
                    schemaVersion: 'northstar.address-value/v1',
                    text: label,
                    pin: { kind: 'user', latitude, longitude: '-113.5' },
                  },
                },
              });
            assert.equal(saved.outcome, 'succeeded');
            return recordId;
          }
          const alpha = await stop(COMPANY, 'North warehouse', '53.52'),
            beta = await stop(
              other,
              'South private yard',
              '47.20',
              '1',
              southRoute,
            );
          const manager = { cookie: 'northstar-demo-actor=manager' };
          for (const id of [COMPANY, other])
            await app.runtime.entry.run({ headers: manager }, async (view) =>
              assert.ok(
                await app.runtime.addresses.configure(view, id, {
                  provider: 'fake',
                  account: 'dispatch',
                  enrichment: true,
                  enabled: true,
                  calls: 50,
                  budgetMicros: 0,
                }),
              ),
            );
          await withArchivedCustomizationRuntime(predecessor, async (run) => {
            // The predecessor compiles from the first-party release this
            // test installed (this tree's release files and acknowledgement),
            // never from its own copies: a train that advances the release
            // lineage then moves both sides alike, and byte identity still
            // compares the same inputs.
            // DOCUMENT-POSTING: every composed release now carries operation
            // reader 10, so the preceding binary cannot compile or answer on the
            // current first-party base; that half is owed in
            // FIRST-TENANT-OWED.md (older-reader "answers" proofs, 2026-11-28).
            const readAsPredecessor = () =>
              run(archivedStockCountQuery, {
                databaseUrl,
                identity: app.runtime.identity,
                queryId: revision.body.listQueryId,
                args: { [scope]: COMPANY },
              }) as Promise<
                | { outcome: 'queried'; records: { recordId: string }[] }
                | { outcome: 'refused'; code: string; message: string }
              >;
            await activate(revision);
            const refused = await readAsPredecessor();
            assert.ok(refused.outcome === 'refused', JSON.stringify(refused));
            assert.equal(refused.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
            assert.match(
              refused.message ?? '',
              /operation-catalog requires version 10 /u,
            );
          });
          const url = new URL('/', app.baseUrl);
          url.searchParams.set('surface', revision.surfaceId);
          url.searchParams.set(scope, COMPANY);
          url.searchParams.set('day', dispatchDay);
          const navigation = {
            ...manager,
            'sec-fetch-dest': 'document',
            'sec-fetch-user': '?1',
          };
          const serve = () => fetch(url, { headers: navigation });
          for (const headers of [
            manager,
            { ...navigation, purpose: 'prefetch' },
          ]) {
            const nonInteractive = await fetch(url, { headers });
            assert.equal(nonInteractive.status, 200);
            const text = await nonInteractive.text();
            assert.ok(text.includes(alpha));
            assert.doesNotMatch(text, /href="\/map\/image/u);
          }
          await (await serve()).arrayBuffer();
          await (await serve()).arrayBuffer();
          const before = catalogParseCount(),
            response = await serve(),
            html = await response.text(),
            after = catalogParseCount();
          assert.equal(response.status, 200, html.slice(-1200));
          assert.match(html, /data-map-drag/u);
          assert.match(html, /North warehouse/u);
          assert.ok(html.includes(alpha));
          assert.ok(!html.includes(beta));
          assert.doesNotMatch(html, /South private yard/u);
          const counts = parseServerTiming(
            response.headers.get('server-timing'),
          );
          assert.ok(counts);
          assert.ok(
            counts.transactions <= 2 &&
              counts.statements <= 40 &&
              counts.authorization <= 3,
            JSON.stringify(counts),
          );
          assert.equal(counts.repeats, 0);
          for (const key of [
            'operationCatalog',
            'queryCatalog',
            'surfaceManifest',
          ] as const)
            assert.equal(after[key], before[key], key);
          const surfaceCount = await app.runtime.entry.run(
            { headers: manager },
            (view) => readCompiledSurfaceManifest(view).surfaces.length,
          );
          const sparseBindings = after.surfaceBinding - before.surfaceBinding;
          assert.ok(sparseBindings <= surfaceCount);
          const src = html
            .match(/href="(\/map\/image\?[^"]+)"/u)?.[1]
            ?.replaceAll('&amp;', '&');
          assert.ok(src);
          const image = new URL(src, app.baseUrl);
          const quotaCalls = async () =>
            Number(
              (
                await pool.query(
                  'SELECT coalesce(sum(calls),0) AS n FROM platform.address_quota WHERE tenant_id=$1 AND environment_id=$2',
                  [
                    app.runtime.identity.tenantId,
                    app.runtime.identity.environmentId,
                  ],
                )
              ).rows[0].n,
            );
          const beforeFirstImage = await quotaCalls();
          const firstImage = await fetch(image, { headers: manager });
          assert.equal(firstImage.status, 200);
          const firstRaster = Buffer.from(await firstImage.arrayBuffer());
          const afterFirstImage = await quotaCalls();
          assert.equal(afterFirstImage, beforeFirstImage + 1);
          image.searchParams.set('company', other);
          assert.equal((await fetch(image, { headers: manager })).status, 404);
          const bUrl = new URL(url);
          bUrl.searchParams.set(scope, other);
          const fitted = fitMap(
            [{ latitude: 53.52, longitude: -113.5 }],
            'medium',
          );
          for (const [param, value] of Object.entries({
            cx: fitted.x,
            cy: fitted.y,
            zoom: fitted.zoom,
            size: fitted.size,
          }))
            bUrl.searchParams.set(param, String(value));
          const bHtml = await (
            await fetch(bUrl, { headers: navigation })
          ).text();
          assert.ok(bHtml.includes(beta) && !bHtml.includes(alpha));
          const alphaPoint = { latitude: 53.52, longitude: -113.5 };
          const bSrc = bHtml
            .match(/href="(\/map\/image\?[^"]+)"/u)?.[1]
            ?.replaceAll('&amp;', '&');
          assert.ok(bSrc && bSrc !== src);
          const reused = await fetch(new URL(bSrc, app.baseUrl), {
            headers: manager,
          });
          assert.equal(reused.status, 200);
          assert.deepEqual(
            Buffer.from(await reused.arrayBuffer()),
            firstRaster,
          );
          assert.equal(await quotaCalls(), afterFirstImage);
          const canonical = new URL(
            html
              .match(/data-map-state="([^"]+)"/u)![1]!
              .replaceAll('&amp;', '&'),
            app.baseUrl,
          );
          for (const [key, expected] of [
            ['cx', fitted.x],
            ['cy', fitted.y],
            ['zoom', fitted.zoom],
          ] as const)
            assert.equal(canonical.searchParams.get(key), String(expected));

          const observed = t.mock.method(app.runtime.queryGateway, 'invoke');
          try {
            const fragment = await fetch(canonical, {
              method: 'POST',
              headers: {
                ...manager,
                origin: canonical.origin,
                'x-rain-fragment': 'map',
              },
              body: new URLSearchParams(),
            });
            assert.equal(fragment.status, 200);
            assert.equal(fragment.headers.get('x-rain-fragment'), 'fragment');
            assert.match(await fragment.text(), /data-map-state=/u);
            assert.equal(observed.mock.callCount(), 1);
            assert.partialDeepStrictEqual(
              observed.mock.calls[0]!.arguments[1],
              {
                queryId: revision.body.listQueryId,
              },
            );
          } finally {
            observed.mock.restore();
          }

          const mapRead = (
            company: string,
            cut: Record<string, unknown> = {},
            headers = manager,
          ) =>
            app.runtime.entry.run({ headers }, (view) =>
              app.runtime.queryGateway.invoke(view, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: revision.body.listQueryId,
                arguments: {
                  [scope]: company,
                  mapPage: {
                    surfaceId: revision.surfaceId,
                    revisionId: revision.revisionId,
                    companyId: company,
                    day: dispatchDay,
                    ...cut,
                  },
                },
              }),
            );
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const membership = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL',
            [tenantId, environmentId, principalId, COMPANY],
          );
          assert.ok(membership.rowCount);
          const buyer = { cookie: 'northstar-demo-actor=buyer' };
          const permitted = await mapRead(COMPANY, {}, buyer);
          assert.equal(permitted.records[0]?.values[stopDay], dispatchDay);
          assert.deepEqual(permitted.mapCoverage?.stops, [
            {
              recordId: alpha,
              group: northRoute,
              ordinal: 1,
              point: alphaPoint,
              provenance: 'User pin',
            },
          ]);
          await assert.rejects(mapRead(other, {}, buyer));
          await assert.rejects(mapRead(COMPANY, { companyId: other }, buyer));
          assert.equal((await fetch(image, { headers: buyer })).status, 404);

          // Use ordinary writes for the contrasting records. Fill the page in one fixture statement.
          const tail = await stop(COMPANY, 'Last north stop', '60', '1000');
          const south = await stop(
            COMPANY,
            'South route depot',
            '48',
            '1',
            southRoute,
          );
          await stop(
            COMPANY,
            'Tomorrow only',
            '61',
            '1',
            northRoute,
            '2026-11-22',
          );
          const table = physicalNameFor('table', stopEntity);
          const column = (field: string) => physicalNameFor('column', field);
          const fillRoute = (
            company: string,
            route: string,
            from: number,
            through: number,
          ) =>
            pool.query(
              `INSERT INTO north_star_module."${table}"
              (tenant_id,environment_id,legal_entity_id,record_id,"${column(name)}","${column(stopSequence)}","${column(stopRoute)}","${column(stopDay)}")
            SELECT $1,$2,$3,gen_random_uuid(),'Pickup ' || n,n,$4,$5::date FROM generate_series($6::integer,$7::integer) n`,
              [
                tenantId,
                environmentId,
                company,
                route,
                dispatchDay,
                from,
                through,
              ],
            );
          await fillRoute(COMPANY, northRoute, 3, 101);
          // Even a private route larger than the work ceiling cannot crowd out company A.
          await fillRoute(other, southRoute, 1, 520);
          const first = await mapRead(COMPANY);
          assert.equal(first.records.length, 100);
          assert.deepEqual(
            first.mapCoverage?.stops.map((s) => s.ordinal),
            Array.from({ length: 100 }, (_, i) => i + 1),
          );
          assert.deepEqual(
            first.records.map((r) => Number(r.values[stopSequence])),
            Array.from({ length: 100 }, (_, i) => i + 2),
          );
          const cursor = first.mapCoverage?.hasNext;
          assert.ok(cursor);
          await stop(other, 'Private route addition', '47', '3', southRoute);
          const second = await mapRead(COMPANY, { cursor });
          assert.equal(second.mapCoverage?.restarted, undefined);
          assert.deepEqual(
            second.records.map((r) => r.recordId),
            [tail, south],
          );
          assert.deepEqual(
            second.mapCoverage?.stops.map((s) => s.ordinal),
            [101, 1],
          );
          assert.equal(second.mapCoverage?.hasNext, undefined);
          const onlySouth = await mapRead(COMPANY, {
            route: southRoute,
            cursor,
          });
          assert.equal(onlySouth.mapCoverage?.restarted, true);
          assert.deepEqual(
            onlySouth.records.map((r) => r.recordId),
            [south],
          );
          const inArea = await mapRead(COMPANY, {
            area: fitMap([{ latitude: 60, longitude: -113.5 }], 'small'),
          });
          assert.deepEqual(
            inArea.mapCoverage?.stops.map((s) => [s.recordId, s.ordinal]),
            [[tail, 101]],
          );
          await (await serve()).arrayBuffer();
          await (await serve()).arrayBuffer();
          const timings: number[] = [];
          for (let i = 0; i < 5; i++) {
            const parsesBefore = catalogParseCount();
            const start = performance.now();
            const full = await serve();
            const body = await full.text();
            timings.push(performance.now() - start);
            const parsesAfter = catalogParseCount();
            for (const key of [
              'operationCatalog',
              'queryCatalog',
              'surfaceManifest',
            ] as const)
              assert.equal(parsesAfter[key], parsesBefore[key], key);
            assert.equal(
              parsesAfter.surfaceBinding - parsesBefore.surfaceBinding,
              sparseBindings,
            );
            assert.equal(full.status, 200);
            assert.match(
              body,
              /Showing 100 of \d+ in this filter — choose a Route or Day/u,
            );
            assert.doesNotMatch(
              body,
              /South private yard|Tomorrow only|class="map-route group-/u,
            );
            const fullCounts = parseServerTiming(
              full.headers.get('server-timing'),
            );
            assert.ok(fullCounts);
            for (const key of [
              'transactions',
              'statements',
              'authorization',
              'repeats',
            ] as const)
              assert.equal(fullCounts[key], counts[key], key);
          }
          t.diagnostic(
            `warm Map sparse/full ${JSON.stringify(counts)}, full p95 ${Math.ceil(timings.sort((a, b) => a - b).at(-1)!)}ms (5 samples, 400ms target)`,
          );
          await fillRoute(COMPANY, northRoute, 200, 620);
          const broad = await mapRead(COMPANY);
          assert.equal(candidateReads.at(-1), 513);
          assert.equal(broad.mapCoverage?.partial, true);
          assert.equal(broad.records.length, 0);
          const narrowed = await mapRead(COMPANY, { route: southRoute });
          assert.deepEqual(
            narrowed.records.map((r) => r.recordId),
            [south],
          );
          assert.equal(candidateReads.at(-1), 1);

          // The sales collection has a released currency filter and a governed
          // Record read model. Exercise its saved view independently of day and route.
          const orderList = 'northstar.app:surface.sales_order_list';
          const orderAddress = 'northstar.app:field.custom_order_site';
          await activate({
            kind: 'changeSet',
            patches: [
              {
                kind: 'addAddressField',
                schemaVersion: 'v6',
                entity: 'northstar.app:entity.sales_order',
                fieldId: orderAddress,
                label: 'Delivery site',
                required: false,
              },
              {
                kind: 'saveListView',
                surface: orderList,
                label: 'Euro deliveries',
                columns: ['northstar.app:list_column.sales_order_list_number'],
                filters: [
                  {
                    field: 'northstar.app:field.sales_order_currency',
                    value: 'EUR',
                  },
                ],
                sort: [],
              },
            ],
          });
          const orderTarget = (await customize.service.targets()).maps?.find(
            (m) => m.frame.listSurfaceId === orderList,
          );
          assert.ok(orderTarget);
          const savedViewId = orderTarget.savedViews.find((id) =>
            id.endsWith('_euro_deliveries'),
          );
          assert.ok(savedViewId);
          const deliveries = draftMapRevision(orderTarget, {
            kind: 'addMapViewRevision',
            surface: orderList,
            label: 'Euro deliveries map',
            addressFieldId: orderAddress,
            orderFieldId: orderTarget.frame.label.fieldId,
            direction: 'asc',
            savedViewId,
          });
          await activate(deliveries);
          const createOrder = (currency: string) =>
            world.create('sales_order', {
              customer_party_id: seededId('Northwind Goods'),
              order_date: `${dispatchDay}T12:00:00.000Z`,
              currency,
            });
          const euro = await createOrder('EUR');
          const canadian = await createOrder('CAD');
          const orders = await app.runtime.entry.run(
            { headers: manager },
            (view) =>
              app.runtime.queryGateway.invoke(view, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: deliveries.body.listQueryId,
                arguments: {
                  'northstar.app:parameter.sales_order_list_legal_entity_scope':
                    COMPANY,
                  mapPage: {
                    companyId: COMPANY,
                    surfaceId: deliveries.surfaceId,
                    revisionId: deliveries.revisionId,
                  },
                },
              }),
          );
          assert.ok(
            orders.records.some((row) => row.recordId === euro.recordId),
          );
          assert.ok(
            !orders.records.some((row) => row.recordId === canadian.recordId),
          );
          assert.equal(candidateReads.at(-1), orders.records.length);
        } finally {
          await customize.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
