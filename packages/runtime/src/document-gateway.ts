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

export interface DocumentGateway {
  readonly scannerLabel: string | null;
  list(
    view: RequestRuntimeView,
    target: DocumentTarget,
  ): Promise<readonly DocumentMetadata[]>;
  read(
    view: RequestRuntimeView,
    target: DocumentTarget,
    linkId: string,
    versionId: string,
    deliver: (metadata: DocumentMetadata, bytes: Buffer) => void,
  ): Promise<void>;
  upload(
    view: RequestRuntimeView,
    target: DocumentTarget,
    upload: DocumentUpload,
    receive: (maximumBytes: number) => Promise<Buffer>,
    signal: AbortSignal,
  ): Promise<DocumentMetadata>;
}
