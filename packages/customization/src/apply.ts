import {
  applyLayoutRevision,
  placeAddedLayoutField,
} from './layout-revision.js';
import type { LayoutDefinition } from '@north-star/canonical-model';
import {
  CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS,
  isNarrowableOperationId,
} from '@north-star/canonical-model';
import type {
  CustomField,
  CustomizationPatch,
  SingleCustomizationPatch,
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
export { CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS } from '@north-star/canonical-model';

export type CustomizationRefusalCode =
  | 'CUSTOMIZE_CHOICE_PLATFORM_OWNED'
  | 'CUSTOMIZE_DUPLICATE_LABEL'
  | 'CUSTOMIZE_RECORD_TYPE_EXISTS'
  | 'CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET'
  | 'CUSTOMIZE_TARGET_NOT_CHOICE'
  | 'CUSTOMIZE_TARGET_NOT_FOUND'
  | 'CUSTOMIZE_LIST_VIEW_INVALID'
  | 'CUSTOMIZE_FIELD_NOT_ON_LIST'
  | 'CUSTOMIZE_LAYOUT_CONFLICT';

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
  const previous: SingleCustomizationPatch[] = [];
  for (const [index, change] of patches.entries()) {
    const members = change.kind === 'changeSet' ? change.patches : [change];
    for (const patch of members) {
      const outcome = applyOne(authored, patch, previous);
      if (outcome) return Object.freeze({ ...outcome, patchIndex: index });
      previous.push(patch);
    }
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

export const ADD_LINK_LATER_CAPABILITY = 'links on a published record type';

export function addLinkLaterRefusal(): UnsupportedCustomization {
  return unsupported(
    ADD_LINK_LATER_CAPABILITY,
    'Links can be added when the record type is first created; adding one later is coming soon',
  );
}

export function recordTypeEntityId(namespace: string, label: string): string {
  return `${namespace}:entity.${TENANT_LOCAL_PREFIX}${slug(label)}`;
}

export function checkCreateTimeLinks(
  change: CustomizationPatch,
): UnsupportedCustomization | null {
  const members = change.kind === 'changeSet' ? change.patches : [change];
  const newTypes: string[] = [];
  for (const member of members) {
    if (member.kind === 'addRecordType') newTypes.push(member.label);
    if (member.kind === 'addLink') {
      const namespace = member.entity.split(':', 1)[0]!;
      if (
        !newTypes.some(
          (label) => recordTypeEntityId(namespace, label) === member.entity,
        )
      )
        return addLinkLaterRefusal();
    }
  }
  return null;
}

function applyOne(
  authored: Json,
  patch: SingleCustomizationPatch,
  previous: readonly SingleCustomizationPatch[],
): Outcome | null {
  switch (patch.kind) {
    case 'addRecordType':
      return addRecordType(authored, patch);
    case 'addField':
      return addField(authored, patch, previous);
    case 'addChoice':
      return addChoice(authored, patch.enumField, patch.option);
    case 'addLink':
      return addLink(authored, patch);
    case 'addLineTable':
      return addLineTable(authored, patch);
    case 'declareLifecycle':
      return declareLifecycle(authored, patch);
    case 'addLayoutRevision': {
      if (
        previous.some(
          (p) =>
            p.kind === 'addLayoutRevision' && p.revisionId === patch.revisionId,
        )
      )
        return refusal(
          'CUSTOMIZE_LAYOUT_CONFLICT',
          'This revision ID has already been used.',
        );
      const createdIds = new Set(
        patch.edits.filter((e) => e.kind === 'createSection').map((e) => e.id),
      );
      if (
        previous.some(
          (p) =>
            p.kind === 'addLayoutRevision' &&
            p.edits.some(
              (e) => e.kind === 'createSection' && createdIds.has(e.id),
            ),
        )
      )
        return refusal(
          'CUSTOMIZE_LAYOUT_CONFLICT',
          'A section already owns that ID.',
        );
      const problem = applyLayoutRevision(
        authored as unknown as LayoutDefinition,
        patch,
      );
      return problem ? refusal('CUSTOMIZE_LAYOUT_CONFLICT', problem) : null;
    }
    case 'arrangeLayout':
      return arrangeLayout(authored, patch);
    case 'saveListView':
      return saveListView(authored, patch);
    case 'addMetricCard':
      return addMetricCard(authored, patch);
    case 'saveWorkflow': {
      const workflows =
        authored.workflows === undefined ? [] : list(authored, 'workflows');
      authored.workflows = [
        ...workflows.filter(
          ({ workflowId }) => workflowId !== patch.workflow.workflowId,
        ),
        patch.workflow,
      ];
      return null;
    }
    case 'addDocumentField':
    case 'addUploadCategory':
      return addDocumentDeclaration(authored, patch);
    case 'addCalculatedDisplayField': {
      if (
        !isTenantId(patch.field.fieldId) ||
        !patch.field.fieldId.startsWith(`${namespaceOf(authored)}:field.`)
      ) {
        return refusal(
          'CUSTOMIZE_TARGET_NOT_FOUND',
          'Use a tenant field ID in the application namespace.',
        );
      }
      const fields =
        authored.calculatedDisplayFields === undefined
          ? []
          : list(authored, 'calculatedDisplayFields');
      if (fields.some((field) => field.fieldId === patch.field.fieldId)) {
        return refusal(
          'CUSTOMIZE_DUPLICATE_LABEL',
          'A calculated display field already uses that ID.',
        );
      }
      authored.calculatedDisplayFields = [...fields, patch.field];
      placeAddedLayoutField(
        authored as unknown as LayoutDefinition,
        patch.field.fieldId,
      );
      return null;
    }
    case 'addValidation': {
      if (
        !isTenantId(patch.rule.ruleId) ||
        !patch.rule.ruleId.startsWith(`${namespaceOf(authored)}:rule.`)
      ) {
        return refusal(
          'CUSTOMIZE_TARGET_NOT_FOUND',
          'Use a tenant rule ID in the application namespace.',
        );
      }
      const rules =
        authored.formulaRules === undefined
          ? []
          : list(authored, 'formulaRules');
      if (rules.some((rule) => rule.ruleId === patch.rule.ruleId)) {
        return refusal(
          'CUSTOMIZE_DUPLICATE_LABEL',
          'A validation rule already uses that ID.',
        );
      }
      authored.formulaRules = [...rules, patch.rule];
      return null;
    }
    case 'narrowPermission':
    case 'unNarrowPermission': {
      if (
        !isNarrowableOperationId(patch.target.id) ||
        !list(authored, 'operations').some(
          (operation) =>
            operation.operationId === patch.target.id &&
            operation.lifecycle !== 'retired',
        )
      )
        return refusal(
          'CUSTOMIZE_TARGET_NOT_FOUND',
          'Choose an active action to restrict.',
        );
      const restrictions =
        authored.operationRoleNarrowings === undefined
          ? []
          : list(authored, 'operationRoleNarrowings');
      const matches = (existing: Json) =>
        existing.operationId === patch.target.id &&
        existing.roleKey === patch.roleKey;
      const exists = restrictions.some(matches);
      if (patch.kind === 'unNarrowPermission') {
        if (!exists)
          return refusal(
            'CUSTOMIZE_TARGET_NOT_FOUND',
            'Choose an existing action restriction to remove.',
          );
        const remaining = restrictions.filter((entry) => !matches(entry));
        if (remaining.length) authored.operationRoleNarrowings = remaining;
        else delete authored.operationRoleNarrowings;
        return null;
      }
      if (exists)
        return refusal(
          'CUSTOMIZE_DUPLICATE_LABEL',
          'This action is already restricted for that role.',
        );
      authored.operationRoleNarrowings = [
        ...restrictions,
        { operationId: patch.target.id, roleKey: patch.roleKey },
      ];
      return null;
    }
  }
}

function addLink(
  authored: Json,
  patch: Extract<SingleCustomizationPatch, { kind: 'addLink' }>,
): Outcome | null {
  const entities = list(authored, 'entities');
  const source = entities.find((entity) => entity.entityId === patch.entity);
  const target = entities.find((entity) => entity.entityId === patch.target);
  if (!source || !target)
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      'Both record types must exist before adding a link.',
    );
  const namespace = namespaceOf(authored);
  const local = localOf(patch.entity);
  const surfaces = list(authored, 'surfaces');
  const surface = (role: string) =>
    surfaces.find(
      (candidate) =>
        candidate.surfaceId === `${namespace}:surface.${local}_${role}`,
    );
  const form = surface('form');
  const detail = surface('detail');
  const listing = surface('list')?.list as Json | undefined;
  if (!isTenantId(patch.entity) || !form || !detail || !listing)
    return unsupported(
      'links on this source record type',
      'Choose a tenant record type with its own list and record page.',
    );
  if (patch.required && patch.entity === patch.target)
    return unsupported(
      'required links to the same record type',
      'Make a link to the same record type optional so the first record can be created.',
    );
  const targetLabel = linkTarget(authored, patch.target);
  if (!targetLabel)
    return unsupported(
      'link target without a readable list and record page',
      `Choose a record type with a list and record page, such as ${String(source.label)}.`,
    );
  const relations = list(authored, 'relations');
  const existing = relations.filter(
    (relation) => (relation.sourceEntity as Json).targetId === patch.entity,
  );
  const relationId = `${namespace}:relation.${local}_${slug(patch.label)}`;
  if (relations.some((relation) => relation.relationId === relationId))
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      'This record type already has a link with that name.',
    );
  const columns = listing.columns as Json[];
  if (existing.length >= 4 || columns.length >= 16)
    return unsupported(
      'additional links on this record type',
      'A record page can show four links and a list can show sixteen columns.',
    );
  push(authored, 'relations', {
    archiveBehavior: 'restrict',
    cardinality: 'manyToOne',
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: nextOrder(existing),
    ownership: 'reference',
    relationId,
    required: patch.required ?? false,
    schemaVersion: version,
    sourceEntity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: patch.entity,
    },
    targetEntity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: patch.target,
    },
  });
  const composition = recordComposition(authored, detail, patch.entity);
  const fields = composition.fields as Json[];
  const column = {
    columnId: `${namespace}:column.${local}_link_${slug(patch.label)}`,
    field: relationId,
    label: patch.label,
    orderKey: nextOrder(fields),
  };
  const reference = (queryId: string) => ({
    query: {
      kind: 'queryReference',
      schemaVersion: version,
      targetId: queryId,
    },
    labelField: {
      kind: 'fieldReference',
      schemaVersion: version,
      targetId: targetLabel.fieldId,
    },
  });
  fields.push({ ...column, reference: reference(targetLabel.getQueryId) });
  const actions = composition.actions as Json[];
  actions.push({
    actionId: `${namespace}:action.${local}_open_${slug(patch.label)}`,
    label: `Open ${patch.label}`,
    description: `Open the linked ${patch.label}.`,
    orderKey: nextOrder(actions),
    conditions: [],
    inputs: [],
    steps: [],
    navigate: {
      surface: {
        kind: 'surfaceReference',
        schemaVersion: version,
        targetId: targetLabel.surfaceId,
      },
      query: reference(targetLabel.pageQueryId).query,
      record: { source: 'record', field: relationId },
    },
  });
  columns.push({
    ...column,
    orderKey: nextOrder(columns),
    reference: reference(targetLabel.queryId),
    relation: true,
    priority: columns.length,
    role: 'value',
    sortable: true,
  });
  if (form.documentEditor)
    appendEditorLink(
      form.documentEditor as Json,
      relationId,
      patch.label,
      targetLabel,
    );
  return null;
}

