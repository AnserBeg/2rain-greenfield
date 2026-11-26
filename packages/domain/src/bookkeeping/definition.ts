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
export const LEDGER_ACCOUNT_PUT_CAPABILITY_ID =
  'northstar.ledger:capability.ledger_account_put' as const;

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
      accountPut: `${namespace}:operation.bookkeeping_account_put`,
      booksStart: `${namespace}:operation.bookkeeping_books_start_set`,
    },
    packageId: `${namespace}:package.bookkeeping_books`,
    permissionIds: {
      accountPut: `${namespace}:permission.bookkeeping_account_put`,
      booksStart: `${namespace}:permission.bookkeeping_books_start_set`,
    },
  } as const;
}

const ledgerCapability = (capabilityId: string) => ({
  capabilityId,
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
});

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
 * engine owns their storage and refusals (ADR-0093): books start and putting
 * an account.
 */
export function bookkeepingModuleDefinition(
  namespace: string,
  company: BookkeepingCompanyRecord,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  /** A confirmation-class operation on the company record, run by a ledger capability. */
  const ledgerOperation = (
    operationId: string,
    label: string,
    capabilityId: string,
    permissionId: string,
  ) => ({
    confirmation: 'humanRequired',
    effect: {
      capability: reference('capabilityReference', capabilityId),
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
    },
    kind: 'operationDefinition',
    label,
    module: reference('moduleReference', definitionIds.moduleId),
    operationId,
    permission: reference('permissionReference', permissionId),
    readBack: reference('queryReference', company.getQueryId),
    schemaVersion: version,
    tier: 'o1',
  });
  const ledgerPermission = (permissionId: string, label: string) => ({
    action: 'transition',
    kind: 'permissionDefinition',
    label,
    permissionId,
    resource: reference('entityReference', company.entityId),
    schemaVersion: version,
  });
  return {
    assertions: [],
    capabilityRequirements: [
      standardSurfaceCapability(namespace),
      ...[
        LEDGER_BOOKS_START_CAPABILITY_ID,
        LEDGER_ACCOUNT_PUT_CAPABILITY_ID,
      ].map(ledgerCapability),
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
      ledgerOperation(
        definitionIds.operationIds.booksStart,
        'Set books start',
        LEDGER_BOOKS_START_CAPABILITY_ID,
        definitionIds.permissionIds.booksStart,
      ),
      ledgerOperation(
        definitionIds.operationIds.accountPut,
        'Put account',
        LEDGER_ACCOUNT_PUT_CAPABILITY_ID,
        definitionIds.permissionIds.accountPut,
      ),
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
      ledgerPermission(
        definitionIds.permissionIds.booksStart,
        'Set books start',
      ),
      ledgerPermission(definitionIds.permissionIds.accountPut, 'Put account'),
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
