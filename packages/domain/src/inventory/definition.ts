// Canonical language v5 is the materialized-state-field language, adopted
// application-wide by `LANG-ADOPT-v5`. This is unrelated to Inventory
// dependency-set v4, which versions the posting capability inputs and does not
// move with the language.
import { INVENTORY_CONTRACT_V1 } from './contracts.js';

const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const INVENTORY_NAMESPACE = 'northstar.inventory' as const;

type FieldType = Record<string, unknown>;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

function ids(namespace: string) {
  const entity = (local: string) => `${namespace}:entity.${local}`;
  const field = (local: string, name: string) =>
    `${namespace}:field.${local}_${name}`;
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    postingCapabilityId: 'northstar.inventory:capability.posting',
    entityIds: {
      legalEntity: entity('legal_entity'),
      movement: entity('inventory_movement'),
      periodLock: entity('inventory_period_lock'),
      postedStockBalance: entity('posted_stock_balance'),
      stockCount: entity('stock_count'),
      stockCountLine: entity('stock_count_line'),
      transaction: entity('inventory_transaction'),
      transactionLine: entity('inventory_transaction_line'),
    },
    fieldIds: {
      legalEntity: {
        code: field('legal_entity', 'code'),
        isDefault: field('legal_entity', 'is_default'),
        name: field('legal_entity', 'name'),
        status: field('legal_entity', 'status'),
      },
      movement: {
        actorId: field('inventory_movement', 'actor_id'),
        effectiveAt: field('inventory_movement', 'effective_at'),
        itemId: field('inventory_movement', 'item_id'),
        locationId: field('inventory_movement', 'location_id'),
        postingRole: field('inventory_movement', 'posting_role'),
        quantityDelta: field('inventory_movement', 'quantity_delta'),
        reasonCode: field('inventory_movement', 'reason_code'),
        reasonNarrative: field('inventory_movement', 'reason_narrative'),
        recordedAt: field('inventory_movement', 'recorded_at'),
        reversalOfMovementId: field(
          'inventory_movement',
          'reversal_of_movement_id',
        ),
        sourceId: field('inventory_movement', 'source_id'),
        sourceLine: field('inventory_movement', 'source_line'),
        sourceRevision: field('inventory_movement', 'source_revision'),
        sourceType: field('inventory_movement', 'source_type'),
        stockDimensionSetVersion: field(
          'inventory_movement',
          'stock_dimension_set_version',
        ),
        unitId: field('inventory_movement', 'unit_id'),
      },
      periodLock: {
        closedThrough: field('inventory_period_lock', 'closed_through'),
      },
      postedStockBalance: {
        itemId: field('posted_stock_balance', 'item_id'),
        locationId: field('posted_stock_balance', 'location_id'),
        postedQuantity: field('posted_stock_balance', 'posted_quantity'),
        unitId: field('posted_stock_balance', 'unit_id'),
      },
      stockCount: {
        actorId: field('stock_count', 'actor_id'),
        countedAt: field('stock_count', 'counted_at'),
        kind: field('stock_count', 'kind'),
        locationId: field('stock_count', 'location_id'),
        number: field('stock_count', 'number'),
        reasonCode: field('stock_count', 'reason_code'),
        reasonNarrative: field('stock_count', 'reason_narrative'),
        recordedAt: field('stock_count', 'recorded_at'),
        state: field('stock_count', 'state'),
      },
      stockCountLine: {
        countedQuantity: field('stock_count_line', 'counted_quantity'),
        expectedQuantity: field('stock_count_line', 'expected_quantity'),
        itemId: field('stock_count_line', 'item_id'),
        lineNumber: field('stock_count_line', 'line_number'),
        reversalOfMovementId: field(
          'stock_count_line',
          'reversal_of_movement_id',
        ),
        unitId: field('stock_count_line', 'unit_id'),
        varianceQuantity: field('stock_count_line', 'variance_quantity'),
      },
      transaction: {
        actorId: field('inventory_transaction', 'actor_id'),
        effectiveAt: field('inventory_transaction', 'effective_at'),
        number: field('inventory_transaction', 'number'),
        reasonCode: field('inventory_transaction', 'reason_code'),
        reasonNarrative: field('inventory_transaction', 'reason_narrative'),
        recordedAt: field('inventory_transaction', 'recorded_at'),
        sourceId: field('inventory_transaction', 'source_id'),
        sourceType: field('inventory_transaction', 'source_type'),
        state: field('inventory_transaction', 'state'),
        type: field('inventory_transaction', 'type'),
      },
      transactionLine: {
        fromLocationId: field('inventory_transaction_line', 'from_location_id'),
        itemId: field('inventory_transaction_line', 'item_id'),
        lineNumber: field('inventory_transaction_line', 'line_number'),
        quantity: field('inventory_transaction_line', 'quantity'),
        toLocationId: field('inventory_transaction_line', 'to_location_id'),
        unitId: field('inventory_transaction_line', 'unit_id'),
      },
    },
    moduleId: `${namespace}:module.inventory`,
    namespace,
    operationIds: {
      postAdjustment: `${namespace}:operation.inventory_transaction_post`,
    },
    packageId: `${namespace}:package.inventory`,
    queryIds: {
      onHand: `${namespace}:query.inventory_movement_on_hand`,
    },
    queryParameterIds: {
      onHandAtTime: `${namespace}:parameter.on_hand_at_time`,
      onHandItemId: `${namespace}:parameter.on_hand_item_id`,
      onHandLegalEntityId: `${namespace}:parameter.on_hand_legal_entity_id`,
      onHandLocationId: `${namespace}:parameter.on_hand_location_id`,
      onHandRecordedAtHorizon: `${namespace}:parameter.on_hand_recorded_at_horizon`,
    },
    querySelectionIds: {
      onHand: `${namespace}:selection.inventory_movement_on_hand`,
    },
    relationIds: {
      movementTransaction: `${namespace}:relation.inventory_movement_transaction`,
      movementTransactionLine: `${namespace}:relation.inventory_movement_transaction_line`,
      stockCountLineSession: `${namespace}:relation.stock_count_line_session`,
      stockCountLineTransactionLine: `${namespace}:relation.stock_count_line_transaction_line`,
      stockCountSupersedes: `${namespace}:relation.stock_count_supersedes`,
      stockCountTransaction: `${namespace}:relation.stock_count_transaction`,
      transactionLineTransaction: `${namespace}:relation.inventory_transaction_line_transaction`,
    },
  } as const;
}