export function linkTarget(authored: Readonly<Json>, entityId: string) {
  const namespace = entityId.split(':')[0];
  const local = localOf(entityId);
  const queries = list(authored, 'queries');
  const query = queries.find(
    (candidate) => candidate.queryId === `${namespace}:query.${local}_list`,
  );
  const get = queries.find(
    (candidate) => candidate.queryId === `${namespace}:query.${local}_get`,
  );
  if (!query || !get) return null;
  const recordQueries = new Set(
    queries
      .filter(
        (candidate) =>
          candidate.queryType === 'get' &&
          (candidate.sourceEntity as Json).targetId === entityId,
      )
      .map((candidate) => candidate.queryId),
  );
  const detail = list(authored, 'surfaces').find(
    (surface) =>
      surface.surfaceRole === 'record' &&
      recordQueries.has((surface.dataSource as Json).targetId),
  );
  if (!detail) return null;
  const fields = new Map(
    list(authored, 'fields').map((field) => [field.fieldId, field]),
  );
  const selected = (query.selections as Json[]).map((selection) =>
    String((selection.field as Json).targetId),
  );
  const exactFields = new Set(
    (get.selections as Json[]).map((selection) =>
      String((selection.field as Json).targetId),
    ),
  );
  const usable = selected.filter(
    (fieldId) =>
      exactFields.has(fieldId) &&
      (fields.get(fieldId)?.fieldType as Json | undefined)?.kind ===
        'textFieldType',
  );
  const fieldId = usable.find((id) => id.endsWith('_name')) ?? usable[0];
  return fieldId
    ? {
        fieldId,
        queryId: String(query.queryId),
        getQueryId: String(get.queryId),
        pageQueryId: String((detail.dataSource as Json).targetId),
        surfaceId: String(detail.surfaceId),
        companyOwned: get.legalEntityScope !== undefined,
      }
    : null;
}

