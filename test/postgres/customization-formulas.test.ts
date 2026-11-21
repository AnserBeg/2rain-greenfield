import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applicationBeforeStockCountWorkflow } from '../helpers/application-before-stock-count-workflow.js';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { fieldComparisonValidationDraft } from '../../packages/customization/src/validation-draft.js';
import { worldOver } from '../agent/agent-world.js';
import {
  archivedRuntimeRead,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

test(
  'a guarded location reads its declared parent under current policy and refuses a literal-only reader',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-relation-guard',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-relation-guard',
          compiledApplication: applicationBeforeStockCountWorkflow().release,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const world = worldOver(app.runtime, String(connection.database));
          const fieldId = 'northstar.app:field.location_name';
          const relationId = 'northstar.app:relation.location_parent';
          const parentId = randomUUID();
          const create = (
            code: string,
            name: string,
            recordId = randomUUID(),
            inside?: string,
          ) =>
            world.invoke(
              'location_create',
              {
                recordId,
                relations: inside ? { [relationId]: inside } : {},
                values: {
                  [fieldId]: name,
                  'northstar.app:field.location_code': code,
                  'northstar.app:field.location_type':
                    'northstar.app:option.store',
                },
              },
              { actor: 'buyer' },
            );
          const parentName = 'Highland warehouse';
          assert.equal(
            (await create('PARENT-GUARD', parentName, parentId)).outcome,
            'succeeded',
          );
          const target = (
            await opened.service.targets()
          ).validationTargets?.find(
            ({ entityId }) => entityId === 'northstar.app:entity.location',
          );
          assert.ok(target);
          const message = 'Use a different name from the parent location.';
          const patch = fieldComparisonValidationDraft(target, {
            fieldId,
            otherFieldId: fieldId,
            relationId,
            operator: 'notEqual',
            message,
          });
          const draft = await opened.service.draft(patch, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await withArchivedCustomizationRuntime(
            '87e7444cdd7b12c7980164129574bfbbed45a4ed',
            async (run) => {
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              await opened.service.activate(draft.patchId);
              const refused = await read();
              assert.equal(refused.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refused.message ?? '',
                /operation-catalog requires version 4/u,
              );
            },
          );
          await assert.rejects(
            () => create('DUPLICATE-GUARD', parentName, randomUUID(), parentId),
            {
              code: 'MODULE_VALIDATION_REFUSED',
              message,
            },
          );
          assert.equal(
            (
              await create(
                'MATCH-GUARD',
                'Highland bin',
                randomUUID(),
                parentId,
              )
            ).outcome,
            'succeeded',
          );
          assert.equal(
            (await create('ABSENT-GUARD', parentName)).outcome,
            'succeeded',
          );
          const revoked = await pool.query(
            `UPDATE platform.current_policy_permission_grants
              SET revoked_at = transaction_timestamp()
            WHERE tenant_id = $1 AND environment_id = $2
              AND permission_id = $3 AND revoked_at IS NULL`,
            [
              app.runtime.identity.tenantId,
              app.runtime.identity.environmentId,
              'northstar.app:permission.location_read',
            ],
          );
          assert.ok(revoked.rowCount);
          await assert.rejects(
            () =>
              create('PRIVATE-GUARD', 'Highland annex', randomUUID(), parentId),
            {
              code: 'MODULE_VALIDATION_OPERAND_UNREADABLE',
            },
          );
          await opened.service.rollback();
          assert.equal(
            (await create('ROLLBACK-GUARD', parentName, randomUUID(), parentId))
              .outcome,
            'succeeded',
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
