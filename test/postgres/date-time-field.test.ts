import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  DATE_TIME_FIELD_READER,
  SavedDateTimeSchema,
  formatRecordZone,
} from '../../packages/canonical-model/src/index.js';
import {
  archivedRuntimeRead,
  archivedTenantEnvelope,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { COMPANY, NS, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const equipment = `${NS}:entity.custom_equipment`;
const appointment = {
  kind: 'addDateTimeField',
  schemaVersion: 'northstar.date-time-field/v1',
  target: { kind: 'tenantRecordType', recordTypeId: equipment },
  fieldId: `${NS}:field.custom_equipment_service_at`,
  label: 'Service appointment',
  required: false,
  zoneSource: { kind: 'perRecordIana', version: 'v1' },
} as const;
const due = {
  ...appointment,
  fieldId: `${NS}:field.custom_equipment_due_at`,
  label: 'Due',
  zoneSource: { kind: 'companyBusinessCalendar', version: 'v1' },
} as const;
const value = (civil: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 'northstar.date-time-value/v1',
  civil,
  ...extra,
});

test(
  'a dateTime field added to a populated record type builds its window index in the attempt and enters, refuses, lists and reads in record zone',
  { timeout: 1_800_000 },
  async () => {
    await withEphemeralPostgres(
      'date-time-field',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'date-time-field' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        const world = worldOver(app.runtime, String(connection.database));
        const ship = async (patch: unknown) => {
          const draft = await opened.service.draft(patch, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          return draft.patchId;
        };
        try {
          await opened.service.activate(
            await ship({
              kind: 'addRecordType',
              label: 'Equipment',
              companyOwnership: 'entityOwned',
              fields: [{ label: 'Name', type: 'text', required: true }],
            }),
          );
          const create = (name: string, values: Record<string, unknown> = {}) =>
            world.invoke('custom_equipment_create', {
              recordId: randomUUID(),
              legalEntityId: COMPANY,
              relations: {},
              values: {
                [`${NS}:field.custom_equipment_name`]: name,
                ...values,
              },
            });
          console.error(
            `[date-time] record type active ${new Date().toISOString()}`,
          );
          const earlier = await create('Earlier boiler');
          assert.equal(earlier.outcome, 'succeeded', JSON.stringify(earlier));

          // Existing populated table: exactly one window createIndex runs in
          // the approved attempt, and it ends ready and valid.
          const patchId = await ship(appointment);
          await opened.service.activate(patchId);
          const indexName = (
            await pool.query<{ name: string }>(
              `SELECT element.physical_object_name AS name
                 FROM north_star_internal.module_storage_element_applications AS application
                 JOIN north_star_internal.module_storage_elements AS element
                   ON element.element_id = application.element_id
                WHERE element.element_kind = 'createIndex'
                  AND application.application_state = 'APPLIED'
                  AND application.attempt_id IS NOT NULL
                  AND application.generation_id = (
                    SELECT generation_id FROM north_star_internal.module_storage_generations
                     ORDER BY created_at DESC LIMIT 1)`,
            )
          ).rows.map((row) => row.name);
          assert.equal(indexName.length, 1, JSON.stringify(indexName));
          const index = await pool.query<{
            ready: boolean;
            valid: boolean;
            definition: string;
          }>(
            `SELECT indisready AS ready, indisvalid AS valid,
                    pg_get_indexdef(indexrelid) AS definition
               FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid
              WHERE relname = $1`,
            [indexName[0]],
          );
          assert.equal(index.rows[0]?.ready, true);
          assert.equal(index.rows[0]?.valid, true);
          assert.match(
            index.rows[0]!.definition,
            /btree \(tenant_id, environment_id, legal_entity_id, nsm_c_\w+, record_id\)/u,
          );
          const check = await pool.query<{ validated: boolean }>(
            `SELECT convalidated AS validated FROM pg_constraint
              WHERE contype = 'c' AND conrelid = (
                SELECT indrelid FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid
                 WHERE relname = $1)
                AND pg_get_constraintdef(oid) LIKE '%make_interval%'`,
            [indexName[0]],
          );
          assert.deepEqual(check.rows, [{ validated: false }]);

          // The earlier row reads as absent.
          const before = await world.read(
            'custom_equipment',
            earlier.readBack!.recordId,
          );
          assert.equal(before.values[appointment.fieldId], null);

          // Typed entry, per-record zone. The spring gap refuses and keeps
          // the entry; the autumn repeat asks for an offset; a foreign offset
          // refuses; each offset of the repeat resolves to its own instant.
          const refused = async (civil: string, extra = {}) => {
            const error = await create('Refused', {
              [appointment.fieldId]: value(civil, {
                zone: 'America/Toronto',
                ...extra,
              }),
            }).then(
              () => null,
              (failure: unknown) => failure,
            );
            assert.ok(error, `${civil} was accepted`);
            return error as { code: string; details: Record<string, string> };
          };
          console.error(
            `[date-time] field active; index verified ${new Date().toISOString()}`,
          );
          const gap = await refused('2026-03-08T02:30');
          assert.equal(gap.code, 'MODULE_FIELD_VALUE_INVALID');
          assert.equal(gap.details.reason, 'DATE_TIME_NONEXISTENT');
          assert.equal(gap.details.civil, '2026-03-08T02:30');
          const repeat = await refused('2026-11-01T01:30');
          assert.equal(repeat.details.reason, 'DATE_TIME_AMBIGUOUS');
          assert.equal(repeat.details.offsets, '-14400,-18000');
          const foreign = await refused('2026-11-01T01:30', {
            offsetSeconds: -21600,
          });
          assert.equal(foreign.details.reason, 'DATE_TIME_OFFSET_INVALID');
          const fixed = await refused('2026-11-01T09:00', {
            zone: 'Etc/GMT+5',
          });
          assert.equal(fixed.details.reason, 'DATE_TIME_ZONE_INVALID');
          const precise = await refused('2026-11-01T09:00:00.0001');
          assert.equal(precise.details.reason, 'DATE_TIME_PRECISION_EXCEEDED');

          const later = await create('Later', {
            [appointment.fieldId]: value('2026-11-01T01:30', {
              zone: 'America/Toronto',
              offsetSeconds: -18000,
            }),
          });
          const sooner = await create('Sooner', {
            [appointment.fieldId]: value('2026-11-01T01:30', {
              zone: 'America/Toronto',
              offsetSeconds: -14400,
            }),
          });
          const linked = await create('Linked zone', {
            [appointment.fieldId]: value('2026-11-01T12:00', {
              zone: 'Canada/Eastern',
            }),
          });
          const defaulted = await create('Default zone', {
            [appointment.fieldId]: value('2026-11-01T12:00'),
          });
          const saved = (result: typeof later) =>
            SavedDateTimeSchema.parse(
              result.readBack!.values[appointment.fieldId],
            );
          assert.equal(saved(later).instant, '2026-11-01T06:30:00.000Z');
          assert.equal(saved(sooner).instant, '2026-11-01T05:30:00.000Z');
          assert.equal(saved(linked).zone, 'America/Toronto');
          assert.equal(saved(defaulted).zone, 'America/Edmonton');
          assert.equal(
            formatRecordZone(saved(later)),
            'November 1, 2026, 01:30 UTC−05:00 America/Toronto',
          );
          assert.deepEqual(saved(later).zoneSource, { kind: 'perRecordIana' });
          assert.match(saved(later).tzdbVersion, /^\d{4}[a-z]$/u);

          // The list orders the two equal-looking civil times by instant,
          // with record ID breaking ties, and prints them in record zone.
          console.error(
            `[date-time] entries saved ${new Date().toISOString()}`,
          );
          const listed = await app.runtime.entry.run(
            { headers: { cookie: 'northstar-demo-actor=manager' } },
            (view) =>
              app.runtime.queryGateway.invoke(view, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: `${NS}:query.custom_equipment_list`,
                arguments: {
                  includeArchived: false,
                  [`${NS}:parameter.custom_equipment_list_legal_entity_scope`]:
                    COMPANY,
                  list: {
                    cursor: null,
                    matchMode: 'substring',
                    pageSize: 50,
                    relationLabels: [],
                    schemaVersion: SHARED_LIST_QUERY_VERSION,
                    search: '',
                    sort: [
                      { fieldId: appointment.fieldId, direction: 'ascending' },
                    ],
                  },
                },
              }),
          );
          const names = listed.records.map(
            (record) => record.values[`${NS}:field.custom_equipment_name`],
          );
          assert.deepEqual(names, [
            'Sooner',
            'Later',
            'Linked zone', // 12:00 Toronto, 17:00Z
            'Default zone', // 12:00 Edmonton, 19:00Z
            'Earlier boiler',
          ]);
          const display = listed.records.find(
            (record) =>
              record.values[`${NS}:field.custom_equipment_name`] === 'Later',
          ) as unknown as { displayValues?: Record<string, string> };
          if (display.displayValues)
            assert.equal(
              display.displayValues[appointment.fieldId],
              'November 1, 2026, 01:30 UTC−05:00 America/Toronto',
            );

          // Untouched keeps the capture; a changed civil time recaptures.
          const id = later.readBack!.recordId;
          const kept = await world.invoke('custom_equipment_update', {
            recordId: id,
            expectedRevision: later.readBack!.revision,
            patch: {
              [appointment.fieldId]: value('2026-11-01T01:30', {
                zone: 'America/Toronto',
              }),
            },
          });
          assert.deepEqual(
            kept.readBack!.values[appointment.fieldId],
            later.readBack!.values[appointment.fieldId],
          );
          const moved = await world.invoke('custom_equipment_update', {
            recordId: id,
            expectedRevision: kept.readBack!.revision,
            patch: {
              [appointment.fieldId]: value('2026-11-02T09:15', {
                zone: 'America/Vancouver',
              }),
            },
          });
          assert.equal(
            SavedDateTimeSchema.parse(
              moved.readBack!.values[appointment.fieldId],
            ).instant,
            '2026-11-02T17:15:00.000Z',
          );

          // Database checks hold without the runtime: a partial capture and a
          // civil/offset/instant disagreement are refused by the table itself.
          const table = (
            await pool.query<{ relname: string }>(
              `SELECT t.relname FROM pg_index AS i
                 JOIN pg_class AS t ON t.oid = i.indrelid
                 JOIN pg_class AS x ON x.oid = i.indexrelid
                WHERE x.relname = $1`,
              [indexName[0]],
            )
          ).rows[0]!.relname;
          const columns = (
            await pool.query<{ attname: string; typname: string }>(
              `SELECT attname, format_type(atttypid, atttypmod) AS typname
                 FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0
                 ORDER BY attnum`,
              [`north_star_module.${table}`],
            )
          ).rows;
          const civilColumn = columns.find(
            (c) => c.typname === 'timestamp(3) without time zone',
          )!.attname;
          const offsetColumn = columns.find(
            (c) => c.typname === 'integer',
          )!.attname;
          for (const [label, sql] of [
            [
              'partial capture',
              `UPDATE north_star_module.${table} SET ${civilColumn} = NULL WHERE record_id = $1`,
            ],
            [
              'inconsistent offset',
              `UPDATE north_star_module.${table} SET ${offsetColumn} = ${offsetColumn} + 3600 WHERE record_id = $1`,
            ],
          ] as const)
            await assert.rejects(
              pool.query(sql, [id]),
              { code: '23514' },
              label,
            );
          console.error(
            `[date-time] database checks verified ${new Date().toISOString()}`,
          );
          // Company-sourced field: the current company calendar decides.
          await pool.query(
            `UPDATE platform.inventory_tenant_calendars SET time_zone = 'America/Toronto'`,
          );
          await opened.service.activate(await ship(due));
          console.error(
            `[date-time] company field active ${new Date().toISOString()}`,
          );
          const company = await create('Company', {
            [due.fieldId]: value('2026-11-01T01:30', { offsetSeconds: -14400 }),
          });
          const capture = SavedDateTimeSchema.parse(
            company.readBack!.values[due.fieldId],
          );
          assert.equal(capture.instant, '2026-11-01T05:30:00.000Z');
          assert.deepEqual(capture.zoneSource, {
            kind: 'companyBusinessCalendar',
            companyId: COMPANY,
            calendarId:
              capture.zoneSource.kind === 'companyBusinessCalendar'
                ? capture.zoneSource.calendarId
                : '',
            dayBoundary:
              capture.zoneSource.kind === 'companyBusinessCalendar'
                ? capture.zoneSource.dayBoundary
                : '',
          });
          const companyGap = await create('Company gap', {
            [due.fieldId]: value('2026-03-08T02:30'),
          }).then(
            () => null,
            (error: { details: Record<string, string> }) => error,
          );
          assert.equal(companyGap?.details.reason, 'DATE_TIME_NONEXISTENT');
          // A calendar change leaves an untouched value intact.
          await pool.query(
            `UPDATE platform.inventory_tenant_calendars SET time_zone = 'America/Edmonton'`,
          );
          const reread = await world.read(
            'custom_equipment',
            company.readBack!.recordId,
          );
          assert.deepEqual(reread.values[due.fieldId], capture);
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

// The preceding production tree: re-pinned to main's tip at merge time.
const previousReader = '67e4efce';

test(
  'releases without the field keep their persisted bytes, the prior parser refuses the member and the prior loader refuses a declaring release',
  { timeout: 1_200_000 },
  async () => {
    await withEphemeralPostgres(
      'date-time-reader',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'date-time-reader' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          // The persisted release row for a field-free customization is the
          // byte-identical release the preceding compiler produces.
          const plain = await opened.service.draft(
            {
              kind: 'addField',
              entity: `${NS}:entity.item`,
              field: { label: 'Inspection notes', type: 'text' },
            },
            'visualBuilder',
          );
          assert.ok(plain.status === 'drafted', JSON.stringify(plain));
          const persisted = (
            await pool.query<{ content_hash: string; desired_state: Buffer }>(
              `SELECT release.content_hash, revision.desired_state
                 FROM platform.tenant_releases AS release
                 JOIN platform.app_package_revisions AS revision
                   ON revision.revision_id = release.app_package_revision_id
                WHERE release.release_id = $1`,
              [plain.releaseId],
            )
          ).rows[0]!;
          await withArchivedCustomizationRuntime(
            previousReader,
            async (run) => {
              const historical = await archivedTenantEnvelope(run);
              assert.equal(persisted.content_hash, historical.releaseRoot);
              assert.equal(
                persisted.desired_state.toString('base64'),
                historical.normalizedDefinitionBytesBase64,
              );
              const parse = (await run(
                `import {readFileSync} from 'node:fs';import {parseCustomizationPatch} from './packages/customization/src/patch.ts';console.log(JSON.stringify(parseCustomizationPatch(JSON.parse(readFileSync(process.argv[2],'utf8')))));`,
                {
                  kind: 'changeSet',
                  patches: [
                    {
                      kind: 'addRecordType',
                      label: 'Visits',
                      fields: [{ label: 'Name', type: 'text' }],
                    },
                    {
                      ...appointment,
                      target: {
                        kind: 'tenantRecordType',
                        recordTypeId: `${NS}:entity.custom_visits`,
                      },
                    },
                  ],
                },
              )) as { status: string; missingCapability?: string };
              assert.equal(parse.status, 'unsupported');
              assert.equal(parse.missingCapability, 'addDateTimeField');
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              const record = await opened.service.draft(
                {
                  kind: 'addRecordType',
                  label: 'Equipment',
                  companyOwnership: 'entityOwned',
                  fields: [{ label: 'Name', type: 'text', required: true }],
                },
                'visualBuilder',
              );
              assert.ok(record.status === 'drafted');
              await opened.service.approve(record.patchId);
              await opened.service.activate(record.patchId);
              assert.equal((await read()).outcome, 'loaded');
              const field = await opened.service.draft(
                appointment,
                'visualBuilder',
              );
              assert.ok(field.status === 'drafted', JSON.stringify(field));
              await opened.service.approve(field.patchId);
              await opened.service.activate(field.patchId);
              const refusal = await read();
              assert.equal(refusal.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refusal.message ?? '',
                new RegExp(
                  `surface-manifest requires version ${String(DATE_TIME_FIELD_READER)}`,
                ),
              );
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

test(
  'one row over the window-index ceiling refuses the attempt by name while the source release keeps serving, and the build at the ceiling is measured',
  { timeout: 1_800_000 },
  async (t) => {
    await withEphemeralPostgres(
      'date-time-ceiling',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'date-time-ceiling' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        const world = worldOver(app.runtime, String(connection.database));
        try {
          const record = await opened.service.draft(
            {
              kind: 'addRecordType',
              label: 'Equipment',
              companyOwnership: 'entityOwned',
              fields: [{ label: 'Name', type: 'text', required: true }],
            },
            'visualBuilder',
          );
          assert.ok(record.status === 'drafted');
          await opened.service.approve(record.patchId);
          await opened.service.activate(record.patchId);
          const seeded = await world.invoke('custom_equipment_create', {
            recordId: randomUUID(),
            legalEntityId: COMPANY,
            relations: {},
            values: { [`${NS}:field.custom_equipment_name`]: 'Seed' },
          });
          assert.equal(seeded.outcome, 'succeeded');
          // The Equipment table is the one module table holding the seed.
          const candidates = await pool.query<{ table: string }>(
            `SELECT c.relname AS table FROM pg_class AS c
               JOIN pg_namespace AS n ON n.oid = c.relnamespace
              WHERE n.nspname = 'north_star_module' AND c.relkind = 'r'
                AND EXISTS (SELECT 1 FROM pg_attribute AS a
                             WHERE a.attrelid = c.oid AND a.attname = 'record_id')`,
          );
          let table = '';
          for (const { table: name } of candidates.rows) {
            const hit = await pool.query(
              `SELECT 1 FROM north_star_module."${name}" WHERE record_id = $1`,
              [seeded.readBack!.recordId],
            );
            if (hit.rowCount) table = `north_star_module.${name}`;
          }
          assert.ok(table, 'the Equipment table holds the seeded record');
          const nameColumn = (
            await pool.query<{ attname: string }>(
              `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass
                 AND format_type(atttypid, atttypmod) = 'character varying(240)'`,
              [table],
            )
          ).rows[0]!.attname;
          const fill = async (count: number, tenant: 'own' | 'other') => {
            const client = await pool.connect();
            try {
              // Another tenant's rows in the pooled table count toward the
              // ceiling; they are written with constraint triggers off.
              if (tenant === 'other')
                await client.query("SET session_replication_role = 'replica'");
              await client.query(
                `INSERT INTO ${table} (tenant_id, environment_id, legal_entity_id, record_id, revision, ${nameColumn})
                 SELECT ${tenant === 'other' ? 'gen_random_uuid()' : 'seed.tenant_id'},
                        seed.environment_id, seed.legal_entity_id, gen_random_uuid(), 1, 'Bulk ' || g
                   FROM (SELECT * FROM ${table} WHERE record_id = $1) AS seed,
                        generate_series(1, $2::integer) AS g`,
                [seeded.readBack!.recordId, count],
              );
            } finally {
              await client.query("SET session_replication_role = 'origin'");
              client.release();
            }
          };
          // 9,000 rows this tenant can see plus 1,001 another tenant's: the
          // tenant-scoped view is under the ceiling, the physical table over it.
          const count = async () =>
            Number(
              (
                await pool.query<{ n: string }>(
                  `SELECT count(*) AS n FROM ${table}`,
                )
              ).rows[0]!.n,
            );
          // Release verification may leave rows of its own; fill up to 9,000
          // this tenant can see, then 1,001 of another tenant's.
          await fill(9_000 - (await count()), 'own');
          await fill(1_001, 'other');
          assert.equal(await count(), 10_001);
          t.diagnostic(`ceiling: filled ${new Date().toISOString()}`);
          const sourceRoot = (await opened.service.status()).activeReleaseRoot;
          const field = await opened.service.draft(
            appointment,
            'visualBuilder',
          );
          assert.ok(field.status === 'drafted', JSON.stringify(field));
          await opened.service.approve(field.patchId);
          await assert.rejects(
            opened.service.activate(field.patchId),
            (error) => {
              assert.equal(
                (error as { code?: string }).code,
                'DATE_TIME_WINDOW_CEILING_EXCEEDED',
              );
              assert.match(
                String((error as Error).message),
                /custom_equipment holds more than 10000 rows/u,
              );
              assert.match(
                String((error as Error).message),
                /custom_equipment_service_at/u,
              );
              return true;
            },
          );
          t.diagnostic(`ceiling: refused ${new Date().toISOString()}`);
          // The verified source keeps serving: it reads and writes as before.
          assert.equal(
            (await opened.service.status()).activeReleaseRoot,
            sourceRoot,
          );
          const read = await world.read(
            'custom_equipment',
            seeded.readBack!.recordId,
          );
          assert.equal(read.values[appointment.fieldId], undefined);
          const updated = await world.invoke('custom_equipment_update', {
            recordId: seeded.readBack!.recordId,
            expectedRevision: read.revision,
            patch: { [`${NS}:field.custom_equipment_name`]: 'Still serving' },
          });
          assert.equal(updated.outcome, 'succeeded');
          // At exactly the ceiling the attempt resumes and builds the index.
          // A concurrent writer measures how long the build blocks writes.
          await pool.query(
            `DELETE FROM ${table} WHERE record_id IN (SELECT record_id FROM ${table} WHERE ${nameColumn} LIKE 'Bulk %' LIMIT 1)`,
          );
          assert.equal(await count(), 10_000);
          t.diagnostic(`ceiling: at the ceiling ${new Date().toISOString()}`);
          const writer = await pool.connect();
          let writing = true;
          let longest = 0;
          const loop = (async () => {
            while (writing) {
              const started = performance.now();
              await writer.query(
                `UPDATE ${table} SET revision = revision WHERE record_id = $1`,
                [seeded.readBack!.recordId],
              );
              longest = Math.max(longest, performance.now() - started);
            }
          })();
          const activated = performance.now();
          await opened.service.activate(field.patchId);
          const activation = performance.now() - activated;
          writing = false;
          await loop;
          writer.release();
          t.diagnostic(
            `writer blocking at the 10,000-row ceiling: longest write ${longest.toFixed(1)} ms during a ${activation.toFixed(0)} ms activation`,
          );
          assert.ok(longest < 2_000, `writer blocked ${longest} ms`);
          assert.notEqual(
            (await opened.service.status()).activeReleaseRoot,
            sourceRoot,
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
