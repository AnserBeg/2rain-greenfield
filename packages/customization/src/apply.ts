import type {
  CustomField,
  CustomizationPatch,
  UnsupportedCustomization,
} from './patch.js';
import { unsupported } from './patch.js';

/**
 * Patch application: an ordered patch chain applied to the first-party
 * AUTHORED application package yields the tenant's authored package, which the
 * canonical model then normalizes into the child revision (ADR-0013, plan
 * §5.6). Normalized bytes do not re-normalize, so the authored form is the
 * only base a patch can be applied to; the caller proves the base by comparing
 * its normalization against the parent revision's stored bytes.
 *
 * Pure and deterministic: the same base and the same chain give the same bytes.
 */

const version = 'v6' as const;

/** Every tenant-authored canonical id carries this prefix in its local part. */
export const TENANT_LOCAL_PREFIX = 'custom_' as const;

/**
 * Plan §10.6 for v1. A tenant may add a field or arrange a list on its own
 * record types, and on these first-party masters and document headers, whose
 * rows people enter through generic operations. The published inventory
 * posting set names only single fields of them (`item.base_unit`,
 * `item.lifecycle`, `location.lifecycle`), never the whole record, and a new
 * field is never one of those. Every other first-party entity -- lines,
 * posted facts, balances, reservations, counts, settings, and records a
 * capability without a published set writes -- is treated as inside a Tier B
 * dependency set, and a patch targeting it is refused.
 */
export const CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS = Object.freeze([
  'item',
  'location',
  'party',
  'purchase_order',
  'sales_order',
] as const);

export type CustomizationRefusalCode =
  | 'CUSTOMIZE_CHOICE_PLATFORM_OWNED'
  | 'CUSTOMIZE_DUPLICATE_LABEL'
  | 'CUSTOMIZE_RECORD_TYPE_EXISTS'
  | 'CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET'
  | 'CUSTOMIZE_TARGET_NOT_CHOICE'
  | 'CUSTOMIZE_TARGET_NOT_FOUND'
  | 'CUSTOMIZE_FIELD_NOT_ON_LIST';

export interface CustomizationRefusal {
  readonly code: CustomizationRefusalCode;
  readonly message: string;
  readonly patchIndex: number;
  readonly status: 'refused';
}

export interface AppliedCustomization {
  readonly authored: Record<string, unknown>;
  /** Evaluator bindings for the permissions the chain declares (ADR AUTH). */
  readonly permissionBindings: readonly CustomPermissionBinding[];
  readonly status: 'applied';
}

export interface CustomPermissionBinding {
  readonly action: string;
  readonly permissionId: string;
  readonly resource: string;
}

export type CustomizationApplication =
  | AppliedCustomization
  | CustomizationRefusal
  | (UnsupportedCustomization & { readonly patchIndex: number });

type Json = Record<string, unknown>;

export function applyCustomizationPatches(
  base: Readonly<Json>,
  patches: readonly CustomizationPatch[],
): CustomizationApplication {
  const authored = structuredClone(base) as Json;
  for (const [index, patch] of patches.entries()) {
    const outcome = applyOne(authored, patch, patches.slice(0, index));
    if (outcome) return Object.freeze({ ...outcome, patchIndex: index });
  }
  // A revision carrying a tenant patch is tenant-authored; the repository
  // checks the revision row against this value.
  if (patches.length > 0) {
    authored.package = {
      ...(authored.package as Json),
      provenance: 'tenantAuthored',
    };
  }
  return Object.freeze({
    authored,
    permissionBindings: customPermissionBindings(authored),
    status: 'applied' as const,
  });
}

/** The evaluator binding every tenant-declared permission needs to compile. */
export function customPermissionBindings(
  authored: Readonly<Json>,
): readonly CustomPermissionBinding[] {
  return Object.freeze(
    list(authored, 'permissions')
      .filter((permission) => isTenantId(String(permission.permissionId ?? '')))
      .map((permission) =>
        Object.freeze({
          action: String(permission.action),
          permissionId: String(permission.permissionId),
          resource: String((permission.resource as Json).targetId),
        }),
      ),
  );
}

