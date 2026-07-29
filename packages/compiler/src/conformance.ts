import {
  LANGUAGE_VERSION,
  canonicalizeAndHash,
  type NormalizedApplicationPackage,
} from '@north-star/canonical-model';

import { compilerDiagnostic } from './diagnostics.js';
import type { CompilerDiagnostic } from './protocol.js';

const REQUIRED_QUERY_TYPES = Object.freeze([
  'get',
  'list',
  'resolve',
  'search',
] as const);
const REQUIRED_OPERATION_EFFECTS = Object.freeze([
  'archiveRecordEffect',
  'createRecordEffect',
  'restoreRecordEffect',
  'updateRecordEffect',
] as const);
const REQUIRED_SURFACE_ROLES = Object.freeze([
  'form',
  'list',
  'record',
] as const);

const INVENTORY_CONTRACT_SCHEMA_VERSION =
  'northstar.inventory-contract/v1' as const;
const INVENTORY_CONTRACT_RELEASE_VERSION =
  'northstar.inventory-contract-release/v1' as const;
const STOCK_DIMENSION_SET_ID = 'northstar.stock-dimension-set/v1' as const;
const INVENTORY_POSTING_ROLES = Object.freeze([
  'adjustment',
  'transfer',
  'count',
  'correction',
  'reBaseline',
] as const);
const NEGATIVE_STOCK_MODES = Object.freeze([
  'reject',
  'allowWithFlag',
  'allow',
] as const);
const REASON_REQUIREMENTS = Object.freeze([
  'codeOnly',
  'codeAndNarrative',
] as const);
const CANONICAL_DECIMAL_V2 = /^(?:0|-[1-9]\d*|[1-9]\d*)(?:\.\d*[1-9])?$/;

type InventoryPostingRole = (typeof INVENTORY_POSTING_ROLES)[number];
type NegativeStockMode = (typeof NEGATIVE_STOCK_MODES)[number];
type ReasonRequirement = (typeof REASON_REQUIREMENTS)[number];

export type InventoryContractDiagnosticCode =
  | 'INVENTORY_BASE_UNIT_IMMUTABLE'
  | 'INVENTORY_CONFIGURATION_MALFORMED'
  | 'INVENTORY_CONFIGURATION_OUT_OF_RANGE'
  | 'INVENTORY_CONFIGURATION_REQUIRED'
  | 'INVENTORY_CONTRACT_INVALID'
  | 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN'
  | 'INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN'
  | 'INVENTORY_POSTING_DEPENDENCY_UNDECLARED'
  | 'INVENTORY_STOCK_DIMENSION_MEMBER_REQUIRED'
  | 'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN'
  | 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
  | 'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN';

export interface InventoryContractDiagnostic {
  bindingMovementId: string | null;
  code: InventoryContractDiagnosticCode;
  path: string;
  rule: string;
  subjectId: string | null;
}

export interface InventoryPostingConfigurationV1 {
  approvalThresholds: Readonly<Record<InventoryPostingRole, string | null>>;
  maximumBackdateDays: number;
  negativeStock: NegativeStockMode;
  reasonRequirements: Readonly<Record<InventoryPostingRole, ReasonRequirement>>;
}

export interface InventoryContractReleaseRecordV1 {
  capabilityId: string;
  capabilityVersion: number;
  configuration: InventoryPostingConfigurationV1;
  configurationScope: 'legalEntity';
  contract: Record<string, unknown>;
  schemaVersion: typeof INVENTORY_CONTRACT_RELEASE_VERSION;
}

export interface CompiledInventoryContractV1 {
  canonicalBytes: Uint8Array;
  release: InventoryContractReleaseRecordV1;
  releaseRoot: string;
}

export type InventoryContractCompileResult =
  | {
      diagnostics: [];
      release: CompiledInventoryContractV1;
      status: 'compiled';
    }
  | {
      diagnostics: InventoryContractDiagnostic[];
      release: null;
      status: 'failed';
    };

export interface InventoryMovementCandidateV1 {
  stockDimensionSetVersion?: string;
  stockIdentity?: Partial<
    Record<'legalEntityId' | 'itemId' | 'locationId', string>
  >;
}

export interface InventoryBaseUnitChangeAttemptV1 {
  bindingMovementId: string | null;
  currentBaseUnitId: string;
  itemId: string;
  requestedBaseUnitId: string;
}

export type InventoryConformanceResult =
  | { diagnostics: []; status: 'accepted' }
  | { diagnostics: InventoryContractDiagnostic[]; status: 'rejected' };
