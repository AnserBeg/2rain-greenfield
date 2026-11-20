import { compileLiteralFormulaRules } from '../../compiler/src/formula-validation-plan.js';
import { retypedCalculatedDisplayField } from '../../canonical-model/src/calculated-display-bindings.js';
import { retypedFormulaRule } from '../../canonical-model/src/formula-validation-bindings.js';
import {
  canonicalize,
  normalizeApplicationPackage,
  type VersionedNormalizedApplicationPackage,
  type LayoutDefinition,
} from '@north-star/canonical-model';
import {
  applyOne,
  customPermissionBindings,
  type AppliedCustomization,
} from './apply.js';
import { currentLayout, type LayoutReplay } from './layout-revision.js';
import type { CustomizationPatch, SingleCustomizationPatch } from './patch.js';
import {
  UPGRADE_PATCH_KINDS,
  type EditLocation,
  type ReplayConflict,
  type ReplayDiagnostics,
  type ReplayOrigin,
} from './upgrade-diagnostics.js';

type Definition = Record<string, unknown>;
type Member = Record<string, unknown>;
const declarationKeys = {
  entities: 'entityId',
  fields: 'fieldId',
  operations: 'operationId',
  relations: 'relationId',
  surfaces: 'surfaceId',
  queries: 'queryId',
  modules: 'moduleId',
  permissions: 'permissionId',
  documentFields: 'fieldId',
  documentCategories: 'categoryId',
  documentTemplatePointers: 'templateId',
  documentTemplateRevisions: 'revisionId',
  calculatedDisplayFields: 'fieldId',
  formulaRules: 'ruleId',
  workflows: 'workflowId',
  mapPlacements: 'placementId',
  stateMachines: 'machineId',
} as const;
function declarations(def: Definition) {
  const ids = new Map<string, Member>();
  for (const [table, key] of Object.entries(declarationKeys)) {
    for (const member of (def[table] as Member[] | undefined) ?? []) {
      ids.set(String(member[key]), member);
      const list = member.list as Member | undefined;
      const fieldType = member.fieldType as Member | undefined;
      for (const [rows, idKey] of [
        [list?.views, 'viewId'],
        [member.states, 'stateId'],
        [list?.columns, 'columnId'],
        [fieldType?.options, 'optionId'],
        [(member.launcher as Member | undefined)?.metrics, 'metricId'],
      ] as const) {
        if (Array.isArray(rows))
          for (const row of rows as Member[])
            if (typeof row[idKey] === 'string') ids.set(row[idKey], row);
      }
    }
  }
  return ids;
}