export function isTenantId(id: string): boolean {
  return (id.split(':')[1] ?? '').split('.')[1]?.startsWith(TENANT_LOCAL_PREFIX)
    ? true
    : false;
}

type Outcome =
  Omit<CustomizationRefusal, 'patchIndex'> | UnsupportedCustomization;

function applyOne(
  authored: Json,
  patch: CustomizationPatch,
  previous: readonly CustomizationPatch[],
): Outcome | null {
  switch (patch.kind) {
    case 'addRecordType':
      return addRecordType(authored, patch.label, patch.fields);
    case 'addField':
      return addField(authored, patch, previous);
    case 'addChoice':
      return addChoice(authored, patch.enumField, patch.option);
    case 'arrangeLayout':
      return arrangeLayout(authored, patch);
  }
}

function addRecordType(
  authored: Json,
  label: string,
  fields: readonly CustomField[],
): Outcome | null {
  const namespace = namespaceOf(authored);
  const local = `${TENANT_LOCAL_PREFIX}${slug(label)}`;
  const id = (kind: string, suffix = '') =>
    `${namespace}:${kind}.${local}${suffix}`;
  const entityId = id('entity');
  // The one menu group every record type a tenant adds is listed under
  // (LOOK-1 round 2): declared by the expansion, never guessed from ids. Its
  // local id has a hyphen, which no record type's slug can produce.
  const groupId = `${namespace}:module.${TENANT_LOCAL_PREFIX}record-types`;
  if (
    list(authored, 'entities').some((entity) => entity.entityId === entityId) ||
    list(authored, 'modules').some(
      (module) =>
        module.moduleId !== groupId &&
        String(module.label).toLowerCase() === label.trim().toLowerCase(),
    )
  ) {
    return refusal(
      'CUSTOMIZE_RECORD_TYPE_EXISTS',
      `A record type called "${label.trim()}" already exists.`,
    );
  }
  const duplicate = firstDuplicate(fields.map((field) => slug(field.label)));
  if (duplicate) {
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      `Two fields of "${label.trim()}" would share the name "${duplicate}".`,
    );
  }
  const moduleId = id('module');
  const packageId = String((authored.package as Json).packageId);
  const orderKey =
    Math.max(
      0,
      ...list(authored, 'modules').map((module) => Number(module.orderKey)),
    ) + 10;
  const fieldDefinitions = fields.map((field, index) =>
    fieldDefinition(namespace, entityId, `${local}_${slug(field.label)}`, {
      ...field,
      // The first field names the record: always present, searchable.
      ...(index === 0 ? { required: true } : {}),
      orderKey: (index + 1) * 10,
      searchable: index === 0,
    }),
  );
  const fieldIds = fieldDefinitions.map((field) => String(field.fieldId));
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });

  if (!list(authored, 'modules').some((module) => module.moduleId === groupId))
    push(authored, 'modules', {
      composition: {
        kind: 'compositionSeam',
        schemaVersion: version,
        status: 'unsupported',
      },
      kind: 'moduleDefinition',
      label: 'Custom',
      moduleId: groupId,
      orderKey,
      ownerPackageId: packageId,
      schemaVersion: version,
    });
  push(authored, 'modules', {
    composition: {
      kind: 'compositionSeam',
      schemaVersion: version,
      status: 'unsupported',
    },
    kind: 'moduleDefinition',
    label: label.trim(),
    moduleId,
    orderKey: orderKey + 5,
    ownerPackageId: packageId,
    schemaVersion: version,
  });
  push(authored, 'entities', {
    entityId,
    kind: 'entityDefinition',
    label: label.trim(),
    module: reference('moduleReference', moduleId),
    orderKey: 10,
    schemaVersion: version,
    storage: reference('storageMappingReference', id('storage')),
  });
  push(authored, 'fields', ...fieldDefinitions);
  push(authored, 'storageMappings', {
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: id('storage'),
  });
  push(
    authored,
    'permissions',
    ...['create', 'read', 'update', 'archive', 'restore'].map((action) => ({
      action,
      kind: 'permissionDefinition',
      label: `${label.trim()} ${action}`,
      permissionId: id('permission', `_${action}`),
      resource: reference('entityReference', entityId),
      schemaVersion: version,
    })),
  );
  push(
    authored,
    'queries',
    ...['get', 'list', 'search', 'resolve'].map((queryType) => ({
      kind: 'queryDefinition',
      maximumResultCount: queryType === 'get' ? 1 : 100,
      module: reference('moduleReference', moduleId),
      permission: reference('permissionReference', id('permission', '_read')),
      queryId: id('query', `_${queryType}`),
      queryType,
      ...(queryType === 'resolve'
        ? {
            resolveMatchKeys: [
              {
                authority: 'advisory',
                field: reference('fieldReference', fieldIds[0]!),
                kind: 'resolveMatchKey',
                matchKeyId: id('resolve-key', '_name'),
                orderKey: 10,
                schemaVersion: version,
              },
            ],
          }
        : {}),
      schemaVersion: version,
      selections: fieldIds.map((fieldId, index) => ({
        field: reference('fieldReference', fieldId),
        kind: 'querySelection',
        orderKey: (index + 1) * 10,
        schemaVersion: version,
        selectionId: id('selection', `_${queryType}_${String(index + 1)}`),
      })),
      sourceEntity: reference('entityReference', entityId),
      tier: 'q0',
    })),
  );
  push(
    authored,
    'operations',
    ...(
      [
        ['create', 'createRecordEffect'],
        ['update', 'updateRecordEffect'],
        ['archive', 'archiveRecordEffect'],
        ['restore', 'restoreRecordEffect'],
      ] as const
    ).map(([action, kind]) => ({
      confirmation: action === 'archive' ? 'humanRequired' : 'none',
      effect: {
        entity: reference('entityReference', entityId),
        kind,
        schemaVersion: version,
      },
      kind: 'operationDefinition',
      module: reference('moduleReference', moduleId),
      operationId: id('operation', `_${action}`),
      permission: reference(
        'permissionReference',
        id('permission', `_${action}`),
      ),
      readBack: reference('queryReference', id('query', '_get')),
      schemaVersion: version,
      tier: 'o0',
    })),
  );
  const contentCapability = `${namespace}:capability.standard_surface_content`;
  const surfaces = (
    [
      ['list', 'list', ['title', 'dataGrid', 'bulkActions'], 'list'],
      [
        'detail',
        'record',
        ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
        'record',
      ],
      [
        'form',
        'record',
        ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
        'form',
      ],
    ] as const
  ).map(([suffix, archetype, slots, surfaceRole]) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      id('query', surfaceRole === 'list' ? '_list' : '_get'),
    ),
    kind: 'surfaceDefinition',
    label: suffix === 'list' ? label.trim() : `${label.trim()} ${suffix}`,
    module: reference('moduleReference', moduleId),
    schemaVersion: version,
    slots: slots.map((slot, index) => ({
      content: reference('opaqueSurfaceContentReference', contentCapability),
      kind: 'surfaceSlot',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      slot,
      slotId: id(
        'slot',
        `_${suffix}_${slot.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)}`,
      ),
    })),
    statusRoles: [],
    surfaceId: id('surface', `_${suffix}`),
    surfaceRole,
    workspace: {
      membership: surfaceRole === 'list' ? 'operational' : 'contextual',
      // Listed in the Custom group, not a group of its own (LOOK-1 round 2).
      ...(surfaceRole === 'list' ? { navigationModuleId: groupId } : {}),
    },
    ...(surfaceRole === 'list'
      ? {
          list: {
            columns: fieldIds.slice(0, 16).map((fieldId, index) => ({
              columnId: id(
                'list_column',
                `_list_${fieldId
                  .split('.')
                  .at(-1)!
                  .slice(local.length + 1)}`,
              ),
              field: fieldId,
              label: fields[index]!.label.trim(),
              orderKey: (index + 1) * 10,
              priority: index,
              role: index === 0 ? 'title' : 'value',
              sortable: true,
              ...(fields[index]!.type === 'date' ? { format: 'date' } : {}),
            })),
            defaultSort: [],
            filters: [],
            kind: 'surfaceList',
            pageSize: 50,
            schemaVersion: version,
            views: [],
          },
        }
      : {}),
  }));
  push(authored, 'surfaces', ...surfaces);
  push(authored, 'assertions', {
    assertionId: id('assertion', '_walking_slice'),
    evidenceKinds: [
      'structure',
      'provider',
      'userInterface',
      'agent',
      'migration',
      'recovery',
    ],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'queryInvocation',
      query: reference('queryReference', id('query', '_get')),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  });
  return null;
}

