/**
 * The business map: what this release's ERP holds and can do, generated from
 * the pinned projections and given to the model at the start of a session,
 * so it does not spend turns discovering it (AGENT-3 slice 1).
 *
 * Two halves, deliberately apart:
 * - `businessMapStructure(view)` is the unfiltered structure. It depends only
 *   on the release content, so it is cached by release root (plan §9.2.1
 *   allows caching summaries by release content hash). A tenant-authored
 *   release has its own root, so a customized record type appears in it.
 * - `renderBusinessMap(structure, usable)` filters it per person through the
 *   ids the gateways' eligibility previews allowed (the session asks the
 *   routed gateways), and is never cached: one person's map is never served
 *   to another.
 *
 * Ids are written by their local name (`sales_order_create`); the session
 * accepts a local name wherever a full id is asked for and it is unique.
 */
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import type { RegisteredOperationDefinition } from '../../runtime/src/semantic-operation-gateway.js';

import {
  effectKind,
  isRecord,
  localName,
  pinnedCatalog,
  type PinnedCatalog,
} from './catalog.js';

export interface MapField {
  readonly id: string;
  readonly kind: string;
  readonly required: boolean;
  readonly options: readonly string[];
}

export interface MapOperation {
  readonly operationId: string;
  readonly tier: string;
  /** create, update, archive, restore, `a -> b`, or the capability's name. */
  readonly does: string;
  readonly confirmation: string;
  readonly fields: readonly MapField[];
  readonly relations: readonly {
    id: string;
    required: boolean;
    target: string;
  }[];
  readonly takesArguments: boolean;
}

export interface MapQuery {
  readonly queryId: string;
  readonly type: string;
  readonly views: readonly { id: string; label: string }[];
  readonly matchesOn: readonly string[];
}

export interface MapAction {
  readonly screen: string;
  readonly label: string;
  /** Operation ids, in order. */
  readonly steps: readonly { operationId: string; inputs: string }[];
}

export interface MapEntity {
  readonly entityId: string;
  readonly label: string;
  readonly states: readonly string[];
  readonly operations: readonly MapOperation[];
  readonly queries: readonly MapQuery[];
  readonly actions: readonly MapAction[];
}

export interface BusinessMapStructure {
  readonly releaseRoot: string;
  readonly entities: readonly MapEntity[];
}

const structures = new Map<string, BusinessMapStructure>();
const maximumCachedReleases = 8;

/** The unfiltered map of the pinned release, cached by its release root. */
export function businessMapStructure(
  view: RequestRuntimeView,
): BusinessMapStructure {
  const root = view.release.contentHash;
  const cached = structures.get(root);
  if (cached) return cached;
  const built = buildStructure(root, pinnedCatalog(view), view);
  structures.set(root, built);
  while (structures.size > maximumCachedReleases)
    structures.delete(structures.keys().next().value!);
  return built;
}

/** How many release structures are cached (tests). */
export function cachedBusinessMapReleases(): readonly string[] {
  return [...structures.keys()];
}

interface SurfaceField {
  readonly fieldId: string;
  readonly options?: readonly { label: string; optionId: string }[];
}

interface SurfaceEntry {
  readonly surfaceId: string;
  readonly archetype: string;
  readonly label?: string;
  readonly dataSourceQueryId?: string;
  readonly fields?: readonly SurfaceField[];
  readonly composition?: { readonly actions?: readonly SurfaceAction[] };
}

interface SurfaceAction {
  readonly label: string;
  readonly inputs?: readonly {
    inputId: string;
    label: string;
    required?: boolean;
  }[];
  readonly steps?: readonly {
    readonly operation: { readonly targetId: string };
    readonly bindings?: readonly {
      readonly path: readonly string[];
      readonly value: Readonly<Record<string, ImmutableJsonValue>>;
    }[];
  }[];
}

