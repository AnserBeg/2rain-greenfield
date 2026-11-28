/**
 * OPEN-ITEM-1 slices 1 and 2: tenant-declared receivables, built by Customize
 * patches and then given the open-item role as data. A "fee note" is a
 * debit-side item with lines; a "receipt" is a line-less credit-side item
 * with an entered amount; a "credit note" is a separate credit-side document
 * with lines, in its own number series. A "receipt application" moves an
 * amount from one receipt to fee notes, a "credit application" from one
 * credit note to fee notes. No Customize member declares the role yet, so
 * the test edits the authored package the patches produced: the generated
 * issue and void transitions become the core's issue and void operations,
 * an application type's create becomes the core's apply and its archive the
 * core's unapply, and its other generic operations go (the type is
 * capability owned).
 *
 * Fee notes and receipts are a test case only: every block is general
 * (rule 17), and nothing here is code under packages/.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  canonicalize,
  normalizeApplicationPackage,
  OPEN_ITEM_APPLY_CAPABILITY,
  OPEN_ITEM_ISSUE_CAPABILITY,
  OPEN_ITEM_UNAPPLY_CAPABILITY,
  OPEN_ITEM_VOID_CAPABILITY,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  DEFAULT_COMPILER_LIMITS,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
  type CompileResult,
} from '../../packages/compiler/src/index.js';
import * as customization from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

export const NS = 'northstar.app';
const entity = (local: string) => `${NS}:entity.custom_${local}`;
const field = (local: string) => `${NS}:field.custom_${local}`;
const relation = (local: string) => `${NS}:relation.custom_${local}`;
const state = (local: string) => `${NS}:state.custom_${local}`;
export const operation = (local: string) => `${NS}:operation.custom_${local}`;
export const query = (local: string) => `${NS}:query.custom_${local}`;

export const ACCOUNT = entity('account');
export const NOTE = entity('fee_note');
export const NOTE_LINES = entity('fee_note_lines');
export const RECEIPT = entity('receipt');
export const APPLICATION = entity('receipt_application');
export const CREDIT = entity('credit_note');
export const CREDIT_LINES = entity('credit_note_lines');
export const CREDIT_APPLICATION = entity('credit_application');
export const note = (local: string) => field(`fee_note_${local}`);
export const line = (local: string) => field(`fee_note_lines_${local}`);
export const receipt = (local: string) => field(`receipt_${local}`);
export const applied = (local: string) => field(`receipt_application_${local}`);
export const credit = (local: string) => field(`credit_note_${local}`);
export const creditLine = (local: string) => field(`credit_note_lines_${local}`);
export const credited = (local: string) =>
  field(`credit_application_${local}`);
export const NOTE_ACCOUNT = relation('fee_note_account');
export const NOTE_LINES_PARENT = relation('fee_note_lines_parent');
export const RECEIPT_ACCOUNT = relation('receipt_account');
export const APPLICATION_SOURCE = relation('receipt_application_receipt');
export const APPLICATION_TARGET = relation('receipt_application_fee_note');
export const CREDIT_ACCOUNT = relation('credit_note_account');
export const CREDIT_LINES_PARENT = relation('credit_note_lines_parent');
export const CREDIT_SOURCE = relation('credit_application_credit_note');
export const CREDIT_TARGET = relation('credit_application_fee_note');
export const ISSUE_NOTE = operation('fee_note_action_issue');
export const ISSUE_RECEIPT = operation('receipt_action_issue');
export const APPLY = operation('receipt_application_create');
/** The core's operations on one application type: its create and archive. */
export const UNAPPLY = operation('receipt_application_archive');
export const APPLY_CREDIT = operation('credit_application_create');
export const UNAPPLY_CREDIT = operation('credit_application_archive');
/** The item types and application types of the fixture. */
const ITEMS = ['fee_note', 'receipt', 'credit_note'] as const;
const APPLICATIONS = ['receipt_application', 'credit_application'] as const;

const money = {
  type: 'money',
  currency: { kind: 'stored', fieldLabel: 'Currency' },
};
const figures = ['Subtotal', 'Total', 'Applied', 'Balance'].map((label) => ({
  label,
  ...money,
}));
const lifecycle = (local: string) => ({
  kind: 'declareLifecycle',
  entity: entity(local),
  initial: 'Draft',
  states: [
    { label: 'Draft' },
    { label: 'Open' },
    { label: 'Partially settled' },
    { label: 'Settled' },
    { label: 'Void' },
  ],
  transitions: [
    { label: 'Issue', from: 'Draft', to: 'Open' },
    { label: 'Void', from: 'Open', to: 'Void' },
  ],
});