export function validateModuleConformance(
  packageRevision: NormalizedApplicationPackage,
): CompilerDiagnostic[] {
  if (packageRevision.languageVersion !== LANGUAGE_VERSION) return [];
  const diagnostics: CompilerDiagnostic[] = [];
  const storageById = new Map(
    packageRevision.storageMappings.map((mapping) => [
      mapping.storageMappingId,
      mapping,
    ]),
  );

  for (const mapping of packageRevision.storageMappings.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    if (mapping.storageClass === null || mapping.storageClass === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_STORAGE_CLASS_REQUIRED',
          'wholeModelValidation',
          '$.storageMappings.storageClass',
          mapping.storageMappingId,
        ),
      );
    } else if (mapping.storageClass === 'generatedTyped') {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_GENERATED_STORAGE_UNSUPPORTED',
          'wholeModelValidation',
          '$.storageMappings.storageClass',
          mapping.storageMappingId,
        ),
      );
    }
    if (mapping.promotion) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_STORAGE_PROMOTION_UNSUPPORTED',
          'wholeModelValidation',
          '$.storageMappings.promotion.capabilityId',
          mapping.storageMappingId,
        ),
      );
    }
  }

  for (const operation of packageRevision.operations) {
    if (
      operation.effect.kind === 'deleteRecordEffect' ||
      operation.effect.kind === 'purgeRecordEffect' ||
      operation.effect.kind === 'destroyRecordEffect'
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED',
          'wholeModelValidation',
          '$.operations.effect.kind',
          operation.operationId,
        ),
      );
    }
  }
  for (const field of packageRevision.fields) {
    if (
      field.classification === 'confidential' ||
      field.classification === 'restricted'
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'MODULE_CLASSIFICATION_UNSUPPORTED',
          'wholeModelValidation',
          '$.fields.classification',
          field.fieldId,
        ),
      );
    }
  }
  for (const query of packageRevision.queries) {
    if (
      query.queryType === 'resolve' &&
      (query.resolveMatchKeys?.length ?? 0) === 0
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED',
          'wholeModelValidation',
          '$.queries.resolveMatchKeys',
          query.queryId,
        ),
      );
    }
  }
  for (const surface of packageRevision.surfaces) {
    if (surface.renderer) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_RENDERER_FORM_UNSUPPORTED',
          'wholeModelValidation',
          '$.surfaces.renderer',
          surface.surfaceId,
        ),
      );
    }
  }

  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query]),
  );
  const operationById = new Map(
    packageRevision.operations.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  const assertedEntities = new Set<string>();
  for (const assertion of packageRevision.assertions.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    if (assertion.invocation.kind === 'queryInvocation') {
      const query = queryById.get(assertion.invocation.query.targetId);
      if (query) {
        assertedEntities.add(query.sourceEntity.targetId);
      }
    } else {
      const operation = operationById.get(
        assertion.invocation.operation.targetId,
      );
      if (operation && 'entity' in operation.effect) {
        assertedEntities.add(operation.effect.entity.targetId);
      }
    }
  }

  for (const entity of packageRevision.entities.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    const mapping = storageById.get(entity.storage.targetId);
    if (!mapping || mapping.lifecycle !== 'active') {
      missing(diagnostics, entity.entityId, 'storage');
    }

    const queryTypes = new Set(
      packageRevision.queries
        .filter(
          (query) =>
            query.lifecycle === 'active' &&
            query.tier === 'q0' &&
            query.sourceEntity.targetId === entity.entityId,
        )
        .map((query) => query.queryType),
    );
    for (const queryType of REQUIRED_QUERY_TYPES) {
      if (!queryTypes.has(queryType)) {
        missing(diagnostics, entity.entityId, `query.${queryType}`);
      }
    }

    const operationEffects = new Set(
      packageRevision.operations
        .filter(
          (operation) =>
            operation.lifecycle === 'active' &&
            operation.tier === 'o0' &&
            'entity' in operation.effect &&
            operation.effect.entity.targetId === entity.entityId,
        )
        .map((operation) => operation.effect.kind),
    );
    for (const effect of REQUIRED_OPERATION_EFFECTS) {
      if (!operationEffects.has(effect)) {
        missing(
          diagnostics,
          entity.entityId,
          `operation.${effect.replace('RecordEffect', '')}`,
        );
      }
    }

    const surfaceRoles = new Set(
      packageRevision.surfaces
        .filter((surface) => {
          if (surface.lifecycle !== 'active') return false;
          const query = queryById.get(surface.dataSource.targetId);
          return query?.sourceEntity.targetId === entity.entityId;
        })
        .map((surface) => surface.surfaceRole),
    );
    for (const role of REQUIRED_SURFACE_ROLES) {
      if (!surfaceRoles.has(role)) {
        missing(diagnostics, entity.entityId, `surface.${role}`);
      }
    }

    if (!assertedEntities.has(entity.entityId)) {
      missing(diagnostics, entity.entityId, 'verification.executableScenario');
    }
  }
  return diagnostics;
}