function appendEditorLink(
  editor: Json,
  fieldId: string,
  label: string,
  target: NonNullable<ReturnType<typeof linkTarget>>,
): void {
  const links = (editor.headerRelations ??= []) as Json[];
  links.push({
    fieldId,
    label,
    reference: {
      queryId: target.queryId,
      getQueryId: target.getQueryId,
      labelFieldIds: [target.fieldId],
    },
  });
}

function declareLifecycle(
  authored: Json,
  patch: Extract<SingleCustomizationPatch, { kind: 'declareLifecycle' }>,
): Outcome | null {
  const entity = list(authored, 'entities').find(
    (candidate) => candidate.entityId === patch.entity,
  );
  if (!entity)
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      `There is no record type ${patch.entity}.`,
    );
  if (!isTenantId(patch.entity))
    return unsupported(
      'first-party lifecycle changes',
      'Choose a tenant record type for this lifecycle.',
    );
  if (
    list(authored, 'stateMachines').some(
      (machine) => (machine.entity as Json).targetId === patch.entity,
    )
  ) {
    return unsupported(
      'editing a declared lifecycle',
      'This record type already has a lifecycle.',
    );
  }
  const stateSlugs = patch.states.map((state) => slug(state.label));
  const transitionSlugs = patch.transitions.map((transition) =>
    slug(transition.label),
  );
  if (firstDuplicate(stateSlugs) || firstDuplicate(transitionSlugs))
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      'Use distinct names for the states and for the actions.',
    );
  const initial = slug(patch.initial);
  const stateNames = new Set(stateSlugs);
  if (
    !stateNames.has(initial) ||
    patch.transitions.some(
      (transition) =>
        !stateNames.has(slug(transition.from)) ||
        !stateNames.has(slug(transition.to)) ||
        slug(transition.from) === slug(transition.to),
    )
  ) {
    return unsupported(
      'invalid lifecycle state',
      'The initial state and both ends of every action must be declared, and actions must move to a different state.',
    );
  }
  const namespace = namespaceOf(authored);
  const local = localOf(patch.entity);
  const id = (kind: string, suffix = '') =>
    `${namespace}:${kind}.${local}${suffix}`;
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });
  const stateRef = (name: string) =>
    reference('stateReference', id('state', `_${name}`));
  const machineId = id('machine');
  const stateFieldId = `${namespace}:derived_state_field.${machineId.split(':')[1]}`;
  const entityRef = reference('entityReference', patch.entity);
  push(authored, 'stateMachines', {
    entity: entityRef,
    initialState: stateRef(initial),
    kind: 'stateMachineDefinition',
    machineId,
    schemaVersion: version,
    states: patch.states.map((state, index) => ({
      kind: 'stateDefinition',
      label: state.label,
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      stateId: stateRef(stateSlugs[index]!).targetId,
      terminal: !patch.transitions.some(
        (transition) => slug(transition.from) === stateSlugs[index],
      ),
    })),
    transitions: patch.transitions.map((transition, index) => ({
      fromState: stateRef(slug(transition.from)),
      kind: 'transitionDefinition',
      label: transition.label,
      orderKey: (index + 1) * 10,
      permission: reference(
        'permissionReference',
        id('permission', `_action_${transitionSlugs[index]}`),
      ),
      schemaVersion: version,
      toState: stateRef(slug(transition.to)),
      transitionId: id('transition', `_${transitionSlugs[index]}`),
    })),
  });
  for (const [index, transition] of patch.transitions.entries()) {
    const localAction = transitionSlugs[index]!;
    const permissionId = id('permission', `_action_${localAction}`);
    push(authored, 'permissions', {
      action: 'transition',
      kind: 'permissionDefinition',
      label: transition.label,
      permissionId,
      resource: entityRef,
      schemaVersion: version,
    });
    push(authored, 'operations', {
      confirmation: 'humanRequired',
      effect: {
        kind: 'transitionStateEffect',
        schemaVersion: version,
        transition: reference(
          'transitionReference',
          id('transition', `_${localAction}`),
        ),
      },
      kind: 'operationDefinition',
      label: transition.label,
      module: entity.module,
      operationId: id('operation', `_action_${localAction}`),
      permission: reference('permissionReference', permissionId),
      precondition: statePrecondition(
        stateFieldId,
        stateRef(slug(transition.from)).targetId,
      ),
      readBack: reference('queryReference', id('query', '_get')),
      schemaVersion: version,
      tier: 'o0',
    });
  }
  for (const query of list(authored, 'queries')) {
    if ((query.sourceEntity as Json).targetId !== patch.entity) continue;
    const selections = query.selections as Json[];
    selections.push({
      field: reference('fieldReference', stateFieldId),
      kind: 'querySelection',
      orderKey: nextOrder(selections),
      schemaVersion: version,
      selectionId: id('selection', `_${String(query.queryType)}_state`),
    });
  }
  const surfaces = list(authored, 'surfaces');
  const detail = surfaces.find(
    (surface) => surface.surfaceId === id('surface', '_detail'),
  )!;
  const form = surfaces.find(
    (surface) => surface.surfaceId === id('surface', '_form'),
  )!;
  if (form.documentEditor) {
    const machine = list(authored, 'stateMachines').find(
      (candidate) => candidate.machineId === machineId,
    )!;
    Object.assign(
      form.documentEditor,
      editorLifecycle(authored, patch.entity, machine),
    );
  }
  const listing = surfaces.find(
    (surface) => surface.surfaceId === id('surface', '_list'),
  )!.list as Json;
  const columns = listing.columns as Json[];
  const statusColumn = {
    columnId: id('column', '-status'),
    field: stateFieldId,
    label: 'Status',
    orderKey: nextOrder(columns),
  };
  if (columns.length === 16)
    return unsupported(
      'a status column on a full list',
      'Hide one list column before adding a lifecycle. A list can show up to 16 columns.',
    );
  columns.push({
    ...statusColumn,
    priority: columns.length,
    role: 'status',
    sortable: true,
    statusRoles: patch.states.flatMap((state) =>
      state.role
        ? [
            {
              value: stateRef(slug(state.label)).targetId,
              role: state.role,
            },
          ]
        : [],
    ),
  });
  const composition = recordComposition(authored, detail, patch.entity);
  const fields = composition.fields as Json[];
  const stateCondition = (state: string) => ({
    value: { source: 'record', field: stateFieldId },
    operator: 'equals',
    compare: state,
  });
  fields.push({ ...statusColumn, orderKey: nextOrder(fields) });
  composition.presentation = {
    ...(composition.presentation as Json),
    header: {
      title: fields[0]!.columnId,
      facts: [],
      subtitle: [],
      status: statusColumn.columnId,
    },
    recordActions: 'progressive',
    technicalDetails: 'progressive',
    progression: {
      title: `${String(entity.label)} status`,
      steps: patch.states.map((state, index) => ({
        label: state.label,
        current: [stateCondition(stateRef(stateSlugs[index]!).targetId)],
        complete: [],
      })),
      next: [],
    },
  };
  return null;
}

