import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { expect, test, type Page } from '@playwright/test';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '@north-star/canonical-model';
import {
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
  type CompilerSemanticProfileVersion,
  type ContentAddressedArtifact,
} from '@north-star/compiler';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '@north-star/runtime/request-context';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type RegisteredCapabilityOperationAuthorizationRequest,
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  ModuleRuntimeInterpreterError,
  parseMutationInput,
} from '../../../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '../../../../packages/runtime/src/request-runtime-view.js';
import {
  FIXTURE_IDS,
  FIXTURE_LANGUAGE_VERSION,
  ordinaryModuleV1,
} from '../../../../test/fixtures/g2/module-conformance/definitions.js';
import {
  EVERY_KIND_FIELD_IDS,
  everyFieldKindModule,
} from '../../../../test/fixtures/g2/module-conformance/field-kinds.js';
import { createSurfaceRuntimeServer } from '../../src/app-server.js';
import {
  SURFACE_MESSAGE_CATALOG,
  type SurfaceMessageCode,
} from '../../src/message-catalog.js';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const environmentId = 'a2000000-0000-4000-8000-000000000002';
const principalId = 'a3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

let server: Server;
let baseUrl: string;
let executor: BrowserFixtureExecutor;
let missingDisplayRecordId: string;
let fieldKindServer: Server;
let fieldKindUrl: string;
let fieldKindExecutor: BrowserFixtureExecutor;
let adoptedFieldKindServer: Server;
let adoptedFieldKindUrl: string;
let adoptedFieldKindExecutor: BrowserFixtureExecutor;

test.beforeAll(async () => {
  const compiled = compileFixture();
  const policy = allowPolicy();
  executor = new BrowserFixtureExecutor(null);
  const operationMediation = new SemanticOperationMediationAuthority();
  executor.createSeed('Existing live master');
  missingDisplayRecordId = executor.createSeed();
  server = createSurfaceRuntimeServer(runtimeEntry(compiled, policy), {
    operationGateway: new SemanticOperationGateway(
      policy,
      executor,
      operationMediation,
    ),
    operationMediation,
    queryGateway: new SemanticQueryGateway(policy, executor),
  });
  baseUrl = await listen(server);

  // A second server on the every-field-kind package compiled at the UNADOPTED
  // compiler-semantic v2. Nothing it produces is recorded, so no lineage entry
  // is minted (ADR-0047 §4a); it exists because the claim below -- that a date
  // field renders a DATE CONTROL -- can only be observed in a browser.
  const fieldKindPolicy = allowPolicy();
  fieldKindExecutor = new BrowserFixtureExecutor(null);
  const fieldKindMediation = new SemanticOperationMediationAuthority();
  fieldKindServer = createSurfaceRuntimeServer(
    runtimeEntry(compileEveryFieldKindFixture(), fieldKindPolicy),
    {
      operationGateway: new SemanticOperationGateway(
        fieldKindPolicy,
        fieldKindExecutor,
        fieldKindMediation,
      ),
      operationMediation: fieldKindMediation,
      queryGateway: new SemanticQueryGateway(
        fieldKindPolicy,
        fieldKindExecutor,
      ),
    },
  );
  fieldKindUrl = await listen(fieldKindServer);

  // The shipped profile-v1 shape is intentionally mixed: operation input
  // fields are present, while surface field kinds are not. That is the path a
  // real form uses today, so it gets its own server rather than being inferred
  // from the profile-v2 renderer fixture above.
  const adoptedFieldKindPolicy = allowPolicy();
  adoptedFieldKindExecutor = new BrowserFixtureExecutor(null);
  const adoptedFieldKindMediation = new SemanticOperationMediationAuthority();
  adoptedFieldKindServer = createSurfaceRuntimeServer(
    runtimeEntry(
      compileEveryFieldKindFixture(COMPILER_SEMANTIC_PROFILE_V1_VERSION),
      adoptedFieldKindPolicy,
    ),
    {
      operationGateway: new SemanticOperationGateway(
        adoptedFieldKindPolicy,
        adoptedFieldKindExecutor,
        adoptedFieldKindMediation,
      ),
      operationMediation: adoptedFieldKindMediation,
      queryGateway: new SemanticQueryGateway(
        adoptedFieldKindPolicy,
        adoptedFieldKindExecutor,
      ),
    },
  );
  adoptedFieldKindUrl = await listen(adoptedFieldKindServer);
});

test('record title falls back to short identity when its compiled display value is absent', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(missingDisplayRecordId)}`,
  );
  const expectedTitle = `${missingDisplayRecordId.slice(0, 8)}…${missingDisplayRecordId.slice(-4)}`;
  await expect(
    page.getByRole('heading', { level: 1, name: expectedTitle }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'master' }),
  ).toHaveCount(0);
});

test('authored business labels survive while field prefixes follow canonical entity identity', async ({
  page,
}) => {
  const listSurfaceId = `${FIXTURE_IDS.namespace}:surface.opaque_orders_list`;
  const formSurfaceId = `${FIXTURE_IDS.namespace}:surface.handset_orders_form`;
  const recordSurfaceId = `${FIXTURE_IDS.namespace}:surface.audit_entry_record`;
  const compiled = compileFixture(
    true,
    false,
    (authored) => {
      const surfaces = authored.surfaces as Array<Record<string, unknown>>;
      const list = surfaces.find(
        (surface) =>
          surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_list`,
      );
      const form = surfaces.find(
        (surface) =>
          surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_form`,
      );
      const record = surfaces.find(
        (surface) =>
          surface.surfaceId ===
          `${FIXTURE_IDS.namespace}:surface.master_record`,
      );
      assert.ok(list);
      assert.ok(form);
      assert.ok(record);
      list.label = 'VAT & R&D orders list';
      list.surfaceId = listSurfaceId;
      form.label = 'iPhone orders form';
      form.surfaceId = formSurfaceId;
      record.label = 'A/P & VAT audit detail';
      record.surfaceId = recordSurfaceId;
    },
    true,
  );
  const policy = allowPolicy();
  const labelExecutor = new BrowserFixtureExecutor(null);
  const labelRecordId = labelExecutor.createSeed('Business label specimen');
  const operationMediation = new SemanticOperationMediationAuthority();
  const labelServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        labelExecutor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, labelExecutor),
    },
  );
  const labelBaseUrl = await listen(labelServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    await page.goto(
      `${labelBaseUrl}/?surface=${encodeURIComponent(listSurfaceId)}`,
    );
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'VAT & R&D orders',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Name', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Master name' }),
    ).toHaveCount(0);

    await page.goto(
      `${labelBaseUrl}/?surface=${encodeURIComponent(formSurfaceId)}`,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'New iPhone orders' }),
    ).toBeVisible();
    await expect(page.getByLabel('Number', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toBeVisible();

    await page.goto(
      `${labelBaseUrl}/?surface=${encodeURIComponent(recordSurfaceId)}&record=${encodeURIComponent(labelRecordId)}`,
    );
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(
      breadcrumb.getByText('VAT & R&D orders list', { exact: true }),
    ).toBeVisible();
    await expect(
      breadcrumb.getByText('A/P & VAT audit', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'A/P & VAT audit information',
      }),
    ).toBeVisible();
    await expect(
      page.locator('dt').getByText('Name', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('dt').getByText('Master name')).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      labelServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    fieldKindServer.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    adoptedFieldKindServer.close((error) =>
      error ? reject(error) : resolve(),
    );
  });
});

/**
 * The observation, not the attribute. `type="date"` in the markup is already
 * asserted server-side; what only a browser can answer is whether the USER gets
 * a date control -- an engine that does not support the type reports `type` as
 * `text` through the IDL and accepts any string. So this reads the live IDL
 * property and then feeds the control a non-date, which a real date control
 * refuses by leaving `value` empty.
 *
 * The same shape for `datalist`: an attribute is a string, `input.list` is the
 * resolved element, and only the second one proves the suggestions are attached.
 */
test('compiled field kinds render as real browser controls', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${fieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
  );
  await expect(page.locator('#surface-record-form')).toBeVisible();

  const date = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.due}"]`);
  await expect(date).toHaveJSProperty('type', 'date');
  await date.evaluate((element: HTMLInputElement) => {
    element.value = 'not-a-date';
  });
  expect(
    await date.evaluate((element: HTMLInputElement) => element.value),
  ).toBe('');
  await date.fill('2026-08-09');
  expect(
    await date.evaluate((element: HTMLInputElement) => element.value),
  ).toBe('2026-08-09');

  // A boolean is a three-option select, not a checkbox: an optional one has
  // three states and a checkbox has two. Blank is the unset state, and it is
  // what the control starts on for a record that has no value.
  const active = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.active}"]`);
  expect(
    await active.evaluate((element) => element.tagName.toLowerCase()),
  ).toBe('select');
  await expect(active).toHaveJSProperty('value', '');
  expect(
    await active.evaluate((element: HTMLSelectElement) =>
      [...element.options].map((option) => option.value),
    ),
  ).toEqual(['', 'true', 'false']);
  await active.selectOption('false');
  await expect(active).toHaveJSProperty('value', 'false');

  // A date-time carrier is deliberately NOT a native control: datetime-local is
  // local time without timezone information, so it cannot hold either declared
  // semantics. Refused by name, with the declared domain on the element.
  const instant = page.locator(
    `[name="value:${FIXTURE_IDS.fieldIds.parentUtcInstant}"]`,
  );
  await expect(instant).toHaveJSProperty('type', 'text');
  await expect(instant).toHaveAttribute(
    'data-refused-control',
    'datetime-local',
  );
  await expect(instant).toHaveAttribute(
    'data-timezone-semantics',
    'utcInstant',
  );

  // Two time fields of one kind, differing only in declared precision, must
  // differ in the step that decides what the browser will accept.
  await expect(
    page.locator(`[name="value:${FIXTURE_IDS.fieldIds.parentLocalTime}"]`),
  ).toHaveJSProperty('step', '1');
  await expect(
    page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.preciseTime}"]`),
  ).toHaveJSProperty('step', '0.001');

  const price = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.price}"]`);
  await expect(price).toHaveJSProperty('type', 'number');
  await price.fill('12.50');
  expect(
    await price.evaluate((element: HTMLInputElement) => element.validity.valid),
  ).toBe(true);

  const grade = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.grade}"]`);
  expect(await grade.evaluate((element) => element.tagName.toLowerCase())).toBe(
    'select',
  );
  await expect(grade).toHaveJSProperty('value', '');
  expect(
    await grade.evaluate(
      (element: HTMLSelectElement) => element.options.length,
    ),
  ).toBe(6);

  const region = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.region}"]`);
  expect(
    await region.evaluate((element) => element.tagName.toLowerCase()),
  ).toBe('input');
  expect(
    await region.evaluate(
      (element: HTMLInputElement) => element.list?.options.length ?? 0,
    ),
  ).toBe(6);
});

