import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';

test(
  'document numbers are assigned by the server: sequential, concurrent-safe, retry-stable, never typed, never reused',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const target = await governedStorageTarget();
      const order = target.entities.find(
        (value) => value.entityId === `${ns}:entity.sales_order`,
      )!;
      const numberColumn = fulfillmentColumn(order, 'sales_order_number');
      const invoke = (
        operation: string,
        input: ImmutableJsonValue,
        key = randomUUID(),
      ) =>
        fixture.app.runtime.entry.run({ headers: {} }, (view) => {
          const operationId = `${ns}:operation.${operation}`;
          const definition = parsePinnedOperationCatalog(
            view.projections.operation.payload,
          ).find((value) => value.operationId === operationId)!;
          return fixture.app.runtime.operationGateway.invoke(
            view,
            {
              schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
              operationId,
              input,
              idempotencyKey: key,
              confirmationGrant:
                definition.confirmation === 'humanRequired'
                  ? fixture.app.runtime.operationMediation.issueConfirmationGrant(
                      view,
                      operationId,
                      input,
                    )
                  : null,
            },
            fixture.app.runtime.operationMediation.issueInvocation(view, 'UI'),
          );
        });
      const orderInput = (
        legalEntityId: string = fixture.scope,
        extra: Record<string, ImmutableJsonValue> = {},
      ) => ({
        recordId: randomUUID(),
        legalEntityId,
        values: {
          [`${ns}:field.sales_order_customer_party_id`]: fixture.customer,
          [`${ns}:field.sales_order_order_date`]: new Date().toISOString(),
          [`${ns}:field.sales_order_currency`]: 'CAD',
          ...extra,
        },
        relations: {},
      });
      const numberOf = (result: Awaited<ReturnType<typeof invoke>>) =>
        result.readBack?.values[`${ns}:field.sales_order_number`];
      const allNumbers = async () =>
        (
          await fixture.pool.query<{ number: string }>(
            `SELECT "${numberColumn}" AS number FROM ${fulfillmentTable(order)}
              WHERE tenant_id = $1 AND environment_id = $2 ORDER BY 1`,
            [
              fixture.app.runtime.identity.tenantId,
              fixture.app.runtime.identity.environmentId,
            ],
          )
        ).rows.map((row) => row.number);
      // Release verification arranged its own archived orders at activation;
      // they carry `V-` sentinels and never take a real number.
      // Asserted first so a verification that consumed real numbers fails by
      // this message rather than by the absence of its sentinels.
      assert.deepEqual(
        (await allNumbers()).filter((number) => !number.startsWith('V-')),
        [],
        'release verification must not consume real document numbers',
      );
      assert.ok(
        (await allNumbers()).some((number) => number.startsWith('V-')),
        'release verification arranged sentinel-numbered orders',
      );
      const storedNumbers = async () =>
        (await allNumbers()).filter((number) => !number.startsWith('V-'));

      // The published contract: no writable number, one assignment.
      const contract = await fixture.app.runtime.entry.run(
        { headers: {} },
        (view) =>
          Promise.resolve(
            parsePinnedOperationCatalog(view.projections.operation.payload),
          ),
      );
      for (const [operation, prefix] of [
        ['sales_order_create', 'SO'],
        ['purchase_order_create', 'PO'],
        ['shipment_create', 'SHP'],
      ] as const) {
        const inputContract = contract.find(
          (value) => value.operationId === `${ns}:operation.${operation}`,
        )!.inputContract!;
        const field = `${ns}:field.${operation.replace(/_create$/u, '')}_number`;
        assert.ok(!inputContract.writableFieldIds.includes(field));
        assert.deepEqual(
          inputContract.assignedFields?.map((entry) => [
            entry.fieldId,
            entry.prefix,
            entry.minimumDigits,
          ]),
          [[field, prefix, 6]],
        );
      }
      const update = contract.find(
        (value) => value.operationId === `${ns}:operation.sales_order_update`,
      )!.inputContract!;
      assert.ok(
        !update.writableFieldIds.includes(`${ns}:field.sales_order_number`),
      );

      // Sequential from SO-000001.
      const first = await invoke('sales_order_create', orderInput());
      const second = await invoke('sales_order_create', orderInput());
      assert.equal(numberOf(first), 'SO-000001');
      assert.equal(numberOf(second), 'SO-000002');

      // The change document records the assigned number.
      const documents = await fixture.pool.query<{ changes: string }>(
        `SELECT changes::text AS changes FROM platform.trust_business_change_documents
          WHERE record_id = $1`,
        [first.readBack!.recordId],
      );
      assert.equal(documents.rows.length, 1);
      assert.match(documents.rows[0]!.changes, /SO-000001/u);

      // A typed number is refused and writes nothing.
      const before = await storedNumbers();
      await assert.rejects(
        invoke(
          'sales_order_create',
          orderInput(fixture.scope, {
            [`${ns}:field.sales_order_number`]: 'SO-999999',
          }),
        ),
      );
      assert.deepEqual(await storedNumbers(), before);
      // An update cannot change an assigned number.
      await assert.rejects(
        invoke('sales_order_update', {
          recordId: first.readBack!.recordId,
          expectedRevision: first.readBack!.revision,
          patch: { [`${ns}:field.sales_order_number`]: 'SO-000777' },
        }),
      );
      assert.deepEqual(await storedNumbers(), before);

      // A retry of the same request keeps its record and number.
      const key = randomUUID();
      const retried = orderInput();
      const once = await invoke('sales_order_create', retried, key);
      const again = await invoke('sales_order_create', retried, key);
      assert.equal(numberOf(once), 'SO-000003');
      assert.equal(numberOf(again), 'SO-000003');
      assert.equal(again.readBack?.recordId, once.readBack?.recordId);
      assert.equal((await storedNumbers()).length, 3);

      // Concurrent creates serialize: ten distinct, consecutive numbers.
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () =>
          invoke('sales_order_create', orderInput()),
        ),
      );
      assert.deepEqual(
        concurrent.map((result) => String(numberOf(result))).sort(),
        Array.from(
          { length: 10 },
          (_, index) => `SO-${String(index + 4).padStart(6, '0')}`,
        ),
      );

      // Archiving keeps the number reserved: the next is never reused.
      const archived = await invoke('sales_order_archive', {
        recordId: second.readBack!.recordId,
        expectedRevision: second.readBack!.revision,
      });
      assert.equal(archived.outcome, 'succeeded');
      const afterArchive = await invoke('sales_order_create', orderInput());
      assert.equal(numberOf(afterArchive), 'SO-000014');

      // One tenant sequence across companies.
      const company = await fixture.measure('second_company');
      const otherCompany = await invoke(
        'sales_order_create',
        orderInput(String((company as { companyId: string }).companyId)),
      );
      assert.equal(numberOf(otherCompany), 'SO-000015');
      const numbers = await storedNumbers();
      assert.equal(new Set(numbers).size, numbers.length);
      assert.equal(numbers.length, 15);

      // A different document type has its own sequence.
      const purchase = await invoke('purchase_order_create', {
        recordId: randomUUID(),
        legalEntityId: fixture.scope,
        values: {
          [`${ns}:field.purchase_order_supplier_party_id`]: fixture.customer,
          [`${ns}:field.purchase_order_order_date`]: new Date().toISOString(),
          [`${ns}:field.purchase_order_currency`]: 'CAD',
        },
        relations: {},
      });
      assert.equal(
        purchase.readBack?.values[`${ns}:field.purchase_order_number`],
        'PO-000001',
      );
    });
  },
);
