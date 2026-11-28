import type { DocumentPostingEngine } from './document-posting.js';

/**
 * The ledger engine's document-posting declaration (ADR-0093, DOCUMENT-POSTING
 * slice 1): a manual or opening journal staged as a header and its lines. The
 * header states the entry's kind, currency, civil date and an optional memo;
 * each line its number, the account's code within the header's company, the
 * side and the amount as an exact number, which the ledger converts to whole
 * minor units of the currency (refusing anything else). The capability is the
 * ledger's own `general_ledger` name.
 */
export const LEDGER_GENERAL_LEDGER_CAPABILITY =
  'northstar.ledger:capability.general_ledger' as const;

export const LEDGER_DOCUMENT_POSTING_ENGINE: DocumentPostingEngine =
  Object.freeze({
    capabilityId: LEDGER_GENERAL_LEDGER_CAPABILITY,
    roles: Object.freeze({
      kind: Object.freeze({
        scope: 'header',
        valueClass: 'choice',
        required: true,
        options: Object.freeze(['manual', 'opening']),
      }),
      currency: Object.freeze({
        scope: 'header',
        valueClass: 'text',
        required: true,
      }),
      date: Object.freeze({
        scope: 'header',
        valueClass: 'calendarDate',
        required: true,
      }),
      memo: Object.freeze({
        scope: 'header',
        valueClass: 'text',
        required: false,
      }),
      number: Object.freeze({
        scope: 'line',
        valueClass: 'integer',
        required: true,
      }),
      account: Object.freeze({
        scope: 'line',
        valueClass: 'text',
        required: true,
      }),
      side: Object.freeze({
        scope: 'line',
        valueClass: 'choice',
        required: true,
        options: Object.freeze(['debit', 'credit']),
      }),
      amount: Object.freeze({
        scope: 'line',
        valueClass: 'exactNumber',
        required: true,
      }),
    }),
  } as const satisfies DocumentPostingEngine);
