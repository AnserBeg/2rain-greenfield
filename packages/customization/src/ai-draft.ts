import {
  CUSTOMIZATION_PATCH_KINDS,
  MAX_CUSTOMIZATION_CHANGE_PATCHES,
  parseCustomizationPatch,
  unsupported,
} from './patch.js';
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
      enum: CUSTOMIZATION_PATCH_KINDS.filter((kind) => kind !== 'changeSet'),
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
    order: { type: 'array', items: { type: 'string' } },
    upFront: { type: 'array', items: { type: 'string' } },
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
    patches: {
      type: 'array',
      items: singlePatchSchema,
      minItems: 2,
      maxItems: MAX_CUSTOMIZATION_CHANGE_PATCHES,
    },
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
    '- addLink {kind, entity, label, target, required?}: a create-time link from a tenant record type. Default is optional. Choose a target from the linkable types below or from an earlier patch in the change set.',
    '- declareLifecycle {kind, entity, initial, states:[{label, role?}], transitions:[{from, to, label}]}: declare named states and actions on a tenant record type. Roles are success, attention, blocked, inProgress. Actions change the record’s own status only.',
    'A record type created in this change set can be referenced by a later member as northstar.app:entity.custom_<label in lowercase with punctuation and spaces replaced by underscores>.',
    "- arrangeLayout {kind, surface, order?, hide?, relabel?}: reorder, hide or rename the columns of a list. surface is one of the list ids below; order, hide and relabel[].field use that list's column field ids.",
    'If any requested part needs an unsupported capability, call the tool with {kind: "unsupported", missingCapability: "<name the exact missing capability>"}. Never omit or approximate part of a request. For example, name "goods receipt event subscription" for starting an inspection automatically when goods are received.',
    'Write labels the way the person would read them, with an initial capital. Do not invent ids.',
    '',
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
    'Lists you can arrange:',
    ...targets.lists.map(
      (list) =>
        `- ${list.surfaceId} — ${list.label}: ${list.columns
          .map((column) => `${column.fieldId} "${column.label}"`)
          .join(', ')}`,
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
    const outcome =
      answer.toolCalls.length === 1
        ? readToolInput(call.input)
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
      `Drafting requires ${typeof missing === 'string' && missing.trim() !== '' ? missing.trim().slice(0, 80) : 'an unnamed capability'}, which is not supported yet.`,
    );
  }
  const parsed = parseCustomizationPatch(input);
  if (parsed.status === 'unsupported') return parsed;
  return parsed.status === 'parsed'
    ? { patch: parsed.patch, status: 'parsed' }
    : { issues: parsed.issues, status: 'invalid' };
}
