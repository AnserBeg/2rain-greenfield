import { PAYMENT_TERMS } from './definition.js';

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
    ],
  };
}
