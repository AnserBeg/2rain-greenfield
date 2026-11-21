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

export const WorkflowVerificationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('refused'),
    message: z.string(),
    removedAction: z.literal('waitForEvent').optional(),
  }),
  z.strictObject({
    status: z.literal('passed'),
    sites: z.array(
      z.strictObject({
        method: z.enum([
          'now',
          'query',
          'operation',
          'requestApproval',
          'waitForEvent',
          'sleep',
        ]),
        target: z.string().nullable(),
        line: z.int().positive(),
        fields: z.array(z.string()),
        branch: z.boolean(),
        loop: z.boolean(),
      }),
    ),
    coverage: z.array(z.array(z.int().nonnegative()).max(64)).max(16),
    executable: z.string().min(1),
    journals: z
      .array(
        z
          .array(z.strictObject({ request: z.string(), result: z.string() }))
          .max(64),
      )
      .max(16),
  }),
]);
