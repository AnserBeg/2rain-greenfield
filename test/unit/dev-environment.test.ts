import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { APPLICATION_IDS } from '../../packages/domain/src/app/builder.js';
import {
  composedApplicationSeed,
  type ComposedApplicationSeedRecord,
} from '../../packages/domain/src/app/seed.js';
import {
  DEFAULT_DEV_CONTAINER_NAME,
  DEV_CONTAINER_VARIABLE,
  RESERVED_CONTAINER_PREFIX,
  RETIRED_CONTAINER_VARIABLE,
  resolveDevContainer,
} from '../../apps/api/src/dev-container.js';

/**
 * The seed and the dev server's printed URLs are checked against the COMPILED
 * RELEASE, not against `APPLICATION_IDS`.
 *
 * That distinction is the whole point of this file. `APPLICATION_IDS` is a
 * second, hand-maintained spelling of identifiers the module definitions build
 * privately through their own `ids(namespace)` factories — nothing makes the
 * two agree. Asserting the seed against `APPLICATION_IDS` would compare a
 * table with itself. The compiled application release is the program's stated
 * authority for what the application contains, so it is what this reads.
 */
const compiledPath = resolve('apps/web/release/app.compiled.json');

interface DeclaredIdentifiers {
  readonly fieldIds: ReadonlySet<string>;
  readonly optionIdsByFieldId: ReadonlyMap<string, ReadonlySet<string>>;
  readonly operationIds: ReadonlySet<string>;
  readonly surfaceIds: ReadonlySet<string>;
}

function declaredIdentifiers(): DeclaredIdentifiers {
  const envelope = JSON.parse(readFileSync(compiledPath, 'utf8')) as {
    applications: { normalizedDefinitionBytesBase64: string }[];
  };
  const head = envelope.applications.at(-1);
  assert.ok(head, 'the compiled application release carries no application');
  const definition = JSON.parse(
    Buffer.from(head.normalizedDefinitionBytesBase64, 'base64').toString(
      'utf8',
    ),
  ) as {
    fields: {
      fieldId: string;
      fieldType: { kind: string; options?: { optionId: string }[] };
    }[];
    operations: { operationId: string }[];
    surfaces: { surfaceId: string }[];
  };
  const optionIdsByFieldId = new Map<string, ReadonlySet<string>>();
  for (const field of definition.fields) {
    if (field.fieldType.kind === 'enumFieldType' && field.fieldType.options) {
      optionIdsByFieldId.set(
        field.fieldId,
        new Set(field.fieldType.options.map((option) => option.optionId)),
      );
    }
  }
  return {
    fieldIds: new Set(definition.fields.map((field) => field.fieldId)),
    operationIds: new Set(
      definition.operations.map((operation) => operation.operationId),
    ),
    optionIdsByFieldId,
    surfaceIds: new Set(
      definition.surfaces.map((surface) => surface.surfaceId),
    ),
  };
}

/**
 * The seed as it stood before it was authored beside the modules, recorded
 * here as a literal so the equality below compares against something the seed
 * cannot move. Deriving it from `composedApplicationSeed` would be the
 * "expectation read from its own subject" defect.
 */
const previousInlineSeed: readonly ComposedApplicationSeedRecord[] = (() => {
  const namespace = 'northstar.app';
  const entry = (
    localEntity: string,
    ordinal: number,
    values: Record<string, string>,
  ): ComposedApplicationSeedRecord => {
    const suffix = String(ordinal).padStart(12, '0');
    return {
      idempotencyKey: `72000000-0000-4000-8000-${suffix}`,
      operationId: `${namespace}:operation.${localEntity}_create`,
      recordId: `71000000-0000-4000-8000-${suffix}`,
      values: Object.fromEntries(
        Object.entries(values).map(([local, value]) => [
          `${namespace}:field.${local}`,
          value,
        ]),
      ),
    };
  };
  return [
    entry('party', 1, {
      party_contact_summary: 'Purchasing · ap@alpine.example',
      party_name: 'Alpine Office Supply',
      party_number: 'P-1001',
    }),
    entry('party', 2, {
      party_contact_summary: 'Wholesale · orders@northwind.example',
      party_name: 'Northwind Goods',
      party_number: 'P-1002',
    }),
    entry('party', 3, {
      party_contact_summary: 'Local delivery · hello@prairie.example',
      party_name: 'Prairie Paper Co.',
      party_number: 'P-1003',
    }),
    entry('party', 4, {
      party_contact_summary: 'Preferred supplier · team@summit.example',
      party_name: 'Summit Industrial',
      party_number: 'P-1004',
    }),
    entry('item', 11, {
      item_base_unit: 'EA',
      item_description: 'Recycled ruled notebook, 80 pages',
      item_name: 'Field notebook',
      item_sku: 'OFF-100',
    }),
    entry('item', 12, {
      item_base_unit: 'BOX',
      item_description: 'Black fine-point pens, pack of twelve',
      item_name: 'Fine-point pen set',
      item_sku: 'OFF-120',
    }),
    entry('item', 13, {
      item_base_unit: 'EA',
      item_description: 'Adjustable task lamp, forest green',
      item_name: 'Task lamp',
      item_sku: 'OFF-210',
    }),
    entry('item', 14, {
      item_base_unit: 'PACK',
      item_description: 'Compostable shipping labels, pack of 100',
      item_name: 'Shipping labels',
      item_sku: 'OPS-310',
    }),
    entry('location', 21, {
      location_code: 'CAL-WH',
      location_name: 'Calgary warehouse',
      location_type: `${namespace}:option.warehouse`,
    }),
    entry('location', 22, {
      location_code: 'EDM-ST',
      location_name: 'Edmonton store',
      location_type: `${namespace}:option.store`,
    }),
    entry('location', 23, {
      location_code: 'VAN-WH',
      location_name: 'Vancouver warehouse',
      location_type: `${namespace}:option.warehouse`,
    }),
    entry('location', 24, {
      location_code: 'YYC-ST',
      location_name: 'Beltline store',
      location_type: `${namespace}:option.store`,
    }),
  ];
})();