type InventoryIds = ReturnType<typeof ids>;

const defaultIds = ids(INVENTORY_NAMESPACE);

export const INVENTORY_IDS = Object.freeze(defaultIds);

const ENTITY_OWNED_QUERY_FAMILIES = new Set([
  'inventory_movement',
  'inventory_period_lock',
  'posted_stock_balance',
  'inventory_transaction',
  'inventory_transaction_line',
  'stock_count',
  'stock_count_line',
]);

/**
 * The inventory module owns business records in the same canonical module
 * plane as every other first-party domain. The movement is intentionally
 * read-only here: G3-P3 owns the only sanctioned posting writer.
 */
export function inventoryModuleDefinition(
  namespace: string = INVENTORY_NAMESPACE,
  options: {
    /**
     * Stock documents recorded like any other document (INVENTORY-PARITY):
     * a transaction takes a server-assigned `STK-000001` number on its first
     * save, and its source, recorded time and actor stop being authored --
     * the editor stores the document as its own posting source, and the
     * movements carry the recorded time and actor. The product application
     * mounts Inventory with this; the standalone kernel harness keeps the
     * module it has always compiled.
     */
    readonly documentEntry?: boolean;
  } = {},
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { entityIds, fieldIds, moduleId, packageId } = definitionIds;
  const documentEntry = options.documentEntry === true;
  const standardEntities = [
    ['legal_entity', 'Legal entity', entityIds.legalEntity],
    ['inventory_transaction', 'Inventory transaction', entityIds.transaction],
    [
      'inventory_transaction_line',
      'Inventory transaction line',
      entityIds.transactionLine,
    ],
    ['inventory_period_lock', 'Inventory period lock', entityIds.periodLock],
    ['stock_count', 'Stock count', entityIds.stockCount],
    ['stock_count_line', 'Stock count line', entityIds.stockCountLine],
  ] as const;
  const movementFields = Object.values(fieldIds.movement);
  const postedStockBalanceFields = Object.values(fieldIds.postedStockBalance);

  return {
    assertions: [
      ...standardEntities.map(([local]) => assertion(definitionIds, local)),
      assertion(definitionIds, 'inventory_movement'),
      assertion(definitionIds, 'posted_stock_balance'),
      onHandScopeAssertion(definitionIds),
      postingRouteAssertion(definitionIds),
    ],
    capabilityRequirements: [
      {
        capabilityId: definitionIds.contentCapabilityId,
        capabilityVersion: 1,
        declaredEffects: ['read'],
        kind: 'capabilityRequirement',
        requiredProjections: [
          'storage',
          'policy',
          'query',
          'operation',
          'surface',
          'agent',
          'reporting',
          'verification',
        ],
        schemaVersion: version,
        supportStatus: 'supported',
      },
      {
        capabilityId: definitionIds.postingCapabilityId,
        // Read from the frozen contract, never spelled here: this is the value
        // `buildCapabilityFacts` carries into a release manifest, and the
        // provider refuses to post against a release whose fact differs from
        // the version it implements (posting-kernel-admission).
        capabilityVersion: INVENTORY_CONTRACT_V1.capabilityVersion,
        declaredEffects: ['appendFact'],
        kind: 'capabilityRequirement',
        requiredProjections: ['operation', 'surface', 'verification'],
        schemaVersion: version,
        supportStatus: 'supported',
      },
    ],
    entities: [
      ...standardEntities.map(([local, label, entityId], index) =>
        entity(definitionIds, local, label, entityId, (index + 1) * 10),
      ),
      entity(
        definitionIds,
        'inventory_movement',
        'Inventory movement',
        entityIds.movement,
        70,
      ),
      entity(
        definitionIds,
        'posted_stock_balance',
        'Posted stock balance',
        entityIds.postedStockBalance,
        80,
      ),
    ],
    fields: [
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.code,
        'Code',
        10,
        text(40),
        {
          businessKey: true,
          searchable: true,
        },
      ),
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.name,
        'Name',
        20,
        text(240),
        {
          searchable: true,
        },
      ),
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.status,
        'Status',
        30,
        enumeration(definitionIds, 'legal_entity_status', [
          'active',
          'archived',
        ]),
      ),
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.isDefault,
        'Default entity',
        40,
        boolean(),
      ),

      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.number,
        'Transaction number',
        10,
        text(60),
        {
          businessKey: true,
          searchable: true,
          // The prefix differs from the kernel's companion numbers (GR-, SH-,
          // SC- followed by a uuid), which the allocator's scan never matches.
          ...(documentEntry ? { numberedAs: 'STK' } : {}),
        },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.type,
        'Transaction type',
        20,
        enumeration(definitionIds, 'inventory_transaction_type', [
          'goodsReceipt',
          'shipment',
          'opening',
          'adjustment',
          'transfer',
          'countCorrection',
          'reBaseline',
        ]),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.state,
        'State',
        30,
        enumeration(definitionIds, 'inventory_transaction_state', [
          'draft',
          'posted',
          'reversed',
        ]),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.reasonCode,
        'Reason code',
        40,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.reasonNarrative,
        'Reason narrative',
        50,
        text(1000),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.sourceType,
        'Source type',
        60,
        text(80),
        { optional: documentEntry },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.sourceId,
        'Source id',
        70,
        text(80),
        { optional: documentEntry },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.effectiveAt,
        'Effective at',
        80,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.recordedAt,
        'Recorded at',
        90,
        instant(),
        { optional: documentEntry },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.actorId,
        'Actor id',
        100,
        text(80),
        { optional: documentEntry },
      ),

      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.lineNumber,
        'Line number',
        10,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.itemId,
        'Item id',
        20,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.fromLocationId,
        'From location id',
        30,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.toLocationId,
        'To location id',
        40,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.quantity,
        'Quantity',
        50,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.unitId,
        'Unit id',
        60,
        text(32),
        { searchable: true },
      ),

      field(
        definitionIds,
        entityIds.periodLock,
        fieldIds.periodLock.closedThrough,
        'Closed through',
        10,
        instant(),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.number,
        'Count number',
        10,
        text(60),
        { businessKey: true, searchable: true },
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.kind,
        'Count kind',
        20,
        enumeration(definitionIds, 'stock_count_kind', [
          'initial',
          'correction',
          'reversal',
        ]),
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.state,
        'Count state',
        30,
        enumeration(definitionIds, 'stock_count_state', [
          'draft',
          'counting',
          'reviewed',
          'posted',
        ]),
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.locationId,
        'Location id',
        40,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.countedAt,
        'Counted at',
        50,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.recordedAt,
        'Recorded at',
        60,
        instant(),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.actorId,
        'Actor id',
        70,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.reasonCode,
        'Reason code',
        80,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.stockCount,
        fieldIds.stockCount.reasonNarrative,
        'Reason narrative',
        90,
        text(1000),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.lineNumber,
        'Line number',
        10,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.itemId,
        'Item id',
        20,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.expectedQuantity,
        'Expected quantity',
        30,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.countedQuantity,
        'Counted quantity',
        40,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.varianceQuantity,
        'Variance quantity',
        50,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.unitId,
        'Unit id',
        60,
        text(32),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.stockCountLine,
        fieldIds.stockCountLine.reversalOfMovementId,
        'Reversal of movement id',
        70,
        text(80),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.stockDimensionSetVersion,
        'Stock dimension set version',
        10,
        enumeration(definitionIds, 'stock_dimension_set_version', ['v1']),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.itemId,
        'Item id',
        20,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.locationId,
        'Location id',
        30,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.quantityDelta,
        'Quantity delta',
        40,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.unitId,
        'Unit id',
        50,
        text(32),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.effectiveAt,
        'Effective at',
        60,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.recordedAt,
        'Recorded at',
        70,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceType,
        'Source type',
        80,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceId,
        'Source id',
        90,
        text(80),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceLine,
        'Source line',
        100,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceRevision,
        'Source revision',
        110,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.postingRole,
        'Posting role',
        120,
        enumeration(definitionIds, 'inventory_posting_role', [
          'receipt',
          'shipment',
          'adjustment',
          'transfer',
          'count',
          'correction',
          'reBaseline',
        ]),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.reasonCode,
        'Reason code',
        130,
        text(80),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.reasonNarrative,
        'Reason narrative',
        140,
        text(1000),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.actorId,
        'Actor id',
        150,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.reversalOfMovementId,
        'Reversal movement id',
        160,
        text(80),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.postedStockBalance,
        fieldIds.postedStockBalance.itemId,
        'Item id',
        10,
        text(80),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.postedStockBalance,
        fieldIds.postedStockBalance.locationId,
        'Location id',
        20,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.postedStockBalance,
        fieldIds.postedStockBalance.postedQuantity,
        'Posted quantity',
        30,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.postedStockBalance,
        fieldIds.postedStockBalance.unitId,
        'Unit id',
        40,
        text(32),
      ),
    ],
    hashAlgorithm: 'sha256',
    impactAnalyses: [],
    kind: 'applicationPackageRevision',
    languageVersion: version,
    modules: [
      {
        composition: {
          kind: 'compositionSeam',
          schemaVersion: version,
          status: 'unsupported',
        },
        kind: 'moduleDefinition',
        label: 'Inventory',
        moduleId,
        orderKey: 10,
        ownerPackageId: packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: [
      ...standardEntities.flatMap(([local, , entityId]) =>
        local === 'inventory_period_lock'
          ? periodLockOperations(definitionIds, entityId)
          : operations(
              definitionIds,
              local,
              entityId,
              standardOperationPreconditions(definitionIds, local),
            ),
      ),
      postingOperation(definitionIds),
    ],
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      ...standardEntities.flatMap(([local, , entityId]) =>
        local === 'inventory_period_lock'
          ? periodLockPermissions(definitionIds, entityId)
          : permissions(definitionIds, local, entityId, false),
      ),
      ...permissions(
        definitionIds,
        'inventory_movement',
        entityIds.movement,
        true,
      ),
      ...permissions(
        definitionIds,
        'posted_stock_balance',
        entityIds.postedStockBalance,
        true,
      ),
      {
        action: 'transition',
        kind: 'permissionDefinition',
        label: 'inventory transaction post',
        permissionId: `${namespace}:permission.inventory_transaction_post`,
        resource: reference('entityReference', entityIds.transaction),
        schemaVersion: version,
      },
    ],
    queries: [
      ...standardEntities.flatMap(([local, , entityId]) => {
        const entityFields = fieldsForEntity(fieldIds, local);
        return queries(
          definitionIds,
          local,
          entityId,
          entityFields,
          resolveFieldForEntity(fieldIds, local),
          local !== 'inventory_period_lock',
        );
      }),
      ...queries(
        definitionIds,
        'inventory_movement',
        entityIds.movement,
        movementFields,
        fieldIds.movement.sourceId,
      ),
      ...queries(
        definitionIds,
        'posted_stock_balance',
        entityIds.postedStockBalance,
        postedStockBalanceFields,
        fieldIds.postedStockBalance.itemId,
      ),
      onHandQuery(definitionIds),
    ],
    relations: [
      relation(
        definitionIds.relationIds.transactionLineTransaction,
        entityIds.transactionLine,
        entityIds.transaction,
        10,
      ),
      relation(
        definitionIds.relationIds.movementTransaction,
        entityIds.movement,
        entityIds.transaction,
        20,
      ),
      relation(
        definitionIds.relationIds.movementTransactionLine,
        entityIds.movement,
        entityIds.transactionLine,
        30,
        'reference',
      ),
      // PUR-2a. The companion transaction is a POST-TIME OUTPUT the posting
      // kernel derives and writes, not a create-time input. A reviewed count
      // exists before its companion does, so this relation is optional and the
      // kernel is its only writer.
      relation(
        definitionIds.relationIds.stockCountTransaction,
        entityIds.stockCount,
        entityIds.transaction,
        40,
        'reference',
        false,
      ),
      relation(
        definitionIds.relationIds.stockCountSupersedes,
        entityIds.stockCount,
        entityIds.stockCount,
        50,
        'reference',
        false,
      ),
      relation(
        definitionIds.relationIds.stockCountLineSession,
        entityIds.stockCountLine,
        entityIds.stockCount,
        60,
      ),
      // PUR-2a. Companion line identity is derived and written by the posting
      // kernel, for the same reason as stockCountTransaction above.
      relation(
        definitionIds.relationIds.stockCountLineTransactionLine,
        entityIds.stockCountLine,
        entityIds.transactionLine,
        70,
        'reference',
        false,
      ),
    ],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      ...standardEntities.map(([local, , entityId]) =>
        storageMapping(definitionIds, local, entityId),
      ),
      storageMapping(definitionIds, 'inventory_movement', entityIds.movement),
      storageMapping(
        definitionIds,
        'posted_stock_balance',
        entityIds.postedStockBalance,
      ),
    ],
    surfaces: [
      ...standardEntities.flatMap(([local, label]) =>
        surfaces(
          definitionIds,
          local,
          label,
          local === 'inventory_period_lock',
          local === 'inventory_transaction',
        ),
      ),
      ...surfaces(
        definitionIds,
        'inventory_movement',
        'Inventory movement',
        true,
      ),
      ...surfaces(definitionIds, 'posted_stock_balance', 'Posted stock', true),
      onHandSurface(definitionIds),
    ],
  };
}

