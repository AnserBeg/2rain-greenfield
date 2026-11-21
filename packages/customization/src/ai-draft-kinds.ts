import { z } from 'zod';

import { DISPLAY_OPERATIONS } from './calculated-display-draft.js';
import {
  CUSTOMIZATION_CHANGE_MEMBER_KINDS,
  CUSTOMIZATION_MEMBER_SCHEMAS,
  CUSTOMIZATION_PATCH_KINDS,
  MAX_CUSTOMIZATION_CHANGE_PATCHES,
  type CustomizationPatchKind,
} from './patch.js';
import { VALIDATION_COMPARISONS } from './validation-draft.js';
import { WorkflowDraftSchema } from './workflow-draft.js';

/**
 * What the AI drafter accepts for each patch kind, and the description of it
 * the model reads, GENERATED from these schemas (MIGRATION-RULE rule 12). A
 * kind whose persisted member the model can emit directly is described by
 * its own patch schema. A kind whose member records digests, revision IDs or
 * derived IDs (boards, layouts, validations, calculated displays, address,
 * map and files members) is drafted as a choice of listed IDs (rule 10) and
 * converted to the member by the drafter (`ai-draft.ts`), never by the model.
 *
 * Every kind in CUSTOMIZATION_PATCH_KINDS is either covered here or carries a
 * dated, named exception in DRAFTER_EXCEPTIONS; the coverage test fails
 * closed on anything else.
 */
export interface DrafterKind {
  /** The tool input this kind is drafted as. */
  readonly input: z.ZodType;
  /** When to use the kind, beyond what its schema states. */
  readonly guidance: string;
  /** Keys of the schema the model never supplies. */
  readonly hidden?: readonly string[];
}

export interface DrafterException {
  /** ISO date the exception was recorded. */
  readonly since: string;
  readonly owner: string;
  readonly reason: string;
}

const id = z.string().min(1).max(180).meta({ description: 'ID' });
const name = z.string().trim().min(1).max(80);
const member = (kind: string): z.ZodType => {
  const schema = CUSTOMIZATION_MEMBER_SCHEMAS[kind];
  if (!schema) throw new Error(`no patch schema for ${kind}`);
  return schema;
};

/** Drafted as choices; the drafter turns each into its patch member. */
export const DRAFTER_SELECTION_SCHEMAS = {
  addValidation: z.strictObject({
    kind: z.literal('addValidation'),
    entity: id,
    validation: z.strictObject({
      fieldId: id,
      check: z.enum([
        'required',
        'minimum',
        'maximum',
        'maximumLength',
        'notBeforeToday',
        'compareFields',
      ]),
      limit: z.string().optional(),
      message: z.string().min(1).max(240),
      operator: z
        .enum(VALIDATION_COMPARISONS.map(([value]) => value) as [string])
        .optional(),
      otherFieldId: id.optional(),
      relationId: id.optional(),
    }),
  }),
  addCalculatedDisplayField: z.strictObject({
    kind: z.literal('addCalculatedDisplayField'),
    surface: id,
    calculation: z.strictObject({
      label: name,
      operator: z.enum(DISPLAY_OPERATIONS.map(([op]) => op) as [string]),
      leftFieldId: id,
      rightFieldId: id,
      listSurfaceId: id.optional(),
    }),
  }),
  addBoardViewRevision: z.strictObject({
    kind: z.literal('addBoardViewRevision'),
    surface: id.optional(),
    entity: id.optional(),
    label: name,
    stageIds: z.array(id).min(1).max(64).optional(),
    operationIds: z.array(id).max(64).optional(),
    factFieldIds: z.array(id).max(3).optional(),
  }),
  addLayoutRevision: z.strictObject({
    kind: z.literal('addLayoutRevision'),
    surface: id,
    mode: z.enum(['create', 'edit', 'detail']),
    layoutEdit: z.strictObject({
      action: z.enum(['create', 'move', 'rename', 'up', 'down']),
      member: id.optional(),
      label: name.optional(),
      destination: id.optional(),
    }),
  }),
  addAddressField: z.strictObject({
    kind: z.literal('addAddressField'),
    entity: id,
    label: name,
    required: z.boolean().optional(),
  }),
  addMapPlacement: z.strictObject({
    kind: z.literal('addMapPlacement'),
    addressField: id,
    surface: id.optional(),
    sectionId: z.string().min(1).max(512).optional(),
  }),
  addDocumentField: z.strictObject({
    kind: z.literal('addDocumentField'),
    entity: id,
    label: name,
    required: z.boolean().optional(),
    maxCount: z.number().int().min(1).max(20).optional(),
    categories: z.array(name).max(20).optional(),
  }),
  addUploadCategory: z.strictObject({
    kind: z.literal('addUploadCategory'),
    filesField: id,
    label: name,
    maxCount: z.number().int().min(1).max(20).optional(),
  }),
} as const;

