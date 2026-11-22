import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import {
  INVENTORY_WRITE_INVARIANTS,
  STOCK_COUNT_COUNTING_INVARIANT,
} from '../../packages/postgres-provider/src/inventory-write-invariants.js';
import {
  bindWriteInvariants,
  stateWriteInvariantRefusal,
  validatedWriteInvariantProviders,
  type ModuleWriteInvariantProvider,
} from '../../packages/postgres-provider/src/module-write-invariants.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';

// GENERALIZE-1 slice 1, item 1. The generic record writer used to recognise
// the first-party stock count by its entity suffix. It now enforces whatever
// state-dependent write invariant a capability declares.

const ns = 'northstar.app';
const countEntity = `${ns}:entity.stock_count`;
const state = `${ns}:field.stock_count_state`;
const mode = `${ns}:field.stock_count_counting_mode`;
const counting = `${ns}:option.stock_count_state_counting`;
const draft = `${ns}:option.stock_count_state_draft`;
const blind = `${ns}:option.stock_count_counting_mode_blind`;
const open = `${ns}:option.stock_count_counting_mode_open`;
const narrative = `${ns}:field.stock_count_reason_narrative`;

test('GENERALIZE-1: Inventory binds the counting invariant on the governed first-party storage', async () => {
  const storage = await governedStorageTarget();
  const bound = bindWriteInvariants(INVENTORY_WRITE_INVARIANTS, storage);
  assert.deepEqual([...bound.keys()], [countEntity]);
  assert.deepEqual(bound.get(countEntity), [
    {
      entityId: countEntity,
      stateFieldId: state,
      guardedStateId: counting,
      appliesToRecordsWithFieldId: mode,
      frozenFields: [
        {
          fieldId: mode,
          refusal: 'counting mode is fixed after Start counting',
        },
        {
          fieldId: state,
          refusal: 'use a stock count command to leave counting',
        },
      ],
    },
  ]);
  // The bound IDs are real columns and options of the pinned storage.
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === countEntity,
  )!;
  for (const fieldId of [state, mode])
    assert.ok(
      entity.columns.some((column) => column.canonicalFieldId === fieldId),
      fieldId,
    );
});

test('GENERALIZE-1: first-party stock count keeps its exact counting refusals', async () => {
  const bound = bindWriteInvariants(
    INVENTORY_WRITE_INVARIANTS,
    await governedStorageTarget(),
  );
  const invariants = bound.get(countEntity)!;
  const prior = { [state]: counting, [mode]: blind, [narrative]: 'Bay 4' };
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, { [mode]: open }),
    'counting mode is fixed after Start counting',
  );
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, { [state]: draft }),
    'use a stock count command to leave counting',
  );
  // Mode is checked before state, as before.
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, {
      [state]: draft,
      [mode]: open,
    }),
    'counting mode is fixed after Start counting',
  );
  // Restating the same values and editing other fields still save.
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, {
      [mode]: blind,
      [state]: counting,
      [narrative]: 'Check the adjacent bay again',
    }),
    null,
  );
  // Outside counting the mode and state are ordinary fields.
  assert.equal(
    stateWriteInvariantRefusal(
      invariants,
      { ...prior, [state]: draft },
      { [mode]: open, [state]: counting },
    ),
    null,
  );
  // Older count definitions do not have a mode, and are exempt.
  assert.equal(
    stateWriteInvariantRefusal(
      invariants,
      { [state]: counting },
      { [state]: draft },
    ),
    null,
  );
  // Another namespace's stock count binds the same way (unchanged behaviour).
  const tenant = STOCK_COUNT_COUNTING_INVARIANT.bind({
    entities: [{ entityId: 'acme.store:entity.stock_count' }],
  } as unknown as StorageTargetPayloadV1);
  assert.equal(tenant[0]?.stateFieldId, 'acme.store:field.stock_count_state');
});

