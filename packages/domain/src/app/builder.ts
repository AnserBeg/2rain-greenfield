import {
  invoiceWorkspace,
  returnWorkspace,
  salesWorkspace,
  salesWorkspaceQueries,
  packingWorkspace,
} from '../sales/workspace.js';
import { catalogModuleDefinition } from '../catalog/definition.js';
import { inventoryModuleDefinition } from '../inventory/definition.js';
import { locationModuleDefinition } from '../location/definition.js';
import { partyModuleDefinition } from '../party/definition.js';
import { partyWorkspace } from '../party/workspace.js';
import { purchasingModuleDefinition } from '../purchasing/definition.js';
import { salesModuleDefinition } from '../sales/definition.js';
import { orderEntrySurfaces } from './order-entry.js';
import {
  declareLists,
  worklistQueries,
  worklistSurfaces,
} from './list-declarations.js';
import {
  billWorkspace,
  purchasingWorkspace,
  receivingWorkspaceQueries,
} from '../purchasing/workspace.js';
import { inventoryDocumentWorkspace } from '../inventory/workspace.js';

const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

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
 * THE ORDERED MODULE REGISTRY.
 *
 * Plan §7.2 assigned this to *"the first packet that mounts anything"*, and
 * §7.5's `PUR-1` row repeats it. Before this, `builder.ts` named every module
 * five times over — a factory list, a destructured tuple, a truthiness guard, a
 * hard-coded count in an error string, a re-listed array for module ordering,
 * and a second re-listed array for the capability comparison. Each mount had to
 * find all six and change the number in one of them.
 *
 * Order is the ONLY thing declared here, and it is load-bearing rather than
 * cosmetic: `orderKey` is derived from position, and the compiled navigation
 * tree groups by module in that order.
 */
const MODULE_REGISTRY = Object.freeze([
  Object.freeze({ create: salesModuleDefinition, moduleName: 'sales' }),
  Object.freeze({
    create: (namespace: string) =>
      purchasingModuleDefinition(namespace, {
        commercialTerms: true,
        payables: true,
      }),
    moduleName: 'purchasing',
  }),
  Object.freeze({ create: inventoryModuleDefinition, moduleName: 'inventory' }),
  Object.freeze({
    create: (namespace: string) =>
      partyModuleDefinition(namespace, { salesMasterData: true }),
    moduleName: 'party',
  }),
  Object.freeze({
    create: (namespace: string) =>
      catalogModuleDefinition(namespace, { sellingPrices: true }),
    moduleName: 'catalog',
  }),
  Object.freeze({ create: locationModuleDefinition, moduleName: 'location' }),
] as const);

/** Record surfaces presented as documents with their own lines and actions. */
const RECORD_COMPOSITIONS: Readonly<
  Record<string, (namespace: string) => Record<string, unknown>>
> = Object.freeze({
  party_detail: partyWorkspace,
  sales_order_detail: salesWorkspace,
  purchase_order_detail: purchasingWorkspace,
  shipment_detail: packingWorkspace,
  customer_return_detail: returnWorkspace,
  customer_invoice_detail: invoiceWorkspace,
  vendor_bill_detail: billWorkspace,
  inventory_transaction_detail: (namespace: string) =>
    inventoryDocumentWorkspace(namespace, 'inventory_transaction'),
  stock_count_detail: (namespace: string) =>
    inventoryDocumentWorkspace(namespace, 'stock_count'),
});

/**
 * Commercial documents whose lines lead the page (ruling B): their details --
 * ship-to, terms, charges, carrier -- follow the line tables, so the lines are
 * on the first screen however many details a document carries.
 */
const LINES_LEAD: ReadonlySet<string> = new Set([
  'sales_order_detail',
  'purchase_order_detail',
  'customer_invoice_detail',
  'vendor_bill_detail',
]);

/** Workspaces that read their record through a read-model query. */
const RECORD_DATA_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  sales_order_detail: 'commercial_order_get',
  purchase_order_detail: 'commercial_purchase_order_get',
});

/**
 * Lists that read their rows through a read-model clone of their query, such
 * as purchase orders with their totals (ORDER-PARITY). Swapped after the
 * worklists are cut from their source Lists, which keep reading plain clones.
 */
const LIST_DATA_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  purchase_order_list: 'commercial_purchase_order_list',
});

/** The mounted module names, in composition order, for callers that assert on the set. */
export const COMPOSED_MODULE_NAMES = Object.freeze(
  MODULE_REGISTRY.map((entry) => entry.moduleName),
);

/**
 * The product application is one canonical package containing the same module
 * definitions their standalone harnesses compile. The factories are
 * instantiated under one package namespace; no definition body is copied and no
 * separately namespaced package is composed.
 *
 * Adding a module is ONE registry entry. Nothing below counts, destructures, or
 * re-lists them.
 */
