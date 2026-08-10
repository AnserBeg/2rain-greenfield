import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { expect, test, type Page } from '@playwright/test';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '@north-star/canonical-model';
import {
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
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
  ordinaryModuleV1,
} from '../../../../test/fixtures/g2/module-conformance/definitions.js';
import {
  EVERY_KIND_FIELD_IDS,
  everyFieldKindModule,
} from '../../../../test/fixtures/g2/module-conformance/field-kinds.js';
import { createSurfaceRuntimeServer } from '../../src/app-server.js';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const environmentId = 'a2000000-0000-4000-8000-000000000002';
const principalId = 'a3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

/**
 * Named rather than a bare boolean, so every construction site reads as a claim
 * about what that double does. `KNOWN_FALSE_GREEN` marks a site that observes a
 * success production would refuse -- routed to `double-must-honour-refusal`.
 */
const HONOURS_REFUSALS = true;
const KNOWN_FALSE_GREEN = false;

let server: Server;
let baseUrl: string;
let executor: BrowserFixtureExecutor;
let missingDisplayRecordId: string;
let fieldKindServer: Server;
let fieldKindUrl: string;
let fieldKindExecutor: BrowserFixtureExecutor;

test.beforeAll(async () => {
  const compiled = compileFixture();
  const policy = allowPolicy();
  executor = new BrowserFixtureExecutor(null, KNOWN_FALSE_GREEN);
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
  fieldKindExecutor = new BrowserFixtureExecutor(null, HONOURS_REFUSALS);
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
      queryGateway: new SemanticQueryGateway(fieldKindPolicy, fieldKindExecutor),
    },
  );
  fieldKindUrl = await listen(fieldKindServer);
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

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    fieldKindServer.close((error) => (error ? reject(error) : resolve()));
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

  const date = page.locator(
    `[name="value:${EVERY_KIND_FIELD_IDS.due}"]`,
  );
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
  await expect(instant).toHaveAttribute('data-refused-control', 'datetime-local');
  await expect(instant).toHaveAttribute('data-timezone-semantics', 'utcInstant');

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
  expect(
    await grade.evaluate((element) => element.tagName.toLowerCase()),
  ).toBe('select');
  await expect(grade).toHaveJSProperty('value', '');
  expect(
    await grade.evaluate((element: HTMLSelectElement) => element.options.length),
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

let lastSubmission: readonly (readonly [string, string])[] = [];

function formUrl(recordId: string): string {
  return `${fieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}&record=${encodeURIComponent(recordId)}`;
}

function capturePost(page: Page): Promise<string> {
  return new Promise<string>((resolve) => {
    page.on('request', (request) => {
      if (request.method() === 'POST') resolve(request.postData() ?? '');
    });
  });
}

async function idleValue(page: Page, fieldId: string): Promise<string> {
  return page
    .locator(`[name="value:${fieldId}"]`)
    .evaluate((element: HTMLInputElement | HTMLSelectElement) => element.value);
}

/**
 * **Four claims, four measurements, and the seam between them is the point.**
 *
 * The first version of this called itself a provider round trip and was not one:
 * the double recorded production's refusal and then merged the refused values
 * anyway, so its "authoritative reread" was a green manufactured by the
 * component whose refusal was the fact. The double now honours the refusal, and
 * the claim is decomposed into the four things actually observed:
 *
 *   1. browser encoding preserves the rendered strings;
 *   2. production currently REFUSES that encoding;
 *   3. the normalised encoding is accepted by `parseMutationInput`;
 *   4. given acceptance, the reread returns the seeded values.
 *
 * Claims 1-3 are observations. **Claim 4 is a stand-in**, named at the point of
 * use: it seeds from the stage production accepts, because no browser submission
 * of this surface is acceptable as submitted. What blocks it is routed and stays
 * routed -- `form-write-untyped-wire` and `form-empty-means-nothing` -- and this
 * packet does not pull either back into its lease.
 */
test('CLAIM 1: the browser encodes the rendered strings, in the compiled order', async ({
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

  const posted = capturePost(page);
  await page.getByRole('button', { name: 'Save' }).click();
  const entries = [...new URLSearchParams(await posted).entries()];
  const valueEntries = entries.filter(([key]) => key.startsWith('value:'));

  expect(entries.map(([key]) => key).slice(0, 4)).toEqual([
    'intent',
    'idempotencyKey',
    'recordId',
    'expectedRevision',
  ]);
  // One entry per field, no shadowing sibling, values byte-identical to what the
  // controls rendered.
  expect(valueEntries.length).toBe(
    new Set(valueEntries.map(([key]) => key)).size,
  );
  for (const [fieldId, value] of Object.entries(SEEDED)) {
    expect(
      valueEntries.find(([key]) => key === `value:${fieldId}`),
      fieldId,
    ).toEqual([`value:${fieldId}`, value]);
  }
  lastSubmission = valueEntries;
});

/**
 * Production refuses what the browser just sent, and the page says so rather
 * than rendering a success. The double throws exactly what `parseMutationInput`
 * threw, so this is the real contract refusing, surfaced through the real
 * gateway and the real renderer.
 *
 * The middle stage is why this is attributable: coercing booleans alone is still
 * refused, so `""` for an unset non-text field is a SECOND gap rather than a
 * detail of the first.
 */
test('CLAIM 2: production refuses that encoding, and the page shows it', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const recordId = fieldKindExecutor.seedTypedValues({
    ...SEEDED,
    [EVERY_KIND_FIELD_IDS.active]: true,
  });
  await page.goto(formUrl(recordId));
  const before = fieldKindExecutor.providerVerdicts.length;
  await page.getByRole('button', { name: 'Save' }).click();

  const verdicts = fieldKindExecutor.providerVerdicts.slice(before);
  const stage = (name: string) =>
    verdicts.find((entry) => entry.stage === name);
  expect(stage('as-submitted')).toMatchObject({
    accepted: false,
    code: 'MODULE_FIELD_VALUE_INVALID',
  });
  expect(stage('booleans-coerced')).toMatchObject({
    accepted: false,
    code: 'MODULE_FIELD_VALUE_INVALID',
  });
  // Refused, not silently succeeded. The double no longer manufactures a green.
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
});

/**
 * The admission twin, decided by the real parser rather than by this file: with
 * `U7`'s normalisation stood in for -- empty strings read as "no value stated",
 * booleans coerced -- the SAME submission is accepted. That is what makes claim
 * 2's refusal attributable to the two named wire gaps and to nothing about the
 * temporal or enum encodings.
 */
test('CLAIM 3: the normalised encoding is accepted by the real parser', async () => {
  expect(lastSubmission.length).toBeGreaterThan(0);
  const verdicts = fieldKindExecutor.providerVerdicts;
  const normalised = verdicts.filter((entry) => entry.stage === 'normalised');
  expect(normalised.length).toBeGreaterThan(0);
  expect(normalised.at(-1)).toEqual({
    accepted: true,
    code: null,
    stage: 'normalised',
    subjectId: null,
  });
});

/**
 * **A stand-in observation, named here rather than in a comment.** No browser
 * submission of this surface is acceptable as submitted, so the record is seeded
 * from the stage production DOES accept and the reread is read off that. It
 * shows that the controls carry back what was stored; it does NOT show that a
 * browser submission produced the stored values, and nothing in this packet
 * shows that.
 */
test('CLAIM 4 (stand-in): given acceptance, the reread returns the seeded values', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  const recordId = fieldKindExecutor.seedTypedValues({
    ...SEEDED,
    [EVERY_KIND_FIELD_IDS.active]: true,
  });
  await page.goto(formUrl(recordId));
  for (const [fieldId, value] of Object.entries(SEEDED)) {
    expect(await idleValue(page, fieldId), `reread ${fieldId}`).toBe(value);
  }
  expect(await idleValue(page, EVERY_KIND_FIELD_IDS.active)).toBe('true');
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
      seeded === undefined
        ? {}
        : { [EVERY_KIND_FIELD_IDS.active]: seeded },
    );
    await page.goto(
      `${fieldKindUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}&record=${encodeURIComponent(recordId)}`,
    );
    await expect(page.locator(control)).toHaveJSProperty('value', expectedIdl);
    // No checkbox and no hidden sibling: nothing can post a value the record
    // did not have.
    await expect(page.locator(`input[type="checkbox"]${control}`)).toHaveCount(0);
    await expect(page.locator(`input[type="hidden"]${control}`)).toHaveCount(0);
  }

  // SUBMISSION, all four states, because the claim above is about the render and
  // this one is about the wire. They are not the same claim and the four-state
  // sentence previously stood over a two-state measurement.
  //
  // What this control distinguishes is THREE things, not four: `true`, `false`,
  // and "no value stated".
  //
  // **A stored `absent` and a stored `null` are identical here in BOTH places
  // measured** -- both leave the blank option selected and both submit the empty
  // string. An earlier version of this sentence said they were "distinguishable
  // only in the render", and the specimen above disproves it: nothing in the
  // boolean renderer adds a discriminator between them. Closing that difference
  // is `form-empty-means-nothing`'s, not this packet's.
  const submitted = async (
    seeded: boolean | null | undefined,
    choose: string | null,
  ): Promise<readonly string[]> => {
    const recordId = fieldKindExecutor.seedTypedValues(
      seeded === undefined ? {} : { [EVERY_KIND_FIELD_IDS.active]: seeded },
    );
    await page.goto(formUrl(recordId));
    if (choose !== null) await page.locator(control).selectOption(choose);
    const posted = capturePost(page);
    await page.getByRole('button', { name: 'Save' }).click();
    return new URLSearchParams(await posted).getAll(
      `value:${EVERY_KIND_FIELD_IDS.active}`,
    );
  };

  // Exactly one entry each time -- no hidden sibling shadowing the control.
  expect(await submitted(undefined, null)).toEqual(['']);
  expect(await submitted(null, null)).toEqual(['']);
  expect(await submitted(false, null)).toEqual(['false']);
  expect(await submitted(true, null)).toEqual(['true']);
  // And turning one off submits `false` rather than omitting the field, which is
  // what a checkbox could not express.
  expect(await submitted(true, 'false')).toEqual(['false']);
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

