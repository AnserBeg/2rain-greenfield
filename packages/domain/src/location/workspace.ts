/**
 * The location page (LOCATIONS): its code, name and type, and its inventory
 * status with the reason and time it last changed. A status says what the
 * stock held here may be used for -- only a usable location's stock counts as
 * usable or available -- and it changes only through "Change status", which
 * requires a reason and records it with the status in one update. The generic
 * Record form leaves the three status fields out (`surface.form.omit`).
 */
export function locationWorkspace(namespace: string): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const field = (name: string) => id('field', `location_${name}`);
  const column = (name: string, label: string, orderKey: number) => ({
    columnId: id('column', `location_${name}`),
    label,
    orderKey,
    field: field(name),
  });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `location_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const statuses = [
    ['usable', 'Usable'],
    ['quarantine', 'Quarantine'],
    ['damaged', 'Damaged'],
    ['in_transit', 'In transit'],
    ['return_pending', 'Return pending'],
  ] as const;
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'location_name'),
        subtitle: [id('column', 'location_code')],
        status: id('column', 'location_status'),
        facts: [
          id('column', 'location_type'),
          id('column', 'location_status_reason'),
          id('column', 'location_status_changed_at'),
        ],
      },
      context: {
        label: 'Inventory status',
        description:
          'Only stock in a usable location counts as usable or available. Stock in quarantine, damaged, in transit or return pending is on hand but not offered.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
    },
    fields: [
      column('code', 'Code', 10),
      column('name', 'Name', 20),
      column('type', 'Type', 30),
      column('status', 'Inventory status', 40),
      column('status_reason', 'Status reason', 50),
      column('status_changed_at', 'Status changed', 60),
    ],
    children: [],
    actions: [
      {
        actionId: id('action', 'location_change_status'),
        label: 'Change status',
        description:
          'Sets what the stock held here may be used for. Every item at this location counts as usable or not from now on; nothing moves. The reason is kept with the status.',
        orderKey: 10,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'location_status'),
            label: 'Inventory status',
            orderKey: 10,
            type: 'text',
            required: true,
            presentation: {
              kind: 'choice',
              options: statuses.map(([local, label]) => ({
                value: id('option', `location_status_${local}`),
                label,
              })),
              defaultValue: id('option', 'location_status_usable'),
              defaultFrom: { source: 'record', field: field('status') },
            },
          },
          {
            inputId: id('input', 'location_status_reason'),
            label: 'Reason',
            orderKey: 20,
            type: 'text',
            required: true,
            presentation: { kind: 'multiline' },
          },
        ],
        steps: [
          {
            stepId: id('step', 'location_status_update'),
            operation: ref(
              'operationReference',
              id('operation', 'location_update'),
            ),
            bindings: [
              bind(['recordId'], { source: 'record', field: 'recordId' }),
              bind(['expectedRevision'], {
                source: 'record',
                field: 'revision',
              }),
              bind(['patch', field('status')], input('status')),
              bind(['patch', field('status_reason')], input('status_reason')),
              bind(['patch', field('status_changed_at')], {
                source: 'generated',
                value: 'instant',
              }),
            ],
          },
        ],
      },
    ],
  };
}