function addMetricCard(
  authored: Json,
  patch: Extract<CustomizationPatch, { kind: 'addMetricCard' }>,
): Outcome | null {
  const namespace = namespaceOf(authored);
  const today = list(authored, 'surfaces').find(
    (surface) => surface.surfaceId === `${namespace}:surface.inventory_today`,
  );
  const launcher = today?.launcher as Json | undefined;
  const target = list(authored, 'surfaces').find(
    (surface) =>
      surface.surfaceId === patch.surface && surface.surfaceRole === 'list',
  );
  const targetList = target?.list as Json | undefined;
  const query = list(authored, 'queries').find(
    (candidate) =>
      candidate.queryId === (target?.dataSource as Json | undefined)?.targetId,
  );
  if (!launcher || !targetList || query?.tier !== 'q0' || query.readModel)
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      'Choose a list that reads records directly.',
    );
  if (
    patch.view &&
    !(targetList.views as Json[]).some((view) => view.viewId === patch.view)
  )
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      'Choose a saved view of this list.',
    );
  if (
    patch.sumField &&
    (targetList.progress ||
      targetList.figures ||
      !(query.listSumFields as string[] | undefined)?.includes(patch.sumField))
  )
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      'Choose a sum declared for this list.',
    );
  const metrics = (launcher.metrics ??= []) as Json[];
  const metricId = `${namespace}:metric.custom_${slug(patch.label)}`;
  if (metrics.some((metric) => metric.metricId === metricId))
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      'Today already has a metric card with that name.',
    );
  if (metrics.length >= 8)
    return unsupported(
      'addMetricCard.limit',
      'Today already has eight metric cards.',
    );
  metrics.push({
    metricId,
    label: patch.label,
    surface: patch.surface,
    ...(patch.view ? { view: patch.view } : {}),
    ...(patch.sumField ? { sumField: patch.sumField } : {}),
  });
  return null;
}

