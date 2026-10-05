import { PAYMENT_TERMS } from './definition.js';
import {
  RETURNABLE_CURRENCIES,
  RETURNABLE_DIRECTIONS,
  RETURNABLE_METHODS,
} from './returnables.js';

/**
 * The customer workspace on a Party record (owner ruling E): the roles it
 * holds, its ship-to address book, and the defaults a new sales order takes
 * when this party is its customer. Every task is an existing governed Party
 * operation; the runtime interprets the same data for any module.
 */
export function partyWorkspace(namespace: string): Record<string, unknown> {
  const id = (type: string, name: string) => `${namespace}:${type}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const field = (name: string) => id('field', name);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    value: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: id('column', `party_${name}`),
    label,
    orderKey,
    field: value,
    ...(lookup
      ? {
          reference: {
            query: q(lookup[0]),
            labelField: ref('fieldReference', field(lookup[1])),
          },
        }
      : {}),
  });
  const role = <T extends object>(
    value: T,
    kind: string,
    priority: number,
  ) => ({
    ...value,
    presentation: { role: kind, priority },
  });
  const record = (name: string) => ({ source: 'record', field: name });
  const selected = (name: string) => ({ source: 'selected', field: name });
  const literal = (value: string | null) => ({ source: 'literal', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `party_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', `party_${name}`),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const update = (name: string, patch: Record<string, unknown>) =>
    step(name, 'party_update', [
      bind(['recordId'], record('recordId')),
      bind(['expectedRevision'], record('revision')),
      ...Object.entries(patch).map(([key, value]) =>
        bind(['patch', field(`party_${key}`)], value),
      ),
    ]);
  const text = (
    name: string,
    label: string,
    orderKey: number,
    required: boolean,
    presentation?: Record<string, unknown>,
  ) => ({
    inputId: id('input', `party_${name}`),
    label,
    orderKey,
    type: 'text',
    required,
    ...(presentation ? { presentation } : {}),
  });
  const roles = id('dataset', 'party_roles');
  const addresses = id('dataset', 'party_addresses');
  const returnables = id('dataset', 'party_returnables');
  const custody = (name: string) => field(`returnable_custody_${name}`);
  const address = (name: string) => field(`party_address_${name}`);
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'party_name'),
        subtitle: [id('column', 'party_number')],
        facts: [
          id('column', 'party_default_currency'),
          id('column', 'party_payment_terms'),
          id('column', 'party_default_salesperson'),
          id('column', 'party_default_ship_to'),
          id('column', 'party_default_tax_code'),
        ],
      },
      context: {
        label: 'Customer setup',
        description:
          'Defaults a new sales order takes when this party is its customer, and the addresses it ships to.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
    },
    fields: [
      column('name', 'Name', 10, field('party_name')),
      column('number', 'Party number', 20, field('party_number')),
      column('contact', 'Contact', 30, field('party_contact_summary')),
      column(
        'default_currency',
        'Default currency',
        40,
        field('party_default_currency'),
      ),
      column(
        'payment_terms',
        'Payment terms',
        50,
        field('party_payment_terms'),
      ),
      column(
        'default_salesperson',
        'Default salesperson',
        60,
        field('party_default_salesperson_party_id'),
        ['party_get', 'party_name'],
      ),
      column(
        'default_ship_to',
        'Default ship-to',
        70,
        field('party_default_ship_to_address_id'),
        ['party_address_get', 'party_address_label'],
      ),
      column(
        'default_tax_code',
        'Default tax code',
        80,
        field('party_default_tax_code_id'),
        ['tax_code_get', 'tax_code_code'],
      ),
    ],
    children: [
      {
        datasetId: roles,
        presentation: { selection: 'none' },
        label: 'Roles',
        orderKey: 10,
        query: q('party_role_list'),
        parent: {
          relationId: id('relation', 'party_role_party'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          role(
            column('role_kind', 'Role', 10, field('party_role_kind')),
            'primary',
            10,
          ),
          role(
            column('role_status', 'Status', 20, field('party_role_status')),
            'secondary',
            20,
          ),
        ],
      },
      {
        datasetId: addresses,
        presentation: { selection: 'explicit', selectedActions: 'row' },
        label: 'Ship-to addresses',
        orderKey: 20,
        query: q('party_address_list'),
        sort: [{ fieldId: address('label'), direction: 'ascending' }],
        parent: {
          relationId: id('relation', 'party_address_party'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          role(
            column('address_label', 'Label', 10, address('label')),
            'primary',
            10,
          ),
          role(
            column('address_recipient', 'Recipient', 20, address('recipient')),
            'secondary',
            20,
          ),
          role(
            column('address_street', 'Street', 30, address('street')),
            'secondary',
            30,
          ),
          role(
            column('address_city', 'City', 40, address('city')),
            'secondary',
            40,
          ),
          role(
            column(
              'address_region',
              'Province or state',
              50,
              address('region'),
            ),
            'detail',
            50,
          ),
          role(
            column(
              'address_postal_code',
              'Postal code',
              60,
              address('postal_code'),
            ),
            'detail',
            60,
          ),
          role(
            column('address_country', 'Country', 70, address('country')),
            'detail',
            70,
          ),
        ],
      },
      // RETURNABLE-ASSETS: the custody records this party is in, either way,
      // read in the company the page is entered with.
      {
        datasetId: returnables,
        presentation: {
          selection: 'none',
          compact: 'scrollTable',
          description:
            'Pallets, kegs and crates out with this customer or held from this supplier, and the deposit on them.',
        },
        label: 'Returnables',
        orderKey: 30,
        query: q('returnable_custody_list'),
        sort: [{ fieldId: custody('number'), direction: 'ascending' }],
        parent: {
          relationId: id('relation', 'returnable_custody_party'),
          value: record('recordId'),
          ownership: 'reference',
        },
        columns: [
          column('returnable_number', 'Custody', 10, custody('number')),
          column(
            'returnable_type',
            'Returnable type',
            20,
            custody('asset_type_id'),
            ['returnable_asset_type_get', 'returnable_asset_type_name'],
          ),
          column('returnable_direction', 'Direction', 30, custody('direction')),
          column(
            'returnable_outstanding',
            'Outstanding',
            40,
            custody('outstanding_quantity'),
          ),
          {
            ...column(
              'returnable_held',
              'Deposit held',
              50,
              custody('deposit_held'),
            ),
            format: 'money' as const,
          },
          column('returnable_currency', 'Currency', 60, custody('currency')),
          column('returnable_state', 'State', 70, custody('state')),
        ],
      },
    ],
    actions: [
      {
        actionId: id('action', 'party_add_role'),
        label: 'Add role',
        description:
          'Adds an active role: a customer can be chosen on sales orders, a supplier on purchase orders, and a salesperson on either.',
        orderKey: 10,
        conditions: [],
        inputs: [
          text('role_kind', 'Role', 10, true, {
            kind: 'choice',
            options: [
              { value: id('option', 'customer'), label: 'Customer' },
              { value: id('option', 'supplier'), label: 'Supplier' },
              { value: id('option', 'salesperson'), label: 'Salesperson' },
            ],
          }),
        ],
        steps: [
          step('role_create', 'party_role_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(['values', field('party_role_kind')], input('role_kind')),
            bind(
              ['values', field('party_role_status')],
              literal(id('option', 'active')),
            ),
            bind(
              ['relations', id('relation', 'party_role_party')],
              record('recordId'),
            ),
          ]),
        ],
      },
      {
        actionId: id('action', 'party_set_defaults'),
        label: 'Set order defaults',
        description:
          'New sales orders for this customer start with this currency and these payment terms; each order can still change them.',
        orderKey: 20,
        conditions: [],
        inputs: [
          text('default_currency', 'Default currency', 10, true, {
            kind: 'choice',
            options: [
              {
                value: id('option', 'party_default_currency_cad'),
                label: 'CAD · Canadian dollar',
              },
              {
                value: id('option', 'party_default_currency_usd'),
                label: 'USD · US dollar',
              },
              {
                value: id('option', 'party_default_currency_eur'),
                label: 'EUR · Euro',
              },
            ],
            defaultValue: id('option', 'party_default_currency_cad'),
            defaultFrom: {
              source: 'record',
              field: field('party_default_currency'),
            },
          }),
          text('payment_terms', 'Payment terms', 20, true, {
            kind: 'choice',
            options: PAYMENT_TERMS.map(([local, label]) => ({
              value: id('option', `party_payment_terms_${local}`),
              label,
            })),
            defaultValue: id('option', 'party_payment_terms_net_30'),
            defaultFrom: {
              source: 'record',
              field: field('party_payment_terms'),
            },
          }),
        ],
        steps: [
          update('defaults_update', {
            default_currency: input('default_currency'),
            payment_terms: input('payment_terms'),
          }),
        ],
      },
      {
        actionId: id('action', 'party_set_salesperson'),
        label: 'Set default salesperson',
        description:
          'New sales orders for this customer start with this salesperson; each order can still change it.',
        orderKey: 30,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'party_salesperson'),
            label: 'Salesperson',
            orderKey: 10,
            type: 'reference',
            required: true,
            query: q('party_list'),
            labelField: ref('fieldReference', field('party_name')),
            // Only parties holding an active salesperson role (ruling E).
            eligibility: {
              queryId: id('query', 'party_role_list'),
              relationId: id('relation', 'party_role_party'),
              filters: [
                {
                  fieldId: field('party_role_kind'),
                  value: id('option', 'salesperson'),
                },
                {
                  fieldId: field('party_role_status'),
                  value: id('option', 'active'),
                },
              ],
            },
          },
        ],
        steps: [
          update('salesperson_update', {
            default_salesperson_party_id: input('salesperson'),
          }),
        ],
      },
      {
        actionId: id('action', 'party_set_tax_code'),
        label: 'Set default tax code',
        description:
          'New sales orders for this customer are taxed by this code; each order and line can still change it.',
        orderKey: 35,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'party_tax_code'),
            label: 'Tax code',
            orderKey: 10,
            type: 'reference',
            required: true,
            query: q('tax_code_list'),
            labelField: ref('fieldReference', field('tax_code_name')),
          },
        ],
        steps: [
          update('tax_code_update', {
            default_tax_code_id: input('tax_code'),
          }),
        ],
      },
      {
        actionId: id('action', 'party_add_address'),
        label: 'Add ship-to address',
        description:
          'Adds an address to this customer’s book. An order copies the address it ships to, so a later change here does not alter it.',
        orderKey: 40,
        conditions: [],
        inputs: [
          text('address_label', 'Address label', 10, true),
          text('address_recipient', 'Recipient', 20, false),
          text('address_street', 'Street address', 30, true, {
            kind: 'multiline',
          }),
          text('address_city', 'City', 40, true),
          text('address_region', 'Province or state', 50, false),
          text('address_postal_code', 'Postal code', 60, true),
          text('address_country', 'Country', 70, true),
        ],
        steps: [
          step('address_create', 'party_address_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            ...(
              [
                'label',
                'recipient',
                'street',
                'city',
                'region',
                'postal_code',
                'country',
              ] as const
            ).map((name) =>
              bind(['values', address(name)], input(`address_${name}`)),
            ),
            bind(
              ['relations', id('relation', 'party_address_party')],
              record('recordId'),
            ),
          ]),
        ],
      },
      {
        actionId: id('action', 'party_default_address'),
        presentation: { placement: 'selection' },
        label: 'Use as default ship-to',
        description:
          'New sales orders for this customer start with this ship-to address.',
        orderKey: 50,
        datasetId: addresses,
        conditions: [],
        inputs: [],
        steps: [
          update('default_address_update', {
            default_ship_to_address_id: selected('recordId'),
          }),
        ],
      },
      {
        actionId: id('action', 'party_open_returnable'),
        label: 'Open custody',
        description:
          'Open the custody record with its events: issue more, record a return, a forfeit or a deposit refund.',
        orderKey: 60,
        datasetId: returnables,
        presentation: { placement: 'row' },
        conditions: [],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref(
            'surfaceReference',
            id('surface', 'returnable_custody_detail'),
          ),
          query: q('returnable_custody_get'),
          record: selected('recordId'),
        },
      },
      {
        // A new custody record and its first Issue: the deposit is taken at
        // the type's unit deposit in the chosen currency, by the method
        // entered here. A type this party already holds is issued from its
        // custody record; the capability refuses a second one.
        actionId: id('action', 'party_issue_returnables'),
        label: 'Issue returnables',
        description:
          'Starts a custody record of one returnable type and records its first issue with the deposit taken. Stock is not moved. To issue more of a type already in custody, open its record.',
        orderKey: 70,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'party_returnable_type'),
            label: 'Returnable type',
            orderKey: 10,
            type: 'reference',
            required: true,
            query: q('returnable_asset_type_list'),
            labelField: ref(
              'fieldReference',
              field('returnable_asset_type_name'),
            ),
          },
          text('returnable_direction', 'Direction', 20, true, {
            kind: 'choice',
            options: RETURNABLE_DIRECTIONS.map(([value, label]) => ({
              value: id('option', `returnable_custody_direction_${value}`),
              label,
            })),
            defaultValue: id('option', 'returnable_custody_direction_out'),
          }),
          text('returnable_currency', 'Deposit currency', 30, true, {
            kind: 'choice',
            options: RETURNABLE_CURRENCIES.map(([value, label]) => ({
              value: id('option', `returnable_custody_currency_${value}`),
              label,
            })),
            defaultValue: id('option', 'returnable_custody_currency_cad'),
          }),
          {
            inputId: id('input', 'party_returnable_quantity'),
            label: 'Quantity',
            orderKey: 40,
            type: 'quantity',
            required: true,
          },
          text('returnable_method', 'Deposit paid by', 50, true, {
            kind: 'choice',
            options: RETURNABLE_METHODS.map(([value, label]) => ({
              value: id('option', `returnable_event_method_${value}`),
              label,
            })),
            defaultValue: id('option', 'returnable_event_method_bank_transfer'),
          }),
          text(
            'returnable_reference',
            'Reference (cheque or transfer number)',
            60,
            false,
          ),
          text('returnable_reason', 'Reason', 70, true, { kind: 'multiline' }),
        ],
        steps: [
          step('returnable_custody', 'returnable_custody_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(['legalEntityId'], { source: 'generated', value: 'scope' }),
            bind(
              ['values', custody('state')],
              literal(id('option', 'returnable_custody_state_new')),
            ),
            bind(['values', custody('party_id')], record('recordId')),
            bind(
              ['values', custody('direction')],
              input('returnable_direction'),
            ),
            bind(
              ['values', custody('asset_type_id')],
              input('returnable_type'),
            ),
            bind(['values', custody('currency')], input('returnable_currency')),
            bind(
              ['relations', id('relation', 'returnable_custody_party')],
              record('recordId'),
            ),
          ]),
          step('returnable_issue', 'returnable_event_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(['legalEntityId'], { source: 'generated', value: 'scope' }),
            bind(
              ['values', field('returnable_event_state')],
              literal(id('option', 'returnable_event_state_draft')),
            ),
            bind(
              ['values', field('returnable_event_kind')],
              literal(id('option', 'returnable_event_kind_issue')),
            ),
            bind(['values', field('returnable_event_event_date')], {
              source: 'generated',
              value: 'instant',
            }),
            bind(
              ['values', field('returnable_event_quantity')],
              input('returnable_quantity'),
            ),
            bind(
              ['values', field('returnable_event_method')],
              input('returnable_method'),
            ),
            bind(
              ['values', field('returnable_event_reference')],
              input('returnable_reference'),
            ),
            bind(
              ['values', field('returnable_event_reason')],
              input('returnable_reason'),
            ),
            bind(['relations', id('relation', 'returnable_event_custody')], {
              source: 'step',
              stepId: id('step', 'party_returnable_custody'),
              field: 'recordId',
            }),
          ]),
          step('returnable_issue_post', 'returnable_event_post', [
            bind(['recordId'], {
              source: 'step',
              stepId: id('step', 'party_returnable_issue'),
              field: 'recordId',
            }),
            bind(['expectedRevision'], {
              source: 'step',
              stepId: id('step', 'party_returnable_issue'),
              field: 'revision',
            }),
          ]),
        ],
      },
    ],
  };
}