type StandardOperationAction = 'archive' | 'create' | 'restore' | 'update';

type StandardOperationPreconditions = Partial<
  Readonly<Record<StandardOperationAction, Record<string, unknown>>>
>;

function standardOperationPreconditions(
  ids: InventoryIds,
  local: string,
): StandardOperationPreconditions | undefined {
  const stockCountMutable = (): Record<string, unknown> => ({
    kind: 'notPredicate',
    schemaVersion: version,
    term: {
      field: reference('fieldReference', ids.fieldIds.stockCount.state),
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: version,
      value: {
        kind: 'textValue',
        schemaVersion: version,
        value: `${ids.namespace}:option.stock_count_state_posted`,
      },
    },
  });
  if (local === 'stock_count') {
    return {
      archive: stockCountMutable(),
      create: stockCountMutable(),
      restore: stockCountMutable(),
      update: stockCountMutable(),
    };
  }
  if (local !== 'inventory_transaction') return undefined;

  // ADR-0054. O0 owns the draft lifecycle: create admits a draft candidate,
  // and update requires both the prior and projected images to remain draft.
  // Archive/restore are deliberately absent here. They change visibility while
  // preserving state, so a posted source stays posted and cannot regain Post.
  const remainsDraft = (): Record<string, unknown> =>
    fieldComparison(ids.fieldIds.transaction.state, 'equals', {
      kind: 'textValue',
      schemaVersion: version,
      value: `${ids.namespace}:option.inventory_transaction_state_draft`,
    });
  return { create: remainsDraft(), update: remainsDraft() };
}

