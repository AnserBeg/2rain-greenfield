import { createHash } from 'node:crypto';
import {
  addressColumnId,
  addressComponents,
  canonicalize,
  SavedAddressSchema,
  type AddressComponent,
  type SavedAddress,
} from '@north-star/canonical-model';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
type Entity = StorageTargetPayloadV1['entities'][number];

interface AddressFieldSets {
  logical: Set<string>;
  components: Set<string>;
}
const addressFieldSets = new WeakMap<Entity, AddressFieldSets>();

function fieldsFor(entity: Entity): AddressFieldSets {
  const cached = addressFieldSets.get(entity);
  if (cached) return cached;
  const fields: AddressFieldSets = {
    logical: new Set(),
    components: new Set(),
  };
  const ids = new Set(entity.columns.map((column) => column.canonicalFieldId));
  if (
    entity.columns.some((column) =>
      column.canonicalFieldId.startsWith('northstar.connector:field.scalar_'),
    )
  ) {
    for (const id of ids) {
      if (!ids.has(addressColumnId(id, 'revision'))) continue;
      const components = addressComponents
        .filter((component) => component !== 'text')
        .map((component) => addressColumnId(id, component));
      if (!components.every((componentId) => ids.has(componentId))) continue;
      fields.logical.add(id);
      for (const componentId of components) fields.components.add(componentId);
    }
  }
  addressFieldSets.set(entity, fields);
  return fields;
}

export function hasAddress(entity: Entity, id: string) {
  return fieldsFor(entity).logical.has(id);
}

export function isAddressComponent(entity: Entity, id: string) {
  return fieldsFor(entity).components.has(id);
}

export function addressColumns(entity: Entity, id: string) {
  const fields = new Map(
    entity.columns.map((c) => [c.canonicalFieldId, c.physicalName]),
  );
  return Object.fromEntries(
    addressComponents.map((component) => {
      const name = fields.get(addressColumnId(id, component));
      if (!name) throw new Error('Incomplete storage for Address ' + id);
      return [component, name];
    }),
  ) as Record<AddressComponent, string>;
}

export function addressScalars(
  value: SavedAddress | null,
): Record<AddressComponent, string | null> {
  const source = value && {
    text: value.text,
    lines: value.lines ?? [],
    city: value.city ?? null,
    region: value.region ?? null,
    postalCode: value.postalCode ?? null,
    country: value.country ?? null,
    place: value.place ?? null,
  };
  return {
    text: value?.text ?? null,
    line1: value?.lines?.[0] ?? null,
    line2: value?.lines?.[1] ?? null,
    line3: value?.lines?.[2] ?? null,
    line4: value?.lines?.[3] ?? null,
    city: value?.city ?? null,
    region: value?.region ?? null,
    postalCode: value?.postalCode ?? null,
    country: value?.country ?? null,
    placeNamespace: value?.place?.namespace ?? null,
    placeId: value?.place?.id ?? null,
    latitude: value?.pin?.latitude ?? null,
    longitude: value?.pin?.longitude ?? null,
    revision: value?.revision ?? null,
    sourceDigest:
      source && createHash('sha256').update(canonicalize(source)).digest('hex'),
    geocodeStatus: value ? (value.pin ? 'userPin' : 'unlocated') : null,
  };
}

export function readAddress(
  columns: Record<AddressComponent, string>,
  row: Record<string, unknown>,
): SavedAddress | null {
  const get = (key: AddressComponent) => row[columns[key]];
  if (get('text') == null) return null;
  const lines = [get('line1'), get('line2'), get('line3'), get('line4')].filter(
    (x) => x != null,
  );
  return SavedAddressSchema.parse({
    schemaVersion: 'northstar.address-value/v1',
    text: get('text'),
    revision: get('revision'),
    ...(lines.length && { lines }),
    ...Object.fromEntries(
      ['city', 'region', 'postalCode', 'country'].flatMap((k) =>
        get(k as AddressComponent) == null
          ? []
          : [[k, get(k as AddressComponent)]],
      ),
    ),
    ...(get('placeId') != null && {
      place: { namespace: get('placeNamespace'), id: get('placeId') },
    }),
    ...(get('latitude') != null && {
      pin: {
        kind: 'user',
        latitude: get('latitude'),
        longitude: get('longitude'),
      },
    }),
  });
}