function addField(
  authored: Json,
  patch: Extract<CustomizationPatch, { kind: 'addField' }>,
  previous: readonly CustomizationPatch[],
): Outcome | null {
  const { entity: entityId, field } = patch;
  const legacy = 'legacy' in patch;
  const entity = list(authored, 'entities').find(
    (candidate) => candidate.entityId === entityId,
  );
  if (!entity) {
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      `There is no record type ${entityId} to add a field to.`,
    );
  }
  const boundary = tierBoundary(entityId);
  if (boundary) return boundary;
  const entityLocal = localOf(entityId);
  const fieldLocal = isTenantId(entityId)
    ? `${entityLocal}_${slug(field.label)}`
    : `${TENANT_LOCAL_PREFIX}${entityLocal}_${slug(field.label)}`;
  const namespace = namespaceOf(authored);
  const fieldId = `${namespace}:field.${fieldLocal}`;
  const siblings = list(authored, 'fields').filter(
    (candidate) => (candidate.entity as Json).targetId === entityId,
  );
  // Re-drafting the same formerly query-only field publishes its screens
  // on a new revision, retaining its canonical id, column and saved values.
  const prior = previous.findLast(
    (p) =>
      p.kind === 'addField' &&
      p.entity === entityId &&
      p.field.label === field.label,
  );
  const bindExisting =
    !legacy &&
    prior?.kind === 'addField' &&
    'legacy' in prior &&
    prior.field.type === field.type &&
    JSON.stringify(prior.field.options) === JSON.stringify(field.options) &&
    (!isTenantId(entityId) ||
      Boolean(prior.field.required) === Boolean(field.required));
  if (
    !bindExisting &&
    siblings.some(
      (candidate) =>
        candidate.fieldId === fieldId ||
        String(candidate.label).toLowerCase() ===
          field.label.trim().toLowerCase(),
    )
  ) {
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      `${String(entity.label)} already has a field called "${field.label.trim()}".`,
    );
  }
  if (!bindExisting)
    push(
      authored,
      'fields',
      fieldDefinition(namespace, entityId, fieldLocal, {
        ...field,
        // Other first-party callers can keep creating records without this field.
        ...(isTenantId(entityId) ? {} : { required: false }),
        orderKey:
          Math.max(
            0,
            ...siblings.map((candidate) => Number(candidate.orderKey)),
          ) + 10,
        searchable: false,
      }),
    );
  // A tenant record type's own list shows the new field as a column.
  if (!bindExisting && isTenantId(entityId)) {
    for (const surface of list(authored, 'surfaces')) {
      const declared = surface.list as Json | undefined;
      if (
        surface.surfaceId !== `${namespace}:surface.${entityLocal}_list` ||
        !declared ||
        (declared.columns as Json[]).length >= 16
      ) {
        continue;
      }
      const columns = declared.columns as Json[];
      columns.push({
        columnId: `${namespace}:list_column.${entityLocal}_list_${fieldLocal.slice(entityLocal.length + 1)}`,
        field: fieldId,
        label: field.label.trim(),
        orderKey:
          Math.max(0, ...columns.map((column) => Number(column.orderKey))) + 10,
        priority: columns.length,
        role: 'value',
        sortable: true,
        ...(field.type === 'date' ? { format: 'date' } : {}),
      });
    }
  }
  const family = list(authored, 'surfaces').filter((surface) =>
    ['form', 'detail', 'list'].some(
      (role) =>
        surface.surfaceId === `${namespace}:surface.${entityLocal}_${role}`,
    ),
  );
  const surfaceQueries = new Set<string>();
  if (!legacy) {
    for (const surface of family) {
      surfaceQueries.add(String((surface.dataSource as Json).targetId));
      const presentation = {
        fieldId,
        label: field.label.trim(),
        ...(isTenantId(entityId) ? {} : { disclosure: 'more' }),
      };
      const editor = surface.documentEditor as Json | undefined;
      if (editor) (editor.headerFields as Json[]).push(presentation);
      else if (surface.surfaceRole === 'form') {
        const form = (surface.form ??= {
          kind: 'surfaceForm',
          schemaVersion: version,
        }) as Json;
        ((form.fields ??= []) as Json[]).push(presentation);
      }
      const composition = surface.composition as Json | undefined;
      if (composition) {
        const fields = composition.fields as Json[];
        fields.push({
          columnId: `${namespace}:column.${fieldLocal}`,
          field: fieldId,
          label: field.label.trim(),
          orderKey: nextOrder(fields),
          showWhenEmpty: true,
        });
      }
      // A generic list (Party) already shows its selected fields. Declare
      // those columns before offering additional ones through Arrange.
      if (surface.surfaceRole === 'list' && !surface.list) {
        const query = list(authored, 'queries').find(
          (q) => q.queryId === (surface.dataSource as Json).targetId,
        )!;
        const columns = (query.selections as Json[])
          .filter((selection) => (selection.field as Json).targetId !== fieldId)
          .map((selection, index) => {
            const id = (selection.field as Json).targetId;
            const sibling = siblings.find((f) => f.fieldId === id)!;
            return {
              ...listColumn(namespace, entityLocal, sibling, index),
              role: index === 0 ? 'title' : 'value',
            };
          });
        surface.list = {
          kind: 'surfaceList',
          schemaVersion: version,
          columns,
          defaultSort: [],
          filters: [],
          views: [],
          pageSize: 50,
        };
      }
    }
  }
  for (const query of list(authored, 'queries')) {
    const plain =
      String(query.queryId) ===
      `${namespace}:query.${entityLocal}_${String(query.queryType)}`;
    if (
      query.tier !== 'q0' ||
      (query.sourceEntity as Json | undefined)?.targetId !== entityId ||
      !['get', 'list'].includes(String(query.queryType)) ||
      (!plain && !surfaceQueries.has(String(query.queryId)))
    )
      continue;
    const selections = query.selections as Json[];
    if (
      selections.some(
        (selection) => (selection.field as Json).targetId === fieldId,
      )
    )
      continue;
    selections.push({
      field: {
        kind: 'fieldReference',
        schemaVersion: version,
        targetId: fieldId,
      },
      kind: 'querySelection',
      orderKey:
        Math.max(
          0,
          ...selections.map((selection) => Number(selection.orderKey)),
        ) + 10,
      schemaVersion: version,
      selectionId: `${namespace}:selection.${fieldLocal}_${plain ? String(query.queryType) : localOf(String(query.queryId))}`,
    });
  }
  return null;
}

