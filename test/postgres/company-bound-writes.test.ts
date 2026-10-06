import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

/**
 * COMPANY-BOUND-WRITES (RETURNABLE-ASSETS round 1, F4). A generic write that
 * names an existing company-owned record acts only on a record of the company
 * its page was entered in. Before this packet the web runtime sent the URL's
 * company only on a create, so a tenant-wide operator who posted company B's
 * record id and current revision through a page entered in company A changed
 * B's record.
 */

const ns = 'northstar.app';
const field = (local: string) => `${ns}:field.${local}`;
const option = (local: string) => `${ns}:option.${local}`;
const STOCK_COUNT_SCOPE = `${ns}:parameter.stock_count_get_legal_entity_scope`;

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

function page(
  fixture: Fixture,
  surface: string,
  parameters: Record<string, string> = {},
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.${surface}`);
  for (const [name, value] of Object.entries(parameters))
    target.searchParams.set(name, value);
  return target.href;
}

async function read(target: string) {
  const response = await fetch(target, { redirect: 'manual' });
  return { status: response.status, html: await response.text() };
}

async function post(target: string, form: Record<string, string>) {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
  return { status: response.status, html: await response.text() };
}

function decoded(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(attributes: string, name: string): string | undefined {
  const found = new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(attributes)?.[1];
  return found === undefined ? undefined : decoded(found);
}

/**
 * What a browser submits from the rendered record form: its action and every
 * successful control, read from the HTML the server rendered -- never
 * reconstructed from the field list.
 */
function renderedForm(html: string, baseUrl: string) {
  const form = /<form id="surface-record-form"([^>]*)>([\s\S]*?)<\/form>/u.exec(
    html,
  );
  assert.ok(form, 'the page renders its record form');
  const action = attribute(form[1]!, 'action');
  assert.ok(action, 'the record form has an action');
  const fields: Record<string, string> = {};
  for (const control of form[2]!.matchAll(/<input\b([^>]*)>/gu)) {
    const name = attribute(control[1]!, 'name');
    const type = attribute(control[1]!, 'type') ?? 'text';
    if (!name || type === 'submit' || type === 'button') continue;
    if (
      (type === 'checkbox' || type === 'radio') &&
      !/\bchecked\b/u.test(control[1]!)
    )
      continue;
    fields[name] =
      attribute(control[1]!, 'value') ?? (type === 'checkbox' ? 'on' : '');
  }
  for (const control of form[2]!.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/gu,
  )) {
    const name = attribute(control[1]!, 'name');
    if (!name) continue;
    const options = [...control[2]!.matchAll(/<option\b([^>]*)>/gu)];
    const chosen =
      options.find((entry) => /\bselected\b/u.test(entry[1]!)) ?? options[0];
    fields[name] = chosen ? (attribute(chosen[1]!, 'value') ?? '') : '';
  }
  for (const control of form[2]!.matchAll(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gu,
  )) {
    const name = attribute(control[1]!, 'name');
    if (name) fields[name] = decoded(control[2]!);
  }
  return { action: new URL(action, baseUrl).href, fields };
}

function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]+)"`, 'u').exec(
    html,
  )?.[1];
  assert.ok(value, `no ${name}`);
  return decoded(value);
}

const diagnostic = (html: string) =>
  /data-diagnostic-code="([A-Z_]+)"/u.exec(html)?.[1] ?? null;

