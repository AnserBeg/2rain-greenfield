import { layoutCommand } from './layout-revision.js';
import { WorkflowDraftSchema, type WorkflowDraft } from './workflow-draft.js';
import {
  ADD_LINK_LATER_CAPABILITY,
  addLinkLaterRefusal,
  checkCreateTimeLinks,
} from './apply.js';
import {
  CUSTOMIZATION_CHANGE_MEMBER_KINDS,
  CUSTOMIZATION_PATCH_KINDS,
  MAX_CUSTOMIZATION_CHANGE_PATCHES,
  parseCustomizationPatch,
  unsupported,
} from './patch.js';
import {
  calculatedDisplayDraft,
  DISPLAY_OPERATIONS,
} from './calculated-display-draft.js';
import {
  fieldComparisonValidationDraft,
  literalValidationDraft,
  VALIDATION_COMPARISONS,
} from './validation-draft.js';
import type { CustomizationPatch, UnsupportedCustomization } from './patch.js';
import type { CustomizationTargets } from './targets.js';

/**
 * AI drafting (CUSTOMIZE slice 4, plan §5.6's conversational channel): a
 * request in plain English becomes one typed change. The model answers only by
 * calling the single drafting tool; its input is the patch JSON, read through
 * the same Zod schema every channel uses. Text is never taken as a change, a
 * malformed patch gets one repair turn with the schema's issues, and a request
 * outside the supported kinds comes back as a typed `unsupported` naming what is
 * missing. Nothing here records, compiles or activates anything.
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

const fieldSchema = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    type: {
      type: 'string',
      enum: ['text', 'number', 'date', 'yesNo', 'choice'],
    },
    required: { type: 'boolean' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['label', 'type'],
} as const;

const singlePatchSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: CUSTOMIZATION_CHANGE_MEMBER_KINDS,
    },
    label: { type: 'string' },
    fields: { type: 'array', items: fieldSchema },
    entity: { type: 'string' },
    target: { type: 'string' },
    required: { type: 'boolean' },
    companyOwnership: { enum: ['entityOwned', 'tenantShared'] },
    initial: { type: 'string' },
    states: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          role: { enum: ['success', 'attention', 'blocked', 'inProgress'] },
        },
        required: ['label'],
      },
    },
    transitions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['from', 'to', 'label'],
      },
    },
    field: fieldSchema,
    enumField: { type: 'string' },
    option: { type: 'string' },
    surface: { type: 'string' },
    view: { type: 'string' },
    sumField: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    upFront: { type: 'array', items: { type: 'string' } },
    columns: { type: 'array', items: { type: 'string' } },
    sort: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          direction: { type: 'string', enum: ['ascending', 'descending'] },
        },
        required: ['column', 'direction'],
      },
    },
    filters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, value: { type: 'string' } },
        required: ['field', 'value'],
      },
    },
    hide: { type: 'array', items: { type: 'string' } },
    relabel: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, label: { type: 'string' } },
        required: ['field', 'label'],
      },
    },
  },
  required: ['kind'],
} as const;

const toolSchema = {
  ...singlePatchSchema,
  properties: {
    ...singlePatchSchema.properties,
    kind: {
      type: 'string',
      enum: [...CUSTOMIZATION_PATCH_KINDS, 'unsupported'],
    },
    calculation: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        operator: {
          type: 'string',
          enum: DISPLAY_OPERATIONS.map(([operator]) => operator),
        },
        leftFieldId: { type: 'string' },
        rightFieldId: { type: 'string' },
        listSurfaceId: { type: 'string' },
      },
      required: ['label', 'operator', 'leftFieldId', 'rightFieldId'],
    },
    validation: {
      type: 'object',
      properties: {
        fieldId: { type: 'string' },
        check: {
          type: 'string',
          enum: [
            'required',
            'minimum',
            'maximum',
            'maximumLength',
            'notBeforeToday',
            'compareFields',
          ],
        },
        limit: { type: 'string' },
        message: { type: 'string' },
        operator: {
          type: 'string',
          enum: VALIDATION_COMPARISONS.map(([value]) => value),
        },
        otherFieldId: { type: 'string' },
        relationId: { type: 'string' },
      },
      required: ['fieldId', 'check', 'message'],
    },
    mode: { type: 'string', enum: ['create', 'edit', 'detail'] },
    layoutEdit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'move', 'rename', 'up', 'down'],
        },
        member: { type: 'string' },
        label: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['action'],
    },
    roleKey: { type: 'string' },
    target: {
      anyOf: [
        singlePatchSchema.properties.target,
        {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['operation'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
      ],
    },
    patches: {
      type: 'array',
      items: singlePatchSchema,
      minItems: 2,
      maxItems: MAX_CUSTOMIZATION_CHANGE_PATCHES,
    },
    workflow: { type: 'object' },
    body: { type: 'string' },
    fixtures: { type: 'array', items: { type: 'object' } },
    missingCapability: { type: 'string' },
  },
} as const;

const TOOL = Object.freeze({
  description:
    'Draft one change as a single patch or as an ordered changeSet. Include only the keys of the chosen kind. Use kind "unsupported" with missingCapability if any part of the request cannot be drafted.',
  inputSchema: toolSchema,
  name: DRAFT_CUSTOMIZATION_TOOL,
});

export function draftingSystemPrompt(targets: CustomizationTargets): string {
  return [
    "You turn a business person's request for a change to their ERP into exactly one typed change.",
    `Answer ONLY by calling the ${DRAFT_CUSTOMIZATION_TOOL} tool, exactly once. Never answer in text.`,
    'The kinds, with exactly these keys:',
    `- changeSet {kind, patches}: two to ${String(MAX_CUSTOMIZATION_CHANGE_PATCHES)} patches in dependency order, reviewed and approved together. Do not nest change sets.`,
    '- addRecordType {kind, label, companyOwnership?, fields:[{label, type, required?, options?}]}: a new kind of record with its own list, page and form. The first field is its name and must be type "text". type is one of text, number (whole number), date, yesNo, choice; a choice field lists options. At most 24 fields. Use entityOwned for company-scoped documents or links to a company-owned target.',
    '- addField {kind, entity, field:{label, type, required?, options?}}: a new field on an existing record type. entity is one of the record type ids below.',
    '- addChoice {kind, enumField, option}: a new choice on a choice field. enumField is one of the choice field ids below.',
    '- addLineTable {kind, entity, label, fields:[{label, type, required?, options?}]}: one child collection on a tenant record type, edited with the header. Include a text field naming a row.',
    '- addLink {kind, entity, label, target, required?}: a link from a tenant record type added by an earlier addRecordType member of this same change set. Default is optional. Choose a target from the linkable types below or from an earlier patch in the change set.',
    '- declareLifecycle {kind, entity, initial, states:[{label, role?}], transitions:[{from, to, label}]}: declare named states and actions on a tenant record type. Roles are success, attention, blocked, inProgress. Actions change the record’s own status only.',
    'A record type created in this change set can be referenced by a later member as northstar.app:entity.custom_<label in lowercase with punctuation and spaces replaced by underscores>.',
    "- arrangeLayout {kind, surface, order?, hide?, relabel?}: add, reorder, hide or rename columns of a list. surface is one of the list ids below; order, hide and relabel[].field use that list's available field ids. Include an available hidden field in order to show it. At most 16 visible columns.",
    '- saveListView {kind, surface, label, columns:[column ID], sort:[{column, direction}], filters:[{field, value}]}: add a tab on one of the lists in Saved view targets below. List the columns in the desired order and include the required record title. Sort by at most three selected sortable columns using ascending or descending. Pin at most three of the declared filter values. Use an empty array for no filters or no sort.',
    '- addMetricCard {kind, surface, label, view?, sumField?}: add a card to Today using a list in Metric card targets below. Omit sumField to count rows. Use a declared sum field for a sum. Omit view to use the default list view.',
    '- addCalculatedDisplayField {kind, surface, calculation:{label, operator, leftFieldId, rightFieldId, listSurfaceId?}}: show an exact decimal value on a record page. Choose add, subtract or multiply and fields from the calculated display targets below. Only include a list when both fields are available on it.',
    '- addValidation {kind, entity, validation:{fieldId, check, limit?, operator?, otherFieldId?, relationId?, message}}: guard create and changes to watched fields. Use required, minimum, maximum, maximumLength, notBeforeToday, or compareFields. For a literal bound supply limit as a string. For compareFields supply a typed operator and otherFieldId. Use relationId only for a listed related field. Include the message to show when saving.',
    '- narrowPermission {kind, roleKey, target:{kind:"operation", id}}: remove the named role\'s grant for one action. Use an exact role key and an action id shown below.',
    '- unNarrowPermission {kind, roleKey, target:{kind:"operation", id}}: remove an existing restriction for exactly the role key and action id listed below.',
    'A calculated display needs its own draft. If a request combines it with another patch, report missingCapability "calculated displays in a grouped draft".',
    'Validation needs its own draft. If a request combines validation with another patch, report missingCapability "validation in a grouped draft".',
    'Action permission patches need their own draft. If a request combines one with any other patch, report missingCapability "action permission changes in a grouped draft".',
    `For links on an existing record type, report missingCapability "${ADD_LINK_LATER_CAPABILITY}".`,
    'If any requested part needs an unsupported capability, call the tool with {kind: "unsupported", missingCapability: "<name the exact missing capability>"}. Never omit or approximate part of a request. For example, name "goods receipt event subscription" for starting an inspection automatically when goods are received.',
    'Write labels the way the person would read them, with an initial capital. Do not invent ids.',
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
    'For a form, arrangeLayout {kind, surface, upFront} lists the added fields to show up front. Other optional added fields wait under More details.',
    ...(targets.forms ?? []).map(
      (form) =>
        `- ${form.surfaceId} — ${form.label}: ${form.fields.map((field) => `${field.fieldId} "${field.label}"`).join(', ')}`,
    ),
    '- addLayoutRevision {kind,surface,mode,layoutEdit:{action,member?,destination?,label?}}. Create a section with label. Rename a member, move a field to a destination section, or move a member up/down. Use listed IDs.',
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
  ].join('\n');
}

export async function draftPatchFromRequest(
  model: DraftingModel,
  request: string,
  targets: CustomizationTargets,
  maximumTurns = 2,
): Promise<DraftedRequest> {
  const text = request.trim();
  if (text === '') {
    return { issues: ['the request is empty'], status: 'invalid' };
  }
  const system =
    draftingSystemPrompt(targets) +
    (targets.workflowSdk
      ? `\nFor a receipt workflow use saveWorkflow with workflow {schemaVersion:"v6", workflowId, trigger:"goodsReceiptPosted", grants:{operations,queries}}, a TypeScript body and fixtures. Each fixture has an event {type:"goodsReceiptPosted", eventId, receiptId, legalEntityId} and effects in execution order {call, result}. Use the exact canonical IDs in these SDK declarations and declare only the calls the body makes. Sleep uses milliseconds and yields null. requestApproval yields a boolean. Never call operations or read live records to test a draft.\n${targets.workflowSdk}`
      : '');
  const conversation: DraftingConversationEntry[] = [{ role: 'user', text }];
  let issues: readonly string[] = ['the model proposed no change'];
  for (let turn = 0; turn < maximumTurns; turn += 1) {
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
      issues = ['the model answered in text instead of proposing a change'];
      conversation.push({
        role: 'user',
        text: `Call the ${DRAFT_CUSTOMIZATION_TOOL} tool; do not answer in text.`,
      });
      continue;
    }
    const outcome =
      answer.toolCalls.length === 1
        ? readToolInput(call.input, targets)
        : {
            status: 'invalid' as const,
            issues: ['propose the complete change in one tool call'],
          };
    if (outcome.status !== 'invalid') return outcome;
    issues = outcome.issues;
    conversation.push({
      results: [
        ...answer.toolCalls.map((candidate) => ({
          content:
            candidate.id === call.id
              ? `The patch is not valid: ${issues.join('; ')}. Call the tool again with a corrected patch.`
              : 'Ignored: call only the drafting tool.',
          id: candidate.id,
          isError: true,
        })),
      ],
      role: 'tool',
    });
  }
  return { issues, status: 'invalid' };
}

function readToolInput(
  input: unknown,
  targets: CustomizationTargets,
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
  if (
    input &&
    typeof input === 'object' &&
    'kind' in input &&
    input.kind === 'addValidation'
  ) {
    const selection = 'validation' in input ? input.validation : null;
    const entity = 'entity' in input ? input.entity : null;
    const target = targets.validationTargets?.find(
      ({ entityId }) => entityId === entity,
    );
    if (!target || !selection || typeof selection !== 'object')
      return {
        status: 'invalid',
        issues: ['Choose a record type and field available for validation.'],
      };
    try {
      const choice = selection as Record<string, unknown>;
      const fieldId = String(choice.fieldId ?? '');
      const message = String(choice.message ?? '');
      input =
        choice.check === 'compareFields'
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
    } catch (error) {
      return {
        status: 'invalid',
        issues: [
          error instanceof Error
            ? error.message
            : 'The validation selection is invalid.',
        ],
      };
    }
  }
  if (
    input &&
    typeof input === 'object' &&
    'kind' in input &&
    input.kind === 'addLayoutRevision'
  ) {
    const req = input as Record<string, unknown>;
    const target = targets.layouts?.find(
      (t) => t.body.surfaceId === req.surface && t.body.mode === req.mode,
    );
    if (!target || !req.layoutEdit || typeof req.layoutEdit !== 'object')
      return {
        status: 'invalid',
        issues: ['Choose a declared layout and edit.'],
      };
    try {
      return {
        status: 'parsed',
        patch: layoutCommand(
          target,
          req.layoutEdit as Parameters<typeof layoutCommand>[1],
        ),
      };
    } catch (error) {
      return { status: 'invalid', issues: [(error as Error).message] };
    }
  }
  if (
    input &&
    typeof input === 'object' &&
    'kind' in input &&
    input.kind === 'addCalculatedDisplayField'
  ) {
    const surface = 'surface' in input ? input.surface : undefined;
    const target = targets.calculatedDisplayTargets?.find(
      ({ recordSurfaceId }) => surface === recordSurfaceId,
    );
    const calculation = 'calculation' in input ? input.calculation : undefined;
    if (!target || !calculation || typeof calculation !== 'object')
      return {
        status: 'invalid',
        issues: ['Choose a record page from the calculated display targets.'],
      };
    try {
      const choice = calculation as Record<string, unknown>;
      input = calculatedDisplayDraft(target, {
        label: String(choice.label ?? ''),
        operator: String(choice.operator ?? ''),
        leftFieldId: String(choice.leftFieldId ?? ''),
        rightFieldId: String(choice.rightFieldId ?? ''),
        listSurfaceId: String(choice.listSurfaceId ?? ''),
      });
    } catch (error) {
      return {
        status: 'invalid',
        issues: [
          error instanceof Error
            ? error.message
            : 'Choose an exact decimal calculation.',
        ],
      };
    }
  }
  const parsed = parseCustomizationPatch(input);
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
