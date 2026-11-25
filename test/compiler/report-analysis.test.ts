import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import {
  DEFAULT_AGE_BANDS,
  ReportChoicesSchema,
  ageBandProblem,
  businessDateOf,
  calendarKey,
  evaluateReportFacts,
  type ReportMeasureSpec,
} from '../../packages/canonical-model/src/index.js';
import {
  DECLARED_REPORT_READER,
  type RegisteredReport,
  type ReportCatalogSource,
} from '../../packages/canonical-model/src/declared-report.js';
import {
  REPORT_ANALYSIS_READER,
  REPORT_MEASURE_READER,
} from '../../packages/canonical-model/src/declared-report-v2.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import {
  applyCustomizationPatches,
  compileInSandbox,
  CustomizationPatchSchema,
  parseSerializedRelease,
  serializeRelease,
  type CustomizationPatch,
} from '../../packages/customization/src/index.js';
import {
  draftReport,
  reportTargets,
  type ReportTarget,
} from '../../packages/customization/src/report-revision.js';
import { draftMeasure } from '../../packages/customization/src/measure-revision.js';
import { projectionPayload } from './helpers.js';
import {
  AGING_AS_OF,
  AGING_DUE_DATES,
  reportAnalysisTypes,
} from '../helpers/report-analysis-fixture.js';

const asOf = { businessDate: AGING_AS_OF, zone: 'UTC', boundary: '00:00:00' };
const due = AGING_DUE_DATES;
const count: ReportMeasureSpec = { id: 'count', operator: 'count', scale: 0 };

test('the packet aging fixture lands 1, 2, 2, 2 and 1 with day 90 in exactly one band', () => {
  const result = evaluateReportFacts(
    [
      {
        operand: 'due',
        kind: 'age',
        type: 'date',
        bands: DEFAULT_AGE_BANDS,
      },
    ],
    [count],
    [...due.map((d) => ({ due: d })), { due: null }],
    asOf,
  );
  assert.deepEqual(
    result.groups.map((g) => [g.keys[0], g.cells[0]!.value]),
    [
      ['not_due', '1'],
      ['d0_30', '2'],
      ['d31_60', '2'],
      ['d61_90', '2'],
      ['d91', '1'],
      [null, '1'],
    ],
  );
  // R8: a finite dimension emits typed zero rows for its empty members.
  const empty = evaluateReportFacts(
    [{ operand: 'due', kind: 'age', type: 'date', bands: DEFAULT_AGE_BANDS }],
    [
      count,
      { id: 'least', operator: 'min', operand: 'due', scale: 0, type: 'date' },
    ],
    [],
    asOf,
  );
  assert.equal(empty.groups.length, 6);
  assert.ok(
    empty.groups.every(
      (g) => g.cells[0]!.value === '0' && g.cells[1]!.value === null,
    ),
  );
  assert.equal(empty.totals[0]!.cells[1]!.value, null);
  assert.equal(ageBandProblem(DEFAULT_AGE_BANDS), null);
  const gap = DEFAULT_AGE_BANDS.map((b) =>
    b.bandId === 'd31_60' ? { ...b, from: 32 } : b,
  );
  assert.match(ageBandProblem(gap)!, /gap or overlaps/u);
  const overlap = DEFAULT_AGE_BANDS.map((b) =>
    b.bandId === 'd31_60' ? { ...b, from: 30 } : b,
  );
  assert.match(ageBandProblem(overlap)!, /gap or overlaps/u);
});

test('periods use the company calendar: Monday weeks, civil dates never zoned, instants through DST at the day boundary', () => {
  assert.equal(calendarKey('2026-11-22', 'week'), '2026-11-16');
  assert.equal(calendarKey('2026-11-23', 'week'), '2026-11-23');
  assert.equal(calendarKey('2026-11-30', 'month'), '2026-11');
  const toronto = {
    businessDate: '2026-11-20',
    zone: 'America/Toronto',
    boundary: '04:00:00',
  };
  // A civil-encoded instant is its UTC date whatever the company zone.
  assert.equal(
    businessDateOf('2026-11-01T00:00:00.000Z', 'instant', 'civilDate', toronto),
    '2026-11-01',
  );
  // Fall back, 2026-11-01: 07:30Z is 02:30 EST, before the 04:00 boundary.
  assert.equal(
    businessDateOf('2026-11-01T07:30:00.000Z', 'instant', 'instant', toronto),
    '2026-10-31',
  );
  assert.equal(
    businessDateOf('2026-11-01T09:30:00.000Z', 'instant', 'instant', toronto),
    '2026-11-01',
  );
  // Spring forward, 2026-03-08: 08:30Z is 04:30 EDT (after), 07:30Z is 03:30 EDT.
  assert.equal(
    businessDateOf('2026-03-08T08:30:00.000Z', 'instant', 'instant', toronto),
    '2026-03-08',
  );
  assert.equal(
    businessDateOf('2026-03-08T07:30:00.000Z', 'instant', 'instant', toronto),
    '2026-03-07',
  );
});

