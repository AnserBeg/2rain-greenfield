import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compositionRelationTargets } from '../../apps/web/src/surface-composition.js';
import type { CompiledSurfaceDefinition } from '../../apps/web/src/surface-contract.js';
import {
  canonicalize,
  normalizeApplicationPackage,
  parseVersionedAuthoredApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import { retypedCalculatedDisplayField } from '../../packages/canonical-model/src/calculated-display-bindings.js';
import {
  decimalDisplayCoefficient,
  decimalDisplayText,
  displayArithmeticType,
  evaluateDisplayArithmetic,
} from '../../packages/canonical-model/src/calculated-display.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  type ProjectionFamilyId,
} from '../../packages/compiler/src/protocol.js';
import {
  applyCustomizationPatches,
  calculatedDisplayDraft,
  customizationTargets,
} from '../../packages/customization/src/index.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import {
  compilerInput,
  mustCompile,
  projectionPayload,
} from '../compiler/helpers.js';

const cad = { precision: 38, scale: 18, currency: 'CAD', unit: null };
const quantity = {
  precision: 38,
  scale: 18,
  currency: null,
  unit: 'northstar.app:unit.each',
};
const usd = { ...cad, currency: 'USD' };
const price = 'northstar.app:field.item_price_cad';
const cost = 'northstar.app:field.item_standard_cost_cad';
const record = 'northstar.app:surface.item_detail';
const list = 'northstar.app:surface.item_list';

test('calculated display arithmetic keeps exact signed decimals at the propagated scale', () => {
  const left = decimalDisplayCoefficient(
    '9007199254740993.000000000000000001',
    cad,
  );
  const right = decimalDisplayCoefficient('9007199254740993', cad);
  assert.ok(left && right);
  assert.equal(
    decimalDisplayText(
      evaluateDisplayArithmetic('subtract', left, 18, right, 18),
      18,
    ),
    '0.000000000000000001',
  );
  assert.equal(
    decimalDisplayText(
      evaluateDisplayArithmetic('add', -left, 18, right, 18),
      18,
    ),
    '-0.000000000000000001',
  );
  const quantityCoefficient = decimalDisplayCoefficient(
    '0.000000000000000001',
    quantity,
  );
  assert.ok(quantityCoefficient);
  assert.equal(
    decimalDisplayText(
      evaluateDisplayArithmetic(
        'multiply',
        quantityCoefficient,
        18,
        quantityCoefficient,
        18,
      ),
      36,
    ),
    '0.000000000000000000000000000000000001',
    'multiplication must preserve both factors and all 36 decimal places',
  );
  assert.equal(decimalDisplayCoefficient('100000000000000000000', cad), null);
  assert.deepEqual(displayArithmeticType('subtract', cad, cad), {
    ...cad,
    precision: 39,
  });
  assert.deepEqual(displayArithmeticType('multiply', cad, quantity), {
    ...cad,
    precision: 76,
    scale: 36,
  });
  assert.equal(displayArithmeticType('subtract', cad, usd), null);
  assert.equal(displayArithmeticType('multiply', cad, cad), null);
});

test('v6 compiles a calculated display to its governed read sinks and refuses mixed currencies', () => {
  const authored = parseVersionedAuthoredApplicationPackageJson(
    readFileSync('apps/web/release/app.authored.json'),
  );
  assert.ok(authored.languageVersion === 'v6');
  const baseline = normalizeApplicationPackage(authored);
  const target = customizationTargets(baseline).calculatedDisplayTargets?.find(
    ({ recordSurfaceId }) => recordSurfaceId === record,
  );
  assert.ok(target);
  const patch = calculatedDisplayDraft(target, {
    label: 'Margin CAD',
    operator: 'subtract',
    leftFieldId: price,
    rightFieldId: cost,
    listSurfaceId: list,
  });
  const applied = applyCustomizationPatches(authored, [patch]);
  assert.ok(applied.status === 'applied', JSON.stringify(applied));
  const parsed = parseVersionedAuthoredApplicationPackageJson(
    canonicalize(applied.authored),
  );
  assert.ok(parsed.languageVersion === 'v6');
  const normalized = normalizeApplicationPackage(parsed);
  const encoder = new TextEncoder();
  const compilerFixture = normalizeApplicationPackage({
    ...authored,
    calculatedDisplayFields: [patch.field],
  });
  const compiled = mustCompile(
    compilerInput(encoder.encode(canonicalize(compilerFixture))),
  );
  const references = compiled.bundle.releaseManifest.projections;
  assert.equal(
    references.find(
      ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.queryCatalog,
    )?.requiredRuntimeCapability.minimumVersion,
    4,
  );
  assert.equal(
    references.find(
      ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.formulaRule,
    )?.payloadSchemaVersion,
    'northstar.formula-rule-payload/v1',
  );
  const fieldId = patch.field.fieldId;
  const recordSurface = projectionPayload<{
    surfaces: CompiledSurfaceDefinition[];
  }>(compiled, PROJECTION_FAMILY_IDS.surfaceManifest).surfaces.find(
    ({ surfaceId }) => surfaceId === record,
  );
  assert.ok(
    recordSurface?.composition?.fields.some(({ field }) => field === fieldId),
  );
  const projection = (familyId: ProjectionFamilyId) => ({
    ...references.find((reference) => reference.familyId === familyId),
    payload: projectionPayload(compiled, familyId),
  });
  const pinned = {
    projections: {
      query: projection(PROJECTION_FAMILY_IDS.queryCatalog),
      formulaRule: projection(PROJECTION_FAMILY_IDS.formulaRule),
    },
  } as RequestRuntimeView;
  assert.ok(
    !compositionRelationTargets(pinned, recordSurface).includes(fieldId),
    'the record requests its calculated display as a result, without a relation lookup',
  );
  assert.doesNotMatch(
    JSON.stringify(normalized.fields),
    new RegExp(fieldId, 'u'),
  );
  assert.doesNotMatch(
    JSON.stringify(normalized.operations),
    new RegExp(fieldId, 'u'),
  );
  assert.equal(
    retypedCalculatedDisplayField(normalized, baseline, baseline),
    null,
  );
  assert.equal(
    retypedCalculatedDisplayField(
      normalized,
      {
        ...baseline,
        fields: baseline.fields.map((field) =>
          field.fieldId === price ? { ...field, lifecycle: 'retired' } : field,
        ),
      },
      baseline,
    ),
    fieldId,
  );
  const incompatible = {
    ...parsed,
    calculatedDisplayFields: [
      {
        ...patch.field,
        expression: {
          ...patch.field.expression,
          right: {
            kind: 'field',
            schemaVersion: 'v6',
            fieldId: 'northstar.app:field.item_standard_cost_usd',
          },
        },
      },
    ],
  };
  assert.throws(
    () => normalizeApplicationPackage(incompatible),
    /CANON_CALCULATED_DISPLAY_BINDING_UNSUPPORTED/u,
  );
  const refused = compileApplication(
    compilerInput(
      encoder.encode(
        canonicalize({
          ...compilerFixture,
          calculatedDisplayFields: incompatible.calculatedDisplayFields,
        }),
      ),
    ),
  );
  assert.equal(refused.status, 'failed');
});
