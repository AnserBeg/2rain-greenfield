import assert from 'node:assert/strict';
import test from 'node:test';

import {
  patchFromForm,
  renderCustomizeScreen,
  type CustomizeScreenService,
} from '../../apps/web/src/customize-screen.js';
import { parseCustomizationPatch } from '../../packages/customization/src/index.js';

const patchId = '11111111-1111-4111-8111-111111111111';

function fakeService(calls: string[]): CustomizeScreenService {
  return {
    activate: (id) => {
      calls.push(`activate ${id}`);
      return Promise.resolve({
        releaseId: 'r' as never,
        releaseRoot: 'a'.repeat(64),
        status: 'activated',
      });
    },
    approve: (id) => {
      calls.push(`approve ${id}`);
      return Promise.resolve({
        activationAttemptId: 'x' as never,
        renderedDiff: 'New record type "Equipment" with 1 field:',
        status: 'approved',
      });
    },
    draft: (input, channel) => {
      calls.push(`draft ${channel} ${JSON.stringify(input)}`);
      const parsed = parseCustomizationPatch(input);
      if (parsed.status === 'unsupported') {
        return Promise.resolve({
          message: parsed.message,
          missingCapability: parsed.missingCapability,
          status: 'unsupported',
        });
      }
      return Promise.resolve({
        canonicalDiffDigest: 'c'.repeat(64),
        patchId: patchId as never,
        releaseId: 'r' as never,
        releaseRoot: 'b'.repeat(64),
        renderedDigest: 'd'.repeat(64),
        renderedDiff:
          'New record type "Equipment" with 1 field:\n  - Name (text, required)',
        revisionId: 'v' as never,
        reused: false,
        status: 'drafted',
      });
    },
    rollback: () => {
      calls.push('rollback');
      return Promise.resolve({
        releaseId: 'r' as never,
        releaseRoot: 'a'.repeat(64),
        status: 'rolledBack',
      });
    },
    status: () =>
      Promise.resolve({
        activeChain: [],
        activeFence: 2,
        upgrades: [],
        upgradeRefusal: null,
        activeReleaseId: 'r' as never,
        activeReleaseRoot: 'a'.repeat(64),
        patches: [],
      }),
    targets: () =>
      Promise.resolve({
        choiceFields: [],
        lists: [
          {
            columns: [
              { fieldId: 'northstar.app:field.location_code', label: 'Code' },
              { fieldId: 'northstar.app:field.location_name', label: 'Name' },
            ],
            label: 'Location list',
            surfaceId: 'northstar.app:surface.location_list',
          },
        ],
        recordTypes: [
          {
            entityId: 'northstar.app:entity.party',
            label: 'Party',
            tenantAuthored: false,
          },
        ],
      }),
  };
}

test('the Customize screen offers the four kinds and the live state', async () => {
  const response = await renderCustomizeScreen(
    fakeService([]),
    'http://local/?customize',
    null,
  );
  assert.equal(response.statusCode, 200);
  for (const kind of [
    'addRecordType',
    'addField',
    'addChoice',
    'arrangeLayout',
  ]) {
    assert.match(
      response.html,
      new RegExp(`data-customize-form="${kind}"|A new choice`, 'u'),
    );
  }
  assert.match(
    response.html,
    /The standard application, with no customizations/u,
  );
  assert.doesNotMatch(response.html, /<script/u);
});

test('a described record type drafts as one typed patch and shows its plain diff with Approve', async () => {
  const calls: string[] = [];
  const response = await renderCustomizeScreen(
    fakeService(calls),
    'http://local/?customize',
    {
      action: 'draft',
      field_1_label: 'Name',
      field_1_type: 'text',
      field_2_label: 'Status',
      field_2_options: 'In service, Retired',
      field_2_type: 'choice',
      field_3_label: '',
      kind: 'addRecordType',
      label: 'Equipment',
    },
  );
  assert.equal(response.statusCode, 200);
  assert.match(response.html, /data-customize-result="drafted"/u);
  assert.match(response.html, /New record type &quot;Equipment&quot;/u);
  assert.match(response.html, /data-customize-action="approve"/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^draft visualBuilder /u);
  const sent = JSON.parse(
    calls[0]!.replace(/^draft visualBuilder /u, ''),
  ) as unknown;
  const parsed = parseCustomizationPatch(sent);
  assert.equal(parsed.status, 'parsed');
  assert.deepEqual(sent, {
    fields: [
      { label: 'Name', type: 'text' },
      { label: 'Status', options: ['In service', 'Retired'], type: 'choice' },
    ],
    kind: 'addRecordType',
    label: 'Equipment',
  });
});