test('averages carry the exact ratio and their total is recomputed from sum and count; distinct totals come from the full set', () => {
  const avg: ReportMeasureSpec = {
    id: 'avg',
    operator: 'average',
    operand: 'v',
    scale: 2,
    type: 'decimal',
  };
  const distinct: ReportMeasureSpec = {
    id: 'd',
    operator: 'distinctCount',
    operand: 'who',
    scale: 0,
    type: 'text',
  };
  const facts = [
    { g: 'a', v: '1.00', who: 'x' },
    { g: 'a', v: '2.00', who: 'y' },
    { g: 'b', v: '10.00', who: 'x' },
    { g: 'b', v: null, who: 'x' },
  ];
  const r = evaluateReportFacts(
    [{ operand: 'g', kind: 'direct', type: 'text' }],
    [avg, distinct],
    facts,
    asOf,
  );
  assert.deepEqual(
    r.groups.map((g) => [g.keys[0], g.cells[0]!.value, g.cells[1]!.value]),
    [
      ['a', '1.50', '2'],
      ['b', '10.00', '1'],
    ],
  );
  // 13.00 / 3 rounds half-even to 4.33; the mean of group means would be 5.75,
  // and adding group distinct counts would give 3.
  assert.deepEqual(r.totals[0]!.cells[0], {
    measureId: 'avg',
    value: '4.33',
    exact: { sum: '13.00', count: 3 },
    recordsWithoutMeasure: 1,
  });
  assert.equal(r.totals[0]!.cells[1]!.value, '2');
  const half = evaluateReportFacts(
    [],
    [{ ...avg, scale: 0 }],
    [{ v: '1' }, { v: '2' }, { v: '3' }, { v: '4' }],
    asOf,
  );
  assert.equal(half.totals[0]!.cells[0]!.value, '2', '2.5 rounds to even');
});

// --- Releases --------------------------------------------------------------

const def = composedApplicationDefinition();
const app = parseCompiledApplication(
  JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
).application;
async function compileHead(chain: CustomizationPatch[]) {
  const result = await compileInSandbox({
    base: def,
    tip: serializeRelease(app),
    chain,
    acknowledgement: readUnboundPermissionAcknowledgementFor(
      'apps/web/release/app.authored.json',
      'northstar.app:package.application',
    ),
  });
  assert.ok(
    result.status === 'compiled',
    result.status === 'compiled' ? '' : JSON.stringify(result),
  );
  return parseSerializedRelease(result.steps.at(-1)!.release).compiled;
}
const floor = (compiled: Awaited<ReturnType<typeof compileHead>>) =>
  compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  )!.requiredRuntimeCapability.minimumVersion;
const registrations = (compiled: Awaited<ReturnType<typeof compileHead>>) =>
  projectionPayload<{ groupedReports: RegisteredReport[] }>(
    compiled,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ).groupedReports;
const targetFor = (catalog: unknown, query: string) =>
  reportTargets(catalog as ReportCatalogSource).find((t) =>
    t.source.queryId.endsWith(query),
  )!;
const invoices = targetFor(def, ':query.customer_invoice_list');
const field = (t: ReportTarget, end: string) =>
  t.fields.find((f) => f.operand.fieldId.endsWith(end))!.operand.fieldId;

