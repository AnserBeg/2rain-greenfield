import { parseCustomizationPatch, unsupported } from './patch.js';
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
        'addMetricCard',
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
    'If the request needs anything else (workflows, approvals, automations, calculations, permissions, reports, deleting things, changing how stock or money is computed), call the tool with {kind: "unsupported", missingCapability: "<a short name of what is missing>"}.',
    'Write labels the way the person would read them, with an initial capital. Do not invent ids.',
    '',
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
    const outcome = readToolInput(call.input);
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

function readToolInput(input: unknown): DraftedRequest {
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
  const parsed = parseCustomizationPatch(input);
  if (parsed.status === 'unsupported') return parsed;
  return parsed.status === 'parsed'
    ? { patch: parsed.patch, status: 'parsed' }
    : { issues: parsed.issues, status: 'invalid' };
}