test('approve, activate and roll back each act once and say what happened', async () => {
  const calls: string[] = [];
  const service = fakeService(calls);
  const approved = await renderCustomizeScreen(
    service,
    'http://local/?customize',
    {
      action: 'approve',
      patchId,
    },
  );
  assert.match(approved.html, /data-customize-action="activate"/u);
  const activated = await renderCustomizeScreen(
    service,
    'http://local/?customize',
    {
      action: 'activate',
      patchId,
    },
  );
  assert.match(activated.html, /data-customize-result="activated"/u);
  const rolledBack = await renderCustomizeScreen(
    service,
    'http://local/?customize',
    {
      action: 'rollback',
      releaseId: 'r',
      fence: '2',
    },
  );
  assert.match(rolledBack.html, /data-customize-result="rolledBack"/u);
  assert.match(rolledBack.html, /Every record entered under it is kept/u);
  assert.deepEqual(calls, [
    `approve ${patchId}`,
    `activate ${patchId}`,
    'rollback',
  ]);
});

test('an unsupported request is named and nothing is recorded', async () => {
  const response = await renderCustomizeScreen(
    fakeService([]),
    'http://local/?customize',
    { action: 'draft', kind: 'addWorkflow' },
  );
  assert.equal(response.statusCode, 422);
  assert.match(response.html, /data-customize-refusal="addWorkflow"/u);
  assert.match(response.html, /Nothing was recorded/u);
});

test('an arranged list becomes order, hide and relabel by field', () => {
  const patch = patchFromForm({
    column_1_field: 'northstar.app:field.location_code',
    column_1_hide: 'on',
    column_1_label: 'Code',
    column_1_position: '2',
    column_2_field: 'northstar.app:field.location_name',
    column_2_label: 'Location',
    column_2_position: '1',
    columns: '2',
    kind: 'arrangeLayout',
    surface: 'northstar.app:surface.location_list',
  });
  assert.deepEqual(patch, {
    hide: ['northstar.app:field.location_code'],
    kind: 'arrangeLayout',
    order: ['northstar.app:field.location_name'],
    relabel: [
      { field: 'northstar.app:field.location_name', label: 'Location' },
    ],
    surface: 'northstar.app:surface.location_list',
  });
  assert.equal(parseCustomizationPatch(patch).status, 'parsed');
});

test('Customize reports activation on another page until the operation settles', async () => {
  const service = fakeService([]);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const activate = service.activate;
  service.activate = async (id) => {
    await gate;
    return activate(id);
  };
  const approving = await renderCustomizeScreen(service, '/?customize', {
    action: 'approve',
    patchId,
  });
  assert.match(approving.html, /Activating your change…/u);
  const work = renderCustomizeScreen(service, '/?customize', {
    action: 'activate',
    patchId,
  });
  try {
    const overview = await renderCustomizeScreen(service, '/?customize', null);
    assert.match(overview.html, /Activation is still running/u);
  } finally {
    finish();
    await work;
  }
  assert.doesNotMatch(
    (await renderCustomizeScreen(service, '/?customize', null)).html,
    /Activation is still running/u,
  );
});

test('the live platform upgrade is the named and release-bound rollback target', async () => {
  const calls: string[] = [];
  const service = fakeService(calls);
  const status = await service.status();
  service.status = () =>
    Promise.resolve({
      ...status,
      activeReleaseId: 'selected-release',
      activeChain: [{ kind: 'addField', patchId, displayLabel: 'Order note' }],
      upgrades: [
        {
          candidateReleaseId: 'selected-release',
          upgradeId: 'upgrade-b',
          state: 'live',
        },
      ],
      upgradeRefusal: {
        code: 'CUSTOMIZE_BASE_MOVED',
        message: 'This chain cannot be upgraded.',
      },
    });
  service.rollback = (releaseId, fence) => {
    calls.push(releaseId, fence);
    return Promise.resolve({ releaseRoot: 'restored' });
  };
  const page = await renderCustomizeScreen(service, '/?customize', null);
  assert.match(page.html, /Latest: Platform upgrade upgrade-b/u);
  assert.match(page.html, /name="releaseId" value="selected-release"/u);
  assert.match(page.html, /CUSTOMIZE_BASE_MOVED/u);
  assert.equal(
    (
      await renderCustomizeScreen(service, '/?customize', {
        action: 'rollback',
      })
    ).statusCode,
    409,
  );
  await renderCustomizeScreen(service, '/?customize', {
    action: 'rollback',
    releaseId: 'selected-release',
    fence: '2',
  });
  assert.deepEqual(calls, ['selected-release', '2']);
});
