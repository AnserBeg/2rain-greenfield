import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { expect, test, type Page } from '@playwright/test';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '@north-star/canonical-model';
import {
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
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
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
import { createSurfaceRuntimeServer } from '../../src/app-server.js';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const environmentId = 'a2000000-0000-4000-8000-000000000002';
const principalId = 'a3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

let server: Server;
let baseUrl: string;
let executor: BrowserFixtureExecutor;
let missingDisplayRecordId: string;

test.beforeAll(async () => {
  const compiled = compileFixture();
  const policy = allowPolicy();
  executor = new BrowserFixtureExecutor();
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
  const executor = new BrowserFixtureExecutor();
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
  const emptyExecutor = new BrowserFixtureExecutor();
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
  const invalidExecutor = new BrowserFixtureExecutor();
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
  const executor = new BrowserFixtureExecutor();
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

    // Operable, not merely present: two enabled submit controls carrying
    // distinct accessible names, each naming its own operation on the wire.
    const cancel = commandBar.locator(
      `form.capability-command[data-operation-id="${commandOperationId('cancel')}"]`,
    );
    const release = commandBar.locator(
      `form.capability-command[data-operation-id="${commandOperationId('release')}"]`,
    );
    await expect(cancel.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await expect(release.getByRole('button', { name: 'Release' })).toBeEnabled();
    await expect(
      cancel.locator('input[name="operationId"]'),
    ).toHaveValue(commandOperationId('cancel'));
    await expect(
      release.locator('input[name="operationId"]'),
    ).toHaveValue(commandOperationId('release'));

    // Press the SECOND control. Under the old dispatch this ran the first.
    await release.getByRole('button', { name: 'Release' }).click();
    await expect(page.getByRole('status')).toContainText('Release complete');
    await expect(page.locator('[data-platform-slot="record:keyFacts"]')).toContainText(
      `ran ${commandCapabilityId('release')}`,
    );
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
  const duplicateExecutor = new BrowserFixtureExecutor();
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
      page.locator(
        '.standalone__card[role="alert"][data-diagnostic-code="QUERY_UNSUPPORTED"]',
      ),
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
  const executor = new BrowserFixtureExecutor();
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
          intent: 'command',
          operationId,
          recordId,
        },
      });
      expect(refused.status()).toBe(422);
      expect(await refused.text()).toContain('OPERATION_UNSUPPORTED');
    }
    assert.deepEqual(
      capabilityExecutors.flatMap((candidate) => candidate.executed),
      [],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      authorityServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

class RecordingCapabilityExecutor
  implements RegisteredCapabilityOperationExecutor
{
  readonly executed: string[] = [];

  constructor(
    readonly capabilityId: string,
    private readonly records: BrowserFixtureExecutor,
  ) {}

  async execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    this.executed.push(request.definition.operationId);
    const input = request.input as Readonly<Record<string, ImmutableJsonValue>>;
    const stored = this.records.stamp(String(input.recordId), this.capabilityId);
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

  constructor(private readonly failedQueryId: string | null = null) {}

  createSeed(name?: string): string {
    const recordId = randomUUID();
    this.records.set(recordId, dto(recordId, name));
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
      operation.operationId === `${FIXTURE_IDS.namespace}:operation.master_create`,
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

function compileFixture(
  withPartialAnatomy = true,
  withInvalidFormBinding = false,
  amend?: (authored: Record<string, unknown>) => void,
): CompileSuccess {
  const authored = ordinaryModuleV1();
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
