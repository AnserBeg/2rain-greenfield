/**
 * An in-memory composed application for the purchasing workspace.
 *
 * What is REAL here: the compiled application release the product ships
 * (`release/app.compiled.json`), the request-runtime view built from it, both
 * semantic gateways, the composed surface-runtime extension and the whole of
 * SurfaceRuntime. Every byte of HTML is produced by production code.
 *
 * What is a DOUBLE: storage. `InMemoryExecutor` stands where the PostgreSQL
 * provider stands. It keeps records in a map, answers `get` and shared `list`
 * queries (search, paging, relation labels) and applies create, update,
 * archive, restore and state transitions.
 *
 * RECEIVING IS SIMULATED, and the word is chosen carefully. In production,
 * posting a receipt, closing and reopening an order run through the receiving
 * capability and the posting kernel in PostgreSQL. `SimulatedReceiving` below
 * imitates only their visible outcome: a posted receipt adds to the
 * `purchase_order_received` read model; close and reopen move the order state,
 * with a few of the same refusals. It appends no stock movement and proves
 * nothing about the kernel. It exists so the SCREENS can be walked end to end;
 * `browser/receiving.composed-application.spec.ts` is the evidence for the
 * real thing.
 *
 * It exists so the purchasing screens can be rendered and exercised without a
 * database — in a unit test, and in a local preview server.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '@north-star/runtime/request-context';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '@north-star/runtime/request-runtime-view';

import { parseMutationInput } from '../../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type RegisteredCapabilityOperationAuthorizationRequest,
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import { COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION } from '../src/sales-section.js';
import type { SurfaceRuntimeGateways } from '../src/surface-runtime.js';

export const FIXTURE_NAMESPACE = 'northstar.app';
export const FIXTURE_LEGAL_ENTITY_ID = '74000000-0000-4000-8000-000000000001';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const environmentId = 'a2000000-0000-4000-8000-000000000002';
const principalId = 'a3000000-0000-4000-8000-000000000003';
const STATE_FIELD_ID = `${FIXTURE_NAMESPACE}:derived_state_field.machine.purchase_order_lifecycle`;

interface StoredRecord {
  readonly dto: SemanticRecordDto;
  readonly relations: Readonly<Record<string, string>>;
}

type Values = Readonly<Record<string, ImmutableJsonValue>>;

export class InMemoryExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly #records = new Map<string, StoredRecord>();

  /** Stores one record. Field keys are local names: `number`, not the full id. */
  seed(
    entityLocal: string,
    values: Readonly<Record<string, ImmutableJsonValue>>,
    options: {
      readonly archived?: boolean;
      readonly recordId?: string;
      readonly relations?: Readonly<Record<string, string>>;
      readonly state?: string;
    } = {},
  ): string {
    const recordId = options.recordId ?? randomUUID();
    const stored: Record<string, ImmutableJsonValue> = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        `${FIXTURE_NAMESPACE}:field.${entityLocal}_${name}`,
        value,
      ]),
    );
    if (options.state) {
      stored[STATE_FIELD_ID] =
        `${FIXTURE_NAMESPACE}:state.purchase_order_${options.state}`;
    }
    this.#records.set(recordId, {
      dto: Object.freeze({
        archived: options.archived ?? false,
        entityId: `${FIXTURE_NAMESPACE}:entity.${entityLocal}`,
        recordId,
        revision: 1,
        values: Object.freeze(stored),
      }),
      relations: Object.freeze(
        Object.fromEntries(
          Object.entries(options.relations ?? {}).map(([name, target]) => [
            `${FIXTURE_NAMESPACE}:relation.${name}`,
            target,
          ]),
        ),
      ),
    });
    return recordId;
  }

  read(recordId: string): SemanticRecordDto | null {
    return this.#records.get(recordId)?.dto ?? null;
  }

  /** Applies one simulated receiving operation and returns the new image. */
  receive(operationLocal: string, recordId: string): SemanticRecordDto {
    const id = (kind: string, local: string): string =>
      `${FIXTURE_NAMESPACE}:${kind}.${local}`;
    const target = this.#records.get(recordId);
    if (!target) throw new Error('record not found');
    const save = (
      record: StoredRecord,
      values: Record<string, ImmutableJsonValue>,
    ): SemanticRecordDto => {
      const dto: SemanticRecordDto = Object.freeze({
        ...record.dto,
        revision: record.dto.revision + 1,
        values: Object.freeze({ ...record.dto.values, ...values }),
      });
      this.#records.set(dto.recordId, { dto, relations: record.relations });
      return dto;
    };
    const state = (record: StoredRecord): string =>
      String(record.dto.values[STATE_FIELD_ID]).split('purchase_order_')[1]!;
    const children = (relationLocal: string, parentId: string) =>
      [...this.#records.values()].filter(
        (record) =>
          record.relations[id('relation', relationLocal)] === parentId &&
          !record.dto.archived,
      );
    const receivedRow = (lineId: string) =>
      children('purchase_order_received_order_line', lineId)[0];
    const quantity = (record: StoredRecord | undefined, field: string) =>
      Number(record?.dto.values[id('field', field)] ?? 0);

    switch (operationLocal) {
      case 'goods_receipt_post': {
        const posted = id('option', 'goods_receipt_state_posted');
        if (target.dto.values[id('field', 'goods_receipt_state')] === posted)
          throw new Error('receipt is already posted');
        const order = this.#records.get(
          target.relations[id('relation', 'goods_receipt_order')] ?? '',
        );
        if (!order || state(order) !== 'released')
          throw new Error('RECEIPT_ORDER_NOT_RELEASED');
        const lines = children('goods_receipt_line_receipt', recordId);
        if (lines.length === 0) throw new Error('receipt has no lines');
        for (const line of lines) {
          const orderLine = this.#records.get(
            line.relations[id('relation', 'goods_receipt_line_order_line')] ??
              '',
          );
          if (!orderLine) throw new Error('receipt line has no order line');
          const existing = receivedRow(orderLine.dto.recordId);
          const next =
            quantity(existing, 'purchase_order_received_received_quantity') +
            quantity(line, 'goods_receipt_line_quantity');
          if (
            next < 0 ||
            next > quantity(orderLine, 'purchase_order_line_ordered_quantity')
          )
            throw new Error('receipt would over- or under-receive the line');
          if (existing) {
            save(existing, {
              [id('field', 'purchase_order_received_received_quantity')]:
                String(next),
            });
          } else {
            this.seed(
              'purchase_order_received',
              { received_quantity: String(next), unit_id: 'each' },
              {
                relations: {
                  purchase_order_received_order_line: orderLine.dto.recordId,
                },
              },
            );
          }
        }
        return save(target, { [id('field', 'goods_receipt_state')]: posted });
      }
      case 'purchase_order_close': {
        if (state(target) !== 'released')
          throw new Error('only a released order can be closed');
        const open = children('purchase_order_line_order', recordId).some(
          (line) =>
            quantity(line, 'purchase_order_line_ordered_quantity') >
            quantity(
              receivedRow(line.dto.recordId),
              'purchase_order_received_received_quantity',
            ),
        );
        if (open) throw new Error('order still has quantity to receive');
        return save(target, {
          [STATE_FIELD_ID]: id('state', 'purchase_order_closed'),
        });
      }
      case 'purchase_order_reopen':
        if (state(target) !== 'closed')
          throw new Error('only a closed order can be reopened');
        return save(target, {
          [STATE_FIELD_ID]: id('state', 'purchase_order_released'),
        });
      default:
        throw new Error(`${operationLocal} is not simulated`);
    }
  }

  async recordNonAccepted(): Promise<void> {
    // Nothing to record: this double keeps no audit trail.
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  async execute(
    request: SemanticOperationExecutionRequest | SemanticQueryExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope | SemanticQueryResultEnvelope> {
    return 'arguments' in request
      ? this.#query(request)
      : this.#operate(request);
  }

  #query(request: SemanticQueryExecutionRequest): SemanticQueryResultEnvelope {
    const { definition } = request;
    const base = {
      kind: 'semanticQueryResult' as const,
      queryId: definition.queryId,
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      unsupportedReason: null,
    };
    const ofEntity = [...this.#records.values()].filter(
      (record) => record.dto.entityId === definition.sourceEntityId,
    );
    if (definition.queryType === 'get') {
      const recordId = (request.arguments as { recordId?: unknown }).recordId;
      const found = ofEntity.filter(
        (record) => record.dto.recordId === recordId,
      );
      return {
        ...base,
        outcome: found.length > 0 ? 'exact' : 'not-found',
        records: found.map((record) => record.dto),
      };
    }
    if (!request.list) {
      return { ...base, outcome: 'unsupported', records: [] };
    }
    const { query, relationLabels } = request.list;
    const search = query.search.toLowerCase();
    const matching = ofEntity
      .filter((record) => query.includeArchived || !record.dto.archived)
      .filter(
        (record) =>
          search === '' ||
          definition.selections.some(({ fieldId }) =>
            String(record.dto.values[fieldId] ?? '')
              .toLowerCase()
              .includes(search),
          ),
      );
    const page = matching.slice(
      query.pageOffset,
      query.pageOffset + query.effectivePageSize,
    );
    const records = page.map((record) =>
      Object.freeze({
        ...record.dto,
        displayValues: Object.freeze(
          Object.fromEntries(
            definition.selections.map(({ fieldId }) => [
              fieldId,
              display(record.dto.values[fieldId]),
            ]),
          ),
        ),
        relationLabels: Object.freeze(
          Object.fromEntries(
            relationLabels.map((label) => {
              const targetId = record.relations[label.relationId] ?? null;
              const target = targetId ? this.#records.get(targetId) : undefined;
              return [
                label.relationId,
                Object.freeze({
                  label: display(target?.dto.values[label.fieldId]),
                  recordId: targetId,
                }),
              ];
            }),
          ),
        ),
      }),
    );
    return {
      ...base,
      listCoverage: Object.freeze({
        effectivePageSize: query.effectivePageSize,
        hasMore: false,
        includeArchived: query.includeArchived,
        matchMode: query.matchMode,
        nextCursor: null,
        pageOffset: query.pageOffset,
        parentScope: null,
        projectedSearchValueCount:
          query.search.length === 0 ? 0 : definition.selections.length,
        requestedPageSize: query.requestedPageSize,
        returnedCount: records.length,
        schemaVersion: 'northstar.shared-list-result/v1',
        search: query.search,
        sort: query.sort,
        totalCount: matching.length,
        truncatedByMaximum: query.truncatedByMaximum,
      }),
      outcome: 'exact',
      records,
    };
  }

  #operate(
    request: SemanticOperationExecutionRequest,
  ): SemanticOperationResultEnvelope {
    const { definition } = request;
    const parsed = parseMutationInput(definition, request.input);
    const previous = this.#records.get(parsed.recordId);
    const effect = definition.effect;
    let values: Values = previous?.dto.values ?? {};
    let archived = previous?.dto.archived ?? false;
    switch (effect.kind) {
      case 'transitionStateEffect':
        assert.ok(previous, 'a transition needs an existing record');
        assert.equal(values[effect.stateFieldId], effect.fromStateId);
        values = { ...values, [effect.stateFieldId]: effect.toStateId };
        break;
      case 'archiveRecordEffect':
        archived = true;
        break;
      case 'restoreRecordEffect':
        archived = false;
        break;
      default:
        values = { ...values, ...parsed.patch };
        // The provider mints the initial state on create; so does this.
        if (
          !previous &&
          effect.entity.targetId ===
            `${FIXTURE_NAMESPACE}:entity.purchase_order`
        ) {
          values = {
            ...values,
            [STATE_FIELD_ID]: `${FIXTURE_NAMESPACE}:state.purchase_order_draft`,
          };
        }
    }
    const dto: SemanticRecordDto = Object.freeze({
      archived,
      entityId: effect.entity.targetId,
      recordId: parsed.recordId,
      revision: (previous?.dto.revision ?? 0) + 1,
      values: Object.freeze(values),
    });
    this.#records.set(parsed.recordId, {
      dto,
      relations: previous?.relations ?? Object.freeze({ ...parsed.relations }),
    });
    return {
      kind: 'semanticOperationResult',
      operationId: definition.operationId,
      outcome: 'succeeded',
      readBack: dto,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
      unsupportedReason: null,
    };
  }
}

