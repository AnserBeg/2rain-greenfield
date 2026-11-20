import { z } from 'zod';
import { WorkflowDefinitionSchema } from '../../canonical-model/src/schemas.js';

const fixture = z.strictObject({
  event: z.strictObject({
    type: z.literal('goodsReceiptPosted'),
    eventId: z.uuid(),
    receiptId: z.uuid(),
    legalEntityId: z.uuid(),
  }),
  effects: z
    .array(z.strictObject({ call: z.json(), result: z.json() }))
    .max(64),
});

const source = {
  body: z
    .string()
    .min(1)
    .max(1024 * 1024),
  fixtures: z.array(fixture).min(1).max(16),
};

export const WorkflowDraftSchema = z.strictObject({
  kind: z.literal('saveWorkflow'),
  workflow: WorkflowDefinitionSchema.omit({ bodyDigest: true }),
  ...source,
});

export const WorkflowBodyBundleSchema = z.strictObject({
  ...source,
  authoredBy: z.uuid(),
  executable: z
    .string()
    .min(1)
    .max(1024 * 1024),
});

export type WorkflowDraft = z.infer<typeof WorkflowDraftSchema>;
export type WorkflowBodyBundle = z.infer<typeof WorkflowBodyBundleSchema>;