function fieldComparison(
  fieldId: string,
  operator: 'equals' | 'lessThanOrEqual',
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    field: reference('fieldReference', fieldId),
    kind: 'fieldComparisonPredicate',
    operator,
    schemaVersion: version,
    value,
  };
}

function queryParameterReference(parameterId: string): Record<string, unknown> {
  return {
    kind: 'queryParameterReference',
    parameterId,
    schemaVersion: version,
  };
}

/**
 * Freeze N's one scalar authority. Both temporal horizons narrow the movement
 * set before ADR-0022's sum; neither is a post-aggregate filter. A movement is
 * a posted fact by construction -- the module exposes no generic create path
 * and the posting capability appends it only when a transaction posts.
 */
function onHandQuery(ids: InventoryIds): Record<string, unknown> {
  const parameters = ids.queryParameterIds;
  return {
    aggregate: {
      field: reference('fieldReference', ids.fieldIds.movement.quantityDelta),
      kind: 'queryAggregateSelection',
      operator: 'sum',
      schemaVersion: version,
      selectionId: ids.querySelectionIds.onHand,
    },
    filter: {
      kind: 'allPredicate',
      schemaVersion: version,
      terms: [
        fieldComparison(
          ids.fieldIds.movement.itemId,
          'equals',
          queryParameterReference(parameters.onHandItemId),
        ),
        fieldComparison(
          ids.fieldIds.movement.locationId,
          'equals',
          queryParameterReference(parameters.onHandLocationId),
        ),
        fieldComparison(
          ids.fieldIds.movement.effectiveAt,
          'lessThanOrEqual',
          queryParameterReference(parameters.onHandAtTime),
        ),
        fieldComparison(
          ids.fieldIds.movement.recordedAt,
          'lessThanOrEqual',
          queryParameterReference(parameters.onHandRecordedAtHorizon),
        ),
      ],
    },
    kind: 'queryDefinition',
    legalEntityScope: {
      cardinality: 'exactlyOne',
      kind: 'queryLegalEntityScope',
      operand: {
        kind: 'queryParameterReference',
        parameterId: parameters.onHandLegalEntityId,
        schemaVersion: version,
      },
      schemaVersion: version,
    },
    maximumResultCount: 1,
    module: reference('moduleReference', ids.moduleId),
    parameters: [
      queryParameter(parameters.onHandLegalEntityId, 10),
      queryParameter(parameters.onHandItemId, 20),
      queryParameter(parameters.onHandLocationId, 30),
      queryParameter(parameters.onHandAtTime, 40),
      queryParameter(parameters.onHandRecordedAtHorizon, 50),
    ],
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.inventory_movement_read`,
    ),
    queryId: ids.queryIds.onHand,
    queryType: 'aggregate',
    schemaVersion: version,
    sourceEntity: reference('entityReference', ids.entityIds.movement),
    tier: 'q1',
  };
}

function queryParameter(
  parameterId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    kind: 'queryParameterDefinition',
    orderKey,
    parameterId,
    schemaVersion: version,
  };
}

function fieldsForEntity(
  fieldIds: InventoryIds['fieldIds'],
  local: string,
): readonly string[] {
  switch (local) {
    case 'legal_entity':
      return Object.values(fieldIds.legalEntity);
    case 'inventory_transaction':
      return Object.values(fieldIds.transaction);
    case 'inventory_transaction_line':
      return Object.values(fieldIds.transactionLine);
    case 'inventory_period_lock':
      return Object.values(fieldIds.periodLock);
    case 'stock_count':
      return Object.values(fieldIds.stockCount);
    case 'stock_count_line':
      return Object.values(fieldIds.stockCountLine);
    default:
      throw new TypeError(`unknown inventory entity ${local}`);
  }
}

function resolveFieldForEntity(
  fieldIds: InventoryIds['fieldIds'],
  local: string,
): string | null {
  switch (local) {
    case 'legal_entity':
      return fieldIds.legalEntity.code;
    case 'inventory_transaction':
      return fieldIds.transaction.number;
    case 'inventory_transaction_line':
      return fieldIds.transactionLine.unitId;
    case 'inventory_period_lock':
      return null;
    case 'stock_count':
      return fieldIds.stockCount.number;
    case 'stock_count_line':
      return fieldIds.stockCountLine.unitId;
    default:
      throw new TypeError(`unknown inventory entity ${local}`);
  }
}

function entity(
  ids: InventoryIds,
  local: string,
  label: string,
  entityId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    entityId,
    kind: 'entityDefinition',
    label,
    module: reference('moduleReference', ids.moduleId),
    orderKey,
    schemaVersion: version,
    storage: reference(
      'storageMappingReference',
      `${ids.namespace}:storage.${local}`,
    ),
  };
}

function field(
  ids: InventoryIds,
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  fieldType: FieldType,
  options: {
    businessKey?: boolean;
    optional?: boolean;
    searchable?: boolean;
    /** A server-assigned document number: `PREFIX-000001`, one per tenant. */
    numberedAs?: string;
  } = {},
): Record<string, unknown> {
  const local = entityId.slice(
    entityId.indexOf(':entity.') + ':entity.'.length,
  );
  return {
    ...(options.businessKey
      ? { businessKey: 'tenantEnvironmentCaseInsensitiveUnique' }
      : {}),
    ...(options.numberedAs
      ? {
          numbering: {
            kind: 'documentSequence',
            sequenceId: `${ids.namespace}:document_sequence.${local}`,
            prefix: options.numberedAs,
            minimumDigits: 6,
            start: 1,
          },
        }
      : {}),
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: options.optional ? 'nullable' : 'none',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType,
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: options.optional ? 'optional' : 'required',
    reportable: true,
    schemaVersion: version,
    searchable: options.searchable ?? false,
  };
}

const text = (maximumLength: number): FieldType => ({
  kind: 'textFieldType',
  maximumLength,
  schemaVersion: version,
});
const boolean = (): FieldType => ({
  kind: 'booleanFieldType',
  schemaVersion: version,
});
const integer = (): FieldType => ({
  kind: 'integerFieldType',
  representation: 'canonicalString',
  schemaVersion: version,
});
const decimal = (): FieldType => ({
  kind: 'exactDecimalFieldType',
  precision: 38,
  representation: 'canonicalString',
  scale: 18,
  schemaVersion: version,
});
const instant = (): FieldType => ({
  kind: 'dateTimeFieldType',
  precision: 'millisecond',
  schemaVersion: version,
  timezoneSemantics: 'utcInstant',
});

function enumeration(
  ids: InventoryIds,
  local: string,
  values: readonly string[],
): FieldType {
  return {
    kind: 'enumFieldType',
    options: values.map((value, index) => ({
      kind: 'enumOption',
      label: value,
      optionId: `${ids.namespace}:option.${local}_${value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
      orderKey: (index + 1) * 10,
      schemaVersion: version,
    })),
    schemaVersion: version,
  };
}