function referencedIds(value: unknown, out = new Set<string>()) {
  if (typeof value === 'string') {
    if (/^[\w.]+:[\w.-]+$|^tenant-section\//u.test(value)) out.add(value);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      if (!['label', 'message', 'text', 'value', 'bodyDigest'].includes(key))
        referencedIds(child, out);
  }
  return out;
}
function bindings(
  patch: SingleCustomizationPatch,
  before: Map<string, Member>,
  after: Map<string, Member>,
): ReplayConflict[] {
  const conflicts: ReplayConflict[] = [];
  for (const subject of referencedIds(patch)) {
    const old = before.get(subject);
    if (!old) continue;
    const next = after.get(subject);
    if (!next || next.lifecycle === 'retired') {
      conflicts.push({
        code: 'RETIRED_TARGET',
        subject,
        expected: subject,
        observed: next ? 'retired' : null,
      });
      continue;
    }
    for (const prop of [
      'fieldType',
      'entity',
      'legalEntityScope',
      'companyOwnership',
      'classification',
    ] as const) {
      if (canonicalize(old[prop] ?? null) === canonicalize(next[prop] ?? null))
        continue;
      conflicts.push({
        code: prop === 'fieldType' ? 'INCOMPATIBLE_TYPE' : 'INCOMPATIBLE_SCOPE',
        subject,
        expected: old[prop] ?? null,
        observed: next[prop] ?? null,
      });
      break;
    }
  }
  return conflicts;
}
function formulaConflicts(
  patch: SingleCustomizationPatch,
  original: Definition,
  trial: Definition,
  base: Definition,
): ReplayConflict[] {
  if (
    patch.kind !== 'addValidation' &&
    patch.kind !== 'addCalculatedDisplayField'
  )
    return [];
  const before = normalizeApplicationPackage(
    original,
  ) as VersionedNormalizedApplicationPackage;
  const after = normalizeApplicationPackage(
    trial,
  ) as VersionedNormalizedApplicationPackage;
  if (before.languageVersion !== 'v6' || after.languageVersion !== 'v6')
    return [];
  if (patch.kind === 'addCalculatedDisplayField') {
    if (
      retypedCalculatedDisplayField(
        { ...before, calculatedDisplayFields: [patch.field] },
        after,
      )
    )
      return [
        {
          code: 'INCOMPATIBLE_TYPE',
          subject: patch.field.fieldId,
          expected: patch.field.expression,
          observed: 'The destination binds a different operand contract.',
        },
      ];
    return [];
  }
  if (retypedFormulaRule({ ...before, formulaRules: [patch.rule] }, after))
    return [
      {
        code: 'INCOMPATIBLE_TYPE',
        subject: patch.rule.ruleId,
        expected: patch.rule.fieldAnchors,
        observed:
          'The destination binds a different validation operand or action.',
      },
    ];
  const proof = compileLiteralFormulaRules(after);
  if (
    proof.status !== 'refused' ||
    !proof.message.includes('satisfying and violating')
  )
    return [];
  const constraints = (base.formulaRules as typeof after.formulaRules) ?? [];
  const alone = compileLiteralFormulaRules({
    ...after,
    formulaRules: [patch.rule],
  });
  const blockers = constraints
    .filter((rule) => {
      if (rule.targetId !== patch.rule.targetId) return false;
      const pair = compileLiteralFormulaRules({
        ...after,
        formulaRules: [rule, patch.rule],
      });
      return pair.status === 'refused' && alone.status === 'compiled';
    })
    .map((rule) => rule.ruleId);
  return [
    {
      code: 'UNSATISFIABLE_RULE',
      subject: patch.rule.ruleId,
      expected: {
        ruleId: patch.rule.ruleId,
        witness: 'satisfying and independently violating inputs',
      },
      observed: {
        constraints: blockers,
        subject: proof.subjectId,
        reason: proof.message,
      },
    },
  ];
}

function applyRefusal(
  patch: SingleCustomizationPatch,
  target: Definition,
  reason: string,
): ReplayConflict {
  const ids = declarations(target);
  if (patch.kind === 'arrangeLayout' && !ids.has(patch.surface))
    return {
      code: 'RETIRED_TARGET',
      subject: patch.surface,
      expected: patch.surface,
      observed: null,
    };
  if (patch.kind === 'addRecordType') {
    const module = (target.modules as Member[]).find(
      (m) => String(m.label).toLowerCase() === patch.label.toLowerCase(),
    );
    if (module)
      return {
        code: 'WHOLE_PACKAGE_FAILURE',
        subject: String(module.moduleId),
        expected: { kind: patch.kind, label: patch.label },
        observed: { moduleId: module.moduleId, label: module.label },
      };
  }
  if (patch.kind === 'addField' || patch.kind === 'addAddressField') {
    const label = patch.kind === 'addField' ? patch.field.label : patch.label;
    const collision = (target.fields as Member[]).find(
      (f) =>
        (f.entity as Member)?.targetId === patch.entity &&
        String(f.label).toLowerCase() === label.toLowerCase(),
    );
    if (collision)
      return {
        code: 'FIELD_COLLISION',
        subject: String(collision.fieldId),
        expected:
          patch.kind === 'addField'
            ? patch.field
            : { fieldId: patch.fieldId, label },
        observed: { fieldId: collision.fieldId, label: collision.label },
      };
  }
  const subject =
    [...referencedIds(patch)][0] ??
    ('label' in patch ? patch.label : patch.kind);
  return {
    code: 'WHOLE_PACKAGE_FAILURE',
    subject,
    expected: patch.kind,
    observed: reason,
  };
}

export function historicalLayout(
  parent: Definition,
  patch: Extract<CustomizationPatch, { kind: 'addLayoutRevision' }>,
): LayoutReplay | undefined {
  const def = parent as unknown as LayoutDefinition;
  const surface = def.surfaces.find((s) => s.surfaceId === patch.surface);
  const layout = surface && currentLayout(def, surface, patch.mode);
  return layout
    ? { source: layout.body, findings: [], blocked: [] }
    : undefined;
}

export interface ReplayFailure extends ReplayDiagnostics {
  status: 'replayConflict';
}
export function replayCustomizationPatches(
  base: Definition,
  chain: readonly CustomizationPatch[],
  origins: readonly ReplayOrigin[] = [],
  activeRoleKeys?: readonly string[],
): AppliedCustomization | ReplayFailure {
  let authored = structuredClone(base);
  let original: Definition | undefined;
  const report: ReplayFailure = {
    status: 'replayConflict',
    findings: [],
    blocked: [],
  };
  const failedIds = new Map<string, EditLocation>();
  const failedLayouts = new Map<string, EditLocation>();
  const applied: SingleCustomizationPatch[] = [];
  const historical: SingleCustomizationPatch[] = [];
  for (const [patchIndex, change] of chain.entries()) {
    const origin = origins[patchIndex];
    if (origin?.parent) original = structuredClone(origin.parent);
    const members = change.kind === 'changeSet' ? change.patches : [change];
    for (const [memberIndex, patch] of members.entries()) {
      const at: EditLocation = {
        patchIndex,
        memberIndex,
        editIndex: 0,
        patchKind: patch.kind,
        ...(origin && { patchId: origin.patchId }),
      };
      const before = original && declarations(original);
      const layoutKey =
        patch.kind === 'addLayoutRevision'
          ? patch.surface + '/' + patch.mode
          : undefined;
      const layout =
        original && patch.kind === 'addLayoutRevision' && origin?.differentBase
          ? historicalLayout(original, patch)
          : undefined;
      const admission = [change.kind, patch.kind].find(
        (kind) => !UPGRADE_PATCH_KINDS.has(kind),
      );
      original = original && structuredClone(original);
      const invalid = original && applyOne(original, patch, historical);
      historical.push(patch);
      if (invalid) {
        report.findings.push({
          ...at,
          code: 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
          subject: patch.kind,
          expected: origin?.patchId,
          observed: invalid.message,
        });
        return report;
      }
      const created =
        before && original
          ? [...declarations(original).keys()].filter((id) => !before.has(id))
          : [];
      if (layout) layout.externalFailures = failedIds;
      const refs =
        layout && patch.kind === 'addLayoutRevision'
          ? [patch.surface]
          : referencedIds(patch);
      const blockedBy =
        (layoutKey && failedLayouts.get(layoutKey)) ||
        [...refs].map((id) => failedIds.get(id)).find((v) => !!v);
      const conflicts: ReplayConflict[] = [];
      if (blockedBy) report.blocked.push({ ...at, blockedBy });
      else if (admission)
        conflicts.push({
          code: 'KIND_NOT_ADMITTED',
          subject: admission,
          expected: 'admitted',
          observed: null,
        });
      else {
        const target = declarations(authored);
        if (
          patch.kind === 'narrowPermission' &&
          activeRoleKeys &&
          !activeRoleKeys.includes(patch.roleKey) &&
          !chain
            .slice(patchIndex + 1)
            .some(
              (p) =>
                p.kind === 'unNarrowPermission' &&
                p.roleKey === patch.roleKey &&
                p.target.id === patch.target.id,
            )
        )
          conflicts.push({
            code: 'RETIRED_TARGET',
            subject: patch.roleKey,
            expected: { roleKey: patch.roleKey, active: true },
            observed: null,
          });
        if (before && !layout)
          conflicts.push(...bindings(patch, before, target));
        if (patch.kind === 'addMapPlacement' && !conflicts.length) {
          const surface = target.get(patch.surfaceId);
          const layout =
            surface &&
            currentLayout(
              authored as unknown as LayoutDefinition,
              surface,
              'detail',
            );
          if (
            !layout?.body.sections.some(
              (section) => section.id === patch.sectionId,
            )
          )
            conflicts.push({
              code: 'RETIRED_TARGET',
              subject: patch.sectionId,
              expected: { surface: patch.surfaceId, section: patch.sectionId },
              observed: null,
            });
        }
        for (const id of created) {
          if (
            target.has(id) &&
            !(
              patch.kind === 'addRecordType' &&
              id.endsWith(':module.custom_record-types')
            )
          )
            conflicts.push({
              code: id.includes(':field.')
                ? 'FIELD_COLLISION'
                : 'WHOLE_PACKAGE_FAILURE',
              subject: id,
              expected: declarations(original!).get(id),
              observed: target.get(id),
            });
        }
        if (!conflicts.length) {
          const trial = structuredClone(authored);
          const outcome = applyOne(trial, patch, applied, layout);
          if (outcome) {
            if (layout && (layout.findings.length || layout.blocked.length)) {
              conflicts.push(...layout.findings);
              report.blocked.push(
                ...layout.blocked.map((b) => ({
                  ...at,
                  editIndex: b.editIndex,
                  blockedBy:
                    typeof b.blockedBy === 'number'
                      ? { ...at, editIndex: b.blockedBy }
                      : b.blockedBy,
                })),
              );
            } else
              conflicts.push(applyRefusal(patch, authored, outcome.message));
          } else {
            if (original)
              conflicts.push(...formulaConflicts(patch, original, trial, base));
            if (!conflicts.length) {
              authored = trial;
              applied.push(patch);
            }
          }
        }
      }
      if (conflicts.length || blockedBy || layout?.blocked.length) {
        const blockedOrigin = layout?.blocked[0]?.blockedBy;
        const cause =
          blockedBy ||
          (typeof blockedOrigin === 'object' && !layout?.findings.length
            ? blockedOrigin
            : {
                ...at,
                editIndex:
                  layout?.findings[0]?.editIndex ??
                  (typeof blockedOrigin === 'number' ? blockedOrigin : 0),
              });
        for (const id of created) failedIds.set(id, cause);
        if (layoutKey) failedLayouts.set(layoutKey, cause);
        if (patch.kind === 'arrangeLayout')
          for (const id of [...(patch.order ?? []), ...(patch.upFront ?? [])])
            failedIds.set(id, cause);
        if (patch.kind === 'addLayoutRevision') {
          for (const [editIndex, edit] of patch.edits.entries()) {
            if (edit.kind === 'rename') continue;
            const from = layout?.blocked.find(
              (b) => b.editIndex === editIndex,
            )?.blockedBy;
            if (from !== undefined)
              failedIds.set(
                edit.id,
                typeof from === 'number' ? { ...at, editIndex: from } : from,
              );
            else if (
              !layout ||
              blockedBy ||
              layout.findings.some((f) => f.editIndex === editIndex)
            )
              failedIds.set(edit.id, blockedBy || { ...at, editIndex });
          }
        }
        report.findings.push(...conflicts.map((c) => ({ ...at, ...c })));
      }
    }
  }
  if (report.findings.length) {
    report.findings.sort(
      (a, b) =>
        a.patchIndex! - b.patchIndex! ||
        a.memberIndex! - b.memberIndex! ||
        a.editIndex! - b.editIndex! ||
        a.subject.localeCompare(b.subject, 'en'),
    );
    return report;
  }
  authored.package = {
    ...(authored.package as Member),
    provenance: 'tenantAuthored',
  };
  return {
    status: 'applied',
    authored,
    permissionBindings: customPermissionBindings(authored),
  };
}
