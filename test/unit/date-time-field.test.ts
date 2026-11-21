import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  DATE_TIME_FIELD_READER,
  canonicalZone,
  canonicalize,
  normalizeApplicationPackage,
  resolveTypedEntry,
} from '../../packages/canonical-model/src/index.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/protocol.js';
import * as customization from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

const authoredPath = resolve('apps/web/release/app.authored.json');
const base = JSON.parse(readFileSync(authoredPath, 'utf8')) as Record<
  string,
  unknown
>;
const tip = parseCompiledApplication(
  JSON.parse(
    readFileSync(resolve('apps/web/release/app.compiled.json'), 'utf8'),
  ) as unknown,
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  authoredPath,
  'northstar.app:package.application',
);
const NS = 'northstar.app';
const equipment = `${NS}:entity.custom_equipment`;
const recordType = {
  kind: 'addRecordType',
  label: 'Equipment',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Status', type: 'text' },
  ],
};
const appointment = {
  kind: 'addDateTimeField',
  schemaVersion: 'northstar.date-time-field/v1',
  target: { kind: 'tenantRecordType', recordTypeId: equipment },
  fieldId: `${NS}:field.custom_equipment_service_at`,
  label: 'Service appointment',
  required: false,
  zoneSource: { kind: 'perRecordIana', version: 'v1' },
};
const fieldId = appointment.fieldId;
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);

function calculatedOnItem() {
  const target = customization
    .customizationTargets(normalizeApplicationPackage(base))
    .calculatedDisplayTargets!.find(
      (t) => t.recordSurfaceId === `${NS}:surface.item_detail`,
    )!;
  const draft = customization.calculatedDisplayDraft(target, {
    label: 'Margin CAD',
    operator: 'subtract',
    leftFieldId: `${NS}:field.item_price_cad`,
    rightFieldId: `${NS}:field.item_standard_cost_cad`,
    listSurfaceId: `${NS}:surface.item_list`,
  }) as unknown as { field: Record<string, unknown> };
  return draft;
}
// A forged definition is edited structurally, as a tampered release would be.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForgedDefinition = Record<string, any>;
const note = {
  kind: 'addField',
  entity: equipment,
  field: { label: 'Note', type: 'text' },
};
/** Compiles through the isolated sandbox; a forged edit lands on the applied definition. */
async function compile(
  chain: unknown[],
  mutate?: (def: ForgedDefinition) => void,
): Promise<customization.SandboxResponse> {
  if (!mutate)
    return customization.compileInSandbox({
      acknowledgement,
      base,
      chain: chain.map(patch),
      tip: customization.serializeRelease(tip),
    });
  const applied = customization.applyCustomizationPatches(
    base,
    chain.map(patch),
  );
  assert.ok(applied.status === 'applied', JSON.stringify(applied));
  const authored = structuredClone(applied.authored) as ForgedDefinition;
  mutate(authored);
  return customization.compileInSandbox({
    acknowledgement,
    base: authored,
    chain: [patch(note)],
    tip: customization.serializeRelease(tip),
  });
}
function refusalOf(result: customization.SandboxResponse): string {
  assert.notEqual(result.status, 'compiled');
  return JSON.stringify(result);
}
function lastRelease(result: customization.SandboxResponse) {
  assert.ok(result.status === 'compiled', JSON.stringify(result).slice(0, 800));
  return customization.parseSerializedRelease(result.steps.at(-1)!.release);
}

test('typed entry refuses the Toronto gap, asks for an offset in the repeat and validates a supplied offset', () => {
  const zone = 'America/Toronto';
  const gap = resolveTypedEntry('2026-03-08T02:30', zone);
  assert.equal(gap.status, 'refused');
  assert.ok(gap.status === 'refused' && gap.code === 'DATE_TIME_NONEXISTENT');
  const repeat = resolveTypedEntry('2026-11-01T01:30', zone);
  assert.ok(
    repeat.status === 'refused' && repeat.code === 'DATE_TIME_AMBIGUOUS',
  );
  assert.deepEqual('offsets' in repeat && repeat.offsets, [-14400, -18000]);
  for (const [offset, instant] of [
    [-14400, '2026-11-01T05:30:00.000Z'],
    [-18000, '2026-11-01T06:30:00.000Z'],
  ] as const) {
    const resolved = resolveTypedEntry('2026-11-01T01:30', zone, offset);
    assert.ok(resolved.status === 'resolved');
    assert.equal(resolved.instant, instant);
  }
  const foreign = resolveTypedEntry('2026-11-01T01:30', zone, -21600);
  assert.ok(
    foreign.status === 'refused' && foreign.code === 'DATE_TIME_OFFSET_INVALID',
  );
  const precise = resolveTypedEntry('2026-11-01T09:00:00.1234', zone);
  assert.ok(
    precise.status === 'refused' &&
      precise.code === 'DATE_TIME_PRECISION_EXCEEDED',
  );
  const kept = resolveTypedEntry('2026-11-01T09:00:00.123', zone);
  assert.ok(kept.status === 'resolved');
  assert.equal(kept.civil, '2026-11-01T09:00:00.123');
});

