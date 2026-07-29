import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  compileInventoryContract,
  validateInventoryBaseUnitChange,
  validateInventoryMovementCandidate,
  type CompiledInventoryContractV1,
  type InventoryContractDiagnostic,
  type InventoryMovementCandidateV1,
} from '../../packages/compiler/src/conformance.js';
import { INVENTORY_CONTRACT_V1 } from '../../packages/domain/src/inventory/index.js';

interface MutableInventoryContract {
  authoritativeDependencies: {
    accessPlan: Array<Record<string, unknown>>;
    dependencies: Array<Record<string, unknown>>;
  };
  compiledArtifacts: Array<Record<string, unknown>>;
  configuration: {
    dials: Record<string, unknown>;
  };
  movement: {
    fields: Array<Record<string, unknown>>;
  };
  stockDimensionSet: {
    v1: Record<string, unknown>;
  };
}

type InventoryContractCase = (name: string, run: () => void) => void;

export function registerInventoryContractCases(
  register: InventoryContractCase,
): void {
  register(
    'inventory declarations compile to one deterministic quantity-only contract release',
    () => {
      const first = mustCompile();
      const second = mustCompile();
      assert.equal(first.releaseRoot, second.releaseRoot);
      assert.deepEqual(first.canonicalBytes, second.canonicalBytes);

      const contract = first.release.contract;
      const stock = contract.stockDimensionSet as {
        dimensions: string[];
        setId: string;
      };
      const movement = contract.movement as {
        fields: Array<{
          fieldId: string;
          semantic: string;
          valueShape?: Record<string, unknown>;
        }>;
        kind: string;
        updatePath: string;
      };
      const dependencies = contract.authoritativeDependencies as {
        dependencies: Array<{ access: string; dependencyId: string }>;
        exhaustiveByConstruction: boolean;
        undeclaredAccess: string;
      };

      assert.deepEqual(stock, {
        dimensions: ['legalEntityId', 'itemId', 'locationId'],
        extension: {
          addition: 'governedVersionedEvent',
          reBaselineOperationId: 'northstar.inventory:operation.re_baseline',
          removal: 'unsupported',
          unspecifiedFromVersion: 2,
        },
        setId: 'northstar.stock-dimension-set/v1',
        v1: {
          allowedVersions: ['v1'],
          membersRequiredAtPosting: true,
          unspecifiedMembers: 'structurallyUnreachable',
        },
      });
      assert.equal(movement.kind, 'quantityOnlyMovement');
      assert.equal(movement.updatePath, 'none');
      assert.deepEqual(
        movement.fields.map((field) => [field.fieldId, field.semantic]),
        [
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
        ],
      );
      assert.deepEqual(
        movement.fields.find((field) => field.fieldId === 'quantityDelta')
          ?.valueShape,
        {
          precision: 38,
          representation: 'canonicalDecimalStringV2',
          scale: 18,
          signed: true,
          unitFieldId: 'unitId',
        },
      );
      assert.equal(dependencies.exhaustiveByConstruction, true);
      assert.equal(dependencies.undeclaredAccess, 'compileFailure');
      assert.equal(dependencies.dependencies.length, 30);

      const golden = JSON.parse(
        readFileSync(
          'test/compiler/inventory-contract.release.golden.json',
          'utf8',
        ),
      ) as unknown;
      assert.deepEqual(releaseSummary(first), golden);
    },
  );

  register(
    'compiled release data is detached, frozen, and still matches its canonical bytes',
    () => {
      const candidate = mutableContract();
      const result = compileInventoryContract(candidate);
      assert.equal(result.status, 'compiled');
      candidate.configuration.dials.negativeStock = { default: 'allow' };

      assert.equal(
        result.release.release.configuration.negativeStock,
        'reject',
      );
      assert.equal(Object.isFrozen(result.release.release), true);
      assert.equal(Object.isFrozen(result.release.release.contract), true);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(result.release.canonicalBytes)),
        result.release.release,
      );
    },
  );

  register(
    'configuration rejects a missing required dial and an out-of-range value',
    () => {
      const missing = mutableContract();
      delete missing.configuration.dials.reasonRequirements;
      const missingResult = compileInventoryContract(missing);
      assert.equal(missingResult.status, 'failed');
      assert.deepEqual(diagnosticView(missingResult.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_REQUIRED',
          path: '$.configuration.dials.reasonRequirements',
          subjectId: 'reasonRequirements',
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_REQUIRED',
          path: '$.configuration.dials.reasonRequirements.default',
          subjectId: null,
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONTRACT_INVALID',
          path: '$.configuration.dials.reasonRequirements.kind',
          subjectId: 'kind',
        },
      ]);

      const outOfRange = compileInventoryContract(INVENTORY_CONTRACT_V1, {
        maximumBackdateDays: 3651,
      });
      assert.equal(outOfRange.status, 'failed');
      assert.deepEqual(diagnosticView(outOfRange.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
          path: '$.configuration.values.maximumBackdateDays',
          subjectId: '3651',
        },
      ]);
    },
  );

  register(
    'negative stock defaults from declaration data and is recorded in release bytes',
    () => {
      const compiled = mustCompile();
      assert.equal(compiled.release.configurationScope, 'legalEntity');
      assert.equal(compiled.release.configuration.negativeStock, 'reject');
      assert.match(
        new TextDecoder().decode(compiled.canonicalBytes),
        /"configuration":\{"approvalThresholds".*"negativeStock":"reject"/u,
      );

      const explicit = mustCompile({ negativeStock: 'allowWithFlag' });
      assert.equal(
        explicit.release.configuration.negativeStock,
        'allowWithFlag',
      );
      assert.notEqual(explicit.releaseRoot, compiled.releaseRoot);
    },
  );

  register(
    'approval thresholds are release-recorded exact base-unit quantities',
    () => {
      const thresholds = {
        adjustment: '12.5',
        correction: null,
        count: null,
        reBaseline: null,
        transfer: '100',
      };
      const compiled = mustCompile({ approvalThresholds: thresholds });
      assert.deepEqual(
        compiled.release.configuration.approvalThresholds,
        thresholds,
      );

      const invalid = compileInventoryContract(INVENTORY_CONTRACT_V1, {
        approvalThresholds: {
          ...thresholds,
          adjustment: '0.1234567890123456789',
        },
      });
      assert.equal(invalid.status, 'failed');
      assert.deepEqual(diagnosticView(invalid.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
          path: '$.configuration.values.approvalThresholds.adjustment',
          subjectId: 'adjustment',
        },
      ]);
    },
  );

  register(
    'money fields and movement-derived monetary artifacts fail compilation separately',
    () => {
      const moneyField = mutableContract();
      moneyField.movement.fields.push({
        fieldId: 'monetaryAmount',
        immutable: true,
        presence: 'required',
        semantic: 'money',
        valueShape: { kind: 'moneyFieldType' },
      });
      const fieldResult = compileInventoryContract(moneyField);
      assert.equal(fieldResult.status, 'failed');
      assert.deepEqual(diagnosticView(fieldResult.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path: '$.movement.fields.monetaryAmount',
          subjectId: 'monetaryAmount',
        },
      ]);

      const monetaryProjection = mutableContract();
      monetaryProjection.compiledArtifacts.push({
        artifactId: 'northstar.inventory:artifact.movement_value',
        outputSemantic: 'money',
        source: 'inventoryMovement',
      });
      const artifactResult = compileInventoryContract(monetaryProjection);
      assert.equal(artifactResult.status, 'failed');
      assert.deepEqual(diagnosticView(artifactResult.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN',
          path: '$.compiledArtifacts.outputSemantic',
          subjectId: 'northstar.inventory:artifact.movement_value',
        },
      ]);
    },
  );

  register('missing and unknown stock-dimension versions are rejected', () => {
    const compiled = mustCompile();
    const missingCandidate = validMovementCandidate();
    delete missingCandidate.stockDimensionSetVersion;

    const missing = validateInventoryMovementCandidate(
      compiled,
      missingCandidate,
    );
    assert.equal(missing.status, 'rejected');
    assert.deepEqual(diagnosticView(missing.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED',
        path: '$.movement.stockDimensionSetVersion',
        subjectId: null,
      },
    ]);

    const unknown = validateInventoryMovementCandidate(compiled, {
      ...validMovementCandidate(),
      stockDimensionSetVersion: 'v99',
    });
    assert.equal(unknown.status, 'rejected');
    assert.deepEqual(diagnosticView(unknown.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN',
        path: '$.movement.stockDimensionSetVersion',
        subjectId: 'v99',
      },
    ]);
  });

  register('v1 unspecified members are structurally unreachable', () => {
    const declaration = mutableContract();
    declaration.stockDimensionSet.v1.unspecifiedMembers = 'declared';
    const declarationResult = compileInventoryContract(declaration);
    assert.equal(declarationResult.status, 'failed');
    assert.deepEqual(diagnosticView(declarationResult.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
        path: '$.stockDimensionSet.v1.unspecifiedMembers',
        subjectId: 'unspecifiedMembers',
      },
    ]);

    const result = validateInventoryMovementCandidate(mustCompile(), {
      ...validMovementCandidate(),
      stockIdentity: {
        itemId: 'item-1',
        legalEntityId: 'entity-1',
        locationId: 'northstar.location:member.unspecified',
      },
    });
    assert.equal(result.status, 'rejected');
    assert.deepEqual(diagnosticView(result.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
        path: '$.movement.stockIdentity.locationId',
        subjectId: 'northstar.location:member.unspecified',
      },
    ]);
  });

  register(
    'movement candidates reject monetary and other undeclared fields',
    () => {
      assert.deepEqual(
        validateInventoryMovementCandidate(
          mustCompile(),
          validMovementCandidate(),
        ),
        { diagnostics: [], status: 'accepted' },
      );

      const result = validateInventoryMovementCandidate(mustCompile(), {
        ...validMovementCandidate(),
        currency: 'CAD',
        monetaryAmount: '125.00',
        warehouseNote: 'ordinary undeclared field',
      } as InventoryMovementCandidateV1);
      assert.equal(result.status, 'rejected');
      assert.deepEqual(diagnosticView(result.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path: '$.movement.currency',
          subjectId: 'currency',
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path: '$.movement.monetaryAmount',
          subjectId: 'monetaryAmount',
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONTRACT_INVALID',
          path: '$.movement.warehouseNote',
          subjectId: 'warehouseNote',
        },
      ]);
    },
  );

  register('base-unit mutation rejection names the binding movement', () => {
    const result = validateInventoryBaseUnitChange(mustCompile(), {
      bindingMovementId: 'movement-00017',
      currentBaseUnitId: 'unit.each',
      itemId: 'item-42',
      requestedBaseUnitId: 'unit.case',
    });
    assert.equal(result.status, 'rejected');
    assert.deepEqual(diagnosticView(result.diagnostics), [
      {
        bindingMovementId: 'movement-00017',
        code: 'INVENTORY_BASE_UNIT_IMMUTABLE',
        path: '$.item.baseUnitId',
        subjectId: 'item-42',
      },
    ]);
  });

  register('undeclared posting dependencies fail conformance', () => {
    for (const entry of [
      {
        access: 'read',
        authority: 'catalog',
        dependencyId: 'northstar.catalog:item.description',
      },
      {
        access: 'append',
        authority: 'trust',
        dependencyId: 'northstar.trust:undeclared_append',
      },
      {
        access: 'transition',
        authority: 'inventory',
        dependencyId: 'northstar.inventory:undeclared_transition',
      },
    ]) {
      const candidate = mutableContract();
      candidate.authoritativeDependencies.accessPlan.push(entry);
      const result = compileInventoryContract(candidate);
      assert.equal(result.status, 'failed');
      assertHasDiagnostic(
        result.diagnostics,
        'INVENTORY_POSTING_DEPENDENCY_UNDECLARED',
        '$.authoritativeDependencies.accessPlan',
        entry.dependencyId,
      );
    }

    const mutation = mutableContract();
    mutation.authoritativeDependencies.accessPlan[0]!.dependencyId =
      'northstar.context:undeclared';
    const mutationResult = compileInventoryContract(mutation);
    assert.equal(mutationResult.status, 'failed');
    assertHasDiagnostic(
      mutationResult.diagnostics,
      'INVENTORY_POSTING_DEPENDENCY_UNDECLARED',
      '$.authoritativeDependencies.accessPlan',
      'northstar.context:undeclared',
    );

    const coordinatedRemoval = mutableContract();
    coordinatedRemoval.authoritativeDependencies.dependencies.pop();
    coordinatedRemoval.authoritativeDependencies.accessPlan.pop();
    const coordinatedResult = compileInventoryContract(coordinatedRemoval);
    assert.equal(coordinatedResult.status, 'failed');
    assertHasDiagnostic(
      coordinatedResult.diagnostics,
      'INVENTORY_CONTRACT_INVALID',
      '$.authoritativeDependencies.dependencies',
      'dependencies',
    );
    assertHasDiagnostic(
      coordinatedResult.diagnostics,
      'INVENTORY_CONTRACT_INVALID',
      '$.authoritativeDependencies.accessPlan',
      'accessPlan',
    );
  });

  register('malformed artifact and dial declarations fail closed', () => {
    for (const artifact of [
      { outputSemantic: 'money' },
      {
        artifactId: 'northstar.inventory:artifact.bad_source',
        outputSemantic: 'quantity',
        source: 'movementGuess',
      },
    ]) {
      const candidate = mutableContract();
      candidate.compiledArtifacts.push(artifact);
      const result = compileInventoryContract(candidate);
      assert.equal(result.status, 'failed');
      assertHasDiagnostic(
        result.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.compiledArtifacts',
        'artifactId' in artifact ? artifact.artifactId : null,
      );
    }

    const extraDial = mutableContract();
    extraDial.configuration.dials.sameInstantOrder = {
      default: 'sourceId',
    };
    const dialResult = compileInventoryContract(extraDial);
    assert.equal(dialResult.status, 'failed');
    assertHasDiagnostic(
      dialResult.diagnostics,
      'INVENTORY_CONFIGURATION_MALFORMED',
      '$.configuration.dials.sameInstantOrder',
      'sameInstantOrder',
    );
  });

  register(
    'temporal operations, global tie-break, and the v2 decimal limit stay explicit',
    () => {
      const contract = mustCompile().release.contract;
      assert.deepEqual(contract.temporal, INVENTORY_CONTRACT_V1.temporal);
      assert.deepEqual(
        contract.sameInstantTieBreak,
        INVENTORY_CONTRACT_V1.sameInstantTieBreak,
      );
      assert.equal(
        (contract.sameInstantTieBreak as { configurable: boolean })
          .configurable,
        false,
      );

      const limit = contract.v2DecimalLimit as {
        canonicalPattern: string;
        signedSubUnitExample: string;
        signedSubUnitValues: string;
      };
      const v2Decimal = new RegExp(limit.canonicalPattern);
      assert.equal(v2Decimal.test('-0.25'), false);
      assert.equal(v2Decimal.test('-1.25'), true);
      assert.equal(limit.signedSubUnitExample, '-0.25');
      assert.equal(limit.signedSubUnitValues, 'inexpressibleUntilV3');
    },
  );
}