export const patches = [
  {
    kind: 'addRecordType',
    label: 'Account',
    companyOwnership: 'tenantShared',
    fields: [{ label: 'Name', type: 'text', required: true }],
  },
  {
    kind: 'addRecordType',
    label: 'Fee note',
    companyOwnership: 'entityOwned',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Currency', type: 'currency', required: true },
      { label: 'Number', type: 'text' },
      { label: 'Document date', type: 'date' },
      ...figures,
    ],
  },
  lifecycle('fee_note'),
  {
    kind: 'addLineTable',
    entity: NOTE,
    label: 'Lines',
    fields: [
      { label: 'Item', type: 'text' },
      { label: 'Amount', ...money },
    ],
  },
  {
    kind: 'addLink',
    entity: NOTE,
    label: 'Account',
    target: ACCOUNT,
    required: true,
  },
  {
    kind: 'addRecordType',
    label: 'Receipt',
    companyOwnership: 'entityOwned',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Currency', type: 'currency', required: true },
      { label: 'Number', type: 'text' },
      { label: 'Amount', ...money },
      ...figures,
    ],
  },
  lifecycle('receipt'),
  {
    kind: 'addLink',
    entity: RECEIPT,
    label: 'Account',
    target: ACCOUNT,
    required: true,
  },
  {
    kind: 'addRecordType',
    label: 'Receipt application',
    companyOwnership: 'entityOwned',
    fields: [
      { label: 'Name', type: 'text' },
      { label: 'Amount', type: 'decimal', scale: 2 },
    ],
  },
  {
    kind: 'addLink',
    entity: APPLICATION,
    label: 'Receipt',
    target: RECEIPT,
    required: true,
  },
  {
    kind: 'addLink',
    entity: APPLICATION,
    label: 'Fee note',
    target: NOTE,
    required: true,
  },
  {
    kind: 'addRecordType',
    label: 'Credit note',
    companyOwnership: 'entityOwned',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Currency', type: 'currency', required: true },
      { label: 'Number', type: 'text' },
      ...figures,
    ],
  },
  lifecycle('credit_note'),
  {
    kind: 'addLineTable',
    entity: CREDIT,
    label: 'Lines',
    fields: [
      { label: 'Item', type: 'text' },
      { label: 'Amount', ...money },
    ],
  },
  {
    kind: 'addLink',
    entity: CREDIT,
    label: 'Account',
    target: ACCOUNT,
    required: true,
  },
  {
    kind: 'addRecordType',
    label: 'Credit application',
    companyOwnership: 'entityOwned',
    fields: [
      { label: 'Name', type: 'text' },
      { label: 'Amount', type: 'decimal', scale: 2 },
    ],
  },
  {
    kind: 'addLink',
    entity: CREDIT_APPLICATION,
    label: 'Credit note',
    target: CREDIT,
    required: true,
  },
  {
    kind: 'addLink',
    entity: CREDIT_APPLICATION,
    label: 'Fee note',
    target: NOTE,
    required: true,
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Authored = Record<string, any>;

let cached: { authored: Authored; bindings: readonly unknown[] } | null = null;
function patched(extra: readonly unknown[] = []): {
  authored: Authored;
  bindings: readonly unknown[];
} {
  if (!cached || extra.length > 0) {
    const base = JSON.parse(
      readFileSync(resolve('apps/web/release/app.authored.json'), 'utf8'),
    ) as Record<string, unknown>;
    const result = customization.applyCustomizationPatches(
      base,
      [...patches, ...extra].map((patch) =>
        customization.CustomizationPatchSchema.parse(patch),
      ),
    );
    assert.ok(result.status === 'applied', JSON.stringify(result));
    const applied = {
      authored: result.authored as Authored,
      bindings: result.permissionBindings,
    };
    if (extra.length > 0) return applied;
    cached = applied;
  }
  return structuredClone(cached);
}

const ref = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: 'v6',
  targetId,
});
const draftOnly = (local: string) => ({
  field: ref(
    'fieldReference',
    `${NS}:derived_state_field.machine.custom_${local}`,
  ),
  kind: 'fieldComparisonPredicate',
  operator: 'equals',
  schemaVersion: 'v6',
  value: {
    kind: 'textValue',
    schemaVersion: 'v6',
    value: state(`${local}_draft`),
  },
});
const capabilityRequirement = (capabilityId: string) => ({
  capabilityId,
  capabilityVersion: 1,
  declaredEffects: ['recordMutation'],
  kind: 'capabilityRequirement',
  requiredProjections: [
    'storage',
    'policy',
    'query',
    'operation',
    'surface',
    'agent',
    'reporting',
    'verification',
  ],
  schemaVersion: 'v6',
  supportStatus: 'supported',
});
const openItem = (
  local: string,
  side: 'debit' | 'credit',
  amount: { lines?: unknown; amountFieldId?: string },
) => ({
  schemaVersion: 'v6',
  entityId: entity(local),
  direction: 'receivable',
  side,
  counterpartyRelationId: relation(`${local}_account`),
  currencyFieldId: field(`${local}_currency`),
  numberFieldId: field(`${local}_number`),
  subtotalFieldId: field(`${local}_subtotal`),
  totalFieldId: field(`${local}_total`),
  appliedFieldId: field(`${local}_applied`),
  balanceFieldId: field(`${local}_balance`),
  ...amount,
  states: {
    machineId: `${NS}:machine.custom_${local}`,
    draft: state(`${local}_draft`),
    open: state(`${local}_open`),
    partiallySettled: state(`${local}_partially_settled`),
    settled: state(`${local}_settled`),
    void: state(`${local}_void`),
  },
  issue: {
    operationId: operation(`${local}_action_issue`),
    transitionId: `${NS}:transition.custom_${local}_issue`,
  },
  void: {
    operationId: operation(`${local}_action_void`),
    transitionId: `${NS}:transition.custom_${local}_void`,
  },
});

