import type { DocumentPostingEngine } from './document-posting.js';
import { LEDGER_DOCUMENT_POSTING_ENGINE } from './ledger-document-posting.js';

/**
 * The registered document-posting engines. A block naming any other
 * capability is refused at compile and at release load. An engine joins with
 * one row here and its own declaration file.
 */
export const DOCUMENT_POSTING_ENGINES: readonly DocumentPostingEngine[] =
  Object.freeze([LEDGER_DOCUMENT_POSTING_ENGINE]);
