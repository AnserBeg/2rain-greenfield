import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';

export const SURFACE_MANIFEST_PAYLOAD_VERSION =
  'northstar.surface-manifest-payload/v0-provisional' as const;

const archetypes = ['builder', 'home', 'list', 'record', 'task'] as const;
const lifecycleValues = ['active', 'retired'] as const;
const statusRoles = ['attention', 'blocked', 'inProgress', 'success'] as const;
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
      | 'INVALID_SURFACE_MANIFEST'
      | 'INVALID_SURFACE_SLOT'
      | 'UNSUPPORTED_SURFACE_VERSION',
    message: string,
  ) {
    super(message);
  }
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
  if (!includes(archetypes, archetype)) invalidSurface(index);
  if (!includes(lifecycleValues, lifecycle)) invalidSurface(index);
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
  });
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