test('the demo profile serializes identically to the seed it replaced', () => {
  const demo = composedApplicationSeed('demo');
  // Exact serialized equality, not deepEqual. deepEqual ignores property
  // insertion order, so it cannot distinguish a values map whose keys were
  // reordered — and JSON.stringify, which is how these reach the wire, can.
  assert.equal(
    JSON.stringify(demo),
    JSON.stringify(previousInlineSeed),
    'the demo profile is the browser suite’s subject; changing its bytes changes a reviewed test',
  );
  assert.equal(demo.length, 12);
});

test('the distributor profile extends the demo profile without altering it', () => {
  const demo = composedApplicationSeed('demo');
  const distributor = composedApplicationSeed('distributor');
  assert.equal(
    JSON.stringify(distributor.slice(0, demo.length)),
    JSON.stringify(demo),
    'the distributor profile must be a prefix-preserving superset of demo',
  );
  assert.ok(
    distributor.length > demo.length,
    'the distributor profile adds no records',
  );
  const recordIds = new Set(distributor.map((record) => record.recordId));
  assert.equal(
    recordIds.size,
    distributor.length,
    'two seed records share a record identifier',
  );
  const keys = new Set(distributor.map((record) => record.idempotencyKey));
  assert.equal(
    keys.size,
    distributor.length,
    'two seed records share an idempotency key',
  );
});

test('the distributor profile fills a list past its declared page size', () => {
  // 100 is the modules' declared maximumResultCount. Below it the item list
  // renders no "Next page" link and the dev environment cannot show a human
  // that pagination works at all.
  const items = composedApplicationSeed('distributor').filter(
    (record) =>
      record.operationId === APPLICATION_IDS.catalog.createOperationId,
  );
  assert.ok(
    items.length > 100,
    `the item seed must exceed the declared page size of 100; got ${String(items.length)}`,
  );
});

test('every seeded identifier exists in the compiled application release', () => {
  const declared = declaredIdentifiers();
  const seed = composedApplicationSeed('distributor');
  assert.ok(seed.length > 0, 'the seed is empty, so this gate read nothing');
  let checkedOptions = 0;
  for (const record of seed) {
    assert.ok(
      declared.operationIds.has(record.operationId),
      `seed operation ${record.operationId} is not in the compiled release`,
    );
    for (const [fieldId, value] of Object.entries(record.values)) {
      assert.ok(
        declared.fieldIds.has(fieldId),
        `seed field ${fieldId} is not in the compiled release`,
      );
      const options = declared.optionIdsByFieldId.get(fieldId);
      if (options) {
        checkedOptions += 1;
        assert.ok(
          options.has(value),
          `seed value ${value} is not a declared option of ${fieldId}`,
        );
      }
    }
  }
  assert.ok(
    checkedOptions > 0,
    'no enum-valued field was seeded, so the option check read nothing',
  );
});

test('the surfaces the dev server prints exist in the compiled application release', () => {
  // apps/api/src/main.ts prints these three as the human entry points. They
  // come from APPLICATION_IDS, which nothing else validates, so a surface
  // rename would produce a valid release and a banner of dead links.
  const declared = declaredIdentifiers();
  for (const surfaceId of [
    APPLICATION_IDS.catalog.listSurfaceId,
    APPLICATION_IDS.party.listSurfaceId,
    APPLICATION_IDS.location.listSurfaceId,
  ]) {
    assert.ok(
      declared.surfaceIds.has(surfaceId),
      `the dev server prints ${surfaceId}, which is not in the compiled release`,
    );
  }
});

test('the dev container name refuses the prefix the matrix guard scans', () => {
  // Unrepresentable rather than detectable. `guard-ephemeral-postgres.mjs`
  // scans `name=^/north-star-` and `run-matrix.sh` invokes it AFTER taking the
  // exclusive lock, so a dev container under that name makes the matrix exit
  // 76 with the slot burned, and past an hour the age sweep removes it without
  // checking whether its owner is alive.
  assert.throws(
    () =>
      resolveDevContainer({
        [DEV_CONTAINER_VARIABLE]: 'north-star-my-dev-db',
      }),
    /must not start with "north-star-"/u,
  );
  // The admission twin: a refusal-only assertion is satisfied by a guard that
  // refuses everything.
  const admitted = resolveDevContainer({
    [DEV_CONTAINER_VARIABLE]: 'my-dev-db',
  });
  assert.equal(admitted.name, 'my-dev-db');
  assert.equal(admitted.volume, 'my-dev-db-data');
});

test('the retired container variable is refused rather than ignored', () => {
  // Four packet records still pass this variable with a `north-star-` value.
  // Ignoring it silently started a container the caller did not name while
  // `dev:stop` targeted a third name.
  assert.throws(
    () =>
      resolveDevContainer({
        [RETIRED_CONTAINER_VARIABLE]: 'north-star-g2-p5da-check',
      }),
    /is no longer read/u,
  );
});

test('the default dev container is outside the reserved prefix', () => {
  const resolved = resolveDevContainer({});
  assert.equal(resolved.name, DEFAULT_DEV_CONTAINER_NAME);
  assert.ok(
    !resolved.name.startsWith(RESERVED_CONTAINER_PREFIX),
    'the default dev container name is inside the reserved test prefix',
  );
  assert.equal(resolved.volume, `${DEFAULT_DEV_CONTAINER_NAME}-data`);
});
