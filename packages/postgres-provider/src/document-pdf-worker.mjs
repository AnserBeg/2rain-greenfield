import { Buffer } from 'node:buffer';
import process from 'node:process';
import { PDFCatalog, PDFParser, PDFPageLeaf, PDFPageTree } from 'pdf-lib';

const disallowedPdfNames = new Set([
  'A',
  'AA',
  'AcroForm',
  'AF',
  'Annot',
  'Annots',
  'EmbeddedFile',
  'EmbeddedFiles',
  'Encrypt',
  'Filespec',
  'GoToE',
  'GoToR',
  'ImportData',
  'JavaScript',
  'JS',
  'Launch',
  'Movie',
  'ObjStm',
  'OpenAction',
  'Prev',
  'RichMedia',
  'Sound',
  'SubmitForm',
  'URI',
  'XFA',
  'XRef',
  'XRefStm',
]);

async function validatePdf(bytes) {
  if (!/^%PDF-1\.[0-7][\r\n]/u.test(bytes.subarray(0, 16).toString('latin1')))
    throw new Error('PDF header');
  const trailer =
    /startxref[\r\n\t ]+(\d{1,8})[\r\n\t ]+%%EOF[\r\n\t ]*$/u.exec(
      bytes.subarray(-128).toString('latin1'),
    );
  if (
    !trailer ||
    bytes.toString('ascii', Number(trailer[1]), Number(trailer[1]) + 4) !==
      'xref'
  )
    throw new Error('PDF cross-reference table');
  // A single classic PDF revision keeps the parser out of compressed object
  // streams and prevents an earlier object from supplying active content.
  const source = bytes.toString('latin1');
  if (source.indexOf('%%EOF') !== source.lastIndexOf('%%EOF'))
    throw new Error('incremental PDF');
  for (const match of source.matchAll(/\/([a-zA-Z0-9#_.-]{1,128})/gu)) {
    const name = match[1].replace(/#([0-9a-f]{2})/giu, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (disallowedPdfNames.has(name))
      throw new Error('unsupported PDF content');
  }
  const context = await new BoundedPdfParser(
    bytes,
    Infinity,
    true,
  ).parseDocument();
  if (context.trailerInfo.Encrypt) throw new Error('encrypted PDF');
  const catalog = context.lookup(context.trailerInfo.Root, PDFCatalog);
  const visited = new Set();
  let pages = 0;
  function visit(node, depth) {
    if (depth > 64 || visited.has(node) || visited.size >= 10000)
      throw new Error('PDF page tree');
    visited.add(node);
    if (node instanceof PDFPageLeaf) {
      if (++pages > 1000) throw new Error('PDF page count');
      return;
    }
    if (!(node instanceof PDFPageTree)) throw new Error('PDF page node');
    const kids = node.Kids();
    for (let i = 0; i < kids.size(); i++)
      visit(context.lookup(kids.get(i)), depth + 1);
  }
  visit(catalog.Pages(), 0);
  if (!pages) throw new Error('empty PDF');
}

// pdf-lib 1.17 dispatches every dictionary/array value through parseObject,
// including trailer values. Refuse before descending or storing another object.
class BoundedPdfParser extends PDFParser {
  depth = 0;
  objects = 0;
  nodes = 0;
  pages = 0;

  parseDict() {
    const value = super.parseDict();
    if (value instanceof PDFPageLeaf && ++this.pages > 1000)
      throw new Error('PDF page count');
    return value;
  }

  parseIndirectObject() {
    if (++this.objects > 10000) throw new Error('PDF object count');
    return super.parseIndirectObject();
  }

  parseObject() {
    if (++this.depth > 64 || ++this.nodes > 200000)
      throw new Error('PDF structural limit');
    try {
      return super.parseObject();
    } finally {
      this.depth--;
    }
  }

  parseName() {
    const name = super.parseName();
    if (disallowedPdfNames.has(name.decodeText()))
      throw new Error('unsupported PDF content');
    return name;
  }
}

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error('PDF size');
    chunks.push(chunk);
  }
  await validatePdf(Buffer.concat(chunks, size));
} catch {
  process.exitCode = 1;
}
