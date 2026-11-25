import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import type {
  RecordTemplateLibrary,
  TemplateLibraryTarget,
} from '../../packages/runtime/src/record-template-library.js';
import {
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { rolePool } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';

export async function raceFirstAssignmentWithRetirement(
  pool: pg.Pool,
  databaseUrl: string,
  view: RequestRuntimeView,
  library: RecordTemplateLibrary,
  target: TemplateLibraryTarget,
  context: string,
  revision: { templateId: string; revisionId: string },
  first: 'assign' | 'retire',
) {
  const runtime = rolePool(databaseUrl, 'north_star_runtime', 1);
  const common = [
    target.company,
    view.release.releaseId,
    view.pointer.fence,
    target.form,
    context,
    0,
    revision.revisionId,
  ];
  const retire = [
    view.release.releaseId,
    view.pointer.fence,
    revision.templateId,
    1,
  ];
  let competing: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await withTrustedRequestTransaction(
      runtime,
      trustedContextForRequestRuntimeView(view),
      async (client) => {
        const {
          rows: [holder],
        } = await client.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        );
        await client.query(
          first === 'assign'
            ? 'SELECT platform.assign_record_template($1,$2,$3,$4,$5,$6,$7)'
            : 'SELECT platform.retire_record_template($1,$2,$3,$4)',
          first === 'assign' ? common : retire,
        );
        competing = Promise.allSettled([
          first === 'assign'
            ? library.retire(view, revision.templateId, 1)
            : library.assign(view, target, context, 0, revision.revisionId),
        ]);
        const deadline = performance.now() + 8000;
        do {
          const {
            rows: [s],
          } = await pool.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT FROM pg_locks l
          WHERE locktype='advisory' AND NOT granted AND $1=ANY(pg_blocking_pids(l.pid))) AS blocked`,
            [holder!.pid],
          );
          if (s!.blocked) return;
          await delay(15);
        } while (performance.now() < deadline);
        assert.fail(
          'the competing writer did not wait for the same company library lock',
        );
      },
    );
    const [result] = await competing!;
    assert.equal(result!.status, first === 'assign' ? 'fulfilled' : 'rejected');
    assert.equal(
      await library.assignmentVersion(view, target, context),
      first === 'assign' ? 1 : 0,
    );
    await assert.rejects(
      library.assign(
        view,
        target,
        context,
        first === 'assign' ? 1 : 0,
        revision.revisionId,
      ),
      /template.revisionUnavailable/u,
    );
  } finally {
    await competing;
    await runtime.end();
  }
}
