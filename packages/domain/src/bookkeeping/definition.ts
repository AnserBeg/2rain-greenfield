const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const BOOKKEEPING_NAMESPACE = 'northstar.bookkeeping' as const;

/**
 * The ledger engine's registered capabilities (ADR-0093). Their local names
 * are names of the `ledger` engine itself, never first-party vocabulary, so
 * the engine's own files may name them.
 */
export const LEDGER_BOOKS_START_CAPABILITY_ID =
  'northstar.ledger:capability.ledger_books_start' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

/** Where a company lives: the released legal-entity master, owned elsewhere. */
export interface BookkeepingCompanyRecord {
  readonly entityId: string;
  readonly getQueryId: string;
}

function ids(namespace: string) {
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    moduleId: `${namespace}:module.bookkeeping_books`,
    namespace,
    operationIds: {
      booksStart: `${namespace}:operation.bookkeeping_books_start_set`,
    },
    packageId: `${namespace}:package.bookkeeping_books`,
    permissionIds: {
      booksStart: `${namespace}:permission.bookkeeping_books_start_set`,
    },
  } as const;
}

const standardSurfaceCapability = (namespace: string) => ({
  capabilityId: `${namespace}:capability.standard_surface_content`,
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
});

/**
 * ACCOUNTING-1 slice 1a-ii: books by hand. The confirmation-class ledger
 * operations act on a company, the released legal-entity record; the ledger
 * engine owns their storage and refusals (ADR-0093). This first cut declares
 * books start only.
 */
export function bookkeepingModuleDefinition(
  namespace: string,
  company: BookkeepingCompanyRecord,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  return {
    assertions: [],
    capabilityRequirements: [
      standardSurfaceCapability(namespace),
      {
        capabilityId: LEDGER_BOOKS_START_CAPABILITY_ID,
        capabilityVersion: 1,
        declaredEffects: ['recordMutation'],
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
    ],
    entities: [],
    fields: [],
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
        label: 'Books',
        moduleId: definitionIds.moduleId,
        orderKey: 10,
        ownerPackageId: definitionIds.packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: [
      {
        confirmation: 'humanRequired',
        effect: {
          capability: reference(
            'capabilityReference',
            LEDGER_BOOKS_START_CAPABILITY_ID,
          ),
          kind: 'registeredCapabilityEffect',
          schemaVersion: version,
        },
        kind: 'operationDefinition',
        label: 'Set books start',
        module: reference('moduleReference', definitionIds.moduleId),
        operationId: definitionIds.operationIds.booksStart,
        permission: reference(
          'permissionReference',
          definitionIds.permissionIds.booksStart,
        ),
        readBack: reference('queryReference', company.getQueryId),
        schemaVersion: version,
        tier: 'o1',
      },
    ],
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId: definitionIds.packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      {
        action: 'transition',
        kind: 'permissionDefinition',
        label: 'Set books start',
        permissionId: definitionIds.permissionIds.booksStart,
        resource: reference('entityReference', company.entityId),
        schemaVersion: version,
      },
    ],
    queries: [],
    relations: [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [],
    surfaces: [],
  };
}

export const BOOKKEEPING_IDS = Object.freeze(ids(BOOKKEEPING_NAMESPACE));