test('zone names normalize links to canonical IANA IDs and refuse unknown and fixed-offset IDs', () => {
  assert.equal(canonicalZone('Canada/Eastern'), 'America/Toronto');
  assert.equal(canonicalZone('Asia/Calcutta'), 'Asia/Kolkata');
  assert.equal(canonicalZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(canonicalZone('UTC'), 'Etc/UTC');
  assert.equal(canonicalZone('Etc/UTC'), 'Etc/UTC');
  assert.equal(canonicalZone('Etc/GMT+5'), null);
  assert.equal(canonicalZone('Nowhere/Special'), null);
});

test('record-zone display prints the captured civil value in every process zone', () => {
  const saved = {
    schemaVersion: 'northstar.date-time-value/v1',
    instant: '2026-11-01T06:30:00.000Z',
    civil: '2026-11-01T01:30:00.000',
    offsetSeconds: -18000,
    zone: 'America/Toronto',
    tzdbVersion: '2025c',
    zoneSource: { kind: 'perRecordIana' },
  };
  const script = `
import { formatRecordZone, formatCivilDate } from './packages/canonical-model/src/date-time-field.ts';
const value = JSON.parse(process.argv[1]);
console.log(JSON.stringify([formatRecordZone(value), formatCivilDate('2026-03-08'), new Date(value.instant).toString()]));`;
  for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/Edmonton']) {
    const [record, civil, process] = JSON.parse(
      execFileSync(
        globalThis.process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          JSON.stringify(saved),
        ],
        { env: { ...globalThis.process.env, TZ: zone }, encoding: 'utf8' },
      ),
    ) as string[];
    assert.equal(
      record,
      'November 1, 2026, 01:30 UTC−05:00 America/Toronto',
      zone,
    );
    assert.equal(civil, 'March 8, 2026', zone);
    if (zone === 'UTC') assert.match(process!, /06:30/u);
  }
});

test('the patch parser admits addDateTimeField alone and in a change set, and refuses an unknown target', () => {
  assert.equal(
    customization.parseCustomizationPatch(appointment).status,
    'parsed',
  );
  assert.equal(
    customization.parseCustomizationPatch({
      kind: 'changeSet',
      patches: [recordType, appointment],
    }).status,
    'parsed',
  );
  assert.equal(
    customization.parseCustomizationPatch({
      ...appointment,
      target: { kind: 'documentHeader', recordTypeId: equipment },
    }).status,
    'invalid',
  );
  assert.equal(
    customization.parseCustomizationPatch({
      ...appointment,
      zoneSource: { kind: 'viewerDevice', version: 'v1' },
    }).status,
    'invalid',
  );
});

test('the declaration binds one logical field on the same three catalogs at the dateTime reader floor', async () => {
  for (const chain of [
    [recordType, appointment],
    [{ kind: 'changeSet', patches: [recordType, appointment] }],
  ]) {
    const bundle = lastRelease(await compile(chain)).compiled.bundle;
    const payloads = new Map(
      bundle.releaseManifest.projections.map((projection) => {
        const manifest = bundle.artifacts.find(
          (a) => a.contentHash === projection.artifactRoot,
        )!;
        const chunk = JSON.parse(
          new TextDecoder().decode(manifest.canonicalBytes),
        ) as { chunks: { contentHash: string }[] };
        const artifact = bundle.artifacts.find(
          (a) => a.contentHash === chunk.chunks[0]?.contentHash,
        );
        return [
          projection.familyId,
          {
            floor: projection.requiredRuntimeCapability?.minimumVersion,
            payload: artifact
              ? (JSON.parse(
                  new TextDecoder().decode(artifact.canonicalBytes),
                ) as Record<string, unknown>)
              : null,
          },
        ];
      }),
    );
    const families = [
      PROJECTION_FAMILY_IDS.operationCatalog,
      PROJECTION_FAMILY_IDS.queryCatalog,
      PROJECTION_FAMILY_IDS.surfaceManifest,
    ];
    const bindings = families.map((family) =>
      canonicalize(payloads.get(family)?.payload?.dateTimeBindings ?? null),
    );
    assert.equal(new Set(bindings).size, 1);
    assert.deepEqual(JSON.parse(bindings[0]!), [
      {
        schemaVersion: 'v6',
        fieldId,
        entityId: equipment,
        logicalType: 'dateTime',
        zoneSource: { kind: 'perRecordIana', version: 'v1' },
      },
    ]);
    assert.equal(
      payloads.get(PROJECTION_FAMILY_IDS.surfaceManifest)?.floor,
      DATE_TIME_FIELD_READER,
    );
  }
});

