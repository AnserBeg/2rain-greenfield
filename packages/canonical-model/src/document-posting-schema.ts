import { z } from 'zod';

/**
 * The document-posting block's wire schema (DOCUMENT-POSTING slice 1), apart
 * from its checks so the language schemas can import it without the
 * predicate kernel. See document-posting.ts.
 */
export const DOCUMENT_POSTING_BINDING_VERSION = 'documentPosting/v1' as const;

const id = z
  .string()
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
const roleKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/u);
const roleMap = z
  .record(roleKey, id)
  .refine((value) => Object.keys(value).length <= 64);

export const DocumentPostingBinding = z.strictObject({
  bindingVersion: z.literal(DOCUMENT_POSTING_BINDING_VERSION),
  engine: id,
  header: z.strictObject({ entity: id }),
  lines: z.strictObject({ relation: id }),
  state: z.strictObject({ field: id, from: id, to: id }),
  roles: roleMap.refine((value) => Object.keys(value).length >= 1),
  options: roleMap,
});
export type DocumentPostingBinding = z.infer<typeof DocumentPostingBinding>;