function buildStructure(
  releaseRoot: string,
  catalog: PinnedCatalog,
  view: RequestRuntimeView,
): BusinessMapStructure {
  const surfaces = (
    (
      view.projections.surface.payload as unknown as {
        surfaces?: readonly SurfaceEntry[];
      }
    ).surfaces ?? []
  ).filter((surface) => typeof surface.surfaceId === 'string');
  const queryEntity = (queryId: string | undefined) =>
    queryId ? (catalog.query(queryId)?.sourceEntityId ?? '') : '';

  const byEntity = new Map<
    string,
    {
      operations: MapOperation[];
      queries: MapQuery[];
      actions: MapAction[];
      label: string;
      states: string[];
    }
  >();
  const slot = (entityId: string) => {
    let entry = byEntity.get(entityId);
    if (!entry) {
      entry = {
        operations: [],
        queries: [],
        actions: [],
        label: '',
        states: [],
      };
      byEntity.set(entityId, entry);
    }
    return entry;
  };

  for (const operation of catalog.operations) {
    const entity = catalog.operationEntity(operation);
    if (!entity) continue;
    slot(entity).operations.push(mapOperation(operation));
  }
  for (const query of catalog.queries) {
    if (!query.sourceEntityId) continue;
    const preset = catalog.preset(query.queryId);
    slot(query.sourceEntityId).queries.push({
      queryId: query.queryId,
      type: query.queryType,
      views: (preset?.views ?? []).map((view) => ({
        id: view.viewId,
        label: view.label,
      })),
      matchesOn: (query.resolveMatchKeys ?? []).map((key) => key.fieldId),
    });
  }
  for (const surface of surfaces) {
    const entity = queryEntity(surface.dataSourceQueryId);
    if (!entity || !byEntity.has(entity)) continue;
    const entry = slot(entity);
    if (
      surface.archetype === 'list' &&
      surface.label &&
      (!entry.label ||
        localName(surface.surfaceId) === `${localName(entity)}_list`)
    )
      entry.label = surface.label;
    if (surface.archetype === 'record') {
      if (entry.states.length === 0)
        for (const field of surface.fields ?? [])
          if (
            /(?:_state|_lifecycle)$/u.test(field.fieldId) &&
            field.options &&
            field.options.length > 0
          ) {
            entry.states.push(...field.options.map((option) => option.label));
            break;
          }
      for (const action of surface.composition?.actions ?? []) {
        const steps = (action.steps ?? []).map((step) => ({
          operationId: step.operation.targetId,
          inputs: describeBindings(
            step.bindings ?? [],
            action,
            localName(entity),
            localName(
              catalog.operationEntity(
                catalog.operation(step.operation.targetId) ??
                  ({ effect: {}, readBackQueryId: '' } as never),
              ),
            ),
          ),
        }));
        if (steps.length > 0)
          entry.actions.push({
            screen: surface.label ?? localName(surface.surfaceId),
            label: action.label,
            steps,
          });
      }
    }
  }
  const entities = [...byEntity.entries()]
    .filter(
      ([, entry]) => entry.operations.length > 0 || entry.queries.length > 0,
    )
    .map(([entityId, entry]) => ({
      entityId,
      label: entry.label || localName(entityId).replaceAll('_', ' '),
      states: entry.states,
      operations: entry.operations.sort((a, b) =>
        a.operationId.localeCompare(b.operationId),
      ),
      queries: entry.queries.sort((a, b) => a.queryId.localeCompare(b.queryId)),
      actions: entry.actions,
    }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
  return Object.freeze({ releaseRoot, entities });
}

function mapOperation(operation: RegisteredOperationDefinition): MapOperation {
  const effect = (operation as unknown as { effect?: Record<string, unknown> })
    .effect;
  const kind = effectKind(operation);
  const does =
    kind === 'createRecordEffect'
      ? 'create'
      : kind === 'updateRecordEffect'
        ? 'update'
        : kind === 'archiveRecordEffect'
          ? 'archive'
          : kind === 'restoreRecordEffect'
            ? 'restore'
            : kind === 'transitionStateEffect'
              ? `${localName(String(effect?.fromStateId))} -> ${localName(String(effect?.toStateId))}`
              : kind === 'registeredCapabilityEffect' &&
                  isRecord(effect?.capability)
                ? `runs ${localName(String(effect.capability.targetId))}`
                : 'acts';
  const contract = operation.inputContract;
  const assigned = new Set(
    (contract?.assignedFields ?? []).map((field) => field.fieldId),
  );
  const fields =
    does === 'create' || does === 'update'
      ? (contract?.fields ?? [])
          .filter((field) => field.writable && !assigned.has(field.fieldId))
          .map((field) => ({
            id: field.fieldId,
            kind: field.fieldKind.replace(/FieldType$/u, ''),
            required: field.required,
            options: [...field.enumOptionIds],
          }))
      : [];
  return {
    operationId: operation.operationId,
    tier: String((operation as unknown as { tier?: string }).tier ?? ''),
    does,
    confirmation: operation.confirmation,
    fields,
    relations: (contract?.relationInputs ?? []).map((relation) => ({
      id: relation.relationId,
      required: relation.required,
      target: relation.targetEntityId ?? '',
    })),
    takesArguments: (contract?.closedArgumentKeys ?? []).includes('arguments'),
  };
}

/** One step's inputs in short words: `field<-source`. Host-owned keys are left out. */
function describeBindings(
  bindings: NonNullable<
    NonNullable<SurfaceAction['steps']>[number]['bindings']
  >,
  action: SurfaceAction,
  recordEntity: string,
  entity: string,
): string {
  const labels = new Map(
    (action.inputs ?? []).map((input) => [input.inputId, input.label]),
  );
  const parts: string[] = [];
  for (const binding of bindings) {
    const [bag, id] = binding.path;
    if (bag !== 'values' && bag !== 'relations' && bag !== 'arguments') {
      if (bag === 'recordId' && binding.value.source === 'step')
        parts.push(`target<-step ${localName(String(binding.value.stepId))}`);
      else if (bag === 'recordId' && binding.value.source === 'record')
        parts.push('target<-this record');
      continue;
    }
    const value = binding.value;
    const source =
      value.source === 'input'
        ? `"${labels.get(String(value.inputId)) ?? localName(String(value.inputId))}"`
        : value.source === 'record'
          ? `this record's ${value.field === 'recordId' ? 'id' : withoutPrefix(localName(String(value.field)), recordEntity)}`
          : value.source === 'step'
            ? `step ${localName(String(value.stepId))} ${localName(String(value.field))}`
            : value.source === 'literal'
              ? JSON.stringify(
                  typeof value.value === 'string' && id
                    ? withoutPrefix(localName(value.value), localName(id))
                    : value.value,
                )
              : value.source === 'generated'
                ? String(value.value) === 'instant'
                  ? 'now'
                  : String(value.value)
                : String(value.source);
    parts.push(`${id ? withoutPrefix(localName(id), entity) : bag}<-${source}`);
  }
  return parts.join(', ');
}

/**
 * The map as the model reads it, keeping only what the person may use now.
 * A screen action naming an operation the person may not run is left out.
 * Bounded: past `maximumCharacters`, field lists and then screen actions are
 * dropped (the model can still load a full contract with erp_discover).
 */
export function renderBusinessMap(
  structure: BusinessMapStructure,
  usable: { operations: ReadonlySet<string>; queries: ReadonlySet<string> },
  maximumCharacters = 60_000,
): string {
  for (const detail of ['full', 'noFields', 'idsOnly'] as const) {
    const text = render(structure, usable, detail);
    if (text.length <= maximumCharacters || detail === 'idsOnly') return text;
  }
  return '';
}

function render(
  structure: BusinessMapStructure,
  usable: { operations: ReadonlySet<string>; queries: ReadonlySet<string> },
  detail: 'full' | 'noFields' | 'idsOnly',
): string {
  const lines: string[] = [];
  for (const entity of structure.entities) {
    const operations = entity.operations.filter((op) =>
      usable.operations.has(op.operationId),
    );
    const queries = entity.queries.filter((query) =>
      usable.queries.has(query.queryId),
    );
    if (operations.length === 0 && queries.length === 0) continue;
    const name = localName(entity.entityId);
    const short = (id: string) => withoutPrefix(localName(id), name);
    lines.push(
      `## ${name} "${entity.label}"${entity.states.length > 0 ? ` states: ${entity.states.join(', ')}` : ''}`,
    );
    if (queries.length > 0)
      lines.push(
        `read: ${queries
          .map((query) => {
            const id = `${localName(query.queryId)}[${query.type}]`;
            if (detail === 'idsOnly') return id;
            const views =
              query.views.length > 0
                ? ` views ${query.views.map((view) => `${withoutPrefix(localName(view.id), localName(query.queryId))}="${view.label}"`).join(' ')}`
                : '';
            const matches =
              query.matchesOn.length > 0
                ? ` by ${query.matchesOn.map(short).join('/')}`
                : '';
            return `${id}${matches}${views}`;
          })
          .join('; ')}`,
      );
    const housekeeping: string[] = [];
    let createFields = '';
    for (const op of operations) {
      if (op.does === 'archive' || op.does === 'restore') {
        housekeeping.push(
          `${localName(op.operationId)}${op.confirmation === 'humanRequired' ? '!' : ''}`,
        );
        continue;
      }
      const head = `- ${localName(op.operationId)}${op.confirmation === 'humanRequired' ? '!' : ''}: ${op.does}`;
      if (
        detail !== 'full' ||
        (op.fields.length === 0 && op.relations.length === 0)
      ) {
        lines.push(head + (op.takesArguments ? '; takes arguments' : ''));
        continue;
      }
      const fields = op.fields
        .map(
          (field) =>
            `${short(field.id)}${field.required ? '*' : ''}${shortKind(field)}`,
        )
        .join(', ');
      const relations = op.relations
        .map(
          (relation) =>
            `${short(relation.id)}${relation.required ? '*' : ''}->${localName(relation.target)}`,
        )
        .join(', ');
      if (op.does === 'create') createFields = fields;
      const sameAsCreate = op.does === 'update' && fields === createFields;
      lines.push(
        `${head}${fields.length > 0 ? (sameAsCreate ? '; patch: the create fields' : `; ${op.does === 'update' ? 'patch' : 'values'} ${fields}`) : ''}${relations.length > 0 ? `; relations ${relations}` : ''}${op.takesArguments ? '; takes arguments' : ''}`,
      );
    }
    if (housekeeping.length > 0)
      lines.push(`- also ${housekeeping.join(', ')}`);
    if (detail !== 'idsOnly')
      for (const action of entity.actions) {
        if (
          !action.steps.every((step) => usable.operations.has(step.operationId))
        )
          continue;
        lines.push(
          `  screen "${action.label}": ${action.steps
            .map(
              (step) =>
                `${localName(step.operationId)}${step.inputs ? `(${step.inputs})` : ''}`,
            )
            .join(' > ')}`,
        );
      }
  }
  return lines.join('\n');
}

/** `sales_order_currency` under `sales_order` reads `currency`. */
export function withoutPrefix(local: string, prefix: string): string {
  return local.startsWith(`${prefix}_`) && local.length > prefix.length + 1
    ? local.slice(prefix.length + 1)
    : local;
}

function shortKind(field: MapField): string {
  if (field.options.length > 0)
    return `(${field.options
      .map((option) => withoutPrefix(localName(option), localName(field.id)))
      .join('|')})`;
  switch (field.kind) {
    case 'text':
      return '';
    case 'exactDecimal':
    case 'money':
    case 'quantity':
      return ':decimal';
    case 'dateTime':
      return ':datetime';
    default:
      return `:${field.kind}`;
  }
}