/** See the file header: an imitation of the visible outcome of receiving. */
export class SimulatedReceiving implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = 'northstar.purchasing:capability.receiving';

  constructor(private readonly records: InMemoryExecutor) {}

  prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ) {
    return Promise.resolve({
      decisionInput: request.input,
      legalEntityReadScopeIds: [],
      readBackArguments: request.input,
    });
  }

  async execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    const { operationId } = request.definition;
    const readBack = this.records.receive(
      operationId.slice(operationId.lastIndexOf('.') + 1),
      String((request.input as { recordId?: unknown }).recordId),
    );
    return {
      kind: 'semanticOperationResult',
      operationId,
      outcome: 'succeeded',
      readBack,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
      unsupportedReason: null,
    };
  }
}

function display(value: ImmutableJsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface CompiledArtifact {
  readonly canonicalBytesBase64: string;
  readonly contentHash: string;
}

interface CompiledApplication {
  readonly artifacts: readonly CompiledArtifact[];
  readonly releaseManifest: {
    readonly projections: readonly {
      readonly artifactRoot: string;
      readonly familyId: string;
      readonly instanceId: string;
      readonly payloadSchemaVersion: string;
      readonly semanticDigest: string;
    }[];
  };
  readonly releaseRoot: string;
}

function loadCompiledApplication(): CompiledApplication {
  const release = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../release/app.compiled.json'),
      'utf8',
    ),
  ) as { application: CompiledApplication };
  return release.application;
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  application: CompiledApplication,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const decode = (contentHash: string): Record<string, unknown> => {
    const artifact = application.artifacts.find(
      (candidate) => candidate.contentHash === contentHash,
    );
    assert.ok(artifact, `missing compiled artifact ${contentHash}`);
    return JSON.parse(
      Buffer.from(artifact.canonicalBytesBase64, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
  };
  const reference = application.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference, `missing projection family ${familyId}`);
  const chunks = decode(reference.artifactRoot).chunks as
    { readonly contentHash: string }[] | undefined;
  assert.equal(chunks?.length, 1, 'fixture reads single-chunk projections');
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(chunks[0]!.contentHash) as unknown as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}