function nextOrder(entries: Json[]): number {
  return Math.max(0, ...entries.map((entry) => Number(entry.orderKey))) + 10;
}

function listColumn(
  namespace: string,
  entityLocal: string,
  field: Json,
  index: number,
): Json {
  return {
    columnId: `${namespace}:list_column.${entityLocal}_list_${localOf(String(field.fieldId))}`,
    field: field.fieldId,
    label: field.label,
    orderKey: (index + 1) * 10,
    priority: index,
    role: 'value',
    sortable: true,
    ...((field.fieldType as Json).kind === 'dateFieldType'
      ? { format: 'date' }
      : {}),
  };
}

function addChoice(
  authored: Json,
  enumFieldId: string,
  option: string,
): Outcome | null {
  const field = list(authored, 'fields').find(
    (candidate) => candidate.fieldId === enumFieldId,
  );
  if (!field) {
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      `There is no field ${enumFieldId} to add a choice to.`,
    );
  }
  // A first-party choice list can be branched on by a platform capability --
  // a location's inventory status decides what stock may be sold -- and no
  // published dependency set clears one yet (plan §10.6). v1 widens only the
  // choice lists a tenant added.
  if (!isTenantId(enumFieldId)) {
    return refusal(
      'CUSTOMIZE_CHOICE_PLATFORM_OWNED',
      `The choices of ${String(field.label)} belong to the platform; only a choice field added by customization can gain choices.`,
    );
  }
  const boundary = tierBoundary(String((field.entity as Json).targetId));
  if (boundary) return boundary;
  const fieldType = field.fieldType as Json;
  if (fieldType.kind !== 'enumFieldType') {
    return refusal(
      'CUSTOMIZE_TARGET_NOT_CHOICE',
      `${String(field.label)} is not a choice field.`,
    );
  }
  const options = fieldType.options as Json[];
  if (
    options.some(
      (candidate) =>
        String(candidate.label).toLowerCase() === option.trim().toLowerCase(),
    )
  ) {
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      `${String(field.label)} already offers "${option.trim()}".`,
    );
  }
  const fieldLocal = localOf(enumFieldId);
  options.push({
    kind: 'enumOption',
    label: option.trim(),
    optionId: `${namespaceOf(authored)}:option.${fieldLocal}_${slug(option)}`,
    orderKey:
      Math.max(0, ...options.map((candidate) => Number(candidate.orderKey))) +
      10,
    schemaVersion: version,
  });
  return null;
}