export const DRAFTER_KINDS = {
  addRecordType: {
    input: member('addRecordType'),
    guidance:
      'A new kind of record with its own list, page and form. The first field is its name and must be type "text". number is a whole number; a choice field lists its options. Use companyOwnership "entityOwned" for company-scoped documents or for links to a company-owned target. A later member of the same change set refers to it as northstar.app:entity.custom_<label in lowercase, punctuation and spaces replaced by underscores>.',
  },
  addField: {
    input: member('addField'),
    hidden: ['screens'],
    guidance:
      'A new field on an existing record type, or on one created earlier in the change set. entity is a record type ID listed below.',
  },
  addChoice: {
    input: member('addChoice'),
    guidance: 'A new option on a listed choice field.',
  },
  addLineTable: {
    input: member('addLineTable'),
    guidance:
      'One child collection on a tenant record type, edited with the header. Include a text field naming a row.',
  },
  addLink: {
    input: member('addLink'),
    guidance:
      'A link from a record type created earlier in this same change set to a listed linkable record type or to another record type of the change set. Optional unless required is true.',
  },
  declareLifecycle: {
    input: member('declareLifecycle'),
    guidance:
      "Named states and actions on a tenant record type; actions change the record's own status only. Roles: success, attention, blocked, inProgress. from, to and initial are state labels.",
  },
  arrangeLayout: {
    input: member('arrangeLayout'),
    guidance:
      "Add, reorder, hide or rename columns of a listed list (order, hide, relabel use that list's field IDs; include an available hidden field in order to show it; at most 16 visible columns), or, on a listed form, list the added fields to show up front (upFront).",
  },
  saveListView: {
    input: member('saveListView'),
    guidance:
      'A tab on a list from Saved view targets: columns in order including the required record title, sort by at most three sortable columns, pin at most three declared filter values. Use empty arrays for no sort or no filters.',
  },
  addMetricCard: {
    input: member('addMetricCard'),
    guidance:
      'A card on Today from Metric card targets. Omit sumField to count rows; omit view for the default list view.',
  },
  addValidation: {
    input: DRAFTER_SELECTION_SCHEMAS.addValidation,
    guidance:
      'Guard create and changes to watched fields of a record type listed under validation. For a literal bound give limit as a string; for compareFields give operator and otherFieldId; use relationId only for a listed related field. message is shown when saving. Needs its own draft.',
  },
  addCalculatedDisplayField: {
    input: DRAFTER_SELECTION_SCHEMAS.addCalculatedDisplayField,
    guidance:
      'Show an exact decimal value on a record page from the calculated display targets. Include listSurfaceId only when both fields are on that list. Needs its own draft.',
  },
  addBoardViewRevision: {
    input: DRAFTER_SELECTION_SCHEMAS.addBoardViewRevision,
    guidance:
      "A board view of a list grouped by lifecycle stage. Name a listed board collection by its list surface ID, or, inside a change set, name a record type created earlier in it (with its lifecycle declared earlier too) by its entity ID. stageIds (state IDs or state labels) default to every stage; operationIds and factFieldIds default to the builder's offer.",
  },
  addLayoutRevision: {
    input: DRAFTER_SELECTION_SCHEMAS.addLayoutRevision,
    guidance:
      'Create a section (label), rename a member, move a field to a destination section, or move a member up or down, on a listed layout, using its listed IDs.',
  },
  addAddressField: {
    input: DRAFTER_SELECTION_SCHEMAS.addAddressField,
    guidance:
      'A postal address field (with a map pin when placed) on a listed record type, or on one created earlier in the change set. Not on line tables.',
  },
  addMapPlacement: {
    input: DRAFTER_SELECTION_SCHEMAS.addMapPlacement,
    guidance:
      "Show an Address field's map on its record page. addressField is a listed Address field ID or the label of an addAddressField earlier in the change set; surface and sectionId default to the record page section holding the field.",
  },
  addDocumentField: {
    input: DRAFTER_SELECTION_SCHEMAS.addDocumentField,
    guidance:
      'A files field (attachments: PDF, JPEG or PNG) on a record type listed under files targets, or on one created earlier in the change set. maxCount defaults to 1; categories name internal upload categories.',
  },
  addUploadCategory: {
    input: DRAFTER_SELECTION_SCHEMAS.addUploadCategory,
    guidance:
      'A new internal upload category on a listed files field (filesField: its ID).',
  },
  narrowPermission: {
    input: member('narrowPermission'),
    guidance:
      "Remove the named role's grant for one listed action. Needs its own draft.",
  },
  unNarrowPermission: {
    input: member('unNarrowPermission'),
    guidance:
      'Remove an existing restriction for exactly a listed role key and action. Needs its own draft.',
  },
  saveWorkflow: {
    input: WorkflowDraftSchema,
    guidance:
      'An automation that runs when goods are received, written as a TypeScript function body with fixtures. Only when receipt workflow declarations are given below.',
  },
  changeSet: {
    input: z.strictObject({
      kind: z.literal('changeSet'),
      patches: z
        .array(
          z.strictObject({ kind: z.enum(CUSTOMIZATION_CHANGE_MEMBER_KINDS) }),
        )
        .min(2)
        .max(MAX_CUSTOMIZATION_CHANGE_PATCHES),
    }),
    guidance: `Two to ${String(MAX_CUSTOMIZATION_CHANGE_PATCHES)} members, each one of ${CUSTOMIZATION_CHANGE_MEMBER_KINDS.join(', ')}, in dependency order, reviewed and approved together. Do not nest change sets.`,
  },
} as const satisfies Partial<Record<CustomizationPatchKind, DrafterKind>>;

