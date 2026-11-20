import assert from 'node:assert/strict';
import test from 'node:test';
import { LINE_CREATE_VALUES_SURFACE_FLOOR } from '../../packages/canonical-model/src/surface-workspace.js';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { DRAFT_CUSTOMIZATION_TOOL } from '../../packages/customization/src/ai-draft.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver, seededId } from '../agent/agent-world.js';
import {
  inspection,
  inspectionChange,
  inspectionLinkRecords,
} from '../fixtures/inspection-customization.js';
import {
  archivedServingRead,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import { recordedPatch } from '../helpers/customization-patch-record.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';
import { scriptedModel } from '../../packages/operations-agent/src/model.js';

test(
  'one inspection change activates linked records and owned lines, and an assistant transition needs a yes',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-inspection',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-inspection',
        };
        const app = await startComposedApplication({
          ...options,
          port: 0,
          seedProfile: 'distributor',
        });
        const request =
          'Set up an inspection process for incoming goods with result lines and pass, fail, conditional and quarantine outcomes.';
        const opened = await openCustomizeService({
          ...options,
          draftingProvider: () =>
            Promise.resolve(
              scriptedModel([
                (conversation) => {
                  assert.deepEqual(conversation, [
                    { role: 'user', text: request },
                  ]);
                  return {
                    toolCalls: [
                      {
                        name: DRAFT_CUSTOMIZATION_TOOL,
                        input: inspectionChange,
                      },
                    ],
                  };
                },
              ]),
            ),
        });
        try {
          const drafted = await opened.service.draftFromRequest(request);
          assert.equal(
            drafted.status,
            'drafted',
            JSON.stringify(drafted.status === 'drafted' ? [] : drafted),
          );
          assert.match(drafted.renderedDiff, /Inspection results/u);
          assert.match(
            drafted.renderedDiff,
            /Quarantine changes "Pending" to "Quarantined"/u,
          );
          assert.equal(
            (await recordedPatch(pool, drafted.patchId)).patch_kind,
            'changeSet',
          );
          assert.equal((await opened.service.status()).patches.length, 1);
          await opened.service.approve(drafted.patchId);
          // The archived Today reader must refuse both releases once the base requires line create values.
          await withArchivedCustomizationRuntime(
            '8839f668293dc06f9d9ba4def3611697323f3760',
            async (run) => {
              const read = () =>
                run(archivedServingRead, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              const refusal = {
                outcome: 'refused',
                code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${LINE_CREATE_VALUES_SURFACE_FLOOR} and this runtime supports 25`,
              };
              assert.deepEqual(await read(), refusal);
              await opened.service.activate(drafted.patchId);
              assert.deepEqual(await read(), refusal);
            },
          );
          const world = worldOver(app.runtime, String(connection.database));
          const { receipt, supplier, item, location } =
            await inspectionLinkRecords(world.create, seededId);
          const beforeMovements = await world.list(
            'northstar.app:query.inventory_movement_list',
          );
          const header = await world.create(
            inspection,
            { name: 'Incoming lot' },
            { goods_receipt: receipt.recordId, supplier, item, location },
          );
          const lineType = `${inspection}_lines`;
          const line = await world.create(
            lineType,
            {
              line_number: '1',
              characteristic: 'Length',
              measured_value: '21',
              pass: true,
            },
            { parent: header.recordId },
          );
          const other = await world.create(inspection, { name: 'Another lot' });
          await world.create(
            lineType,
            { line_number: '1', characteristic: 'Width' },
            { parent: other.recordId },
          );
          const lines = await world.list(
            `northstar.app:query.${lineType}_list`,
            {
              parentScope: {
                relationId: `northstar.app:relation.${lineType}_parent`,
                recordId: header.recordId,
              },
            },
          );
          assert.deepEqual(
            lines.map((row) => row.recordId),
            [line.recordId],
          );
          await assert.rejects(
            world.invoke(`${inspection}_archive`, {
              recordId: header.recordId,
              expectedRevision: header.revision,
            }),
            /active dependent records/u,
          );

          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            autoApproveReversible: true,
            approve: (plan) =>
              Promise.resolve(plan.steps[0]?.operationLabel === 'Quarantine'),
          });
          const found = await agent.call('erp_query', {
            queryId: `${inspection}_list`,
            arguments: {
              search:
                receipt.values['northstar.app:field.goods_receipt_number'],
            },
          });
          assert.equal(found.isError, false, JSON.stringify(found.content));
          assert.deepEqual(
            (found.content as { records: { recordId: string }[] }).records.map(
              (record) => record.recordId,
            ),
            [header.recordId],
          );
          const plan = await agent.call('erp_plan', {
            intents: [
              {
                operationId: `${inspection}_action_quarantine`,
                target: header.recordId,
              },
            ],
          });
          assert.equal(plan.isError, false, JSON.stringify(plan.content));
          assert.equal(agent.approvals.at(-1)?.riskClass, 'needsYes');
          assert.equal(agent.approvals.at(-1)?.by, 'person');
          const executed = await agent.call('erp_execute', {
            planId: (plan.content as { planId: string }).planId,
            executionIdempotencyKey: 'inspection-quarantine',
          });
          assert.equal(
            executed.isError,
            false,
            JSON.stringify(executed.content),
          );
          const current = await world.read(inspection, header.recordId);
          assert.equal(
            current.values[
              `northstar.app:derived_state_field.machine.${inspection}`
            ],
            `northstar.app:state.${inspection}_quarantined`,
          );
          const afterMovements = await world.list(
            'northstar.app:query.inventory_movement_list',
          );
          assert.deepEqual(
            afterMovements.map((row) => row.recordId),
            beforeMovements.map((row) => row.recordId),
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