test('a release without the declaration emits no key, binding or floor', async () => {
  const applied = customization.applyCustomizationPatches(base, [
    patch(recordType),
  ]);
  assert.ok(applied.status === 'applied');
  const normalized = normalizeApplicationPackage(applied.authored);
  assert.equal('dateTimeFields' in normalized, false);
  const release = lastRelease(await compile([recordType]));
  assert.doesNotMatch(
    JSON.stringify(
      release.compiled.bundle.releaseManifest.projections.map(
        (p) => p.requiredRuntimeCapability,
      ),
    ),
    new RegExp(`"minimumVersion":${String(DATE_TIME_FIELD_READER)}`),
  );
});

test('first-party records, lines and forged non-instant scalars are named gaps', async () => {
  const firstParty = customization.applyCustomizationPatches(base, [
    patch({
      ...appointment,
      target: { kind: 'tenantRecordType', recordTypeId: `${NS}:entity.item` },
      fieldId: `${NS}:field.custom_item_service_at`,
    }),
  ]);
  assert.equal(firstParty.status, 'refused');
  assert.match(
    refusalOf(
      await compile([recordType, appointment], (def) => {
        const field = def.fields.find(
          (f: { fieldId: string }) => f.fieldId === fieldId,
        );
        field.fieldType = {
          ...field.fieldType,
          timezoneSemantics: 'offsetDateTime',
        };
      }),
    ),
    /millisecond UTC instant/u,
  );
});

// Each consumer v1 does not admit is refused by logical type, naming the field
// and the consumer, whatever channel put the binding there.
const consumers: [string, (def: ForgedDefinition) => void, RegExp][] = [
  [
    'list filter',
    (def) => {
      const list = def.surfaces.find(
        (s: { surfaceId: string }) =>
          s.surfaceId === `${NS}:surface.custom_equipment_list`,
      ).list;
      list.filters.push({
        filterId: `${NS}:filter.custom_equipment_list_service_at`,
        label: 'Appointment',
        orderKey: 900,
        field: fieldId,
        options: [{ value: '2026-11-01', label: 'Nov 1' }],
      });
    },
    /list filter/u,
  ],
  [
    'metric card sum',
    (def) => {
      const query = def.queries.find(
        (q: { queryId: string }) =>
          q.queryId === `${NS}:query.custom_equipment_list`,
      );
      query.listSumFields = [fieldId];
    },
    /metric card/u,
  ],
  [
    'calculated display operand',
    (def) => {
      const price = `${NS}:field.item_price_cad`;
      const swap = (value: unknown): unknown =>
        value === price
          ? fieldId
          : Array.isArray(value)
            ? value.map(swap)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [k, swap(v)]),
                )
              : value;
      def.calculatedDisplayFields = [swap(calculatedOnItem().field)];
    },
    /calculated operand/u,
  ],
];
for (const [name, mutate, pattern] of consumers) {
  test(`a forged ${name} on a dateTime field refuses by logical type`, async () => {
    const message = refusalOf(await compile([recordType, appointment], mutate));
    assert.match(message, pattern);
    assert.match(message, new RegExp(fieldId.replace('.', '\\.')));
    assert.match(message, /dateTime/u);
  });
}

function rule(predicate: unknown) {
  const schemaVersion = 'v6';
  return {
    kind: 'addValidation',
    rule: {
      kind: 'validationRule',
      schemaVersion,
      ruleId: `${NS}:rule.custom_equipment_appointment`,
      targetId: equipment,
      boundOperationIds: [
        `${NS}:operation.custom_equipment_create`,
        `${NS}:operation.custom_equipment_update`,
      ],
      trigger: { schemaVersion, kind: 'afterDefaultsOrChangedFields' },
      absence: { schemaVersion, kind: 'validationThreeValued' },
      effect: 'refuse',
      existingRecords: 'grandfather',
      message: 'A scheduled job needs an appointment.',
      fieldAnchors: [fieldId],
      predicate,
    },
  };
}