/**
 * Compiles the inventory posting protocol declaration independently of the
 * canonical application language. The result is canonical, content-addressed
 * release data; no runtime behavior or storage representation is emitted here.
 */
export function compileInventoryContract(
  definition: unknown,
  configuredValues: unknown = {},
): InventoryContractCompileResult {
  const diagnostics = validateInventoryContractDefinition(definition);
  if (diagnostics.length > 0 || !isRecord(definition)) {
    return failedInventoryContract(diagnostics);
  }

  const configurationResult = materializeInventoryConfiguration(
    definition,
    configuredValues,
  );
  if (configurationResult.diagnostics.length > 0) {
    return failedInventoryContract(configurationResult.diagnostics);
  }

  const release: InventoryContractReleaseRecordV1 = {
    capabilityId: definition.capabilityId as string,
    capabilityVersion: definition.capabilityVersion as number,
    configuration: configurationResult.configuration!,
    configurationScope: 'legalEntity',
    contract: definition,
    schemaVersion: INVENTORY_CONTRACT_RELEASE_VERSION,
  };

  try {
    const canonical = canonicalizeAndHash(release);
    const frozenRelease = deepFreeze(
      JSON.parse(canonical.text) as InventoryContractReleaseRecordV1,
    );
    return {
      diagnostics: [],
      release: {
        canonicalBytes: canonical.bytes,
        release: frozenRelease,
        releaseRoot: canonical.contentHash,
      },
      status: 'compiled',
    };
  } catch {
    return failedInventoryContract([
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$',
        typeof definition.capabilityId === 'string'
          ? definition.capabilityId
          : null,
      ),
    ]);
  }
}

/**
 * Conformance seam consumed by the later posting handler. It proves that v1
 * cannot accept an absent/unknown version or manufacture an `unspecified`
 * member for any launch dimension.
 */
export function validateInventoryMovementCandidate(
  compiled: CompiledInventoryContractV1,
  candidate: InventoryMovementCandidateV1,
): InventoryConformanceResult {
  const diagnostics: InventoryContractDiagnostic[] = [];
  const stock = nestedRecord(compiled.release.contract, ['stockDimensionSet']);
  const v1 = stock ? nestedRecord(stock, ['v1']) : undefined;
  const allowedVersions = v1?.allowedVersions;
  const dimensions = stock?.dimensions;
  const version = candidate.stockDimensionSetVersion;

  if (typeof version !== 'string' || version.length === 0) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED',
        '$.movement.stockDimensionSetVersion',
        null,
      ),
    );
  } else if (
    !Array.isArray(allowedVersions) ||
    !allowedVersions.includes(version)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN',
        '$.movement.stockDimensionSetVersion',
        version,
      ),
    );
  }

  if (Array.isArray(dimensions)) {
    for (const dimension of dimensions) {
      if (typeof dimension !== 'string') continue;
      const value =
        candidate.stockIdentity?.[
          dimension as keyof NonNullable<
            InventoryMovementCandidateV1['stockIdentity']
          >
        ];
      if (typeof value !== 'string' || value.length === 0) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_STOCK_DIMENSION_MEMBER_REQUIRED',
            `$.movement.stockIdentity.${dimension}`,
            dimension,
          ),
        );
      } else if (
        value === 'unspecified' ||
        value.endsWith('.unspecified') ||
        value.endsWith(':unspecified')
      ) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
            `$.movement.stockIdentity.${dimension}`,
            value,
          ),
        );
      }
    }
  }

  return inventoryConformanceResult(diagnostics);
}

/**
 * Pure operation-contract check: a changed unit is admissible only before any
 * movement binds the item. The rejection carries the exact binding movement.
 */
export function validateInventoryBaseUnitChange(
  compiled: CompiledInventoryContractV1,
  attempt: InventoryBaseUnitChangeAttemptV1,
): InventoryConformanceResult {
  if (
    attempt.currentBaseUnitId === attempt.requestedBaseUnitId ||
    attempt.bindingMovementId === null
  ) {
    return { diagnostics: [], status: 'accepted' };
  }

  const baseUnit = nestedRecord(compiled.release.contract, ['baseUnit']);
  if (baseUnit?.changeWhenBound !== 'reject') {
    return inventoryConformanceResult([
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.baseUnit.changeWhenBound',
        attempt.itemId,
      ),
    ]);
  }

  return inventoryConformanceResult([
    inventoryDiagnostic(
      'INVENTORY_BASE_UNIT_IMMUTABLE',
      '$.item.baseUnitId',
      attempt.itemId,
      attempt.bindingMovementId,
    ),
  ]);
}

