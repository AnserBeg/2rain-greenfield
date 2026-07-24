import {
  LANGUAGE_VERSION,
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
