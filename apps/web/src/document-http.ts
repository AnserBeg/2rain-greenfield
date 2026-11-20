import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthenticatedRequestRuntimeEntryAdapter } from '@north-star/runtime/request-runtime-view';
import {
  DocumentRequestError,
  type DocumentGateway,
} from '../../../packages/runtime/src/document-gateway.js';
import { DOCUMENT_RESPONSE_MILLISECONDS } from '../../../packages/canonical-model/src/documents.js';

export function mountDocumentHttp(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  gateway: DocumentGateway,
) {
  let reads = 0;
  let writes = 0;

  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    sameOrigin: boolean,
  ) => {
    const mode = url.searchParams.get('mode');
    const upload = request.method === 'POST' && mode === 'upload';
    const generate =
      request.method === 'POST' && mode === 'generate' && gateway.generate;
    const templatePreview =
      request.method === 'GET' &&
      mode === 'template-preview' &&
      gateway.previewTemplate;
    const byteRead =
      request.method === 'GET' && (mode === 'download' || mode === 'preview');
    const list = request.method === 'GET' && mode === 'list';
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    response.setHeader('x-content-type-options', 'nosniff');
    const write = upload || Boolean(generate);
    const read = byteRead || Boolean(templatePreview);
    if (!(write || read || list) || (write && !sameOrigin)) {
      documentError(
        response,
        write ? 403 : 405,
        'This file request is unavailable.',
      );
      return;
    }
    if ((write && writes >= 2) || (read && reads >= 2)) {
      response.setHeader('retry-after', '1');
      documentError(response, 429, 'File transfers are busy. Try again.');
      return;
    }
    if (write) writes++;
    if (read) reads++;
    const controller = new AbortController();
    const expires = performance.now() + DOCUMENT_RESPONSE_MILLISECONDS;
    let settle: () => void;
    const responseDone = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const close = () => {
      controller.abort(
        new DocumentRequestError(408, 'The file response expired.'),
      );
      settle();
    };
    response.once('close', close);
    response.once('finish', () => settle());
    const timer = setTimeout(() => {
      controller.abort(
        new DocumentRequestError(408, 'The file response expired.'),
      );
      if (response.headersSent) response.destroy();
      else documentError(response, 408, 'The file response expired.');
    }, DOCUMENT_RESPONSE_MILLISECONDS);
    const assertDeadline = () => {
      controller.signal.throwIfAborted();
      if (performance.now() >= expires)
        throw new DocumentRequestError(408, 'The file response expired.');
    };

    try {
      const target = {
        surfaceId: url.searchParams.get('surface') ?? '',
        recordId: url.searchParams.get('record') ?? '',
        companyId: url.searchParams.get('company'),
      };
      await entry.run({ headers: request.headers }, async (view) => {
        assertDeadline();
        if (generate) {
          const metadata = await generate.call(
            gateway,
            view,
            target,
            url.searchParams.get('template') ?? '',
            url.searchParams.get('retryKey') ?? '',
            controller.signal,
          );
          assertDeadline();
          return json(response, 201, metadata);
        }
        if (templatePreview) {
          const bytes = await templatePreview.call(
            gateway,
            view,
            target,
            url.searchParams.get('template') ?? '',
            controller.signal,
          );
          assertDeadline();
          response.setHeader('content-type', 'application/pdf');
          response.setHeader('content-length', bytes.length);
          response.setHeader(
            'content-disposition',
            'inline; filename="template-preview.pdf"',
          );
          return response.end(bytes);
        }
        if (upload) {
          const metadata = await gateway.upload(
            view,
            target,
            {
              retryKey: url.searchParams.get('retryKey') ?? '',
              fieldId: url.searchParams.get('field'),
              categoryId: url.searchParams.get('category'),
              fileName: url.searchParams.get('fileName') ?? '',
              contentType:
                request.headers['content-type'] ?? 'application/octet-stream',
            },
            async (maximumBytes) => {
              const length = request.headers['content-length'];
              if (length && Number(length) > maximumBytes)
                throw new DocumentRequestError(
                  413,
                  'The file exceeds this upload limit.',
                );
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of request.iterator({
                destroyOnReturn: false,
              })) {
                assertDeadline();
                const bytes = Buffer.isBuffer(chunk)
                  ? chunk
                  : Buffer.from(chunk);
                size += bytes.length;
                if (size > maximumBytes)
                  throw new DocumentRequestError(
                    413,
                    'The file exceeds this upload limit.',
                  );
                chunks.push(bytes);
              }
              return Buffer.concat(chunks, size);
            },
            controller.signal,
          );
          assertDeadline();
          return json(response, 201, metadata);
        }
        if (list) {
          const rows = await gateway.list(view, target);
          assertDeadline();
          return json(response, 200, rows);
        }
        await gateway.read(
          view,
          target,
          url.searchParams.get('link') ?? '',
          url.searchParams.get('version') ?? '',
          (metadata, bytes) => {
            assertDeadline();
            const filename = encodeURIComponent(metadata.fileName).replaceAll(
              "'",
              '%27',
            );
            response.setHeader('content-type', metadata.contentType);
            response.setHeader('content-length', metadata.byteLength);
            response.setHeader(
              'content-disposition',
              `${mode === 'preview' ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
            );
            response.end(bytes);
          },
        );
      });
    } catch (error) {
      if (!response.headersSent) {
        const refusal =
          error instanceof DocumentRequestError
            ? error
            : new DocumentRequestError(
                404,
                'This attachment or record is unavailable.',
              );
        documentError(response, refusal.status, refusal.message);
      }
    } finally {
      await responseDone;
      clearTimeout(timer);
      response.off('close', close);
      if (write) writes--;
      if (read) reads--;
    }
  };
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function documentError(
  response: ServerResponse,
  status: number,
  message: string,
) {
  if (response.destroyed) return;
  response.setHeader('connection', 'close');
  json(response, status, { message });
}