function mustCompile(
  configuration: Record<string, unknown> = {},
): CompiledInventoryContractV1 {
  const result = compileInventoryContract(INVENTORY_CONTRACT_V1, configuration);
  assert.equal(
    result.status,
    'compiled',
    result.status === 'failed' ? JSON.stringify(result.diagnostics) : undefined,
  );
  return result.release;
}

function mutableContract(): MutableInventoryContract {
  return structuredClone(
    INVENTORY_CONTRACT_V1,
  ) as unknown as MutableInventoryContract;
}

function validMovementCandidate(): InventoryMovementCandidateV1 {
  return {
    effectiveAt: '2026-07-28T18:00:00.000Z',
    movementId: 'movement-1',
    postingRole: 'adjustment',
    quantityDelta: '-1.25',
    recordedAt: '2026-07-28T18:00:01.000Z',
    sourceId: 'adjustment-1',
    sourceLine: '1',
    sourceType: 'inventoryAdjustment',
    stockDimensionSetVersion: 'v1',
    stockIdentity: {
      itemId: 'item-1',
      legalEntityId: 'entity-1',
      locationId: 'location-1',
    },
    unitId: 'unit.each',
  };
}

function diagnosticView(diagnostics: InventoryContractDiagnostic[]): unknown {
  return diagnostics.map(({ bindingMovementId, code, path, subjectId }) => ({
    bindingMovementId,
    code,
    path,
    subjectId,
  }));
}