function arrangeLayout(
  authored: Json,
  patch: Extract<CustomizationPatch, { kind: 'arrangeLayout' }>,
): Outcome | null {
  const surface = list(authored, 'surfaces').find(
    (candidate) => candidate.surfaceId === patch.surface,
  );
  if (!surface) {
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      `There is no screen ${patch.surface} to arrange.`,
    );
  }
  if (patch.upFront) {
    if (
      surface.surfaceRole !== 'form' ||
      patch.order ||
      patch.hide ||
      patch.relabel
    )
      return unsupported(
        'arrangeLayout.upFront',
        'Choose added fields to show up front on one form.',
      );
    const query = list(authored, 'queries').find(
      (q) => q.queryId === (surface.dataSource as Json).targetId,
    )!;
    const entityId = String((query.sourceEntity as Json).targetId);
    const boundary = tierBoundary(entityId);
    if (boundary) return boundary;
    const fieldsOf = (s: Json) =>
      ((s.documentEditor as Json | undefined)?.headerFields ??
        (s.form as Json | undefined)?.fields ??
        []) as Json[];
    const eligible = fieldsOf(surface).filter((f) =>
      isTenantId(String(f.fieldId)),
    );
    const chosen = new Set(patch.upFront);
    if (patch.upFront.some((id) => !eligible.some((f) => f.fieldId === id)))
      return refusal(
        'CUSTOMIZE_TARGET_NOT_FOUND',
        'Choose a field added to this form.',
      );
    const required = new Set(
      list(authored, 'fields')
        .filter((f) => f.presence === 'required')
        .map((f) => f.fieldId),
    );
    for (const candidate of list(authored, 'surfaces')) {
      if (
        candidate !== surface &&
        (candidate.documentEditor as Json | undefined)?.headerFormSurfaceId !==
          surface.surfaceId
      )
        continue;
      for (const field of fieldsOf(candidate)) {
        if (!eligible.some((f) => f.fieldId === field.fieldId)) continue;
        if (chosen.has(String(field.fieldId)) || required.has(field.fieldId))
          delete field.disclosure;
        else field.disclosure = 'more';
      }
    }
    return null;
  }
  if (surface.surfaceRole !== 'list') {
    return unsupported(
      'arrangeLayout.recordPage',
      'This layout change arranges list columns. For a form, choose which added fields to show up front.',
    );
  }
  const query = list(authored, 'queries').find(
    (candidate) => candidate.queryId === (surface.dataSource as Json).targetId,
  );
  const entityId = String(
    ((query?.sourceEntity as Json | undefined)?.targetId as string) ?? '',
  );
  const boundary = tierBoundary(entityId);
  if (boundary) return boundary;
  let declared = surface.list as Json | undefined;
  if (!declared) {
    const fields = new Map(
      list(authored, 'fields').map((field) => [field.fieldId, field]),
    );
    declared = {
      kind: 'surfaceList',
      schemaVersion: version,
      columns: (query!.selections as Json[]).map((selection, index) => ({
        ...listColumn(
          namespaceOf(authored),
          localOf(entityId),
          fields.get((selection.field as Json).targetId)!,
          index,
        ),
        role: index === 0 ? 'title' : 'value',
      })),
      defaultSort: [],
      filters: [],
      views: [],
      pageSize: Math.min(50, Number(query!.maximumResultCount)),
    };
    surface.list = declared;
  }
  const columns = declared.columns as Json[];
  const byField = new Map(
    columns.map((column) => [String(column.field), column]),
  );
  // Every field of the listed entity may become a column. Only fields used
  // by this arrangement are added to the query, so earlier patches reproduce
  // their original selections and release roots.
  const selected = new Set(
    (query!.selections as Json[]).map((s) => (s.field as Json).targetId),
  );
  for (const field of list(authored, 'fields')) {
    const id = String(field.fieldId);
    if ((field.entity as Json).targetId === entityId && !byField.has(id))
      byField.set(
        id,
        listColumn(
          namespaceOf(authored),
          localOf(entityId),
          field,
          columns.length,
        ),
      );
  }
  for (const fieldId of [
    ...(patch.order ?? []),
    ...(patch.hide ?? []),
    ...(patch.relabel ?? []).map((entry) => entry.field),
  ]) {
    if (!byField.has(fieldId)) {
      return refusal(
        'CUSTOMIZE_FIELD_NOT_ON_LIST',
        `${String(surface.label)} has no column for ${fieldId}.`,
      );
    }
  }
  for (const entry of patch.relabel ?? []) {
    byField.get(entry.field)!.label = entry.label.trim();
  }
  const hidden = new Set(patch.hide ?? []);
  const ordered = [
    ...(patch.order ?? []).map((fieldId) => byField.get(fieldId)!),
    ...columns.filter(
      (column) => !(patch.order ?? []).includes(String(column.field)),
    ),
  ].filter((column) => !hidden.has(String(column.field)));
  if (ordered.length === 0) {
    return refusal(
      'CUSTOMIZE_FIELD_NOT_ON_LIST',
      `${String(surface.label)} must keep at least one column.`,
    );
  }
  for (const column of ordered) {
    if (selected.has(column.field)) continue;
    // Existing columns can also be derived outputs. Those already have a
    // declared provider and never become stored-field selections.
    if (!list(authored, 'fields').some((f) => f.fieldId === column.field))
      continue;
    const selections = query!.selections as Json[];
    selections.push({
      kind: 'querySelection',
      schemaVersion: version,
      selectionId: `${namespaceOf(authored)}:selection.custom_${localOf(String(query!.queryId))}_${localOf(String(column.field))}`,
      field: {
        kind: 'fieldReference',
        schemaVersion: version,
        targetId: column.field,
      },
      orderKey: nextOrder(selections),
    });
    selected.add(column.field);
  }
  const titleKept = ordered.some((column) => column.role === 'title');
  declared.columns = ordered.map((column, index) => ({
    ...column,
    orderKey: (index + 1) * 10,
    priority: index,
    ...(titleKept || index !== 0 ? {} : { role: 'title' }),
  }));
  const keptIds = new Set(
    (declared.columns as Json[]).map((column) => String(column.columnId)),
  );
  declared.defaultSort = (declared.defaultSort as Json[]).filter((sort) =>
    keptIds.has(String(sort.columnId)),
  );
  return null;
}

