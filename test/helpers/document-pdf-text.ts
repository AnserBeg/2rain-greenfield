import { inflateSync } from 'node:zlib';

// The renderer uses PDFKit's built-in WinAnsi fonts and Flate page streams.
export function documentPdfText(bytes: Buffer): string {
  const pdf = bytes.toString('latin1');
  return [
    ...pdf.matchAll(
      /<<[^<>]*?\/Length (\d+)[^<>]*?\/Filter \/FlateDecode[^<>]*?>>\r?\nstream\r?\n/gu,
    ),
  ]
    .flatMap((match) => {
      const start = match.index + match[0].length;
      const stream = inflateSync(
        bytes.subarray(start, start + Number(match[1])),
      ).toString('latin1');
      return [...stream.matchAll(/\[([^[\]]*)\]\s+TJ\b/gu)].map((text) =>
        [...text[1]!.matchAll(/<([a-f0-9]+)>/giu)]
          .map((part) => Buffer.from(part[1]!, 'hex').toString('latin1'))
          .join(''),
      );
    })
    .join('\n');
}
