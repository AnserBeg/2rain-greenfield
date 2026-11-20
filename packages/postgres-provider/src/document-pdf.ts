import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DocumentRequestError } from '../../runtime/src/document-gateway.js';

export interface DocumentPdfInput {
  readonly name: string;
  readonly identity: string | null;
  readonly paper: 'A4' | 'LETTER';
  readonly ink: string;
  readonly accent: string;
  readonly logoDataUri: string | null;
  readonly pageNumbers: boolean;
  readonly blocks: ReadonlyArray<
    | { readonly kind: 'heading' | 'text'; readonly text: string }
    | {
        readonly kind: 'table';
        readonly title: string;
        readonly columns: readonly string[];
        readonly rows: ReadonlyArray<readonly string[]>;
      }
  >;
}

export const DOCUMENT_PDF_MAX_BYTES = 1024 * 1024;
const resolvePackage = createRequire(import.meta.url).resolve;

export async function renderDocumentPdf(
  input: DocumentPdfInput,
  signal: AbortSignal,
): Promise<Buffer> {
  const result = await runRenderer(input, signal);
  if (
    !(result instanceof Uint8Array) ||
    !result.length ||
    result.length > DOCUMENT_PDF_MAX_BYTES
  )
    throw renderRefusal();
  return Buffer.from(result);
}

/** Exercise the guest using the same Wasm boundary as a render. */
export async function probeDocumentPdfNetwork(signal: AbortSignal) {
  return runRenderer(null, signal);
}

async function runRenderer(
  input: DocumentPdfInput | null,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024)
    throw renderRefusal();
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(
    new URL(`./document-pdf-worker.${extension}`, import.meta.url),
    {
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 40, stackSizeMb: 2 },
      workerData: {
        engine: pathToFileURL(resolvePackage('quickjs-emscripten')).href,
        pdfkit: resolvePackage('pdfkit/js/pdfkit.standalone.js'),
        input,
        outputLimit: DOCUMENT_PDF_MAX_BYTES,
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(renderRefusal()), 18_000);
      worker.once('message', resolve);
      worker.once('error', () => reject(renderRefusal()));
      worker.once('exit', () => reject(renderRefusal()));
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    clearTimeout(timer);
    await worker.terminate();
  }
}

function renderRefusal() {
  return new DocumentRequestError(
    422,
    'The template could not produce a PDF within the rendering limits.',
  );
}
