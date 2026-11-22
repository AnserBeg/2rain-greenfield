import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  RecordTemplateBindingSchema,
  templateBindingDigest,
  type RecordTemplateOffer,
} from '@north-star/canonical-model';

export const TemplateBindingPatchSchema = RecordTemplateBindingSchema.extend({
  kind: z.literal('addRecordTemplateBindingRevision'),
  schemaVersion: z.literal('v6'),
});
export type TemplateBindingPatch = z.infer<typeof TemplateBindingPatchSchema>;
export const TemplateBindingChoicesSchema = z.strictObject({
  formId: z.string().describe('Declared editor with an owned collection'),
  contextId: z
    .string()
    .nullable()
    .describe(
      'Scoped relation or choice field ID, or null for the entire type',
    ),
  required: z.boolean(),
  fields: z
    .array(z.strictObject({ fieldId: z.string(), copyEligible: z.boolean() }))
    .min(1)
    .max(24),
  lifecycle: RecordTemplateBindingSchema.shape.status,
});
export function draftTemplateBinding(
  offers: readonly RecordTemplateOffer[],
  selection: unknown,
): TemplateBindingPatch {
  const choices = TemplateBindingChoicesSchema.parse(selection);
  const offer = offers.find((o) => o.frame.formId === choices.formId);
  if (!offer)
    throw new Error('Choose a company-owned collection in this release.');
  const selector = offer.contexts.find(
    ({ selector: s }) =>
      (s.kind === 'choice'
        ? s.fieldId
        : s.kind === 'link'
          ? s.relationId
          : null) === choices.contextId,
  )?.selector;
  if (!selector) throw new Error('Choose a declared context selector.');
  if (choices.lifecycle === 'retired' && offer.previous?.status !== 'active')
    throw new Error('Choose an active template binding to retire.');
  const selected = choices.fields.map(({ fieldId, copyEligible }) => {
    const field = offer.columns.find((c) => c.fieldId === fieldId);
    if (!field)
      throw new Error('Choose a declared column for this collection.');
    const { label, ...column } = field;
    void label;
    return { ...column, copyEligible };
  });
  if (new Set(selected.map((c) => c.fieldId)).size !== selected.length)
    throw new Error('Each column may appear once.');
  const body =
    choices.lifecycle === 'retired'
      ? offer.previous!.body
      : {
          ...offer.frame,
          context: selector,
          required: choices.required,
          columns: selected,
        };
  return {
    schemaVersion: 'v6',
    kind: 'addRecordTemplateBindingRevision',
    version: 1,
    revisionId: randomUUID(),
    predecessor: offer.previous?.revisionId ?? null,
    status: choices.lifecycle,
    resultDigest: templateBindingDigest(body),
    body,
  };
}
