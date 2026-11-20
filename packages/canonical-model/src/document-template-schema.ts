import { z } from 'zod';

const id = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
const label = z.string().trim().min(1).max(80);
const color = z.string().regex(/^#[a-f0-9]{6}$/u);
const field = z.strictObject({ fieldId: id, label });
const logo = z.strictObject({
  surfaceId: id,
  recordId: z.uuid(),
  companyId: z.uuid().nullable(),
  linkId: z.uuid(),
  versionId: z.uuid(),
});

export const DocumentTemplateRevisionSchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  templateId: id,
  revisionId: id,
  entityId: id,
  label,
  documentKind: z.enum([
    'quote',
    'purchaseOrder',
    'invoice',
    'workOrder',
    'contract',
  ]),
  headerQueryId: id,
  identityFieldId: id,
  currencyFieldId: id.nullable(),
  format: z.strictObject({
    locale: z.enum(['en-CA', 'en-US', 'fr-CA']),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => {
        try {
          return (
            new Intl.DateTimeFormat('en-CA', {
              timeZone: value,
            }).resolvedOptions().timeZone === value
          );
        } catch {
          return false;
        }
      }, 'Use a supported canonical IANA time zone.'),
    currency: z.enum(['CAD', 'USD', 'EUR', 'GBP']),
    dateStyle: z.enum(['short', 'medium', 'long']),
    numberGrouping: z.boolean(),
    pageSize: z.enum(['A4', 'LETTER']),
  }),
  branding: z.strictObject({
    displayName: label,
    ink: color,
    accent: color,
    logo: logo.nullable(),
  }),
  layout: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('heading'), text: label }),
        z.strictObject({
          kind: z.literal('text'),
          text: z.string().trim().min(1).max(500),
        }),
        field.extend({ kind: z.literal('field') }),
        z.strictObject({
          kind: z.literal('table'),
          label,
          queryId: id,
          parentRelationId: id,
          currencyFieldId: id.nullable(),
          columns: z.array(field).min(1).max(6),
        }),
      ]),
    )
    .min(1)
    .max(24),
  pageNumbers: z.boolean(),
});

export const DocumentTemplatePointerSchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  templateId: id,
  activeRevisionId: id.nullable(),
});

export type DocumentTemplateRevision = z.infer<
  typeof DocumentTemplateRevisionSchema
>;
export type DocumentTemplatePointer = z.infer<
  typeof DocumentTemplatePointerSchema
>;
export type DocumentTemplateLogo = z.infer<typeof logo>;

export function documentPalettePasses(
  branding: DocumentTemplateRevision['branding'],
): boolean {
  return [branding.ink, branding.accent].every((hex) => {
    const rgb = hex
      .slice(1)
      .match(/../gu)!
      .map((byte) => parseInt(byte, 16) / 255);
    const linear = (channel: number) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const weight = [0.2126, 0.7152, 0.0722];
    const luminance = rgb.reduce(
      (sum, channel, i) => sum + weight[i]! * linear(channel),
      0,
    );
    const grey = linear(
      rgb.reduce((sum, channel, i) => sum + weight[i]! * channel, 0),
    );
    return [luminance, grey].every((value) => 1.05 / (value + 0.05) >= 4.5);
  });
}