const SEEDED = Object.freeze({
  // Nonzero seconds AND milliseconds, on both timezone semantics. A control
  // that drops either -- which is what every datetime-local does at its default
  // 60-second step -- destroys these on the first edit.
  [FIXTURE_IDS.fieldIds.parentUtcInstant]: '2026-08-09T12:34:56.789Z',
  [EVERY_KIND_FIELD_IDS.offsetMoment]: '2026-08-09T12:34:56-06:00',
  // Times WITH seconds, at both declared precisions.
  [FIXTURE_IDS.fieldIds.parentLocalTime]: '12:34:56',
  [EVERY_KIND_FIELD_IDS.preciseTime]: '12:34:56.789',
  [EVERY_KIND_FIELD_IDS.due]: '2026-08-09',
  [EVERY_KIND_FIELD_IDS.price]: '1250.75',
  [EVERY_KIND_FIELD_IDS.count]: '42',
  [EVERY_KIND_FIELD_IDS.grade]: `${FIXTURE_IDS.namespace}:option.grade_c`,
  [EVERY_KIND_FIELD_IDS.region]: `${FIXTURE_IDS.namespace}:option.region_west`,
  [FIXTURE_IDS.fieldIds.parentName]: 'Round trip master',
});

function formUrl(recordId: string): string {
  return `${fieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}&record=${encodeURIComponent(recordId)}`;
}

function fieldKindFormUrl(base: string, recordId: string): string {
  return `${base}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}&record=${encodeURIComponent(recordId)}`;
}

function capturePost(page: Page): Promise<string> {
  return new Promise<string>((resolve) => {
    page.on('request', (request) => {
      if (request.method() === 'POST') resolve(request.postData() ?? '');
    });
  });
}

async function readRenderedForm(page: Page): Promise<Record<string, string>> {
  return (await page
    .locator('#surface-record-form')
    .evaluate((form: HTMLFormElement) =>
      Object.fromEntries(
        [...new FormData(form).entries()].map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    )) as Record<string, string>;
}

async function idleValue(page: Page, fieldId: string): Promise<string> {
  return page
    .locator(`[name="value:${fieldId}"]`)
    .evaluate((element: HTMLInputElement | HTMLSelectElement) => element.value);
}

test('the string wire is normalised before the real provider parser admits it', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const recordId = fieldKindExecutor.seedTypedValues({
    ...SEEDED,
    [EVERY_KIND_FIELD_IDS.active]: true,
  });
  await page.goto(formUrl(recordId));
  await expect(page.locator('#surface-record-form')).toBeVisible();

  // Read through the live IDL, not the markup: a control that truncated or
  // refused its value reports what the user would actually submit.
  for (const [fieldId, value] of Object.entries(SEEDED)) {
    expect(await idleValue(page, fieldId), fieldId).toBe(value);
  }
  expect(await idleValue(page, EVERY_KIND_FIELD_IDS.active)).toBe('true');

  // Native validity, which is what the declared precision buys. A time control
  // at the browser's default 60-second step refuses `12:34:56` outright.
  for (const fieldId of Object.keys(SEEDED)) {
    expect(
      await page
        .locator(`[name="value:${fieldId}"]`)
        .evaluate((element: HTMLInputElement) => element.checkValidity()),
      fieldId,
    ).toBe(true);
  }
  expect(
    await page.evaluate((stored) => {
      const probe = (step: string | null): boolean => {
        const input = document.createElement('input');
        input.type = 'time';
        if (step !== null) input.step = step;
        input.value = stored;
        return input.checkValidity();
      };
      return { asRendered: probe('0.001'), browserDefault: probe(null) };
    }, SEEDED[EVERY_KIND_FIELD_IDS.preciseTime]!),
  ).toEqual({ asRendered: true, browserDefault: false });
  // And the premise behind refusing `datetime-local` by name: a real one cannot
  // hold the stored instant at all.
  expect(
    await page.evaluate((stored) => {
      const probe = document.createElement('input');
      probe.type = 'datetime-local';
      probe.value = stored;
      return probe.value;
    }, SEEDED[FIXTURE_IDS.fieldIds.parentUtcInstant]!),
  ).toBe('');

  // THE RENDERED ARM. Exactly one selector control, carrying the update
  // operation, and zero of the retired vocabulary. This proves the OLD half is
  // not present -- a presence check alone cannot, because `operationId` being
  // there does not exclude `intent` being there too, and both is precisely what
  // a half-reverted merge produces.
  const form = page.locator('#surface-record-form');
  expect(
    await form
      .locator('[name="operationId"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLInputElement).value),
      ),
  ).toEqual([`${FIXTURE_IDS.namespace}:operation.master_update`]);
  await expect(form.locator('[name="intent"]')).toHaveCount(0);

  const posted = capturePost(page);
  await page.getByRole('button', { name: 'Save' }).click();
  const params = new URLSearchParams(await posted);
  const entries = [...params.entries()];
  const valueEntries = entries.filter(([key]) => key.startsWith('value:'));

  // THE SUBMITTED ARM, as an exact multiset rather than a prefix. A review found
  // the prefix check satisfiable by a form that posts the WRONG operation: append
  // a second `operationId` after the four asserted keys and every assertion here
  // stayed green, while `readFormSubmission` builds its record with
  // `Object.fromEntries`, so the LAST duplicate wins. An update form would then
  // address the create operation. Cardinality and value, not position.
  expect(params.getAll('operationId')).toEqual([
    `${FIXTURE_IDS.namespace}:operation.master_update`,
  ]);
  expect(params.getAll('intent')).toEqual([]);
  // Order still matters for last-value-wins, so the leading shape is kept as a
  // separate, weaker statement rather than as the selector check.
  expect(entries.map(([key]) => key).slice(0, 4)).toEqual([
    'operationId',
    'idempotencyKey',
    'recordId',
    'expectedRevision',
  ]);
  // One primary entry per field, no shadowing sibling. The raw carrier remains
  // URL-encoded strings; typed booleans are deliberately not representable here.
  expect(valueEntries.length).toBe(
    new Set(valueEntries.map(([key]) => key)).size,
  );
  for (const [fieldId, value] of Object.entries(SEEDED)) {
    expect(
      valueEntries.find(([key]) => key === `value:${fieldId}`),
      fieldId,
    ).toEqual([`value:${fieldId}`, value]);
  }
  expect(params.get(`value:${EVERY_KIND_FIELD_IDS.active}`)).toBe('true');
  expect(params.get(`value:${EVERY_KIND_FIELD_IDS.weight}`)).toBe('');
  expect(params.get(`empty:${EVERY_KIND_FIELD_IDS.weight}`)).toBe('nothing');
  expect(fieldKindExecutor.providerVerdicts.at(-1)).toEqual({
    accepted: true,
    code: null,
    stage: 'operation-input',
    subjectId: null,
  });
  await expect(page.getByRole('status')).toContainText('Update complete');

  const stored = fieldKindExecutor.readRecord(recordId);
  assert.ok(stored);
  assert.equal(stored.values[EVERY_KIND_FIELD_IDS.active], true);
  assert.equal(
    Object.hasOwn(stored.values, EVERY_KIND_FIELD_IDS.weight),
    false,
  );
});

test('a create sets a boolean and omits a blank optional date', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${fieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
  );
  await page.getByLabel('Name', { exact: true }).fill('Boolean and blank date');
  await page.getByLabel('Number', { exact: true }).fill('WIRE-001');
  await page
    .locator(`[name="value:${EVERY_KIND_FIELD_IDS.active}"]`)
    .selectOption('true');
  const posted = capturePost(page);
  const before = fieldKindExecutor.providerVerdicts.length;
  await page.getByRole('button', { name: 'Save' }).click();

  const params = new URLSearchParams(await posted);
  expect(params.get(`value:${EVERY_KIND_FIELD_IDS.active}`)).toBe('true');
  expect(params.get(`value:${EVERY_KIND_FIELD_IDS.due}`)).toBe('');
  expect(params.get(`empty:${EVERY_KIND_FIELD_IDS.due}`)).toBe('nothing');
  expect(fieldKindExecutor.providerVerdicts.slice(before)).toEqual([
    {
      accepted: true,
      code: null,
      stage: 'operation-input',
      subjectId: null,
    },
  ]);
  await expect(page.getByRole('status')).toContainText('Create complete');

  const stored = fieldKindExecutor.readRecord(String(params.get('recordId')));
  assert.ok(stored);
  assert.equal(stored.values[EVERY_KIND_FIELD_IDS.active], true);
  assert.equal(Object.hasOwn(stored.values, EVERY_KIND_FIELD_IDS.due), false);
});

test('the adopted profile-v1 bare form converts a boolean and omits a blank date', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${adoptedFieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
  );
  await page.getByLabel('Name', { exact: true }).fill('Adopted profile wire');
  await page.getByLabel('Number', { exact: true }).fill('WIRE-V1-001');
  const active = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.active}"]`);
  const due = page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.due}"]`);
  await expect(active).toHaveJSProperty('type', 'text');
  await expect(due).toHaveJSProperty('type', 'text');
  await active.fill('true');
  await expect(
    page.locator(`[name="empty:${EVERY_KIND_FIELD_IDS.due}"]`),
  ).toHaveValue('nothing');

  const posted = capturePost(page);
  const before = adoptedFieldKindExecutor.providerVerdicts.length;
  await page.getByRole('button', { name: 'Save' }).click();
  const params = new URLSearchParams(await posted);

  expect(params.get(`value:${EVERY_KIND_FIELD_IDS.active}`)).toBe('true');
  expect(params.get(`value:${EVERY_KIND_FIELD_IDS.due}`)).toBe('');
  expect(params.get(`empty:${EVERY_KIND_FIELD_IDS.due}`)).toBe('nothing');
  expect(adoptedFieldKindExecutor.providerVerdicts.slice(before)).toEqual([
    {
      accepted: true,
      code: null,
      stage: 'operation-input',
      subjectId: null,
    },
  ]);
  await expect(page.getByRole('status')).toContainText('Create complete');

  const stored = adoptedFieldKindExecutor.readRecord(
    String(params.get('recordId')),
  );
  assert.ok(stored);
  assert.equal(stored.values[EVERY_KIND_FIELD_IDS.active], true);
  assert.equal(Object.hasOwn(stored.values, EVERY_KIND_FIELD_IDS.due), false);
});