function addRecordType(
  authored: Json,
  patch: Extract<SingleCustomizationPatch, { kind: 'addRecordType' }>,
): Outcome | null {
  const { companyOwnership, fields, label } = patch;
  const namespace = namespaceOf(authored);
  const local = `${TENANT_LOCAL_PREFIX}${slug(label)}`;
  const id = (kind: string, suffix = '') =>
    `${namespace}:${kind}.${local}${suffix}`;
  const entityId = recordTypeEntityId(namespace, label);
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
    ...(companyOwnership === undefined ? {} : { companyOwnership }),
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
  addRecordOperations(
    authored,
    entityId,
    moduleId,
    label,
    fieldIds,
    companyOwnership === 'entityOwned',
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
      ...(companyOwnership === 'entityOwned'
        ? {
            entry: {
              companyQueryId: `${namespace}:query.legal_entity_list`,
              companyNameFieldId: `${namespace}:field.legal_entity_name`,
              companyStateFieldId: `${namespace}:field.legal_entity_status`,
              activeStateId: `${namespace}:option.legal_entity_status_active`,
              policy: 'authorizedSingleOrPreference',
              authorizationQueryId: id('query', '_list'),
            },
          }
        : {}),
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

function addRecordOperations(
  authored: Json,
  entityId: string,
  moduleId: string,
  label: string,
  fieldIds: readonly string[],
  companyOwned: boolean,
  nameFieldId = fieldIds[0]!,
): void {
  const namespace = namespaceOf(authored);
  const id = (kind: string, suffix = '') =>
    `${namespace}:${kind}.${localOf(entityId)}${suffix}`;
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
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
    ...['get', 'list', 'search', 'resolve'].map((queryType) => {
      const parameterId = id('parameter', `_${queryType}_legal_entity_scope`);
      return {
        kind: 'queryDefinition',
        ...(companyOwned
          ? {
              legalEntityScope: {
                cardinality: 'exactlyOne',
                kind: 'queryLegalEntityScope',
                operand: {
                  kind: 'queryParameterReference',
                  parameterId,
                  schemaVersion: version,
                },
                schemaVersion: version,
              },
              parameters: [
                {
                  kind: 'queryParameterDefinition',
                  orderKey: 10,
                  parameterId,
                  schemaVersion: version,
                },
              ],
            }
          : {}),
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
                  field: reference('fieldReference', nameFieldId),
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
      };
    }),
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
}

function addLineTable(
  authored: Json,
  patch: Extract<SingleCustomizationPatch, { kind: 'addLineTable' }>,
): Outcome | null {
  const parent = list(authored, 'entities').find(
    (entity) => entity.entityId === patch.entity,
  );
  const machine = list(authored, 'stateMachines').find(
    (candidate) => (candidate.entity as Json).targetId === patch.entity,
  );
  if (!parent || !isTenantId(patch.entity))
    return unsupported(
      'line tables on first-party record types',
      'Choose a tenant record type for this line table.',
    );

  const namespace = namespaceOf(authored);
  const parentLocal = localOf(patch.entity);
  const local = `${parentLocal}_lines`;
  const id = (kind: string, suffix = '') =>
    `${namespace}:${kind}.${local}${suffix}`;
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });
  const entityId = id('entity');
  const surfaces = list(authored, 'surfaces');
  const parentForm = surfaces.find(
    (surface) =>
      surface.surfaceId === `${namespace}:surface.${parentLocal}_form`,
  )!;
  const parentDetail = surfaces.find(
    (surface) =>
      surface.surfaceId === `${namespace}:surface.${parentLocal}_detail`,
  )!;
  if (
    parentForm.documentEditor ||
    list(authored, 'entities').some((entity) => entity.entityId === entityId)
  )
    return unsupported(
      'multiple line tables',
      'This record type already has a line table, or its generated line type name is in use.',
    );

  const nameIndex = patch.fields.findIndex((field) => field.type === 'text');
  if (nameIndex < 0)
    return unsupported(
      'line tables without a text field',
      'Add a text field such as Characteristic to identify the line.',
    );
  const duplicate = firstDuplicate([
    'line_number',
    ...patch.fields.map((field) => slug(field.label)),
  ]);
  if (duplicate)
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      `Two line fields would share the name "${duplicate}".`,
    );

  const moduleId = String((parent.module as Json).targetId);
  const lineNumberId = id('field', '_line_number');
  const fields = [
    { label: 'Line number', type: 'number', required: true } as const,
    ...patch.fields,
  ];
  const lineFields = fields.map((field, index) =>
    fieldDefinition(namespace, entityId, `${local}_${slug(field.label)}`, {
      ...field,
      orderKey: (index + 1) * 10,
      searchable: index === nameIndex + 1,
    }),
  );
  push(authored, 'entities', {
    ...(parent.companyOwnership === undefined
      ? {}
      : { companyOwnership: parent.companyOwnership }),
    entityId,
    kind: 'entityDefinition',
    label: patch.label,
    module: parent.module,
    orderKey: nextOrder(
      list(authored, 'entities').filter(
        (entity) => (entity.module as Json).targetId === moduleId,
      ),
    ),
    schemaVersion: version,
    storage: reference('storageMappingReference', id('storage')),
  });
  push(authored, 'fields', ...lineFields);
  push(authored, 'storageMappings', {
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: id('storage'),
  });
  const parentRelationId = id('relation', '_parent');
  push(authored, 'relations', {
    archiveBehavior: 'restrict',
    cardinality: 'manyToOne',
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: 10,
    ownership: 'parentScopedChild',
    relationId: parentRelationId,
    required: true,
    schemaVersion: version,
    sourceEntity: reference('entityReference', entityId),
    targetEntity: reference('entityReference', patch.entity),
  });
  addRecordOperations(
    authored,
    entityId,
    moduleId,
    patch.label,
    lineFields.map((field) => String(field.fieldId)),
    parent.companyOwnership === 'entityOwned',
    String(lineFields[nameIndex + 1]!.fieldId),
  );
  // The gateway uses the parent's update precondition for child mutations.
  const lifecycle = machine
    ? editorLifecycle(authored, patch.entity, machine)
    : {};
  const lineFormId = id('surface', '_form');
  for (const [role, suffix, source] of [
    ['form', '_form', parentForm],
    ['record', '_detail', parentDetail],
    [
      'list',
      '_list',
      surfaces.find(
        (surface) =>
          surface.surfaceId === `${namespace}:surface.${parentLocal}_list`,
      )!,
    ],
  ] as const) {
    push(authored, 'surfaces', {
      archetype: role === 'list' ? 'list' : 'record',
      dataSource: reference(
        'queryReference',
        id('query', role === 'list' ? '_list' : '_get'),
      ),
      kind: 'surfaceDefinition',
      label: `${patch.label} ${suffix.slice(1)}`,
      module: parent.module,
      schemaVersion: version,
      slots: (source.slots as Json[])
        .filter((slot) => slot.slot !== 'childTables')
        .map((slot) => ({
          ...slot,
          slotId: id(
            'slot',
            `${suffix}_${String(slot.slot).replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)}`,
          ),
        })),
      statusRoles: [],
      surfaceId: id('surface', suffix),
      surfaceRole: role,
      workspace: {
        ...(parentForm.workspace as Json),
        ownerSurfaceId: `${namespace}:surface.${parentLocal}_list`,
      },
    });
  }
  push(authored, 'assertions', {
    assertionId: id('assertion', '_read_line'),
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
  const headerFields = list(authored, 'fields').filter(
    (field) => (field.entity as Json).targetId === patch.entity,
  );
  parentForm.documentEditor = {
    ...lifecycle,
    ...(parent.companyOwnership === 'entityOwned'
      ? {}
      : { scope: 'tenantShared' }),
    headerFields: headerFields.map(editorField),
    headerFormSurfaceId: parentForm.surfaceId,
    kind: 'draftDocumentEditor',
    lineFields: lineFields.slice(1).map(editorField),
    lineFormSurfaceId: lineFormId,
    lineNumberFieldId: lineNumberId,
    lineQueryId: id('query', '_list'),
    linesLabel: patch.label,
    parentRelationId,
    recordSurfaceId: parentDetail.surfaceId,
    saveMode: 'sequential',
  };
  const composition = recordComposition(authored, parentDetail, patch.entity);
  for (const column of composition.fields as Json[]) {
    const relation = list(authored, 'relations').find(
      (candidate) => candidate.relationId === column.field,
    );
    if (!relation || relation.ownership !== 'reference') continue;
    const target = linkTarget(
      authored,
      String((relation.targetEntity as Json).targetId),
    );
    if (!target) throw new Error('A declared link has no picker target');
    appendEditorLink(
      parentForm.documentEditor as Json,
      String(relation.relationId),
      String(column.label),
      target,
    );
  }
  (composition.children as Json[]).push({
    columns: lineFields.map((field) => ({
      columnId: id('column', `_${slug(String(field.label))}`),
      field: field.fieldId,
      label: field.label,
      orderKey: field.orderKey,
    })),
    datasetId: id('dataset'),
    label: patch.label,
    orderKey: 10,
    parent: {
      relationId: parentRelationId,
      value: { source: 'record', field: 'recordId' },
      ownership: 'parentScopedChild',
    },
    presentation: { selection: 'none', compact: 'scrollTable' },
    query: reference('queryReference', id('query', '_list')),
    sort: [{ fieldId: lineNumberId, direction: 'ascending' }],
  });
  return null;
}

function editorLifecycle(
  authored: Json,
  entityId: string,
  machine: Json,
): Json {
  const namespace = namespaceOf(authored);
  const editableState = String((machine.initialState as Json).targetId);
  const stateFieldId = `${namespace}:derived_state_field.${String(machine.machineId).split(':')[1]}`;
  const updateId = `${namespace}:operation.${localOf(entityId)}_update`;
  const update = list(authored, 'operations').find(
    (operation) => operation.operationId === updateId,
  )!;
  update.precondition = statePrecondition(stateFieldId, editableState);
  return { stateFieldId, editableStateIds: [editableState] };
}

function recordComposition(
  authored: Json,
  surface: Json,
  entityId: string,
): Json {
  if (surface.composition) return surface.composition as Json;
  const namespace = namespaceOf(authored);
  const fields = list(authored, 'fields')
    .filter((field) => (field.entity as Json).targetId === entityId)
    .map((field) => ({
      columnId: `${namespace}:column.${localOf(String(field.fieldId))}`,
      field: field.fieldId,
      label: field.label,
      orderKey: field.orderKey,
      showWhenEmpty: true,
    }));
  ensureChildTables(authored, surface, localOf(entityId));
  const composition = {
    kind: 'surfaceComposition',
    schemaVersion: version,
    fields,
    children: [],
    actions: [],
    presentation: {
      header: { title: fields[0]!.columnId, facts: [], subtitle: [] },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
  };
  surface.composition = composition;
  return composition;
}

function ensureChildTables(authored: Json, surface: Json, local: string): void {
  const slots = surface.slots as Json[];
  if (slots.some((slot) => slot.slot === 'childTables')) return;
  const namespace = namespaceOf(authored);
  slots.push({
    content: {
      kind: 'opaqueSurfaceContentReference',
      schemaVersion: version,
      targetId: `${namespace}:capability.standard_surface_content`,
    },
    kind: 'surfaceSlot',
    orderKey: nextOrder(slots),
    schemaVersion: version,
    slot: 'childTables',
    slotId: `${namespace}:slot.${local}_detail_child_tables`,
  });
}

function editorField(field: Json): Json {
  const type = field.fieldType as Json;
  return {
    fieldId: field.fieldId,
    label: field.label,
    ...(type.kind === 'enumFieldType'
      ? {
          presentation: {
            kind: 'choice',
            options: (type.options as Json[]).map((option) => ({
              label: option.label,
              value: option.optionId,
            })),
          },
        }
      : {}),
  };
}

function statePrecondition(fieldId: string, stateId: string): Json {
  return {
    field: {
      kind: 'fieldReference',
      schemaVersion: version,
      targetId: fieldId,
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: version,
    value: { kind: 'textValue', schemaVersion: version, value: stateId },
  };
}

function addDocumentDeclaration(
  authored: Json,
  patch: Extract<
    SingleCustomizationPatch,
    { kind: 'addDocumentField' | 'addUploadCategory' }
  >,
): Outcome | null {
  const { kind, ...declaration } = patch;
  const collection =
    kind === 'addDocumentField' ? 'documentFields' : 'documentCategories';
  const idKey = kind === 'addDocumentField' ? 'fieldId' : 'categoryId';
  if (
    !list(authored, 'entities').some(
      (entity) => entity.entityId === declaration.entityId,
    )
  )
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      'Choose an existing record type.',
    );
  const id = kind === 'addDocumentField' ? patch.fieldId : patch.categoryId;
  if (!isTenantId(id) || id.split(':')[0] !== namespaceOf(authored))
    return refusal(
      'CUSTOMIZE_TARGET_NOT_FOUND',
      'Use a stable tenant ID for this declaration.',
    );
  const declarations = authored[collection] ? list(authored, collection) : [];
  if (declarations.some((item) => item[idKey] === id))
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      'This document declaration already exists.',
    );
  authored[collection] = [
    ...declarations,
    { ...declaration, schemaVersion: version },
  ];
  return null;
}

function addField(
  authored: Json,
  patch: Extract<CustomizationPatch, { kind: 'addField' }>,
  previous: readonly SingleCustomizationPatch[],
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
  placeAddedLayoutField(authored as unknown as LayoutDefinition, fieldId);
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
    columnId: listColumnId(namespace, entityLocal, String(field.fieldId)),
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

export function listColumnId(
  namespace: string,
  entityLocal: string,
  fieldId: string,
): string {
  return `${namespace}:list_column.${entityLocal}_list_${localOf(fieldId)}`;
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
  if (
    surface.layouts ||
    list(authored, 'surfaces').some(
      (s) =>
        s.layouts &&
        (surface.documentEditor as Json | undefined)?.headerFormSurfaceId ===
          s.surfaceId,
    )
  ) {
    return refusal(
      'CUSTOMIZE_LAYOUT_CONFLICT',
      'This surface now uses layout revisions.',
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
  const affected = (declared.views as Json[]).find((view) =>
    ((view.layout as { columns: string[] } | undefined)?.columns ?? []).some(
      (id) => !keptIds.has(id),
    ),
  );
  if (affected)
    return refusal(
      'CUSTOMIZE_LIST_VIEW_INVALID',
      `Keep the columns used by the "${String(affected.label)}" view.`,
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

function saveListView(
  authored: Json,
  patch: Extract<CustomizationPatch, { kind: 'saveListView' }>,
): Outcome | null {
  const surface = list(authored, 'surfaces').find(
    (candidate) =>
      candidate.surfaceId === patch.surface && candidate.surfaceRole === 'list',
  );
  if (!surface)
    return refusal('CUSTOMIZE_TARGET_NOT_FOUND', 'Choose an existing list.');

  const query = list(authored, 'queries').find(
    (candidate) => candidate.queryId === (surface.dataSource as Json).targetId,
  );
  const boundary = tierBoundary(
    String((query?.sourceEntity as Json | undefined)?.targetId ?? ''),
  );
  if (boundary) return boundary;
  if (!surface.list) {
    const arranged = arrangeLayout(authored, {
      kind: 'arrangeLayout',
      surface: patch.surface,
    });
    if (arranged) return arranged;
  }
  const declared = surface.list as Json;
  const views = declared.views as Json[];
  const namespace = namespaceOf(authored);
  const local = localOf(patch.surface);
  const viewId = `${namespace}:list_view.custom_${local}_${slug(patch.label)}`;
  if (
    views.some(
      (view) =>
        view.viewId === viewId ||
        String(view.label).toLowerCase() === patch.label.toLowerCase(),
    ) ||
    (views.length === 0 && patch.label.toLowerCase() === 'all')
  )
    return refusal(
      'CUSTOMIZE_DUPLICATE_LABEL',
      'This list already has a view with that name.',
    );
  if (views.filter((view) => view.layout).length >= 8)
    return refusal(
      'CUSTOMIZE_LIST_VIEW_INVALID',
      'This list already has eight saved views.',
    );

  const columns = new Map(
    (declared.columns as Json[]).map((column) => [
      String(column.columnId),
      column,
    ]),
  );
  if (
    firstDuplicate(patch.columns) ||
    patch.columns.some((id) => !columns.has(id)) ||
    !patch.columns.some((id) => columns.get(id)?.role === 'title')
  )
    return refusal(
      'CUSTOMIZE_FIELD_NOT_ON_LIST',
      'Choose distinct columns from this list and keep its record title.',
    );
  const sort = patch.sort.map(({ column, direction }) => ({
    columnId: column,
    direction,
  }));
  if (
    firstDuplicate(sort.map((entry) => entry.columnId)) ||
    sort.some(
      ({ columnId }) =>
        !patch.columns.includes(columnId) ||
        columns.get(columnId)?.sortable !== true,
    )
  )
    return refusal(
      'CUSTOMIZE_LIST_VIEW_INVALID',
      'Sort by a column shown in this view that supports sorting.',
    );
  const filters = declared.filters as {
    field: string;
    options: { value: string }[];
  }[];
  if (
    firstDuplicate(patch.filters.map((filter) => filter.field)) ||
    patch.filters.some(
      ({ field, value }) =>
        !filters.some(
          (filter) =>
            filter.field === field &&
            filter.options.some((option) => option.value === value),
        ),
    )
  )
    return refusal(
      'CUSTOMIZE_LIST_VIEW_INVALID',
      'Choose one declared filter value for each field you want to filter.',
    );

  if (views.length === 0) {
    views.push({
      viewId: `${namespace}:list_view.${local}_all`,
      label: 'All',
      orderKey: 10,
      filters: [],
    });
    (surface.slots as Json[]).push({
      kind: 'surfaceSlot',
      schemaVersion: version,
      slot: 'savedViews',
      slotId: `${namespace}:slot.${local}_saved_views`,
      orderKey: 15,
      content: {
        kind: 'opaqueSurfaceContentReference',
        schemaVersion: version,
        targetId: `${namespace}:capability.standard_surface_content`,
      },
    });
  }
  views.push({
    viewId,
    label: patch.label,
    orderKey: nextOrder(views),
    filters: patch.filters,
    layout: { columns: patch.columns, sort },
  });
  return null;
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
