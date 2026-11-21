import { z } from 'zod';

import { WorkflowDefinitionSchema } from '../../canonical-model/src/schemas.js';
import { drafterKindLines, drafterToolSchema } from './ai-draft-kinds.js';
import {
  ADD_LINK_LATER_CAPABILITY,
  addLinkLaterRefusal,
  applyCustomizationPatches,
  checkCreateTimeLinks,
} from './apply.js';
import { authoringRuleLines } from './authoring-rules.js';
import { defaultBoardChoices, draftBoardRevision } from './board-revision.js';
import { calculatedDisplayDraft } from './calculated-display-draft.js';
import {
  addressFieldMember,
  documentFieldMembers,
  mapPlacementMember,
  uploadCategoryMember,
} from './field-member-draft.js';
import { layoutCommand } from './layout-revision.js';
import { parseCustomizationPatch, unsupported } from './patch.js';
import type { CustomizationPatch, UnsupportedCustomization } from './patch.js';
import { customizationTargets, type CustomizationTargets } from './targets.js';
import {
  fieldComparisonValidationDraft,
  literalValidationDraft,
} from './validation-draft.js';
import { WorkflowDraftSchema, type WorkflowDraft } from './workflow-draft.js';

/**
 * AI drafting (CUSTOMIZE slice 4, plan §5.6's conversational channel): a
 * request in plain English becomes one typed change. The model answers only by
 * calling the single drafting tool; its input is the patch JSON, read through
 * the same Zod schema every channel uses. Text is never taken as a change. A
 * malformed patch, or a well-formed one the caller's check refuses (compile,
 * workflow type-check, lint and replay), gets at most two repair turns with
 * bounded, structured diagnostics (AI-BUILD-1 slice 2). A request outside the
 * supported kinds comes back as a typed `unsupported` naming what is missing,
 * and is never repaired. Nothing here records, compiles or activates anything.
 *
 * The model is any adapter with this shape -- the operations agent's
 * provider adapter, wrapped by the composition, or a scripted fake in tests.
 */
export interface DraftingToolCall {
  readonly id: string;
  readonly input: unknown;
  readonly name: string;
}

export type DraftingConversationEntry =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly providerContent?: unknown;
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly DraftingToolCall[];
    }
  | {
      readonly results: readonly {
        readonly content: string;
        readonly id: string;
        readonly isError: boolean;
      }[];
      readonly role: 'tool';
    };

export interface DraftingModel {
  readonly modelId: string;
  next(request: {
    readonly conversation: readonly DraftingConversationEntry[];
    readonly system: string;
    readonly tools: readonly {
      readonly description: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
      readonly name: string;
    }[];
  }): Promise<{
    readonly providerContent?: unknown;
    readonly text: string;
    readonly toolCalls: readonly DraftingToolCall[];
  }>;
}

export const DRAFT_CUSTOMIZATION_TOOL = 'draft_customization' as const;

export type DraftedRequest =
  | { readonly patch: CustomizationPatch; readonly status: 'parsed' }
  | { readonly draft: WorkflowDraft; readonly status: 'workflowDraft' }
  | UnsupportedCustomization
  | { readonly issues: readonly string[]; readonly status: 'invalid' };

const WORKFLOW_ID_PATTERN = String(
  (
    z.toJSONSchema(WorkflowDefinitionSchema, { io: 'input' }) as unknown as {
      properties: { workflowId: { pattern: string } };
    }
  ).properties.workflowId.pattern,
);

const TOOL = Object.freeze({
  description: [
    'Draft one change as a single patch or as an ordered changeSet. Include only the keys of the chosen kind. Use kind "unsupported" with missingCapability if any part of the request cannot be drafted.',
    'Kinds, with their exact keys (key? is optional):',
    ...drafterKindLines(),
    'Platform rules. A draft that breaks one is refused:',
    ...authoringRuleLines().map((rule) => `- ${rule}`),
    '- A calculated display needs its own draft. If a request combines it with another patch, report missingCapability "calculated displays in a grouped draft".',
    '- Validation needs its own draft. If a request combines validation with another patch, report missingCapability "validation in a grouped draft".',
    '- Action permission patches need their own draft. If a request combines one with any other patch, report missingCapability "action permission changes in a grouped draft".',
    `- For links on an existing record type, report missingCapability "${ADD_LINK_LATER_CAPABILITY}".`,
    '- If any requested part needs an unsupported capability, call the tool with {kind: "unsupported", missingCapability: "<name the exact missing capability>"}. Never omit or approximate part of a request.',
    '- Write labels the way the person would read them, with an initial capital.',
  ].join('\n'),
  inputSchema: drafterToolSchema(),
  name: DRAFT_CUSTOMIZATION_TOOL,
});

