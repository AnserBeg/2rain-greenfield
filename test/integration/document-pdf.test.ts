import assert from 'node:assert/strict';
import test from 'node:test';
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
