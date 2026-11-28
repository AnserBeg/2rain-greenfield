/**
 * OPEN-ITEM-1 slices 1 and 2 on PostgreSQL: tenant-declared receivables (a
 * fee note with lines, a line-less receipt, a credit note with lines, and an
 * application type for each credit-side type) go draft -> issue (numbered
 * per company and series) -> applied -> unapplied or void, on two companies
 * of one tenant. Each assertion message names the check whose removal reds
 * it (rule 8; test/evidence/OPEN-ITEM-1-s1.expected-red.json and -s2).
 * One install, self-contained subtests: each creates its own records.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';

import { escapeIdentifier, type Pool } from 'pg';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import {
  OPEN_ITEM_APPLY_CAPABILITY,
  openItemLineSetDigest,
  type OpenItemOperationBinding,
} from '../../packages/canonical-model/src/index.js';
import { createComposedApplicationRuntime } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import type { PostgresCapabilityOperationExecutorContext } from '../../packages/postgres-provider/src/capability-operation-executor-factory.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { INVENTORY_WRITE_INVARIANTS } from '../../packages/postgres-provider/src/inventory-write-invariants.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { OPEN_ITEM_CAPABILITY_EXECUTOR_FACTORIES } from '../../packages/postgres-provider/src/open-item-capability-executor.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type RegisteredCapabilityOperationAuthorizationRequest,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { migrationsDirectory } from '../helpers/customization-fixture.js';
import {
  APPLICATION,
  APPLICATION_SOURCE,
  APPLICATION_TARGET,
  APPLY,
  CREDIT,
  CREDIT_ACCOUNT,
  CREDIT_APPLICATION,
  CREDIT_LINES,
  CREDIT_LINES_PARENT,
  CREDIT_TARGET,
  ISSUE_NOTE,
  NOTE,
  NOTE_ACCOUNT,
  NOTE_LINES,
  NOTE_LINES_PARENT,
  RECEIPT,
  RECEIPT_ACCOUNT,
  applied,
  compileOpenItems,
  credit,
  creditLine,
  credited,
  line,
  note,
  openItemApplication,
  openItemAuthored,
  receipt,
} from '../helpers/open-item-fixture.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const NS = 'northstar.app:';
/** An input decimal in canonical spelling ("40.00" is sent as "40"). */
const canonical = (value: string) =>
  value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
const MANAGER = { headers: { cookie: 'northstar-demo-actor=manager' } };
const outcome = (promise: Promise<{ outcome: string }>) =>
  promise.then(
    (result) =>
      result.outcome === 'succeeded' ? 'succeeded' : JSON.stringify(result),
    (error: Error & { code?: string }) =>
      `${String(error.code)} ${error.message}`,
  );

