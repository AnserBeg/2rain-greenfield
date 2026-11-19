import { z } from 'zod';

/**
 * The typed semantic patch a tenant customization is made of (ADR-0013). Every
 * channel -- the command line, the Customize screen and the model -- emits one
 * of these kinds. A request outside them is a typed
 * `unsupported` result naming the missing capability, never partial output.
 *
 * Targets are canonical ids, never labels, so re-applying a recorded patch to
 * the base it was authored against is deterministic interpretation.
 */
export const CUSTOMIZATION_PATCH_VERSION =
  'northstar.customization-patch/v1' as const;

const canonicalId = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
const label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/[\p{L}\p{N}]/u, 'a label needs at least one letter or digit');

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'yesNo',
  'choice',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CustomFieldSchema = z
  .strictObject({
    label,
    type: z.enum(CUSTOM_FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(label).min(1).max(20).optional(),
  })
  .superRefine((field, context) => {
    if (field.type === 'choice' && !field.options) {
      context.addIssue({
        code: 'custom',
        message: 'a choice field lists its options',
        path: ['options'],
      });
    }
    if (field.type !== 'choice' && field.options) {
      context.addIssue({
        code: 'custom',
        message: 'only a choice field has options',
        path: ['options'],
      });
    }
  });
export type CustomField = z.infer<typeof CustomFieldSchema>;

const addRecordType = z
  .strictObject({
    kind: z.literal('addRecordType'),
    label,
    fields: z.array(CustomFieldSchema).min(1).max(24),
  })
  .superRefine((patch, context) => {
    if (patch.fields[0]?.type !== 'text') {
      context.addIssue({
        code: 'custom',
        message: "a record type's first field is its name, a text field",
        path: ['fields', 0, 'type'],
      });
    }
  });

const addField = z.strictObject({
  kind: z.literal('addField'),
  entity: canonicalId,
  field: CustomFieldSchema,
  // Stored with new patches so earlier chains reproduce their original screens.
  screens: z.literal('record').optional(),
});

const addChoice = z.strictObject({
  kind: z.literal('addChoice'),
  enumField: canonicalId,
  option: label,
});

const arrangeLayout = z
  .strictObject({
    kind: z.literal('arrangeLayout'),
    surface: canonicalId,
    upFront: z.array(canonicalId).max(30).optional(),
    order: z.array(canonicalId).max(16).optional(),
    hide: z.array(canonicalId).max(16).optional(),
    relabel: z
      .array(z.strictObject({ field: canonicalId, label }))
      .max(16)
      .optional(),
  })
  .superRefine((patch, context) => {
    if (!patch.order && !patch.hide && !patch.relabel && !patch.upFront) {
      context.addIssue({
        code: 'custom',
        message: 'a layout change orders, hides or relabels at least one field',
      });
    }
  });

const saveListView = z.strictObject({
  kind: z.literal('saveListView'),
  surface: canonicalId,
  label,
  columns: z.array(canonicalId).min(1).max(16),
  sort: z
    .array(
      z.strictObject({
        column: canonicalId,
        direction: z.enum(['ascending', 'descending']),
      }),
    )
    .max(3),
  filters: z
    .array(
      z.strictObject({
        field: canonicalId,
        value: z.string().min(1).max(240),
      }),
    )
    .max(3),
});

export const CustomizationPatchSchema = z.discriminatedUnion('kind', [
  addRecordType,
  addField,
  addChoice,
  arrangeLayout,
  saveListView,
]);
type ParsedPatch = z.infer<typeof CustomizationPatchSchema>;
export type CustomizationPatch =
  ParsedPatch | (Extract<ParsedPatch, { kind: 'addField' }> & { legacy: true });
export type CustomizationPatchKind = CustomizationPatch['kind'];
export const CUSTOMIZATION_PATCH_KINDS = Object.freeze([
  'addRecordType',
  'addField',
  'addChoice',
  'arrangeLayout',
  'saveListView',
] as const satisfies readonly CustomizationPatchKind[]);

export interface UnsupportedCustomization {
  readonly status: 'unsupported';
  /** The capability the request needs and v1 does not have. */
  readonly missingCapability: string;
  readonly message: string;
}

export type ParsedCustomizationPatch =
  | { readonly patch: CustomizationPatch; readonly status: 'parsed' }
  | UnsupportedCustomization
  | { readonly issues: readonly string[]; readonly status: 'invalid' };

/**
 * Reads one patch. A `kind` this version does not know is `unsupported` with
 * that kind named; a known kind with a malformed body is `invalid` with every
 * issue listed. Nothing is ever approximated.
 */
export function parseCustomizationPatch(
  input: unknown,
): ParsedCustomizationPatch {
  const kind =
    typeof input === 'object' && input !== null && 'kind' in input
      ? (input as { kind: unknown }).kind
      : undefined;
  if (
    typeof kind !== 'string' ||
    !(CUSTOMIZATION_PATCH_KINDS as readonly string[]).includes(kind)
  ) {
    return unsupported(
      typeof kind === 'string' && kind.trim() !== '' ? kind : 'unnamed',
      `This version can add a record type, add a field, add a choice, arrange a layout or save a list view. "${typeof kind === 'string' ? kind : 'no kind'}" is not one of them.`,
    );
  }
  const parsed = CustomizationPatchSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({
      issues: Object.freeze(
        parsed.error.issues.map(
          (issue) =>
            `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`,
        ),
      ),
      status: 'invalid' as const,
    });
  }
  return Object.freeze({ patch: parsed.data, status: 'parsed' as const });
}

export function unsupported(
  missingCapability: string,
  message: string,
): UnsupportedCustomization {
  return Object.freeze({
    message,
    missingCapability,
    status: 'unsupported' as const,
  });
}