/** The drafting tool as the model is offered it (for tests and the eval). */
export const DRAFTING_TOOL: {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
} = TOOL;

export function draftingSystemPrompt(targets: CustomizationTargets): string {
  return [
    "You turn a business person's request for a change to their ERP into exactly one typed change.",
    `Answer ONLY by calling the ${DRAFT_CUSTOMIZATION_TOOL} tool, exactly once. Never answer in text.`,
    'The kinds and their exact keys are in the tool description. Use only the IDs listed below, or the predictable ID of a record type created earlier in the same change set.',
    '',
    ...(targets.calculatedDisplayTargets?.length
      ? [
          'Calculated display targets:',
          ...targets.calculatedDisplayTargets.map((target) =>
            JSON.stringify(target),
          ),
        ]
      : []),
    ...(targets.permissionRoleKeys?.length && targets.permissionActions?.length
      ? [
          'Role keys for action restrictions:',
          ...targets.permissionRoleKeys.map(
            (key) =>
              `- ${key}${targets.permissionRoleLabels?.[key] ? ` — ${targets.permissionRoleLabels[key]}` : ''}`,
          ),
          'Actions for role restrictions:',
          ...targets.permissionActions.map(
            ({ id, label }) => `- ${id} — ${label}`,
          ),
          ...(targets.permissionRestrictions?.length
            ? [
                'Existing action restrictions:',
                ...targets.permissionRestrictions.map(
                  ({ operationId, roleKey }) =>
                    `- ${operationId} for ${roleKey}`,
                ),
              ]
            : []),
          '',
        ]
      : []),
    ...(targets.metricLists?.length
      ? [
          'Metric card targets:',
          ...targets.metricLists.map(
            (target) =>
              `- ${target.surfaceId} "${target.label}"${target.views
                .map((view) => `; view ${view.viewId} "${view.label}"`)
                .join('')}${target.measures
                .map((field) => `; sum ${field.fieldId} "${field.label}"`)
                .join('')}`,
          ),
          '',
        ]
      : []),
    ...(targets.validationTargets?.length
      ? [
          'Record types and fields that support validation:',
          ...targets.validationTargets.map(
            ({ entityId, label, fields, relatedFields }) =>
              `- ${entityId} — ${label}: ${fields.map(({ fieldId, label: fieldLabel, valueType }) => `${fieldId} "${fieldLabel}" (${valueType.kind})`).join(', ')}${relatedFields?.length ? `. Related fields ${relatedFields.map(({ fieldId, relationId, label: fieldLabel, valueType }) => `${relationId} → ${fieldId} "${fieldLabel}" (${valueType.kind})`).join(', ')}` : ''}`,
          ),
        ]
      : []),
    'Record types you can add a field to:',
    ...targets.recordTypes.map(
      (entity) => `- ${entity.entityId} — ${entity.label}`,
    ),
    'Linkable record types:',
    ...(targets.linkTargets ?? []).map(
      (target) =>
        `- ${target.entityId} — ${target.label}${target.companyOwned ? ' (company owned)' : ''}`,
    ),
    'Choice fields you can add a choice to:',
    ...(targets.choiceFields.length === 0
      ? ['- (none yet)']
      : targets.choiceFields.map(
          (field) =>
            `- ${field.fieldId} — ${field.label} (${field.options.join(', ')})`,
        )),
    'Forms (arrangeLayout upFront lists the added fields to show up front; other optional added fields wait under More details):',
    ...(targets.forms ?? []).map(
      (form) =>
        `- ${form.surfaceId} — ${form.label}: ${form.fields.map((field) => `${field.fieldId} "${field.label}"`).join(', ')}`,
    ),
    'Board collections (list surface, stages, moves by operation ID, facts by field ID):',
    ...(targets.boards ?? []).map(
      (t) =>
        t.frame.listSurfaceId +
        ' ' +
        t.listLabel +
        ' stages: ' +
        t.stages.map((stage) => stage.stateId + ' ' + stage.label).join(', ') +
        '; moves: ' +
        (t.moves
          .map(
            (m) =>
              m.operationId +
              ' ' +
              m.label +
              ' (' +
              m.fromStateId +
              ' -> ' +
              m.toStateId +
              ')',
          )
          .join(', ') || 'none') +
        '; facts: ' +
        (t.facts.map((f) => f.fieldId + ' ' + f.label).join(', ') || 'none') +
        '; default facts: ' +
        (t.defaultFacts.join(', ') || 'none'),
    ),
    'Layouts (surface, mode, then sections with their fields, then blocks):',
    ...(targets.layouts ?? []).map(
      (t) =>
        t.body.surfaceId +
        ' ' +
        t.body.mode +
        ' ' +
        t.body.sections
          .map(
            (s) =>
              s.id +
              ' ' +
              s.label.text +
              ' [' +
              s.fields.map((f) => f.id + ' ' + f.label.text).join(', ') +
              ']',
          )
          .concat(t.body.blocks.map((b) => b.id + ' ' + b.label.text))
          .join('; '),
    ),
    'Lists you can arrange:',
    ...targets.lists.map(
      (list) =>
        `- ${list.surfaceId} — ${list.label}: ${list.columns
          .map(
            (column) =>
              `${column.fieldId} "${column.label}"${column.hidden ? ' (available, hidden)' : ''}`,
          )
          .join(', ')}`,
    ),
    'Saved view targets:',
    ...targets.lists.flatMap((list) =>
      list.savedView
        ? [
            `- ${list.surfaceId} — ${list.label}: ${list.savedView.columns.map((column) => `${column.columnId} "${column.label}"${column.title ? ' (required title)' : ''}${column.sortable ? ' (sortable)' : ''}`).join(', ')}`,
            ...list.savedView.filters.map(
              (filter) =>
                `  Filter ${filter.field} "${filter.label}": ${filter.options.map((option) => `${option.value} "${option.label}"`).join(', ')}`,
            ),
          ]
        : [],
    ),
    ...(targets.documentTargets?.length
      ? [
          'Files targets (record types that can have a files field):',
          ...targets.documentTargets.map(
            (target) => `- ${target.entityId} — ${target.label}`,
          ),
        ]
      : []),
    ...(targets.documentFields?.length
      ? [
          'Files fields (can gain an upload category):',
          ...targets.documentFields.map(
            (field) =>
              `- ${field.fieldId} — ${field.label} on ${field.entityId}`,
          ),
        ]
      : []),
  ].join('\n');
}

