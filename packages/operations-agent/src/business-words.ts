/**
 * The words the person reads (end review X16): a record type's business
 * label and a record's role, taken from what the release declares for its
 * screens, never from a hand list. A record type's label is its record
 * page's (`<type>_detail`, less " detail"); an option's label is the one its
 * screens show. A record type that holds roles (a child type `<type>_role`
 * with a `_kind` choice, as a contact holds "Customer" or "Supplier") is
 * named by its roles, and by none when it has none: its own type label is a
 * modelling word ("Party"), not the business's.
 */
import type { RegisteredOperationDefinition } from '../../runtime/src/semantic-operation-gateway.js';
import type { RequestRuntimeView } from '../../runtime/src/request-runtime-view.js';
import { effectKind, localName, type PinnedCatalog } from './catalog.js';

export interface RoleSource {
  /** The child record type that holds the roles. */
  readonly childEntity: string;
  readonly relationId: string;
  readonly kindFieldId: string;
  readonly listQueryId: string | null;
}

export interface BusinessWords {
  /** The label the screens show for an option or state, when declared. */
  optionLabel(optionId: string): string | undefined;
  /** A record type's business label, lower case ("sales order"). */
  typeLabel(entityId: string): string;
  /** Where a record type's roles are held, when it holds roles. */
  roleOf(entityId: string): RoleSource | undefined;
  /** The parent type a role type belongs to, when it is one. */
  roleParent(entityId: string): string | undefined;
}

interface SurfaceShape {
  readonly surfaceId?: string;
  readonly archetype?: string;
  readonly label?: string;
  readonly dataSourceQueryId?: string;
  readonly fields?: readonly {
    readonly options?: readonly { label?: string; optionId?: string }[];
  }[];
}

const cache = new WeakMap<object, BusinessWords>();

export function businessWords(
  view: RequestRuntimeView,
  catalog: PinnedCatalog,
): BusinessWords {
  const payload = view.projections.surface.payload as object;
  const cached = cache.get(payload);
  if (cached) return cached;
  const surfaces =
    (payload as { surfaces?: readonly SurfaceShape[] }).surfaces ?? [];
  const options = new Map<string, string>();
  const types = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) {
      const entry = value as { optionId?: unknown; label?: unknown };
      if (
        typeof entry.optionId === 'string' &&
        typeof entry.label === 'string' &&
        !options.has(entry.optionId)
      )
        options.set(entry.optionId, entry.label);
      Object.values(value).forEach(collect);
    }
  };
  for (const surface of surfaces) {
    collect(surface.fields ?? []);
    const entity = surface.dataSourceQueryId
      ? catalog.query(surface.dataSourceQueryId)?.sourceEntityId
      : undefined;
    if (
      entity &&
      surface.archetype === 'record' &&
      surface.label &&
      surface.surfaceId &&
      localName(surface.surfaceId) === `${localName(entity)}_detail`
    )
      types.set(entity, surface.label.replace(/\s+detail$/iu, ''));
  }
  const roles = new Map<string, RoleSource>();
  const parents = new Map<string, string>();
  for (const operation of catalog.operations) {
    if (effectKind(operation) !== 'createRecordEffect') continue;
    const child = catalog.operationEntity(operation);
    if (!localName(child).endsWith('_role')) continue;
    const kind = (operation.inputContract?.fields ?? []).find(
      (field) =>
        localName(field.fieldId).endsWith('_kind') &&
        field.enumOptionIds.length > 0,
    );
    const relation = (operation.inputContract?.relationInputs ?? []).find(
      (input) =>
        input.required &&
        input.targetEntityId &&
        localName(child) === `${localName(input.targetEntityId)}_role`,
    );
    if (!kind || !relation?.targetEntityId) continue;
    const list = catalog.queries.find(
      (query) =>
        query.sourceEntityId === child &&
        query.queryType === 'list' &&
        localName(query.queryId) === `${localName(child)}_list`,
    );
    roles.set(relation.targetEntityId, {
      childEntity: child,
      relationId: relation.relationId,
      kindFieldId: kind.fieldId,
      listQueryId: list?.queryId ?? null,
    });
    parents.set(child, relation.targetEntityId);
  }
  const words: BusinessWords = {
    optionLabel: (optionId) => options.get(optionId),
    typeLabel: (entityId) =>
      (
        types.get(entityId) ?? localName(entityId).replaceAll('_', ' ')
      ).toLowerCase(),
    roleOf: (entityId) => roles.get(entityId),
    roleParent: (entityId) => parents.get(entityId),
  };
  cache.set(payload, words);
  return words;
}

/** Roles as the person reads them: "customer", "customer and supplier". */
export function roleNoun(
  words: BusinessWords,
  kinds: readonly unknown[],
): string | null {
  const labels = [
    ...new Set(
      kinds
        .filter((kind): kind is string => typeof kind === 'string')
        .map((kind) =>
          (
            words.optionLabel(kind) ?? localName(kind).replaceAll('_', ' ')
          ).toLowerCase(),
        ),
    ),
  ];
  return labels.length > 0 ? labels.join(' and ') : null;
}

/**
 * What a step does, in the business's words, for the plan card. `noun` is
 * the record as the person knows it ("customer"); null when the release
 * gives it no business word, and then "record". The model's contract keeps
 * its own wording (`describeEffect`).
 */
export function businessEffect(
  words: BusinessWords,
  operation: RegisteredOperationDefinition,
  entity: string,
  noun: string | null,
  values: Readonly<Record<string, unknown>> = {},
): string {
  const effect = (operation as unknown as { effect?: Record<string, unknown> })
    .effect;
  const it = noun ?? 'record';
  const parent = words.roleParent(entity);
  if (parent && effect?.kind === 'createRecordEffect') {
    const kind = words.roleOf(parent)?.kindFieldId;
    const role = kind ? roleNoun(words, [values[kind]]) : null;
    return role ? `makes it a ${role}` : 'adds a role';
  }
  const state = (id: unknown) =>
    (
      words.optionLabel(String(id)) ??
      localName(String(id)).replaceAll('_', ' ')
    ).toLowerCase();
  switch (effect?.kind) {
    case 'createRecordEffect':
      return `adds a new ${it}`;
    case 'updateRecordEffect':
      return `changes this ${it}`;
    case 'archiveRecordEffect':
      return `archives this ${it} (it leaves the lists; nothing is deleted)`;
    case 'restoreRecordEffect':
      return `brings back this archived ${it}`;
    case 'transitionStateEffect':
      return `moves this ${it} from ${state(effect.fromStateId)} to ${state(effect.toStateId)}`;
    case 'registeredCapabilityEffect':
      return `carries out this ${it}; it may move stock or money, and it checks stock and status itself`;
    default:
      return `acts on this ${it}`;
  }
}
