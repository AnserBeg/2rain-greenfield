import type { CustomizationPatchKind } from './patch.js';

/** Admission changes independently of the parser. Each entry has a replay fixture. */
export const UPGRADE_PATCH_KINDS: ReadonlySet<string> = new Set([
  'addAddressField',
  'addMapPlacement',
  'addBoardViewRevision',
  'addReportRevision',
  'addRecordType',
  'addField',
  'addChoice',
  'addLink',
  'addLineTable',
  'declareLifecycle',
  'arrangeLayout',
  'addLayoutRevision',
  'saveListView',
  'addValidation',
  'addCalculatedDisplayField',
  'addMetricCard',
  'addDocumentField',
  'addUploadCategory',
  'narrowPermission',
  'unNarrowPermission',
  'saveWorkflow',
  'changeSet',
] satisfies CustomizationPatchKind[]);

export const UPGRADE_CODES_V1 = Object.freeze({
  RETIRED_TARGET: 'A referenced subject is absent on the destination.',
  MOVED_MEMBER: 'A member or anchor has a different placement.',
  INCOMPATIBLE_TYPE: 'A bound subject has a different contract.',
  INCOMPATIBLE_SCOPE: 'A subject has a different scope.',
  FIELD_COLLISION:
    'A first-party field occupies the proposed tenant field ID or name.',
  MISSING_BODY: 'A bound artifact body is missing.',
  REMOVED_ACTION: 'A workflow action is absent.',
  CHANGED_ACTION_SIGNATURE: 'A bound workflow action has a different contract.',
  REQUIRED_INPUT_CONCEALED: 'A tenant layout conceals a required input.',
  UNSATISFIABLE_RULE:
    'A destination constraint defeats a tenant validation witness.',
  WORKFLOW_FIXTURE_FAILED:
    'A workflow fixture fails verification under the destination SDK.',
  KIND_NOT_ADMITTED: 'A patch kind has no replay admission.',
  CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE:
    'The recorded source lineage cannot be reproduced.',
  WHOLE_PACKAGE_FAILURE:
    'The package cannot be replayed or the refusal is unclassified.',
});
export type UpgradeCode = keyof typeof UPGRADE_CODES_V1;
export interface ReplayConflict {
  code: UpgradeCode;
  subject: string;
  expected: unknown;
  observed: unknown;
}
export interface EditLocation {
  patchIndex: number;
  patchKind: string;
  memberIndex: number;
  editIndex: number;
  patchId?: string;
}
export type UpgradeFinding = ReplayConflict & Partial<EditLocation>;
export type BlockedEdit = EditLocation & { blockedBy: EditLocation };
export interface ReplayDiagnostics {
  findings: UpgradeFinding[];
  blocked: BlockedEdit[];
}
export interface ReplayOrigin {
  patchId: string;
  differentBase: boolean;
  /** The verified authoring parent at a discontinuity in the original chain. */
  parent?: Record<string, unknown>;
}
export function unadmittedMembers(
  change: unknown,
  memberIndex = 0,
): { kind: string; memberIndex: number }[] {
  if (
    !change ||
    typeof change !== 'object' ||
    !('kind' in change) ||
    typeof change.kind !== 'string'
  )
    return [];
  if (!UPGRADE_PATCH_KINDS.has(change.kind))
    return [{ kind: change.kind, memberIndex }];
  if (
    change.kind === 'changeSet' &&
    'patches' in change &&
    Array.isArray(change.patches)
  )
    return change.patches.flatMap((member, index) =>
      unadmittedMembers(member, index),
    );
  return [];
}