export interface OpenItemOptions {
  /** Leave the generated issue transition generic (amendment 7's refusal). */
  readonly genericIssue?: boolean;
  /** Leave archive and restore without the draft-only precondition. */
  readonly looseArchive?: boolean;
  /** Declare the receipt payable (amendment 4's refusal). */
  readonly payableReceipt?: boolean;
  /** A required link on the receipt application the core never writes. */
  readonly requiredApplicationLink?: boolean;
  /** Keep the receipt application's name required (Customize's default). */
  readonly requiredApplicationName?: boolean;
}

/** The patched package with the open-item role given as data. */
export function openItemAuthored(options: OpenItemOptions = {}): {
  authored: Authored;
  bindings: readonly unknown[];
} {
  const { authored, bindings } = patched(
    options.requiredApplicationLink
      ? [
          {
            kind: 'addLink',
            entity: APPLICATION,
            label: 'Account',
            target: ACCOUNT,
            required: true,
          },
        ]
      : [],
  );
  const prefix: Record<string, string> = {
    fee_note: 'FN',
    receipt: 'RC',
    credit_note: 'CN',
  };
  // A person-confirmed core operation in place of a generated one.
  const toCore = (operationId: string, capabilityId: string) => {
    const entry = authored.operations.find(
      (candidate: Authored) => candidate.operationId === operationId,
    );
    entry.effect = {
      capability: ref('capabilityReference', capabilityId),
      kind: 'registeredCapabilityEffect',
      schemaVersion: 'v6',
    };
    entry.tier = 'o1';
    entry.confirmation = 'humanRequired';
    delete entry.precondition;
  };
  for (const local of ITEMS) {
    const number = authored.fields.find(
      (entry: Authored) => entry.fieldId === field(`${local}_number`),
    );
    number.numbering = {
      kind: 'documentSequence',
      sequenceId: `${NS}:sequence.custom_${local}_number`,
      prefix: prefix[local],
      minimumDigits: 6,
      start: 1,
      assignOn: { transitionId: `${NS}:transition.custom_${local}_issue` },
      scope: 'legalEntity',
    };
    for (const verb of ['update', 'archive', 'restore'])
      if (!options.looseArchive)
        authored.operations.find(
          (entry: Authored) =>
            entry.operationId === operation(`${local}_${verb}`),
        ).precondition = draftOnly(local);
    // The generated transitions become the core's issue and void.
    if (!options.genericIssue)
      toCore(operation(`${local}_action_issue`), OPEN_ITEM_ISSUE_CAPABILITY);
    toCore(operation(`${local}_action_void`), OPEN_ITEM_VOID_CAPABILITY);
  }
  // A core-written figure is nobody's input, so no editor offers it.
  const written = new Set(
    ITEMS.flatMap((local) =>
      ['number', 'subtotal', 'total', 'applied', 'balance'].map((role) =>
        field(`${local}_${role}`),
      ),
    ),
  );
  for (const surface of authored.surfaces) {
    const editor = surface.documentEditor;
    if (!editor) continue;
    for (const key of ['headerFields', 'lineFields', 'createValues'])
      if (Array.isArray(editor[key]))
        editor[key] = editor[key].filter(
          (entry: Authored) => !written.has(entry.fieldId),
        );
  }
  for (const local of APPLICATIONS) {
    // Only the core writes an application, so its name is optional.
    if (!(options.requiredApplicationName && local === 'receipt_application'))
      authored.fields.find(
        (entry: Authored) =>
          entry.fieldId === field(`${local}_name`),
      ).presence = 'optional';
    // The type is capability owned: its create becomes the apply, its
    // archive the unapply, and its other generic writes go.
    const generic = ['update', 'restore'].map((verb) =>
      operation(`${local}_${verb}`),
    );
    authored.operations = authored.operations.filter(
      (entry: Authored) => !generic.includes(entry.operationId),
    );
    toCore(operation(`${local}_create`), OPEN_ITEM_APPLY_CAPABILITY);
    toCore(operation(`${local}_archive`), OPEN_ITEM_UNAPPLY_CAPABILITY);
  }
  authored.capabilityRequirements = [
    ...authored.capabilityRequirements,
    capabilityRequirement(OPEN_ITEM_ISSUE_CAPABILITY),
    capabilityRequirement(OPEN_ITEM_APPLY_CAPABILITY),
    capabilityRequirement(OPEN_ITEM_VOID_CAPABILITY),
    capabilityRequirement(OPEN_ITEM_UNAPPLY_CAPABILITY),
  ];
  authored.createOnlyFields = ITEMS.map((local) => ({
    schemaVersion: 'v6',
    fieldId: field(`${local}_currency`),
    entityId: entity(local),
  }));
  authored.openItems = [
    openItem('fee_note', 'debit', {
      lines: { relationId: NOTE_LINES_PARENT, amountFieldId: line('amount') },
    }),
    {
      ...openItem('receipt', 'credit', { amountFieldId: receipt('amount') }),
      ...(options.payableReceipt ? { direction: 'payable' } : {}),
    },
    openItem('credit_note', 'credit', {
      lines: {
        relationId: CREDIT_LINES_PARENT,
        amountFieldId: creditLine('amount'),
      },
    }),
  ];
  authored.openItemApplications = [
    {
      schemaVersion: 'v6',
      entityId: APPLICATION,
      sourceRelationId: APPLICATION_SOURCE,
      targetRelationId: APPLICATION_TARGET,
      amountFieldId: applied('amount'),
      applyOperationId: APPLY,
      unapplyOperationId: UNAPPLY,
    },
    {
      schemaVersion: 'v6',
      entityId: CREDIT_APPLICATION,
      sourceRelationId: CREDIT_SOURCE,
      targetRelationId: CREDIT_TARGET,
      amountFieldId: credited('amount'),
      applyOperationId: APPLY_CREDIT,
      unapplyOperationId: UNAPPLY_CREDIT,
    },
  ];
  return { authored, bindings };
}

