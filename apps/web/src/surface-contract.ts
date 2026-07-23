import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import type { RegisteredOperationDefinition } from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  registeredQueryFromPinnedView,
  type RegisteredQueryDefinition,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

export const SURFACE_MANIFEST_PAYLOAD_VERSION =
  'northstar.surface-manifest-payload/v0-provisional' as const;

const archetypes = ['builder', 'home', 'list', 'record', 'task'] as const;
const lifecycleValues = ['active', 'retired'] as const;
const statusRoles = ['attention', 'blocked', 'inProgress', 'success'] as const;
const surfaceRoles = ['form', 'list', 'record'] as const;
const operationCatalogPayloadVersion =
  'northstar.operation-catalog-payload/v0-provisional' as const;
const slotsByArchetype = Object.freeze({
  builder: Object.freeze([
    'modeSwitch',
    'selection',
    'properties',
    'draftBanner',
    'publishDiff',
  ]),
  home: Object.freeze(['exceptions', 'setupChecklist']),
  list: Object.freeze(['title', 'savedViews', 'dataGrid', 'bulkActions']),
  record: Object.freeze([
    'breadcrumb',
    'titleStatus',
    'commandBar',
    'keyFacts',
    'sections',
    'childTables',
    'activity',
  ]),
  task: Object.freeze(['decision', 'scanInput', 'primaryAction']),
});

export type CompiledSurfaceArchetype = (typeof archetypes)[number];
export type CompiledSurfaceStatusRole = (typeof statusRoles)[number];
export type CompiledSurfaceRole = (typeof surfaceRoles)[number];
export type SurfaceOperationIntent =
  'archive' | 'create' | 'restore' | 'update';

export interface CompiledSurfaceSlot {
  readonly contentReferenceId: string;
  readonly orderKey: number;
  readonly slot: string;
  readonly slotId: string;
}

export interface CompiledSurfaceDefinition {
  readonly archetype: CompiledSurfaceArchetype;
  readonly dataSourceQueryId: string;
  readonly fieldIds: readonly string[];
  readonly label: string;
  readonly lifecycle: (typeof lifecycleValues)[number];
  readonly slots: readonly CompiledSurfaceSlot[];
  readonly statusRoles: readonly CompiledSurfaceStatusRole[];
  readonly surfaceId: string;
  readonly surfaceRole: CompiledSurfaceRole | null;
}

export interface CompiledSurfaceOperationBinding {
  readonly confirmation: RegisteredOperationDefinition['confirmation'];
  readonly intent: SurfaceOperationIntent;
  readonly operationId: string;
}

export interface CompiledSurfaceDataBinding {
  readonly operations: readonly CompiledSurfaceOperationBinding[];
  readonly query: RegisteredQueryDefinition;
}

export interface CompiledSurfaceManifest {
  readonly kind: 'surfaceManifestPayload';
  readonly schemaVersion: typeof SURFACE_MANIFEST_PAYLOAD_VERSION;
  readonly surfaces: readonly CompiledSurfaceDefinition[];
}

export class SurfaceProjectionError extends Error {
  override readonly name = 'SurfaceProjectionError';