function validateInventoryContractDefinition(
  definition: unknown,
): InventoryContractDiagnostic[] {
  const diagnostics: InventoryContractDiagnostic[] = [];
  if (!isRecord(definition)) {
    return [inventoryDiagnostic('INVENTORY_CONTRACT_INVALID', '$', null)];
  }

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['schemaVersion'],
    INVENTORY_CONTRACT_SCHEMA_VERSION,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['capabilityId'],
    'northstar.inventory:capability.posting',
  );
  expectInventoryLiteral(diagnostics, definition, ['capabilityVersion'], 1);

  validateStockDimensionSet(diagnostics, definition);
  validateMovementContract(diagnostics, definition);
  validateBaseUnitContract(diagnostics, definition);
  validateTemporalContract(diagnostics, definition);
  validateMonetaryBoundary(diagnostics, definition);
  validateAuthoritativeDependencies(diagnostics, definition);
  validateInventoryConfigurationDeclaration(diagnostics, definition);
  validateSameInstantRule(diagnostics, definition);
  validateV2DecimalLimit(diagnostics, definition);

  return sortInventoryDiagnostics(diagnostics);
}

function validateStockDimensionSet(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'setId'],
    STOCK_DIMENSION_SET_ID,
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['stockDimensionSet', 'dimensions'],
    ['legalEntityId', 'itemId', 'locationId'],
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['stockDimensionSet', 'v1', 'allowedVersions'],
    ['v1'],
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'v1', 'membersRequiredAtPosting'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'v1', 'unspecifiedMembers'],
    'structurallyUnreachable',
    'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'addition'],
    'governedVersionedEvent',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'reBaselineOperationId'],
    'northstar.inventory:operation.re_baseline',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'removal'],
    'unsupported',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'unspecifiedFromVersion'],
    2,
  );
}

function validateMovementContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['movement', 'kind'],
    'quantityOnlyMovement',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['movement', 'updatePath'],
    'none',
  );
  const movement = nestedRecord(definition, ['movement']);
  const fields = movement?.fields;
  if (!Array.isArray(fields)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.movement.fields',
        'northstar.inventory:capability.posting',
      ),
    );
    return;
  }

  const expected = new Map<string, string>([
    ['movementId', 'identifier'],
    ['stockDimensionSetVersion', 'stockDimensionSetVersion'],
    ['quantityDelta', 'quantity'],
    ['unitId', 'unit'],
    ['effectiveAt', 'instant'],
    ['recordedAt', 'instant'],
    ['sourceType', 'sourceType'],
    ['sourceId', 'identifier'],
    ['sourceLine', 'sourceLine'],
    ['postingRole', 'postingRole'],
  ]);
  const seen = new Set<string>();

  for (const field of fields) {
    if (!isRecord(field) || typeof field.fieldId !== 'string') {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.movement.fields',
          null,
        ),
      );
      continue;
    }
    const path = `$.movement.fields.${field.fieldId}`;
    const semantic = typeof field.semantic === 'string' ? field.semantic : '';
    const shape = isRecord(field.valueShape) ? field.valueShape : undefined;
    if (
      /(?:amount|money|value|cost|price|currency)/iu.test(field.fieldId) ||
      /(?:amount|money|monetaryValue|cost|price|currency)/iu.test(semantic) ||
      shape?.kind === 'moneyFieldType'
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path,
          field.fieldId,
        ),
      );
      continue;
    }
    if (
      !expected.has(field.fieldId) ||
      expected.get(field.fieldId) !== semantic ||
      field.immutable !== true ||
      field.presence !== 'required' ||
      seen.has(field.fieldId)
    ) {
      diagnostics.push(
        inventoryDiagnostic('INVENTORY_CONTRACT_INVALID', path, field.fieldId),
      );
      continue;
    }
    seen.add(field.fieldId);
  }

  for (const fieldId of expected.keys()) {
    if (!seen.has(fieldId)) {
      diagnostics.push(
        inventoryDiagnostic(
          fieldId === 'stockDimensionSetVersion'
            ? 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
            : 'INVENTORY_CONTRACT_INVALID',
          `$.movement.fields.${fieldId}`,
          fieldId,
        ),
      );
    }
  }

  const versionField = fields.find(
    (field) => isRecord(field) && field.fieldId === 'stockDimensionSetVersion',
  );
  const versionShape =
    isRecord(versionField) && isRecord(versionField.valueShape)
      ? versionField.valueShape
      : undefined;
  if (!sameStringArray(versionShape?.allowedValues, ['v1'])) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN',
        '$.movement.fields.stockDimensionSetVersion.valueShape.allowedValues',
        null,
      ),
    );
  }

  const quantityField = fields.find(
    (field) => isRecord(field) && field.fieldId === 'quantityDelta',
  );
  const quantityShape =
    isRecord(quantityField) && isRecord(quantityField.valueShape)
      ? quantityField.valueShape
      : undefined;
  const exactQuantityShape =
    quantityShape?.precision === 38 &&
    quantityShape.scale === 18 &&
    quantityShape.signed === true &&
    quantityShape.representation === 'canonicalDecimalStringV2' &&
    quantityShape.unitFieldId === 'unitId';
  if (!exactQuantityShape) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.movement.fields.quantityDelta.valueShape',
        'quantityDelta',
      ),
    );
  }
}

function validateBaseUnitContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const expectations: Array<[readonly string[], string]> = [
    [['baseUnit', 'bindingFact'], 'firstPostedMovement'],
    [['baseUnit', 'changeWhenBound'], 'reject'],
    [['baseUnit', 'diagnostic', 'bindingMovementField'], 'movementId'],
    [['baseUnit', 'diagnostic', 'code'], 'INVENTORY_BASE_UNIT_IMMUTABLE'],
    [['baseUnit', 'operationContract'], 'namedBaseUnitChange'],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }
  const itemFieldId = nestedValue(definition, ['baseUnit', 'itemFieldId']);
  if (
    typeof itemFieldId !== 'string' ||
    !itemFieldId.endsWith(':field.item_base_unit')
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.baseUnit.itemFieldId',
        typeof itemFieldId === 'string' ? itemFieldId : null,
      ),
    );
  }
}

function validateTemporalContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const expectations: Array<[readonly string[], string | boolean]> = [
    [['temporal', 'effectiveAt', 'source'], 'operationInput'],
    [['temporal', 'recordedAt', 'source'], 'trustedRequestContext'],
    [['temporal', 'recordedAt', 'updatePath'], 'none'],
    [['temporal', 'recordedAt', 'projectionRetention'], 'required'],
    [
      ['temporal', 'businessCalendar', 'timeZone'],
      'tenantDeclaredIanaRequired',
    ],
    [
      ['temporal', 'businessCalendar', 'businessDayBoundary'],
      'tenantDeclaredRequired',
    ],
    [['temporal', 'businessCalendar', 'utcDefault'], 'forbidden'],
    [['temporal', 'periodLock', 'closedThroughScope'], 'legalEntity'],
    [['temporal', 'periodLock', 'enforcement'], 'insidePostingTransaction'],
    [
      ['temporal', 'periodLock', 'advance', 'operationId'],
      'northstar.inventory:operation.advance_period_lock',
    ],
    [
      ['temporal', 'periodLock', 'advance', 'permissionId'],
      'northstar.inventory:permission.advance_period_lock',
    ],
    [['temporal', 'periodLock', 'advance', 'audited'], true],
    [
      ['temporal', 'periodLock', 'reopen', 'operationId'],
      'northstar.inventory:operation.reopen_period',
    ],
    [
      ['temporal', 'periodLock', 'reopen', 'permissionId'],
      'northstar.inventory:permission.reopen_period',
    ],
    [['temporal', 'periodLock', 'reopen', 'audited'], true],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }
}

function validateMonetaryBoundary(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const expectations: Array<[readonly string[], string]> = [
    [['monetaryBoundary', 'movementAmountFields'], 'forbidden'],
    [
      ['monetaryBoundary', 'movementDerivedMonetaryArtifacts'],
      'compileFailure',
    ],
    [['monetaryBoundary', 'receiptCostOwner'], 'G4'],
    [['monetaryBoundary', 'valuationCapability'], 'unsupported'],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }

  const artifacts = definition.compiledArtifacts;
  if (!Array.isArray(artifacts)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.compiledArtifacts',
        null,
      ),
    );
    return;
  }
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) continue;
    const output =
      typeof artifact.outputSemantic === 'string'
        ? artifact.outputSemantic
        : '';
    if (
      artifact.source === 'inventoryMovement' &&
      /(?:amount|money|monetary|value|cost|price|currency)/iu.test(output)
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN',
          '$.compiledArtifacts.outputSemantic',
          typeof artifact.artifactId === 'string' ? artifact.artifactId : null,
        ),
      );
    }
  }
}

