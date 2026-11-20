import { DOCUMENT_RESPONSE_MILLISECONDS } from '../../canonical-model/src/documents.js';
import type { RequestRuntimeView } from './request-runtime-view.js';

export interface DocumentTarget {
  readonly surfaceId: string;
  readonly recordId: string;
  readonly companyId: string | null;
}

export interface DocumentMetadata {
  readonly linkId: string;
  readonly versionId: string;
  readonly fieldId: string | null;
  readonly categoryId: string | null;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteLength: number;
}

export interface DocumentUpload {
  readonly retryKey: string;
  readonly fieldId: string | null;
  readonly categoryId: string | null;
  readonly fileName: string;
  readonly contentType: string;
}

export class DocumentRequestError extends Error {
  readonly code = 'DOCUMENT_REQUEST_REFUSED';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DocumentDeadline {
  readonly signal: AbortSignal;
  /** Throws on cancellation or expiry, even if the event loop delayed the timer. */
  remainingMilliseconds(): number;
  readonly beginPublicationCommit?: (() => void) | undefined;
}

export function documentDeadline(
  signal = new AbortController().signal,
  now = () => performance.now(),
  beginPublicationCommit?: () => void,
): DocumentDeadline {
  const expires = now() + DOCUMENT_RESPONSE_MILLISECONDS;
  return {
    signal,
    beginPublicationCommit,
    remainingMilliseconds() {
      signal.throwIfAborted();
      const remaining = expires - now();
      if (remaining <= 0)
        throw new DocumentRequestError(408, 'The file response expired.');
      return Math.ceil(remaining);
    },
  };
}

export const DOCUMENT_PAGE_SIZE = 50;

export interface DocumentGateway {
  readonly scannerLabel: string | null;
  generate?(
    view: RequestRuntimeView,
    target: DocumentTarget,
    templateId: string,
    retryKey: string,
    signal: AbortSignal,
    deadline?: DocumentDeadline,
  ): Promise<DocumentMetadata>;
  previewTemplate?(
    view: RequestRuntimeView,
    target: DocumentTarget,
    templateId: string,
    signal: AbortSignal,
    deadline?: DocumentDeadline,
  ): Promise<Buffer>;
  list(
    view: RequestRuntimeView,
    target: DocumentTarget,
    page?: { after: string | null; limit: number },
    deadline?: DocumentDeadline,
  ): Promise<readonly DocumentMetadata[]>;
  read(
    view: RequestRuntimeView,
    target: DocumentTarget,
    linkId: string,
    versionId: string,
    deliver: (metadata: DocumentMetadata, bytes: Buffer) => void,
    deadline?: DocumentDeadline,
  ): Promise<void>;
  upload(
    view: RequestRuntimeView,
    target: DocumentTarget,
    upload: DocumentUpload,
    receive: (maximumBytes: number) => Promise<Buffer>,
    signal: AbortSignal,
    deadline?: DocumentDeadline,
  ): Promise<DocumentMetadata>;
}