/**
 * Compile a fixture package directly after the retained bootstrap, with the
 * patches' own permission bindings and first-party provenance (no Customize
 * member declares the role in slice 1, as the line-totals fixture does).
 */
export function compileOpenItems(
  authored: Authored,
  bindings: readonly unknown[],
): CompileResult {
  const authoredPath = resolve('apps/web/release/app.authored.json');
  const { bootstrap } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const normalized = normalizeApplicationPackage({
    ...authored,
    package: { ...authored.package, provenance: 'firstParty' },
  });
  const acknowledgement = readUnboundPermissionAcknowledgementFor(
    authoredPath,
    normalized.package.packageId,
  );
  return compileApplicationRelease(
    {
      kind: 'compilerInput',
      dependencies: [],
      expectedActiveRelease: expectedActiveReleaseFrom(bootstrap.compiled),
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes: new TextEncoder().encode(
        canonicalize(normalized),
      ),
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    },
    {
      ...acknowledgement,
      evaluatorBindings: [
        ...(acknowledgement.evaluatorBindings ?? []),
        ...(bindings as NonNullable<typeof acknowledgement.evaluatorBindings>),
      ],
    },
  );
}

/** The installable compiled application for the fixture package. */
export function openItemApplication(options: OpenItemOptions = {}) {
  const { bootstrap } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const { authored, bindings } = openItemAuthored(options);
  const compiled = compileOpenItems(authored, bindings);
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.status === 'compiled' ? [] : compiled.diagnostics),
  );
  return {
    schemaVersion: 'northstar.web:compiled-application-release/v1',
    application: customization.serializeRelease({
      compiled,
      normalizedDefinitionBytes: new TextEncoder().encode(
        canonicalize(
          normalizeApplicationPackage({
            ...authored,
            package: { ...authored.package, provenance: 'firstParty' },
          }),
        ),
      ),
    }),
    bootstrap: customization.serializeRelease(bootstrap),
  };
}
