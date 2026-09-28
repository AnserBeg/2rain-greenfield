import {
  SurfaceCompositionSchema,
  type SurfaceComposition,
} from '../../../packages/canonical-model/src/index.js';
import {
  SurfaceWorkspaceSchema,
  SurfaceDocumentEditorSchema,
  SurfaceListSchema,
  type SurfaceList,
  type SurfaceWorkspace,
  type SurfaceDocumentEditor,
} from '../../../packages/canonical-model/src/schemas.js';
import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS,
} from '../../../packages/compiler/src/protocol.js';
import {
  OPERATION_CATALOG_PAYLOAD_VERSION,
  parsePinnedOperationCatalog,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import type {
  RegisteredOperationDefinition,
  RegisteredOperationInputContract,
  RegisteredOperationSystemInput,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
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
export type CompiledTemporalKind = (typeof temporalFieldKinds)[number];
export type CompiledTemporalPrecision = (typeof temporalPrecisions)[number];

/**
 * **The only place a timezone spelling is written**, and now literally so.
 *
 * Each entry is exactly what that kind's canonical schema admits:
 * `dateFieldType.timezoneSemantics` and `timeFieldType.timezoneSemantics` are
 * single literals there, and `dateTimeFieldType`'s is a two-value enum.
 *
 * `satisfies` pins the KEYS to the temporal kinds, so a kind added to
 * `temporalFieldKinds` without an entry here fails to compile rather than
 * reaching the reader as an unmapped lookup.
 */
const timezoneSemanticsByKind = Object.freeze({
  dateFieldType: Object.freeze(['calendarDate'] as const),
  dateTimeFieldType: Object.freeze(['offsetDateTime', 'utcInstant'] as const),
  timeFieldType: Object.freeze(['localWallTime'] as const),
}) satisfies Record<CompiledTemporalKind, readonly string[]>;

/**
 * The accepted vocabulary, DERIVED from the table rather than declared beside
 * it.
 *
 * A review found the gap this closes: the broad list and the table were two
 * independent declarations, and nothing tied them together. Adding a spelling to
 * one kind's entry and forgetting the list would make `CompiledSurfaceField`
 * statically admit a value the parser refuses one check earlier as an
 * "unreadable temporal domain" -- not silent coercion, but exactly the
 * type-versus-runtime contradiction the single-authority claim says cannot
 * happen. The claim was false while both representations existed unchecked, and
 * deriving one from the other is what makes it true rather than restating it.
 */
const timezoneSemantics = Object.freeze([
  ...timezoneSemanticsByKind.dateFieldType,
  ...timezoneSemanticsByKind.dateTimeFieldType,
  ...timezoneSemanticsByKind.timeFieldType,
] as const);

export type CompiledTimezoneSemantics = (typeof timezoneSemantics)[number];

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
 * check bytes -- but a caller cannot CONSTRUCT the wrong pair, and every
 * spelling the parser accepts, the type admits and the branches carry now
 * derives from `timezoneSemanticsByKind`, so no edit can move one without the
 * others.
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
      readonly kind: Exclude<
        CompiledFieldKind,
        CompiledTemporalKind | 'enumFieldType'
      >;
    });
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
 * stays refused BY NAME rather than binding invisibly. A family with no form
 * renders no `create` or `update` at all; there a surplus of either is left
 * unbound rather than refusing the family's read surfaces.
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
  readonly list?: SurfaceList;
  readonly workspace?: SurfaceWorkspace;
  readonly documentEditor?: SurfaceDocumentEditor;
  readonly composition?: SurfaceComposition;
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
  /**
   * Provider-facing field kinds from the already-pinned operation catalog.
   * Form normalization must not depend on profile-v2 surface metadata becoming
   * adopted before it can write a boolean.
   */
  readonly inputFields: readonly CompiledSurfaceInputField[] | null;
  readonly intent: SurfaceOperationIntent;
  readonly label: string;
  readonly operationId: string;
  readonly precondition: Readonly<
    Record<string, RuntimeViewContract.ImmutableJsonValue>
  >;
  /**
   * The compiler-declared key for a create operand supplied by the web
   * boundary. The selected value remains untrusted operation input; this
   * carrier prevents the browser from inventing or hardcoding the key.
   */
  readonly systemInputArgumentKey:
    RegisteredOperationSystemInput['argumentKey'] | null;
}