function tierBoundary(entityId: string): Outcome | null {
  if (isTenantId(entityId)) return null;
  if (
    (CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS as readonly string[]).includes(
      localOf(entityId),
    )
  ) {
    return null;
  }
  return refusal(
    'CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET',
    `${entityId} is read or written as a whole by a platform capability (plan §10.6), so it cannot be customized.`,
  );
}

function fieldDefinition(
  namespace: string,
  entityId: string,
  fieldLocal: string,
  field: CustomField & { orderKey: number; searchable: boolean },
): Json {
  const required = field.required === true;
  const common = {
    classification: 'internal',
    defaultSemantics: required ? 'none' : 'nullable',
    entity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: entityId,
    },
    fieldId: `${namespace}:field.${fieldLocal}`,
    kind: 'fieldDefinition',
    label: field.label.trim(),
    orderKey: field.orderKey,
    presence: required ? 'required' : 'optional',
    reportable: true,
    schemaVersion: version,
    searchable: field.searchable,
  };
  switch (field.type) {
    case 'text':
      return {
        ...common,
        collation: 'unicodeCaseInsensitive',
        fieldType: {
          kind: 'textFieldType',
          maximumLength: 240,
          schemaVersion: version,
        },
      };
    case 'number':
      return {
        ...common,
        collation: 'binary',
        fieldType: {
          kind: 'integerFieldType',
          representation: 'canonicalString',
          schemaVersion: version,
        },
      };
    case 'date':
      return {
        ...common,
        collation: 'binary',
        fieldType: {
          calendar: 'iso8601',
          kind: 'dateFieldType',
          schemaVersion: version,
          timezoneSemantics: 'calendarDate',
        },
      };
    case 'yesNo':
      return {
        ...common,
        collation: 'binary',
        fieldType: { kind: 'booleanFieldType', schemaVersion: version },
      };
    case 'choice':
      return {
        ...common,
        collation: 'binary',
        fieldType: {
          kind: 'enumFieldType',
          options: (field.options ?? []).map((option, index) => ({
            kind: 'enumOption',
            label: option.trim(),
            optionId: `${namespace}:option.${fieldLocal}_${slug(option)}`,
            orderKey: (index + 1) * 10,
            schemaVersion: version,
          })),
          schemaVersion: version,
        },
      };
  }
}

/** A label's canonical-id local: lower case words joined by underscores. */
export function slug(label: string): string {
  const words = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const joined = words.join('_').slice(0, 40).replace(/_+$/u, '');
  if (joined === '') return 'field';
  return /^[a-z]/u.test(joined) ? joined : `n${joined}`;
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function refusal(
  code: CustomizationRefusalCode,
  message: string,
): Omit<CustomizationRefusal, 'patchIndex'> {
  return Object.freeze({ code, message, status: 'refused' as const });
}

function namespaceOf(authored: Json): string {
  return String((authored.package as Json).namespace);
}

function localOf(id: string): string {
  return (id.split(':')[1] ?? '').split('.').slice(1).join('.');
}

function list(authored: Readonly<Json>, name: string): Json[] {
  const value = authored[name];
  if (!Array.isArray(value)) {
    throw new TypeError(`authored application is missing ${name}`);
  }
  return value as Json[];
}

function push(authored: Json, name: string, ...values: Json[]): void {
  list(authored, name).push(...values);
}
