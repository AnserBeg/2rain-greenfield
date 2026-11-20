import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  normalizeApplicationPackage,
  parseVersionedAuthoredApplicationPackageJson,
} from '@north-star/canonical-model';
import { compileDocumentTemplates } from '../../packages/compiler/src/document-templates.js';
import type { DocumentTemplateRevision } from '../../packages/canonical-model/src/document-template-schema.js';
import { readCivilDate } from '../../packages/runtime/src/civil-date.js';
import { documentPdfText } from '../helpers/document-pdf-text.js';
import {
  probeDocumentPdfNetwork,
  renderDocumentPdf,
  type DocumentPdfInput,
} from '../../packages/postgres-provider/src/document-pdf.js';
import { validateDocumentContent } from '../../packages/postgres-provider/src/document-content.js';

test('PDFKit emits deterministic admissible PDF bytes inside the document isolate', async () => {
  const input: DocumentPdfInput = {
    name: 'North Star',
    identity: 'PO-014',
    paper: 'LETTER',
    ink: '#131a24',
    accent: '#1d4165',
    logoDataUri:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg==',
    pageNumbers: true,
    blocks: [
      { kind: 'heading', text: 'Purchase order' },
      { kind: 'text', text: 'Ready to send' },
      {
        kind: 'table',
        title: 'Lines',
        columns: ['Item', 'Quantity'],
        rows: [['Large box', '4']],
      },
    ],
  };
  const signal = new AbortController().signal;
  const first = await renderDocumentPdf(input, signal);
  assert.match(
    documentPdfText(first),
    /Large box/u,
    'saved PDF lost its line cell',
  );
  assert.deepEqual(await renderDocumentPdf(input, signal), first);
  assert.notDeepEqual(
    await renderDocumentPdf({ ...input, identity: 'PO-015' }, signal),
    first,
  );
  assert.equal(
    await validateDocumentContent(first, 'application/pdf'),
    'application/pdf',
  );
});

test('the PDF guest cannot use fetch, WebSocket, require or process to reach a network', async () => {
  assert.deepEqual(
    await probeDocumentPdfNetwork(new AbortController().signal),
    [true, true, true, true],
  );
});

test('the renderer refuses the twenty-first PDF page', async () => {
  const input: DocumentPdfInput = {
    name: 'Page bound',
    identity: null,
    paper: 'LETTER',
    ink: '#131a24',
    accent: '#1d4165',
    logoDataUri: null,
    pageNumbers: true,
    blocks: Array.from({ length: 21 }, () => ({
      kind: 'text',
      text: Array.from({ length: 37 }, () => 'Bounded output').join('\n'),
    })),
  };
  const signal = new AbortController().signal;
  const twenty = await renderDocumentPdf(
    { ...input, blocks: input.blocks.slice(0, 20) },
    signal,
  );
  assert.equal(/\/Count (\d+)\b/u.exec(twenty.toString('latin1'))?.[1], '20');
  await assert.rejects(renderDocumentPdf(input, signal), { status: 422 });
});

test('template money uses its declared currency and rejects a text override', () => {
  const parsed = parseVersionedAuthoredApplicationPackageJson(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  );
  assert.ok(parsed.languageVersion === 'v6');
  const definition = normalizeApplicationPackage(parsed);
  const ns = 'northstar.app:';
  const amountId = ns + 'field.purchase_order_freight_amount';
  const fields = definition.fields.map((field) =>
    field.fieldId === amountId
      ? {
          ...field,
          fieldType: {
            kind: 'moneyFieldType' as const,
            currencyCode: 'USD' as const,
            minorUnit: 2,
            precision: 18,
            scale: 2,
            representation: 'canonicalString' as const,
            schemaVersion: 'v6' as const,
          },
        }
      : field,
  );
  const revision: DocumentTemplateRevision = {
    schemaVersion: 'v6',
    entityId: ns + 'entity.purchase_order',
    templateId: ns + 'template.test_money',
    revisionId: ns + 'revision.test_money',
    documentKind: 'purchaseOrder',
    label: 'Purchase order',
    headerQueryId: ns + 'query.purchase_order_get',
    identityFieldId: ns + 'field.purchase_order_number',
    currencyFieldId: null,
    format: {
      locale: 'en-CA',
      timeZone: 'UTC',
      currency: 'USD',
      dateStyle: 'medium',
      numberGrouping: true,
      pageSize: 'LETTER',
    },
    layout: [{ kind: 'field', fieldId: amountId, label: 'Freight' }],
    pageNumbers: false,
  };
  const compile = (template: DocumentTemplateRevision) =>
    compileDocumentTemplates({
      ...definition,
      fields,
      documentTemplateRevisions: [template],
      documentTemplatePointers: [
        {
          schemaVersion: 'v6',
          templateId: template.templateId,
          activeRevisionId: template.revisionId,
        },
      ],
    });
  assert.ok(compile(revision).templates);
  assert.match(
    compile({ ...revision, currencyFieldId: ns + 'field.purchase_order_notes' })
      .message ?? '',
    /currency declared by the field type/u,
  );
  assert.match(
    compile({ ...revision, format: { ...revision.format, currency: 'CAD' } })
      .message ?? '',
    /currency declared by the field type/u,
  );
});

test('civil dates accept date fields serialized at ISO midnight', () => {
  const expected = '2026-11-18T00:00:00.000Z';
  assert.equal(
    readCivilDate('dateFieldType', '2026-11-18')?.toISOString(),
    expected,
  );
  assert.equal(
    readCivilDate('dateFieldType', expected)?.toISOString(),
    expected,
  );
  assert.equal(
    readCivilDate('dateTimeFieldType', expected)?.toISOString(),
    expected,
  );
  assert.equal(readCivilDate('dateFieldType', '2026-02-30'), null);
  assert.equal(
    readCivilDate('dateTimeFieldType', '2026-11-18T12:00:00.000Z'),
    null,
  );
});