  constructor(
    readonly code:
      | 'DUPLICATE_SURFACE_ID'
      | 'INVALID_SURFACE_BINDING'
      | 'INVALID_SURFACE_MANIFEST'
      | 'INVALID_SURFACE_SLOT'
      | 'UNSUPPORTED_SURFACE_VERSION',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolves a surface's semantic read/write binding exclusively from the
 * request-pinned projections. Operation IDs are never selected by browser
 * input and physical storage metadata is not part of this contract.
 */
export function readCompiledSurfaceDataBinding(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
): CompiledSurfaceDataBinding {
  assertRequestRuntimeView(view);
  const query = registeredQueryFromPinnedView(view, surface.dataSourceQueryId);
  if (!query) {
    throw invalidBinding(
      'surface query is not registered in the pinned release',
    );
  }
  const queryFieldIds = query.selections.map((selection) => selection.fieldId);
  if (
    queryFieldIds.length !== surface.fieldIds.length ||
    queryFieldIds.some((fieldId, index) => fieldId !== surface.fieldIds[index])
  ) {
    throw invalidBinding(
      'surface fields do not match the pinned data-source query selections',
    );
  }

  const projection = view.projections.operation;
  const payload = projection.payload;
  if (
    projection.payloadSchemaVersion !== operationCatalogPayloadVersion ||
    !isRecord(payload) ||
    payload.kind !== 'operationCatalogPayload' ||
    payload.schemaVersion !== operationCatalogPayloadVersion ||
    !Array.isArray(payload.operations)
  ) {
    throw invalidBinding('pinned operation catalog has an invalid envelope');
  }

  const byIntent = new Map<
    SurfaceOperationIntent,
    CompiledSurfaceOperationBinding
  >();
  for (const value of payload.operations) {
    const operation = parseOperationBinding(value);
    if (
      operation.lifecycle !== 'active' ||
      operation.tier !== 'o0' ||
      operation.entityId !== query.sourceEntityId
    ) {
      continue;
    }
    if (byIntent.has(operation.intent)) {
      throw invalidBinding(
        `surface entity has more than one active O0 ${operation.intent} operation`,
      );
    }
    byIntent.set(
      operation.intent,
      Object.freeze({
        confirmation: operation.confirmation,
        intent: operation.intent,
        operationId: operation.operationId,
      }),
    );
  }

  return Object.freeze({
    operations: Object.freeze(
      [...byIntent.values()].sort((left, right) =>
        left.intent.localeCompare(right.intent),
      ),
    ),
    query,
  });
}

/**
 * SurfaceRuntime accepts only the surface projection from an issued Freeze D
 * view. It never accepts a release, tenant, or surface manifest separately.
 */
export function readCompiledSurfaceManifest(
  view: RuntimeViewContract.RequestRuntimeView,
): CompiledSurfaceManifest {
  assertRequestRuntimeView(view);
  const projection = view.projections.surface;
  if (projection.payloadSchemaVersion !== SURFACE_MANIFEST_PAYLOAD_VERSION) {
    throw new SurfaceProjectionError(
      'UNSUPPORTED_SURFACE_VERSION',
      `unsupported surface payload version ${projection.payloadSchemaVersion}`,
    );
  }

  const payload = projection.payload;
  if (
    !isRecord(payload) ||
    payload.kind !== 'surfaceManifestPayload' ||
    payload.schemaVersion !== SURFACE_MANIFEST_PAYLOAD_VERSION ||
    !Array.isArray(payload.surfaces)
  ) {
    throw new SurfaceProjectionError(
      'INVALID_SURFACE_MANIFEST',
      'compiled surface projection has an invalid envelope',
    );
  }

  const seenSurfaceIds = new Set<string>();
  const surfaces = payload.surfaces.map((value, index) => {
    const surface = parseSurface(value, index);
    if (seenSurfaceIds.has(surface.surfaceId)) {
      throw new SurfaceProjectionError(
        'DUPLICATE_SURFACE_ID',
        `compiled surface projection repeats ${surface.surfaceId}`,
      );
    }
    seenSurfaceIds.add(surface.surfaceId);
    return surface;
  });

  return Object.freeze({
    kind: 'surfaceManifestPayload' as const,
    schemaVersion: SURFACE_MANIFEST_PAYLOAD_VERSION,
    surfaces: Object.freeze(surfaces),
  });
}

function parseSurface(
  value: unknown,
  index: number,
): CompiledSurfaceDefinition {
  if (!isRecord(value)) invalidSurface(index);
  const archetype = value.archetype;
  const lifecycle = value.lifecycle;
  const surfaceRole = value.surfaceRole ?? null;
  if (!includes(archetypes, archetype)) invalidSurface(index);
  if (!includes(lifecycleValues, lifecycle)) invalidSurface(index);
  if (surfaceRole !== null && !includes(surfaceRoles, surfaceRole)) {
    invalidSurface(index);
  }
  if (!Array.isArray(value.fieldIds) || !value.fieldIds.every(isNonBlank)) {
    invalidSurface(index);
  }
  if (!Array.isArray(value.slots) || !Array.isArray(value.statusRoles)) {
    invalidSurface(index);
  }
  if (!value.statusRoles.every((role) => includes(statusRoles, role))) {
    invalidSurface(index);
  }
  if (
    !isNonBlank(value.dataSourceQueryId) ||
    !isNonBlank(value.label) ||
    !isNonBlank(value.surfaceId)
  ) {
    invalidSurface(index);
  }

  const seenSlots = new Set<string>();
  const slots = value.slots.map((slot, slotIndex) => {
    const parsed = parseSlot(slot, index, slotIndex, archetype);
    if (seenSlots.has(parsed.slot)) {
      throw new SurfaceProjectionError(
        'INVALID_SURFACE_SLOT',
        `surface ${String(value.surfaceId)} repeats slot ${parsed.slot}`,
      );
    }
    seenSlots.add(parsed.slot);
    return parsed;
  });

  return Object.freeze({
    archetype,
    dataSourceQueryId: value.dataSourceQueryId,
    fieldIds: Object.freeze([...value.fieldIds]),
    label: value.label,
    lifecycle,
    slots: Object.freeze(slots),
    statusRoles: Object.freeze([...value.statusRoles]),
    surfaceId: value.surfaceId,
    surfaceRole,
  });
}

function parseOperationBinding(value: unknown): {
  readonly confirmation: RegisteredOperationDefinition['confirmation'];
  readonly entityId: string;
  readonly intent: SurfaceOperationIntent;
  readonly lifecycle: RegisteredOperationDefinition['lifecycle'];
  readonly operationId: string;
  readonly tier: RegisteredOperationDefinition['tier'];
} {
  if (
    !isRecord(value) ||
    (value.confirmation !== 'none' && value.confirmation !== 'humanRequired') ||
    (value.lifecycle !== 'active' && value.lifecycle !== 'retired') ||
    (value.tier !== 'o0' && value.tier !== 'o1') ||
    !isNonBlank(value.operationId) ||
    !isRecord(value.effect) ||
    !isRecord(value.effect.entity) ||
    !isNonBlank(value.effect.entity.targetId)
  ) {
    throw invalidBinding(
      'pinned operation catalog contains an invalid operation',
    );
  }
  const intent = operationIntent(value.effect.kind);
  if (!intent) {
    throw invalidBinding(
      'pinned operation catalog contains a destructive or unknown effect',
    );
  }
  return {
    confirmation: value.confirmation,
    entityId: value.effect.entity.targetId,
    intent,
    lifecycle: value.lifecycle,
    operationId: value.operationId,
    tier: value.tier,
  };
}

function operationIntent(value: unknown): SurfaceOperationIntent | null {
  switch (value) {
    case 'archiveRecordEffect':
      return 'archive';
    case 'createRecordEffect':
      return 'create';
    case 'restoreRecordEffect':
      return 'restore';
    case 'updateRecordEffect':
      return 'update';
    default:
      return null;
  }
}

function invalidBinding(message: string): SurfaceProjectionError {
  return new SurfaceProjectionError('INVALID_SURFACE_BINDING', message);
}

function parseSlot(
  value: unknown,
  surfaceIndex: number,
  slotIndex: number,
  archetype: CompiledSurfaceArchetype,
): CompiledSurfaceSlot {
  if (
    !isRecord(value) ||
    !isNonBlank(value.contentReferenceId) ||
    !isNonBlank(value.slot) ||
    !isNonBlank(value.slotId) ||
    !Number.isSafeInteger(value.orderKey) ||
    Number(value.orderKey) < 0 ||
    !slotsByArchetype[archetype].includes(value.slot)
  ) {
    throw new SurfaceProjectionError(
      'INVALID_SURFACE_SLOT',
      `compiled surface ${surfaceIndex} has an invalid slot at ${slotIndex}`,
    );
  }
  return Object.freeze({
    contentReferenceId: value.contentReferenceId,
    orderKey: Number(value.orderKey),
    slot: value.slot,
    slotId: value.slotId,
  });
}

function invalidSurface(index: number): never {
  throw new SurfaceProjectionError(
    'INVALID_SURFACE_MANIFEST',
    `compiled surface at index ${index} has an invalid shape`,
  );
}

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.some((entry) => entry === value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
