import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ReportRevisionSchema,
  ReportChoicesSchema,
  SURFACE_SLOTS,
  type ReportChoices,
  type ReportRevision,
} from '@north-star/canonical-model';
import {
  reportOffer,
  resolveReportChoices,
  reportDigest,
  reportBindingProblem,
  type ReportCatalogSource,
  type ReportOffer,
} from '../../canonical-model/src/declared-report.js';

export const AddReportRevisionSchema = ReportRevisionSchema.extend({
  kind: z.literal('addReportRevision'),
  schemaVersion: z.literal('v6'),
  version: z.literal('report-revision/v1'),
  label: z.string().trim().min(1).max(240),
  status: z.enum(['active', 'retired']),
});
export type ReportPatch = z.infer<typeof AddReportRevisionSchema>;
export interface ReportTarget extends ReportOffer {
  reports: { revision: ReportRevision; label: string; lifecycle: string }[];
}
export function reportTargets(def: ReportCatalogSource): ReportTarget[] {
  return def.surfaces.flatMap((s) => {
    const offer = reportOffer(def, String(s.surfaceId));
    if (!offer) return [];
    return [
      {
        ...offer,
        reports: def.surfaces.flatMap((row) => {
          const revision = row.report as ReportRevision | undefined;
          return revision && revision.body.source.listSurfaceId === s.surfaceId
            ? [
                {
                  revision,
                  label: String(row.label),
                  lifecycle: String(row.lifecycle ?? 'active'),
                },
              ]
            : [];
        }),
      },
    ];
  });
}
/** Both visual authoring and the AI tool bind a proposal to current source contracts. */
export const ReportDraftSchema = z.strictObject({
  listSurfaceId: z.string(),
  label: z.string().trim().min(1).max(240),
  status: z.enum(['active', 'retired']),
  reportId: z.string().optional(),
  choices: ReportChoicesSchema.optional(),
});
export function draftReport(
  target: ReportTarget,
  label: string,
  choices: ReportChoices | undefined,
  reportId?: string,
  status: ReportPatch['status'] = 'active',
): ReportPatch {
  const previous = target.reports.find((r) => r.revision.reportId === reportId);
  if (
    (reportId && (!previous || previous.lifecycle === 'retired')) ||
    (!previous && status === 'retired')
  )
    throw new Error('This report revision is unavailable.');
  const body =
    status === 'retired'
      ? previous!.revision.body
      : choices
        ? resolveReportChoices(target, choices)
        : previous?.revision.body;
  if (!body || typeof body === 'string')
    throw new Error(
      'Choose reportable operands: ' + (body ?? 'no report definition'),
    );
  return AddReportRevisionSchema.parse({
    kind: 'addReportRevision',
    schemaVersion: 'v6',
    version: 'report-revision/v1',
    reportId:
      reportId ??
      target.source.entityId.split(':')[0] + ':report.custom_' + randomUUID(),
    label,
    status,
    revisionId: randomUUID(),
    predecessorDigest: previous ? predecessorOf(previous.revision) : null,
    contractDigest: reportDigest(body),
    body,
  });
}
function predecessorOf(r: ReportRevision) {
  // A rename produces a different revision even when every operand stays the same.
  return canonicalizeAndHash({
    reportId: r.reportId,
    revisionId: r.revisionId,
    contractDigest: r.contractDigest,
  }).contentHash;
}
import { canonicalizeAndHash } from '@north-star/canonical-model';
export function reportSurfaceId(id: string) {
  return id.replace(':report.custom_', ':surface.custom_report_');
}
export function applyReportRevision(
  def: ReportCatalogSource & { surfaces: Record<string, unknown>[] },
  patch: ReportPatch,
  identityOnly: boolean,
): string | null {
  const namespace = patch.body.source.entityId.split(':')[0]!;
  if (!patch.reportId.startsWith(namespace + ':report.custom_'))
    return patch.reportId;
  const surfaceId = reportSurfaceId(patch.reportId);
  const current = def.surfaces.find((s) => s.surfaceId === surfaceId);
  const prior = current?.report as ReportRevision | undefined;
  if (current && (!prior || current.lifecycle === 'retired'))
    return patch.reportId;
  if (
    (prior ? predecessorOf(prior) : null) !== patch.predecessorDigest ||
    (prior &&
      prior.body.source.listSurfaceId !== patch.body.source.listSurfaceId)
  )
    return patch.reportId;
  if (
    patch.status === 'retired' &&
    (!prior || prior.contractDigest !== patch.contractDigest)
  )
    return patch.reportId;
  if (reportDigest(patch.body) !== patch.contractDigest) return patch.reportId;
  if (patch.status === 'active' && !identityOnly) {
    const invalid = reportBindingProblem(def, patch.body);
    if (invalid) return invalid;
  }
  const owner =
    def.surfaces.find((s) => s.surfaceId === patch.body.source.listSurfaceId) ??
    current;
  if (!owner) return patch.body.source.listSurfaceId;
  const content = (owner.slots as { content: unknown }[])[0]?.content;
  if (!content) return patch.body.source.listSurfaceId;
  const { reportId, revisionId, contractDigest, predecessorDigest, body } =
    patch;
  const surface = {
    kind: 'surfaceDefinition',
    schemaVersion: 'v6',
    archetype: 'list',
    surfaceId,
    lifecycle: patch.status,
    label: patch.label,
    module: owner.module,
    dataSource: owner.dataSource,
    workspace: {
      membership: 'contextual',
      ownerSurfaceId: body.source.listSurfaceId,
      ...((owner.workspace as { entry?: unknown })?.entry
        ? {
            entry: (owner.workspace as { entry: unknown }).entry,
          }
        : {}),
    },
    slots: SURFACE_SLOTS.list.map((slot, i) => ({
      kind: 'surfaceSlot',
      schemaVersion: 'v6',
      slot,
      orderKey: (i + 1) * 10,
      slotId:
        surfaceId.replace(':surface.', ':slot.') + '_' + slot.toLowerCase(),
      content,
    })),
    statusRoles: [],
    report: { reportId, revisionId, contractDigest, predecessorDigest, body },
  };
  if (current) def.surfaces[def.surfaces.indexOf(current)] = surface;
  else def.surfaces.push(surface);
  return null;
}
export function supersededReports(
  chain: readonly { kind: string; patches?: readonly unknown[] }[],
) {
  const latest = new Map<string, string>();
  const superseded = new Set<string>();
  for (const change of chain)
    for (const item of (change.kind === 'changeSet'
      ? change.patches!
      : [change]) as ReportPatch[]) {
      if (item.kind !== 'addReportRevision') continue;
      const previous = latest.get(item.reportId);
      if (previous) superseded.add(previous);
      latest.set(item.reportId, item.revisionId);
    }
  return superseded;
}
