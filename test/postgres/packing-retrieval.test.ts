import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type pg from 'pg';

import { startComposedApplication } from '../../apps/api/src/composition-root.js';
import { loadShipmentPackingDocument } from '../../apps/web/src/sales-section.js';
import {
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentOption,
  fulfillmentRelation,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const ns = 'northstar.app';
const legalEntityId = '74000000-0000-4000-8000-000000000001';
const itemId = 'ITEM-PACK-001';
const locationId = 'LOC-PACK-001';
const unitId = 'EA';

/**
 * F3, second correction. The packing document used a display-number substring
 * search, paged the broader matching set, then filtered by exact parent id.
 * `LIMIT/OFFSET` positions are only meaningful within one snapshot, and every
 * page is its own transaction, so when an UNRELATED matching row left the set
 * between pages the offset slid over a committed target line and the document
 * rendered without it, and without a diagnostic.
 *
 * The correction restricts the list to the exact shipment parent through the
 * registered shared-list `parentScope`, applied before the count and the page
 * window. This vertical demonstrates the original loss, the corrected
 * retrieval, complete multi-page retrieval, cursor identity, and the parent
 * guard that makes the posted target's own membership stable in the first
 * place -- the last one because exact parent filtering would not be enough if
 * the target's lines could be archived underneath the paging.
 */
test('packing retrieval is exactly parent scoped and its posted target is immutable', async () => {
  await withEphemeralPostgres(
    'packing-retrieval',
    async ({ connection, pool }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        tenantSlug: 'packing-retrieval',
      });
      try {
        await scenario(application, pool);
      } finally {
        await application.close();
      }
    },
  );
});

type Application = Awaited<ReturnType<typeof startComposedApplication>>;

async function scenario(
  application: Application,
  pool: pg.Pool,
): Promise<void> {
  const runtime = application.runtime;
  const target = await governedStorageTarget();
  const binding = fulfillmentBinding(target)!;
  const identity = runtime.identity;
  const seed = new Seeder(pool, binding, identity);

  // One order line and one reservation carry every shipment line below; the
  // retrieval semantics under test do not depend on how many of them there are.
  const orderId = await seed.order('SO-PACK-1');
  const orderLineId = await seed.orderLine(orderId);
  const reservationId = await seed.reservation(orderLineId);

  // The reviewer's ordering: the default list order is record_id ASC, so A
  // sorts first, the unrelated draft lines sit between, and B sorts last. That
  // is what puts B beyond the first page of the OLD broader query.
  const lineA = '10000000-0000-4000-8000-000000000001';
  const lineB = '99000000-0000-4000-8000-000000000001';
  const packed = await seed.shipment('PACK-1', 'posted', orderId);
  await seed.line(packed, orderLineId, reservationId, 1, lineA);
  await seed.line(packed, orderLineId, reservationId, 2, lineB);

  // An unrelated shipment whose number CONTAINS the target's, which is exactly
  // what made a substring search page a broader set.
  // 100 seeded, one of which the parent-guard arm below archives, leaving the
  // reviewer's 99 ACTIVE unrelated draft lines at the moment of retrieval:
  // A + 99 drafts exactly fills the first page and pushes B onto the second.
  const draft = await seed.shipment('PACK-1-DRAFT', 'draft', orderId);
  const draftLines: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const recordId = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    draftLines.push(recordId);
    await seed.line(draft, orderLineId, reservationId, index + 1, recordId);
  }

  const invoke = (
    operationId: string,
    input: Readonly<Record<string, unknown>>,
    confirmed = false,
  ) =>
    runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: confirmed
            ? runtime.operationMediation.issueConfirmationGrant(
                view,
                operationId,
                input as ImmutableJsonValue,
              )
            : null,
          idempotencyKey: randomUUID(),
          input,
          operationId,
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );

  await assertParentGuardHoldsForPostedShipments(
    invoke,
    pool,
    binding,
    identity,
    draftLines[0]!,
    lineB,
  );

  await assertInterleavedArchiveKeepsEveryCommittedLine(
    application,
    invoke,
    packed,
    draftLines[1]!,
  );

  await assertMultiPageTargetRetrievesCompletely(
    application,
    seed,
    orderId,
    orderLineId,
    reservationId,
  );

  await assertCursorIsBoundToItsParent(application, packed, draft);
  await assertParentScopeMustNameARelationOfTheQueriedEntity(
    application,
    packed,
  );
}

