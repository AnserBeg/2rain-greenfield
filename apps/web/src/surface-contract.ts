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
/**
 * The canonical field-type vocabulary, verbatim. No second spelling is coined
 * here: the renderer switches on the same word `FieldTypeSchema` discriminates
 * on, so a kind the compiler can emit and this list omits is a mismatch a
 * reviewer can see by diffing two lists rather than by reasoning about a
 * mapping.
 */
export const COMPILED_FIELD_KINDS = Object.freeze([
  'booleanFieldType',
  'dateFieldType',
  'dateTimeFieldType',
  'enumFieldType',
  'exactDecimalFieldType',
  'integerFieldType',
  'moneyFieldType',
  'quantityFieldType',
  'textFieldType',
  'timeFieldType',
] as const);
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
export type CompiledFieldKind = (typeof COMPILED_FIELD_KINDS)[number];
/** The canonical temporal kinds, and the only ones that carry `temporal`. */
const temporalFieldKinds = [
  'dateFieldType',
  'dateTimeFieldType',
  'timeFieldType',
] as const;
const temporalPrecisions = ['millisecond', 'second'] as const;
const timezoneSemantics = [
  'calendarDate',
  'localWallTime',
  'offsetDateTime',
  'utcInstant',
] as const;

export type CompiledTemporalPrecision = (typeof temporalPrecisions)[number];
export type CompiledTimezoneSemantics = (typeof timezoneSemantics)[number];
export type CompiledTemporalKind = (typeof temporalFieldKinds)[number];

/**
 * The one place the kind-to-semantics mapping is written down, so the reader's
 * check and the type above cannot drift apart. Each entry is exactly what that
 * kind's canonical schema admits: `dateFieldType.timezoneSemantics` and
 * `timeFieldType.timezoneSemantics` are single literals there, and
 * `dateTimeFieldType`'s is a two-value enum.
 */
const timezoneSemanticsByKind = Object.freeze({
  dateFieldType: Object.freeze(['calendarDate'] as const),
  dateTimeFieldType: Object.freeze(['offsetDateTime', 'utcInstant'] as const),
  timeFieldType: Object.freeze(['localWallTime'] as const),
});

export interface CompiledFieldOption {
  readonly label: string;
  readonly optionId: string;
}

/**
 * The declared domain of one field. `precision` is `null` exactly for
 * `dateFieldType`, which has no sub-day component to be precise about.
 */
export interface CompiledFieldTemporal {
  readonly precision: CompiledTemporalPrecision | null;
  readonly timezoneSemantics: CompiledTimezoneSemantics;
}

interface CompiledFieldCommon {
  readonly fieldId: string;
  readonly required: boolean;
}

/**
 * One temporal branch, DERIVED from `timezoneSemanticsByKind` rather than
 * declared beside it.
 *
 * The spellings previously had four independent representations -- the broad
 * vocabulary list, this table, three hand-written union branches, and the
 * parser's hardcoded returns -- and a review found what that leaves open:
 * nothing typed the table against the union, so editing the date entry to
 * `['utcInstant']` would make the runtime check ADMIT a date field carrying
 * `utcInstant`, after which the parser substituted the literal `calendarDate`.
 * Acceptance followed by coercion, which ADR-0041 forbids by name.
 *
 * Deriving the branch from the table collapses two of those representations into
 * one: the table is the only place a spelling is written, and any edit moves the
 * type, the runtime check and every consumer together. `precision` is keyed off
 * the same discriminant -- `null` for `dateFieldType` alone, which has no
 * sub-day component to be precise about.
 */
type CompiledTemporalField<K extends CompiledTemporalKind> =
  // Distributive on purpose: a naked type parameter in a conditional distributes
  // over the union, so `CompiledTemporalField<CompiledTemporalKind>` is the union
  // of the three branches rather than one branch whose `kind` is a union. The
  // parser returns exactly that, and the difference is what lets callers narrow.
  K extends unknown
    ? CompiledFieldCommon & {
        readonly kind: K;
        readonly temporal: {
          readonly precision: K extends 'dateFieldType'
            ? null
            : CompiledTemporalPrecision;
          readonly timezoneSemantics: (typeof timezoneSemanticsByKind)[K][number];
        };
      }
    : never;