export function composedApplicationDefinition(): Record<string, unknown> {
  const mounted = MODULE_REGISTRY.map((entry) => {
    const definition = entry.create(APPLICATION_NAMESPACE);
    if (!isRecord(definition)) {
      throw new TypeError(
        `module ${entry.moduleName} did not produce a definition`,
      );
    }
    return { definition, moduleName: entry.moduleName };
  });
  if (mounted.length === 0) {
    throw new TypeError(
      'the composed application requires at least one module',
    );
  }
  const definitions = mounted.map((entry) => entry.definition);

  const modules = mounted.map(({ definition, moduleName }, index) => {
    const [module] = collection(definition, 'modules');
    if (!isRecord(module)) {
      throw new TypeError(`module ${moduleName} declares no moduleDefinition`);
    }
    return {
      ...module,
      orderKey: (index + 1) * 10,
      ownerPackageId: packageId,
    };
  });

  // The FIRST registry entry supplies the standard surface capability and every
  // other must match it exactly. Naming the first by position rather than by
  // module keeps this independent of which module leads the registry.
  const [lead, ...rest] = mounted;
  const sharedCapability = collection(
    lead!.definition,
    'capabilityRequirements',
  )[0];
  if (!isRecord(sharedCapability)) {
    throw new TypeError('the standard surface capability is missing');
  }
  for (const { definition, moduleName } of rest) {
    const capability = collection(definition, 'capabilityRequirements')[0];
    if (JSON.stringify(capability) !== JSON.stringify(sharedCapability)) {
      throw new TypeError(
        `module ${moduleName} surface capability requirements diverged`,
      );
    }
  }
  const moduleCapabilities = definitions.flatMap((definition) =>
    collection(definition, 'capabilityRequirements').slice(1),
  );

  return withDeclaredLists({
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
    queries: [
      ...salesWorkspaceQueries(
        APPLICATION_NAMESPACE,
        merged(definitions, 'queries') as Record<string, unknown>[],
      ),
      // A worklist reads its own clone of its source List's query.
      ...worklistQueries(
        APPLICATION_NAMESPACE,
        merged(definitions, 'queries') as Record<string, unknown>[],
      ),
      // A receipt's lines with what each can still reverse (ORDER-PARITY).
      ...receivingWorkspaceQueries(
        APPLICATION_NAMESPACE,
        merged(definitions, 'queries') as Record<string, unknown>[],
      ),
    ],
    relations: merged(definitions, 'relations'),
    schemaVersion: version,
    stateMachines: merged(definitions, 'stateMachines'),
    storageMappings: merged(definitions, 'storageMappings'),
    surfaces: orderEntrySurfaces(
      APPLICATION_NAMESPACE,
      // Worklists join the workspace pass as Lists of their own.
      withWorklistSurfaces(merged(definitions, 'surfaces')).map((surface) => {
        if (!isRecord(surface))
          throw new TypeError('surface must be an object');
        const local = String(surface.surfaceId).split(':surface.')[1] ?? '';
        const composition = RECORD_COMPOSITIONS[local]?.(APPLICATION_NAMESPACE);
        if (!composition) return surface;
        // A workspace may read its record with a read model's figures, such as
        // a sales order's totals; the record query stays the plain get.
        const dataSource = RECORD_DATA_SOURCES[local];
        const slots = surface.slots as Record<string, unknown>[];
        const slot = (name: string, suffix: string, orderKey: number) => ({
          kind: 'surfaceSlot',
          schemaVersion: version,
          slot: name,
          slotId: `${String(surface.surfaceId).replace(':surface.', ':slot.')}_${suffix}`,
          orderKey,
          content: {
            kind: 'opaqueSurfaceContentReference',
            schemaVersion: version,
            targetId: `${APPLICATION_NAMESPACE}:capability.standard_surface_content`,
          },
        });
        return {
          ...surface,
          ...(dataSource
            ? {
                dataSource: {
                  kind: 'queryReference',
                  schemaVersion: version,
                  targetId: `${APPLICATION_NAMESPACE}:query.${dataSource}`,
                },
              }
            : {}),
          composition,
          slots: [
            ...slots.map((slot) => ({
              ...slot,
              ...(slot.slot === 'keyFacts' ? { orderKey: 90 } : {}),
              ...(slot.slot === 'sections' && LINES_LEAD.has(local)
                ? { orderKey: 70 }
                : {}),
            })),
            // A composition renders its fields in `sections`; a read-only
            // document that never declared one gains it here.
            ...(slots.some((value) => value.slot === 'sections')
              ? []
              : [
                  slot('sections', 'sections', LINES_LEAD.has(local) ? 70 : 50),
                ]),
            slot('childTables', 'children', 60),
          ],
        };
      }),
      merged(definitions, 'queries') as Record<string, unknown>[],
    ),
  });
}

