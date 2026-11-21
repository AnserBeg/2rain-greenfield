import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import type * as QuickJS from 'quickjs-emscripten';
import type { DocumentPdfInput } from './document-pdf.js';

const data = workerData as {
  engine: string;
  pdfkit: string;
  input: DocumentPdfInput | null;
  outputLimit: number;
};

const { newQuickJSWASMModule, newVariant, RELEASE_SYNC }: typeof QuickJS =
  await import(data.engine);
const pages = 1024;
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
const isolate = await newQuickJSWASMModule(
  newVariant(RELEASE_SYNC, { wasmMemory: memory }),
);
if (isolate.getWasmMemory() !== memory)
  throw new Error('Wasm memory ceiling unavailable');
const runtime = isolate.newRuntime();
runtime.setMemoryLimit(48 * 1024 * 1024);
runtime.setMaxStackSize(512 * 1024);
const guest = runtime.newContext();
const pdfkit = await readFile(data.pdfkit, 'utf8');
const deadline = performance.now() + 4_000;
runtime.setInterruptHandler(() => performance.now() >= deadline);

const noNetworkProbe = `
  (() => {
    const attempts = [
      () => fetch('http://127.0.0.1/'),
      () => new WebSocket('ws://127.0.0.1/'),
      () => require('node:net'),
      () => process.getBuiltinModule('node:net'),
    ];
    return JSON.stringify(attempts.map((invoke) => {
      try { invoke(); return false; } catch (error) { return error instanceof ReferenceError; }
    }));
  })()
`;

try {
  // Provision neither host globals nor callbacks. These shims run within Wasm.
  const source = `
    const jobs = [];
    globalThis.setTimeout = (fn) => { jobs.push(fn); return fn; };
    globalThis.clearTimeout = (fn) => {
      const i = jobs.indexOf(fn);
      if (i >= 0) jobs.splice(i, 1);
    };
    globalThis.TextEncoder = class {
      encode(text) { return Uint8Array.from(unescape(encodeURIComponent(text)), c => c.charCodeAt(0)); }
    };
    globalThis.TextDecoder = class {
      decode(bytes) { return decodeURIComponent(escape(Array.from(bytes, c => String.fromCharCode(c)).join(''))); }
    };
    ${pdfkit}
    ${data.input === null ? noNetworkProbe : renderSource(data.input, data.outputLimit)}
  `;
  const result = guest.evalCode(source, 'document-pdf.js', { type: 'global' });
  if (result.error) {
    result.error.dispose();
    throw new Error('PDF guest refused');
  }
  try {
    const value = JSON.parse(guest.getString(result.value)) as unknown;
    if (data.input === null) {
      parentPort!.postMessage(value);
    } else {
      if (
        !Array.isArray(value) ||
        value.some((part) => typeof part !== 'string')
      )
        throw new Error('PDF guest result');
      const bytes = Buffer.concat(
        value.map((part: string) => Buffer.from(part, 'base64')),
      );
      if (!bytes.length || bytes.length > data.outputLimit)
        throw new Error('PDF byte limit');
      parentPort!.postMessage(bytes);
    }
  } finally {
    result.value.dispose();
  }
} finally {
  guest.dispose();
  runtime.dispose();
}

function renderSource(input: DocumentPdfInput, outputLimit: number): string {
  return `
    (() => {
      const input = JSON.parse(${JSON.stringify(JSON.stringify(input))});
      const pdf = new PDFDocument({
        size: input.paper, margin: 46, bufferPages: true, autoFirstPage: false,
        info: { CreationDate: new Date(0), ModDate: new Date(0), Title: input.name },
      });
      const chunks = [];
      let bytes = 0;
      let ended = false;
      pdf.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > ${outputLimit}) throw new Error('PDF byte limit');
        chunks.push(chunk.toString('base64'));
      });
      pdf.on('end', () => { ended = true; });

      let y;
      let pages = 0;
      pdf.on('pageAdded', () => {
        if (++pages > 20) throw new Error('PDF page limit');
      });
      function page() {
        pdf.addPage();
        y = 46;
      }
      page();
      const width = pdf.page.width - 92;
      const bottom = pdf.page.height - 60;
      function font(size, bold, color) {
        pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
      }
      function text(value, size, bold, color) {
        font(size, bold, color);
        const height = pdf.heightOfString(value, { width });
        if (height > bottom - 46) throw new Error('Text exceeds a full page');
        if (y + height > bottom) page();
        pdf.text(value, 46, y, { width });
        y += height + 8;
      }
      if (input.logoDataUri) {
        pdf.image(input.logoDataUri, 46, y, { fit: [140, 48] });
        y += 54;
      }
      text(input.name, 20, true, input.ink);
      if (input.identity !== null) text(input.identity, 12, true, input.accent);

      function table(block) {
        const gap = 8;
        const column = (width - gap * (block.columns.length - 1)) / block.columns.length;
        function height(values) {
          return Math.max(...values.map((value) => pdf.heightOfString(value, { width: column })));
        }
        function cells(values, height, bold) {
          font(10, bold, bold ? input.accent : input.ink);
          values.forEach((value, index) => {
            pdf.text(value, 46 + index * (column + gap), y, { width: column });
          });
          y += height + 6;
        }
        font(10, true, input.accent);
        const headerHeight = height(block.columns);
        if (y + headerHeight + 42 > bottom) page();
        text(block.title, 13, true, input.accent);
        cells(block.columns, headerHeight, true);
        for (const row of block.rows) {
          font(10, false, input.ink);
          const rowHeight = height(row);
          if (rowHeight + headerHeight + 12 > bottom - 46) throw new Error('Table row exceeds a page');
          if (y + rowHeight > bottom) {
            page();
            cells(block.columns, headerHeight, true);
          }
          cells(row, rowHeight, false);
        }
      }
      for (const block of input.blocks) {
        if (block.kind === 'table') table(block);
        else if (block.kind === 'heading') text(block.text, 14, true, input.accent);
        else text(block.text, 11, false, input.ink);
      }
      if (input.pageNumbers) {
        for (let index = 0; index < pages; index++) {
          pdf.switchToPage(index);
          font(9, false, input.ink);
          pdf.text(String(index + 1) + ' / ' + String(pages), 46, pdf.page.height - 58,
            { width, align: 'right', lineBreak: false });
        }
      }
      pdf.end();
      for (let count = 0; jobs.length; count++) {
        if (count >= 8192) throw new Error('PDF job limit');
        jobs.shift()();
      }
      if (!ended) throw new Error('PDF stream did not complete');
      return JSON.stringify(chunks);
    })()
  `;
}