/**
 * A returnable custody record (RETURNABLE-ASSETS): what one party holds of
 * ours, or we of a supplier's, in one returnable type, with the deposit on
 * it and every event that moved it. Each Task writes a draft event and posts
 * it through the returnables capability, which bounds it and restates the
 * figures: return plus forfeit never exceeds what was issued, and a refund
 * never exceeds the deposit taken on what came back. Nothing moves stock.
 */
export function returnableCustodyWorkspace(
  namespace: string,
): Record<string, unknown> {
  const id = (type: string, name: string) => `${namespace}:${type}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const custody = (name: string) => id('field', `returnable_custody_${name}`);
  const event = (name: string) => id('field', `returnable_event_${name}`);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    value: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: id('column', `custody_${name}`),
    label,
    orderKey,
    field: value,
    ...(lookup
      ? {
          reference: {
            query: q(lookup[0]),
            labelField: ref('fieldReference', id('field', lookup[1])),
          },
        }
      : {}),
  });
  const money = <T extends object>(value: T) => ({
    ...value,
    format: 'money' as const,
  });
  const record = (name: string) => ({ source: 'record', field: name });
  const literal = (value: string | null) => ({ source: 'literal', value });
  const generated = (value: string) => ({ source: 'generated', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `custody_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', `custody_${name}`),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const fromStep = (name: string, value: 'recordId' | 'revision') => ({
    source: 'step',
    stepId: id('step', `custody_${name}`),
    field: value,
  });
  /** Writes a draft event of this custody record and posts it. */
  const recordEvent = (
    kind: 'issue' | 'return' | 'forfeit' | 'refund',
    values: Record<string, unknown>,
  ) => [
    step(`${kind}_draft`, 'returnable_event_create', [
      bind(['recordId'], generated('uuid')),
      bind(['legalEntityId'], generated('scope')),
      bind(
        ['values', event('state')],
        literal(id('option', 'returnable_event_state_draft')),
      ),
      bind(
        ['values', event('kind')],
        literal(id('option', `returnable_event_kind_${kind}`)),
      ),
      bind(['values', event('event_date')], generated('instant')),
      ...Object.entries(values).map(([name, value]) =>
        bind(['values', event(name)], value),
      ),
      bind(
        ['relations', id('relation', 'returnable_event_custody')],
        record('recordId'),
      ),
    ]),
    step(`${kind}_post`, 'returnable_event_post', [
      bind(['recordId'], fromStep(`${kind}_draft`, 'recordId')),
      bind(['expectedRevision'], fromStep(`${kind}_draft`, 'revision')),
    ]),
  ];
  const quantity = (label: string) => ({
    inputId: id('input', 'custody_quantity'),
    label,
    orderKey: 10,
    type: 'quantity',
    required: true,
  });
  const method = (label: string) => ({
    inputId: id('input', 'custody_method'),
    label,
    orderKey: 20,
    type: 'text',
    required: true,
    presentation: {
      kind: 'choice',
      options: RETURNABLE_METHODS.map(([value, optionLabel]) => ({
        value: id('option', `returnable_event_method_${value}`),
        label: optionLabel,
      })),
      defaultValue: id('option', 'returnable_event_method_bank_transfer'),
    },
  });
  const reference = {
    inputId: id('input', 'custody_reference'),
    label: 'Reference (cheque or transfer number)',
    orderKey: 30,
    type: 'text',
    required: false,
  };
  const reason = {
    inputId: id('input', 'custody_reason'),
    label: 'Reason',
    orderKey: 40,
    type: 'text',
    required: true,
    presentation: { kind: 'multiline' },
  };
  const positive = (name: string) => ({
    value: record(custody(name)),
    operator: 'positive',
    compare: null,
  });
  const events = id('dataset', 'custody_events');
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'custody_number'),
        subtitle: [id('column', 'custody_party')],
        status: id('column', 'custody_state'),
        facts: [
          id('column', 'custody_type'),
          id('column', 'custody_direction'),
          id('column', 'custody_outstanding'),
          id('column', 'custody_held'),
          id('column', 'custody_refundable'),
          id('column', 'custody_currency'),
        ],
      },
      context: {
        label: 'Custody and deposit',
        description:
          'Returnable assets out with a customer or held from a supplier, and the deposit taken on them. Sellable stock is not moved.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
    },
    fields: [
      column('number', 'Custody', 10, custody('number')),
      column('state', 'Custody state', 15, custody('state')),
      column('party', 'Party', 20, custody('party_id'), [
        'party_get',
        'party_name',
      ]),
      column('type', 'Returnable type', 25, custody('asset_type_id'), [
        'returnable_asset_type_get',
        'returnable_asset_type_name',
      ]),
      column('direction', 'Direction', 30, custody('direction')),
      column('currency', 'Currency', 35, custody('currency')),
      money(
        column('unit_deposit', 'Unit deposit', 40, custody('unit_deposit')),
      ),
      column('issued', 'Issued', 45, custody('issued_quantity')),
      column('returned', 'Returned', 50, custody('returned_quantity')),
      column('forfeited', 'Forfeited', 55, custody('forfeited_quantity')),
      column('outstanding', 'Outstanding', 60, custody('outstanding_quantity')),
      ...[
        column('taken', 'Deposit taken', 65, custody('deposit_taken')),
        column('refunded', 'Deposit refunded', 70, custody('deposit_refunded')),
        column('kept', 'Deposit kept', 75, custody('deposit_forfeited')),
        column('held', 'Deposit held', 80, custody('deposit_held')),
        column(
          'refundable',
          'Refundable now',
          85,
          custody('deposit_refundable'),
        ),
      ].map(money),
      column('notes', 'Notes', 90, custody('notes')),
    ],
    children: [
      {
        datasetId: events,
        presentation: { selection: 'none', compact: 'scrollTable' },
        label: 'Events',
        orderKey: 10,
        query: q('returnable_event_list'),
        sort: [{ fieldId: event('event_date'), direction: 'ascending' }],
        parent: {
          relationId: id('relation', 'returnable_event_custody'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          column('event_date', 'Date', 10, event('event_date')),
          column('event_kind', 'Event', 20, event('kind')),
          column('event_quantity', 'Quantity', 30, event('quantity')),
          money(column('event_amount', 'Amount', 40, event('amount'))),
          column('event_method', 'Method', 50, event('method')),
          column('event_reference', 'Reference', 60, event('reference')),
          column('event_reason', 'Reason', 70, event('reason')),
          column('event_recorded_by', 'Recorded by', 80, event('recorded_by')),
          column('event_state', 'State', 90, event('state')),
        ],
      },
    ],
    actions: [
      {
        actionId: id('action', 'custody_issue'),
        label: 'Issue',
        description:
          'Records more of this type handed over -- to the customer, or received from the supplier -- and the deposit taken on them at the unit deposit.',
        orderKey: 10,
        conditions: [],
        inputs: [
          quantity('Quantity'),
          method('Deposit paid by'),
          reference,
          reason,
        ],
        steps: recordEvent('issue', {
          quantity: input('quantity'),
          method: input('method'),
          reference: input('reference'),
          reason: input('reason'),
        }),
      },
      {
        actionId: id('action', 'custody_return'),
        label: 'Return',
        description:
          'Records assets that came back. It may not exceed what is outstanding; the deposit on them becomes refundable.',
        orderKey: 20,
        conditions: [positive('outstanding_quantity')],
        inputs: [quantity('Quantity returned'), { ...reason, orderKey: 20 }],
        steps: recordEvent('return', {
          quantity: input('quantity'),
          reason: input('reason'),
        }),
      },
      {
        actionId: id('action', 'custody_forfeit'),
        label: 'Forfeit',
        description:
          'Records assets that will not come back: the deposit on them is kept and is no longer refundable. It may not exceed what is outstanding.',
        orderKey: 30,
        conditions: [positive('outstanding_quantity')],
        inputs: [quantity('Quantity forfeited'), { ...reason, orderKey: 20 }],
        steps: recordEvent('forfeit', {
          quantity: input('quantity'),
          reason: input('reason'),
        }),
      },
      {
        actionId: id('action', 'custody_refund'),
        label: 'Refund deposit',
        description:
          'Records the deposit paid back on returned assets. It may not exceed what is refundable now.',
        orderKey: 40,
        conditions: [positive('deposit_refundable')],
        inputs: [
          {
            ...quantity('Amount refunded'),
            inputId: id('input', 'custody_amount'),
          },
          method('Refunded by'),
          reference,
          reason,
        ],
        steps: recordEvent('refund', {
          amount: input('amount'),
          method: input('method'),
          reference: input('reference'),
          reason: input('reason'),
        }),
      },
    ],
  };
}