test(
  'OPEN-ITEM-1-s1: draft -> issue (numbered per company) -> one receipt applied, on two companies',
  { timeout: 1_800_000 },
  async (t) => {
    await withEphemeralPostgres(
      'open-items',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
        const tenantSlug = 'open-items';
        const runtime = await createComposedApplicationRuntime({
          // The base release's own capabilities (startRuntime's list) and
          // the open-item core.
          capabilityOperationExecutorFactories: [
            INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
            PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
            ...OPEN_ITEM_CAPABILITY_EXECUTOR_FACTORIES,
          ],
          compiledApplication: openItemApplication(),
          databaseUrl,
          inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
          localDemoIdentity: true,
          migrationsDirectory,
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          writeInvariants: INVENTORY_WRITE_INVARIANTS,
          tenantSlug,
        });
        try {
          await run(
            t,
            runtime,
            pool,
            databaseUrl,
            tenantSlug,
            String(connection.database),
          );
        } finally {
          await runtime.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

async function run(
  t: TestContext,
  runtime: Awaited<ReturnType<typeof createComposedApplicationRuntime>>,
  pool: Pool,
  databaseUrl: string,
  tenantSlug: string,
  databaseName: string,
) {
  const world = worldOver(runtime, databaseName, databaseUrl, tenantSlug);
  const { tenant, environment } = (
    await pool.query<{ tenant: string; environment: string }>(
      `SELECT p.tenant_id AS tenant, p.environment_id AS environment
         FROM platform.active_release_pointers p JOIN platform.tenants tn ON tn.id = p.tenant_id
        WHERE tn.slug = $1`,
      [tenantSlug],
    )
  ).rows[0]!;
  // The released storage plan, read as the core reads it.
  const plan = (
    await pool.query<{ plan: StoragePlan }>(
      `SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb AS plan
         FROM platform.active_release_pointers p
         JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
         JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
         JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
           AND blob.artifact_kind = 'projectionChunk'
        WHERE (p.tenant_id, p.environment_id) = ($1,$2)
          AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'`,
      [tenant, environment],
    )
  ).rows[0]!.plan;
  const physical = (entityId: string) => {
    const entity = plan.entities.find((entry) => entry.entityId === entityId)!;
    return {
      table: `north_star_module.${escapeIdentifier(entity.physicalTableName)}`,
      column: (fieldId: string) =>
        escapeIdentifier(
          entity.columns.find((entry) => entry.canonicalFieldId === fieldId)!
            .physicalName,
        ),
      relation: (relationId: string) =>
        escapeIdentifier(
          plan.relations.find((entry) => entry.relationId === relationId)!
            .relationColumn.physicalName,
        ),
    };
  };
  const stateField = (local: string) =>
    `${NS}derived_state_field.machine.custom_${local}`;
  /** An item's stored figures, revision and state, read straight from storage. */
  type Kind = 'fee_note' | 'receipt' | 'credit_note';
  const stored = async (kind: Kind, recordId: string) => {
    const entity =
      kind === 'fee_note' ? NOTE : kind === 'receipt' ? RECEIPT : CREDIT;
    const f =
      kind === 'fee_note' ? note : kind === 'receipt' ? receipt : credit;
    const p = physical(entity);
    const row = (
      await pool.query<Record<string, string | null>>(
        `SELECT revision::text AS revision, ${p.column(f('number'))} AS number,
                ${p.column(f('total'))}::text AS total, ${p.column(f('applied'))}::text AS applied,
                ${p.column(f('balance'))}::text AS balance, ${p.column(stateField(kind))} AS state
           FROM ${p.table} WHERE (tenant_id, environment_id, record_id) = ($1,$2,$3)`,
        [tenant, environment, recordId],
      )
    ).rows[0]!;
    return {
      number: row.number ?? null,
      total: row.total ?? null,
      applied: row.applied ?? null,
      balance: row.balance ?? null,
      revision: Number(row.revision),
      state: String(row.state).replace(`${NS}state.custom_${kind}_`, ''),
    };
  };
  /** The live lines of a fee note (or a credit note): ID and revision. */
  const liveLines = async (
    noteId: string,
    lines = NOTE_LINES,
    parent = NOTE_LINES_PARENT,
  ) => {
    const p = physical(lines);
    return (
      await pool.query<{ recordId: string; revision: number }>(
        `SELECT record_id::text AS "recordId", revision::int AS revision FROM ${p.table}
          WHERE (tenant_id, environment_id) = ($1,$2) AND ${p.relation(parent)} = $3
            AND archived_at IS NULL`,
        [tenant, environment, noteId],
      )
    ).rows;
  };
  /** Sum of the live application amounts naming `recordId` on one end. */
  const appliedSum = async (
    end: string,
    recordId: string,
    entity = APPLICATION,
    amount = applied('amount'),
  ) => {
    const p = physical(entity);
    return (
      await pool.query<{ sum: string }>(
        `SELECT coalesce(sum(${p.column(amount)}), 0.00)::text AS sum FROM ${p.table}
          WHERE (tenant_id, environment_id) = ($1,$2) AND ${p.relation(end)} = $3 AND archived_at IS NULL`,
        [tenant, environment, recordId],
      )
    ).rows[0]!.sum;
  };
  const creditSum = (end: string, recordId: string) =>
    appliedSum(end, recordId, CREDIT_APPLICATION, credited('amount'));

  // A second company of the same tenant and environment.
  const companyB = randomUUID();
  const created = await world.invoke('legal_entity_create', {
    recordId: companyB,
    relations: {},
    values: {
      [`${NS}field.legal_entity_name`]: 'Second company',
      [`${NS}field.legal_entity_code`]: 'OPENB',
      [`${NS}field.legal_entity_is_default`]: false,
      [`${NS}field.legal_entity_status`]: `${NS}option.legal_entity_status_active`,
    },
  });
  assert.equal(created.outcome, 'succeeded', JSON.stringify(created));

  const account = async (name: string) => {
    const result = await world.invoke('custom_account_create', {
      recordId: randomUUID(),
      relations: {},
      values: { [`${NS}field.custom_account_name`]: name },
    });
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
    return result.readBack!.recordId;
  };
  const accountA = await account('Harbour Clinic');
  const accountB = await account('Ridge Rentals');

  let lineNumber = 0;
  const addLine = async (
    noteId: string,
    amount: string,
    company: string = COMPANY,
  ) => {
    const result = await world.invoke('custom_fee_note_lines_create', {
      recordId: randomUUID(),
      legalEntityId: company,
      values: {
        [line('line_number')]: String(++lineNumber),
        [line('item')]: 'Service',
        [line('amount')]: canonical(amount),
      },
      relations: { [NOTE_LINES_PARENT]: noteId },
    });
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
    return result.readBack!;
  };
  /** A draft fee note with lines. */
  const draftNote = async (
    amounts: readonly string[],
    options: {
      company?: string;
      currency?: string;
      party?: string;
      name?: string;
    } = {},
  ) => {
    const company = options.company ?? COMPANY;
    const result = await world.invoke('custom_fee_note_create', {
      recordId: randomUUID(),
      legalEntityId: company,
      values: {
        [note('name')]: options.name ?? 'Visit',
        [note('currency')]: options.currency ?? 'CAD',
      },
      relations: { [NOTE_ACCOUNT]: options.party ?? accountA },
    });
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
    const noteId = result.readBack!.recordId;
    for (const amount of amounts) await addLine(noteId, amount, company);
    return noteId;
  };
  const issueInput = async (noteId: string, total: string) => ({
    recordId: noteId,
    expectedRevision: (await stored('fee_note', noteId)).revision,
    arguments: {
      total,
      lineSetDigest: openItemLineSetDigest(await liveLines(noteId)),
    },
  });
  const issueNote = async (noteId: string, total: string) =>
    outcome(
      world.invoke(
        'custom_fee_note_action_issue',
        await issueInput(noteId, total),
      ),
    );
  const draftReceipt = async (
    amount: string,
    options: { company?: string; currency?: string; party?: string } = {},
  ) => {
    const result = await world.invoke('custom_receipt_create', {
      recordId: randomUUID(),
      legalEntityId: options.company ?? COMPANY,
      values: {
        [receipt('name')]: 'Bank transfer',
        [receipt('currency')]: options.currency ?? 'CAD',
        [receipt('amount')]: canonical(amount),
      },
      relations: { [RECEIPT_ACCOUNT]: options.party ?? accountA },
    });
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
    return result.readBack!.recordId;
  };
  const issueReceipt = async (receiptId: string, total: string) =>
    outcome(
      world.invoke('custom_receipt_action_issue', {
        recordId: receiptId,
        expectedRevision: (await stored('receipt', receiptId)).revision,
        arguments: { total },
      }),
    );
  const applyInput = async (
    receiptId: string,
    lines: readonly { target: string; amount: string }[],
  ) => ({
    recordId: receiptId,
    expectedRevision: (await stored('receipt', receiptId)).revision,
    arguments: {
      lines: lines.map((entry) => ({ applicationId: randomUUID(), ...entry })),
    },
  });
  const apply = async (
    receiptId: string,
    lines: readonly { target: string; amount: string }[],
  ) =>
    outcome(
      world.invoke(
        'custom_receipt_application_create',
        await applyInput(receiptId, lines),
      ),
    );

  await t.test(
    'an issue numbers per company and series, freezes the figures, and a receipt applies',
    async () => {
      const first = await draftNote(['40.00', '60.00']);
      const draft = await stored('fee_note', first);
      assert.equal(draft.number, null, 'a draft fee note carries a number');
      assert.equal(draft.state, 'draft');
      assert.equal(await issueNote(first, '100.00'), 'succeeded');
      const issued = await stored('fee_note', first);
      assert.equal(
        issued.number,
        'FN-000001',
        'the first issue in company A is not FN-000001',
      );
      assert.equal(
        issued.total,
        '100.00',
        'the stored total is not the sum of the live lines',
      );
      assert.equal(issued.applied, '0.00');
      assert.equal(issued.balance, '100.00');
      assert.equal(issued.state, 'open');
      const second = await draftNote(['5.00']);
      assert.equal(await issueNote(second, '5.00'), 'succeeded');
      assert.equal((await stored('fee_note', second)).number, 'FN-000002');
      const other = await draftNote(['7.50'], {
        company: companyB,
        party: accountA,
      });
      assert.equal(await issueNote(other, '7.50'), 'succeeded');
      assert.equal(
        (await stored('fee_note', other)).number,
        'FN-000001',
        'company B did not start its own series: numbers are counted tenant-wide',
      );
      const money = await draftReceipt('30.00');
      assert.equal(await issueReceipt(money, '30.00'), 'succeeded');
      assert.equal((await stored('receipt', money)).number, 'RC-000001');
      assert.equal(
        await apply(money, [{ target: first, amount: '30.00' }]),
        'succeeded',
      );
      const paid = await stored('fee_note', first);
      assert.deepEqual(
        [paid.applied, paid.balance, paid.state],
        ['30.00', '70.00', 'partially_settled'],
      );
      const spent = await stored('receipt', money);
      assert.deepEqual(
        [spent.applied, spent.balance, spent.state],
        ['30.00', '0.00', 'settled'],
      );
      assert.equal(
        await appliedSum(APPLICATION_TARGET, first),
        '30.00',
        'applied is not the sum of the application lines',
      );
      assert.equal(await appliedSum(APPLICATION_SOURCE, money), '30.00');
    },
  );

  await t.test('a rolled-back issue returns its number: no gap', async () => {
    const before = await draftNote(['1.00']);
    assert.equal(await issueNote(before, '1.00'), 'succeeded');
    const last = Number(
      String((await stored('fee_note', before)).number).slice(3),
    );
    // Fail the issue after the number is drawn: the item update refuses.
    const failing = await draftNote(['2.00'], { name: 'Rollback' });
    const p = physical(NOTE);
    await pool.query(`CREATE FUNCTION public.open_item_test_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test refusal after the number'; END $$`);
    await pool.query(`CREATE TRIGGER open_item_test_refuse BEFORE UPDATE ON ${p.table}
      FOR EACH ROW WHEN (OLD.${p.column(note('name'))} = 'Rollback')
      EXECUTE FUNCTION public.open_item_test_refuse()`);
    try {
      assert.match(
        await issueNote(failing, '2.00'),
        /test refusal after the number/u,
      );
    } finally {
      await pool.query(`DROP TRIGGER open_item_test_refuse ON ${p.table}`);
      await pool.query('DROP FUNCTION public.open_item_test_refuse()');
    }
    assert.equal((await stored('fee_note', failing)).number, null);
    const after = await draftNote(['3.00']);
    assert.equal(await issueNote(after, '3.00'), 'succeeded');
    assert.equal(
      (await stored('fee_note', after)).number,
      `FN-${String(last + 1).padStart(6, '0')}`,
      'a rolled-back issue left a gap in the series',
    );
  });

  await t.test(
    "generic writes stay on drafts: core figures are nobody's input",
    async () => {
      const draft = await draftNote(['10.00']);
      const patched = await outcome(
        world.invoke('custom_fee_note_update', {
          recordId: draft,
          expectedRevision: (await stored('fee_note', draft)).revision,
          patch: { [note('balance')]: '0' },
        }),
      );
      assert.notEqual(
        patched,
        'succeeded',
        "a generic update wrote a draft fee note's balance",
      );
      const forged = await outcome(
        world.invoke('custom_receipt_create', {
          recordId: randomUUID(),
          legalEntityId: COMPANY,
          values: {
            [receipt('name')]: 'Forged',
            [receipt('currency')]: 'CAD',
            [receipt('amount')]: '10',
            [receipt('applied')]: '10',
          },
          relations: { [RECEIPT_ACCOUNT]: accountA },
        }),
      );
      assert.notEqual(
        forged,
        'succeeded',
        "a generic create wrote a receipt's applied",
      );
      assert.equal(await issueNote(draft, '10.00'), 'succeeded');
      const issued = await stored('fee_note', draft);
      const renamed = await outcome(
        world.invoke('custom_fee_note_update', {
          recordId: draft,
          expectedRevision: issued.revision,
          patch: { [note('name')]: 'Renamed' },
        }),
      );
      assert.notEqual(
        renamed,
        'succeeded',
        'a generic update changed an issued fee note',
      );
      const archived = await outcome(
        world.invoke('custom_fee_note_archive', {
          recordId: draft,
          expectedRevision: issued.revision,
        }),
      );
      assert.notEqual(
        archived,
        'succeeded',
        'a generic archive removed an issued fee note',
      );
      // A generic transition on an open-item machine does not compile.
      const { authored, bindings } = openItemAuthored({ genericIssue: true });
      const generic = compileOpenItems(authored, bindings);
      assert.notEqual(
        generic.status,
        'compiled',
        'a generic issue transition compiled',
      );
    },
  );

  await t.test(
    'the line set is frozen: a changed line refuses the issue, a line write after issue refuses',
    async () => {
      const draft = await draftNote(['20.00', '30.00']);
      const previewed = await issueInput(draft, '50.00');
      // Same total, different lines: 20 + 30 becomes 25 + 25.
      const lines = await liveLines(draft);
      for (const entry of lines) {
        const result = await world.invoke('custom_fee_note_lines_update', {
          recordId: entry.recordId,
          expectedRevision: entry.revision,
          patch: { [line('amount')]: '25' },
        });
        assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
      }
      const refusedIssue = await outcome(
        world.invoke('custom_fee_note_action_issue', previewed),
      );
      assert.match(
        refusedIssue,
        /openItem\.linesChanged/u,
        `an issue froze a line set other than the one confirmed: ${refusedIssue}`,
      );
      assert.equal(await issueNote(draft, '50.00'), 'succeeded');
      assert.equal((await stored('fee_note', draft)).total, '50.00');
      const late = await outcome(
        world.invoke('custom_fee_note_lines_create', {
          recordId: randomUUID(),
          legalEntityId: COMPANY,
          values: {
            [line('line_number')]: String(++lineNumber),
            [line('item')]: 'Late',
            [line('amount')]: '1',
          },
          relations: { [NOTE_LINES_PARENT]: draft },
        }),
      );
      assert.notEqual(
        late,
        'succeeded',
        'a line was added to an issued fee note',
      );
      assert.equal((await stored('fee_note', draft)).total, '50.00');
    },
  );

  await t.test(
    'two receipts over-applying one fee note: exactly one succeeds',
    async () => {
      const target = await draftNote(['100.00']);
      assert.equal(await issueNote(target, '100.00'), 'succeeded');
      const first = await draftReceipt('60.00');
      const second = await draftReceipt('60.00');
      assert.equal(await issueReceipt(first, '60.00'), 'succeeded');
      assert.equal(await issueReceipt(second, '60.00'), 'succeeded');
      const inputs = await Promise.all([
        applyInput(first, [{ target, amount: '60.00' }]),
        applyInput(second, [{ target, amount: '60.00' }]),
      ]);
      const results = await Promise.all(
        inputs.map((input) =>
          outcome(world.invoke('custom_receipt_application_create', input)),
        ),
      );
      assert.equal(
        results.filter((result) => result === 'succeeded').length,
        1,
        `two receipts over-applied one fee note: ${results.join(' | ')}`,
      );
      assert.ok(
        results.some((result) => /openItem\.exceedsBalance/u.test(result)),
        results.join(' | '),
      );
      const settled = await stored('fee_note', target);
      assert.deepEqual([settled.applied, settled.balance], ['60.00', '40.00']);
      assert.equal(
        await appliedSum(APPLICATION_TARGET, target),
        settled.applied,
      );
    },
  );

  await t.test(
    'one receipt across three fee notes against a crossing pair: no deadlock',
    async () => {
      const notes = [
        await draftNote(['50.00']),
        await draftNote(['50.00']),
        await draftNote(['50.00']),
      ];
      for (const id of notes)
        assert.equal(await issueNote(id, '50.00'), 'succeeded');
      const left = await draftReceipt('60.00');
      const right = await draftReceipt('60.00');
      assert.equal(await issueReceipt(left, '60.00'), 'succeeded');
      assert.equal(await issueReceipt(right, '60.00'), 'succeeded');
      const inputs = await Promise.all([
        applyInput(
          left,
          notes.map((target) => ({ target, amount: '20.00' })),
        ),
        applyInput(
          right,
          [...notes].reverse().map((target) => ({ target, amount: '20.00' })),
        ),
      ]);
      const results = await Promise.all(
        inputs.map((input) =>
          outcome(world.invoke('custom_receipt_application_create', input)),
        ),
      );
      assert.deepEqual(results, ['succeeded', 'succeeded']);
      for (const id of notes) {
        const item = await stored('fee_note', id);
        assert.deepEqual([item.applied, item.balance], ['40.00', '10.00']);
        assert.equal(await appliedSum(APPLICATION_TARGET, id), '40.00');
      }
    },
  );

  await t.test(
    'only an open receipt applies, within one currency, counterparty and direction',
    async () => {
      const target = await draftNote(['80.00']);
      assert.equal(await issueNote(target, '80.00'), 'succeeded');
      const draft = await draftReceipt('10.00');
      const fromDraft = await apply(draft, [{ target, amount: '10.00' }]);
      assert.match(
        fromDraft,
        /openItem\.sourceNotOpen/u,
        `a draft receipt was applied: ${fromDraft}`,
      );
      const dollars = await draftReceipt('10.00', { currency: 'USD' });
      assert.equal(await issueReceipt(dollars, '10.00'), 'succeeded');
      const crossCurrency = await apply(dollars, [{ target, amount: '10.00' }]);
      assert.match(
        crossCurrency,
        /openItem\.currencyMismatch/u,
        `a receipt settled a fee note in another currency: ${crossCurrency}`,
      );
      const stranger = await draftReceipt('10.00', { party: accountB });
      assert.equal(await issueReceipt(stranger, '10.00'), 'succeeded');
      const crossParty = await apply(stranger, [{ target, amount: '10.00' }]);
      assert.match(
        crossParty,
        /openItem\.counterpartyMismatch/u,
        `a receipt settled another counterparty's fee note: ${crossParty}`,
      );
      assert.equal((await stored('fee_note', target)).applied, '0.00');
      const { authored, bindings } = openItemAuthored({ payableReceipt: true });
      assert.notEqual(
        compileOpenItems(authored, bindings).status,
        'compiled',
        'a receivable fee note could be settled by a payable item',
      );
    },
  );

  await t.test(
    'one grant confirms one request, and a request needs a grant',
    async () => {
      const draft = await draftNote(['12.00']);
      const input = await issueInput(draft, '12.00');
      const viaGateway = (grant: string | null, idempotencyKey: string) =>
        outcome(
          runtime.entry.run(MANAGER, (view) =>
            runtime.operationGateway.invoke(
              view,
              {
                confirmationGrant: grant,
                idempotencyKey,
                input,
                operationId: ISSUE_NOTE,
                schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
              },
              runtime.operationMediation.issueInvocation(view, 'UI'),
            ),
          ),
        );
      const unconfirmed = await viaGateway(null, randomUUID());
      assert.notEqual(
        unconfirmed,
        'succeeded',
        'an issue ran without a confirmation',
      );
      const grant = await runtime.entry.run(MANAGER, (view) =>
        Promise.resolve(
          runtime.operationMediation.issueConfirmationGrant(
            view,
            ISSUE_NOTE,
            input,
          ),
        ),
      );
      assert.equal(await viaGateway(grant, randomUUID()), 'succeeded');
      const replay = await viaGateway(grant, randomUUID());
      assert.match(
        replay,
        /openItem\.approvalRequired/u,
        `one confirmation was consumed by a second request: ${replay}`,
      );
    },
  );

  await t.test(
    'a principal of company B is refused on company A records',
    async () => {
      const draft = await draftNote(['9.00']);
      const principal = await runtime.entry.run(MANAGER, (view) =>
        Promise.resolve(view.principalId),
      );
      const memberships = (
        await pool.query<{ id: string; company: string | null }>(
          `SELECT membership_id::text AS id, legal_entity_id::text AS company FROM platform.current_policy_memberships
          WHERE (tenant_id, environment_id, principal_id) = ($1,$2,$3) AND revoked_at IS NULL`,
          [tenant, environment, principal],
        )
      ).rows;
      await pool.query(
        `UPDATE platform.current_policy_memberships SET legal_entity_id = $4
        WHERE (tenant_id, environment_id, principal_id) = ($1,$2,$3) AND revoked_at IS NULL`,
        [tenant, environment, principal, companyB],
      );
      let scoped: string;
      try {
        scoped = await issueNote(draft, '9.00');
      } finally {
        for (const membership of memberships)
          await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id = $2 WHERE membership_id = $1',
            [membership.id, membership.company],
          );
      }
      assert.notEqual(
        scoped,
        'succeeded',
        'a company-B principal issued a company-A fee note',
      );
      assert.equal((await stored('fee_note', draft)).number, null);
      // A company-B receipt naming a company-A fee note.
      const target = await draftNote(['9.00']);
      assert.equal(await issueNote(target, '9.00'), 'succeeded');
      const foreign = await draftReceipt('9.00', { company: companyB });
      assert.equal(await issueReceipt(foreign, '9.00'), 'succeeded');
      const across = await apply(foreign, [{ target, amount: '9.00' }]);
      assert.match(
        across,
        /openItem\.companyMismatch/u,
        `a company-B receipt settled a company-A fee note: ${across}`,
      );
      assert.equal((await stored('fee_note', target)).applied, '0.00');
    },
  );

  // ---- OPEN-ITEM-1 s2: void, unapply, credit notes, named refusals ----
  const voidInput = async (kind: Kind, recordId: string) => ({
    recordId,
    expectedRevision: (await stored(kind, recordId)).revision,
    arguments: {},
  });
  const voidItem = async (kind: Kind, recordId: string) =>
    outcome(
      world.invoke(
        `custom_${kind}_action_void`,
        await voidInput(kind, recordId),
      ),
    );
  /** Apply with chosen application IDs (unapply names them later). */
  const applyLines = async (
    local: 'receipt' | 'credit_note',
    sourceId: string,
    lines: readonly { applicationId: string; target: string; amount: string }[],
  ) =>
    outcome(
      world.invoke(
        local === 'receipt'
          ? 'custom_receipt_application_create'
          : 'custom_credit_application_create',
        {
          recordId: sourceId,
          expectedRevision: (await stored(local, sourceId)).revision,
          arguments: { lines },
        },
      ),
    );
  const unapply = async (
    local: 'receipt' | 'credit_note',
    sourceId: string,
    applicationIds: readonly string[],
  ) =>
    outcome(
      world.invoke(
        local === 'receipt'
          ? 'custom_receipt_application_archive'
          : 'custom_credit_application_archive',
        {
          recordId: sourceId,
          expectedRevision: (await stored(local, sourceId)).revision,
          arguments: { applicationIds },
        },
      ),
    );
  /** A draft credit note with lines. */
  const draftCredit = async (amounts: readonly string[]) => {
    const result = await world.invoke('custom_credit_note_create', {
      recordId: randomUUID(),
      legalEntityId: COMPANY,
      values: {
        [credit('name')]: 'Returned service',
        [credit('currency')]: 'CAD',
      },
      relations: { [CREDIT_ACCOUNT]: accountA },
    });
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
    const creditId = result.readBack!.recordId;
    for (const amount of amounts) {
      const added = await world.invoke('custom_credit_note_lines_create', {
        recordId: randomUUID(),
        legalEntityId: COMPANY,
        values: {
          [creditLine('line_number')]: String(++lineNumber),
          [creditLine('item')]: 'Returned',
          [creditLine('amount')]: canonical(amount),
        },
        relations: { [CREDIT_LINES_PARENT]: creditId },
      });
      assert.equal(added.outcome, 'succeeded', JSON.stringify(added));
    }
    return creditId;
  };
  const issueCredit = async (creditId: string, total: string) =>
    outcome(
      world.invoke('custom_credit_note_action_issue', {
        recordId: creditId,
        expectedRevision: (await stored('credit_note', creditId)).revision,
        arguments: {
          total,
          lineSetDigest: openItemLineSetDigest(
            await liveLines(creditId, CREDIT_LINES, CREDIT_LINES_PARENT),
          ),
        },
      }),
    );
  const issuedNote = async (amount: string) => {
    const id = await draftNote([amount]);
    assert.equal(await issueNote(id, amount), 'succeeded');
    return id;
  };
  const issuedReceipt = async (amount: string) => {
    const id = await draftReceipt(amount);
    assert.equal(await issueReceipt(id, amount), 'succeeded');
    return id;
  };

  await t.test(
    'void: an open item with nothing applied is voided and keeps its number; an applied one is refused',
    async () => {
      const draft = await draftNote(['15.00']);
      assert.match(await voidItem('fee_note', draft), /openItem\.notOpen/u);
      assert.equal(await issueNote(draft, '15.00'), 'succeeded');
      const number = (await stored('fee_note', draft)).number;
      assert.equal(await voidItem('fee_note', draft), 'succeeded');
      const voided = await stored('fee_note', draft);
      assert.deepEqual(
        [voided.state, voided.number, voided.total, voided.applied],
        ['void', number, '15.00', '0.00'],
        'a voided fee note lost its number or its figures',
      );
      assert.equal(
        voided.balance,
        '0.00',
        'a voided fee note still owes its balance',
      );
      assert.match(await voidItem('fee_note', draft), /openItem\.notOpen/u);
      const money = await issuedReceipt('5.00');
      const onVoid = await apply(money, [{ target: draft, amount: '5.00' }]);
      assert.match(
        onVoid,
        /openItem\.targetNotOpen/u,
        `a receipt was applied to a void fee note: ${onVoid}`,
      );
      const paid = await issuedNote('20.00');
      assert.equal(
        await apply(money, [{ target: paid, amount: '5.00' }]),
        'succeeded',
      );
      const appliedVoid = await voidItem('fee_note', paid);
      assert.match(
        appliedVoid,
        /openItem\.notOpen/u,
        `a fee note with an applied amount was voided: ${appliedVoid}`,
      );
      const spentVoid = await voidItem('receipt', money);
      assert.match(
        spentVoid,
        /openItem\.notOpen/u,
        `a receipt with an applied amount was voided: ${spentVoid}`,
      );
      const after = await stored('fee_note', paid);
      assert.deepEqual(
        [after.state, after.applied],
        ['partially_settled', '5.00'],
      );
    },
  );

  await t.test(
    'void racing apply: exactly one succeeds, never a void item with applied != 0',
    async () => {
      for (let round = 0; round < 3; round += 1) {
        const target = await issuedNote('10.00');
        const money = await issuedReceipt('10.00');
        const [voiding, applying] = await Promise.all([
          voidInput('fee_note', target),
          applyInput(money, [{ target, amount: '10.00' }]),
        ]);
        const results = await Promise.all([
          outcome(world.invoke('custom_fee_note_action_void', voiding)),
          outcome(world.invoke('custom_receipt_application_create', applying)),
        ]);
        assert.equal(
          results.filter((result) => result === 'succeeded').length,
          1,
          `void and apply both ran or both refused: ${results.join(' | ')}`,
        );
        const item = await stored('fee_note', target);
        const live = await appliedSum(APPLICATION_TARGET, target);
        assert.ok(
          item.state !== 'void' || (item.applied === '0.00' && live === '0.00'),
          `a void fee note carries an applied amount: ${JSON.stringify(item)} live ${live}`,
        );
        assert.equal(live, item.applied);
      }
    },
  );

  await t.test(
    'unapply returns the amounts to both ends; a line is unapplied once, by its own source',
    async () => {
      const target = await issuedNote('100.00');
      const money = await issuedReceipt('60.00');
      const first = randomUUID();
      const second = randomUUID();
      assert.equal(
        await applyLines('receipt', money, [
          { applicationId: first, target, amount: '40.00' },
        ]),
        'succeeded',
      );
      assert.equal(
        await applyLines('receipt', money, [
          { applicationId: second, target, amount: '20.00' },
        ]),
        'succeeded',
      );
      assert.equal(await unapply('receipt', money, [first]), 'succeeded');
      const note1 = await stored('fee_note', target);
      assert.deepEqual(
        [note1.applied, note1.balance, note1.state],
        ['20.00', '80.00', 'partially_settled'],
        'an unapply did not return the amount to the target',
      );
      const receipt1 = await stored('receipt', money);
      assert.deepEqual(
        [receipt1.applied, receipt1.balance, receipt1.state],
        ['20.00', '40.00', 'partially_settled'],
        'an unapply did not return the amount to the source',
      );
      assert.equal(await appliedSum(APPLICATION_TARGET, target), '20.00');
      assert.equal(await appliedSum(APPLICATION_SOURCE, money), '20.00');
      const twice = await unapply('receipt', money, [first]);
      assert.notEqual(twice, 'succeeded', 'one line was unapplied twice');
      assert.equal((await stored('fee_note', target)).applied, '20.00');
      // Another source's line cannot be unapplied through this one.
      const other = await issuedReceipt('5.00');
      const foreignLine = randomUUID();
      assert.equal(
        await applyLines('receipt', other, [
          { applicationId: foreignLine, target, amount: '5.00' },
        ]),
        'succeeded',
      );
      const foreign = await unapply('receipt', money, [foreignLine]);
      assert.match(
        foreign,
        /openItem\.applicationMismatch/u,
        `a source unapplied another source's line: ${foreign}`,
      );
      assert.equal(await unapply('receipt', other, [foreignLine]), 'succeeded');
      assert.equal(await unapply('receipt', money, [second]), 'succeeded');
      const cleared = await stored('fee_note', target);
      assert.deepEqual(
        [cleared.applied, cleared.balance, cleared.state],
        ['0.00', '100.00', 'open'],
        'a fully unapplied fee note did not return to open',
      );
      assert.deepEqual(
        [
          (await stored('receipt', money)).state,
          (await stored('receipt', money)).balance,
        ],
        ['open', '60.00'],
      );
      // Nothing applied any more, so it may be voided now.
      assert.equal(await voidItem('fee_note', target), 'succeeded');
    },
  );

  await t.test(
    'a credit note, its own document and series, settles a fee note beside a receipt',
    async () => {
      const target = await issuedNote('100.00');
      const money = await issuedReceipt('30.00');
      assert.equal(
        await apply(money, [{ target, amount: '30.00' }]),
        'succeeded',
      );
      const note1 = await draftCredit(['20.00', '30.00']);
      assert.equal((await stored('credit_note', note1)).number, null);
      assert.equal(await issueCredit(note1, '50.00'), 'succeeded');
      const issued = await stored('credit_note', note1);
      assert.deepEqual(
        [issued.number, issued.total, issued.balance, issued.state],
        ['CN-000001', '50.00', '50.00', 'open'],
        'a credit note is not numbered in its own series',
      );
      const line1 = randomUUID();
      const credit1 = await applyLines('credit_note', note1, [
        { applicationId: line1, target, amount: '50.00' },
      ]);
      assert.equal(
        credit1,
        'succeeded',
        `a credit note could not settle a fee note a receipt part-settled: ${credit1}`,
      );
      const after = await stored('fee_note', target);
      assert.deepEqual(
        [after.applied, after.balance, after.state],
        ['80.00', '20.00', 'partially_settled'],
        "a fee note's applied is not the sum across both application types",
      );
      assert.equal(await appliedSum(APPLICATION_TARGET, target), '30.00');
      assert.equal(await creditSum(CREDIT_TARGET, target), '50.00');
      const spent = await stored('credit_note', note1);
      assert.deepEqual(
        [spent.applied, spent.balance, spent.state],
        ['50.00', '0.00', 'settled'],
      );
      // The receipt's and the credit note's amounts share one balance.
      const note2 = await draftCredit(['30.00']);
      assert.equal(await issueCredit(note2, '30.00'), 'succeeded');
      const over = await applyLines('credit_note', note2, [
        { applicationId: randomUUID(), target, amount: '30.00' },
      ]);
      assert.match(
        over,
        /openItem\.exceedsBalance/u,
        `a credit note over-applied a fee note a receipt part-settled: ${over}`,
      );
      assert.equal(await unapply('credit_note', note1, [line1]), 'succeeded');
      const back = await stored('fee_note', target);
      assert.deepEqual(
        [back.applied, back.balance, back.state],
        ['30.00', '70.00', 'partially_settled'],
      );
      assert.equal(await creditSum(CREDIT_TARGET, target), '0.00');
      assert.deepEqual(
        [
          (await stored('credit_note', note1)).state,
          (await stored('credit_note', note1)).balance,
        ],
        ['open', '50.00'],
        'a fully unapplied credit note did not return to open',
      );
    },
  );

  await t.test(
    'named refusals: currency missing, policy changed, isolation, direction mismatch',
    async () => {
      // Two stored items with no currency are not one currency: absent
      // never equals absent.
      const target = await issuedNote('10.00');
      const blank = await issuedReceipt('10.00');
      for (const [entity, fieldId, recordId] of [
        [RECEIPT, receipt('currency'), blank],
        [NOTE, note('currency'), target],
      ] as const) {
        const p = physical(entity);
        await pool.query(
          `UPDATE ${p.table} SET ${p.column(fieldId)} = ''
            WHERE (tenant_id, environment_id, record_id) = ($1,$2,$3)`,
          [tenant, environment, recordId],
        );
      }
      const noCurrency = await apply(blank, [{ target, amount: '10.00' }]);
      assert.match(
        noCurrency,
        /openItem\.currencyMissing/u,
        `a receipt with no stored currency was applied: ${noCurrency}`,
      );
      assert.equal((await stored('fee_note', target)).applied, '0.00');
      // The policy moves after the gateway decided: the write refuses.
      const draft = await draftNote(['4.00']);
      await pool.query(`CREATE FUNCTION public.open_item_test_policy_moves() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN
          UPDATE platform.current_policy_epochs SET policy_version = policy_version + 1
           WHERE (tenant_id, environment_id) = (NEW.tenant_id, NEW.environment_id);
          RETURN NULL; END $$`);
      await pool.query(`CREATE TRIGGER open_item_test_policy_moves
        AFTER INSERT ON platform.open_item_approval_grants
        FOR EACH ROW EXECUTE FUNCTION public.open_item_test_policy_moves()`);
      let moved: string;
      try {
        moved = await issueNote(draft, '4.00');
      } finally {
        await pool.query(
          'DROP TRIGGER open_item_test_policy_moves ON platform.open_item_approval_grants',
        );
        await pool.query('DROP FUNCTION public.open_item_test_policy_moves()');
      }
      assert.match(
        moved,
        /openItem\.policyChanged/u,
        `an issue ran under a policy that moved after the decision: ${moved}`,
      );
      assert.equal((await stored('fee_note', draft)).number, null);
      assert.equal(await issueNote(draft, '4.00'), 'succeeded');
      // The line freeze holds only under READ COMMITTED.
      const client = await pool.connect();
      let isolation: string;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        isolation = await client
          .query(
            'SELECT platform.open_item_consume_grant($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
            [
              randomUUID(),
              'northstar.openitem:capability.open_item_issue',
              randomUUID(),
              1,
              ISSUE_NOTE,
              randomUUID(),
              '{}',
              'UI',
            ],
          )
          .then(
            () => 'consumed',
            (error: Error) => error.message,
          );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      assert.match(
        isolation,
        /openItem\.isolationUnsupported/u,
        `a grant was consumed outside READ COMMITTED: ${isolation}`,
      );
      // A binding whose ends differ in direction refuses before any read
      // (the binder never compiles one; the executor holds it too).
      const definition = await runtime.entry.run(MANAGER, (view) =>
        Promise.resolve(
          parsePinnedOperationCatalog(view.projections.operation.payload).find(
            (entry) => entry.operationId === APPLY,
          )!,
        ),
      );
      const binding = (
        definition as { readonly openItem?: OpenItemOperationBinding }
      ).openItem!;
      assert.equal(binding.bindingVersion, 'openItem.apply/v1');
      if (binding.bindingVersion !== 'openItem.apply/v1') return;
      const applyFactory = OPEN_ITEM_CAPABILITY_EXECUTOR_FACTORIES.find(
        (factory) => factory.capabilityId === OPEN_ITEM_APPLY_CAPABILITY,
      )!;
      const executor = applyFactory.create({
        projection: () => ({
          payload: {
            kind: 'storageTargetPayload',
            entities: [],
            relations: [],
          },
        }),
      } as unknown as PostgresCapabilityOperationExecutorContext);
      const crossed = await executor
        .prepareAuthorization({
          definition: {
            ...definition,
            openItem: {
              ...binding,
              target: { ...binding.target, direction: 'payable' },
            },
          },
          input: {
            recordId: randomUUID(),
            expectedRevision: 1,
            arguments: {
              lines: [
                {
                  applicationId: randomUUID(),
                  target: randomUUID(),
                  amount: '1',
                },
              ],
            },
          },
          readBackDefinition: {
            queryType: 'get',
            sourceEntityId: APPLICATION,
            legalEntityScope: {
              cardinality: 'exactlyOne',
              operand: { parameterId: `${NS}parameter.scope` },
            },
          },
        } as unknown as RegisteredCapabilityOperationAuthorizationRequest)
        .then(
          () => 'authorized',
          (error: Error) => error.message,
        );
      assert.equal(
        crossed,
        'openItem.directionMismatch',
        'a receivable item could be settled by a payable item at run time',
      );
    },
  );

  await t.test('compile refusals name their reason', () => {
    const reasons = (options: Parameters<typeof openItemAuthored>[0]) => {
      const { authored, bindings } = openItemAuthored(options);
      const compiled = compileOpenItems(authored, bindings);
      return compiled.status === 'compiled'
        ? 'compiled'
        : JSON.stringify(compiled.diagnostics);
    };
    assert.match(
      reasons({ requiredApplicationLink: true }),
      /every other link is optional/u,
      'a required link the core never writes compiled on an application type',
    );
    assert.match(
      reasons({ requiredApplicationName: true }),
      /every other field is optional/u,
      'a required field the core never writes compiled on an application type',
    );
    assert.match(
      reasons({ genericIssue: true }),
      /Only the open-item core moves/u,
    );
    assert.match(
      reasons({ payableReceipt: true }),
      /stays within one direction/u,
    );
  });
}

interface StoragePlan {
  readonly entities: readonly {
    readonly entityId: string;
    readonly physicalTableName: string;
    readonly columns: readonly {
      readonly canonicalFieldId: string;
      readonly physicalName: string;
    }[];
  }[];
  readonly relations: readonly {
    readonly relationId: string;
    readonly relationColumn: { readonly physicalName: string };
  }[];
}