test('slice-1 choices keep their v1 body, member and floor; an age dimension rides v2 at its own rung', async () => {
  const v1 = draftReport(
    invoices,
    'Balance by customer',
    ReportChoicesSchema.parse({
      grain: 'record',
      dimensions: [
        { kind: 'direct', fieldId: field(invoices, '_customer_party_id') },
      ],
      filters: [],
      measures: [
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_balance',
          label: 'Balance',
          operator: { kind: 'sum', fieldId: field(invoices, '_balance') },
        },
      ],
      outputs: [{ kind: 'table' }],
    }),
  );
  assert.equal(v1.version, 'report-revision/v1');
  assert.equal(v1.body.version, 'grouped-report/v1');
  assert.ok(!('links' in v1.body));
  const before = await compileHead([v1]);
  assert.ok(floor(before) >= DECLARED_REPORT_READER);
  assert.ok(floor(before) < REPORT_ANALYSIS_READER);
  assert.ok(!('links' in registrations(before)[0]!));

  const aging = draftReport(
    invoices,
    'Aging',
    ReportChoicesSchema.parse({
      dimensions: [
        {
          kind: 'age',
          fieldId: field(invoices, '_due_date'),
          bands: DEFAULT_AGE_BANDS,
          absentLabel: 'No due date',
        },
      ],
      filters: [],
      measures: [
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_count',
          label: 'Count',
          operator: { kind: 'count' },
        },
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_balance',
          label: 'Balance',
          operator: { kind: 'sum', fieldId: field(invoices, '_balance') },
        },
      ],
      outputs: [{ kind: 'table' }, { kind: 'csv' }],
    }),
  );
  assert.equal(aging.version, 'report-revision/v2');
  assert.equal(aging.body.version, 'grouped-report/v2');
  const compiled = await compileHead([aging]);
  assert.equal(floor(compiled), REPORT_ANALYSIS_READER);
  const [registration] = registrations(compiled);
  assert.deepEqual(registration!.links, []);
  assert.deepEqual(
    registration!.measures!.map((m) => m.operator.kind),
    ['count', 'sum'],
  );
  // R5: the member version names the body vocabulary, and an unknown variant
  // refuses the whole patch, inside a change set too.
  const mislabelled = { ...aging, version: 'report-revision/v1' as const };
  const applied = applyCustomizationPatches(
    def as unknown as Record<string, unknown>,
    [mislabelled],
  );
  assert.equal(applied.status, 'refused');
  const unknown = structuredClone(aging) as unknown as {
    body: { dimensions: { kind: string }[] };
  };
  unknown.body.dimensions[0]!.kind = 'quarter';
  assert.equal(CustomizationPatchSchema.safeParse(unknown).success, false);
  assert.equal(
    CustomizationPatchSchema.safeParse({
      kind: 'changeSet',
      patches: [v1, unknown],
    }).success,
    false,
  );
});

test('Invoice lines report one row per line with the invoice as required parent; a header balance summed per line refuses in preview', () => {
  const lines = targetFor(def, ':query.customer_invoice_line_list');
  assert.equal(lines.grain, 'line');
  const parent = lines.links.find((l) => l.parent)!;
  assert.ok(parent.link.required);
  assert.equal(parent.link.entityId, invoices.source.entityId);
  const via = parent.link.via;
  const balance = parent.fields.find((f) =>
    f.operand.fieldId.endsWith('_balance'),
  )!.operand;
  const choices = (operator: unknown) =>
    ReportChoicesSchema.parse({
      grain: 'line',
      dimensions: [{ kind: 'direct', fieldId: field(lines, '_item_id') }],
      filters: [],
      measures: [
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_lines',
          label: 'Lines',
          operator: { kind: 'count' },
        },
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_invoices',
          label: 'Invoices',
          operator,
        },
      ],
      outputs: [{ kind: 'table' }],
    });
  const report = draftReport(
    lines,
    'Lines and invoices',
    choices({ kind: 'distinctTargets', via }),
  );
  assert.equal(report.body.version, 'grouped-report/v2');
  assert.ok(report.body.version === 'grouped-report/v2');
  assert.equal(report.body.source.grain, 'line');
  assert.deepEqual(
    report.body.links.map((l) => [l.via, l.required]),
    [[via, true]],
  );
  // The header's invoice date carries no currency, so the fan-out rule alone
  // refuses its maximum per line.
  const invoiceDate = parent.fields.find((f) =>
    f.operand.fieldId.endsWith('_invoice_date'),
  )!.operand.fieldId;
  assert.throws(
    () =>
      draftReport(
        lines,
        'Fan-out',
        choices({ kind: 'max', fieldId: invoiceDate, via }),
      ),
    /would repeat once per line/u,
  );
  // A header balance is refused twice over: by the fan-out rule and because
  // its currency binding is not local to the line.
  assert.throws(
    () =>
      draftReport(
        lines,
        'Fan-out',
        choices({ kind: 'sum', fieldId: balance.fieldId, via }),
      ),
    /would repeat once per line/u,
  );
  // The same header balance is measurable at its own grain.
  assert.ok(balance.currency);
});

const tenantTypes = reportAnalysisTypes;

