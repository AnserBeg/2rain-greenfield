import { requestDeadline } from '../../../packages/runtime/src/request-deadline.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthenticatedRequestRuntimeEntryAdapter } from '@north-star/runtime/request-runtime-view';
import {
  DocumentRequestError,
  DOCUMENT_PAGE_SIZE,
  documentDeadline,
  type DocumentGateway,
} from '../../../packages/runtime/src/document-gateway.js';
import { DOCUMENT_RESPONSE_MILLISECONDS } from '../../../packages/canonical-model/src/documents.js';

export function mountDocumentHttp(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  gateway: DocumentGateway,
  responseMilliseconds = DOCUMENT_RESPONSE_MILLISECONDS,
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
    let publicationCommitting = false;
    const deadline = documentDeadline(
      controller.signal,
      undefined,
      () => {
        publicationCommitting = true;
      },
      responseMilliseconds,
    );
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
      if (publicationCommitting) return;
      controller.abort(
        new DocumentRequestError(408, 'The file response expired.'),
      );
      if (response.headersSent) response.destroy();
      else documentError(response, 408, 'The file response expired.');
    }, responseMilliseconds);
    const { remainingMilliseconds } = deadline;

    try {
      const target = {
        surfaceId: url.searchParams.get('surface') ?? '',
        recordId: url.searchParams.get('record') ?? '',
        companyId: url.searchParams.get('company'),
      };
      await requestDeadline.run(remainingMilliseconds, () =>
        entry.run({ headers: request.headers }, async (view) => {
          remainingMilliseconds();
          if (generate) {
            const metadata = await generate.call(
              gateway,
              view,
              target,
              url.searchParams.get('template') ?? '',
              url.searchParams.get('retryKey') ?? '',
              controller.signal,
              deadline,
            );
            if (!publicationCommitting) remainingMilliseconds();
            return json(response, 201, metadata);
          }
          if (templatePreview) {
            const bytes = await templatePreview.call(
              gateway,
              view,
              target,
              url.searchParams.get('template') ?? '',
              controller.signal,
              deadline,
            );
            remainingMilliseconds();
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
                  remainingMilliseconds();
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
              deadline,
            );
            if (!publicationCommitting) remainingMilliseconds();
            return json(response, 201, metadata);
          }
          if (list) {
            const after = url.searchParams.get('after');
            const limit = Number(
              url.searchParams.get('limit') ?? DOCUMENT_PAGE_SIZE,
            );
            if (
              !Number.isInteger(limit) ||
              limit < 1 ||
              limit > DOCUMENT_PAGE_SIZE
            )
              throw new DocumentRequestError(400, 'Invalid file page size.');
            const rows = await gateway.list(
              view,
              target,
              { after, limit: limit + 1 },
              deadline,
            );
            if (rows.length > limit)
              response.setHeader(
                'x-next-document-link',
                rows[limit - 1]!.linkId,
              );
            remainingMilliseconds();
            return json(response, 200, rows.slice(0, limit));
          }
          await gateway.read(
            view,
            target,
            url.searchParams.get('link') ?? '',
            url.searchParams.get('version') ?? '',
            (metadata, bytes) => {
              remainingMilliseconds();
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
            deadline,
          );
        }),
      );
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