/** A worklist's List surface joins the composed surfaces beside its source. */
function withWorklistSurfaces(surfaces: unknown[]): unknown[] {
  return [
    ...surfaces,
    ...worklistSurfaces(
      APPLICATION_NAMESPACE,
      surfaces as Record<string, unknown>[],
    ),
  ];
}

/** Declared Lists apply after the workspace pass, over the final surfaces. */
function withDeclaredLists<
  T extends {
    queries: Record<string, unknown>[];
    surfaces: Record<string, unknown>[];
  },
>(application: T): T {
  return {
    ...application,
    surfaces: declareLists(
      APPLICATION_NAMESPACE,
      application.surfaces.map((surface) => {
        const local = String(surface.surfaceId).split(':surface.')[1] ?? '';
        const queryId = `${APPLICATION_NAMESPACE}:query.${LIST_DATA_SOURCES[local] ?? ''}`;
        // Only when the application composes the read-model query.
        return Object.hasOwn(LIST_DATA_SOURCES, local) &&
          application.queries.some((query) => query.queryId === queryId)
          ? {
              ...surface,
              dataSource: {
                kind: 'queryReference',
                schemaVersion: version,
                targetId: queryId,
              },
            }
          : surface;
      }),
    ),
  };
}

export const APPLICATION_IDS = Object.freeze({
  catalog: Object.freeze({
    createOperationId: `${APPLICATION_NAMESPACE}:operation.item_create`,
    fieldIds: Object.freeze({
      baseUnit: `${APPLICATION_NAMESPACE}:field.item_base_unit`,
      description: `${APPLICATION_NAMESPACE}:field.item_description`,
      name: `${APPLICATION_NAMESPACE}:field.item_name`,
      priceCad: `${APPLICATION_NAMESPACE}:field.item_price_cad`,
      priceEur: `${APPLICATION_NAMESPACE}:field.item_price_eur`,
      priceUsd: `${APPLICATION_NAMESPACE}:field.item_price_usd`,
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
  taxCode: Object.freeze({
    createOperationId: `${APPLICATION_NAMESPACE}:operation.tax_code_create`,
    fieldIds: Object.freeze({
      code: `${APPLICATION_NAMESPACE}:field.tax_code_code`,
      name: `${APPLICATION_NAMESPACE}:field.tax_code_name`,
      ratePercent: `${APPLICATION_NAMESPACE}:field.tax_code_rate_percent`,
    }),
  }),
  party: Object.freeze({
    address: Object.freeze({
      createOperationId: `${APPLICATION_NAMESPACE}:operation.party_address_create`,
      fieldIds: Object.freeze({
        city: `${APPLICATION_NAMESPACE}:field.party_address_city`,
        country: `${APPLICATION_NAMESPACE}:field.party_address_country`,
        label: `${APPLICATION_NAMESPACE}:field.party_address_label`,
        postalCode: `${APPLICATION_NAMESPACE}:field.party_address_postal_code`,
        recipient: `${APPLICATION_NAMESPACE}:field.party_address_recipient`,
        region: `${APPLICATION_NAMESPACE}:field.party_address_region`,
        street: `${APPLICATION_NAMESPACE}:field.party_address_street`,
      }),
      partyRelationId: `${APPLICATION_NAMESPACE}:relation.party_address_party`,
    }),
    createOperationId: `${APPLICATION_NAMESPACE}:operation.party_create`,
    fieldIds: Object.freeze({
      contactSummary: `${APPLICATION_NAMESPACE}:field.party_contact_summary`,
      defaultCurrency: `${APPLICATION_NAMESPACE}:field.party_default_currency`,
      defaultSalespersonPartyId: `${APPLICATION_NAMESPACE}:field.party_default_salesperson_party_id`,
      defaultShipToAddressId: `${APPLICATION_NAMESPACE}:field.party_default_ship_to_address_id`,
      defaultTaxCodeId: `${APPLICATION_NAMESPACE}:field.party_default_tax_code_id`,
      name: `${APPLICATION_NAMESPACE}:field.party_name`,
      number: `${APPLICATION_NAMESPACE}:field.party_number`,
      paymentTerms: `${APPLICATION_NAMESPACE}:field.party_payment_terms`,
    }),
    currencyOptionIds: Object.freeze({
      cad: `${APPLICATION_NAMESPACE}:option.party_default_currency_cad`,
      eur: `${APPLICATION_NAMESPACE}:option.party_default_currency_eur`,
      usd: `${APPLICATION_NAMESPACE}:option.party_default_currency_usd`,
    }),
    paymentTermOptionIds: Object.freeze({
      dueOnReceipt: `${APPLICATION_NAMESPACE}:option.party_payment_terms_due_on_receipt`,
      net15: `${APPLICATION_NAMESPACE}:option.party_payment_terms_net_15`,
      net30: `${APPLICATION_NAMESPACE}:option.party_payment_terms_net_30`,
      net45: `${APPLICATION_NAMESPACE}:option.party_payment_terms_net_45`,
      net60: `${APPLICATION_NAMESPACE}:option.party_payment_terms_net_60`,
    }),
    formSurfaceId: `${APPLICATION_NAMESPACE}:surface.party_form`,
    listQueryId: `${APPLICATION_NAMESPACE}:query.party_list`,
    listSurfaceId: `${APPLICATION_NAMESPACE}:surface.party_list`,
    role: Object.freeze({
      createOperationId: `${APPLICATION_NAMESPACE}:operation.party_role_create`,
      fieldIds: Object.freeze({
        kind: `${APPLICATION_NAMESPACE}:field.party_role_kind`,
        status: `${APPLICATION_NAMESPACE}:field.party_role_status`,
      }),
      optionIds: Object.freeze({
        active: `${APPLICATION_NAMESPACE}:option.active`,
        customer: `${APPLICATION_NAMESPACE}:option.customer`,
        salesperson: `${APPLICATION_NAMESPACE}:option.salesperson`,
        supplier: `${APPLICATION_NAMESPACE}:option.supplier`,
      }),
      partyRelationId: `${APPLICATION_NAMESPACE}:relation.party_role_party`,
    }),
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
  sales: Object.freeze({
    cancelOperationId: `${APPLICATION_NAMESPACE}:operation.sales_order_cancel`,
    createOperationId: `${APPLICATION_NAMESPACE}:operation.sales_order_create`,
    detailSurfaceId: `${APPLICATION_NAMESPACE}:surface.sales_order_detail`,
    entityIds: Object.freeze({
      salesOrder: `${APPLICATION_NAMESPACE}:entity.sales_order`,
      salesOrderLine: `${APPLICATION_NAMESPACE}:entity.sales_order_line`,
    }),
    fieldIds: Object.freeze({
      currency: `${APPLICATION_NAMESPACE}:field.sales_order_currency`,
      customerPartyId: `${APPLICATION_NAMESPACE}:field.sales_order_customer_party_id`,
      itemId: `${APPLICATION_NAMESPACE}:field.sales_order_line_item_id`,
      lineNumber: `${APPLICATION_NAMESPACE}:field.sales_order_line_line_number`,
      notes: `${APPLICATION_NAMESPACE}:field.sales_order_notes`,
      number: `${APPLICATION_NAMESPACE}:field.sales_order_number`,
      orderDate: `${APPLICATION_NAMESPACE}:field.sales_order_order_date`,
      orderedQuantity: `${APPLICATION_NAMESPACE}:field.sales_order_line_ordered_quantity`,
      requestedDate: `${APPLICATION_NAMESPACE}:field.sales_order_requested_date`,
      unitId: `${APPLICATION_NAMESPACE}:field.sales_order_line_unit_id`,
      unitPrice: `${APPLICATION_NAMESPACE}:field.sales_order_line_unit_price`,
    }),
    formSurfaceId: `${APPLICATION_NAMESPACE}:surface.sales_order_form`,
    lineCreateOperationId: `${APPLICATION_NAMESPACE}:operation.sales_order_line_create`,
    lineDetailSurfaceId: `${APPLICATION_NAMESPACE}:surface.sales_order_line_detail`,
    lineFormSurfaceId: `${APPLICATION_NAMESPACE}:surface.sales_order_line_form`,
    lineListQueryId: `${APPLICATION_NAMESPACE}:query.sales_order_line_list`,
    lineListSurfaceId: `${APPLICATION_NAMESPACE}:surface.sales_order_line_list`,
    lineRelationId: `${APPLICATION_NAMESPACE}:relation.sales_order_line_order`,
    lineUpdateOperationId: `${APPLICATION_NAMESPACE}:operation.sales_order_line_update`,
    listQueryId: `${APPLICATION_NAMESPACE}:query.sales_order_list`,
    listSurfaceId: `${APPLICATION_NAMESPACE}:surface.sales_order_list`,
    releaseOperationId: `${APPLICATION_NAMESPACE}:operation.sales_order_release`,
    stateFieldId: `${APPLICATION_NAMESPACE}:derived_state_field.machine.sales_order_lifecycle`,
    stateIds: Object.freeze({
      cancelled: `${APPLICATION_NAMESPACE}:state.sales_order_cancelled`,
      draft: `${APPLICATION_NAMESPACE}:state.sales_order_draft`,
      released: `${APPLICATION_NAMESPACE}:state.sales_order_released`,
    }),
    updateOperationId: `${APPLICATION_NAMESPACE}:operation.sales_order_update`,
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