function assertHasDiagnostic(
  diagnostics: InventoryContractDiagnostic[],
  code: InventoryContractDiagnostic['code'],
  path: string,
  subjectId: string | null,
): void {
  assert.equal(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code &&
        diagnostic.path === path &&
        diagnostic.subjectId === subjectId,
    ),
    true,
    JSON.stringify(diagnosticView(diagnostics)),
  );
}

function releaseSummary(compiled: CompiledInventoryContractV1): unknown {
  const contract = compiled.release.contract;
  const movement = contract.movement as {
    fields: Array<{ fieldId: string; semantic: string }>;
    kind: string;
  };
  const dependencies = contract.authoritativeDependencies as {
    dependencies: Array<{ access: string; dependencyId: string }>;
  };
  return {
    configuration: compiled.release.configuration,
    configurationScope: compiled.release.configurationScope,
    dependencySet: dependencies.dependencies.map(
      (entry) => `${entry.access}:${entry.dependencyId}`,
    ),
    movement: {
      fields: movement.fields.map((field) => ({
        fieldId: field.fieldId,
        semantic: field.semantic,
      })),
      kind: movement.kind,
    },
    releaseRoot: compiled.releaseRoot,
    stockDimensions: (contract.stockDimensionSet as { dimensions: string[] })
      .dimensions,
  };
}
