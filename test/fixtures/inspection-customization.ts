export const inspection = 'custom_goods_receipt_inspection';
export const inspectionEntity = `northstar.app:entity.${inspection}`;
export const inspectionLinks = [
  { label: 'Goods receipt', target: 'goods_receipt', local: 'goods_receipt' },
  { label: 'Supplier', target: 'party', local: 'supplier' },
  { label: 'Item', target: 'item', local: 'item' },
  { label: 'Location', target: 'location', local: 'location' },
] as const;
export const inspectionStates = [
  { label: 'Pending', role: 'inProgress' },
  { label: 'Passed', role: 'success' },
  { label: 'Failed', role: 'blocked' },
  { label: 'Conditional', role: 'attention' },
  { label: 'Quarantined', role: 'blocked' },
  { label: 'Released', role: 'success' },
] as const;
export const inspectionTransitions = [
  { label: 'Pass', from: 'Pending', to: 'Passed' },
  { label: 'Fail', from: 'Pending', to: 'Failed' },
  { label: 'Pass conditionally', from: 'Pending', to: 'Conditional' },
  { label: 'Quarantine', from: 'Pending', to: 'Quarantined' },
  { label: 'Release', from: 'Quarantined', to: 'Released' },
] as const;
export const inspectionFields = [
  { label: 'Characteristic', type: 'text', required: true },
  { label: 'Measured value', type: 'number' },
  { label: 'Pass', type: 'yesNo' },
] as const;

export const inspectionChange = {
  kind: 'changeSet',
  patches: [
    {
      kind: 'addRecordType',
      label: 'Goods Receipt Inspection',
      companyOwnership: 'entityOwned',
      fields: [{ label: 'Name', type: 'text' }],
    },
    ...inspectionLinks.map(({ label, target }) => ({
      kind: 'addLink',
      entity: inspectionEntity,
      label,
      target: `northstar.app:entity.${target}`,
    })),
    {
      kind: 'addLineTable',
      entity: inspectionEntity,
      label: 'Inspection results',
      fields: inspectionFields,
    },
    {
      kind: 'declareLifecycle',
      entity: inspectionEntity,
      initial: 'Pending',
      states: inspectionStates,
      transitions: inspectionTransitions,
    },
  ],
} as const;
