import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalize } from '../../packages/canonical-model/src/canonicalize.js';
import { BILLING_READER } from '../../packages/canonical-model/src/billing.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { unsupportedRuntimeCapability } from '../../packages/runtime/src/request-runtime-view.js';
import {
  compilerInput,
  mustCompile,
  normalizedBytes,
  projectionPayload,
} from '../compiler/helpers.js';
import {
  withArchivedCustomizationRuntime,
  assertArchivedTenantEnvelope,
} from '../helpers/archived-customization-runtime.js';

test('a declaring release carries its plan and preserves pre-billing release bytes when absent', async () => {
  const authored = JSON.parse(
    readFileSync('test/fixtures/g1/compiler/vertical-v1.authored.json', 'utf8')
      .replaceAll('"v3"', '"v6"')
      .replaceAll('northstar.normalization/v3', 'northstar.normalization/v6'),
  );
  const input = {
    ...authored,
    billingPlans: [
      {
        schemaVersion: 'v6',
        id: 'capacity',
        version: '1',
        currency: 'USD',
        serviceUnit: 'seat',
        slots: [{ kind: 'money', id: 'fee', currency: 'USD', scale: 2 }],
        schedule: { kind: 'onServiceEnd' },
        components: [
          {
            id: 'end',
            kind: 'fixed',
            stage: 'afterCapBeforeTax',
            taxClassification: 'untaxed',
            base: 'enrollment',
            amount: 'fee',
            occurrence: { kind: 'oneOff', at: 'serviceEnd' },
          },
        ],
      },
    ],
  };
  const compiled = mustCompile(compilerInput(normalizedBytes(input)));
  const family = PROJECTION_FAMILY_IDS.surfaceManifest;
  const payload = projectionPayload<{ billingPlans: { id: string }[] }>(
    compiled,
    family,
  );
  assert.equal(payload.billingPlans[0]!.id, 'capacity');
  const ref = compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === family,
  )!;
  assert.equal(ref.requiredRuntimeCapability.minimumVersion, BILLING_READER);
  assert.equal(
    unsupportedRuntimeCapability(family, ref.requiredRuntimeCapability),
    null,
  );
  const absent = mustCompile(compilerInput(normalizedBytes(authored)));
  assert.ok(
    !Object.hasOwn(projectionPayload<object>(absent, family), 'billingPlans'),
  );
  await withArchivedCustomizationRuntime(
    'f25df5af44df132045c67ba29eb9aebe1084dcc7',
    async (run) => {
      const previous = (await run(
        `
     import {readFileSync} from 'node:fs';
     import {compilerInput,normalizedBytes,mustCompile} from './test/compiler/helpers.ts';
     const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
     const result=mustCompile(compilerInput(normalizedBytes(input)));
     console.log(JSON.stringify(result.releaseRoot));
   `,
        authored,
      )) as string;
      assert.equal(previous, absent.releaseRoot);
      await assertArchivedTenantEnvelope(run);
    },
  );
  assert.throws(
    () =>
      normalizedBytes({
        ...input,
        billingPlans: [{ ...input.billingPlans[0], currency: 'CAD' }],
      }),
    /CANON_SCHEMA_INVALID/,
  );
  assert.ok(canonicalize(payload).includes('oneOff'));
});
