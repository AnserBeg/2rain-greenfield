import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS,
} from '../../../packages/compiler/src/protocol.js';
import type { RegisteredOperationDefinition } from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  registeredSemanticQueryFromPinnedView,
  type RegisteredQueryDefinition,
  type RegisteredSemanticQueryDefinition,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

export {
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
};
type SurfaceManifestPayloadVersion =
  (typeof SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS)[number];

const archetypes = ['builder', 'home', 'list', 'record', 'task'] as const;
const lifecycleValues = ['active', 'retired'] as const;
const statusRoles = ['attention', 'blocked', 'inProgress', 'success'] as const;
const disclosureTiers = ['always', 'onDemand', 'progressive'] as const;
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
export type CompiledDisclosureTier = (typeof disclosureTiers)[number];
export type CompiledSurfaceRole = (typeof surfaceRoles)[number];
export type SurfaceOperationIntent =
  'archive' | 'command' | 'create' | 'restore' | 'update';

/**
 * How many operations of an intent a surface may bind, and the reason is a
 * fact about the control that carries them rather than a preference.
 *
 * A submission names its operation, so dispatch no longer needs the intent to
 * be unique. What is still not general is the CONTROL: four of the five
 * intents are rendered by a single control whose identity is fixed by
 * something other than the operation -- `create` and `update` by the form
 * role's one Save button, `archive` and `restore` by whether the record is
 * archived. A second operation on any of those has nowhere to render, so it
 * stays refused BY NAME rather than binding invisibly.
 *
 * `command` is the exception because each command renders its own named
 * button, which is the whole reason this limit lifted.
 *
 * **This is arity, not order.** ux-grammar's *"command bar orders the primary
 * action first; destructive actions live behind the overflow"* needs an
 * authored signal saying which command is primary, and the operation catalog
 * carries none -- `operationDefinition` has no `orderKey`. Commands therefore
 * render in a deterministic order that is not yet a meaningful one; the
 * grammar owns that gap and this constant does not paper over it.
 */
export const INTENT_RENDERED_ARITY: Readonly<
  Record<SurfaceOperationIntent, number>
> = Object.freeze({
  archive: 1,
  command: Number.POSITIVE_INFINITY,
  create: 1,
  restore: 1,
  update: 1,
});

export interface CompiledSurfaceSlot {
  readonly contentReferenceId: string;
  // Absent under every profile version that does not emit it, which today is
  // every recorded entry. Optional here rather than defaulted, so the reader
  // cannot invent a tier the projection did not carry.
  readonly disclosureTier?: CompiledDisclosureTier;
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

export interface CompiledNavigationSurface {
  readonly kind: 'navigationSurface';
  readonly surfaceId: string;
}

export interface CompiledNavigationGroup {
  readonly children: readonly CompiledNavigationEntry[];
  readonly kind: 'navigationGroup';
  readonly label: string;
  readonly navigationId: string;
}

export type CompiledNavigationEntry =
  CompiledNavigationGroup | CompiledNavigationSurface;

export interface CompiledNavigationTree {
  readonly entries: readonly CompiledNavigationGroup[];
  readonly kind: 'navigationTree';
}

export interface CompiledSurfaceOperationBinding {
  readonly capabilityId: string | null;
  readonly confirmation: RegisteredOperationDefinition['confirmation'];
  readonly intent: SurfaceOperationIntent;
  readonly label: string;
  readonly operationId: string;
  readonly precondition: Readonly<
    Record<string, RuntimeViewContract.ImmutableJsonValue>
  >;
}

export interface CompiledSurfaceDataBinding {
  readonly displayFieldId: string | null;
  readonly operations: readonly CompiledSurfaceOperationBinding[];
  readonly query: RegisteredSemanticQueryDefinition;
}

export interface CompiledSurfaceManifest {
  readonly kind: 'surfaceManifestPayload';
  readonly navigation: CompiledNavigationTree | null;
  readonly schemaVersion: SurfaceManifestPayloadVersion;
  readonly surfaces: readonly CompiledSurfaceDefinition[];
}

export class SurfaceProjectionError extends Error {
  override readonly name = 'SurfaceProjectionError';