function validateAuthoritativeDependencies(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'version'],
    1,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'exhaustiveByConstruction'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'undeclaredAccess'],
    'compileFailure',
  );
  const dependencyContract = nestedRecord(definition, [
    'authoritativeDependencies',
  ]);
  const dependencies = dependencyContract?.dependencies;
  const accessPlan = dependencyContract?.accessPlan;
  if (!Array.isArray(dependencies) || !Array.isArray(accessPlan)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.authoritativeDependencies',
        'northstar.inventory:capability.posting',
      ),
    );
    return;
  }

  const declared = new Set<string>();
  for (const entry of dependencies) {
    const key = inventoryDependencyKey(entry);
    if (key === null || declared.has(key)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.authoritativeDependencies.dependencies',
          isRecord(entry) && typeof entry.dependencyId === 'string'
            ? entry.dependencyId
            : null,
        ),
      );
      continue;
    }
    declared.add(key);
  }

  for (const entry of accessPlan) {
    const key = inventoryDependencyKey(entry);
    if (key !== null && declared.has(key)) continue;
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_POSTING_DEPENDENCY_UNDECLARED',
        '$.authoritativeDependencies.accessPlan',
        isRecord(entry) && typeof entry.dependencyId === 'string'
          ? entry.dependencyId
          : null,
      ),
    );
  }
}

function validateInventoryConfigurationDeclaration(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'scope'],
    'legalEntity',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'valuesAreReleaseRecorded'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'version'],
    1,
  );
  const dials = nestedRecord(definition, ['configuration', 'dials']);
  for (const dialName of [
    'negativeStock',
    'reasonRequirements',
    'approvalThresholds',
    'maximumBackdateDays',
  ]) {
    if (!dials || !Object.hasOwn(dials, dialName)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_REQUIRED',
          `$.configuration.dials.${dialName}`,
          dialName,
        ),
      );
    }
  }
  if (!dials) return;

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'kind'],
    'enum',
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'values'],
    NEGATIVE_STOCK_MODES,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'default'],
    'reject',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'evaluation'],
    'insidePostingTransactionAgainstSerializedState',
  );

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'reasonRequirements', 'kind'],
    'postingRoleReasonMap',
  );
  const reasonDefaults = nestedValue(definition, [
    'configuration',
    'dials',
    'reasonRequirements',
    'default',
  ]);
  validateReasonMap(
    diagnostics,
    reasonDefaults,
    '$.configuration.dials.reasonRequirements.default',
    'INVENTORY_CONFIGURATION_REQUIRED',
  );

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'kind'],
    'postingRoleExactQuantityMap',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'exactBaseUnit'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'precision'],
    38,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'scale'],
    18,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'comparison'],
    'absoluteQuantityGreaterThan',
  );
  const thresholdDefaults = nestedValue(definition, [
    'configuration',
    'dials',
    'approvalThresholds',
    'default',
  ]);
  validateApprovalMap(
    diagnostics,
    thresholdDefaults,
    '$.configuration.dials.approvalThresholds.default',
    'INVENTORY_CONFIGURATION_REQUIRED',
  );

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'kind'],
    'integer',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'minimum'],
    0,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'maximum'],
    3650,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'default'],
    0,
  );
}

function validateSameInstantRule(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'scope'],
    'global',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'configurable'],
    false,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'rule'],
    'ascendingCanonicalValueOrder',
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'ordering'],
    [
      'effectiveAt',
      'recordedAt',
      'sourceType',
      'sourceId',
      'sourceLine',
      'postingRole',
      'movementId',
    ],
  );
}

function validateV2DecimalLimit(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'canonicalPattern'],
    '^(?:0|-[1-9]\\d*|[1-9]\\d*)(?:\\.\\d*[1-9])?$',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'fieldShapePermitted'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'signedSubUnitExample'],
    '-0.25',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'signedSubUnitValues'],
    'inexpressibleUntilV3',
  );
}