function queries(
  ids: InventoryIds,
  local: string,
  entityId: string,
  selectedFieldIds: readonly string[],
  resolveFieldId: string | null,
  includeSearch = true,
): Array<Record<string, unknown>> {
  const queryTypes = [
    'get',
    'list',
    ...(includeSearch ? (['search'] as const) : []),
    ...(resolveFieldId === null ? [] : (['resolve'] as const)),
  ] as const;
  return queryTypes.map((queryType) => {
    const legalEntityScopeParameterId = `${ids.namespace}:parameter.${local}_${queryType}_legal_entity_scope`;
    return {
      kind: 'queryDefinition',
      ...(ENTITY_OWNED_QUERY_FAMILIES.has(local)
        ? {
            legalEntityScope: {
              cardinality: 'exactlyOne',
              kind: 'queryLegalEntityScope',
              operand: {
                kind: 'queryParameterReference',
                parameterId: legalEntityScopeParameterId,
                schemaVersion: version,
              },
              schemaVersion: version,
            },
            parameters: [
              {
                kind: 'queryParameterDefinition',
                orderKey: 10,
                parameterId: legalEntityScopeParameterId,
                schemaVersion: version,
              },
            ],
          }
        : {}),
      maximumResultCount: queryType === 'get' ? 1 : 100,
      // The declared List exports this whole filtered set in one statement.
      ...(queryType === 'list' && local === 'posted_stock_balance'
        ? { exportMaximumResultCount: 5_000 }
        : {}),
      module: reference('moduleReference', ids.moduleId),
      permission: reference(
        'permissionReference',
        `${ids.namespace}:permission.${local}_read`,
      ),
      queryId: `${ids.namespace}:query.${local}_${queryType}`,
      queryType,
      ...(queryType === 'resolve' && resolveFieldId !== null
        ? {
            resolveMatchKeys: [
              {
                authority: 'identifier',
                field: reference('fieldReference', resolveFieldId),
                kind: 'resolveMatchKey',
                matchKeyId: `${ids.namespace}:resolve-key.${local}`,
                orderKey: 10,
                schemaVersion: version,
              },
            ],
          }
        : {}),
      schemaVersion: version,
      selections: selectedFieldIds.map((fieldId, index) => ({
        field: reference('fieldReference', fieldId),
        kind: 'querySelection',
        orderKey: (index + 1) * 10,
        schemaVersion: version,
        selectionId: `${ids.namespace}:selection.${local}_${queryType}_${String(index + 1)}`,
      })),
      sourceEntity: reference('entityReference', entityId),
      tier: 'q0',
    };
  });
}