test('GENERALIZE-1: a second application gets the same writer behaviour purely by declaration', () => {
  // A field-service app: an inspection visit's method is fixed once the visit
  // is in progress, and only the app's own Complete/Abandon command leaves.
  const visit = 'fieldops.app:entity.inspection_visit';
  const visitState = 'fieldops.app:field.visit_status';
  const inProgress = 'fieldops.app:option.visit_status_in_progress';
  const method = 'fieldops.app:field.inspection_method';
  const crew = 'fieldops.app:field.assigned_crew';
  const provider = {
    providerId: 'fieldops.app:write-invariant.visit-in-progress',
    bind: (storage: StorageTargetPayloadV1) =>
      storage.entities
        .filter((entity) => entity.entityId === visit)
        .map(() => ({
          entityId: visit,
          stateFieldId: visitState,
          guardedStateId: inProgress,
          appliesToRecordsWithFieldId: method,
          frozenFields: [
            { fieldId: method, refusal: 'the inspection method is fixed' },
            { fieldId: crew, refusal: 'reassign the crew with Handover' },
            { fieldId: visitState, refusal: 'finish the visit with Complete' },
          ],
        })),
  } satisfies ModuleWriteInvariantProvider;
  const storage = {
    entities: [
      { entityId: visit },
      { entityId: 'fieldops.app:entity.stock_count' },
    ],
  } as unknown as StorageTargetPayloadV1;
  const bound = bindWriteInvariants(
    validatedWriteInvariantProviders([provider]),
    storage,
  );
  // Only what was declared binds: no stock-count rule rides along.
  assert.deepEqual([...bound.keys()], [visit]);
  const invariants = bound.get(visit)!;
  const prior = {
    [visitState]: inProgress,
    [method]: 'fieldops.app:option.inspection_method_visual',
    [crew]: 'crew-7',
  };
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, {
      [method]: 'fieldops.app:option.inspection_method_ultrasonic',
    }),
    'the inspection method is fixed',
  );
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, { [crew]: 'crew-9' }),
    'reassign the crew with Handover',
  );
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, {
      [visitState]: 'fieldops.app:option.visit_status_scheduled',
    }),
    'finish the visit with Complete',
  );
  assert.equal(
    stateWriteInvariantRefusal(invariants, prior, {
      'fieldops.app:field.visit_notes': 'Gate code 4412',
    }),
    null,
  );
  assert.equal(
    stateWriteInvariantRefusal(
      invariants,
      { ...prior, [visitState]: 'fieldops.app:option.visit_status_scheduled' },
      { [crew]: 'crew-9' },
    ),
    null,
  );
});

test('GENERALIZE-1: write invariant providers and declarations are validated', () => {
  const provider = {
    providerId: 'x.app:write-invariant.one',
    bind: () => [],
  } satisfies ModuleWriteInvariantProvider;
  assert.throws(
    () => validatedWriteInvariantProviders([provider, provider]),
    /duplicated/u,
  );
  assert.throws(
    () =>
      bindWriteInvariants(
        [
          {
            providerId: 'x.app:write-invariant.empty',
            bind: () => [
              {
                entityId: 'x.app:entity.thing',
                stateFieldId: 'x.app:field.state',
                guardedStateId: 'x.app:option.state_on',
                appliesToRecordsWithFieldId: 'x.app:field.state',
                frozenFields: [],
              },
            ],
          },
        ],
        { entities: [] } as unknown as StorageTargetPayloadV1,
      ),
    /invalid/u,
  );
});

test('GENERALIZE-1: the generic record writer names no stock count and enforces declared invariants on update', async () => {
  const source = await readFile(
    resolve('packages/postgres-provider/src/module-runtime-interpreter.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /stock_count|stockCount|counting_mode/u);
  const update = source.slice(
    source.indexOf("if (kind === 'updateRecordEffect') {"),
    source.indexOf('const changes =\n'),
  );
  assert.match(
    update,
    /requireStateWriteInvariants\(\s*writeInvariants,\s*entity,\s*prior\.values,\s*input\.patch,\s*\)/u,
    'the update path enforces the declared invariants on the stored image',
  );
});

test('GENERALIZE-1: every production record writer is constructed with the declared write invariants', async () => {
  const { readdir } = await import('node:fs/promises');
  const sources: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') await walk(path);
      } else if (/\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name))
        sources.push(path);
    }
  };
  for (const root of ['packages', 'apps'])
    for (const entry of await readdir(resolve(root), { withFileTypes: true }))
      if (entry.isDirectory()) {
        const src = resolve(root, entry.name, 'src');
        await walk(src).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
  const constructions: string[] = [];
  for (const path of sources) {
    const text = await readFile(path, 'utf8');
    for (const name of [
      'new PostgresModuleRuntimeInterpreter(',
      'new PostgresReleaseVerificationService(',
      'new PostgresWorkflowGateway(',
    ]) {
      let at = text.indexOf(name);
      while (at !== -1) {
        let depth = 0;
        let end = at + name.length - 1;
        for (; end < text.length; end += 1) {
          if (text[end] === '(') depth += 1;
          else if (text[end] === ')' && --depth === 0) break;
        }
        const call = text.slice(at, end + 1);
        constructions.push(`${path}: ${name}`);
        assert.match(
          call,
          /writeInvariants/u,
          `${path} constructs a record writer without write invariants`,
        );
        at = text.indexOf(name, end);
      }
    }
  }
  // Serving, workflow, verification, and the two customization view loads.
  assert.ok(constructions.length >= 6, constructions.join('\n'));
});