export interface PurchasingFixture {
  readonly entry: AuthenticatedRequestRuntimeEntryAdapter;
  readonly executor: InMemoryExecutor;
  readonly gateways: SurfaceRuntimeGateways;
  /** `/?surface=…` for a purchasing surface, scoped to the fixture entity. */
  url(
    surfaceLocal: string,
    parameters?: Readonly<Record<string, string>>,
  ): string;
}

/** The composed application over an empty in-memory store. */
export function createPurchasingFixture(): PurchasingFixture {
  const application = loadCompiledApplication();
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  const policy: CurrentPolicyGateway = {
    async authorize() {
      return {
        decision: 'ALLOW',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'purchasing-fixture-policy/v1',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'purchasing-fixture-policy/v1' };
    },
  };
  const families = REQUEST_RUNTIME_PROJECTION_FAMILIES;
  const definition: LoadedRequestRuntimeDefinition = {
    environmentId,
    pointer: { fence: 1, pointerId: 'd5000000-0000-4000-8000-000000000005' },
    projections: {
      agent: projection(application, families.agent),
      catalog: projection(application, families.catalog),
      operation: projection(application, families.operation),
      query: projection(application, families.query),
      surface: projection(application, families.surface),
    },
    release: {
      contentHash: application.releaseRoot,
      releaseId: 'd4000000-0000-4000-8000-000000000004',
    },
    tenantId,
  };
  const executor = new InMemoryExecutor();
  executor.seed(
    'legal_entity',
    { code: 'DEFAULT', is_default: true, name: 'Default legal entity' },
    { recordId: FIXTURE_LEGAL_ENTITY_ID },
  );
  const operationMediation = new SemanticOperationMediationAuthority();
  return {
    entry: new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => identity),
      {
        async load() {
          return definition;
        },
      },
      policy,
    ),
    executor,
    gateways: {
      applicationExtension: COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION,
      operationGateway: new SemanticOperationGateway(
        policy,
        executor,
        operationMediation,
        undefined,
        [new SimulatedReceiving(executor)],
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, executor),
    },
    url(surfaceLocal, parameters = {}) {
      const queryLocal = surfaceLocal
        .replace(/_(?:detail|form)$/u, '_get')
        .replace(/_list$/u, '_list');
      return `/?${new URLSearchParams({
        surface: `${FIXTURE_NAMESPACE}:surface.${surfaceLocal}`,
        [`${FIXTURE_NAMESPACE}:parameter.${queryLocal}_legal_entity_scope`]:
          FIXTURE_LEGAL_ENTITY_ID,
        ...parameters,
      }).toString()}`;
    },
  };
}