test('presence is admitted on the whole value; comparison and length operands are named gaps', async () => {
  const schemaVersion = 'v6';
  const status = `${NS}:field.custom_equipment_status`;
  const scheduled = 'Scheduled';
  const presence = rule({
    schemaVersion,
    kind: 'any',
    terms: [
      {
        schemaVersion,
        kind: 'not',
        term: {
          schemaVersion,
          kind: 'comparison',
          operator: 'equal',
          left: {
            schemaVersion,
            kind: 'field',
            fieldId: status,
            select: 'value',
          },
          right: {
            schemaVersion,
            kind: 'literal',
            scalar: { kind: 'text', value: scheduled },
          },
        },
      },
      {
        schemaVersion,
        kind: 'required',
        operand: { schemaVersion, kind: 'field', fieldId, select: 'value' },
      },
    ],
  });
  lastRelease(await compile([recordType, appointment, presence]));
  const comparison = rule({
    schemaVersion,
    kind: 'comparison',
    operator: 'greaterThan',
    left: { schemaVersion, kind: 'field', fieldId, select: 'value' },
    right: {
      schemaVersion,
      kind: 'literal',
      scalar: { kind: 'date', value: '2026-11-01' },
    },
  });
  assert.match(
    refusalOf(await compile([recordType, appointment, comparison])),
    /comparison operand/u,
  );
  const length = rule({
    schemaVersion,
    kind: 'comparison',
    operator: 'lessThan',
    left: { schemaVersion, kind: 'field', fieldId, select: 'textLength' },
    right: {
      schemaVersion,
      kind: 'literal',
      scalar: { kind: 'integer', value: '10' },
    },
  });
  assert.match(
    refusalOf(await compile([recordType, appointment, length])),
    /maximum length/u,
  );
});

test('a saved list view filtering on the field refuses when saved, and a sort by it is admitted', async () => {
  const list = `${NS}:surface.custom_equipment_list`;
  const title = `${NS}:list_column.custom_equipment_list_name`;
  const column = `${NS}:list_column.custom_equipment_list_custom_equipment_service_at`;
  const sorted = await compile([
    recordType,
    appointment,
    {
      kind: 'saveListView',
      surface: list,
      label: 'By appointment',
      columns: [title, column],
      sort: [{ column, direction: 'ascending' }],
      filters: [],
    },
  ]);
  lastRelease(sorted);
  const filtered = await compile([
    recordType,
    appointment,
    {
      kind: 'saveListView',
      surface: list,
      label: 'On a day',
      columns: [title, column],
      sort: [],
      filters: [{ field: fieldId, value: '2026-11-01' }],
    },
  ]);
  // No declared filter can exist on the field, so the saved view refuses.
  assert.match(refusalOf(filtered), /CUSTOMIZE_LIST_VIEW_INVALID/u);
});

test('with the member active and after its field retires, adding a field and arranging the list still compile', async () => {
  const later = [
    {
      kind: 'addField',
      entity: equipment,
      field: { label: 'Bay', type: 'text' },
    },
    {
      kind: 'arrangeLayout',
      surface: `${NS}:surface.custom_equipment_list`,
      relabel: [{ field: `${NS}:field.custom_equipment_name`, label: 'Tool' }],
    },
  ];
  lastRelease(await compile([recordType, appointment, ...later]));
  const retired = await compile([recordType, appointment, ...later], (def) => {
    def.fields.find(
      (f: { fieldId: string }) => f.fieldId === fieldId,
    ).lifecycle = 'retired';
  });
  lastRelease(retired);
});

test('serving admission refuses disagreeing bindings, a missing catalog binding and an understated floor', async () => {
  const { dateTimeBindingsProblem } =
    await import('../../packages/postgres-provider/src/date-time-admission.js');
  const binding = {
    schemaVersion: 'v6',
    fieldId,
    entityId: equipment,
    logicalType: 'dateTime',
    zoneSource: { kind: 'perRecordIana', version: 'v1' },
  };
  const payload = { dateTimeBindings: [binding] };
  assert.equal(
    dateTimeBindingsProblem(
      [payload, payload, payload],
      DATE_TIME_FIELD_READER,
    ),
    null,
  );
  assert.equal(dateTimeBindingsProblem([{}, {}, {}], 34), null);
  assert.match(
    dateTimeBindingsProblem([payload, {}, payload], DATE_TIME_FIELD_READER) ??
      '',
    /disagree/u,
  );
  assert.match(
    dateTimeBindingsProblem(
      [
        payload,
        payload,
        {
          dateTimeBindings: [
            {
              ...binding,
              zoneSource: { kind: 'companyBusinessCalendar', version: 'v1' },
            },
          ],
        },
      ],
      DATE_TIME_FIELD_READER,
    ) ?? '',
    /disagree/u,
  );
  assert.match(
    dateTimeBindingsProblem(
      [payload, payload, payload],
      DATE_TIME_FIELD_READER - 1,
    ) ?? '',
    /floor/u,
  );
  assert.match(
    dateTimeBindingsProblem([{}, {}, {}], DATE_TIME_FIELD_READER) ?? '',
    /floor without/u,
  );
});