export interface CompiledSurfaceInputField {
  readonly temporal?: RegisteredOperationInputContract['fields'][number]['temporal'];
  /**
   * The pinned contract's value bounds, so an editor can refuse an out-of-range
   * decimal before any step commits. The provider still enforces them.
   */
  readonly bounds?: RegisteredOperationInputContract['fields'][number]['bounds'];
  readonly fieldId: string;
  readonly kind: RegisteredOperationInputContract['fields'][number]['fieldKind'];
  readonly required: boolean;
}

/**
 * A relation the entity accepts as create input. `targetEntityId` names the
 * entity whose records are candidates, and is `null` on a generation-1 artifact
 * that does not declare one.
 */
export interface CompiledSurfaceRelationInput {
  readonly archiveBehavior: 'restrict' | 'retainReference';
  readonly relationId: string;
  readonly required: boolean;
  readonly targetEntityId: string | null;
}

/**
 * Either the entity's create-input relations, or an explicit absence. Modelled
 * as a discriminated state so a consumer cannot silently read "unknown" as
 * "none" -- ADR-0041's honoured-or-refused rule applied to a reader.
 */
export type EntityRelationAuthority =
  | {
      readonly relationInputs: readonly CompiledSurfaceRelationInput[];
      readonly status: 'known';
    }
  | { readonly status: 'unavailable' };

