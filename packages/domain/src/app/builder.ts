import { catalogModuleDefinition } from '../catalog/definition.js';
import { inventoryModuleDefinition } from '../inventory/definition.js';
import { locationModuleDefinition } from '../location/definition.js';
import { partyModuleDefinition } from '../party/definition.js';

const version = 'v4' as const;
const normalizationProfileVersion = 'northstar.normalization/v4' as const;

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
 * Catalog, Location, and Inventory definitions their standalone harnesses
 * compile. The factories are instantiated under one package namespace; no
 * definition body is copied and no separately namespaced package is composed.
 */
export function composedApplicationDefinition(): Record<string, unknown> {
  const definitions = [
    partyModuleDefinition(APPLICATION_NAMESPACE),
    catalogModuleDefinition(APPLICATION_NAMESPACE),
    locationModuleDefinition(APPLICATION_NAMESPACE),
    inventoryModuleDefinition(APPLICATION_NAMESPACE),
  ];
  const [party, catalog, location, inventory] = definitions;
  if (!party || !catalog || !location || !inventory) {
    throw new TypeError('the composed application requires four modules');
  }

  const modules = [party, catalog, location, inventory].map(
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
  for (const definition of [catalog, location, inventory]) {
    const capability = collection(definition, 'capabilityRequirements')[0];
    if (JSON.stringify(capability) !== JSON.stringify(sharedCapability)) {
      throw new TypeError('module surface capability requirements diverged');
    }
  }

  return {
    assertions: merged(definitions, 'assertions'),
    capabilityRequirements: [sharedCapability],
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
