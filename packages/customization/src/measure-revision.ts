import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MeasureRevisionSchema,
  ReportFilterV2Schema,
  ReportOperatorSchema,
  type MeasureRevision,
} from '@north-star/canonical-model';
import type { ReportCatalogSource } from '../../canonical-model/src/declared-report.js';
import {
  measureBodyProblem,
  reportBindingProblemV2,
  reportDigestV2,
  resolveReportChoicesV2,
} from '../../canonical-model/src/declared-report-v2.js';
import {
  declaredListSurface,
  predecessorOf,
  type ReportTarget,
} from './report-revision.js';

/** A reusable named measure (ADR-0089 "What a report declares", Measure). A
 * trial revision runs on authorized data through the report reader and
 * confers nothing; an approved revision covers exactly the contract that was
 * trialled; reports bind it by stable ID and contract digest. */
export const AddMeasureRevisionSchema = MeasureRevisionSchema.extend({
  kind: z.literal('addMeasureRevision'),
  schemaVersion: z.literal('v6'),
  version: z.literal('measure-revision/v1'),
  label: z.string().trim().min(1).max(240),
  status: z.enum(['trial', 'approved', 'retired']),
});
type ReportOperatorId = MeasureRevision['measureId'];
export type MeasurePatch = z.infer<typeof AddMeasureRevisionSchema>;

export const MeasureDraftSchema = z.strictObject({
  listSurfaceId: z.string(),
  label: z.string().trim().min(1).max(240),
  status: z.enum(['trial', 'approved', 'retired']),
  measureId: z.string().optional(),
  // Omitted to approve or retire the current candidate exactly as trialled.
  operator: ReportOperatorSchema.optional(),
  filters: z.array(ReportFilterV2Schema).max(16).optional(),
});

export function measureSurfaceId(id: string) {
  return id.replace(':measure.custom_', ':surface.custom_measure_');
}

export function draftMeasure(
  target: ReportTarget,
  label: string,
  status: MeasurePatch['status'],
  operator?: z.infer<typeof ReportOperatorSchema>,
  measureId?: string,
  filters: z.infer<typeof MeasureDraftSchema>['filters'] = [],
): MeasurePatch {
  const previous = target.namedMeasures.find(
    (m) => m.revision.measureId === measureId,
  );
  if (
    (measureId && (!previous || previous.lifecycle === 'retired')) ||
    (!previous && status !== 'trial')
  )
    throw new Error(
      measureId
        ? 'This measure revision is unavailable.'
        : 'Trial a new measure before approving it.',
    );
  const id =
    measureId ??
    target.source.entityId.split(':')[0] + ':measure.custom_' + randomUUID();
  const body = operator
    ? resolveReportChoicesV2(target, {
        grain: target.grain,
        dimensions: [],
        filters: filters ?? [],
        measures: [
          {
            kind: 'inline',
            measureId: id as ReportOperatorId,
            label,
            operator,
          },
        ],
        outputs: [{ kind: 'table' }],
      })
    : previous?.revision.body;
  if (!body || typeof body === 'string')
    throw new Error(
      'Choose a reportable operand: ' + (body ?? 'no measure definition'),
    );
  return AddMeasureRevisionSchema.parse({
    kind: 'addMeasureRevision',
    schemaVersion: 'v6',
    version: 'measure-revision/v1',
    measureId: id,
    label,
    status,
    revisionId: randomUUID(),
    predecessorDigest: previous ? predecessorOf(previous.revision) : null,
    contractDigest: reportDigestV2(body),
    body,
  });
}

export function applyMeasureRevision(
  def: ReportCatalogSource & { surfaces: Record<string, unknown>[] },
  patch: MeasurePatch,
  identityOnly: boolean,
): string | null {
  const namespace = patch.body.source.entityId.split(':')[0]!;
  if (!patch.measureId.startsWith(namespace + ':measure.custom_'))
    return patch.measureId;
  const shape = measureBodyProblem(patch.measureId, patch.body);
  if (shape) return shape;
  const surfaceId = measureSurfaceId(patch.measureId);
  const current = def.surfaces.find((s) => s.surfaceId === surfaceId);
  const prior = current?.measure as MeasureRevision | undefined;
  if (current && (!prior || current.lifecycle === 'retired'))
    return patch.measureId;
  if (
    (prior ? predecessorOf(prior) : null) !== patch.predecessorDigest ||
    (prior &&
      prior.body.source.listSurfaceId !== patch.body.source.listSurfaceId)
  )
    return patch.measureId;
  // Approval and retirement cover exactly the candidate already released.
  if (
    patch.status !== 'trial' &&
    (!prior || prior.contractDigest !== patch.contractDigest)
  )
    return patch.measureId;
  if (reportDigestV2(patch.body) !== patch.contractDigest)
    return patch.measureId;
  if (patch.status !== 'retired' && !identityOnly) {
    const invalid = reportBindingProblemV2(def, patch.body);
    if (invalid) return invalid;
  }
  const owner =
    def.surfaces.find((s) => s.surfaceId === patch.body.source.listSurfaceId) ??
    current;
  if (!owner) return patch.body.source.listSurfaceId;
  const { measureId, revisionId, contractDigest, predecessorDigest, body } =
    patch;
  const surface = declaredListSurface(
    def,
    owner,
    surfaceId,
    patch.label,
    patch.status === 'retired' ? 'retired' : 'active',
    body.source.listSurfaceId,
    {
      measure: {
        measureId,
        revisionId,
        contractDigest,
        predecessorDigest,
        status:
          patch.status === 'retired'
            ? (prior?.status ?? 'trial')
            : patch.status,
        body,
      },
    },
  );
  if (!surface) return patch.body.source.listSurfaceId;
  if (current) def.surfaces[def.surfaces.indexOf(current)] = surface;
  else def.surfaces.push(surface);
  return null;
}