export interface CompiledSurfaceDataBinding {
  readonly displayFieldId: string | null;
  readonly operations: readonly CompiledSurfaceOperationBinding[];
  readonly query: RegisteredSemanticQueryDefinition;
  /**
   * The ENTITY's create-input relations, or an explicit statement that no
   * authority for them exists.
   *
   * `unavailable` is NOT the same as a known empty list, and collapsing the two
   * was a defect: an entity with no create operation has nothing to learn its
   * relations from, and returning `[]` there is a positive assertion the reader
   * cannot support. A consumer must refuse, or render a declared unsupported
   * state -- never treat unavailable as "this entity has no relations".
   *
   * When authority exists it is read from EVERY create-effect operation for the
   * entity regardless of lifecycle, and disagreement refuses by name. Two
   * earlier shapes were wrong: the active create binding alone drops the freeze
   * disclosure on a release whose create is retired, and taking whichever
   * contract declared the most relations makes cardinality into authority.
   */
  readonly relationInputs: EntityRelationAuthority;
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
 * request-pinned projections. Physical storage metadata is not part of this
 * contract.
 *
 * **Browser input selects an operation id; it does not authorize one or widen
 * the set.** Corrected 2026-08-08: this said *"Operation IDs are never
 * selected by browser input"*, which stopped being true the moment a
 * submission started naming its operation — directly above the reader that
 * produces the set it names from. The set is built here, from the pinned
 * catalog alone, and `submitSurfaceRuntimeIntent` may only pick a member of
 * it.
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
      relationInputs: Object.freeze({ status: 'unavailable' as const }),
    });
  }

  const projection = view.projections.operation;
  if (projection.payloadSchemaVersion !== OPERATION_CATALOG_PAYLOAD_VERSION) {
    throw invalidBinding(
      'pinned operation projection has an invalid payload version',
    );
  }
  let operationCatalog: readonly RegisteredOperationDefinition[];
  try {
    operationCatalog = parsePinnedOperationCatalog(projection.payload);
  } catch (error) {
    throw invalidBinding(
      `pinned operation catalog is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const byOperationId = new Map<string, CompiledSurfaceOperationBinding>();
  const intentCount = new Map<SurfaceOperationIntent, number>();
  const surplus = new Map<SurfaceOperationIntent, string>();
  let relationInputs: readonly CompiledSurfaceRelationInput[] | null = null;
  let authorityUnavailable = false;
  for (const value of operationCatalog) {
    const operation = parseOperationBinding(value);
    const entityId =
      operation.entityId ??
      registeredSemanticQueryFromPinnedView(view, operation.readBackQueryId)
        ?.sourceEntityId;
    if (entityId !== query.sourceEntityId) continue;
    // Lifecycle-independent on purpose: the relations an entity carries are a
    // property of the entity, and an update form must disclose that they are
    // frozen even where the create effect has been retired.
    if (operation.intent === 'create') {
      // A create with NO contract carries no authority, so the entity's
      // authority is unavailable even though a create exists. `known` requires
      // that EVERY create declared one and that they agree.
      if (operation.relationInputs === null) {
        authorityUnavailable = true;
      } else if (relationInputs === null) {
        relationInputs = operation.relationInputs;
      } else if (
        !sameRelationInputs(relationInputs, operation.relationInputs)
      ) {
        throw invalidBinding(
          'surface entity has create operations declaring different relation inputs',
        );
      }
    }
    if (operation.lifecycle !== 'active') continue;
    // The KNOWN LIMIT comment that stood here is deleted rather than moved:
    // it said an entity carrying a release AND a cancel "binds neither and
    // refuses by name", and named the rendering question as owed. That is what
    // this packet answered. `command` now admits many; the other four still
    // refuse, and INTENT_RENDERED_ARITY carries the reason.
    const bound = (intentCount.get(operation.intent) ?? 0) + 1;
    if (
      bound > INTENT_RENDERED_ARITY[operation.intent] &&
      !surplus.has(operation.intent)
    )
      surplus.set(
        operation.intent,
        `surface entity has more than one active ${operation.tier} ${operation.intent} operation`,
      );
    intentCount.set(operation.intent, bound);
    byOperationId.set(
      operation.operationId,
      Object.freeze({
        capabilityId: operation.capabilityId,
        confirmation: operation.confirmation,
        inputFields: operation.inputFields,
        intent: operation.intent,
        label: operationLabel(operation.operationId),
        operationId: operation.operationId,
        precondition: operation.precondition,
        systemInputArgumentKey: operation.systemInputArgumentKey,
      }),
    );
  }

  // A surplus is refused by name wherever it could render. `create` and
  // `update` render only through the family's form; a family that declares no
  // active form has nowhere to render either, so its surplus is left unbound
  // (the operations stay governed through their own gateways) instead of making
  // its read-only List and Record unreadable.
  for (const [intent, message] of surplus) {
    if (
      (intent !== 'create' && intent !== 'update') ||
      familyDeclaresForm(view, query.sourceEntityId)
    )
      throw invalidBinding(message);
    for (const [operationId, operation] of byOperationId)
      if (operation.intent === intent) byOperationId.delete(operationId);
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
    relationInputs:
      authorityUnavailable || relationInputs === null
        ? Object.freeze({ status: 'unavailable' as const })
        : Object.freeze({ relationInputs, status: 'known' as const }),
  });
}

/** Whether any active form surface in the pinned release edits this entity. */
function familyDeclaresForm(
  view: RuntimeViewContract.RequestRuntimeView,
  entityId: string,
): boolean {
  return readCompiledSurfaceManifest(view).surfaces.some(
    (surface) =>
      surface.lifecycle === 'active' &&
      surface.surfaceRole === 'form' &&
      registeredSemanticQueryFromPinnedView(view, surface.dataSourceQueryId)
        ?.sourceEntityId === entityId,
  );
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
    payload.navigation !== undefined
      ? parseNavigationTree(payload.navigation, surfaces)
      : null;
  if (
    payloadSchemaVersion !== COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION &&
    surfaces.some((surface) => surface.composition)
  )
    throw new SurfaceProjectionError(
      'UNSUPPORTED_SURFACE_VERSION',
      'composition requires the v2 surface envelope',
    );
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
  return surface.workspace
    ? surface.workspace.membership !== 'contextual'
    : surface.surfaceRole === 'list' ||
        (surface.surfaceRole === null &&
          (surface.archetype === 'list' ||
            surface.archetype === 'home' ||
            surface.archetype === 'task'));
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
    ...(value.composition === undefined
      ? {}
      : { composition: SurfaceCompositionSchema.parse(value.composition) }),
    ...(value.workspace === undefined
      ? {}
      : { workspace: SurfaceWorkspaceSchema.parse(value.workspace) }),
    ...(value.list === undefined
      ? {}
      : { list: SurfaceListSchema.parse(value.list) }),
    ...(value.documentEditor === undefined
      ? {}
      : {
          documentEditor: SurfaceDocumentEditorSchema.parse(
            value.documentEditor,
          ),
        }),
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
    throw invalidField(
      `${at} (${value.fieldId}) declares a non-array option list`,
    );
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

function parseOperationBinding(value: RegisteredOperationDefinition): {
  readonly capabilityId: string | null;
  readonly confirmation: RegisteredOperationDefinition['confirmation'];
  readonly entityId: string | null;
  readonly inputFields: readonly CompiledSurfaceInputField[] | null;
  readonly intent: SurfaceOperationIntent;
  readonly lifecycle: RegisteredOperationDefinition['lifecycle'];
  readonly operationId: string;
  readonly precondition: Readonly<
    Record<string, RuntimeViewContract.ImmutableJsonValue>
  >;
  readonly readBackQueryId: string;
  readonly relationInputs: readonly CompiledSurfaceRelationInput[] | null;
  readonly systemInputArgumentKey:
    RegisteredOperationSystemInput['argumentKey'] | null;
  readonly tier: RegisteredOperationDefinition['tier'];
} {
  // The whole catalog was admitted before entity selection, so this reader
  // only interprets the shared authority's discriminated result. It keeps no
  // envelope, identity, or per-definition validator of its own.
  const effect = value.effect;
  const capabilityEffect = effect.kind === 'registeredCapabilityEffect';
  const intent = capabilityEffect ? 'command' : operationIntent(effect.kind);
  if (!intent) {
    throw invalidBinding(
      'pinned operation catalog contains a destructive or unknown effect',
    );
  }
  return {
    capabilityId: capabilityEffect ? effect.capability.targetId : null,
    confirmation: value.confirmation,
    entityId: capabilityEffect ? null : effect.entity.targetId,
    inputFields:
      value.inputContract === undefined
        ? null
        : Object.freeze(
            value.inputContract.fields
              .filter(
                (field) =>
                  field.writable &&
                  value.inputContract!.writableFieldIds.includes(field.fieldId),
              )
              .map((field) =>
                Object.freeze({
                  fieldId: field.fieldId,
                  kind: field.fieldKind,
                  temporal: field.temporal,
                  bounds: field.bounds,
                  required: field.required,
                }),
              ),
          ),
    intent,
    lifecycle: value.lifecycle,
    operationId: value.operationId,
    precondition: value.precondition as Readonly<
      Record<string, RuntimeViewContract.ImmutableJsonValue>
    >,
    readBackQueryId: value.readBackQueryId,
    relationInputs: parseRelationInputs(value.inputContract),
    systemInputArgumentKey:
      value.inputContract?.systemInput?.argumentKey ?? null,
    tier: value.tier,
  };
}

/**
 * Returns `null` when the operation declares NO input contract at all, which is
 * a legitimate compiled state: the projection emits `inputContract` only for the
 * current language version, so a historical create arrives without one. Reading
 * that absence as an empty relation list is a positive assertion this reader
 * cannot support, and it is what re-collapsed unknown into none once already.
 */
function parseRelationInputs(
  inputContract: RegisteredOperationInputContract | undefined,
): readonly CompiledSurfaceRelationInput[] | null {
  if (inputContract === undefined) return null;
  const carriesTargets =
    inputContract.schemaVersion === 'northstar.module-input-contract/v3' ||
    inputContract.schemaVersion === 'northstar.module-input-contract/v4';
  return Object.freeze(
    inputContract.relationInputs.map((relation) =>
      Object.freeze({
        archiveBehavior: relation.archiveBehavior,
        relationId: relation.relationId,
        required: relation.required,
        targetEntityId: carriesTargets ? relation.targetEntityId! : null,
      }),
    ),
  );
}

function sameRelationInputs(
  left: readonly CompiledSurfaceRelationInput[],
  right: readonly CompiledSurfaceRelationInput[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (relation, index) =>
        relation.relationId === right[index]?.relationId &&
        relation.required === right[index]?.required &&
        relation.targetEntityId === right[index]?.targetEntityId &&
        // archiveBehavior is compared too. Dropping it made two contracts that
        // differ only on archive behaviour count as "agreement", which the
        // phrase entity relation AUTHORITY does not survive.
        relation.archiveBehavior === right[index]?.archiveBehavior,
    )
  );
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