for (const profile of [
  {
    label: 'adopted profile v1',
    runtime: () => ({
      executor: adoptedFieldKindExecutor,
      url: adoptedFieldKindUrl,
    }),
  },
  {
    label: 'explicit profile v2',
    runtime: () => ({ executor: fieldKindExecutor, url: fieldKindUrl }),
  },
] as const) {
  test(`multiline text survives an unrelated edit (${profile.label})`, async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const { executor: profileExecutor, url } = profile.runtime();
    const notesId = FIXTURE_IDS.fieldIds.parentNotes;

    const updateOptionalNotes = async (
      storedNotes: ImmutableJsonValue,
      changedName: string,
      unavailable: boolean,
    ): Promise<void> => {
      const recordId = profileExecutor.seedTypedValues({
        [FIXTURE_IDS.fieldIds.parentName]: 'Before text preservation',
        [FIXTURE_IDS.fieldIds.parentNumber]: 'TEXT-PRESERVE-001',
        [notesId]: storedNotes,
      });
      await page.goto(fieldKindFormUrl(url, recordId));

      const control = page.locator(`[name="value:${notesId}"]`);
      const disclosure = page.locator(
        `[data-unavailable-value-for="${notesId}"]`,
      );
      if (unavailable) {
        await expect(control).toHaveValue('');
        await expect(disclosure).toContainText(JSON.stringify(storedNotes));
        assert.equal(
          await control.getAttribute('aria-describedby'),
          await disclosure.getAttribute('id'),
        );
      } else {
        await expect(control).toHaveValue(String(storedNotes));
        await expect(disclosure).toHaveCount(0);
      }
      await expect(page.locator(`[name="empty:${notesId}"]`)).toHaveValue(
        'nothing',
      );

      await page.getByLabel('Name', { exact: true }).fill(changedName);
      const posted = capturePost(page);
      const before = profileExecutor.providerVerdicts.length;
      await page.getByRole('button', { name: 'Save' }).click();
      const params = new URLSearchParams(await posted);
      expect(params.get(`value:${notesId}`)).toBe(
        unavailable ? '' : String(storedNotes),
      );
      expect(params.get(`empty:${notesId}`)).toBe('nothing');
      expect(profileExecutor.providerVerdicts.slice(before)).toEqual([
        {
          accepted: true,
          code: null,
          stage: 'operation-input',
          subjectId: null,
        },
      ]);
      await expect(page.getByRole('status')).toContainText('Update complete');

      const stored = profileExecutor.readRecord(recordId);
      assert.ok(stored);
      assert.equal(stored.values[FIXTURE_IDS.fieldIds.parentName], changedName);
      assert.equal(stored.values[notesId], storedNotes);
    };

    const multiline = 'Call buyer\nConfirm purchase order';
    // One-property admission neighbour: only the newline becomes a space.
    await updateOptionalNotes(multiline, 'After multiline preservation', true);
    await updateOptionalNotes(
      multiline.replace('\n', ' '),
      'After one-line admission',
      false,
    );
    // A historical non-string must not become the string produced by the
    // renderer; its same-spelling string neighbour remains displayable.
    await updateOptionalNotes(17, 'After non-string preservation', true);
    await updateOptionalNotes('17', 'After string admission', false);

    // Required empty text is ordinarily a real value, so an unavailable stored
    // value needs an explicit `nothing` marker as well. Otherwise rendering it
    // blank would silently replace it with "" on the unrelated update.
    const requiredRecordId = profileExecutor.seedTypedValues({
      [FIXTURE_IDS.fieldIds.parentName]: multiline,
      [FIXTURE_IDS.fieldIds.parentNumber]: 'BEFORE-REQUIRED-TEXT',
    });
    await page.goto(fieldKindFormUrl(url, requiredRecordId));
    const requiredName = page.locator(
      `[name="value:${FIXTURE_IDS.fieldIds.parentName}"]`,
    );
    await expect(requiredName).toHaveValue('');
    await expect(
      page.locator(
        `[data-unavailable-value-for="${FIXTURE_IDS.fieldIds.parentName}"]`,
      ),
    ).toContainText(JSON.stringify(multiline));
    await expect(
      page.locator(`[name="empty:${FIXTURE_IDS.fieldIds.parentName}"]`),
    ).toHaveValue('nothing');
    await page
      .getByLabel('Number', { exact: true })
      .fill('AFTER-REQUIRED-TEXT');
    const requiredPosted = capturePost(page);
    const requiredBefore = profileExecutor.providerVerdicts.length;
    await page.getByRole('button', { name: 'Save' }).click();
    const requiredParams = new URLSearchParams(await requiredPosted);
    expect(requiredParams.get(`value:${FIXTURE_IDS.fieldIds.parentName}`)).toBe(
      '',
    );
    expect(requiredParams.get(`empty:${FIXTURE_IDS.fieldIds.parentName}`)).toBe(
      'nothing',
    );
    expect(profileExecutor.providerVerdicts.slice(requiredBefore)).toEqual([
      {
        accepted: true,
        code: null,
        stage: 'operation-input',
        subjectId: null,
      },
    ]);
    const requiredStored = profileExecutor.readRecord(requiredRecordId);
    assert.ok(requiredStored);
    assert.equal(
      requiredStored.values[FIXTURE_IDS.fieldIds.parentName],
      multiline,
    );
    assert.equal(
      requiredStored.values[FIXTURE_IDS.fieldIds.parentNumber],
      'AFTER-REQUIRED-TEXT',
    );

    const replacementRecordId = profileExecutor.seedTypedValues({
      [FIXTURE_IDS.fieldIds.parentName]: multiline,
      [FIXTURE_IDS.fieldIds.parentNumber]: 'REPLACE-REQUIRED-TEXT',
    });
    await page.goto(fieldKindFormUrl(url, replacementRecordId));
    await page
      .locator(`[name="value:${FIXTURE_IDS.fieldIds.parentName}"]`)
      .fill('Valid replacement');
    const replacementPosted = capturePost(page);
    const replacementBefore = profileExecutor.providerVerdicts.length;
    await page.getByRole('button', { name: 'Save' }).click();
    const replacementParams = new URLSearchParams(await replacementPosted);
    expect(
      replacementParams.get(`value:${FIXTURE_IDS.fieldIds.parentName}`),
    ).toBe('Valid replacement');
    expect(
      replacementParams.get(`empty:${FIXTURE_IDS.fieldIds.parentName}`),
    ).toBe('nothing');
    expect(profileExecutor.providerVerdicts.slice(replacementBefore)).toEqual([
      {
        accepted: true,
        code: null,
        stage: 'operation-input',
        subjectId: null,
      },
    ]);
    assert.equal(
      profileExecutor.readRecord(replacementRecordId)?.values[
        FIXTURE_IDS.fieldIds.parentName
      ],
      'Valid replacement',
    );
  });

  test(`required unavailable text can be replaced with empty text (${profile.label})`, async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const { executor: profileExecutor, url } = profile.runtime();
    const nameId = FIXTURE_IDS.fieldIds.parentName;
    const numberId = FIXTURE_IDS.fieldIds.parentNumber;
    const recordId = profileExecutor.seedTypedValues({
      [nameId]: 'Call buyer\nConfirm purchase order',
      [numberId]: 'BEFORE-EMPTY-TEXT',
    });
    const surfaceUrl = fieldKindFormUrl(url, recordId);
    await page.goto(surfaceUrl);

    const emptyIntent = page.locator(`[name="empty:${nameId}"]`);
    await expect(emptyIntent).toHaveValue('nothing');
    expect(
      await emptyIntent.locator('option').evaluateAll((options) =>
        options.map((option) => ({
          text: option.textContent?.trim() ?? '',
          value: (option as HTMLOptionElement).value,
        })),
      ),
    ).toEqual([
      { text: 'Leave unchanged', value: 'nothing' },
      { text: 'Save an empty text value', value: 'emptyText' },
    ]);

    const renderedForm = await readRenderedForm(page);
    const original = profileExecutor.readRecord(recordId);
    assert.ok(original);
    const refuse = async (
      mutate: (form: Record<string, string>) => void,
    ): Promise<void> => {
      const form = {
        ...renderedForm,
        idempotencyKey: randomUUID(),
        [`value:${numberId}`]: 'AFTER-REFUSED-SUBMISSION',
      };
      mutate(form);
      const beforeRefusal = profileExecutor.providerVerdicts.length;
      const response = await page.request.post(surfaceUrl, {
        form,
        headers: { authorization: 'fixture-user' },
      });
      assert.equal(response.status(), 422);
      assert.match(await response.text(), /OPERATION_INPUT_INVALID/);
      assert.equal(profileExecutor.providerVerdicts.length, beforeRefusal);
      const stored = profileExecutor.readRecord(recordId);
      assert.ok(stored);
      assert.equal(stored.revision, original.revision);
      assert.deepEqual(stored.values, original.values);
    };

    // The native form is otherwise unchanged. The first three vary one posted
    // property; the fourth removes the whole required-text subject, which is
    // the subject-absence vacuity vector rather than two independent faults.
    await refuse((form) => delete form[`empty:${nameId}`]);
    await refuse((form) => {
      form[`empty:${nameId}`] = 'clear';
    });
    await refuse((form) => delete form[`value:${nameId}`]);
    await refuse((form) => {
      delete form[`value:${nameId}`];
      delete form[`empty:${nameId}`];
    });

    await emptyIntent.selectOption({ label: 'Save an empty text value' });
    await page.locator(`[name="value:${numberId}"]`).fill('AFTER-EMPTY-TEXT');

    const posted = capturePost(page);
    const before = profileExecutor.providerVerdicts.length;
    await page.getByRole('button', { name: 'Save' }).click();
    const params = new URLSearchParams(await posted);
    expect(params.get(`value:${nameId}`)).toBe('');
    expect(params.get(`empty:${nameId}`)).toBe('emptyText');
    expect(profileExecutor.providerVerdicts.slice(before)).toEqual([
      {
        accepted: true,
        code: null,
        stage: 'operation-input',
        subjectId: null,
      },
    ]);
    await expect(page.getByRole('status')).toContainText('Update complete');

    const stored = profileExecutor.readRecord(recordId);
    assert.ok(stored);
    assert.equal(stored.values[nameId], '');
    assert.equal(stored.values[numberId], 'AFTER-EMPTY-TEXT');
  });

  test(`representable required text remains intentionally blankable (${profile.label})`, async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const { executor: profileExecutor, url } = profile.runtime();
    const nameId = FIXTURE_IDS.fieldIds.parentName;
    const numberId = FIXTURE_IDS.fieldIds.parentNumber;
    const recordId = profileExecutor.seedTypedValues({
      [nameId]: 'Representable required text',
      [numberId]: 'BEFORE-REPRESENTABLE-EMPTY',
    });
    await page.goto(fieldKindFormUrl(url, recordId));

    const emptyIntent = page.locator(`[name="empty:${nameId}"]`);
    await expect(emptyIntent).toHaveValue('emptyText');
    expect(
      await emptyIntent.locator('option').evaluateAll((options) =>
        options.map((option) => ({
          text: option.textContent?.trim() ?? '',
          value: (option as HTMLOptionElement).value,
        })),
      ),
    ).toEqual([
      { text: 'Leave unchanged', value: 'nothing' },
      { text: 'Save an empty text value', value: 'emptyText' },
    ]);
    await page.locator(`[name="value:${nameId}"]`).fill('');
    await page.locator(`[name="value:${numberId}"]`).fill('AFTER-EMPTY');

    const posted = capturePost(page);
    const before = profileExecutor.providerVerdicts.length;
    await page.getByRole('button', { name: 'Save' }).click();
    const params = new URLSearchParams(await posted);
    expect(params.get(`value:${nameId}`)).toBe('');
    expect(params.get(`empty:${nameId}`)).toBe('emptyText');
    expect(profileExecutor.providerVerdicts.slice(before)).toEqual([
      {
        accepted: true,
        code: null,
        stage: 'operation-input',
        subjectId: null,
      },
    ]);
    const stored = profileExecutor.readRecord(recordId);
    assert.ok(stored);
    assert.equal(stored.values[nameId], '');
    assert.equal(stored.values[numberId], 'AFTER-EMPTY');
  });

  test(`required text remains real empty text on create (${profile.label})`, async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const { executor: profileExecutor, url } = profile.runtime();
    const nameId = FIXTURE_IDS.fieldIds.parentName;
    const numberId = FIXTURE_IDS.fieldIds.parentNumber;
    await page.goto(
      `${url}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
    );

    await expect(page.locator(`[name="value:${nameId}"]`)).toHaveValue('');
    await expect(page.locator(`[name="empty:${nameId}"]`)).toHaveCount(0);
    await page.locator(`[name="value:${numberId}"]`).fill('CREATE-EMPTY-TEXT');

    const renderedForm = await readRenderedForm(page);
    const refusedRecordId = String(renderedForm.recordId);
    const beforeRefusal = profileExecutor.providerVerdicts.length;
    const refused = await page.request.post(
      `${url}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
      {
        form: {
          ...renderedForm,
          [`empty:${nameId}`]: 'emptyText',
          idempotencyKey: randomUUID(),
        },
        headers: { authorization: 'fixture-user' },
      },
    );
    assert.equal(refused.status(), 422);
    assert.match(await refused.text(), /OPERATION_INPUT_INVALID/);
    assert.equal(profileExecutor.providerVerdicts.length, beforeRefusal);
    assert.equal(profileExecutor.readRecord(refusedRecordId), null);

    const posted = capturePost(page);
    const before = profileExecutor.providerVerdicts.length;
    await page.getByRole('button', { name: 'Save' }).click();
    const params = new URLSearchParams(await posted);
    expect(params.get(`value:${nameId}`)).toBe('');
    expect(params.getAll(`empty:${nameId}`)).toEqual([]);
    expect(profileExecutor.providerVerdicts.slice(before)).toEqual([
      {
        accepted: true,
        code: null,
        stage: 'operation-input',
        subjectId: null,
      },
    ]);
    await expect(page.getByRole('status')).toContainText('Create complete');

    const stored = profileExecutor.readRecord(String(params.get('recordId')));
    assert.ok(stored);
    assert.equal(stored.values[nameId], '');
    assert.equal(stored.values[numberId], 'CREATE-EMPTY-TEXT');
  });
}

