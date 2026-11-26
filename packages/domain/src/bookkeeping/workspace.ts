/** One fact of the company record the page shows, declared by its owner. */
export interface BookkeepingCompanyColumn {
  readonly field: string;
  readonly label: string;
}

/**
 * The company's record page with the ledger's books-start command
 * (ACCOUNTING-1 slice 1a-ii). The company is the legal-entity record another
 * module declares; this composition only shows the facts its owner names and
 * adds the ledger's Tasks, "Set books start" and "Put account", whose inputs
 * are the operations' `arguments`. The person types the books start they expect to replace
 * (empty the first time): there is no ledger read model yet, so a different
 * stored value is refused by name rather than shown (1a-iv adds the read).
 */
export function bookkeepingCompanyWorkspace(
  namespace: string,
  company: {
    readonly title: BookkeepingCompanyColumn;
    readonly facts: readonly BookkeepingCompanyColumn[];
  },
): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const column = (index: number) =>
    id('column', `bookkeeping_books_company_${index}`);
  const columns = [company.title, ...company.facts].map((fact, index) => ({
    columnId: column(index),
    label: fact.label,
    orderKey: (index + 1) * 10,
    field: fact.field,
  }));
  const date = id('input', 'bookkeeping_books_start_date');
  const prior = id('input', 'bookkeeping_books_start_prior');
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: column(0),
        subtitle: [],
        facts: columns.slice(1).map((value) => value.columnId),
      },
      context: {
        label: 'Books',
        description:
          'Books start is the first day this company keeps its books here. Each change is confirmed before it changes anything.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: columns,
    children: [],
    actions: [
      {
        actionId: id('action', 'bookkeeping_books_start_set'),
        label: 'Set books start',
        description:
          'Type the first day of these books as YYYY-MM-DD. To change it, also type the current books start; leave that empty the first time. Books start cannot move once an entry is recorded.',
        orderKey: 10,
        conditions: [],
        inputs: [
          {
            inputId: date,
            label: 'Books start (YYYY-MM-DD)',
            orderKey: 10,
            type: 'text',
            required: true,
          },
          {
            inputId: prior,
            label: 'Current books start (empty the first time)',
            orderKey: 20,
            type: 'text',
            required: false,
          },
        ],
        steps: [
          {
            stepId: id('step', 'bookkeeping_books_start_set'),
            operation: {
              kind: 'operationReference',
              schemaVersion: 'v6',
              targetId: id('operation', 'bookkeeping_books_start_set'),
            },
            bindings: [
              {
                path: ['recordId'],
                value: { source: 'record', field: 'recordId' },
              },
              {
                path: ['expectedRevision'],
                value: { source: 'record', field: 'revision' },
              },
              {
                path: ['arguments', 'date'],
                value: { source: 'input', inputId: date },
              },
              {
                path: ['arguments', 'expectedPrior'],
                value: { source: 'input', inputId: prior },
              },
            ],
          },
        ],
      },
      accountPutAction(id),
    ],
  };
}

/**
 * "Put account": add an account to the company's chart by a new code, or
 * change the label or active state of the account with that code. The person
 * types the label and active state they expect to replace (both empty for a
 * new code); a different stored account is refused by name.
 */
function accountPutAction(id: (kind: string, name: string) => string) {
  const input = (
    name: string,
    label: string,
    orderKey: number,
    required: boolean,
  ) => ({
    inputId: id('input', `bookkeeping_account_put_${name}`),
    label,
    orderKey,
    type: 'text',
    required,
  });
  const inputs = [
    ['code', 'Account code', true],
    ['kind', 'Kind (a core role name, such as cash)', true],
    ['label', 'Name', true],
    ['active', 'Active (yes or no)', true],
    ['prior_label', 'Current name (empty for a new code)', false],
    [
      'prior_active',
      'Currently active (yes or no; empty for a new code)',
      false,
    ],
  ] as const;
  const argumentOf: Readonly<Record<string, string>> = {
    prior_label: 'expectedLabel',
    prior_active: 'expectedActive',
  };
  return {
    actionId: id('action', 'bookkeeping_account_put'),
    label: 'Put account',
    description:
      "Add an account to this company's chart by a new code, or rename, deactivate or reactivate the account with that code. Its kind cannot change once it exists.",
    orderKey: 20,
    conditions: [],
    inputs: inputs.map(([name, label, required], index) =>
      input(name, label, (index + 1) * 10, required),
    ),
    steps: [
      {
        stepId: id('step', 'bookkeeping_account_put'),
        operation: {
          kind: 'operationReference',
          schemaVersion: 'v6',
          targetId: id('operation', 'bookkeeping_account_put'),
        },
        bindings: [
          {
            path: ['recordId'],
            value: { source: 'record', field: 'recordId' },
          },
          {
            path: ['expectedRevision'],
            value: { source: 'record', field: 'revision' },
          },
          ...inputs.map(([name]) => ({
            path: ['arguments', argumentOf[name] ?? name],
            value: {
              source: 'input',
              inputId: id('input', `bookkeeping_account_put_${name}`),
            },
          })),
        ],
      },
    ],
  };
}