test('fixture list and form render live DTOs and reflect a semantic create', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'master list',
  );
  await expect(
    page.getByRole('cell', { name: 'Existing live master' }),
  ).toBeVisible();
  await expect(page.locator('[data-data-state="exact"]')).toBeVisible();

  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New master' }),
  ).toBeVisible();
  await page.getByLabel('Master Name').fill('Browser-created master');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.getByRole('status')).toContainText(
    'trust evidence is linked',
  );
  await expect(page.getByLabel('Master Name')).toHaveValue(
    'Browser-created master',
  );

  await page
    .getByRole('navigation', { name: 'Release navigation' })
    .getByRole('link', { name: 'master', exact: true })
    .click();
  await expect(
    page.getByRole('cell', { name: 'Browser-created master' }),
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

test('compiler-valid one-slot Record surfaces retain fallback actions and feedback', async ({
  page,
}) => {
  const compiled = compileFixture(false);
  const policy = allowPolicy();
  const executor = new BrowserFixtureExecutor(null, KNOWN_FALSE_GREEN);
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
    await page.getByLabel('Master Name').fill('Legacy one-slot master');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');

    await page
      .getByRole('navigation', { name: 'Release navigation' })
      .getByRole('link', { name: 'master', exact: true })
      .click();
    const row = page.locator('tr', { hasText: 'Legacy one-slot master' });
    await row.getByRole('link').click();
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
    KNOWN_FALSE_GREEN,
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
    ).toContainText('master list');
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
  const emptyExecutor = new BrowserFixtureExecutor(null, KNOWN_FALSE_GREEN);
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

test('an invalid selected-surface binding remains page-level before slot composition', async ({
  page,
}) => {
  const compiled = compileFixture(true, true);
  const policy = allowPolicy();
  const invalidExecutor = new BrowserFixtureExecutor(null, KNOWN_FALSE_GREEN);
  const operationMediation = new SemanticOperationMediationAuthority();
  const invalidServer = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy),
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
  const invalidBaseUrl = await listen(invalidServer);

  try {
    await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
    const response = await page.goto(
      `${invalidBaseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
    );
    expect(response?.status()).toBe(422);
    await expect(
      page.locator(
        '.standalone__card[role="alert"][data-diagnostic-code="QUERY_UNSUPPORTED"]',
      ),
    ).toBeVisible();
    await expect(page.locator('[data-platform-slot]')).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      invalidServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

class BrowserFixtureExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  private readonly records = new Map<string, SemanticRecordDto>();

  /**
   * **This double does NOT honour provider refusals in general, and the
   * parameter has no default so that no construction site can be silent about
   * it.**
   *
   * A review found the earlier framing false: with a defaulted `false`,
   * `execute()` still recorded the refusal and then merged the rejected values,
   * persisted them and returned `outcome: 'succeeded'` with a read-back. The
   * class could be described as refusal-honouring while its default behaviour
   * did the opposite. Requiring the argument does not fix that behaviour -- it
   * makes every site state which one it has.
   *
   * `false` is a KNOWN FALSE GREEN, not a preference. The real parser refuses
   * `ordinaryModuleV1`'s create with `MODULE_REQUIRED_FIELD_MISSING` on
   * `master_number` -- a required field that surface never renders, so its form
   * cannot submit it -- and two tests below observe "Create complete" for an
   * operation production cannot perform. That is pre-existing, it is a different
   * instance from the wire gaps `ux-picker` routed, and closing it means
   * reconciling a surface with its entity's input contract. Routed to the
   * `double-must-honour-refusal` sweep; deliberately not fixed here, because
   * fixing it inside this lease would widen the packet past its charter.
   */
  constructor(
    private readonly failedQueryId: string | null,
    private readonly honourProviderRefusal: boolean,
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
    stage: 'as-submitted' | 'booleans-coerced' | 'normalised';
    subjectId: string | null;
  }[] = [];

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

  async recordNonAccepted(
    _request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    void _request;
  }

  /**
   * Puts the submitted input past the REAL write path's value contracts three
   * times, so each transformation's contribution is attributable instead of one
   * lumped verdict.
   *
   * **Both transformations stand in for a mechanism that does not exist**, and
   * recording all three stages is how this gate reports that rather than hiding
   * it behind a stub that accepts anything. Measured here, in this order:
   *
   * - **as submitted** -- refused. A form posts strings, and two kinds of string
   *   are not values: `"true"` where `booleanFieldType` demands a JSON boolean,
   *   and `""` for every field the record has no value for, which no non-text
   *   kind admits.
   * - **booleans coerced** -- still refused, which is the point of the middle
   *   stage: fixing the boolean alone is not enough.
   * - **normalised** (empty strings omitted as "no value stated", booleans
   *   coerced) -- accepted, so every temporal and enum value the controls
   *   rendered survives the wire byte for byte.
   *
   * Neither gap is introduced by `ux-picker`; a bare text box posted `""` too.
   * Both are `U7`'s Postel input normalisation, and whether an empty control
   * means "leave alone" or "clear it" is a decision `U7` owns -- this stand-in
   * takes the conservative reading and does not pretend to settle it.
   */
  #askTheProvider(
    request: SemanticOperationExecutionRequest,
    input: Record<string, unknown>,
  ): void {
    const key = 'values' in input ? 'values' : 'patch';
    const submitted = recordValue(input[key] ?? {});
    const withValues = (
      entries: readonly (readonly [string, unknown])[],
    ): Record<string, unknown> => ({
      ...input,
      [key]: Object.fromEntries(entries),
    });
    const asBoolean = (value: unknown): unknown =>
      value === 'true' ? true : value === 'false' ? false : value;
    const entries = Object.entries(submitted);

    for (const [stage, candidate] of [
      ['as-submitted', input],
      [
        'booleans-coerced',
        withValues(entries.map(([field, value]) => [field, asBoolean(value)])),
      ],
      [
        'normalised',
        withValues(
          entries
            .filter(([, value]) => value !== '')
            .map(([field, value]) => [field, asBoolean(value)]),
        ),
      ],
    ] as const) {
      try {
        parseMutationInput(
          request.definition as Parameters<typeof parseMutationInput>[0],
          candidate as unknown as ImmutableJsonValue,
        );
        this.providerVerdicts.push({
          accepted: true,
          code: null,
          stage,
          subjectId: null,
        });
      } catch (error) {
        const known = error instanceof ModuleRuntimeInterpreterError;
        this.providerVerdicts.push({
          accepted: false,
          code: known ? error.code : null,
          stage,
          subjectId: known ? error.subjectId : null,
        });
      }
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

    const input = recordValue(request.input);
    // **Honoured only where the construction site asked for it.** This is NOT a
    // refusal-honouring double in general: with `KNOWN_FALSE_GREEN` the recorded
    // refusal is ignored and the branch below merges the rejected values,
    // persists them and returns `outcome: 'succeeded'` with a read-back. That is
    // ADR-0041's accepted-and-ignored state, it is live at the sites named
    // `KNOWN_FALSE_GREEN`, and naming it does not make those tests valid
    // evidence of semantic create behaviour -- see `double-must-honour-refusal`.
    //
    // An earlier version of this comment said the double honours the refusal it
    // records, without qualification. It does not, and a reviewer had to read
    // the branch to find that out.
    this.#askTheProvider(request, input);
    const asSubmitted = this.providerVerdicts.at(-3);
    if (this.honourProviderRefusal && asSubmitted && !asSubmitted.accepted) {
      throw new ModuleRuntimeInterpreterError(
        asSubmitted.code ?? 'MODULE_FIELD_VALUE_INVALID',
        'the real write path refuses this operation input',
        asSubmitted.subjectId,
      );
    }
    const values = recordValue(input.values ?? input.patch ?? {});
    const recordId = String(input.recordId);
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

function compileFixture(
  withPartialAnatomy = true,
  withInvalidFormBinding = false,
): CompileSuccess {
  const authored = ordinaryModuleV1();
  const surfaces = authored.surfaces as Array<Record<string, unknown>>;
  if (withPartialAnatomy) {
    for (const surface of surfaces) {
      const surfaceId = String(surface.surfaceId);
      const existingSlots = surface.slots as Array<Record<string, unknown>>;
      const requiredSlots = surfaceId.endsWith('_list')
        ? ['title', 'dataGrid']
        : surfaceId.endsWith('_form')
          ? ['breadcrumb', 'titleStatus', 'commandBar', 'sections']
          : ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts'];
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

function compileEveryFieldKindFixture(): CompileSuccess {
  const normalized = normalizeApplicationPackage(everyFieldKindModule());
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
      compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_V2_VERSION,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
