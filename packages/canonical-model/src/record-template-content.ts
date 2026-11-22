import { z } from 'zod';

export const RecordTemplateContentSchema = z.strictObject({
  version: z.literal(1),
  label: z.string().trim().min(1).max(120),
  columns: z
    .array(
      z.strictObject({
        fieldId: z.string().min(1).max(180),
        caption: z.string().trim().min(1).max(120),
      }),
    )
    .min(1)
    .max(24),
  members: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
        kind: z.enum(['question', 'row', 'section', 'instruction', 'member']),
        caption: z.string().trim().min(1).max(500),
        cells: z.record(
          z.string(),
          z.union([z.string().max(2000), z.boolean()]),
        ),
        source: z
          .strictObject({ parentId: z.uuid(), rowId: z.uuid() })
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type RecordTemplateContent = z.infer<typeof RecordTemplateContentSchema>;
