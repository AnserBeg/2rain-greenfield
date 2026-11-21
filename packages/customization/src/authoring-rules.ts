import type { CustomizationRefusalCode } from './apply.js';

/**
 * The platform's own authoring rules, stated to the AI drafter so a
 * well-formed draft is not refused for a rule it was never told
 * (AI-BUILD-1 slice 2, item 2). Each entry restates the refusals patch
 * application produces under that code (`apply.ts`); the `Record` type makes
 * a new refusal code a compile error until its rule is written here. The
 * compiler rules below restate compiler diagnostics a well-formed draft can
 * still meet.
 */
export const AUTHORING_RULES: Readonly<
  Record<CustomizationRefusalCode, readonly string[]>
> = Object.freeze({
  CUSTOMIZE_DUPLICATE_LABEL: [
    'Within one lifecycle every state label is distinct and every action (transition) label is distinct: when several states move to the same state, give each move its own action label (for example "Mark lost from lead" and "Mark lost from proposal"), never one label on several transitions.',
    'Field labels are distinct within one record type and within one line table; a new field must not reuse an existing field label of that record type.',
    'A record type has at most one link with a given label; a list has at most one saved view with a given name; Today has at most one metric card with a given name; a choice field cannot gain an option it already offers.',
  ],
  CUSTOMIZE_RECORD_TYPE_EXISTS: [
    'A new record type label must differ from every existing record type label.',
  ],
  CUSTOMIZE_TARGET_NOT_FOUND: [
    'Every ID you use is listed below or is the predictable ID of a record type created earlier in the same change set; never invent other IDs.',
    'A link is created in the same change set as the record type it starts from; both record types must exist.',
  ],
  CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET: [
    'Only the record types listed as targets can be customized. Line tables cannot have Address fields.',
  ],
  CUSTOMIZE_TARGET_NOT_CHOICE: ['addChoice targets a choice field only.'],
  CUSTOMIZE_CHOICE_PLATFORM_OWNED: [
    'Only choice fields added by customization can gain choices; the listed choice fields are the ones that can.',
  ],
  CUSTOMIZE_LIST_VIEW_INVALID: [
    'A list has at most eight saved views. A saved view sorts only by sortable columns it shows and pins at most one declared value per filter field. Hiding columns must keep the columns a saved view uses.',
  ],
  CUSTOMIZE_FIELD_NOT_ON_LIST: [
    'A list keeps at least one visible column and its record title; arrange only the columns listed for that list.',
  ],
  CUSTOMIZE_BOARD_CONFLICT: [
    "A board groups a list by its record type's lifecycle: choose stages from that lifecycle, moves between the chosen stages and at most three facts.",
  ],
  CUSTOMIZE_LAYOUT_CONFLICT: [
    'A layout edit uses the listed section and field IDs of that layout.',
  ],
});

/**
 * Patch application's typed `unsupported` outcomes that a well-formed draft
 * can meet, and the compiler diagnostics (`packages/compiler`). The ones in
 * DRAFT_SHAPE_CAPABILITIES are mistakes in the draft's shape and are repaired;
 * the rest are platform limits and come back to the person as they are.
 */
export const COMPILER_AUTHORING_RULES: readonly string[] = Object.freeze([
  "A record type's first field is its name and is a text field.",
  'A lifecycle declares 2 to 8 states and 1 to 12 transitions. Its initial state is one of its states; every action goes from a declared state to a different declared state.',
  'Lifecycles and line tables go only on tenant record types (ones created by customization). A record type has at most one line table and one lifecycle, and a declared lifecycle cannot be edited later.',
  'A line table includes a text field that names a row.',
  'A link to the same record type must be optional. A record page shows at most four links.',
  'An Address field goes on a record type with a record page; a map placement names an Address field and an existing section of that record page.',
  'arrangeLayout with upFront names added fields of one listed form; order, hide and relabel arrange list columns only. Today has at most eight metric cards.',
]);

/** `unsupported` capabilities from patch application that are draft mistakes. */
export const DRAFT_SHAPE_CAPABILITIES: readonly string[] = Object.freeze([
  'invalid lifecycle state',
  'line tables without a text field',
  'required links to the same record type',
  'arrangeLayout.upFront',
  'arrangeLayout.recordPage',
]);

export function authoringRuleLines(): readonly string[] {
  return [
    ...new Set([
      ...Object.values(AUTHORING_RULES).flat(),
      ...COMPILER_AUTHORING_RULES,
    ]),
  ];
}