function materializeInventoryConfiguration(
  definition: Record<string, unknown>,
  configuredValues: unknown,
): {
  configuration: InventoryPostingConfigurationV1 | null;
  diagnostics: InventoryContractDiagnostic[];
} {
  if (!isRecord(configuredValues)) {
    return {
      configuration: null,
      diagnostics: [
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_MALFORMED',
          '$.configuration.values',
          null,
        ),
      ],
    };
  }

  const diagnostics: InventoryContractDiagnostic[] = [];
  const allowedKeys = new Set([
    'approvalThresholds',
    'maximumBackdateDays',
    'negativeStock',
    'reasonRequirements',
  ]);
  for (const key of Object.keys(configuredValues)) {
    if (!allowedKeys.has(key)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_MALFORMED',
          `$.configuration.values.${key}`,
          key,
        ),
      );
    }
  }

  const dials = nestedRecord(definition, ['configuration', 'dials'])!;
  const negativeStockDial = nestedRecord(dials, ['negativeStock'])!;
  const backdateDial = nestedRecord(dials, ['maximumBackdateDays'])!;
  const reasonDial = nestedRecord(dials, ['reasonRequirements'])!;
  const approvalDial = nestedRecord(dials, ['approvalThresholds'])!;

  const negativeStock = Object.hasOwn(configuredValues, 'negativeStock')
    ? configuredValues.negativeStock
    : negativeStockDial.default;
  if (
    typeof negativeStock !== 'string' ||
    !(NEGATIVE_STOCK_MODES as readonly string[]).includes(negativeStock)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONFIGURATION_MALFORMED',
        '$.configuration.values.negativeStock',
        typeof negativeStock === 'string' ? negativeStock : null,
      ),
    );
  }

  const maximumBackdateDays = Object.hasOwn(
    configuredValues,
    'maximumBackdateDays',
  )
    ? configuredValues.maximumBackdateDays
    : backdateDial.default;
  if (
    typeof maximumBackdateDays !== 'number' ||
    !Number.isSafeInteger(maximumBackdateDays) ||
    maximumBackdateDays < Number(backdateDial.minimum) ||
    maximumBackdateDays > Number(backdateDial.maximum)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
        '$.configuration.values.maximumBackdateDays',
        typeof maximumBackdateDays === 'number'
          ? String(maximumBackdateDays)
          : null,
      ),
    );
  }

  const reasonRequirements = Object.hasOwn(
    configuredValues,
    'reasonRequirements',
  )
    ? configuredValues.reasonRequirements
    : reasonDial.default;
  validateReasonMap(
    diagnostics,
    reasonRequirements,
    '$.configuration.values.reasonRequirements',
    'INVENTORY_CONFIGURATION_MALFORMED',
  );

  const approvalThresholds = Object.hasOwn(
    configuredValues,
    'approvalThresholds',
  )
    ? configuredValues.approvalThresholds
    : approvalDial.default;
  validateApprovalMap(
    diagnostics,
    approvalThresholds,
    '$.configuration.values.approvalThresholds',
    'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
  );

  if (diagnostics.length > 0) {
    return {
      configuration: null,
      diagnostics: sortInventoryDiagnostics(diagnostics),
    };
  }
  return {
    configuration: {
      approvalThresholds: approvalThresholds as Record<
        InventoryPostingRole,
        string | null
      >,
      maximumBackdateDays: maximumBackdateDays as number,
      negativeStock: negativeStock as NegativeStockMode,
      reasonRequirements: reasonRequirements as Record<
        InventoryPostingRole,
        ReasonRequirement
      >,
    },
    diagnostics: [],
  };
}

function validateReasonMap(
  diagnostics: InventoryContractDiagnostic[],
  value: unknown,
  path: string,
  code: InventoryContractDiagnosticCode,
): void {
  if (!isRecord(value) || !hasExactKeys(value, INVENTORY_POSTING_ROLES)) {
    diagnostics.push(inventoryDiagnostic(code, path, null));
    return;
  }
  for (const role of INVENTORY_POSTING_ROLES) {
    if (!(REASON_REQUIREMENTS as readonly unknown[]).includes(value[role])) {
      diagnostics.push(inventoryDiagnostic(code, `${path}.${role}`, role));
    }
  }
}

function validateApprovalMap(
  diagnostics: InventoryContractDiagnostic[],
  value: unknown,
  path: string,
  code: InventoryContractDiagnosticCode,
): void {
  if (!isRecord(value) || !hasExactKeys(value, INVENTORY_POSTING_ROLES)) {
    diagnostics.push(inventoryDiagnostic(code, path, null));
    return;
  }
  for (const role of INVENTORY_POSTING_ROLES) {
    const threshold = value[role];
    if (
      threshold !== null &&
      (typeof threshold !== 'string' ||
        threshold.startsWith('-') ||
        !canonicalDecimalWithin(threshold, 38, 18))
    ) {
      diagnostics.push(inventoryDiagnostic(code, `${path}.${role}`, role));
    }
  }
}

function canonicalDecimalWithin(
  value: string,
  precision: number,
  scale: number,
): boolean {
  if (!CANONICAL_DECIMAL_V2.test(value)) return false;
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer = '', fractional = ''] = unsigned.split('.');
  return (
    integer.length + fractional.length <= precision &&
    fractional.length <= scale
  );
}