/**
 * A field is DISCRIMINATED on its kind, and each temporal kind carries only the
 * timezone semantics its own canonical schema admits.
 *
 * The first shape here was a flat record with an optional
 * `{precision, timezoneSemantics}` validated against the union of all four
 * spellings, so `dateFieldType` with `utcInstant` and `timeFieldType` with
 * `calendarDate` were both ADMITTED while the renderer picked its control from
 * `kind` alone -- the compiled contract stating one temporal domain and the
 * control implementing another, silently.
 *
 * `review-tiers` prefers unrepresentable to detectable. The reader below still
 * validates the pairing, because a payload arrives as JSON and a type cannot
 * check bytes -- but a caller cannot CONSTRUCT the wrong pair, and the check and
 * the type now read the same table, so they cannot disagree about which pairs
 * exist.
 */
export type CompiledSurfaceField =
  | CompiledTemporalField<'dateFieldType'>
  | CompiledTemporalField<'dateTimeFieldType'>
  | CompiledTemporalField<'timeFieldType'>
  | (CompiledFieldCommon & {
      readonly kind: 'enumFieldType';
      readonly options: readonly CompiledFieldOption[];
    })
  | (CompiledFieldCommon & {
      readonly kind: Exclude<CompiledFieldKind, CompiledTemporalKind | 'enumFieldType'>;
    });
