import { catalogModuleDefinition } from '../catalog/definition.js';
import { inventoryModuleDefinition } from '../inventory/definition.js';
import { locationModuleDefinition } from '../location/definition.js';
import { partyModuleDefinition } from '../party/definition.js';
import { purchasingModuleDefinition } from '../purchasing/definition.js';

const version = 'v5' as const;
const normalizationProfileVersion = 'northstar.normalization/v5' as const;

export const APPLICATION_NAMESPACE = 'northstar.app' as const;

const packageId = `${APPLICATION_NAMESPACE}:package.application`;

type CollectionName =
  | 'assertions'
  | 'entities'
  | 'fields'
  | 'operations'
  | 'permissions'
  | 'queries'
  | 'relations'
  | 'stateMachines'
  | 'storageMappings'
  | 'surfaces';

/**
 * The product application is one canonical package containing the same Party,
 * Catalog, Location, Inventory, and Purchasing definitions their standalone
 * harnesses compile. The factories are instantiated under one package
 * namespace; no definition body is copied and no separately namespaced package
 * is composed.
 *
 * Purchasing is the fifth module group, and five is exactly
 * `MAX_PRIMARY_NAVIGATION_ENTRIES`: it renders as a peer of Inventory rather
 * than as the first occupant of an overflow `More`.
 */