/**
 * TARGET-SET STABILITY, OBSERVED RATHER THAN ASSUMED.
 *
 * `shipment_line` declares no local precondition, which by itself proves
 * nothing. The guard is derived: `parentGuardsFromCatalog` lifts a guard from
 * every active parent `updateRecordEffect`, `shipment_update` carries
 * `shipment_state == draft`, `shipment_line_shipment` is `parentScopedChild`,
 * and `requireExistingParentGuards` -> `requireRelationTarget` evaluates that
 * precondition against the parent's persisted values under `FOR SHARE`.
 *
 * The admission twin matters: archiving a line under a DRAFT parent must
 * succeed, otherwise the refusal below would be satisfiable by a line that
 * could never be archived at all. Both arms carry the confirmation grant that
 * `archive` declares, so neither refusal can be a missing grant.
 */
async function assertParentGuardHoldsForPostedShipments(
  invoke: (
    operationId: string,
    input: Readonly<Record<string, unknown>>,
    confirmed?: boolean,
  ) => Promise<unknown>,
  pool: pg.Pool,
  binding: NonNullable<ReturnType<typeof fulfillmentBinding>>,
  identity: { tenantId: string; environmentId: string },
  draftLineId: string,
  postedLineId: string,
): Promise<void> {
  await invoke(
    `${ns}:operation.shipment_line_archive`,
    { expectedRevision: 1, recordId: draftLineId },
    true,
  );
  const archivedDraft = await readLine(pool, binding, identity, draftLineId);
  assert.notEqual(
    archivedDraft.archived_at,
    null,
    'a line under a draft shipment archives, so the posted refusal is about state',
  );

  const before = await readLine(pool, binding, identity, postedLineId);
  await assert.rejects(
    invoke(
      `${ns}:operation.shipment_line_archive`,
      { expectedRevision: 1, recordId: postedLineId },
      true,
    ),
    (error: unknown) => {
      assert.match(
        String((error as { code?: string }).code ?? String(error)),
        /MODULE_OPERATION_PRECONDITION_REFUSED|PRECONDITION/u,
        'the posted parent refuses its line archive by precondition',
      );
      return true;
    },
  );
  assert.deepEqual(
    await readLine(pool, binding, identity, postedLineId),
    before,
    'the refused archive left the posted line untouched',
  );
}

/** The original defect, and the corrected retrieval, in one deterministic run. */
async function assertInterleavedArchiveKeepsEveryCommittedLine(
  application: Application,
  invoke: (
    operationId: string,
    input: Readonly<Record<string, unknown>>,
    confirmed?: boolean,
  ) => Promise<unknown>,
  shipmentId: string,
  unrelatedDraftLineId: string,
): Promise<void> {
  const runtime = application.runtime;
  let firstPage = true;
  const document = await runtime.entry.run(
    { headers: { authorization: 'local' } },
    async (view) => {
      const shipment = await readShipmentDto(application, view, shipmentId);
      // Deterministic interleaving: the unrelated draft line is archived after
      // the first page has been read and before the next query runs. No sleep,
      // no retry -- the seam is the gateway call itself.
      const gateway = {
        invoke: async (
          ...args: Parameters<typeof runtime.queryGateway.invoke>
        ) => {
          const result = await runtime.queryGateway.invoke(...args);
          if (firstPage) {
            firstPage = false;
            await invoke(
              `${ns}:operation.shipment_line_archive`,
              { expectedRevision: 1, recordId: unrelatedDraftLineId },
              true,
            );
          }
          return result;
        },
      } as unknown as typeof runtime.queryGateway;
      return loadShipmentPackingDocument(
        view,
        gateway,
        shipment,
        legalEntityId,
      );
    },
  );
  assert.ok(document, 'a posted shipment renders a packing document');
  assert.deepEqual(
    document.lines.map((line) => line.lineNumber).toSorted(),
    ['1', '2'],
    'both committed lines survive an unrelated archive between pages',
  );
}