test('an unrelated edit preserves both stored null and absent optional values', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const recordId = fieldKindExecutor.seedTypedValues({
    [EVERY_KIND_FIELD_IDS.active]: null,
    [FIXTURE_IDS.fieldIds.parentName]: 'Before unrelated edit',
  });
  await page.goto(formUrl(recordId));
  await page.getByLabel('Name', { exact: true }).fill('After unrelated edit');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');

  const stored = fieldKindExecutor.readRecord(recordId);
  assert.ok(stored);
  assert.equal(
    stored.values[FIXTURE_IDS.fieldIds.parentName],
    'After unrelated edit',
  );
  assert.equal(stored.values[EVERY_KIND_FIELD_IDS.active], null);
  assert.equal(Object.hasOwn(stored.values, EVERY_KIND_FIELD_IDS.due), false);
});

test('typed controls preserve and disclose every stored value they cannot display', async ({
  page,
}) => {
  const unavailable = {
    [EVERY_KIND_FIELD_IDS.active]: 'legacy-boolean',
    [EVERY_KIND_FIELD_IDS.count]: 'not-a-number',
    [EVERY_KIND_FIELD_IDS.due]: '2026-02-30',
    [EVERY_KIND_FIELD_IDS.grade]: `${FIXTURE_IDS.namespace}:option.grade_retired`,
    [EVERY_KIND_FIELD_IDS.preciseTime]: '25:00:00',
  } as const;
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const recordId = fieldKindExecutor.seedTypedValues({
    [FIXTURE_IDS.fieldIds.parentName]: 'Before unavailable preservation',
    [FIXTURE_IDS.fieldIds.parentNumber]: 'UNAVAILABLE-001',
    ...unavailable,
  });
  await page.goto(formUrl(recordId));

  for (const [fieldId, value] of Object.entries(unavailable)) {
    const control = page.locator(`[name="value:${fieldId}"]`);
    const emptyIntent = page.locator(`[name="empty:${fieldId}"]`);
    await expect(control, fieldId).toHaveValue('');
    await expect(emptyIntent, fieldId).toHaveValue('nothing');
    expect(
      await emptyIntent
        .locator('option')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        ),
      fieldId,
    ).toEqual(['nothing', 'clear']);
    const disclosure = page.locator(
      `[data-unavailable-value-for="${fieldId}"]`,
    );
    await expect(disclosure, fieldId).toContainText(JSON.stringify(value));
    assert.equal(
      await control.getAttribute('aria-describedby'),
      await disclosure.getAttribute('id'),
      fieldId,
    );
  }

  await page
    .getByLabel('Name', { exact: true })
    .fill('After unavailable preservation');
  const posted = capturePost(page);
  const before = fieldKindExecutor.providerVerdicts.length;
  await page.getByRole('button', { name: 'Save' }).click();
  const params = new URLSearchParams(await posted);

  for (const fieldId of Object.keys(unavailable)) {
    expect(params.get(`value:${fieldId}`), fieldId).toBe('');
    expect(params.get(`empty:${fieldId}`), fieldId).toBe('nothing');
  }
  expect(fieldKindExecutor.providerVerdicts.slice(before)).toEqual([
    {
      accepted: true,
      code: null,
      stage: 'operation-input',
      subjectId: null,
    },
  ]);
  await expect(page.getByRole('status')).toContainText('Update complete');

  const stored = fieldKindExecutor.readRecord(recordId);
  assert.ok(stored);
  assert.equal(
    stored.values[FIXTURE_IDS.fieldIds.parentName],
    'After unavailable preservation',
  );
  for (const [fieldId, value] of Object.entries(unavailable)) {
    assert.equal(stored.values[fieldId], value, fieldId);
  }
});

test('blank plus explicit clear sends null while blank text can remain a real value', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const recordId = fieldKindExecutor.seedTypedValues({
    [EVERY_KIND_FIELD_IDS.due]: '2026-08-09',
    [FIXTURE_IDS.fieldIds.parentName]: 'Clear and empty text',
  });
  await page.goto(formUrl(recordId));
  await page.locator(`[name="value:${EVERY_KIND_FIELD_IDS.due}"]`).fill('');
  await page
    .locator(`[name="empty:${EVERY_KIND_FIELD_IDS.due}"]`)
    .selectOption('clear');
  await page
    .locator(`[name="empty:${FIXTURE_IDS.fieldIds.parentNotes}"]`)
    .selectOption('emptyText');
  await page
    .locator(`[name="value:${FIXTURE_IDS.fieldIds.parentNotes}"]`)
    .fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');

  const stored = fieldKindExecutor.readRecord(recordId);
  assert.ok(stored);
  assert.equal(stored.values[EVERY_KIND_FIELD_IDS.due], null);
  assert.equal(stored.values[FIXTURE_IDS.fieldIds.parentNotes], '');
});

/**
 * The boolean's three states, end to end. A checkbox cannot express them, and
 * the first cut's hidden `value="false"` sibling made an unrelated edit rewrite
 * a stored `null` to `false` -- upstream of anywhere `U7` could recover it.
 */
test('an optional boolean renders and submits three states, with absent and null identical', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const control = `[name="value:${EVERY_KIND_FIELD_IDS.active}"]`;
  for (const [seeded, expectedIdl] of [
    [undefined, ''],
    [null, ''],
    [false, 'false'],
    [true, 'true'],
  ] as const) {
    const recordId = fieldKindExecutor.seedTypedValues(
      seeded === undefined ? {} : { [EVERY_KIND_FIELD_IDS.active]: seeded },
    );
    await page.goto(
      `${fieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}&record=${encodeURIComponent(recordId)}`,
    );
    await expect(page.locator(control)).toHaveJSProperty('value', expectedIdl);
    // No checkbox and no hidden sibling: nothing can post a value the record
    // did not have.
    await expect(page.locator(`input[type="checkbox"]${control}`)).toHaveCount(
      0,
    );
    await expect(page.locator(`input[type="hidden"]${control}`)).toHaveCount(0);
  }

  // SUBMISSION, all four stored states. The blank primary value is paired with a
  // closed intent: `nothing` preserves either null or absence, while a non-empty
  // primary value is a real set. No hidden default can rewrite null to false.
  const submitted = async (
    seeded: boolean | null | undefined,
    choose: string | null,
  ): Promise<{
    readonly emptyIntent: readonly string[];
    readonly stored: ImmutableJsonValue | undefined;
    readonly value: readonly string[];
  }> => {
    const recordId = fieldKindExecutor.seedTypedValues(
      seeded === undefined ? {} : { [EVERY_KIND_FIELD_IDS.active]: seeded },
    );
    await page.goto(formUrl(recordId));
    if (choose !== null) await page.locator(control).selectOption(choose);
    const posted = capturePost(page);
    await page.getByRole('button', { name: 'Save' }).click();
    const params = new URLSearchParams(await posted);
    return {
      emptyIntent: params.getAll(`empty:${EVERY_KIND_FIELD_IDS.active}`),
      stored:
        fieldKindExecutor.readRecord(recordId)?.values[
          EVERY_KIND_FIELD_IDS.active
        ],
      value: params.getAll(`value:${EVERY_KIND_FIELD_IDS.active}`),
    };
  };

  // Exactly one entry each time -- no hidden sibling shadowing the control.
  expect(await submitted(undefined, null)).toEqual({
    emptyIntent: ['nothing'],
    stored: undefined,
    value: [''],
  });
  expect(await submitted(null, null)).toEqual({
    emptyIntent: ['nothing'],
    stored: null,
    value: [''],
  });
  expect(await submitted(false, null)).toEqual({
    emptyIntent: ['nothing'],
    stored: false,
    value: ['false'],
  });
  expect(await submitted(true, null)).toEqual({
    emptyIntent: ['nothing'],
    stored: true,
    value: ['true'],
  });
  // And turning one off submits `false` rather than omitting the field, which is
  // what a checkbox could not express.
  expect(await submitted(true, 'false')).toEqual({
    emptyIntent: ['nothing'],
    stored: false,
    value: ['false'],
  });
});

