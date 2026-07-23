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
const REQUIRED_VERIFICATION_EVIDENCE = Object.freeze([
  'agent',
  'migration',
  'provider',
  'structure',
  'userInterface',
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
  const assertedEvidenceByEntity = new Map<string, Set<string>>();
  for (const assertion of packageRevision.assertions.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    if (assertion.invocation.kind === 'queryInvocation') {
      const query = queryById.get(assertion.invocation.query.targetId);
      if (query) {
        addEvidence(
          assertedEvidenceByEntity,
          query.sourceEntity.targetId,
          assertion.evidenceKinds,
        );
      }
    } else {
      const operation = operationById.get(
        assertion.invocation.operation.targetId,
      );
      if (operation && 'entity' in operation.effect) {
        addEvidence(
          assertedEvidenceByEntity,
          operation.effect.entity.targetId,
          assertion.evidenceKinds,
        );
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

    const evidence = assertedEvidenceByEntity.get(entity.entityId);
    if (
      !evidence ||
      REQUIRED_VERIFICATION_EVIDENCE.some((kind) => !evidence.has(kind))
    ) {
      missing(diagnostics, entity.entityId, 'verification');
    }
  }
  return diagnostics;
}

function addEvidence(
  evidenceByEntity: Map<string, Set<string>>,
  entityId: string,
  evidenceKinds: readonly string[],
): void {
  const evidence = evidenceByEntity.get(entityId) ?? new Set<string>();
  for (const kind of evidenceKinds) evidence.add(kind);
  evidenceByEntity.set(entityId, evidence);
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
