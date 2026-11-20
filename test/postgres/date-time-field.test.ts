import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  SavedDateTimeSchema,
  formatRecordZone,
} from '../../packages/canonical-model/src/index.js';
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
  { timeout: 900000 },
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
              values: { [`${NS}:field.custom_equipment_name`]: name, ...values },
            });
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
            'Default zone',
            'Linked zone',
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
            SavedDateTimeSchema.parse(moved.readBack!.values[appointment.fieldId])
              .instant,
            '2026-11-02T17:15:00.000Z',
          );

          // Database checks hold without the runtime: a partial capture and a
          // civil/offset/instant disagreement are refused by the table itself.
          const table = (
            await pool.query<{ relname: string }>(
              `SELECT relname FROM pg_class JOIN pg_index ON pg_index.indrelid = pg_class.oid
                 JOIN pg_class AS i ON i.oid = pg_index.indexrelid WHERE i.relname = $1`,
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
          const offsetColumn = columns.find((c) => c.typname === 'integer')!
            .attname;
          for (const [label, sql] of [
            ['partial capture', `UPDATE north_star_module.${table} SET ${civilColumn} = NULL WHERE record_id = $1`],
            ['inconsistent offset', `UPDATE north_star_module.${table} SET ${offsetColumn} = ${offsetColumn} + 3600 WHERE record_id = $1`],
          ] as const)
            await assert.rejects(pool.query(sql, [id]), { code: '23514' }, label);
          // Company-sourced field: the current company calendar decides.
          await pool.query(
            `UPDATE platform.inventory_tenant_calendars SET time_zone = 'America/Toronto'`,
          );
          await opened.service.activate(await ship(due));
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
            calendarId: capture.zoneSource.kind === 'companyBusinessCalendar'
              ? capture.zoneSource.calendarId
              : '',
            dayBoundary: capture.zoneSource.kind === 'companyBusinessCalendar'
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