  constructor(
    readonly code:
      | 'DUPLICATE_SURFACE_ID'
      | 'INVALID_SURFACE_BINDING'
      | 'INVALID_SURFACE_MANIFEST'
      | 'INVALID_SURFACE_NAVIGATION'
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
  const query = registeredSemanticQueryFromPinnedView(
    view,
    surface.dataSourceQueryId,
  );
  if (!query) {
    throw invalidBinding(
      'surface query is not registered in the pinned release',
    );
  }
  if (!surfaceAcceptsQuery(surface, query.queryType)) {
    throw invalidBinding(
      'surface role is incompatible with the pinned data-source query kind',
    );
  }
  const queryFieldIds =
    query.queryType === 'aggregate'
      ? []
      : query.selections.map((selection) => selection.fieldId);
  if (
    queryFieldIds.length !== surface.fieldIds.length ||
    queryFieldIds.some((fieldId, index) => fieldId !== surface.fieldIds[index])
  ) {
    throw invalidBinding(
      'surface fields do not match the pinned data-source query selections',
    );
  }

  if (query.queryType === 'aggregate') {
    return Object.freeze({
      displayFieldId: null,
      operations: Object.freeze([]),
      query,
    });
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

  const byOperationId = new Map<string, CompiledSurfaceOperationBinding>();
  const intentCount = new Map<SurfaceOperationIntent, number>();
  for (const value of payload.operations) {
    const operation = parseOperationBinding(value);
    const entityId =
      operation.entityId ??
      registeredSemanticQueryFromPinnedView(view, operation.readBackQueryId)
        ?.sourceEntityId;
    if (
      operation.lifecycle !== 'active' ||
      entityId !== query.sourceEntityId ||
      (operation.intent === 'command'
        ? operation.tier !== 'o1'
        : operation.tier !== 'o0')
    ) {
      continue;
    }
    const bound = (intentCount.get(operation.intent) ?? 0) + 1;
    if (bound > INTENT_RENDERED_ARITY[operation.intent]) {
      throw invalidBinding(
        `surface entity has more than one active ${operation.tier} ${operation.intent} operation`,
      );
    }
    intentCount.set(operation.intent, bound);
    byOperationId.set(
      operation.operationId,
      Object.freeze({
        capabilityId: operation.capabilityId,
        confirmation: operation.confirmation,
        intent: operation.intent,
        label: operationLabel(operation.operationId),
        operationId: operation.operationId,
        precondition: operation.precondition,
      }),
    );
  }

  return Object.freeze({
    displayFieldId: displayFieldIdFromPinnedQueries(view, query),
    // Intent first so the four single-control intents keep the order every
    // existing expectation was written against, then operation id, which is
    // the only ordering signal the catalog carries -- `operationDefinition`
    // declares no `orderKey`. Deterministic, and NOT the grammar's
    // primary-action-first rule: see INTENT_RENDERED_ARITY.
    operations: Object.freeze(
      [...byOperationId.values()].sort(
        (left, right) =>
          left.intent.localeCompare(right.intent) ||
          left.operationId.localeCompare(right.operationId),
      ),
    ),
    query,
  });
}

function displayFieldIdFromPinnedQueries(
  view: RuntimeViewContract.RequestRuntimeView,
  boundQuery: RegisteredQueryDefinition,
): string | null {
  const payload = view.projections.query.payload;
  if (!isRecord(payload) || !Array.isArray(payload.queries)) {
    throw invalidBinding('pinned query catalog has an invalid envelope');
  }

  // registeredQueryFromPinnedView validated every entry before returning the
  // bound query above. Reuse those validated definitions to select the
  // entity's declared resolve/display authority without module-specific IDs.
  const resolveQueries = (
    payload.queries as unknown as readonly RegisteredQueryDefinition[]
  ).filter(
    (candidate) =>
      candidate.lifecycle === 'active' &&
      candidate.queryType === 'resolve' &&
      candidate.sourceEntityId === boundQuery.sourceEntityId &&
      candidate.tier === 'q0',
  );
  if (resolveQueries.length > 1) {
    throw invalidBinding(
      'surface entity has more than one active Q0 resolve query',
    );
  }
  const resolve = resolveQueries[0];
  if (!resolve) return null;
  const selectedFieldIds = new Set(
    boundQuery.selections.map((selection) => selection.fieldId),
  );
  const keys = [...(resolve.resolveMatchKeys ?? [])]
    .filter((key) => selectedFieldIds.has(key.fieldId))
    .sort(
      (left, right) =>
        (left.authority === right.authority
          ? 0
          : left.authority === 'advisory'
            ? -1
            : 1) || left.orderKey - right.orderKey,
    );
  return keys[0]?.fieldId ?? null;
}

function surfaceAcceptsQuery(
  surface: CompiledSurfaceDefinition,
  queryType: RegisteredSemanticQueryDefinition['queryType'],
): boolean {
  return surface.archetype === 'task' && surface.surfaceRole === null
    ? queryType === 'aggregate'
    : surface.surfaceRole === 'list'
      ? queryType === 'list' || queryType === 'search'
      : surface.surfaceRole === 'form' || surface.surfaceRole === 'record'
        ? queryType === 'get' || queryType === 'resolve'
        : false;
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
  if (
    !SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS.some(
      (version) => version === projection.payloadSchemaVersion,
    )
  ) {
    throw new SurfaceProjectionError(
      'UNSUPPORTED_SURFACE_VERSION',
      `unsupported surface payload version ${projection.payloadSchemaVersion}`,
    );
  }
  const payloadSchemaVersion =
    projection.payloadSchemaVersion as SurfaceManifestPayloadVersion;

  const payload = projection.payload;
  if (
    !isRecord(payload) ||
    payload.kind !== 'surfaceManifestPayload' ||
    payload.schemaVersion !== payloadSchemaVersion ||
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
  if (
    payloadSchemaVersion === FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION &&
    payload.navigation !== undefined
  ) {
    throw invalidNavigation(
      'a flat v0 surface manifest cannot contain compiled navigation grouping',
    );
  }
  if (
    payloadSchemaVersion === GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION &&
    payload.navigation === undefined
  ) {
    throw invalidNavigation(
      'a grouped v1 surface manifest is missing compiled navigation grouping',
    );
  }
  const navigation =
    payloadSchemaVersion === GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION
      ? parseNavigationTree(payload.navigation, surfaces)
      : null;
  validateNavigationReachability(navigation, surfaces);

  return Object.freeze({
    kind: 'surfaceManifestPayload' as const,
    navigation,
    schemaVersion: payloadSchemaVersion,
    surfaces: Object.freeze(surfaces),
  });
}

function parseNavigationTree(
  value: unknown,
  surfaces: readonly CompiledSurfaceDefinition[],
): CompiledNavigationTree {
  if (
    !isRecord(value) ||
    value.kind !== 'navigationTree' ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > 5
  ) {
    throw invalidNavigation('compiled navigation has an invalid tree');
  }
  const surfaceIds = new Set(surfaces.map((surface) => surface.surfaceId));
  const navigationIds = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    const parsed = parseNavigationEntry(
      entry,
      `navigation.entries[${String(index)}]`,
      0,
      navigationIds,
      surfaceIds,
    );
    if (parsed.kind !== 'navigationGroup') {
      throw invalidNavigation(
        'compiled navigation top-level entries must be groups',
      );
    }
    return parsed;
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    kind: 'navigationTree' as const,
  });
}

function parseNavigationEntry(
  value: unknown,
  path: string,
  depth: number,
  navigationIds: Set<string>,
  surfaceIds: ReadonlySet<string>,
): CompiledNavigationEntry {
  if (!isRecord(value) || depth > 2) {
    throw invalidNavigation(`${path} is invalid or nested too deeply`);
  }
  if (value.kind === 'navigationSurface') {
    if (!isNonBlank(value.surfaceId) || !surfaceIds.has(value.surfaceId)) {
      throw invalidNavigation(`${path} references an unknown surface`);
    }
    return Object.freeze({
      kind: 'navigationSurface' as const,
      surfaceId: value.surfaceId,
    });
  }
  if (
    value.kind !== 'navigationGroup' ||
    !isNonBlank(value.label) ||
    !isNonBlank(value.navigationId) ||
    !Array.isArray(value.children) ||
    value.children.length === 0 ||
    navigationIds.has(value.navigationId)
  ) {
    throw invalidNavigation(`${path} is not a valid navigation group`);
  }
  navigationIds.add(value.navigationId);
  return Object.freeze({
    children: Object.freeze(
      value.children.map((child, index) =>
        parseNavigationEntry(
          child,
          `${path}.children[${String(index)}]`,
          depth + 1,
          navigationIds,
          surfaceIds,
        ),
      ),
    ),
    kind: 'navigationGroup' as const,
    label: value.label,
    navigationId: value.navigationId,
  });
}

function validateNavigationReachability(
  navigation: CompiledNavigationTree | null,
  surfaces: readonly CompiledSurfaceDefinition[],
): void {
  const expected = surfaces
    .filter(
      (surface) =>
        surface.lifecycle === 'active' && isNavigationSurface(surface),
    )
    .map((surface) => surface.surfaceId)
    .sort();
  if (!navigation) {
    if (expected.length > 5) {
      throw invalidNavigation(
        'an over-budget surface manifest is missing compiled navigation grouping',
      );
    }
    return;
  }
  const observed = navigation.entries.flatMap(navigationSurfaceIds).sort();
  if (
    observed.length !== new Set(observed).size ||
    observed.length !== expected.length ||
    observed.some((surfaceId, index) => surfaceId !== expected[index])
  ) {
    throw invalidNavigation(
      'compiled navigation must reach every active navigation surface exactly once',
    );
  }
}

function navigationSurfaceIds(entry: CompiledNavigationEntry): string[] {
  return entry.kind === 'navigationSurface'
    ? [entry.surfaceId]
    : entry.children.flatMap(navigationSurfaceIds);
}

function isNavigationSurface(surface: CompiledSurfaceDefinition): boolean {
  return (
    surface.surfaceRole === 'list' ||
    (surface.surfaceRole === null &&
      (surface.archetype === 'list' ||
        surface.archetype === 'home' ||
        surface.archetype === 'task'))
  );
}

function invalidNavigation(message: string): SurfaceProjectionError {
  return new SurfaceProjectionError('INVALID_SURFACE_NAVIGATION', message);
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
  readonly capabilityId: string | null;
  readonly confirmation: RegisteredOperationDefinition['confirmation'];
  readonly entityId: string | null;
  readonly intent: SurfaceOperationIntent;
  readonly lifecycle: RegisteredOperationDefinition['lifecycle'];
  readonly operationId: string;
  readonly precondition: Readonly<
    Record<string, RuntimeViewContract.ImmutableJsonValue>
  >;
  readonly readBackQueryId: string;
  readonly tier: RegisteredOperationDefinition['tier'];
} {
  if (
    !isRecord(value) ||
    (value.confirmation !== 'none' && value.confirmation !== 'humanRequired') ||
    (value.lifecycle !== 'active' && value.lifecycle !== 'retired') ||
    (value.tier !== 'o0' && value.tier !== 'o1') ||
    !isNonBlank(value.operationId) ||
    !isNonBlank(value.readBackQueryId) ||
    !isRecord(value.effect) ||
    !isRecord(value.precondition)
  ) {
    throw invalidBinding(
      'pinned operation catalog contains an invalid operation',
    );
  }
  const capabilityEffect = value.effect.kind === 'registeredCapabilityEffect';
  const entity = isRecord(value.effect.entity) ? value.effect.entity : null;
  const capability = isRecord(value.effect.capability)
    ? value.effect.capability
    : null;
  const intent = capabilityEffect
    ? 'command'
    : operationIntent(value.effect.kind);
  if (!intent) {
    throw invalidBinding(
      'pinned operation catalog contains a destructive or unknown effect',
    );
  }
  if (
    (capabilityEffect &&
      (value.tier !== 'o1' ||
        !capability ||
        !isNonBlank(capability.targetId))) ||
    (!capabilityEffect &&
      (value.tier !== 'o0' || !entity || !isNonBlank(entity.targetId)))
  ) {
    throw invalidBinding('pinned operation effect does not match its tier');
  }
  return {
    capabilityId: capabilityEffect ? String(capability!.targetId) : null,
    confirmation: value.confirmation,
    entityId: capabilityEffect ? null : String(entity!.targetId),
    intent,
    lifecycle: value.lifecycle,
    operationId: value.operationId,
    precondition: value.precondition as Readonly<
      Record<string, RuntimeViewContract.ImmutableJsonValue>
    >,
    readBackQueryId: value.readBackQueryId,
    tier: value.tier,
  };
}

function operationLabel(operationId: string): string {
  const local = operationId.slice(operationId.lastIndexOf('.') + 1);
  const action = local.slice(local.lastIndexOf('_') + 1);
  return action.length === 0
    ? 'Run command'
    : action.slice(0, 1).toUpperCase() + action.slice(1).replaceAll('_', ' ');
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
    !slotsByArchetype[archetype].includes(value.slot) ||
    // Refused rather than dropped. `parseSlot` builds a fresh object from the
    // keys it recognises, so an unrecognised tier would be silently discarded --
    // the adoption trap this reader previously carried.
    (value.disclosureTier !== undefined &&
      !includes(disclosureTiers, value.disclosureTier))
  ) {
    throw new SurfaceProjectionError(
      'INVALID_SURFACE_SLOT',
      `compiled surface ${surfaceIndex} has an invalid slot at ${slotIndex}`,
    );
  }
  return Object.freeze({
    contentReferenceId: value.contentReferenceId,
    ...(value.disclosureTier === undefined
      ? {}
      : { disclosureTier: value.disclosureTier }),
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
