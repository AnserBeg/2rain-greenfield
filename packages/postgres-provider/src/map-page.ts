import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  MapViewportSchema,
  MERCATOR_LIMIT,
  mapExtent,
  SurfaceMapSchema,
  type SurfaceMap,
} from '@north-star/canonical-model';
import type {
  SemanticQueryExecutionRequest,
  SemanticRecordDto,
  SemanticQueryResultEnvelope,
} from '../../runtime/src/semantic-query-gateway.js';

const bindings = new WeakMap<object, Map<string, SurfaceMap>>();
export const mapPageInput = z.strictObject({
  surfaceId: z.string(),
  revisionId: z.uuid(),
  companyId: z.uuid(),
  route: z.string().max(180).optional(),
  day: z.iso.date().optional(),
  area: MapViewportSchema.optional(),
  cursor: z.uuid().optional(),
});
export function mapPageBinding(request: SemanticQueryExecutionRequest) {
  const input = mapPageInput.parse(
    (request.arguments as Record<string, unknown>).mapPage,
  );
  const m = request.view.projections.surface.payload;
  if (
    m === null ||
    typeof m !== 'object' ||
    !('surfaces' in m) ||
    !Array.isArray(m.surfaces)
  )
    throw new Error('The Map selection is unavailable.');
  let available = bindings.get(m);
  if (!available) {
    available = new Map();
    for (const s of (m as { surfaces: readonly Record<string, unknown>[] })
      .surfaces)
      if (s.archetype === 'map' && s.lifecycle === 'active')
        available.set(String(s.surfaceId), SurfaceMapSchema.parse(s.map));
    bindings.set(m, available);
  }
  const map = available.get(input.surfaceId);
  if (
    !map ||
    map.body.listQueryId !== request.definition.queryId ||
    map.revisionId !== input.revisionId ||
    map.body.entityId !== request.definition.sourceEntityId ||
    request.legalEntityReadScope?.legalEntityIds.length !== 1 ||
    request.legalEntityReadScope.legalEntityIds[0] !== input.companyId ||
    Boolean(input.day) !== (map.body.defaultScope.kind === 'day') ||
    (input.route !== undefined && !map.body.group)
  )
    throw new Error('The Map selection is unavailable.');
  return { map, input };
}
type Point = { latitude: number; longitude: number };
export interface MapCandidate {
  record: SemanticRecordDto;
  group: string | null;
  ordered: boolean;
  ordinal: number;
}
type Located = MapCandidate & {
  point: Point | null;
  source: string;
};
const anchors = new Map<string, { context: string; last: string }>();
function newAnchor(context: string, last: string) {
  while (anchors.size >= 2048) anchors.delete(anchors.keys().next().value!);
  const key = randomUUID();
  anchors.set(key, { context, last });
  return key;
}
export async function finishMapPage(
  client: PoolClient,
  request: SemanticQueryExecutionRequest,
  candidates: readonly MapCandidate[],
): Promise<SemanticQueryResultEnvelope> {
  const { map, input } = mapPageBinding(request),
    b = map.body,
    company = input.companyId;
  const pageSize = Math.min(100, request.definition.maximumResultCount);
  const page = (
    rows: Located[],
    meta: {
      partial: boolean;
      hasNext?: string;
      restarted?: boolean;
      installationId?: string;
      display?: 'browser' | 'raster';
    },
  ) => ({
    kind: 'semanticQueryResult' as const,
    schemaVersion: 'northstar.semantic-query-result/v1' as const,
    outcome: 'exact' as const,
    queryId: request.definition.queryId,
    records: rows.map((r) => r.record),
    unsupportedReason: null,
    mapCoverage: {
      ...meta,
      revisionId: map.revisionId,
      pageSize,
      stops: rows.map((r) => ({
        recordId: r.record.recordId,
        group: r.group,
        ordinal: r.ordered ? r.ordinal : null,
        point: r.point,
        source: r.source,
      })),
    },
  });
  if (candidates.length > 512) return page([], { partial: true });
  const addresses = candidates.map((r) => {
    const address = r.record.values[b.addressFieldId];
    return address as {
      revision?: string;
      pin?: { latitude: string; longitude: string };
    } | null;
  });
  // One runtime-role statement for the installation and all authorized address revisions.
  const result = await client.query<{
    installation_id: string;
    provider: 'google' | 'fake';
    record_id: string | null;
    latitude: string | null;
    longitude: string | null;
  }>(
    `
    WITH installed AS MATERIALIZED (
      SELECT installation_id,provider FROM platform.address_installations() WHERE company_id=$1
    ), located AS (
      SELECT ids.record_id, p.latitude,p.longitude FROM installed i
      CROSS JOIN unnest($2::uuid[],$3::uuid[]) ids(record_id,revision)
      CROSS JOIN LATERAL platform.address_pin($1,i.installation_id,$4,ids.record_id,$5,ids.revision) p
      WHERE p.usable AND p.state='ready'
    ) SELECT i.installation_id,i.provider,p.* FROM installed i LEFT JOIN located p ON true`,
    [
      company,
      candidates.map((r) => r.record.recordId),
      addresses.map((a) => a?.revision ?? null),
      b.entityId,
      b.addressFieldId,
    ],
  );
  const installationId = result.rows[0]?.installation_id;
  const browserDisplay = result.rows[0]?.provider === 'google';
  const pins = new Map(
    result.rows
      .filter((r) => r.record_id && r.latitude !== null && r.longitude !== null)
      .map((r) => [
        r.record_id,
        { latitude: Number(r.latitude), longitude: Number(r.longitude) },
      ]),
  );
  const located: Located[] = candidates.map((c, i) => {
    const user = addresses[i]?.pin;
    const point = user
      ? { latitude: Number(user.latitude), longitude: Number(user.longitude) }
      : (pins.get(c.record.recordId) ?? null);
    return {
      ...c,
      point: point && Math.abs(point.latitude) <= MERCATOR_LIMIT ? point : null,
      source: !point
        ? 'Location unavailable'
        : Math.abs(point.latitude) > MERCATOR_LIMIT
          ? 'Outside map coverage'
          : user
            ? 'User pin'
            : browserDisplay
              ? 'Google Maps'
              : 'Demo Maps',
    };
  });
  const area = input.area && mapExtent(input.area);
  const filtered = located.filter(
    (r) =>
      !area ||
      (r.point &&
        r.point.longitude >= area.west &&
        r.point.longitude <= area.east &&
        r.point.latitude >= area.south &&
        r.point.latitude <= area.north),
  );
  const view = request.view;
  const context = createHash('sha256')
    .update(
      JSON.stringify([
        view.tenantId,
        view.environmentId,
        company,
        view.principalId,
        view.entryPolicyVersion,
        view.pointer.fence,
        view.release.contentHash,
        input.surfaceId,
        map.revisionId,
        input.day,
        input.route,
        input.area,
        installationId,
        located.map((r) => [r.record.recordId, r.record.revision, r.point]),
      ]),
    )
    .digest('hex');
  const anchor = input.cursor && anchors.get(input.cursor);
  const valid = anchor && anchor.context === context;
  const start = valid
    ? filtered.findIndex((r) => r.record.recordId === anchor.last) + 1
    : 0;
  const rows = filtered.slice(start, start + pageSize);
  return page(rows, {
    partial: false,
    ...(installationId && {
      installationId,
      display: browserDisplay ? 'browser' : 'raster',
    }),
    ...(input.cursor && !valid && { restarted: true }),
    ...(start + rows.length < filtered.length && {
      hasNext: newAnchor(context, rows.at(-1)!.record.recordId),
    }),
  });
}
