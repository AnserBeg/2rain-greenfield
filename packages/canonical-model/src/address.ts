import { createHash } from 'node:crypto';
import { LayoutBodySchema } from './layout.js';
import { z } from 'zod';

// Canonical JSON admits integer numbers. Decimal degrees travel as decimal
// strings through hashes, receipts and PostgreSQL without rounding.
const degree = (limit: number) =>
  z
    .string()
    .regex(/^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,8})?$/u)
    .refine((value) => Math.abs(Number(value)) <= limit);
export const CoordinatesSchema = z.strictObject({
  latitude: degree(90),
  longitude: degree(180),
});
export const AddressInputSchema = z.strictObject({
  schemaVersion: z.literal('northstar.address-value/v1'),
  text: z
    .string()
    .max(512)
    .refine((text) => text.trim().length > 0),
  lines: z.array(z.string().trim().min(1).max(160)).max(4).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  region: z.string().trim().min(1).max(120).optional(),
  postalCode: z.string().trim().min(1).max(24).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/u)
    .optional(),
  place: z
    .strictObject({
      namespace: z.enum(['google.places', 'demo.places']),
      id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
    })
    .optional(),
  pin: CoordinatesSchema.extend({ kind: z.literal('user') }).optional(),
});
// The editor can request enrichment for one reviewed installation. The host
// strips that request before persisting the business value.
export const AddressWriteSchema = AddressInputSchema.extend({
  locateFor: z
    .strictObject({ companyId: z.uuid(), installationId: z.uuid() })
    .optional(),
});
export const SavedAddressSchema = AddressInputSchema.extend({
  revision: z.uuid(),
});
export type AddressInput = z.infer<typeof AddressInputSchema>;
export type SavedAddress = z.infer<typeof SavedAddressSchema>;
export type Coordinates = z.infer<typeof CoordinatesSchema>;

export const ADDRESS_FIELD_READER = 30;
export const ADDRESS_MAP_READER = 31;
export const CONNECTOR_FAMILY =
  'northstar.compiler:projection-family.connector';
export const CONNECTOR_PAYLOAD = 'northstar.connector-payload/v1';
const id = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
export const AddressBindingSchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  fieldId: id,
  entityId: id,
  contractVersion: z.literal('northstar.address/v1'),
  mappingVersion: z.literal('v1'),
});
export const MapPlacementSchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  placementId: id,
  fieldId: id,
  surfaceId: id,
  sectionId: z.string().min(1).max(512),
});
export const AddressProjectionSchema = z
  .strictObject({
    kind: z.literal('connectorPayload'),
    schemaVersion: z.literal(CONNECTOR_PAYLOAD),
    bindings: z
      .array(
        AddressBindingSchema.extend({
          recordQueryId: id,
          editOperationIds: z.array(id).min(1),
          suggestQueryId: id,
          geocodeOperationId: id,
          mapQueryId: id,
        }),
      )
      .max(128),
    retiredFieldIds: z.array(id).min(1).max(128).optional(),
    placements: z.array(MapPlacementSchema).max(128),
    layouts: z.array(LayoutBodySchema).max(128),
  })
  .refine(
    (payload) =>
      payload.bindings.length > 0 || !!payload.retiredFieldIds?.length,
  );
export type AddressProjection = z.infer<typeof AddressProjectionSchema>;

// Component storage IDs are derived from the complete logical ID, independently of labels and layouts.
export const ADDRESS_COMPONENTS = {
  text: 512,
  line1: 160,
  line2: 160,
  line3: 160,
  line4: 160,
  city: 120,
  region: 120,
  postalCode: 24,
  country: 2,
  placeNamespace: 32,
  placeId: 256,
  latitude: 0,
  longitude: 0,
  revision: 36,
  sourceDigest: 64,
  geocodeStatus: 16,
} as const;
export type AddressComponent = keyof typeof ADDRESS_COMPONENTS;
export const addressComponents = Object.keys(
  ADDRESS_COMPONENTS,
) as AddressComponent[];
export function addressColumnId(
  fieldId: string,
  component: AddressComponent,
): string {
  return component === 'text'
    ? fieldId
    : 'northstar.connector:field.scalar_' +
        createHash('sha256').update(fieldId).digest('hex') +
        '.' +
        component.toLowerCase();
}

export function addressJson(value: unknown) {
  return z.json().parse(value);
}