export interface SeededPurchasing {
  readonly cancelledOrderId: string;
  readonly closedOrderId: string;
  readonly draftOrderId: string;
  readonly emptyDraftOrderId: string;
  readonly overdueOrderId: string;
  readonly partialLineId: string;
  readonly releasedOrderId: string;
}

/**
 * A small, deliberately varied book of orders: every lifecycle state, every
 * receiving state, a priced and an unpriced line, a supplier that resolves to
 * a party and one that does not. Dates are relative to `now` so "overdue" is
 * stable whenever the fixture runs.
 */
export function seedPurchasing(
  executor: InMemoryExecutor,
  now: Date,
): SeededPurchasing {
  const day = (offset: number): string =>
    new Date(now.getTime() + offset * 86_400_000).toISOString();
  const supplier = executor.seed('party', {
    contact_summary: 'orders@northwind.example',
    name: 'Northwind Building Supply',
    number: 'SUP-1001',
  });
  executor.seed('party', {
    contact_summary: 'sales@cascade.example',
    name: 'Cascade Fasteners Ltd',
    number: 'SUP-1002',
  });
  const item = (sku: string, name: string): string =>
    executor.seed('item', {
      base_unit: 'each',
      description: name,
      name,
      sku,
    });
  const hinge = item('HW-0410', 'Butt hinge 4 in — satin nickel');
  const screws = item('FS-2210', 'Wood screw #10 × 2 in (box of 100)');
  const sealant = item('SL-0031', 'Exterior sealant 300 ml — white');

  const order = (
    number: string,
    state: string,
    values: Readonly<Record<string, ImmutableJsonValue>>,
  ): string =>
    executor.seed(
      'purchase_order',
      { currency: 'CAD', number, order_date: day(-20), ...values },
      { state },
    );
  const line = (
    orderId: string,
    lineNumber: string,
    itemId: string,
    quantity: string,
    unitPrice: string | null,
    received?: string,
  ): string => {
    const lineId = executor.seed(
      'purchase_order_line',
      {
        item_id: itemId,
        line_number: lineNumber,
        ordered_quantity: quantity,
        unit_price: unitPrice,
      },
      { relations: { purchase_order_line_order: orderId } },
    );
    if (received !== undefined) {
      executor.seed(
        'purchase_order_received',
        { received_quantity: received, unit_id: 'each' },
        { relations: { purchase_order_received_order_line: lineId } },
      );
    }
    return lineId;
  };

  const draftOrderId = order('PO-2041', 'draft', {
    expected_date: day(14),
    notes: 'Confirm lead time with the supplier before release.',
    supplier_party_id: supplier,
  });
  line(draftOrderId, '1', hinge, '120', '4.85');
  line(draftOrderId, '2', screws, '40', null);

  const emptyDraftOrderId = order('PO-2042', 'draft', {
    supplier_party_id: 'SUP-1002',
  });

  const releasedOrderId = order('PO-2038', 'released', {
    expected_date: day(6),
    supplier_party_id: supplier,
  });
  const partialLineId = line(releasedOrderId, '1', hinge, '200', '4.85', '80');
  line(releasedOrderId, '2', sealant, '48', '7.2', '48');
  line(releasedOrderId, '3', screws, '25', '12.495');

  const overdueOrderId = order('PO-2031', 'released', {
    expected_date: day(-5),
    order_date: day(-34),
    supplier_party_id: 'unlisted-local-supplier',
  });
  line(overdueOrderId, '1', sealant, '1500', '6.9');

  const closedOrderId = order('PO-2017', 'closed', {
    expected_date: day(-30),
    order_date: day(-60),
    supplier_party_id: 'SUP-1002',
  });
  line(closedOrderId, '1', screws, '60', '11.75', '60');

  const cancelledOrderId = order('PO-2009', 'cancelled', {
    currency: 'USD',
    order_date: day(-75),
    supplier_party_id: supplier,
  });
  line(cancelledOrderId, '1', hinge, '10', '5');

  return {
    cancelledOrderId,
    closedOrderId,
    draftOrderId,
    emptyDraftOrderId,
    overdueOrderId,
    partialLineId,
    releasedOrderId,
  };
}
