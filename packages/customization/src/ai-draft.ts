import {
  calculatedDisplayDraft,
  DISPLAY_OPERATIONS,
} from './calculated-display-draft.js';
import { parseCustomizationPatch, unsupported } from './patch.js';
import {
  fieldComparisonValidationDraft,
  literalValidationDraft,
  VALIDATION_COMPARISONS,
} from './validation-draft.js';
import type { CustomizationPatch, UnsupportedCustomization } from './patch.js';
import type { CustomizationTargets } from './targets.js';

/**
 * AI drafting (CUSTOMIZE slice 4, plan §5.6's conversational channel): a
 * request in plain English becomes ONE typed patch. The model answers only by
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

const toolSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [
        'addRecordType',
        'addField',
        'addChoice',
        'arrangeLayout',
        'saveListView',
        'addValidation',
        'addCalculatedDisplayField',
        'addMetricCard',
        'narrowPermission',
        'unNarrowPermission',
        'unsupported',
      ],
    },
    label: { type: 'string' },
    fields: { type: 'array', items: fieldSchema },
    entity: { type: 'string' },
    field: fieldSchema,
    enumField: { type: 'string' },
    option: { type: 'string' },
    surface: { type: 'string' },
    view: { type: 'string' },
    sumField: { type: 'string' },
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
    roleKey: { type: 'string' },
    target: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['operation'] },
        id: { type: 'string' },
      },
      required: ['kind', 'id'],
    },
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
    missingCapability: { type: 'string' },
  },
  required: ['kind'],
} as const;

const TOOL = Object.freeze({
  description:
    'Record the one change the person asked for, as a typed patch. Include only the keys of the chosen kind. Use kind "unsupported" with missingCapability when the request needs another kind.',
  inputSchema: toolSchema,
  name: DRAFT_CUSTOMIZATION_TOOL,
});

export function draftingSystemPrompt(targets: CustomizationTargets): string {
  return [
    "You turn a business person's request for a change to their ERP into exactly one typed patch.",
    `Answer ONLY by calling the ${DRAFT_CUSTOMIZATION_TOOL} tool, exactly once. Never answer in text.`,
    'The supported kinds, with exactly these keys:',
    '- addRecordType {kind, label, fields:[{label, type, required?, options?}]}: a new kind of record with its own list, page and form. The first field is its name and must be type "text". type is one of text, number (whole number), date, yesNo, choice; a choice field lists options. At most 24 fields.',
    '- addField {kind, entity, field:{label, type, required?, options?}}: a new field on an existing record type. entity is one of the record type ids below.',
    '- addChoice {kind, enumField, option}: a new choice on a choice field. enumField is one of the choice field ids below.',
    "- arrangeLayout {kind, surface, order?, hide?, relabel?}: add, reorder, hide or rename columns of a list. surface is one of the list ids below; order, hide and relabel[].field use that list's available field ids. Include an available hidden field in order to show it. At most 16 visible columns.",
    '- saveListView {kind, surface, label, columns:[column ID], sort:[{column, direction}], filters:[{field, value}]}: add a tab on one of the lists in Saved view targets below. List the columns in the desired order and include the required record title. Sort by at most three selected sortable columns using ascending or descending. Pin at most three of the declared filter values. Use an empty array for no filters or no sort.',
    '- addMetricCard {kind, surface, label, view?, sumField?}: add a card to Today using a list in Metric card targets below. Omit sumField to count rows. Use a declared sum field for a sum. Omit view to use the default list view.',
    '- addCalculatedDisplayField {kind, surface, calculation:{label, operator, leftFieldId, rightFieldId, listSurfaceId?}}: show an exact decimal value on a record page. Choose add, subtract or multiply and fields from the calculated display targets below. Only include a list when both fields are available on it.',
    '- addValidation {kind, entity, validation:{fieldId, check, limit?, operator?, otherFieldId?, relationId?, message}}: guard create and changes to watched fields. Use required, minimum, maximum, maximumLength, notBeforeToday, or compareFields. For a literal bound supply limit as a string. For compareFields supply a typed operator and otherFieldId. Use relationId only for a listed related field. Include the message to show when saving.',
    '- narrowPermission {kind, roleKey, target:{kind:"operation", id}}: remove the named role\'s grant for one action. Use an exact role key and an action id shown below.',
    '- unNarrowPermission {kind, roleKey, target:{kind:"operation", id}}: remove an existing restriction for exactly the role key and action id listed below.',
    'If the request needs anything else (workflows, approvals, automations, stored calculations, role-based field visibility, permission grants, reports, deleting things, changing how stock or money is computed), call the tool with {kind: "unsupported", missingCapability: "<a short name of what is missing>"}.',
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
  const system = draftingSystemPrompt(targets);
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
    const outcome = readToolInput(call.input, targets);
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
    typeof input === 'object' &&
    input !== null &&
    (input as { kind?: unknown }).kind === 'unsupported'
  ) {
    const missing = (input as { missingCapability?: unknown })
      .missingCapability;
    return unsupported(
      typeof missing === 'string' && missing.trim() !== ''
        ? missing.trim().slice(0, 80)
        : 'unnamed',
      'This version can add a record type, add a field, add a choice or arrange a list; this request needs something else.',
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
  return parsed.status === 'parsed'
    ? { patch: parsed.patch, status: 'parsed' }
    : { issues: parsed.issues, status: 'invalid' };
}