test('the in-app drafter can emit addDateTimeField with keys generated from the member schema', () => {
  const schema = customization.draftingToolInputSchema() as {
    properties: Record<string, { enum?: string[] }>;
  };
  assert.ok(schema.properties.kind?.enum?.includes('addDateTimeField'));
  for (const key of ['schemaVersion', 'target', 'fieldId', 'zoneSource'])
    assert.ok(key in schema.properties, key);
  assert.deepEqual(
    Object.keys(customization.DATE_TIME_DRAFTER_PROPERTIES).sort(),
    ['fieldId', 'schemaVersion', 'target', 'zoneSource'],
  );
  // addLink's string target and the member's tenantRecordType target coexist.
  const target = JSON.stringify(schema.properties.target);
  assert.match(target, /"type":"string"/u);
  assert.match(target, /tenantRecordType/u);
  assert.match(target, /operation/u);
});

test('the web control preserves typed entry, leaves an untouched capture alone and prints record zone', async () => {
  const web = await import('../../apps/web/src/date-time-field.js');
  const binding = {
    schemaVersion: 'v6' as const,
    fieldId,
    entityId: equipment,
    logicalType: 'dateTime' as const,
    zoneSource: { kind: 'perRecordIana' as const, version: 'v1' as const },
  };
  const saved = {
    schemaVersion: 'northstar.date-time-value/v1',
    instant: '2026-11-01T06:30:15.250Z',
    civil: '2026-11-01T01:30:15.250',
    offsetSeconds: -18000,
    zone: 'America/Toronto',
    tzdbVersion: '2025c',
    zoneSource: { kind: 'perRecordIana' },
  };
  const edit = web.renderDateTimeEntry(binding, 'value:f', saved, '');
  assert.match(edit, /type="datetime-local" step="60"/u);
  assert.match(edit, /value="2026-11-01T01:30"/u);
  assert.match(edit, /<option value="America\/Toronto" selected>/u);
  assert.match(
    edit,
    /Recorded November 1, 2026, 01:30:15\.250 UTC\u221205:00 America\/Toronto/u,
  );
  // Re-sending the shown minute with the recorded zone is untouched, so the
  // sub-minute capture survives; any change submits a whole typed entry.
  const recorded = /name="value:f:recorded" value="([^"]+)"/u.exec(edit)![1]!;
  assert.deepEqual(
    web.dateTimeFromForm('value:f', {
      'value:f': '2026-11-01T01:30',
      'value:f:zone': 'America/Toronto',
      'value:f:recorded': recorded,
    }),
    { kind: 'nothing' },
  );
  assert.deepEqual(
    web.dateTimeFromForm('value:f', {
      'value:f': '2026-11-01T01:30',
      'value:f:zone': 'America/Toronto',
      'value:f:offset': '-14400',
      'value:f:recorded': recorded,
    }),
    {
      kind: 'set',
      value: {
        schemaVersion: 'northstar.date-time-value/v1',
        civil: '2026-11-01T01:30',
        zone: 'America/Toronto',
        offsetSeconds: -14400,
      },
    },
  );
  // A refused repeated hour comes back with the typed entry and both offsets.
  const ambiguous = web.renderDateTimeEntry(
    binding,
    'value:f',
    {
      civil: '2026-11-01T01:30',
      zone: 'America/Toronto',
      offsets: [-14400, -18000],
    },
    '',
  );
  assert.match(ambiguous, /value="2026-11-01T01:30"/u);
  assert.match(ambiguous, /name="value:f:offset" required/u);
  assert.match(
    ambiguous,
    /<option value="-14400">UTC\u221204:00<\/option><option value="-18000">UTC\u221205:00<\/option>/u,
  );
  const company = web.renderDateTimeEntry(
    {
      ...binding,
      zoneSource: { kind: 'companyBusinessCalendar', version: 'v1' },
    },
    'value:f',
    undefined,
    '',
  );
  assert.doesNotMatch(company, /:zone/u);
  assert.equal(
    web.recordZoneText(saved),
    'November 1, 2026, 01:30:15.250 UTC\u221205:00 America/Toronto',
  );
  assert.equal(web.recordZoneText('2026-11-01T06:30:00.000Z'), null);
});
