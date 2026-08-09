import {
  FIXTURE_IDS,
  FIXTURE_LANGUAGE_VERSION,
  ordinaryModuleV2,
} from './definitions.js';

/**
 * `ordinaryModuleV2` with one field of every canonical field kind, and two enums
 * that differ ONLY in how many options they carry.
 *
 * It exists because the claim `ux-picker` has to prove is *every recognised kind
 * renders its control*, and no fixture in the tree carried more than five of the
 * ten. A specimen missing four kinds turns that claim into a claim about the
 * kinds someone happened to need earlier.
 *
 * **The two enums are the boundary control.** `grade` has five options and
 * `region` has six; every other property of the two fields is identical, so a
 * renderer that picked `select` or `datalist` on anything except the count would
 * fail one of them. That is the one-property rule applied to a threshold.
 *
 * Authored at `FIXTURE_LANGUAGE_VERSION` like its base. Nothing here is an
 * authored-surface change -- these are ordinary field declarations every
 * language version since v0 admits -- so ADR-0047 §7's "author the fixture at
 * the ADOPTED version" does not bind: there is no widening to hide.
 */
const version = FIXTURE_LANGUAGE_VERSION;
const { contentCapabilityId, entityIds, namespace } = FIXTURE_IDS;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

export const EVERY_KIND_FIELD_IDS = Object.freeze({
  /** `booleanFieldType` */
  active: `${namespace}:field.master_active`,
  /** `integerFieldType` */
  count: `${namespace}:field.master_count`,
  /** `dateFieldType` */
  due: `${namespace}:field.master_due`,
  /** `enumFieldType`, five options -- the last count that renders a `select`. */
  grade: `${namespace}:field.master_grade`,
  /** `moneyFieldType` */
  price: `${namespace}:field.master_price`,
  /** `enumFieldType`, six options -- the first count that renders a `datalist`. */
  region: `${namespace}:field.master_region`,
  /** `quantityFieldType` */
  weight: `${namespace}:field.master_weight`,
});

const GRADE_OPTIONS = ['a', 'b', 'c', 'd', 'e'] as const;
const REGION_OPTIONS = [
  'north',
  'south',
  'east',
  'west',
  'central',
  'offshore',
] as const;

function field(
  fieldId: string,
  label: string,
  orderKey: number,
  fieldType: Record<string, unknown>,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'nullable',
    entity: reference('entityReference', entityIds.parent),
    fieldId,
    fieldType,
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: 'optional',
    reportable: true,
    schemaVersion: version,
    searchable: false,
  };
}

function enumType(
  local: string,
  options: readonly string[],
): Record<string, unknown> {
  return {
    kind: 'enumFieldType',
    options: options.map((option, index) => ({
      kind: 'enumOption',
      label: `${option.slice(0, 1).toUpperCase()}${option.slice(1)}`,
      optionId: `${namespace}:option.${local}_${option}`,
      orderKey: (index + 1) * 10,
      schemaVersion: version,
    })),
    schemaVersion: version,
  };
}

export function everyFieldKindModule(): Record<string, unknown> {
  const definition = ordinaryModuleV2() as {
    fields: Array<Record<string, unknown>>;
    queries: Array<{
      queryId: string;
      selections: Array<Record<string, unknown>>;
    }>;
  } & Record<string, unknown>;
  const added: Array<readonly [string, string, Record<string, unknown>]> = [
    [
      EVERY_KIND_FIELD_IDS.active,
      'Active',
      { kind: 'booleanFieldType', schemaVersion: version },
    ],
    [
      EVERY_KIND_FIELD_IDS.count,
      'Count',
      {
        kind: 'integerFieldType',
        representation: 'canonicalString',
        schemaVersion: version,
      },
    ],
    [
      EVERY_KIND_FIELD_IDS.due,
      'Due',
      {
        calendar: 'iso8601',
        kind: 'dateFieldType',
        schemaVersion: version,
        timezoneSemantics: 'calendarDate',
      },
    ],
    [
      EVERY_KIND_FIELD_IDS.price,
      'Price',
      {
        currencyCode: 'USD',
        kind: 'moneyFieldType',
        minorUnit: 2,
        precision: 12,
        representation: 'canonicalString',
        scale: 2,
        schemaVersion: version,
      },
    ],
    [
      EVERY_KIND_FIELD_IDS.weight,
      'Weight',
      {
        // `unitReference` resolves against the package's declared capabilities
        // (`normalize.ts`), so the module's own content capability is the only
        // unit this fixture can name without inventing a second capability.
        baseUnit: reference('unitReference', contentCapabilityId),
        kind: 'quantityFieldType',
        precision: 10,
        representation: 'canonicalString',
        scale: 3,
        schemaVersion: version,
      },
    ],
    [EVERY_KIND_FIELD_IDS.grade, 'Grade', enumType('grade', GRADE_OPTIONS)],
    [EVERY_KIND_FIELD_IDS.region, 'Region', enumType('region', REGION_OPTIONS)],
  ];
  added.forEach(([fieldId, label, fieldType], index) => {
    definition.fields.push(field(fieldId, label, 80 + index * 10, fieldType));
  });
  for (const query of definition.queries.filter((entry) =>
    new RegExp(`^${namespace}:query\\.master_(get|list|search|resolve)$`).test(
      entry.queryId,
    ),
  )) {
    added.forEach(([fieldId], index) => {
      query.selections.push({
        field: reference('fieldReference', fieldId),
        kind: 'querySelection',
        orderKey: 80 + index * 10,
        schemaVersion: version,
        selectionId: `${query.queryId.replace(':query.', ':selection.')}_${fieldId.slice(fieldId.lastIndexOf('.') + 1)}`,
      });
    });
  }
  return definition;
}