test('malformed boolean and empty intent are refused beside admitted twins', async ({
  page,
}) => {
  const recordId = fieldKindExecutor.seedTypedValues({});
  const surfaceUrl = formUrl(recordId);
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(surfaceUrl);
  const renderedForm = (await page
    .locator('#surface-record-form')
    .evaluate((form: HTMLFormElement) =>
      Object.fromEntries(
        [...new FormData(form).entries()].map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    )) as Record<string, string>;
  const post = (
    overrides: Record<string, string>,
    omitted: readonly string[] = [],
  ) => {
    const form: Record<string, string> = {
      ...renderedForm,
      idempotencyKey: randomUUID(),
      ...overrides,
    };
    for (const key of omitted) delete form[key];
    return page.request.post(surfaceUrl, {
      form,
      headers: { authorization: 'fixture-user' },
    });
  };

  const beforeMalformedBoolean = fieldKindExecutor.providerVerdicts.length;
  const malformedBoolean = await post({
    [`empty:${EVERY_KIND_FIELD_IDS.active}`]: 'clear',
    expectedRevision: '1',
    [`value:${EVERY_KIND_FIELD_IDS.active}`]: 'yes',
  });
  assert.equal(malformedBoolean.status(), 422);
  assert.match(await malformedBoolean.text(), /OPERATION_INPUT_INVALID/);
  assert.equal(
    fieldKindExecutor.providerVerdicts.length,
    beforeMalformedBoolean,
  );
  assert.equal(
    Object.hasOwn(
      fieldKindExecutor.readRecord(recordId)?.values ?? {},
      EVERY_KIND_FIELD_IDS.active,
    ),
    false,
  );

  const admittedBoolean = await post({
    [`empty:${EVERY_KIND_FIELD_IDS.active}`]: 'clear',
    expectedRevision: '1',
    [`value:${EVERY_KIND_FIELD_IDS.active}`]: 'false',
  });
  assert.equal(admittedBoolean.status(), 200);
  assert.equal(
    fieldKindExecutor.readRecord(recordId)?.values[EVERY_KIND_FIELD_IDS.active],
    false,
  );

  const verdictCount = fieldKindExecutor.providerVerdicts.length;
  const malformedIntent = await post({
    [`empty:${EVERY_KIND_FIELD_IDS.due}`]: 'mystery',
    expectedRevision: '2',
    [`value:${EVERY_KIND_FIELD_IDS.due}`]: '',
  });
  assert.equal(malformedIntent.status(), 422);
  assert.match(await malformedIntent.text(), /OPERATION_INPUT_INVALID/);
  assert.equal(fieldKindExecutor.providerVerdicts.length, verdictCount);

  const missingIntent = await post(
    {
      expectedRevision: '2',
      [`value:${EVERY_KIND_FIELD_IDS.due}`]: '',
    },
    [`empty:${EVERY_KIND_FIELD_IDS.due}`],
  );
  assert.equal(missingIntent.status(), 422);
  assert.match(await missingIntent.text(), /OPERATION_INPUT_INVALID/);
  assert.equal(fieldKindExecutor.providerVerdicts.length, verdictCount);

  const absentField = await post({ expectedRevision: '2' }, [
    `empty:${EVERY_KIND_FIELD_IDS.due}`,
    `value:${EVERY_KIND_FIELD_IDS.due}`,
  ]);
  assert.equal(absentField.status(), 422);
  assert.match(await absentField.text(), /OPERATION_INPUT_INVALID/);
  assert.equal(fieldKindExecutor.providerVerdicts.length, verdictCount);

  const admittedNothing = await post({
    [`empty:${EVERY_KIND_FIELD_IDS.due}`]: 'nothing',
    expectedRevision: '2',
    [`value:${EVERY_KIND_FIELD_IDS.due}`]: '',
  });
  assert.equal(admittedNothing.status(), 200);
  assert.equal(
    Object.hasOwn(
      fieldKindExecutor.readRecord(recordId)?.values ?? {},
      EVERY_KIND_FIELD_IDS.due,
    ),
    false,
  );
});

/**
 * The absence twin in the browser. The pre-`ux-picker` render is still what a
 * reader of an unadopted-profile manifest gets, and it must stay a working text
 * box rather than a control the payload never described.
 */
test('a form with no compiled field kinds still renders working text boxes', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
  );
  const name = page.locator(
    `[name="value:${FIXTURE_IDS.fieldIds.parentName}"]`,
  );
  await expect(name).toHaveJSProperty('type', 'text');
  await name.fill('typed into a bare text box');
  await expect(name).toHaveValue('typed into a bare text box');
  await expect(page.locator('#surface-record-form select')).toHaveCount(0);
  await expect(page.locator('#surface-record-form datalist')).toHaveCount(0);
});

test('a provider refusal cannot be manufactured into browser success', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const surfaceUrl = `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`;
  await page.goto(surfaceUrl);
  const form = (await page
    .locator('#surface-record-form')
    .evaluate((element: HTMLFormElement) =>
      Object.fromEntries(
        [...new FormData(element).entries()].map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    )) as Record<string, string>;
  form[`value:${FIXTURE_IDS.fieldIds.parentName}`] = 'Refused create';
  delete form[`value:${FIXTURE_IDS.fieldIds.parentNumber}`];
  const recordId = form.recordId;
  assert.ok(recordId);
  const before = executor.providerVerdicts.length;

  const response = await page.request.post(surfaceUrl, {
    form,
    headers: { authorization: 'fixture-user' },
  });

  assert.equal(response.status(), 422);
  const refusalHtml = await response.text();
  assert.doesNotMatch(refusalHtml, /Create complete/);
  await page.setContent(refusalHtml);
  await expectCompleteMessage(page, {
    code: 'OPERATION_REFUSED',
    fullText:
      'APPLICATION DIAGNOSTIC Operation refused The provider refused this operation for a reason this application cannot yet present in plain language. Give the refusal code to an administrator before trying this operation again. MODULE_REQUIRED_FIELD_MISSINGOPERATION_REFUSED',
    subject: 'MODULE_REQUIRED_FIELD_MISSING',
  });
  assert.deepEqual(executor.providerVerdicts.slice(before), [
    {
      accepted: false,
      code: 'MODULE_REQUIRED_FIELD_MISSING',
      stage: 'operation-input',
      subjectId: FIXTURE_IDS.fieldIds.parentNumber,
    },
  ]);
  assert.equal(executor.readRecord(recordId), null);
});

test('fixture list and form render live DTOs and reflect a semantic create', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('master');
  await expect(
    page.getByRole('cell', { name: 'Existing live master', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-data-state="exact"]')).toBeVisible();

  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New master' }),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Browser-created master');
  await page.getByLabel('Number', { exact: true }).fill('BROWSER-001');
  const before = executor.providerVerdicts.length;
  await page.getByRole('button', { name: 'Save' }).click();

  expect(executor.providerVerdicts.slice(before)).toEqual([
    {
      accepted: true,
      code: null,
      stage: 'operation-input',
      subjectId: null,
    },
  ]);
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.getByRole('status')).toContainText(
    'trust evidence is linked',
  );
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Browser-created master',
  );

  await page
    .getByRole('navigation', { name: 'Release navigation' })
    .getByRole('link', { name: 'master', exact: true })
    .click();
  await expect(
    page.getByRole('cell', { name: 'Browser-created master', exact: true }),
  ).toBeVisible();
  const createdRow = page.locator('tr', { hasText: 'Browser-created master' });
  const createdRecordId = await createdRow.getAttribute('data-record-id');
  assert.ok(createdRecordId);
  await createdRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Browser-created master' }),
  ).toBeVisible();
  const overflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  const archive = page.getByRole('button', { name: 'Archive' });
  await expect(overflow).toBeVisible();
  await expect(archive).toBeHidden();
  await overflow.locator('summary').click();
  await expect(archive).toBeVisible();
  await expect(page.locator('body')).not.toContainText('north_star_module');
  await expect(page.locator('body')).not.toContainText('storageClass');
});