export type SurfaceOperationIntent =
  'archive' | 'command' | 'create' | 'restore' | 'update';

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
  // Absent under every profile version that does not emit it, which today is
  // every recorded entry. Optional here rather than defaulted, so the reader
  // cannot invent a kind the projection did not carry -- the `disclosureTier`
  // precedent above, and the reason `text` is not the type of an unknown field.
  readonly fields?: readonly CompiledSurfaceField[];
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
      | 'INVALID_SURFACE_FIELD'
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

  const byIntent = new Map<
    SurfaceOperationIntent,
    CompiledSurfaceOperationBinding
  >();
  for (const value of payload.operations) {
    const operation = parseOperationBinding(value);
    const entityId =
      operation.entityId ??
      registeredSemanticQueryFromPinnedView(view, operation.readBackQueryId)
        ?.sourceEntityId;
    if (operation.lifecycle !== 'active' || entityId !== query.sourceEntityId) {
      continue;
    }
    // KNOWN LIMIT, declared rather than silent: one operation per intent, so
    // an entity carrying two named transitions (a release AND a cancel) binds
    // neither and refuses by name. Rendering a list of named actions is a
    // surface-design question this contract does not answer, and it is owed
    // before a document with more than one transition reaches a surface.
    if (byIntent.has(operation.intent)) {
      throw invalidBinding(
        `surface entity has more than one active ${operation.tier} ${operation.intent} operation`,
      );
    }
    byIntent.set(
      operation.intent,
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
    operations: Object.freeze(
      [...byIntent.values()].sort((left, right) =>
        left.intent.localeCompare(right.intent),
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

  const fields = parseSurfaceFields(value, index);

  return Object.freeze({
    archetype,
    dataSourceQueryId: value.dataSourceQueryId,
    fieldIds: Object.freeze([...value.fieldIds]),
    ...(fields === undefined ? {} : { fields }),
    label: value.label,
    lifecycle,
    slots: Object.freeze(slots),
    statusRoles: Object.freeze([...value.statusRoles]),
    surfaceId: value.surfaceId,
    surfaceRole,
  });
}

function invalidField(message: string): SurfaceProjectionError {
  return new SurfaceProjectionError('INVALID_SURFACE_FIELD', message);
}

/**
 * Reads the per-field kinds a v2 manifest carries, and refuses rather than
 * dropping.
 *
 * `U5b`'s round-1 defect was a reader that built a fresh object from the keys
 * it recognised, so an unrecognised `disclosureTier` was silently discarded and
 * the surface rendered as though nothing had been declared. The same shape here
 * is worse: an unrecognised kind would fall back to a text box, which is
 * indistinguishable from a field the compiler never described. So an unknown
 * kind is refused **by name** -- the message says which kind, because a reader
 * one version behind its compiler needs to learn what it is missing, not that
 * something was wrong.
 *
 * The parity check is the second half. A `fields` array that is short, long, or
 * out of order against `fieldIds` means the projection and the form disagree
 * about what this surface has, and the failure that follows is a form rendering
 * some controls correctly and the rest as bare text -- the exact silent
 * degradation this packet exists to remove. Refused as one fault, named.
 */
function parseSurfaceFields(
  value: Record<string, unknown>,
  surfaceIndex: number,
): readonly CompiledSurfaceField[] | undefined {
  // Absence is a state, not a default. Under every profile that does not emit
  // per-field kinds the key is not there at all; `Object.hasOwn` keeps that
  // distinguishable from a surface whose field list is genuinely empty.
  if (!Object.hasOwn(value, 'fields')) return undefined;
  if (!Array.isArray(value.fields)) {
    throw invalidField(
      `compiled surface ${surfaceIndex} declares a non-array field list`,
    );
  }
  const fields = value.fields.map((entry, fieldIndex) =>
    parseSurfaceField(entry, surfaceIndex, fieldIndex),
  );
  const fieldIds = value.fieldIds as readonly string[];
  if (
    fields.length !== fieldIds.length ||
    fields.some((field, fieldIndex) => field.fieldId !== fieldIds[fieldIndex])
  ) {
    throw invalidField(
      `compiled surface ${surfaceIndex} declares field kinds that do not match its selected fields`,
    );
  }
  return Object.freeze(fields);
}

function parseSurfaceField(
  value: unknown,
  surfaceIndex: number,
  fieldIndex: number,
): CompiledSurfaceField {
  const at = `compiled surface ${surfaceIndex} field ${fieldIndex}`;
  if (!isRecord(value) || !isNonBlank(value.fieldId)) {
    throw invalidField(`${at} is not a declared field`);
  }
  if (!includes(COMPILED_FIELD_KINDS, value.kind)) {
    throw invalidField(
      `${at} (${value.fieldId}) declares the unrecognised field kind ${JSON.stringify(value.kind)}`,
    );
  }
  const kind = value.kind;
  if (typeof value.required !== 'boolean') {
    throw invalidField(
      `${at} (${value.fieldId}) does not declare whether it is required`,
    );
  }
  const required = value.required;
  const common = { fieldId: value.fieldId, required };
  // Present exactly when the kind is `enumFieldType`: options on any other kind
  // mean the payload was built by something this reader does not understand,
  // and their absence on an enum would render a choice with nothing to choose.
  if (Object.hasOwn(value, 'options') !== (kind === 'enumFieldType')) {
    throw invalidField(
      `${at} (${value.fieldId}) carries options that do not belong to kind ${kind}`,
    );
  }
  if (includes(temporalFieldKinds, kind)) {
    return parseTemporalField(value, kind, common, at);
  }
  if (kind !== 'enumFieldType') {
    if (Object.hasOwn(value, 'temporal')) {
      throw invalidField(
        `${at} (${value.fieldId}) carries temporal precision that does not belong to kind ${kind}`,
      );
    }
    return Object.freeze({ ...common, kind });
  }
  if (Object.hasOwn(value, 'temporal')) {
    throw invalidField(
      `${at} (${value.fieldId}) carries temporal precision that does not belong to kind ${kind}`,
    );
  }
  if (!Array.isArray(value.options)) {
    throw invalidField(`${at} (${value.fieldId}) declares a non-array option list`);
  }
  const options = value.options.map((option) => {
    if (
      !isRecord(option) ||
      !isNonBlank(option.optionId) ||
      !isNonBlank(option.label)
    ) {
      throw invalidField(
        `${at} (${value.fieldId}) declares an invalid enum option`,
      );
    }
    return Object.freeze({ label: option.label, optionId: option.optionId });
  });
  return Object.freeze({
    ...common,
    kind,
    options: Object.freeze(options),
  });
}

/**
 * `temporal` is present exactly for a temporal kind, and a temporal kind without
 * it is refused rather than rendered.
 *
 * That asymmetry with `options` is deliberate: an enum missing its options
 * renders a visibly empty choice, but a `dateTimeFieldType` missing its
 * precision and timezone semantics renders a control that looks fine and cannot
 * express the stored value. The silent one is the one that has to be refused.
 *
 * **Both discriminants are bound to the kind, and the second one was the
 * defect.** The first cut bound `precision` to the kind -- `null` for
 * `dateFieldType` alone -- and then checked `timezoneSemantics` only for
 * membership in the union of all four spellings, so `dateFieldType` +
 * `utcInstant` and `timeFieldType` + `calendarDate` were admitted while the
 * renderer picked its control from `kind`. One discriminant was checked
 * properly and the other was not, in the same function.
 */
function parseTemporalField<K extends CompiledTemporalKind>(
  value: Record<string, unknown>,
  kind: K,
  common: CompiledFieldCommon,
  at: string,
): CompiledTemporalField<K> {
  if (!Object.hasOwn(value, 'temporal')) {
    throw invalidField(
      `${at} (${String(value.fieldId)}) carries temporal precision that does not belong to kind ${kind}`,
    );
  }
  const temporal = value.temporal;
  if (
    !isRecord(temporal) ||
    !includes(timezoneSemantics, temporal.timezoneSemantics) ||
    (temporal.precision !== null &&
      !includes(temporalPrecisions, temporal.precision))
  ) {
    throw invalidField(
      `${at} (${String(value.fieldId)}) declares an unreadable temporal domain`,
    );
  }
  if ((temporal.precision === null) !== (kind === 'dateFieldType')) {
    throw invalidField(
      `${at} (${String(value.fieldId)}) declares a temporal precision that kind ${kind} cannot carry`,
    );
  }
  if (!includes(timezoneSemanticsByKind[kind], temporal.timezoneSemantics)) {
    throw invalidField(
      `${at} (${String(value.fieldId)}) declares timezone semantics ${temporal.timezoneSemantics} that kind ${kind} cannot carry`,
    );
  }
  // The VALIDATED value, never a second spelling. Returning a hardcoded literal
  // here is how the table and the returned value could disagree: the check would
  // admit and the parser would quietly substitute. The one cast is justified by
  // the four refusals immediately above -- shape, vocabulary, precision-to-kind
  // and semantics-to-kind -- and there is no other route out of this function.
  return Object.freeze({
    ...common,
    kind,
    temporal: Object.freeze({
      precision: temporal.precision,
      timezoneSemantics: temporal.timezoneSemantics,
    }),
  }) as CompiledTemporalField<K>;
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
  const transitionEffect = value.effect.kind === 'transitionStateEffect';
  const entity = isRecord(value.effect.entity) ? value.effect.entity : null;
  const capability = isRecord(value.effect.capability)
    ? value.effect.capability
    : null;
  const intent = capabilityEffect ? 'command' : operationIntent(value.effect.kind);
  if (!intent) {
    throw invalidBinding(
      'pinned operation catalog contains a destructive or unknown effect',
    );
  }
  // Tier follows the EFFECT, not the intent. A capability command is o1
  // because ADR-0038 binds it there structurally; a transition is a record
  // effect and stays o0, and both present as `command`. Keying this check on
  // the intent instead would refuse the transition for being what it is.
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

/**
 * A record transition is a named command from a surface's point of view: the
 * record is already staged, the button names the move, and the server chooses
 * the outcome. Its posted arguments -- `recordId` and `expectedRevision` --
 * are byte-for-byte the capability command's, so it binds to the same intent
 * rather than minting one the rest of the shell does not understand.
 *
 * Returning `null` here is not a small failure: `parseOperationBinding` raises
 * `INVALID_SURFACE_BINDING` for the whole surface contract, so an unmapped
 * effect kind takes every surface in the release down, the same shape as the
 * catalog defect ADR-0050 §1 recorded one layer lower.
 */
function operationIntent(value: unknown): SurfaceOperationIntent | null {
  switch (value) {
    case 'archiveRecordEffect':
      return 'archive';
    case 'createRecordEffect':
      return 'create';
    case 'restoreRecordEffect':
      return 'restore';
    case 'transitionStateEffect':
      return 'command';
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