/** Exact retrieval must still span pages when the target itself is large. */
async function assertMultiPageTargetRetrievesCompletely(
  application: Application,
  seed: Seeder,
  orderId: string,
  orderLineId: string,
  reservationId: string,
): Promise<void> {
  const wide = await seed.shipment('PACK-WIDE', 'posted', orderId);
  const total = 150;
  for (let index = 0; index < total; index += 1) {
    await seed.line(
      wide,
      orderLineId,
      reservationId,
      index + 1,
      `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
  }
  const runtime = application.runtime;
  const document = await runtime.entry.run(
    { headers: { authorization: 'local' } },
    async (view) =>
      loadShipmentPackingDocument(
        view,
        runtime.queryGateway,
        await readShipmentDto(application, view, wide),
        legalEntityId,
      ),
  );
  assert.ok(document);
  assert.equal(
    document.lines.length,
    total,
    'a target spanning more than one page is retrieved completely',
  );
  assert.equal(
    new Set(document.lines.map((line) => line.lineNumber)).size,
    total,
    'every line appears exactly once across the pages',
  );
}

/** A page window for one parent must not decode against another. */
async function assertCursorIsBoundToItsParent(
  application: Application,
  parentA: string,
  parentB: string,
): Promise<void> {
  const runtime = application.runtime;
  await runtime.entry.run(
    { headers: { authorization: 'local' } },
    async (view) => {
      const page = await listLines(runtime, view, parentA, null, 1);
      const cursor = page.listCoverage?.nextCursor;
      assert.ok(cursor, 'the first page of a two-line parent has a successor');
      await assert.rejects(
        listLines(runtime, view, parentB, cursor, 1),
        'a cursor minted for one parent is refused for another',
      );
    },
  );
}

/** The operand is resolved against the compiled relation, never trusted. */
async function assertParentScopeMustNameARelationOfTheQueriedEntity(
  application: Application,
  shipmentId: string,
): Promise<void> {
  const runtime = application.runtime;
  await runtime.entry.run(
    { headers: { authorization: 'local' } },
    async (view) => {
      await assert.rejects(
        listLines(
          runtime,
          view,
          shipmentId,
          null,
          10,
          `${ns}:relation.shipment_order`,
        ),
        'a relation of another entity cannot scope this list',
      );
    },
  );
}

function listLines(
  runtime: Application['runtime'],
  view: Parameters<Application['runtime']['queryGateway']['invoke']>[0],
  parentRecordId: string,
  cursor: string | null,
  pageSize: number,
  relationId = `${ns}:relation.shipment_line_shipment`,
) {
  return runtime.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: `${ns}:query.shipment_line_list`,
    arguments: {
      includeArchived: false,
      [`${ns}:parameter.shipment_line_list_legal_entity_scope`]: legalEntityId,
      list: {
        schemaVersion: 'northstar.shared-list-query/v1',
        cursor,
        matchMode: 'substring',
        pageSize,
        parentScope: { recordId: parentRecordId, relationId },
        search: '',
        sort: [],
        relationLabels: [],
      },
    },
  } as never) as Promise<{
    listCoverage?: { nextCursor: string | null };
  }>;
}

async function readShipmentDto(
  application: Application,
  view: Parameters<Application['runtime']['queryGateway']['invoke']>[0],
  shipmentId: string,
) {
  const result = (await application.runtime.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: `${ns}:query.shipment_get`,
    arguments: {
      recordId: shipmentId,
      [`${ns}:parameter.shipment_get_legal_entity_scope`]: legalEntityId,
    },
  } as never)) as { records: readonly unknown[] };
  const record = result.records[0];
  assert.ok(record, 'the seeded shipment reads back');
  return record as Parameters<typeof loadShipmentPackingDocument>[2];
}

async function readLine(
  pool: pg.Pool,
  binding: NonNullable<ReturnType<typeof fulfillmentBinding>>,
  identity: { tenantId: string; environmentId: string },
  recordId: string,
): Promise<Record<string, unknown>> {
  const line = binding.shipmentLine;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT revision, archived_at,
            ${q(fulfillmentColumn(line, 'shipment_line_quantity'))} AS quantity
       FROM ${fulfillmentTable(line)}
      WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
    [identity.tenantId, identity.environmentId, recordId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

/** Direct seeding: this vertical is about retrieval, not about how rows arrive. */
class Seeder {
  constructor(
    private readonly pool: pg.Pool,
    private readonly binding: NonNullable<
      ReturnType<typeof fulfillmentBinding>
    >,
    private readonly identity: { tenantId: string; environmentId: string },
  ) {}

  private get scope(): readonly [string, string, string] {
    return [this.identity.tenantId, this.identity.environmentId, legalEntityId];
  }

  async order(number: string): Promise<string> {
    const order = this.binding.order;
    const recordId = randomUUID();
    await this.pool.query(
      `INSERT INTO ${fulfillmentTable(order)}
         (tenant_id,environment_id,${q(order.legalEntity!.column)},record_id,revision,archived_at,
          ${q(fulfillmentColumn(order, 'sales_order_number'))},
          ${q(fulfillmentColumn(order, 'sales_order_customer_party_id'))},
          ${q(fulfillmentColumn(order, 'sales_order_order_date'))},
          ${q(fulfillmentColumn(order, 'sales_order_currency'))},
          ${q(fulfillmentColumn(order, 'derived_state_field.machine.sales_order_lifecycle'))})
       VALUES ($1,$2,$3,$4,1,NULL,$5,'CUST-PACK-001',$6,'CAD',$7)`,
      [
        ...this.scope,
        recordId,
        number,
        new Date().toISOString(),
        `${ns}:state.sales_order_released`,
      ],
    );
    return recordId;
  }

  async orderLine(orderId: string): Promise<string> {
    const line = this.binding.orderLine;
    const recordId = randomUUID();
    await this.pool.query(
      `INSERT INTO ${fulfillmentTable(line)}
         (tenant_id,environment_id,${q(line.legalEntity!.column)},record_id,revision,archived_at,
          ${q(fulfillmentColumn(line, 'sales_order_line_line_number'))},
          ${q(fulfillmentColumn(line, 'sales_order_line_item_id'))},
          ${q(fulfillmentColumn(line, 'sales_order_line_unit_id'))},
          ${q(fulfillmentColumn(line, 'sales_order_line_ordered_quantity'))},
          ${q(fulfillmentRelation(this.binding, line, 'sales_order_line_order'))})
       VALUES ($1,$2,$3,$4,1,NULL,1,$5,$6,'1000',$7)`,
      [...this.scope, recordId, itemId, unitId, orderId],
    );
    return recordId;
  }

  async reservation(orderLineId: string): Promise<string> {
    const reservation = this.binding.reservation;
    const recordId = randomUUID();
    await this.pool.query(
      `INSERT INTO ${fulfillmentTable(reservation)}
         (tenant_id,environment_id,${q(reservation.legalEntity!.column)},record_id,revision,archived_at,
          ${q(fulfillmentColumn(reservation, 'reservation_number'))},
          ${q(fulfillmentColumn(reservation, 'reservation_state'))},
          ${q(fulfillmentColumn(reservation, 'reservation_item_id'))},
          ${q(fulfillmentColumn(reservation, 'reservation_location_id'))},
          ${q(fulfillmentColumn(reservation, 'reservation_quantity'))},
          ${q(fulfillmentColumn(reservation, 'reservation_unit_id'))},
          ${q(fulfillmentRelation(this.binding, reservation, 'reservation_order_line'))})
       VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7,$8,'1000',$9,$10)`,
      [
        ...this.scope,
        recordId,
        `RES-${randomUUID().slice(0, 8)}`,
        fulfillmentOption(reservation, 'reservation_state', 'active'),
        itemId,
        locationId,
        unitId,
        orderLineId,
      ],
    );
    return recordId;
  }

  async shipment(
    number: string,
    state: 'draft' | 'posted',
    orderId: string,
  ): Promise<string> {
    const shipment = this.binding.shipment;
    const recordId = randomUUID();
    await this.pool.query(
      `INSERT INTO ${fulfillmentTable(shipment)}
         (tenant_id,environment_id,${q(shipment.legalEntity!.column)},record_id,revision,archived_at,
          ${q(fulfillmentColumn(shipment, 'shipment_number'))},
          ${q(fulfillmentColumn(shipment, 'shipment_state'))},
          ${q(fulfillmentColumn(shipment, 'shipment_kind'))},
          ${q(fulfillmentColumn(shipment, 'shipment_effective_at'))},
          ${q(fulfillmentColumn(shipment, 'shipment_location_id'))},
          ${q(fulfillmentColumn(shipment, 'shipment_reason_code'))},
          ${q(fulfillmentRelation(this.binding, shipment, 'shipment_order'))})
       VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7,$8,$9,'packing-retrieval',$10)`,
      [
        ...this.scope,
        recordId,
        number,
        fulfillmentOption(shipment, 'shipment_state', state),
        fulfillmentOption(shipment, 'shipment_kind', 'initial'),
        new Date().toISOString(),
        locationId,
        orderId,
      ],
    );
    return recordId;
  }

  async line(
    shipmentId: string,
    orderLineId: string,
    reservationId: string,
    lineNumber: number,
    recordId: string,
  ): Promise<void> {
    const line = this.binding.shipmentLine;
    await this.pool.query(
      `INSERT INTO ${fulfillmentTable(line)}
         (tenant_id,environment_id,${q(line.legalEntity!.column)},record_id,revision,archived_at,
          ${q(fulfillmentColumn(line, 'shipment_line_line_number'))},
          ${q(fulfillmentColumn(line, 'shipment_line_item_id'))},
          ${q(fulfillmentColumn(line, 'shipment_line_quantity'))},
          ${q(fulfillmentColumn(line, 'shipment_line_unit_id'))},
          ${q(fulfillmentRelation(this.binding, line, 'shipment_line_shipment'))},
          ${q(fulfillmentRelation(this.binding, line, 'shipment_line_order_line'))},
          ${q(fulfillmentRelation(this.binding, line, 'shipment_line_reservation'))})
       VALUES ($1,$2,$3,$4,1,NULL,$5,$6,'1',$7,$8,$9,$10)`,
      [
        ...this.scope,
        recordId,
        lineNumber,
        itemId,
        unitId,
        shipmentId,
        orderLineId,
        reservationId,
      ],
    );
  }
}