export function composedApplicationDefinition(): Record<string, unknown> {
  const definitions = [
    partyModuleDefinition(APPLICATION_NAMESPACE),
    catalogModuleDefinition(APPLICATION_NAMESPACE),
    locationModuleDefinition(APPLICATION_NAMESPACE),
    inventoryModuleDefinition(APPLICATION_NAMESPACE),
    purchasingModuleDefinition(APPLICATION_NAMESPACE),
  ];
  const [party, catalog, location, inventory, purchasing] = definitions;
  if (!party || !catalog || !location || !inventory || !purchasing) {
    throw new TypeError('the composed application requires five modules');
  }

  const modules = [party, catalog, location, inventory, purchasing].map(
    (definition, index) => {
      const [module] = collection(definition, 'modules');
      if (!isRecord(module)) {
        throw new TypeError('a composed module definition is missing');
      }
      return {
        ...module,
        orderKey: (index + 1) * 10,
        ownerPackageId: packageId,
      };
    },
  );

  const sharedCapability = collection(party, 'capabilityRequirements')[0];
  if (!isRecord(sharedCapability)) {
    throw new TypeError('the standard surface capability is missing');
  }
  for (const definition of [catalog, location, inventory, purchasing]) {
    const capability = collection(definition, 'capabilityRequirements')[0];
    if (JSON.stringify(capability) !== JSON.stringify(sharedCapability)) {
      throw new TypeError('module surface capability requirements diverged');
    }
  }
  const moduleCapabilities = definitions.flatMap((definition) =>
    collection(definition, 'capabilityRequirements').slice(1),
  );

  return {
    assertions: merged(definitions, 'assertions'),
    capabilityRequirements: [sharedCapability, ...moduleCapabilities],
    entities: merged(definitions, 'entities'),
    fields: merged(definitions, 'fields'),
    hashAlgorithm: 'sha256',
    impactAnalyses: [],
    kind: 'applicationPackageRevision',
    languageVersion: version,
    modules,
    normalizationProfileVersion,
    operations: merged(definitions, 'operations'),
    package: {
      kind: 'packageDefinition',
      namespace: APPLICATION_NAMESPACE,
      packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: merged(definitions, 'permissions'),
    queries: merged(definitions, 'queries'),
    relations: merged(definitions, 'relations'),
    schemaVersion: version,
    stateMachines: merged(definitions, 'stateMachines'),
    storageMappings: merged(definitions, 'storageMappings'),
    surfaces: merged(definitions, 'surfaces'),
  };
}

export const APPLICATION_IDS = Object.freeze({
  catalog: Object.freeze({
    createOperationId: `${APPLICATION_NAMESPACE}:operation.item_create`,
    fieldIds: Object.freeze({
      baseUnit: `${APPLICATION_NAMESPACE}:field.item_base_unit`,
      description: `${APPLICATION_NAMESPACE}:field.item_description`,
      name: `${APPLICATION_NAMESPACE}:field.item_name`,
      sku: `${APPLICATION_NAMESPACE}:field.item_sku`,
    }),
    formSurfaceId: `${APPLICATION_NAMESPACE}:surface.item_form`,
    listQueryId: `${APPLICATION_NAMESPACE}:query.item_list`,
    listSurfaceId: `${APPLICATION_NAMESPACE}:surface.item_list`,
  }),
  location: Object.freeze({
    createOperationId: `${APPLICATION_NAMESPACE}:operation.location_create`,
    fieldIds: Object.freeze({
      code: `${APPLICATION_NAMESPACE}:field.location_code`,
      locationType: `${APPLICATION_NAMESPACE}:field.location_type`,
      name: `${APPLICATION_NAMESPACE}:field.location_name`,
    }),
    formSurfaceId: `${APPLICATION_NAMESPACE}:surface.location_form`,
    listQueryId: `${APPLICATION_NAMESPACE}:query.location_list`,
    listSurfaceId: `${APPLICATION_NAMESPACE}:surface.location_list`,
  }),
  namespace: APPLICATION_NAMESPACE,
  packageId,
  party: Object.freeze({
    createOperationId: `${APPLICATION_NAMESPACE}:operation.party_create`,
    fieldIds: Object.freeze({
      contactSummary: `${APPLICATION_NAMESPACE}:field.party_contact_summary`,
      name: `${APPLICATION_NAMESPACE}:field.party_name`,
      number: `${APPLICATION_NAMESPACE}:field.party_number`,
    }),
    formSurfaceId: `${APPLICATION_NAMESPACE}:surface.party_form`,
    listQueryId: `${APPLICATION_NAMESPACE}:query.party_list`,
    listSurfaceId: `${APPLICATION_NAMESPACE}:surface.party_list`,
  }),
  purchasing: Object.freeze({
    cancelOperationId: `${APPLICATION_NAMESPACE}:operation.purchase_order_cancel`,
    createOperationId: `${APPLICATION_NAMESPACE}:operation.purchase_order_create`,
    detailSurfaceId: `${APPLICATION_NAMESPACE}:surface.purchase_order_detail`,
    entityIds: Object.freeze({
      purchaseOrder: `${APPLICATION_NAMESPACE}:entity.purchase_order`,
      purchaseOrderLine: `${APPLICATION_NAMESPACE}:entity.purchase_order_line`,
    }),
    fieldIds: Object.freeze({
      currency: `${APPLICATION_NAMESPACE}:field.purchase_order_currency`,
      expectedDate: `${APPLICATION_NAMESPACE}:field.purchase_order_expected_date`,
      itemId: `${APPLICATION_NAMESPACE}:field.purchase_order_line_item_id`,
      lineNumber: `${APPLICATION_NAMESPACE}:field.purchase_order_line_line_number`,
      notes: `${APPLICATION_NAMESPACE}:field.purchase_order_notes`,
      number: `${APPLICATION_NAMESPACE}:field.purchase_order_number`,
      orderDate: `${APPLICATION_NAMESPACE}:field.purchase_order_order_date`,
      orderedQuantity: `${APPLICATION_NAMESPACE}:field.purchase_order_line_ordered_quantity`,
      supplierPartyId: `${APPLICATION_NAMESPACE}:field.purchase_order_supplier_party_id`,
      unitPrice: `${APPLICATION_NAMESPACE}:field.purchase_order_line_unit_price`,
    }),
    formSurfaceId: `${APPLICATION_NAMESPACE}:surface.purchase_order_form`,
    lineCreateOperationId: `${APPLICATION_NAMESPACE}:operation.purchase_order_line_create`,
    lineDetailSurfaceId: `${APPLICATION_NAMESPACE}:surface.purchase_order_line_detail`,
    lineFormSurfaceId: `${APPLICATION_NAMESPACE}:surface.purchase_order_line_form`,
    lineListQueryId: `${APPLICATION_NAMESPACE}:query.purchase_order_line_list`,
    lineListSurfaceId: `${APPLICATION_NAMESPACE}:surface.purchase_order_line_list`,
    lineRelationId: `${APPLICATION_NAMESPACE}:relation.purchase_order_line_order`,
    lineUpdateOperationId: `${APPLICATION_NAMESPACE}:operation.purchase_order_line_update`,
    listQueryId: `${APPLICATION_NAMESPACE}:query.purchase_order_list`,
    listSurfaceId: `${APPLICATION_NAMESPACE}:surface.purchase_order_list`,
    releaseOperationId: `${APPLICATION_NAMESPACE}:operation.purchase_order_release`,
    // Materialized by normalization from the machine identity, not authored.
    // The composed application re-instantiates the module under
    // `northstar.app`, so the machine id -- and therefore this field id --
    // carry that namespace too.
    stateFieldId: `${APPLICATION_NAMESPACE}:derived_state_field.machine.purchase_order_lifecycle`,
    stateIds: Object.freeze({
      cancelled: `${APPLICATION_NAMESPACE}:state.purchase_order_cancelled`,
      draft: `${APPLICATION_NAMESPACE}:state.purchase_order_draft`,
      released: `${APPLICATION_NAMESPACE}:state.purchase_order_released`,
    }),
    updateOperationId: `${APPLICATION_NAMESPACE}:operation.purchase_order_update`,
  }),
});

function merged(
  definitions: readonly Record<string, unknown>[],
  name: CollectionName,
): unknown[] {
  return definitions.flatMap((definition) => collection(definition, name));
}

function collection(
  definition: Record<string, unknown>,
  name: CollectionName | 'capabilityRequirements' | 'modules',
): unknown[] {
  const value = definition[name];
  if (!Array.isArray(value)) {
    throw new TypeError(`module definition is missing ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