/** Kinds the drafter does not emit yet, each dated and named. */
export const DRAFTER_EXCEPTIONS: Readonly<
  Partial<Record<CustomizationPatchKind, DrafterException>>
> = Object.freeze({});

export type DrafterKindName = keyof typeof DRAFTER_KINDS;
export const DRAFTER_KIND_NAMES = Object.freeze(
  Object.keys(DRAFTER_KINDS) as DrafterKindName[],
);

/** Kinds that may appear inside a change set (the member kinds the drafter covers). */
export const DRAFTER_MEMBER_KINDS = Object.freeze(
  DRAFTER_KIND_NAMES.filter((kind) =>
    (CUSTOMIZATION_CHANGE_MEMBER_KINDS as readonly string[]).includes(kind),
  ),
);

// ---------------------------------------------------------------- generation

type Json = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Json;
  delete out.$schema;
  return out;
}

const CANONICAL_ID_PATTERN = '^[a-z][a-z0-9]*(?:\\.';

/** A provider may refuse Unicode property escapes; ID patterns are stated in words. */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (
      key === 'pattern' &&
      typeof value === 'string' &&
      (value.includes('\\p') || value.startsWith(CANONICAL_ID_PATTERN))
    )
      continue;
    out[key] = sanitize(value);
  }
  return out;
}

function typeText(node: Json): string {
  if ('const' in node) return JSON.stringify(node.const);
  if (node.description === 'ID') return 'ID';
  if (node.format === 'uuid') return 'UUID';
  if (Array.isArray(node.enum))
    return node.enum.map((value) => JSON.stringify(value)).join('|');
  if (Array.isArray(node.anyOf))
    return (node.anyOf as Json[]).map(typeText).join(' or ');
  switch (node.type) {
    case 'string': {
      if (
        typeof node.pattern === 'string' &&
        node.pattern.startsWith(CANONICAL_ID_PATTERN)
      )
        return 'ID';
      const pattern =
        typeof node.pattern === 'string' && !node.pattern.includes('\\p')
          ? ` matching ${node.pattern}`
          : '';
      const max =
        typeof node.maxLength === 'number'
          ? ` (at most ${String(node.maxLength)} chars)`
          : '';
      return `text${pattern}${pattern ? '' : max}`;
    }
    case 'integer':
    case 'number': {
      const range =
        typeof node.minimum === 'number' && typeof node.maximum === 'number'
          ? ` ${String(node.minimum)}-${String(node.maximum)}`
          : '';
      return `number${range}`;
    }
    case 'boolean':
      return 'true|false';
    case 'array': {
      const items = node.items ? typeText(node.items as Json) : 'value';
      const min = typeof node.minItems === 'number' ? node.minItems : 0;
      const max = typeof node.maxItems === 'number' ? node.maxItems : null;
      const count =
        max === null
          ? min
            ? ` (at least ${String(min)})`
            : ''
          : ` (${String(min)} to ${String(max)})`;
      return `[${items}]${count}`;
    }
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, Json>;
      const required = new Set((node.required ?? []) as string[]);
      const keys = Object.entries(properties).map(
        ([key, value]) =>
          `${key}${required.has(key) ? '' : '?'}: ${typeText(value)}`,
      );
      return keys.length ? `{${keys.join(', ')}}` : 'object';
    }
    default:
      return 'value';
  }
}