test('a tenant Inspection groups by a linked Site field, counts distinct sites, and an approved measure is reused by ID and contract', async () => {
  const applied = applyCustomizationPatches(
    def as unknown as Record<string, unknown>,
    [tenantTypes],
  );
  assert.ok(applied.status === 'applied', JSON.stringify(applied));
  const t = targetFor(applied.authored, ':query.custom_inspection_list');
  assert.equal(t.grain, 'record');
  const siteLink = t.links.find((l) =>
    l.link.entityId.endsWith('custom_site'),
  )!;
  assert.equal(siteLink.link.required, false);
  const region = siteLink.fields.find((f) =>
    f.operand.fieldId.endsWith('_region'),
  )!.operand;
  const score = field(t, '_score');
  const trial = draftMeasure(t, 'Average score', 'trial', {
    kind: 'average',
    fieldId: score as never,
  });
  // An approval is exactly the trialled candidate; a new measure cannot skip
  // the trial.
  assert.throws(
    () => draftMeasure(t, 'Skipped', 'approved', { kind: 'count' }),
    /Trial a new measure/u,
  );
  const afterTrial = applyCustomizationPatches(
    applied.authored as Record<string, unknown>,
    [trial],
  );
  assert.ok(afterTrial.status === 'applied', JSON.stringify(afterTrial));
  const t2 = targetFor(afterTrial.authored, ':query.custom_inspection_list');
  assert.equal(t2.measures.length, 0, 'a trial confers nothing on reports');
  const approve = draftMeasure(
    t2,
    'Average score',
    'approved',
    undefined,
    trial.measureId,
  );
  assert.equal(approve.contractDigest, trial.contractDigest);
  // A self-consistent approval of a different contract than the trial refuses.
  const tampered = draftMeasure(
    t2,
    'Average score',
    'approved',
    { kind: 'count' },
    trial.measureId,
  );
  assert.notEqual(tampered.contractDigest, trial.contractDigest);
  assert.equal(
    applyCustomizationPatches(afterTrial.authored as Record<string, unknown>, [
      tampered,
    ]).status,
    'refused',
  );
  const approved = applyCustomizationPatches(
    afterTrial.authored as Record<string, unknown>,
    [approve],
  );
  assert.ok(approved.status === 'applied');
  const t3 = targetFor(approved.authored, ':query.custom_inspection_list');
  assert.deepEqual(
    t3.measures.map((m) => [m.measureId, m.contractDigest]),
    [[trial.measureId, trial.contractDigest]],
  );
  const bound = (label: string) =>
    draftReport(
      t3,
      label,
      ReportChoicesSchema.parse({
        dimensions: [
          { kind: 'direct', fieldId: region.fieldId, via: region.via },
        ],
        filters: [],
        measures: [
          {
            kind: 'inline',
            measureId: 'northstar.app:measure.custom_sites',
            label: 'Sites',
            operator: { kind: 'distinctTargets', via: siteLink.link.via },
          },
          {
            kind: 'approved',
            measureId: trial.measureId,
            contractDigest: trial.contractDigest,
          },
        ],
        outputs: [{ kind: 'table' }],
      }),
    );
  const first = bound('By region');
  const second = bound('Again by region');
  const compiled = await compileHead([
    tenantTypes,
    trial,
    approve,
    first,
    second,
  ]);
  assert.equal(floor(compiled), REPORT_MEASURE_READER);
  const regs = registrations(compiled);
  const reports = regs.filter((r) => r.kind !== 'measure');
  assert.equal(reports.length, 2);
  for (const r of reports) {
    assert.deepEqual(
      r.links!.map((l) => [l.via, l.legalEntity]),
      [[siteLink.link.via, true]],
    );
    assert.deepEqual(r.measures![1], {
      measureId: trial.measureId,
      label: 'Average score',
      operator: { kind: 'average', fieldId: score },
      approved: { contractDigest: trial.contractDigest },
    });
  }
  assert.equal(regs.filter((r) => r.kind === 'measure').length, 1);
  // Retiring the measure while a report binds it refuses the release; retiring
  // the consumers in the same ordered change set admits it.
  const retire = draftMeasure(
    t3,
    'Average score',
    'retired',
    undefined,
    trial.measureId,
  );
  await assert.rejects(
    compileHead([tenantTypes, trial, approve, first, retire]),
    /REPORT_BINDING_UNAVAILABLE|REPORT_MEASURE_UNAVAILABLE|rejected|refused/u,
  );
  const withFirst = applyCustomizationPatches(
    approved.authored as Record<string, unknown>,
    [first],
  );
  assert.ok(withFirst.status === 'applied');
  const t4 = targetFor(withFirst.authored, ':query.custom_inspection_list');
  const retireFirst = draftReport(
    t4,
    'By region',
    undefined,
    first.reportId,
    'retired',
  );
  await compileHead([
    tenantTypes,
    trial,
    approve,
    first,
    CustomizationPatchSchema.parse({
      kind: 'changeSet',
      patches: [retireFirst, retire],
    }),
  ]);
  // A retired measure ID is never reused.
  const afterRetire = applyCustomizationPatches(
    approved.authored as Record<string, unknown>,
    [retire],
  );
  assert.ok(afterRetire.status === 'applied');
  const revived = {
    ...trial,
    predecessorDigest: null,
    revisionId: crypto.randomUUID(),
  };
  assert.equal(
    applyCustomizationPatches(afterRetire.authored as Record<string, unknown>, [
      revived,
    ]).status,
    'refused',
  );
});
