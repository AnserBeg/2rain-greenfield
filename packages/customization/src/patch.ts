import { z } from 'zod';

/**
 * The typed semantic patch a tenant customization is made of (ADR-0013). Every
 * channel -- the command line, the Customize screen and the model -- emits one
 * typed change. A request outside the supported kinds is a typed
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
    companyOwnership: z.enum(['entityOwned', 'tenantShared']).optional(),
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

const declareLifecycle = z.strictObject({
  kind: z.literal('declareLifecycle'),
  entity: canonicalId,
  initial: label,
  states: z.array(z.strictObject({ label })).min(2).max(8),
  transitions: z
    .array(
      z.strictObject({
        label,
        from: label,
        to: label,
      }),
    )
    .min(1)
    .max(12),
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

const SinglePatchSchema = z.discriminatedUnion('kind', [
  addRecordType,
  addField,
  addChoice,
  declareLifecycle,
  arrangeLayout,
]);
type ParsedPatch = z.infer<typeof SinglePatchSchema>;
export type SingleCustomizationPatch =
  ParsedPatch | (Extract<ParsedPatch, { kind: 'addField' }> & { legacy: true });

export const MAX_CUSTOMIZATION_CHANGE_PATCHES = 16;
const changeSet = z.strictObject({
  kind: z.literal('changeSet'),
  patches: z
    .array(SinglePatchSchema)
    .min(2)
    .max(MAX_CUSTOMIZATION_CHANGE_PATCHES),
});
export const CustomizationPatchSchema = z.discriminatedUnion('kind', [
  SinglePatchSchema,
  changeSet,
]);
export type CustomizationPatch =
  SingleCustomizationPatch | z.infer<typeof changeSet>;
export type CustomizationPatchKind = CustomizationPatch['kind'];
export const CUSTOMIZATION_PATCH_KINDS = Object.freeze([
  'addRecordType',
  'addField',
  'addChoice',
  'declareLifecycle',
  'arrangeLayout',
  'changeSet',
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
  const kind = patchKind(input);
  if (
    typeof kind !== 'string' ||
    !(CUSTOMIZATION_PATCH_KINDS as readonly string[]).includes(kind)
  ) {
    return unsupportedKind(kind);
  }
  if (kind === 'changeSet') {
    const patches = (input as { patches?: unknown }).patches;
    if (
      Array.isArray(patches) &&
      patches.length <= MAX_CUSTOMIZATION_CHANGE_PATCHES
    ) {
      for (const patch of patches) {
        const memberKind = patchKind(patch);
        if (
          typeof memberKind === 'string' &&
          !(CUSTOMIZATION_PATCH_KINDS as readonly string[]).includes(memberKind)
        )
          return unsupportedKind(memberKind);
      }
    }
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

function patchKind(input: unknown): unknown {
  return typeof input === 'object' && input !== null && 'kind' in input
    ? input.kind
    : undefined;
}

function unsupportedKind(kind: unknown): UnsupportedCustomization {
  const name =
    typeof kind === 'string' && kind.trim() !== '' ? kind : 'unnamed';
  return unsupported(
    name,
    `This version does not support patch kind "${name}".`,
  );
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