const refused = (code: string) => (error: unknown) => {
  assert.ok(
    typeof error === 'object' && error !== null && 'code' in error,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  return true;
};

test(
  'COMPANY-BOUND-WRITES: a write naming an existing company-owned record acts only in the company it was entered in',
  { timeout: 300_000 },
  async (t) => {
    await withOrderEntryFixture(async (fixture) => {
      const target = await governedStorageTarget();
      const entity = (local: string) =>
        target.entities.find(
          (value) => value.entityId === `${ns}:entity.${local}`,
        )!;
      const count = entity('stock_count');
      assert.ok(count.legalEntity, 'a stock count is company-owned');
      const party = entity('party');
      assert.equal(party.legalEntity, undefined, 'a party is tenant-level');
      const { tenantId, environmentId } = fixture.app.runtime.identity;
      const companyA = fixture.scope;

      // A second company, declared with the tenant's calendar.
      const companyB = randomUUID();
      await fixture.pool.query(
        `SELECT platform.provision_inventory_scope($1,$2,$3,'BIND-B','BIND B',$5,$6,$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
        [
          tenantId,
          environmentId,
          companyB,
          fixture.app.runtime.releaseRoot,
          COMPOSED_APPLICATION_INVENTORY_SCOPE.timeZone,
          COMPOSED_APPLICATION_INVENTORY_SCOPE.businessDayBoundary,
        ],
      );
      assert.equal(
        (
          await fixture.invoke('legal_entity_create', {
            recordId: companyB,
            values: {
              [field('legal_entity_code')]: 'BIND-B',
              [field('legal_entity_name')]: 'Binding B company',
              [field('legal_entity_is_default')]: false,
              [field('legal_entity_status')]: option(
                'legal_entity_status_active',
              ),
            },
          })
        ).outcome,
        'succeeded',
      );

      const createCount = async (legalEntityId: string, number: string) => {
        const recordId = randomUUID();
        const result = await fixture.invoke('stock_count_create', {
          recordId,
          legalEntityId,
          relations: {},
          values: {
            [field('stock_count_number')]: number,
            [field('stock_count_kind')]: option('stock_count_kind_initial'),
            [field('stock_count_state')]: option('stock_count_state_draft'),
            [field('stock_count_location_id')]: fixture.location,
            [field('stock_count_counted_at')]: '2026-10-01T12:00:00.000Z',
          },
        });
        assert.equal(result.outcome, 'succeeded');
        return recordId;
      };
      /** The stored row, read directly -- never through a page or a query. */
      const stored = async (recordId: string) => {
        const { rows } = await fixture.pool.query<{
          archived: boolean;
          company: string;
          number: string;
          revision: string;
        }>(
          `SELECT "${count.optimisticRevision.column}"::text AS revision,
                  "${fulfillmentColumn(count, 'stock_count_number')}" AS number,
                  "${count.legalEntity!.column}"::text AS company,
                  "${count.archive.archivedAtColumn}" IS NOT NULL AS archived
             FROM ${fulfillmentTable(count)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND "${count.recordIdentity.column}" = $3`,
          [tenantId, environmentId, recordId],
        );
        assert.equal(rows.length, 1);
        return rows[0]!;
      };
      const update = (
        recordId: string,
        revision: string,
        number: string,
        binding: Record<string, string>,
        key = randomUUID(),
      ) =>
        fixture.invoke(
          'stock_count_update',
          {
            recordId,
            expectedRevision: Number(revision),
            ...binding,
            patch: { [field('stock_count_number')]: number },
          } as ImmutableJsonValue,
          key,
        );

      const countA = await createCount(companyA, 'BIND-A-1');
      const countB = await createCount(companyB, 'BIND-B-1');
      const formIn = (company: string, recordId: string) =>
        page(fixture, 'stock_count_form', {
          record: recordId,
          [STOCK_COUNT_SCOPE]: company,
        });
      const detailIn = (company: string, recordId: string) =>
        page(fixture, 'stock_count_detail', {
          record: recordId,
          [STOCK_COUNT_SCOPE]: company,
        });

      await t.test(
        "an edit posted through a page entered in A does not change B's record",
        async () => {
          const opened = await read(formIn(companyA, countA));
          assert.equal(opened.status, 200);
          const form = renderedForm(opened.html, fixture.app.baseUrl);
          assert.equal(
            new URL(form.action).searchParams.get(STOCK_COUNT_SCOPE),
            companyA,
            "the form posts back to the page's company",
          );
          const before = await stored(countB);
          const response = await post(form.action, {
            ...form.fields,
            recordId: countB,
            expectedRevision: before.revision,
            [`value:${field('stock_count_number')}`]: 'MOVED-BY-A',
          });
          // The persisted row first: it is the fact, the page only reports it.
          assert.deepEqual(
            await stored(countB),
            before,
            "B's record must not be written through A's page",
          );
          assert.equal(
            diagnostic(response.html),
            'OPERATION_LEGAL_ENTITY_MISMATCH',
          );
          assert.equal(response.status, 422);
          assert.match(response.html, /Record belongs to another company/u);
        },
      );

      await t.test('the same edit in its own company saves', async () => {
        const opened = await read(formIn(companyA, countA));
        const form = renderedForm(opened.html, fixture.app.baseUrl);
        const before = await stored(countA);
        const response = await post(form.action, {
          ...form.fields,
          [`value:${field('stock_count_number')}`]: 'BIND-A-1-EDITED',
        });
        assert.equal(response.status, 200, diagnostic(response.html) ?? '');
        assert.deepEqual(await stored(countA), {
          ...before,
          number: 'BIND-A-1-EDITED',
          revision: String(Number(before.revision) + 1),
        });
      });

      await t.test(
        'archive and restore are bound to the entered company',
        async () => {
          const lifecycle = async (
            company: string,
            recordId: string,
            operation: 'archive' | 'restore',
          ) => {
            const url = detailIn(company, recordId);
            const form = {
              idempotencyKey: randomUUID(),
              operationId: `${ns}:operation.stock_count_${operation}`,
              recordId,
              expectedRevision: (await stored(recordId)).revision,
            };
            const first = await post(url, form);
            // Archive asks for a human confirmation first; restore does not.
            if (!/name="confirmationGrant"/u.test(first.html)) return first;
            assert.equal(first.status, 200);
            return post(url, {
              ...form,
              confirmationGrant: hidden(first.html, 'confirmationGrant'),
            });
          };

          const activeB = await stored(countB);
          const archiveBInA = await lifecycle(companyA, countB, 'archive');
          assert.equal(
            diagnostic(archiveBInA.html),
            'OPERATION_LEGAL_ENTITY_MISMATCH',
          );
          assert.deepEqual(await stored(countB), activeB);

          const archiveAInA = await lifecycle(companyA, countA, 'archive');
          assert.equal(archiveAInA.status, 200);
          assert.equal((await stored(countA)).archived, true);

          const archiveBInB = await lifecycle(companyB, countB, 'archive');
          assert.equal(archiveBInB.status, 200);
          const archivedB = await stored(countB);
          assert.equal(archivedB.archived, true);

          const restoreBInA = await lifecycle(companyA, countB, 'restore');
          assert.equal(
            diagnostic(restoreBInA.html),
            'OPERATION_LEGAL_ENTITY_MISMATCH',
          );
          assert.deepEqual(await stored(countB), archivedB);

          for (const [company, recordId] of [
            [companyA, countA],
            [companyB, countB],
          ] as const) {
            const restored = await lifecycle(company, recordId, 'restore');
            assert.equal(restored.status, 200);
            assert.equal((await stored(recordId)).archived, false);
          }
        },
      );

      await t.test('a tenant-level record is unaffected', async () => {
        const name = fulfillmentColumn(party, 'party_contact_summary');
        const summary = async () =>
          (
            await fixture.pool.query<{ value: string | null }>(
              `SELECT "${name}" AS value FROM ${fulfillmentTable(party)}
                WHERE tenant_id = $1 AND environment_id = $2
                  AND "${party.recordIdentity.column}" = $3`,
              [tenantId, environmentId, fixture.customer],
            )
          ).rows[0]!.value;
        // Its ordinary edit carries no company and saves.
        const opened = await read(
          page(fixture, 'party_form', { record: fixture.customer }),
        );
        assert.equal(opened.status, 200);
        const form = renderedForm(opened.html, fixture.app.baseUrl);
        const response = await post(form.action, {
          ...form.fields,
          [`value:${field('party_contact_summary')}`]:
            'Edited without a company',
        });
        assert.equal(response.status, 200, diagnostic(response.html) ?? '');
        assert.equal(await summary(), 'Edited without a company');
        // A company named on its write is refused by name, before any write:
        // it would otherwise scope a company grant onto a record no company owns.
        const revision = (
          await fixture.pool.query<{ revision: string }>(
            `SELECT "${party.optimisticRevision.column}"::text AS revision
               FROM ${fulfillmentTable(party)}
              WHERE tenant_id = $1 AND environment_id = $2
                AND "${party.recordIdentity.column}" = $3`,
            [tenantId, environmentId, fixture.customer],
          )
        ).rows[0]!.revision;
        await assert.rejects(
          fixture.invoke('party_update', {
            recordId: fixture.customer,
            expectedRevision: Number(revision),
            legalEntityId: companyA,
            patch: { [field('party_contact_summary')]: 'Bound to A' },
          }),
          refused('MODULE_LEGAL_ENTITY_BINDING_UNSUPPORTED'),
        );
        assert.equal(await summary(), 'Edited without a company');
      });

      await t.test(
        'the comparison reads the persisted row under its lock',
        async () => {
          // Records never move companies. To observe WHICH row the comparison
          // reads, a direct transaction moves one anyway and holds the row
          // while the A-bound edit arrives; the edit must wait for it and then
          // judge the row it is about to write, not the one it saw first.
          const recordId = await createCount(companyA, 'BIND-A-LOCK');
          const before = await stored(recordId);
          const mover = await fixture.pool.connect();
          try {
            await mover.query('BEGIN');
            const moverPid = (
              await mover.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            await mover.query(
              `UPDATE ${fulfillmentTable(count)}
                  SET "${count.legalEntity!.column}" = $4
                WHERE tenant_id = $1 AND environment_id = $2
                  AND "${count.recordIdentity.column}" = $3`,
              [tenantId, environmentId, recordId, companyB],
            );
            const edit = update(recordId, before.revision, 'MOVED-IN-FLIGHT', {
              legalEntityId: companyA,
            }).then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            );
            await waitUntilBlockedBy(fixture, moverPid);
            await mover.query('COMMIT');
            const settled = await edit;
            assert.ok('error' in settled, 'the in-flight edit must be refused');
            refused('MODULE_LEGAL_ENTITY_BINDING_MISMATCH')(settled.error);
          } finally {
            mover.release();
          }
          assert.deepEqual(await stored(recordId), {
            ...before,
            company: companyB,
          });
        },
      );

      await t.test(
        'a request key recorded without the company still replays, and only in its own company',
        async () => {
          // What every write sent before this packet: no company operand.
          const revisionA = (await stored(countA)).revision;
          const keyA = randomUUID();
          const firstA = await update(countA, revisionA, 'REPLAY-A', {}, keyA);
          assert.equal(firstA.outcome, 'succeeded');
          const afterA = await stored(countA);
          const replayA = await update(
            countA,
            revisionA,
            'REPLAY-A',
            { legalEntityId: companyA },
            keyA,
          );
          assert.deepEqual(replayA.trust, firstA.trust, 'replayed, not rerun');
          assert.deepEqual(await stored(countA), afterA);

          const revisionB = (await stored(countB)).revision;
          const keyB = randomUUID();
          const firstB = await update(countB, revisionB, 'REPLAY-B', {}, keyB);
          assert.equal(firstB.outcome, 'succeeded');
          const afterB = await stored(countB);
          await assert.rejects(
            update(
              countB,
              revisionB,
              'REPLAY-B',
              { legalEntityId: companyA },
              keyB,
            ),
            refused('MODULE_LEGAL_ENTITY_BINDING_MISMATCH'),
          );
          const replayB = await update(
            countB,
            revisionB,
            'REPLAY-B',
            { legalEntityId: companyB },
            keyB,
          );
          assert.deepEqual(replayB.trust, firstB.trust);
          assert.deepEqual(await stored(countB), afterB);

          // A key recorded WITH its company is bound to it.
          const keyBound = randomUUID();
          const revision = (await stored(countA)).revision;
          const bound = await update(
            countA,
            revision,
            'REPLAY-A-BOUND',
            { legalEntityId: companyA },
            keyBound,
          );
          assert.equal(bound.outcome, 'succeeded');
          await assert.rejects(
            update(
              countA,
              revision,
              'REPLAY-A-BOUND',
              { legalEntityId: companyB },
              keyBound,
            ),
            refused('SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT'),
          );
          await assert.rejects(
            update(countA, revision, 'REPLAY-A-BOUND', {}, keyBound),
            refused('SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT'),
          );
          assert.deepEqual(
            (
              await update(
                countA,
                revision,
                'REPLAY-A-BOUND',
                { legalEntityId: companyA },
                keyBound,
              )
            ).trust,
            bound.trust,
          );
        },
      );

      await t.test(
        "a principal granted only company A writes A's records and no others",
        async () => {
          // Narrow the local operator's one role to company A.
          const narrowed = await fixture.pool.query(
            `UPDATE platform.current_policy_memberships AS membership
                SET legal_entity_id = $3
               FROM platform.current_policy_roles AS role
              WHERE membership.tenant_id = $1 AND membership.environment_id = $2
                AND role.tenant_id = membership.tenant_id
                AND role.environment_id = membership.environment_id
                AND role.role_id = membership.role_id
                AND role.role_key = 'local-demo-full-release'
                AND membership.revoked_at IS NULL`,
            [tenantId, environmentId, companyA],
          );
          assert.ok((narrowed.rowCount ?? 0) >= 1);
          const revisionA = (await stored(countA)).revision;
          // Unbound, the write names no company, so a company grant cannot
          // authorize it -- as before this packet.
          await assert.rejects(
            update(countA, revisionA, 'SCOPED-UNBOUND', {}),
            refused('SEMANTIC_OPERATION_POLICY_DENIED'),
          );
          // Bound to A, the company grant authorizes it.
          assert.equal(
            (
              await update(countA, revisionA, 'SCOPED-A', {
                legalEntityId: companyA,
              })
            ).outcome,
            'succeeded',
          );
          assert.equal((await stored(countA)).number, 'SCOPED-A');
          const beforeB = await stored(countB);
          // Naming A does not reach B's record; naming B is not authorized.
          await assert.rejects(
            update(countB, beforeB.revision, 'SCOPED-INTO-B', {
              legalEntityId: companyA,
            }),
            refused('MODULE_LEGAL_ENTITY_BINDING_MISMATCH'),
          );
          await assert.rejects(
            update(countB, beforeB.revision, 'SCOPED-INTO-B', {
              legalEntityId: companyB,
            }),
            refused('SEMANTIC_OPERATION_POLICY_DENIED'),
          );
          assert.deepEqual(await stored(countB), beforeB);
        },
      );
    });
  },
);

/** Observes the blocked backend in pg_stat_activity; never sleeps a duration. */
async function waitUntilBlockedBy(
  fixture: Fixture,
  blockerPid: number,
): Promise<void> {
  const deadline = process.hrtime.bigint() + 30_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const { rows } = await fixture.pool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND $1::integer = ANY(pg_blocking_pids(pid))
        LIMIT 1`,
      [blockerPid],
    );
    if (rows.length === 1) return;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error('the bound edit never waited on the moved row');
}