/** At most this many repair turns follow the first draft (AI-BUILD-1 slice 2). */
export const MAXIMUM_DRAFT_REPAIRS = 2;
const MAXIMUM_DIAGNOSTICS = 8;
const MAXIMUM_DIAGNOSTIC_LENGTH = 400;

export type DraftCheckResult<T> =
  | { readonly status: 'accepted'; readonly value: T }
  /** Fed back to the model as structured diagnostics; `value` is returned if no turn is left. */
  | {
      readonly status: 'repair';
      readonly diagnostics: readonly string[];
      readonly value: T;
    }
  /** Never repaired: authority, staleness, or a refusal the platform owns. */
  | { readonly status: 'final'; readonly value: T };

export type CheckableDraft = Extract<
  DraftedRequest,
  { status: 'parsed' | 'workflowDraft' }
>;

export interface DraftingOptions<T> {
  /** Repair turns after the first draft; default MAXIMUM_DRAFT_REPAIRS. */
  readonly maximumRepairs?: number;
  /**
   * The caller's verification of a well-formed draft (compile, workflow
   * type-check, lint and replay). A `repair` result is fed back to the model
   * as the tool result of its call.
   */
  readonly check?: (draft: CheckableDraft) => Promise<DraftCheckResult<T>>;
  /**
   * The live release's definition, so a change-set member can choose targets
   * created by the members before it (a board or map on a new record type).
   */
  readonly definition?: Readonly<Record<string, unknown>>;
  /** Rules generated from the workflow compiler, stated with the SDK. */
  readonly workflowRules?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface CheckedDraft<T> {
  readonly status: 'checked';
  readonly value: T;
  /** Repair turns used before this outcome (0 = the first draft). */
  readonly repairs: number;
}

/** Diagnostics as the model reads them: at most 8, each at most 400 characters. */
export function boundedDiagnostics(issues: readonly string[]): string[] {
  const unique = [...new Set(issues.map((issue) => issue.trim()))].filter(
    Boolean,
  );
  const shown = unique
    .slice(0, MAXIMUM_DIAGNOSTICS)
    .map((issue) =>
      issue.length > MAXIMUM_DIAGNOSTIC_LENGTH
        ? `${issue.slice(0, MAXIMUM_DIAGNOSTIC_LENGTH)}…`
        : issue,
    );
  if (unique.length > shown.length)
    shown.push(`(${String(unique.length - shown.length)} more not shown)`);
  return shown;
}

export function workflowPromptSection(
  sdk: string,
  rules: readonly string[] = [],
): string {
  return [
    'For a receipt workflow use saveWorkflow with workflow {schemaVersion:"v6", workflowId, trigger:"goodsReceiptPosted", grants:{operations,queries}}, a TypeScript body and fixtures.',
    `workflowId matches ${WORKFLOW_ID_PATTERN}: lowercase letters, digits and hyphens, starting with a letter (no underscores).`,
    ...rules,
    'Each fixture has an event {type:"goodsReceiptPosted", eventId, receiptId, legalEntityId} (UUIDs) and effects in execution order {call, result}. Use the exact canonical IDs in these SDK declarations and declare only the calls the body makes. Sleep uses milliseconds and yields null. requestApproval yields a boolean. Never call operations or read live records to test a draft.',
    sdk,
  ].join('\n');
}

export async function draftPatchFromRequest<T = never>(
  model: DraftingModel,
  request: string,
  targets: CustomizationTargets,
  options: DraftingOptions<T> = {},
): Promise<DraftedRequest | CheckedDraft<T>> {
  const text = request.trim();
  if (text === '') {
    return { issues: ['the request is empty'], status: 'invalid' };
  }
  const system =
    draftingSystemPrompt(targets) +
    (targets.workflowSdk
      ? `\n${workflowPromptSection(targets.workflowSdk, options.workflowRules)}`
      : '');
  const context: DraftContext = {
    targetsAfter: options.definition
      ? targetsAfter(options.definition)
      : undefined,
  };
  const calls = 1 + (options.maximumRepairs ?? MAXIMUM_DRAFT_REPAIRS);
  const conversation: DraftingConversationEntry[] = [{ role: 'user', text }];
  let last: DraftedRequest | CheckedDraft<T> = {
    issues: ['the model proposed no change'],
    status: 'invalid',
  };
  for (let turn = 0; turn < calls; turn += 1) {
    options.signal?.throwIfAborted();
    const answer = await model.next({ conversation, system, tools: [TOOL] });
    conversation.push({
      ...(answer.providerContent !== undefined
        ? { providerContent: answer.providerContent }
        : {}),
      role: 'assistant',
      text: answer.text,
      toolCalls: answer.toolCalls,
    });
    const call = answer.toolCalls.find(
      (candidate) => candidate.name === DRAFT_CUSTOMIZATION_TOOL,
    );
    if (!call) {
      last = {
        issues: ['the model answered in text instead of proposing a change'],
        status: 'invalid',
      };
      conversation.push({
        role: 'user',
        text: `Call the ${DRAFT_CUSTOMIZATION_TOOL} tool; do not answer in text.`,
      });
      continue;
    }
    const outcome =
      answer.toolCalls.length === 1
        ? readToolInput(call.input, targets, context)
        : {
            status: 'invalid' as const,
            issues: ['propose the complete change in one tool call'],
          };
    // A refusal is the model's (or the platform's) judgement: never repaired.
    if (outcome.status === 'unsupported') return outcome;
    let diagnostics: readonly string[];
    if (outcome.status === 'invalid') {
      last = outcome;
      diagnostics = outcome.issues;
    } else if (!options.check) {
      return outcome;
    } else {
      options.signal?.throwIfAborted();
      const checked = await options.check(outcome);
      const result = {
        status: 'checked' as const,
        value: checked.value,
        repairs: turn,
      };
      if (checked.status !== 'repair') return result;
      last = result;
      diagnostics = checked.diagnostics;
    }
    const shown = boundedDiagnostics(diagnostics);
    conversation.push({
      results: [
        ...answer.toolCalls.map((candidate) => ({
          content:
            candidate.id === call.id
              ? [
                  'The change was not accepted:',
                  ...shown.map((issue) => `- ${issue}`),
                  `Call the ${DRAFT_CUSTOMIZATION_TOOL} tool again with a corrected change that still does everything the person asked.`,
                ].join('\n')
              : 'Ignored: call only the drafting tool.',
          id: candidate.id,
          isError: true,
        })),
      ],
      role: 'tool',
    });
  }
  return last;
}

// ---------------------------------------------------------------- tool input

interface DraftContext {
  /** Targets on the live release plus the change-set members before one. */
  readonly targetsAfter?:
    ((prior: readonly unknown[]) => CustomizationTargets | null) | undefined;
}

function targetsAfter(definition: Readonly<Record<string, unknown>>) {
  return (prior: readonly unknown[]): CustomizationTargets | null => {
    const patches: CustomizationPatch[] = [];
    for (const member of prior) {
      const parsed = parseCustomizationPatch(member);
      if (parsed.status !== 'parsed') return null;
      patches.push(parsed.patch);
    }
    const applied = applyCustomizationPatches(definition, patches);
    return applied.status === 'applied'
      ? customizationTargets(
          applied.authored as unknown as Parameters<
            typeof customizationTargets
          >[0],
        )
      : null;
  };
}

const kindOf = (input: unknown) =>
  input && typeof input === 'object'
    ? (input as { kind?: unknown }).kind
    : undefined;

const sameLabel = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One drafted member as the patch member(s) it stands for. Choice-shaped
 * kinds are converted here; every other kind passes through unchanged and is
 * read by the patch parser.
 */
function convertMember(
  input: unknown,
  base: CustomizationTargets,
  context: DraftContext,
  prior: readonly unknown[],
): unknown[] {
  const req = (input ?? {}) as Record<string, unknown>;
  const local = () =>
    (prior.length ? context.targetsAfter?.(prior) : null) ?? base;
  switch (kindOf(input)) {
    case 'addValidation':
      return [validationMember(req, base)];
    case 'addCalculatedDisplayField':
      return [calculatedDisplayMember(req, base)];
    case 'addLayoutRevision': {
      const target = base.layouts?.find(
        (t) => t.body.surfaceId === req.surface && t.body.mode === req.mode,
      );
      if (!target || !req.layoutEdit || typeof req.layoutEdit !== 'object')
        throw new Error('Choose a declared layout and edit.');
      return [
        layoutCommand(
          target,
          req.layoutEdit as Parameters<typeof layoutCommand>[1],
        ),
      ];
    }
    case 'addBoardViewRevision':
      return [boardMember(req, local())];
    case 'addAddressField': {
      if (typeof req.entity !== 'string' || typeof req.label !== 'string')
        throw new Error('An address field names a record type and a label.');
      return [addressFieldMember(req.entity, req.label, req.required === true)];
    }
    case 'addMapPlacement':
      return [mapMember(req, local(), prior)];
    case 'addDocumentField': {
      if (typeof req.entity !== 'string' || typeof req.label !== 'string')
        throw new Error('A files field names a record type and a label.');
      return documentFieldMembers(req.entity, req.label, {
        required: req.required === true,
        ...(typeof req.maxCount === 'number' ? { maxCount: req.maxCount } : {}),
        ...(Array.isArray(req.categories)
          ? { categories: req.categories.map(String) }
          : {}),
      });
    }
    case 'addUploadCategory': {
      const field =
        base.documentFields?.find(
          (f) => f.fieldId === req.field || sameLabel(f.label, req.field),
        ) ??
        prior
          .filter((m) => kindOf(m) === 'addDocumentField')
          .map((m) => m as { fieldId: string; entityId: string; label: string })
          .find(
            (f) => f.fieldId === req.field || sameLabel(f.label, req.field),
          );
      if (!field || typeof req.label !== 'string')
        throw new Error('Choose a listed files field and name the category.');
      return [
        uploadCategoryMember(
          field.entityId,
          field.fieldId,
          field.label,
          req.label,
          typeof req.maxCount === 'number' ? req.maxCount : 1,
        ),
      ];
    }
    default:
      return [input];
  }
}

function boardMember(
  req: Record<string, unknown>,
  targets: CustomizationTargets,
) {
  const target = targets.boards?.find(
    (t) =>
      !t.retireOnly &&
      ((req.surface !== undefined && t.frame.listSurfaceId === req.surface) ||
        (req.surface === undefined &&
          req.entity !== undefined &&
          t.frame.entityId === req.entity)),
  );
  const ids = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (
    !target ||
    typeof req.label !== 'string' ||
    (req.stageIds !== undefined && !ids(req.stageIds)) ||
    (req.operationIds !== undefined && !ids(req.operationIds)) ||
    (req.factFieldIds !== undefined && !ids(req.factFieldIds))
  )
    throw new Error(
      'Choose a listed board collection (or a record type created earlier in this change set, with its lifecycle declared earlier too) and its lifecycle stages.',
    );
  const stateIds = ids(req.stageIds)
    ? req.stageIds.map((wanted) => {
        const stage = target.stages.find(
          (s) => s.stateId === wanted || sameLabel(s.label, wanted),
        );
        if (!stage)
          throw new Error(
            `There is no stage "${wanted}"; choose from ${target.stages.map((s) => s.label).join(', ')}.`,
          );
        return stage.stateId;
      })
    : target.stages.map((s) => s.stateId);
  // The drafter may leave moves or facts to the builder's default offer; the
  // patch still records the resulting explicit IDs.
  const offered = defaultBoardChoices(target, stateIds);
  return draftBoardRevision(target, req.label, {
    stateIds,
    operationIds: ids(req.operationIds)
      ? req.operationIds
      : offered.operationIds,
    factFieldIds: ids(req.factFieldIds)
      ? req.factFieldIds
      : offered.factFieldIds,
  });
}

function mapMember(
  req: Record<string, unknown>,
  targets: CustomizationTargets,
  prior: readonly unknown[],
) {
  const added = prior
    .filter((m) => kindOf(m) === 'addAddressField')
    .map((m) => m as { fieldId: string; label: string })
    .find((m) => sameLabel(m.label, req.field));
  const fieldId =
    added?.fieldId ?? (typeof req.field === 'string' ? req.field : '');
  const holds = (sections: readonly { fields: readonly { id: string }[] }[]) =>
    sections.some((s) => s.fields.some((f) => f.id === fieldId));
  const layouts = (targets.layouts ?? []).filter(
    (t) =>
      t.body.mode === 'detail' &&
      (req.surface === undefined || t.body.surfaceId === req.surface),
  );
  const layout =
    layouts.find((t) => holds(t.body.sections)) ??
    (req.surface !== undefined ? layouts[0] : undefined);
  if (!fieldId || !layout)
    throw new Error(
      'Choose an Address field and its record page; the field may be an addAddressField earlier in this change set.',
    );
  const section =
    (typeof req.sectionId === 'string'
      ? layout.body.sections.find((s) => s.id === req.sectionId)
      : undefined) ??
    layout.body.sections.find((s) => s.fields.some((f) => f.id === fieldId)) ??
    layout.body.sections[0];
  if (!section) throw new Error('The record page has no section for a map.');
  return mapPlacementMember(fieldId, layout.body.surfaceId, section.id);
}

function validationMember(
  input: Record<string, unknown>,
  targets: CustomizationTargets,
): unknown {
  const selection = input.validation;
  const target = targets.validationTargets?.find(
    ({ entityId }) => entityId === input.entity,
  );
  if (!target || !selection || typeof selection !== 'object')
    throw new Error('Choose a record type and field available for validation.');
  const choice = selection as Record<string, unknown>;
  const fieldId = String(choice.fieldId ?? '');
  const message = String(choice.message ?? '');
  return choice.check === 'compareFields'
    ? fieldComparisonValidationDraft(target, {
        fieldId,
        message,
        operator: String(choice.operator ?? ''),
        otherFieldId: String(choice.otherFieldId ?? ''),
        ...(typeof choice.relationId === 'string'
          ? { relationId: choice.relationId }
          : {}),
      })
    : literalValidationDraft(target, {
        fieldId,
        check: String(choice.check ?? ''),
        limit: String(choice.limit ?? ''),
        message,
      });
}

function calculatedDisplayMember(
  input: Record<string, unknown>,
  targets: CustomizationTargets,
): unknown {
  const target = targets.calculatedDisplayTargets?.find(
    ({ recordSurfaceId }) => input.surface === recordSurfaceId,
  );
  const calculation = input.calculation;
  if (!target || !calculation || typeof calculation !== 'object')
    throw new Error(
      'Choose a record page from the calculated display targets.',
    );
  const choice = calculation as Record<string, unknown>;
  return calculatedDisplayDraft(target, {
    label: String(choice.label ?? ''),
    operator: String(choice.operator ?? ''),
    leftFieldId: String(choice.leftFieldId ?? ''),
    rightFieldId: String(choice.rightFieldId ?? ''),
    listSurfaceId: String(choice.listSurfaceId ?? ''),
  });
}

function readToolInput(
  input: unknown,
  targets: CustomizationTargets,
  context: DraftContext = {},
): DraftedRequest {
  if (
    input &&
    typeof input === 'object' &&
    'kind' in input &&
    input.kind === 'saveWorkflow'
  ) {
    if (!targets.workflowSdk)
      return unsupported(
        'workflow',
        'No callable workflow targets are available.',
      );
    const parsed = WorkflowDraftSchema.safeParse(input);
    return parsed.success
      ? { status: 'workflowDraft', draft: parsed.data }
      : {
          status: 'invalid',
          issues: parsed.error.issues.map(
            ({ path, message }) => `${path.join('.')}: ${message}`,
          ),
        };
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    (input as { kind?: unknown }).kind === 'unsupported'
  ) {
    const missing = (input as { missingCapability?: unknown })
      .missingCapability;
    if (missing === ADD_LINK_LATER_CAPABILITY) return addLinkLaterRefusal();
    return unsupported(
      typeof missing === 'string' && missing.trim() !== ''
        ? missing.trim().slice(0, 80)
        : 'unnamed',
      `Drafting requires ${typeof missing === 'string' && missing.trim() !== '' ? missing.trim().slice(0, 80) : 'an unnamed capability'}, which is not supported yet.`,
    );
  }
  let change: unknown;
  try {
    const patches = (input as { patches?: unknown } | null)?.patches;
    if (kindOf(input) === 'changeSet' && Array.isArray(patches)) {
      const members: unknown[] = [];
      for (const member of patches)
        members.push(...convertMember(member, targets, context, members));
      change = { kind: 'changeSet', patches: members };
    } else {
      const members = convertMember(input, targets, context, []);
      change =
        members.length === 1
          ? members[0]
          : { kind: 'changeSet', patches: members };
    }
  } catch (error) {
    return {
      status: 'invalid',
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
  const parsed = parseCustomizationPatch(change);
  if (parsed.status === 'unsupported') return parsed;
  if (parsed.status === 'invalid')
    return { issues: parsed.issues, status: 'invalid' };
  return (
    checkCreateTimeLinks(parsed.patch) ?? {
      patch: parsed.patch,
      status: 'parsed',
    }
  );
}
