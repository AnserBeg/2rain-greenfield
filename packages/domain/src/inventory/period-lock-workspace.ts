/**
 * The period lock page (WAREHOUSE-MODE): one lock per company, read-only
 * until now. Its two existing operations become commands, each a Task with a
 * review and an explicit confirmation under its own permission: "Close
 * period through" moves Closed through later (advance_period_lock), "Reopen
 * to" moves it earlier (reopen_period, which also asks for the operation's
 * human confirmation). Postings dated at or before Closed through are refused
 * inside the posting transaction, as before. There are no per-module locks,
 * and the backdate window -- set when a company is provisioned -- is not
 * changed here.
 */
export function periodLockWorkspace(
  namespace: string,
): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const closedThrough = id('field', 'inventory_period_lock_closed_through');
  const command = (
    name: string,
    label: string,
    description: string,
    orderKey: number,
    inputLabel: string,
    operation: string,
    conditions: unknown[],
  ) => ({
    actionId: id('action', `inventory_period_lock_${name}`),
    label,
    description,
    orderKey,
    conditions,
    inputs: [
      {
        inputId: id('input', `inventory_period_lock_${name}_through`),
        label: inputLabel,
        orderKey: 10,
        type: 'instant',
        required: true,
      },
    ],
    steps: [
      {
        stepId: id('step', `inventory_period_lock_${name}`),
        operation: ref('operationReference', id('operation', operation)),
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
            path: ['patch', closedThrough],
            value: {
              source: 'input',
              inputId: id('input', `inventory_period_lock_${name}_through`),
            },
          },
        ],
      },
    ],
  });
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'inventory_period_lock_closed_through'),
        subtitle: [],
        facts: [],
      },
      context: {
        label: 'Posting period',
        description:
          'Postings dated at or before Closed through are refused in this company. Closing moves it later and reopening moves it earlier; each is confirmed before it changes anything.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: [
      {
        columnId: id('column', 'inventory_period_lock_closed_through'),
        label: 'Closed through',
        orderKey: 10,
        field: closedThrough,
      },
    ],
    children: [],
    actions: [
      command(
        'close',
        'Close period through',
        'Postings dated at or before this time will be refused in this company. Nothing already posted changes.',
        10,
        'Close through',
        'advance_period_lock',
        [],
      ),
      // Only a closed period reopens.
      command(
        'reopen',
        'Reopen to',
        'Postings dated after this time will be accepted again in this company. Nothing already posted changes.',
        20,
        'Reopen to',
        'reopen_period',
        [
          {
            value: { source: 'record', field: closedThrough },
            operator: 'notEquals',
            compare: null,
          },
        ],
      ),
    ],
  };
}