function operations(
  ids: InventoryIds,
  local: string,
  entityId: string,
  preconditions?: StandardOperationPreconditions,
): Array<Record<string, unknown>> {
  return (
    [
      ['create', 'createRecordEffect'],
      ['update', 'updateRecordEffect'],
      ['archive', 'archiveRecordEffect'],
      ['restore', 'restoreRecordEffect'],
    ] as const
  ).map(([action, kind]) => {
    const precondition = preconditions?.[action];
    return {
      confirmation: action === 'archive' ? 'humanRequired' : 'none',
      effect: {
        entity: reference('entityReference', entityId),
        kind,
        schemaVersion: version,
      },
      kind: 'operationDefinition',
      module: reference('moduleReference', ids.moduleId),
      operationId: `${ids.namespace}:operation.${local}_${action}`,
      permission: reference(
        'permissionReference',
        `${ids.namespace}:permission.${local}_${action}`,
      ),
      ...(precondition ? { precondition } : {}),
      readBack: reference(
        'queryReference',
        `${ids.namespace}:query.${local}_get`,
      ),
      schemaVersion: version,
      tier: 'o0',
    };
  });
}

function postingOperation(ids: InventoryIds): Record<string, unknown> {
  return {
    confirmation: 'humanRequired',
    effect: {
      capability: reference('capabilityReference', ids.postingCapabilityId),
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', ids.moduleId),
    operationId: ids.operationIds.postAdjustment,
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.inventory_transaction_post`,
    ),
    precondition: fieldComparison(ids.fieldIds.transaction.state, 'equals', {
      kind: 'textValue',
      schemaVersion: version,
      value: `${ids.namespace}:option.inventory_transaction_state_draft`,
    }),
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.inventory_transaction_get`,
    ),
    schemaVersion: version,
    tier: 'o1',
  };
}