/** One line per kind: its keys and their types, then its guidance. */
export function describeDrafterKind(kind: DrafterKindName): string {
  const spec: DrafterKind = DRAFTER_KINDS[kind];
  const schema = jsonSchema(spec.input);
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required ?? []) as string[]);
  const keys = Object.entries(properties)
    .filter(([key]) => key !== 'kind' && !spec.hidden?.includes(key))
    .map(
      ([key, value]) =>
        `${key}${required.has(key) ? '' : '?'}: ${typeText(value)}`,
    );
  return `- ${kind} {kind, ${keys.join(', ')}}: ${spec.guidance}`;
}

export function drafterKindLines(): readonly string[] {
  return DRAFTER_KIND_NAMES.map(describeDrafterKind);
}

function merge(schemas: readonly Json[]): Record<string, unknown> {
  const byKey = new Map<string, Map<string, unknown>>();
  for (const schema of schemas) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'kind') continue;
      const variants = byKey.get(key) ?? new Map<string, unknown>();
      variants.set(JSON.stringify(value), value);
      byKey.set(key, variants);
    }
  }
  return Object.fromEntries(
    [...byKey].map(([key, variants]) => [
      key,
      variants.size === 1
        ? [...variants.values()][0]
        : { anyOf: [...variants.values()] },
    ]),
  );
}

/**
 * The drafting tool's input schema: one flat object (a provider needs a
 * top-level object) whose properties are the union of every covered kind's
 * keys, generated from the same schemas as the descriptions.
 */
export function drafterToolSchema(): Readonly<Record<string, unknown>> {
  const schemaOf = (kind: DrafterKindName) => {
    const spec: DrafterKind = DRAFTER_KINDS[kind];
    const schema = sanitize(jsonSchema(spec.input)) as Json;
    const properties = { ...((schema.properties ?? {}) as Json) };
    for (const key of spec.hidden ?? []) delete properties[key];
    return { ...schema, properties };
  };
  const members = DRAFTER_MEMBER_KINDS.map(schemaOf);
  const memberSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...DRAFTER_MEMBER_KINDS] },
      ...merge(members),
    },
    required: ['kind'],
  };
  const top = DRAFTER_KIND_NAMES.filter((kind) => kind !== 'changeSet').map(
    schemaOf,
  );
  return Object.freeze({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...DRAFTER_KIND_NAMES, 'unsupported'] },
      ...merge(top),
      patches: {
        type: 'array',
        items: memberSchema,
        minItems: 2,
        maxItems: MAX_CUSTOMIZATION_CHANGE_PATCHES,
      },
      missingCapability: { type: 'string' },
    },
    required: ['kind'],
  });
}

/** Coverage for the fail-closed test: every patch kind is drafted or excepted. */
export function drafterCoverage(): {
  readonly covered: readonly string[];
  readonly excepted: readonly string[];
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
} {
  const covered = DRAFTER_KIND_NAMES as readonly string[];
  const excepted = Object.keys(DRAFTER_EXCEPTIONS);
  const kinds = CUSTOMIZATION_PATCH_KINDS as readonly string[];
  return {
    covered,
    excepted,
    missing: kinds.filter(
      (kind) => !covered.includes(kind) && !excepted.includes(kind),
    ),
    unknown: [...covered, ...excepted].filter((kind) => !kinds.includes(kind)),
  };
}
