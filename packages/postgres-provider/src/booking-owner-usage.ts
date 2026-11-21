import {
  BOOKING_USAGE_BINDING,
  BOOKING_USAGE_QUERY_READER,
} from '@north-star/canonical-model';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  trustedContextForRequestRuntimeView,
  type ImmutableJsonValue,
} from '../../runtime/src/request-runtime-view.js';
import type { SemanticQueryReadModelExecutor } from '../../runtime/src/semantic-query-gateway.js';
import { withTrustedRequestRead } from './request-context.js';

const cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u);
const window = z.strictObject({
  from: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  afterCursor: cursor.optional(),
  highWater: cursor.optional(),
  pageSize: z.int().min(1).max(128).optional(),
});

export function bookingOwnerUsageReadModel(
  pool: Pool,
): SemanticQueryReadModelExecutor {
  return async ({ view, definition, result, arguments: args }) => {
    if (result.outcome !== 'exact') return result;
    const row = result.records[0];
    const binding = definition.readModel;
    if (
      !row ||
      result.records.length !== 1 ||
      binding?.binding !== BOOKING_USAGE_BINDING ||
      !binding.resultFields.usage ||
      definition.queryType !== 'get' ||
      // The floor is the highest catalog feature, so it may sit above usage.
      (view.projections.query.requiredRuntimeCapability?.minimumVersion ?? 0) <
        BOOKING_USAGE_QUERY_READER ||
      !args ||
      Array.isArray(args) ||
      typeof args !== 'object' ||
      !('usage' in args)
    )
      throw new Error('booking.invalidUsageBinding');
    const page = window.parse(args.usage);
    const usage = await withTrustedRequestRead(
      pool,
      trustedContextForRequestRuntimeView(view),
      async (client) => {
        const { rows } = await client.query<{ usage: ImmutableJsonValue }>(
          'SELECT platform.booking_owner_usage($1,$2,$3,$4,$5,$6,$7,$8,$9) AS usage',
          [
            view.release.releaseId,
            view.pointer.fence,
            definition.queryId,
            row.recordId,
            page.from,
            page.until,
            page.afterCursor ?? null,
            page.highWater ?? null,
            page.pageSize ?? 64,
          ],
        );
        return rows[0]!.usage;
      },
    );
    return {
      ...result,
      records: [
        {
          ...row,
          values: { ...row.values, [binding.resultFields.usage]: usage },
        },
      ],
    };
  };
}

/** Runs on the consuming writer's transaction so its comparison holds until commit. */
export async function bookingOwnerCursorFence(
  client: PoolClient,
  releaseId: string,
  fence: number,
  owners: readonly { readonly queryId: string; readonly recordId: string }[],
) {
  const { rows } = await client.query<{
    result: {
      schemaVersion: 'booking.ownerCursorFence/v1';
      owners: {
        ownerRef: { entityId: string; recordId: string };
        cursor: string;
      }[];
    };
  }>('SELECT platform.booking_owner_cursor_fence($1,$2,$3) AS result', [
    releaseId,
    fence,
    JSON.stringify(owners),
  ]);
  return rows[0]!.result;
}