function validateSameValue(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

function expectInventoryLiteral(
  diagnostics: InventoryContractDiagnostic[],
  root: Record<string, unknown>,
  path: readonly string[],
  expected: unknown,
  code: InventoryContractDiagnosticCode = 'INVENTORY_CONTRACT_INVALID',
): void {
  if (validateSameValue(nestedValue(root, path), expected)) return;
  diagnostics.push(
    inventoryDiagnostic(code, `$.${path.join('.')}`, path.at(-1) ?? null),
  );
}

function expectInventoryStringArray(
  diagnostics: InventoryContractDiagnostic[],
  root: Record<string, unknown>,
  path: readonly string[],
  expected: readonly string[],
): void {
  if (sameStringArray(nestedValue(root, path), expected)) return;
  diagnostics.push(
    inventoryDiagnostic(
      'INVENTORY_CONTRACT_INVALID',
      `$.${path.join('.')}`,
      path.at(-1) ?? null,
    ),
  );
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function inventoryDependencyKey(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.dependencyId !== 'string' ||
    typeof value.access !== 'string' ||
    typeof value.authority !== 'string'
  ) {
    return null;
  }
  if (!['read', 'append', 'transition'].includes(value.access)) return null;
  if (
    ![
      'trustedContext',
      'operationInput',
      'catalog',
      'location',
      'party',
      'inventory',
      'trust',
    ].includes(value.authority)
  ) {
    return null;
  }
  return `${value.access}\0${value.authority}\0${value.dependencyId}`;
}

function nestedRecord(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | undefined {
  const value = nestedValue(root, path);
  return isRecord(value) ? value : undefined;
}

function nestedValue(
  root: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return sameStringArray(actual, keys);
}

const INVENTORY_DIAGNOSTIC_RULES: Readonly<
  Record<InventoryContractDiagnosticCode, string>
> = Object.freeze({
  INVENTORY_BASE_UNIT_IMMUTABLE:
    'an item base unit cannot change after the first posted movement binds it',
  INVENTORY_CONFIGURATION_MALFORMED:
    'inventory posting configuration accepts only its declared typed dials',
  INVENTORY_CONFIGURATION_OUT_OF_RANGE:
    'inventory posting configuration values remain inside their declared exact bounds',
  INVENTORY_CONFIGURATION_REQUIRED:
    'every required inventory posting dial declares its type and release-recorded default',
  INVENTORY_CONTRACT_INVALID:
    'the inventory posting capability compiles only its frozen v1 declaration shape',
  INVENTORY_MOVEMENT_MONEY_FORBIDDEN:
    'an inventory movement is a quantity-only fact and carries no monetary field',
  INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN:
    'no compiled artifact derives a monetary value from inventory movement facts',
  INVENTORY_POSTING_DEPENDENCY_UNDECLARED:
    'inventory posting reads and writes only through its published authoritative dependency set',
  INVENTORY_STOCK_DIMENSION_MEMBER_REQUIRED:
    'every v1 stock dimension has a real required value at posting',
  INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN:
    'v1 stock dimensions cannot manufacture an unspecified member',
  INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED:
    'every inventory movement declares the stock-dimension-set version it uses',
  INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN:
    'an inventory movement uses only a known released stock-dimension-set version',
});

function inventoryDiagnostic(
  code: InventoryContractDiagnosticCode,
  path: string,
  subjectId: string | null,
  bindingMovementId: string | null = null,
): InventoryContractDiagnostic {
  return {
    bindingMovementId,
    code,
    path,
    rule: INVENTORY_DIAGNOSTIC_RULES[code],
    subjectId,
  };
}

function sortInventoryDiagnostics(
  diagnostics: InventoryContractDiagnostic[],
): InventoryContractDiagnostic[] {
  return diagnostics.sort(
    (left, right) =>
      compareInventoryCodeUnits(left.path, right.path) ||
      compareInventoryCodeUnits(left.code, right.code) ||
      compareInventoryCodeUnits(left.subjectId ?? '', right.subjectId ?? ''),
  );
}

function compareInventoryCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failedInventoryContract(
  diagnostics: InventoryContractDiagnostic[],
): InventoryContractCompileResult {
  return {
    diagnostics: sortInventoryDiagnostics(diagnostics),
    release: null,
    status: 'failed',
  };
}

function inventoryConformanceResult(
  diagnostics: InventoryContractDiagnostic[],
): InventoryConformanceResult {
  return diagnostics.length === 0
    ? { diagnostics: [], status: 'accepted' }
    : {
        diagnostics: sortInventoryDiagnostics(diagnostics),
        status: 'rejected',
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function missing(
  diagnostics: CompilerDiagnostic[],
  entityId: string,
  family: string,
): void {
  diagnostics.push(
    compilerDiagnostic(
      'COMPILER_ENTITY_PROJECTION_MISSING',
      'wholeModelValidation',
      `$.conformance.${family}`,
      entityId,
    ),
  );
}
