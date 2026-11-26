import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ReportRevisionSchema,
  ReportChoicesSchema,
  SURFACE_SLOTS,
  canonicalizeAndHash,
  type MeasureRevision,
  type ReportChoices,
  type ReportRevision,
} from '@north-star/canonical-model';
import {
  resolveAnyReportChoices,
  reportDigest,
  reportBindingProblem,
  type ReportCatalogSource,
} from '../../canonical-model/src/declared-report.js';
import {
  reportOfferV2,
  type ReportOfferV2,
} from '../../canonical-model/src/declared-report-v2.js';

/** R5: a v1 body rides member v1; any slice-2 variant rides member v2. */
export const AddReportRevisionSchema = ReportRevisionSchema.extend({
  kind: z.literal('addReportRevision'),
  schemaVersion: z.literal('v6'),
  version: z.enum(['report-revision/v1', 'report-revision/v2']),
  label: z.string().trim().min(1).max(240),
  status: z.enum(['active', 'retired']),
});
export type ReportPatch = z.infer<typeof AddReportRevisionSchema>;
export interface ReportTarget extends ReportOfferV2 {
  reports: { revision: ReportRevision; label: string; lifecycle: string }[];
  /** Named measures on this source, trial or approved, current revision. */
  namedMeasures: {
    revision: MeasureRevision;
    label: string;
    lifecycle: string;
  }[];
}
export function reportTargets(def: ReportCatalogSource): ReportTarget[] {
  return def.surfaces.flatMap((s) => {
    const offer = reportOfferV2(def, String(s.surfaceId));
    if (!offer) return [];
    const on = (body: { source: { listSurfaceId: string } }) =>
      body.source.listSurfaceId === s.surfaceId;
    return [
      {
        ...offer,
        reports: def.surfaces.flatMap((row) => {
          const revision = row.report as ReportRevision | undefined;
          return revision && on(revision.body)
            ? [
                {
                  revision,
                  label: String(row.label),
                  lifecycle: String(row.lifecycle ?? 'active'),
                },
              ]
            : [];
        }),
        namedMeasures: def.surfaces.flatMap((row) => {
          const revision = row.measure as MeasureRevision | undefined;
          return revision && on(revision.body)
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
        ? resolveAnyReportChoices(target, choices)
        : previous?.revision.body;
  if (!body || typeof body === 'string')
    throw new Error(
      'Choose reportable operands: ' + (body ?? 'no report definition'),
    );
  return AddReportRevisionSchema.parse({
    kind: 'addReportRevision',
    schemaVersion: 'v6',
    version:
      body.version === 'grouped-report/v2'
        ? 'report-revision/v2'
        : 'report-revision/v1',
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
export function predecessorOf(r: {
  revisionId: string;
  contractDigest: string;
  reportId?: string;
  measureId?: string;
}) {
  // A rename produces a different revision even when every operand stays the same.
  return canonicalizeAndHash(
    r.measureId
      ? {
          measureId: r.measureId,
          revisionId: r.revisionId,
          contractDigest: r.contractDigest,
        }
      : {
          reportId: r.reportId,
          revisionId: r.revisionId,
          contractDigest: r.contractDigest,
        },
  ).contentHash;
}
export function reportSurfaceId(id: string) {
  return id.replace(':report.custom_', ':surface.custom_report_');
}
type Def = ReportCatalogSource & { surfaces: Record<string, unknown>[] };
/** The contextual List a report or measure page lives on, beside its source. */
export function declaredListSurface(
  def: Def,
  owner: Record<string, unknown>,
  surfaceId: string,
  label: string,
  lifecycle: string,
  listSurfaceId: string,
  member: Record<string, unknown>,
) {
  const content = (owner.slots as { content: unknown }[])[0]?.content;
  if (!content) return null;
  return {
    kind: 'surfaceDefinition',
    schemaVersion: 'v6',
    archetype: 'list',
    surfaceId,
    lifecycle,
    label,
    module: owner.module,
    dataSource: owner.dataSource,
    workspace: {
      membership: 'contextual',
      // A line collection is itself contextual: its page sits beside the
      // workspace List that owns that collection.
      ownerSurfaceId:
        (owner.workspace as { membership?: string; ownerSurfaceId?: string })
          ?.membership === 'contextual'
          ? (owner.workspace as { ownerSurfaceId: string }).ownerSurfaceId
          : listSurfaceId,
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
    ...member,
  };
}
export function applyReportRevision(
  def: Def,
  patch: ReportPatch,
  identityOnly: boolean,
): string | null {
  const namespace = patch.body.source.entityId.split(':')[0]!;
  if (!patch.reportId.startsWith(namespace + ':report.custom_'))
    return patch.reportId;
  // R5: the member version names the body vocabulary it carries.
  if (
    (patch.version === 'report-revision/v2') !==
      (patch.body.version === 'grouped-report/v2') ||
    patch.body.dimensions.length === 0
  )
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
  const { reportId, revisionId, contractDigest, predecessorDigest, body } =
    patch;
  const surface = declaredListSurface(
    def,
    owner,
    surfaceId,
    patch.label,
    patch.status,
    body.source.listSurfaceId,
    {
      report: { reportId, revisionId, contractDigest, predecessorDigest, body },
    },
  );
  if (!surface) return patch.body.source.listSurfaceId;
  if (current) def.surfaces[def.surfaces.indexOf(current)] = surface;
  else def.surfaces.push(surface);
  return null;
}
/** Revisions a later revision of the same report or measure supersedes. */
export function supersededReports(
  chain: readonly { kind: string; patches?: readonly unknown[] }[],
) {
  const latest = new Map<string, string>();
  const superseded = new Set<string>();
  for (const change of chain)
    for (const item of (change.kind === 'changeSet'
      ? change.patches!
      : [change]) as {
      kind: string;
      reportId?: string;
      measureId?: string;
      revisionId: string;
    }[]) {
      if (
        item.kind !== 'addReportRevision' &&
        item.kind !== 'addMeasureRevision'
      )
        continue;
      const id = item.reportId ?? item.measureId!;
      const previous = latest.get(id);
      if (previous) superseded.add(previous);
      latest.set(id, item.revisionId);
    }
  return superseded;
}