function periodLockOperations(
  ids: InventoryIds,
  entityId: string,
): Array<Record<string, unknown>> {
  return (
    [
      ['advance_period_lock', 'advance_period_lock'],
      ['reopen_period', 'reopen_period'],
    ] as const
  ).map(([operationLocalId, permissionLocalId]) => ({
    confirmation:
      operationLocalId === 'reopen_period' ? 'humanRequired' : 'none',
    effect: {
      entity: reference('entityReference', entityId),
      kind: 'updateRecordEffect',
      schemaVersion: version,
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', ids.moduleId),
    operationId: `${ids.namespace}:operation.${operationLocalId}`,
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.${permissionLocalId}`,
    ),
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.inventory_period_lock_get`,
    ),
    schemaVersion: version,
    tier: 'o0',
  }));
}

function periodLockPermissions(
  ids: InventoryIds,
  entityId: string,
): Array<Record<string, unknown>> {
  return [
    ['inventory_period_lock_read', 'read'],
    ['advance_period_lock', 'update'],
    ['reopen_period', 'update'],
  ].map(([localId, action]) => ({
    action,
    kind: 'permissionDefinition',
    label: `inventory_period_lock ${localId}`,
    permissionId: `${ids.namespace}:permission.${localId}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function relation(
  relationId: string,
  sourceEntityId: string,
  targetEntityId: string,
  orderKey: number,
  ownership: 'parentScopedChild' | 'reference' = 'parentScopedChild',
  required = true,
): Record<string, unknown> {
  return {
    archiveBehavior: 'restrict',
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: version,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey,
    ownership,
    relationId,
    required,
    schemaVersion: version,
    sourceEntity: reference('entityReference', sourceEntityId),
    targetEntity: reference('entityReference', targetEntityId),
  };
}

function permissions(
  ids: InventoryIds,
  local: string,
  entityId: string,
  readOnly: boolean,
): Array<Record<string, unknown>> {
  return (
    readOnly ? ['read'] : ['create', 'read', 'update', 'archive', 'restore']
  ).map((action) => ({
    action,
    kind: 'permissionDefinition',
    label: `${local} ${action}`,
    permissionId: `${ids.namespace}:permission.${local}_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function surfaces(
  ids: InventoryIds,
  local: string,
  label: string,
  readOnly: boolean,
  commandRecord = false,
): Array<Record<string, unknown>> {
  const descriptors: Array<
    readonly [string, string, readonly string[], 'form' | 'list' | 'record']
  > = [
    ['list', 'list', ['title', 'dataGrid'], 'list'],
    [
      'detail',
      'record',
      [
        'breadcrumb',
        'titleStatus',
        ...(commandRecord ? ['commandBar'] : []),
        'keyFacts',
      ],
      'record',
    ],
    ...(readOnly
      ? []
      : ([
          // ADR-0054. `sections` is the form: it is the only registration
          // carrying `mutationIntents.form`, and the only renderer that emits
          // the field controls and `<form id="surface-record-form">`. Without
          // it `surfaceSupportsRuntimeIntent` is false and the surface is inert
          // by construction. `commandBar` puts Save in the grammar's slot for a
          // primary action instead of the `sections` fallback. `sections` is
          // what makes the related form operable and thereby re-admits New,
          // Edit, archive and restore on the paired surfaces. `activity` is NOT
          // declared: authoring and compilation accept it, but the web registry
          // then refuses the whole surface because no renderer is registered.
          // Its absence is reported by name as `SG003_REQUIRED_SLOT` against
          // the conformance baseline, which is where this debt is expressible.
          [
            'form',
            'record',
            ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
            'form',
          ],
        ] as const)),
  ];
  return descriptors.map(([suffix, archetype, slots, surfaceRole]) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
    ),
    kind: 'surfaceDefinition',
    label: `${label} ${suffix}`,
    module: reference('moduleReference', ids.moduleId),
    schemaVersion: version,
    slots: slots.map((slot, index) => ({
      content: reference(
        'opaqueSurfaceContentReference',
        ids.contentCapabilityId,
      ),
      kind: 'surfaceSlot',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      slot,
      slotId: `${ids.namespace}:slot.${local}_${suffix}_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
    })),
    statusRoles: [],
    surfaceId: `${ids.namespace}:surface.${local}_${suffix}`,
    surfaceRole,
  }));
}

function onHandSurface(ids: InventoryIds): Record<string, unknown> {
  return {
    archetype: 'task',
    dataSource: reference('queryReference', ids.queryIds.onHand),
    kind: 'surfaceDefinition',
    label: 'On-hand lookup',
    module: reference('moduleReference', ids.moduleId),
    schemaVersion: version,
    slots: ['decision', 'scanInput', 'primaryAction'].map((slot, index) => ({
      content: reference(
        'opaqueSurfaceContentReference',
        ids.contentCapabilityId,
      ),
      kind: 'surfaceSlot',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      slot,
      slotId: `${ids.namespace}:slot.inventory_on_hand_lookup_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
    })),
    statusRoles: [],
    surfaceId: `${ids.namespace}:surface.inventory_on_hand_lookup`,
  };
}

function storageMapping(
  ids: InventoryIds,
  local: string,
  entityId: string,
): Record<string, unknown> {
  return {
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: `${ids.namespace}:storage.${local}`,
  };
}

function assertion(ids: InventoryIds, local: string): Record<string, unknown> {
  return {
    assertionId: `${ids.namespace}:assertion.${local}_walking_slice`,
    evidenceKinds: [
      'structure',
      'provider',
      'userInterface',
      'agent',
      'migration',
      'recovery',
    ],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'queryInvocation',
      query: reference('queryReference', `${ids.namespace}:query.${local}_get`),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  };
}

function onHandScopeAssertion(ids: InventoryIds): Record<string, unknown> {
  return {
    assertionId: `${ids.namespace}:assertion.inventory_movement_on_hand_scope`,
    evidenceKinds: ['structure', 'provider'],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'queryInvocation',
      query: reference('queryReference', ids.queryIds.onHand),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  };
}

function postingRouteAssertion(ids: InventoryIds): Record<string, unknown> {
  return {
    assertionId: `${ids.namespace}:assertion.inventory_transaction_post_refusal`,
    evidenceKinds: ['provider'],
    expectedDiagnosticCode: 'INVENTORY_POSTING_INPUT_INVALID',
    expectedOutcome: 'fails',
    invocation: {
      kind: 'operationInvocation',
      operation: reference(
        'operationReference',
        ids.operationIds.postAdjustment,
      ),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  };
}