test('compiler-valid one-slot Record surfaces do not synthesize mutation controls', async ({
  page,
}) => {
  const compiled = compileFixture(false);
  const policy = allowPolicy();
  const executor = new BrowserFixtureExecutor(null);
  const operationMediation = new SemanticOperationMediationAuthority();
  const legacyServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        executor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, executor),
    },
  );
  const legacyBaseUrl = await listen(legacyServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    await page.goto(
      `${legacyBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
    );
    await expect(
      page.locator('[data-platform-slot="record:commandBar"]'),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

    const recordId = executor.createSeed('Legacy one-slot master');

    await page
      .getByRole('navigation', { name: 'Release navigation' })
      .getByRole('link', { name: 'master', exact: true })
      .click();
    await page.goto(
      `${legacyBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(recordId)}`,
    );
    await expect(
      page.locator('[data-platform-slot="record:keyFacts"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-platform-slot="record:commandBar"]'),
    ).toHaveCount(0);

    const overflow = page.locator('details.action-overflow');
    const archive = page.getByRole('button', { name: 'Archive' });
    await expect(overflow).toBeVisible();
    await expect(archive).toBeHidden();
    await overflow.locator('summary').click();
    await expect(archive).toBeVisible();
    await archive.click();
    await page.getByRole('button', { name: 'Confirm Archive' }).click();
    await expect(page.getByRole('status')).toContainText('Archive complete');
    await expect(page.getByText('Archived · revision 2')).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) => {
      legacyServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('a failed data slot stays inline while ready siblings render without JavaScript', async ({
  browser,
}) => {
  const compiled = compileFixture();
  const policy = allowPolicy();
  const failingExecutor = new BrowserFixtureExecutor(
    `${FIXTURE_IDS.namespace}:query.master_get`,
  );
  const operationMediation = new SemanticOperationMediationAuthority();
  const failingServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        failingExecutor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, failingExecutor),
    },
  );
  const failingBaseUrl = await listen(failingServer);
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: 'fixture-user' },
    javaScriptEnabled: false,
  });

  try {
    const page = await context.newPage();
    const response = await page.goto(
      `${failingBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(randomUUID())}`,
    );
    expect(response?.status()).toBe(200);

    const failedSlot = page.locator(
      '[data-platform-slot="record:keyFacts"][data-slot-state="failed"]',
    );
    await expect(failedSlot.getByRole('alert')).toContainText(
      'QUERY_UNAVAILABLE',
    );
    await expect(failedSlot.getByRole('alert')).toHaveAttribute(
      'data-status-role',
      'blocked',
    );
    await expect(
      page.locator(
        '[data-platform-slot="record:breadcrumb"][data-slot-state="ready"]',
      ),
    ).toContainText('master');
    await expect(
      page.locator(
        '[data-platform-slot="record:titleStatus"][data-slot-state="ready"]',
      ),
    ).toContainText('master');
    await expect(
      page.locator(
        '[data-platform-slot="record:commandBar"][data-slot-state="ready"]',
      ),
    ).toContainText('New');
    await expect(page.locator('.standalone')).toHaveCount(0);
    await expectClosedSlotStates(page);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      failingServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('an empty data slot is observably distinct from a failed slot', async ({
  page,
}) => {
  const compiled = compileFixture();
  const policy = allowPolicy();
  const emptyExecutor = new BrowserFixtureExecutor(null);
  const operationMediation = new SemanticOperationMediationAuthority();
  const emptyServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        emptyExecutor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, emptyExecutor),
    },
  );
  const emptyBaseUrl = await listen(emptyServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    await page.goto(
      `${emptyBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
    );
    const emptySlot = page.locator(
      '[data-platform-slot="list:dataGrid"][data-slot-state="empty"]',
    );
    await expect(emptySlot.getByText('No records yet')).toBeVisible();
    await expect(emptySlot.getByRole('alert')).toHaveCount(0);
    await expect(
      page.locator('[data-platform-slot][data-slot-state="failed"]'),
    ).toHaveCount(0);
    await expectClosedSlotStates(page);
  } finally {
    await new Promise<void>((resolve, reject) => {
      emptyServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

for (const unsupportedSlot of ['activity', 'childTables'] as const) {
  test(`an unsupported ${unsupportedSlot} slot stays visible without vetoing a write`, async ({
    page,
  }) => {
    const compiled = compileFixture(
      true,
      false,
      undefined,
      false,
      unsupportedSlot,
    );
    const policy = allowPolicy();
    const slotExecutor = new BrowserFixtureExecutor(null);
    const operationMediation = new SemanticOperationMediationAuthority();
    const slotServer = createSurfaceRuntimeServer(
      runtimeEntry(compiled, policy),
      {
        operationGateway: new SemanticOperationGateway(
          policy,
          slotExecutor,
          operationMediation,
        ),
        operationMediation,
        queryGateway: new SemanticQueryGateway(policy, slotExecutor),
      },
    );
    const slotBaseUrl = await listen(slotServer);

    try {
      await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
      await page.goto(
        `${slotBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
      );
      const unsupported = page.locator(
        `[data-platform-slot="record:${unsupportedSlot}"][data-slot-state="failed"]`,
      );
      await expect(
        unsupported.locator('[data-message="UNSUPPORTED_COMPONENT"]'),
      ).toBeVisible();
      await expect(
        page.locator(
          '[data-platform-slot="record:sections"][data-slot-state="ready"]',
        ),
      ).toBeVisible();
      await expect(
        page.locator(
          '[data-platform-slot="record:commandBar"][data-slot-state="ready"]',
        ),
      ).toBeVisible();

      await page.getByLabel('Name', { exact: true }).fill('Slot-local refusal');
      await page.getByLabel('Number', { exact: true }).fill('SLOT-001');
      const before = slotExecutor.providerVerdicts.length;
      await page.getByRole('button', { name: 'Save' }).click();
      expect(slotExecutor.providerVerdicts.slice(before)).toEqual([
        {
          accepted: true,
          code: null,
          stage: 'operation-input',
          subjectId: null,
        },
      ]);
      await expect(page.getByRole('status')).toContainText('Create complete');
    } finally {
      await new Promise<void>((resolve, reject) => {
        slotServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

test('invalid binding, unsupported query, and unavailable runtime view remain distinct', async ({
  page,
}) => {
  const policy = allowPolicy();
  const operationMediation = new SemanticOperationMediationAuthority();
  const invalidExecutor = new BrowserFixtureExecutor(null);
  const invalidServer = createSurfaceRuntimeServer(
    runtimeEntry(compileFixture(true, true), policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        invalidExecutor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, invalidExecutor),
    },
  );
  const unsupportedExecutor = new BrowserFixtureExecutor(null, 'unsupported');
  const unsupportedRecordId = unsupportedExecutor.createSeed(
    'Unsupported query target',
  );
  const unsupportedServer = createSurfaceRuntimeServer(
    runtimeEntry(compileFixture(), policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        unsupportedExecutor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, unsupportedExecutor),
    },
  );
  const unavailableServer = createSurfaceRuntimeServer(
    new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => ({
        environmentId,
        principalId,
        tenantId,
      })),
      {
        async load(): Promise<never> {
          throw new Error('runtime view unavailable');
        },
      },
      policy,
    ),
  );
  const invalidUrl = await listen(invalidServer);
  const unsupportedUrl = await listen(unsupportedServer);
  const unavailableUrl = await listen(unavailableServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const invalidResponse = await page.goto(
      `${invalidUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
    );
    expect(invalidResponse?.status()).toBe(422);
    const invalidCode = await expectCompleteMessage(page, {
      code: 'INVALID_SURFACE_BINDING',
      fullText:
        'PINNED RELEASE DIAGNOSTIC Surface binding unreadable The selected surface does not have a valid pinned semantic binding. INVALID_SURFACE_BINDING Release d4000000…0004 · fence 1',
    });
    await expect(page.locator('[data-platform-slot]')).toHaveCount(0);

    const unsupportedResponse = await page.goto(
      `${unsupportedUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(unsupportedRecordId)}`,
    );
    expect(unsupportedResponse?.status()).toBe(200);
    const unsupportedCode = await expectCompleteMessage(page, {
      code: 'QUERY_UNSUPPORTED',
      fullText:
        '! RELEASE DIAGNOSTIC Capability unavailable The pinned release does not provide this semantic data capability. QUERY_UNSUPPORTED',
    });

    const unavailableResponse = await page.goto(unavailableUrl);
    expect(unavailableResponse?.status()).toBe(500);
    const unavailableCode = await expectCompleteMessage(page, {
      code: 'REQUEST_RUNTIME_VIEW_UNAVAILABLE',
      fullText:
        'APPLICATION DIAGNOSTIC Application shell unavailable The request could not construct its pinned runtime view. REQUEST_RUNTIME_VIEW_UNAVAILABLE',
    });

    expect(new Set([invalidCode, unsupportedCode, unavailableCode]).size).toBe(
      3,
    );
  } finally {
    for (const target of [
      invalidServer,
      unsupportedServer,
      unavailableServer,
    ]) {
      await new Promise<void>((resolve, reject) => {
        target.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

/**
 * Records which capability actually executed, and writes it into the record so
 * the answer is READ BACK FROM THE PAGE rather than asked of the test. A test
 * that only asserted "two buttons exist" would have passed against the
 * defect this closes: two controls that both invoke the same operation.
 */
/**
 * The packet's evidence: a RENDERED command bar with two operable controls,
 * each dispatching its own operation.
 *
 * The second assertion is the one that matters. Before this change
 * `submitSurfaceRuntimeIntent` resolved `intent -> the first operation
 * carrying it`, so two buttons both posting `intent=command` would both run
 * whichever sorted first. Counting controls would not have caught that; the
 * page has to say which one ran.
 */
test('a record command bar renders every granted command as its own operable control', async ({
  page,
}) => {
  const compiled = compileFixture(true, false, pushCommandOperations);
  const policy = allowPolicy();
  const executor = new BrowserFixtureExecutor(null);
  const recordId = executor.createSeed('Two-command master');
  const capabilityExecutors = COMMAND_ACTIONS.map(
    (action) =>
      new RecordingCapabilityExecutor(commandCapabilityId(action), executor),
  );
  const operationMediation = new SemanticOperationMediationAuthority();
  const commandServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        executor,
        operationMediation,
        undefined,
        capabilityExecutors,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, executor),
    },
  );
  const commandBaseUrl = await listen(commandServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    await page.goto(
      `${commandBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(recordId)}`,
    );

    const commandBar = page.locator(
      '[data-platform-slot="record:commandBar"] .command-bar',
    );
    await expect(commandBar).toBeVisible();
    const commands = commandBar.locator('form.capability-command');
    await expect(commands).toHaveCount(2);
    expect(await commands.getByRole('button').allTextContents()).toEqual([
      'Release',
      'Cancel',
    ]);

    // Operable, not merely present: two enabled submit controls carrying
    // distinct accessible names, each naming its own operation on the wire.
    const cancel = commandBar.locator(
      `form.capability-command[data-operation-id="${commandOperationId('cancel')}"]`,
    );
    const release = commandBar.locator(
      `form.capability-command[data-operation-id="${commandOperationId('release')}"]`,
    );
    await expect(cancel.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await expect(
      release.getByRole('button', { name: 'Release' }),
    ).toBeEnabled();
    await expect(cancel.locator('input[name="operationId"]')).toHaveValue(
      commandOperationId('cancel'),
    );
    await expect(release.locator('input[name="operationId"]')).toHaveValue(
      commandOperationId('release'),
    );

    // Press the SECOND control. Under the old dispatch this ran the first.
    await release.getByRole('button', { name: 'Release' }).click();
    await expect(page.getByRole('status')).toContainText('Release complete');
    await expect(
      page.locator('[data-platform-slot="record:keyFacts"]'),
    ).toContainText(`ran ${commandCapabilityId('release')}`);
    assert.deepEqual(
      capabilityExecutors.map((candidate) => candidate.executed),
      [[commandOperationId('release')], []],
    );

    // And the first control still reaches the first operation.
    await release.page().goBack();
    await commandBar
      .locator(
        `form.capability-command[data-operation-id="${commandOperationId('cancel')}"]`,
      )
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(page.getByRole('status')).toContainText('Cancel complete');
    assert.deepEqual(
      capabilityExecutors.map((candidate) => candidate.executed),
      [[commandOperationId('release')], [commandOperationId('cancel')]],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      commandServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

/**
 * The limit lifted for `command` and stayed for the other four, so both halves
 * are asserted. Without the second, "admit two commands" is satisfiable by
 * admitting everything -- which is the quiet permissiveness this packet was
 * told is worse than the limit.
 */
test('an intent rendered by one control still refuses a second operation by name', async ({
  page,
}) => {
  const compiled = compileFixture(true, false, pushDuplicateCreate);
  const policy = allowPolicy();
  const duplicateExecutor = new BrowserFixtureExecutor(null);
  const operationMediation = new SemanticOperationMediationAuthority();
  const duplicateServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        duplicateExecutor,
        operationMediation,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, duplicateExecutor),
    },
  );
  const duplicateBaseUrl = await listen(duplicateServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const response = await page.goto(
      `${duplicateBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}`,
    );
    expect(response?.status()).toBe(422);
    await expect(
      page.locator('[data-message="INVALID_SURFACE_BINDING"]'),
    ).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) => {
      duplicateServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

/**
 * The property the old dispatch got for free and this one must assert: the
 * compiled binding is still the sole authority for what is invocable. The wire
 * now SELECTS within that set; it may not add to it.
 */
test('a posted operation id outside the surface binding is refused', async ({
  page,
}) => {
  const compiled = compileFixture(true, false, pushCommandOperations);
  const policy = allowPolicy();
  const executor = new BrowserFixtureExecutor(null);
  const recordId = executor.createSeed('Binding authority master');
  const capabilityExecutors = COMMAND_ACTIONS.map(
    (action) =>
      new RecordingCapabilityExecutor(commandCapabilityId(action), executor),
  );
  const operationMediation = new SemanticOperationMediationAuthority();
  const authorityServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        executor,
        operationMediation,
        undefined,
        capabilityExecutors,
      ),
      operationMediation,
      queryGateway: new SemanticQueryGateway(policy, executor),
    },
  );
  const authorityBaseUrl = await listen(authorityServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const surfaceUrl = `${authorityBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}`;
    for (const operationId of [
      // Registered in the release, bound to the OTHER entity's surface.
      `${FIXTURE_IDS.namespace}:operation.master_role_update`,
      // Not registered at all.
      `${FIXTURE_IDS.namespace}:operation.master_forged`,
      // Absent entirely -- the old wire vocabulary is not a fallback.
      '',
    ]) {
      const refused = await page.request.post(surfaceUrl, {
        form: {
          expectedRevision: '1',
          idempotencyKey: randomUUID(),
          // Posted deliberately: the retired wire vocabulary must not be a
          // fallback that resurrects the old intent-keyed resolution.
          intent: 'command',
          operationId,
          recordId,
        },
        headers: { authorization: 'fixture-user' },
      });
      expect(refused.status()).toBe(422);
      expect(await refused.text()).toContain('OPERATION_UNSUPPORTED');
    }
    assert.deepEqual(
      capabilityExecutors.flatMap((candidate) => candidate.executed),
      [],
    );

    // The companion that makes the three refusals mean something. Without it
    // this test is satisfied by a surface that refuses EVERYTHING -- which is
    // exactly what the pre-change binding does with two commands bound, so the
    // refusals alone would pass against the defect.
    const accepted = await page.request.post(surfaceUrl, {
      form: {
        expectedRevision: '1',
        idempotencyKey: randomUUID(),
        operationId: commandOperationId('release'),
        recordId,
      },
      headers: { authorization: 'fixture-user' },
    });
    expect(accepted.status()).toBe(200);
    assert.deepEqual(
      capabilityExecutors.flatMap((candidate) => candidate.executed),
      [commandOperationId('release')],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      authorityServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

class RecordingCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly executed: string[] = [];

  constructor(
    readonly capabilityId: string,
    private readonly records: BrowserFixtureExecutor,
  ) {}

  prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ) {
    return Promise.resolve({
      decisionInput: request.input,
      legalEntityReadScopeIds: [],
      readBackArguments: request.input,
    });
  }

  async execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    this.executed.push(request.definition.operationId);
    const input = request.input as Readonly<Record<string, ImmutableJsonValue>>;
    const stored = this.records.stamp(
      String(input.recordId),
      this.capabilityId,
    );
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: stored,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
      unsupportedReason: null,
    };
  }
}

class BrowserFixtureExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  private readonly records = new Map<string, SemanticRecordDto>();

  /**
   * This double cannot report success after the real provider input parser
   * refuses. There is no ignore-refusal mode: adding one would make the two
   * states expressible again and recreate the false green this packet removes.
   */
  constructor(
    private readonly failedQueryId: string | null,
    private readonly forcedQueryOutcome: 'unsupported' | null = null,
  ) {}

  /**
   * What the REAL provider decided about each operation input it was handed.
   *
   * `parseMutationInput` is the first thing `PostgresModuleRuntimeInterpreter`
   * does on a mutation, before a connection is taken, and it is where every
   * compiled value contract is enforced. Calling it here makes "the provider
   * accepts this" an observation rather than a stub's opinion -- with no
   * database, so a browser gate can hold it.
   */
  readonly providerVerdicts: {
    accepted: boolean;
    code: string | null;
    stage: 'operation-input';
    subjectId: string | null;
  }[] = [];

  readRecord(recordId: string): SemanticRecordDto | null {
    return this.records.get(recordId) ?? null;
  }

  createSeed(name?: string): string {
    const recordId = randomUUID();
    this.records.set(recordId, dto(recordId, name));
    return recordId;
  }

  /**
   * Seeds a record carrying real typed values. `createSeed` stores one string,
   * which cannot express a JSON `true` or the difference between a stored `null`
   * and a field that was never set.
   */
  seedTypedValues(
    values: Readonly<Record<string, ImmutableJsonValue>>,
  ): string {
    const recordId = randomUUID();
    this.records.set(
      recordId,
      Object.freeze({
        archived: false,
        entityId: FIXTURE_IDS.entityIds.parent,
        recordId,
        revision: 1,
        values: Object.freeze({ ...values }),
      }),
    );
    return recordId;
  }

  /** Names the capability that ran, on the record, where the page will show it. */
  stamp(recordId: string, capabilityId: string): SemanticRecordDto {
    const previous = this.records.get(recordId);
    assert.ok(previous);
    const stored: SemanticRecordDto = Object.freeze({
      ...previous,
      revision: previous.revision + 1,
      values: Object.freeze({
        ...previous.values,
        [FIXTURE_IDS.fieldIds.parentName]: `ran ${capabilityId}`,
      }) as Readonly<Record<string, ImmutableJsonValue>>,
    });
    this.records.set(recordId, stored);
    return stored;
  }

  async recordNonAccepted(
    _request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    void _request;
  }

  #askTheProvider(
    request: SemanticOperationExecutionRequest,
    input: Record<string, unknown>,
  ): ReturnType<typeof parseMutationInput> {
    try {
      const parsed = parseMutationInput(
        request.definition as Parameters<typeof parseMutationInput>[0],
        input as unknown as ImmutableJsonValue,
      );
      this.providerVerdicts.push({
        accepted: true,
        code: null,
        stage: 'operation-input',
        subjectId: null,
      });
      return parsed;
    } catch (error) {
      const known = error instanceof ModuleRuntimeInterpreterError;
      this.providerVerdicts.push({
        accepted: false,
        code: known ? error.code : null,
        stage: 'operation-input',
        subjectId: known ? error.subjectId : null,
      });
      throw error;
    }
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  async execute(
    request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope | SemanticOperationResultEnvelope> {
    if ('arguments' in request) {
      if (request.definition.queryId === this.failedQueryId) {
        throw new Error('intentional slot data failure');
      }
      if (this.forcedQueryOutcome === 'unsupported') {
        return {
          kind: 'semanticQueryResult',
          outcome: 'unsupported',
          queryId: request.definition.queryId,
          records: [],
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          unsupportedReason: 'fixture runtime does not support this query',
        };
      }
      const args = recordValue(request.arguments);
      const records =
        request.definition.queryType === 'get'
          ? [...this.records.values()].filter(
              (record) => record.recordId === args.recordId,
            )
          : [...this.records.values()];
      const projectedRecords = request.list
        ? records.map((entry) => projectedListRecord(request, entry))
        : records;
      const result: SemanticQueryResultEnvelope = {
        kind: 'semanticQueryResult',
        outcome:
          records.length > 0 || request.definition.queryType === 'list'
            ? 'exact'
            : 'not-found',
        queryId: request.definition.queryId,
        records: projectedRecords,
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: null,
      };
      return request.list
        ? {
            ...result,
            listCoverage: listCoverage(request, projectedRecords.length),
          }
        : result;
    }

    const parsed = this.#askTheProvider(request, recordValue(request.input));
    const values = parsed.patch;
    const recordId = parsed.recordId;
    const previous = this.records.get(recordId);
    const effect = request.definition.effect.kind;
    const stored: SemanticRecordDto = Object.freeze({
      archived:
        effect === 'archiveRecordEffect'
          ? true
          : effect === 'restoreRecordEffect'
            ? false
            : (previous?.archived ?? false),
      entityId: request.definition.effect.entity.targetId,
      recordId,
      revision: (previous?.revision ?? 0) + 1,
      values: Object.freeze({
        ...(previous?.values ?? {}),
        ...values,
      }) as Readonly<Record<string, ImmutableJsonValue>>,
    });
    this.records.set(recordId, stored);
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: stored,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
      unsupportedReason: null,
    };
  }
}

function allowPolicy(): CurrentPolicyGateway {
  return {
    async authorize() {
      return {
        decision: 'ALLOW',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'browser-surface-policy/v1',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'browser-surface-policy/v1' };
    },
  };
}

function runtimeEntry(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) =>
      request.headers?.authorization === 'fixture-user' ? identity : null,
    ),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId,
          pointer: { fence: 1, pointerId },
          projections: runtimeProjections(compiled),
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId,
        };
      },
    },
    policy,
  );
}

function dto(recordId: string, name?: string): SemanticRecordDto {
  return Object.freeze({
    archived: false,
    entityId: FIXTURE_IDS.entityIds.parent,
    recordId,
    revision: 1,
    values: Object.freeze(
      name === undefined ? {} : { [FIXTURE_IDS.fieldIds.parentName]: name },
    ),
  });
}

function projectedListRecord(
  request: SemanticQueryExecutionRequest,
  record: SemanticRecordDto,
): SemanticRecordDto {
  return Object.freeze({
    ...record,
    displayValues: Object.freeze(
      Object.fromEntries(
        request.definition.selections.map(({ fieldId }) => [
          fieldId,
          displayValue(record.values[fieldId]),
        ]),
      ),
    ),
    relationLabels: Object.freeze({}),
  });
}

function displayValue(value: ImmutableJsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function listCoverage(
  request: SemanticQueryExecutionRequest,
  returnedCount: number,
): NonNullable<SemanticQueryResultEnvelope['listCoverage']> {
  assert.ok(request.list);
  return Object.freeze({
    effectivePageSize: request.list.query.effectivePageSize,
    hasMore: false,
    includeArchived: request.list.query.includeArchived,
    matchMode: request.list.query.matchMode,
    nextCursor: null,
    pageOffset: request.list.query.pageOffset,
    parentScope: null,
    projectedSearchValueCount:
      request.list.query.search.length === 0
        ? 0
        : request.definition.selections.length,
    requestedPageSize: request.list.query.requestedPageSize,
    returnedCount,
    schemaVersion: 'northstar.shared-list-result/v1',
    search: request.list.query.search,
    sort: request.list.query.sort,
    totalCount: request.list.query.pageOffset + returnedCount,
    truncatedByMaximum: request.list.query.truncatedByMaximum,
  });
}

function runtimeProjections(
  compiled: CompileSuccess,
): LoadedRequestRuntimeDefinition['projections'] {
  return {
    agent: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.agent),
    catalog: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog),
    operation: projection(
      compiled,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
    ),
    query: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.query),
    surface: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.surface),
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifestValue = decode(artifact(compiled, reference.artifactRoot));
  assert.ok(Array.isArray(manifestValue.chunks));
  const descriptor = manifestValue.chunks[0];
  assert.ok(isRecord(descriptor));
  const contentHash = descriptor.contentHash;
  assert.equal(typeof contentHash, 'string');
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(
      artifact(compiled, String(contentHash)),
    ) as unknown as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}

function artifact(
  compiled: CompileSuccess,
  contentHash: string,
): ContentAddressedArtifact {
  const value = compiled.bundle.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  assert.ok(value);
  return value;
}

function decode(value: ContentAddressedArtifact): Record<string, unknown> {
  const decoded: unknown = JSON.parse(
    new TextDecoder().decode(value.canonicalBytes),
  );
  assert.ok(isRecord(decoded));
  return decoded;
}

/**
 * Two `command` operations on one entity -- the `PUR-1` shape (a release AND a
 * cancel) expressed in a fixture rather than a module, so this needs no
 * purchasing entity, no mount and no language cut.
 *
 * They are registered capabilities rather than state transitions only because
 * `transitionStateEffect` does not yet map to `command` on this base; both
 * effect kinds bind to the same intent, so the mechanism under test is the
 * same one `PUR-1` will hit.
 */
const COMMAND_ACTIONS = Object.freeze(['release', 'cancel'] as const);

function commandCapabilityId(action: string): string {
  return `${FIXTURE_IDS.namespace}:capability.master_${action}`;
}

function commandOperationId(action: string): string {
  return `${FIXTURE_IDS.namespace}:operation.master_${action}`;
}

/** A second operation on an intent rendered by ONE control, which stays refused. */
function pushDuplicateCreate(authored: Record<string, unknown>): void {
  const operations = authored.operations as Array<Record<string, unknown>>;
  const create = operations.find(
    (operation) =>
      operation.operationId ===
      `${FIXTURE_IDS.namespace}:operation.master_create`,
  );
  assert.ok(create);
  operations.push({
    ...create,
    operationId: `${FIXTURE_IDS.namespace}:operation.master_create_alternate`,
  });
}

function pushCommandOperations(authored: Record<string, unknown>): void {
  (authored.capabilityRequirements as unknown[]).push(
    ...COMMAND_ACTIONS.map((action) => ({
      capabilityId: commandCapabilityId(action),
      capabilityVersion: 1,
      declaredEffects: ['recordMutation'],
      kind: 'capabilityRequirement',
      requiredProjections: ['operation'],
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      supportStatus: 'supported',
    })),
  );
  (authored.permissions as unknown[]).push(
    ...COMMAND_ACTIONS.map((action) => ({
      action: 'update',
      kind: 'permissionDefinition',
      label: `master ${action}`,
      permissionId: `${FIXTURE_IDS.namespace}:permission.master_${action}`,
      resource: {
        kind: 'entityReference',
        schemaVersion: FIXTURE_LANGUAGE_VERSION,
        targetId: FIXTURE_IDS.entityIds.parent,
      },
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
    })),
  );
  (authored.operations as unknown[]).push(
    ...COMMAND_ACTIONS.map((action) => ({
      confirmation: 'none',
      effect: {
        capability: {
          kind: 'capabilityReference',
          schemaVersion: FIXTURE_LANGUAGE_VERSION,
          targetId: commandCapabilityId(action),
        },
        kind: 'registeredCapabilityEffect',
        schemaVersion: FIXTURE_LANGUAGE_VERSION,
      },
      kind: 'operationDefinition',
      module: {
        kind: 'moduleReference',
        schemaVersion: FIXTURE_LANGUAGE_VERSION,
        targetId: FIXTURE_IDS.moduleId,
      },
      operationId: commandOperationId(action),
      permission: {
        kind: 'permissionReference',
        schemaVersion: FIXTURE_LANGUAGE_VERSION,
        targetId: `${FIXTURE_IDS.namespace}:permission.master_${action}`,
      },
      readBack: {
        kind: 'queryReference',
        schemaVersion: FIXTURE_LANGUAGE_VERSION,
        targetId: `${FIXTURE_IDS.namespace}:query.master_get`,
      },
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      tier: 'o1',
    })),
  );
}

/** Makes this browser fixture's create form capable of stating every required value. */
function exposeRequiredMasterNumber(authored: Record<string, unknown>): void {
  const queries = authored.queries as Array<Record<string, unknown>>;
  const get = queries.find(
    (query) => query.queryId === `${FIXTURE_IDS.namespace}:query.master_get`,
  );
  assert.ok(get);
  (get.selections as Array<Record<string, unknown>>).push({
    field: {
      kind: 'fieldReference',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.fieldIds.parentNumber,
    },
    kind: 'querySelection',
    orderKey: 20,
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
    selectionId: `${FIXTURE_IDS.namespace}:selection.master_get_number`,
  });
}

function compileFixture(
  withPartialAnatomy = true,
  withInvalidFormBinding = false,
  amend?: (authored: Record<string, unknown>) => void,
  includeRecordSections = false,
  unsupportedNonMutationSlot: 'activity' | 'childTables' | null = null,
): CompileSuccess {
  const authored = ordinaryModuleV1();
  exposeRequiredMasterNumber(authored);
  amend?.(authored);
  const surfaces = authored.surfaces as Array<Record<string, unknown>>;
  if (withPartialAnatomy) {
    for (const surface of surfaces) {
      const surfaceId = String(surface.surfaceId);
      const existingSlots = surface.slots as Array<Record<string, unknown>>;
      const requiredSlots = surfaceId.endsWith('_list')
        ? ['title', 'dataGrid']
        : surfaceId.endsWith('_form')
          ? ['breadcrumb', 'titleStatus', 'commandBar', 'sections']
          : [
              'breadcrumb',
              'titleStatus',
              'commandBar',
              'keyFacts',
              ...(includeRecordSections ? ['sections'] : []),
            ];
      const exemplar = existingSlots[0];
      assert.ok(exemplar);
      surface.slots = requiredSlots.map((slot, index) => ({
        ...exemplar,
        orderKey: (index + 1) * 10,
        slot,
        slotId: `${surfaceId.replace(':surface.', ':slot.')}_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
      }));
    }
  }
  if (unsupportedNonMutationSlot !== null) {
    const form = surfaces.find(
      (surface) =>
        surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_form`,
    );
    assert.ok(form);
    const slots = form.slots as Array<Record<string, unknown>>;
    const exemplar = slots[0];
    assert.ok(exemplar);
    slots.push({
      ...exemplar,
      orderKey: 50,
      slot: unsupportedNonMutationSlot,
      slotId: `${FIXTURE_IDS.namespace}:slot.master_form_${unsupportedNonMutationSlot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
    });
  }
  if (withInvalidFormBinding) {
    const form = surfaces.find(
      (surface) =>
        surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_form`,
    );
    assert.ok(form);
    recordValue(form.dataSource).targetId =
      `${FIXTURE_IDS.namespace}:query.master_list`;
  }
  const normalized = normalizeApplicationPackage(authored);
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    // Version-from-artifact, matching what the production compile scripts in
    // apps/web/scripts already do. This was the only site under apps/ still
    // pinning the profile.
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

function compileEveryFieldKindFixture(
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion = COMPILER_SEMANTIC_PROFILE_V2_VERSION,
): CompileSuccess {
  const authored = everyFieldKindModule();
  exposeRequiredMasterNumber(authored);
  declareFixtureFormAnatomy(authored);
  const normalized = normalizeApplicationPackage(authored);
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: {
      ...MODULE_COMPILER_PROFILE,
      compilerSemanticProfileVersion,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

function declareFixtureFormAnatomy(authored: Record<string, unknown>): void {
  const surfaces = authored.surfaces as Array<Record<string, unknown>>;
  for (const surface of surfaces.filter((candidate) =>
    String(candidate.surfaceId).endsWith('_form'),
  )) {
    const surfaceId = String(surface.surfaceId);
    const slots = surface.slots as Array<Record<string, unknown>>;
    const exemplar = slots[0];
    assert.ok(exemplar);
    surface.slots = ['breadcrumb', 'titleStatus', 'commandBar', 'sections'].map(
      (slot, index) => ({
        ...exemplar,
        orderKey: (index + 1) * 10,
        slot,
        slotId: `${surfaceId.replace(':surface.', ':slot.')}_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
      }),
    );
  }
}

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
  const address = target.address();
  assert.ok(typeof address === 'object' && address !== null);
  return `http://127.0.0.1:${address.port}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

async function expectClosedSlotStates(page: Page): Promise<void> {
  const slots = page.locator('[data-platform-slot]');
  expect(await slots.count()).toBeGreaterThan(0);
  await expect(
    page.locator('[data-platform-slot]:not([data-slot-state])'),
  ).toHaveCount(0);
  const states = await slots.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-slot-state')),
  );
  expect(
    states.every((state) =>
      ['pending', 'ready', 'empty', 'failed'].includes(state ?? ''),
    ),
  ).toBe(true);
}

interface CompleteMessageExpectation {
  readonly code: SurfaceMessageCode;
  readonly fullText: string;
  readonly subject?: string;
}

async function expectCompleteMessage(
  page: Page,
  expected: CompleteMessageExpectation,
): Promise<string> {
  const messages = page.locator('[data-message]');
  await expect(messages).toHaveCount(1);
  const message = messages.first();
  const catalog = SURFACE_MESSAGE_CATALOG[expected.code];
  await expect(message).toBeVisible();
  await expect(message).toHaveAttribute('data-message', expected.code);
  await expect(message).toHaveAttribute('data-diagnostic-code', expected.code);
  await expect(message).toHaveAttribute(
    'data-status-role',
    catalog.consequence === 'blocking' ? 'blocked' : 'attention',
  );
  await expect(message.locator('[data-message-sentence]')).toHaveText(
    catalog.sentence,
  );
  await expect(message.locator('[data-message-detail]')).toHaveText(
    catalog.detail,
  );
  const nextAction = message.locator('[data-message-next-action]');
  if (catalog.nextAction === null) {
    await expect(nextAction).toHaveCount(0);
  } else {
    await expect(nextAction).toHaveText(catalog.nextAction);
  }
  const subject = message.locator('[data-message-subject]');
  if (expected.subject === undefined) {
    await expect(subject).toHaveCount(0);
  } else {
    await expect(subject).toHaveText(expected.subject);
  }
  await expect(message.locator('[data-message-code]')).toHaveText(
    expected.code,
  );
  expect(normalizeVisibleText(await message.innerText())).toBe(
    expected.fullText,
  );
  return (await message.getAttribute('data-message')) ?? '';
}

function normalizeVisibleText(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
