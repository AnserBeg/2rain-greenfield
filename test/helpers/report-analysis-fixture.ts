import { CustomizationPatchSchema } from '../../packages/customization/src/index.js';

/** REPORTS-1 slice 2: a field-service shape built entirely in Customize. A
 * company-owned Site, an Inspection linked to it, and Inspection lines. */
export const reportAnalysisTypes = CustomizationPatchSchema.parse({
  kind: 'changeSet',
  patches: [
    {
      kind: 'addRecordType',
      label: 'Site',
      companyOwnership: 'entityOwned',
      fields: [
        { label: 'Name', type: 'text' },
        { label: 'Region', type: 'choice', options: ['East', 'West'] },
      ],
    },
    {
      kind: 'addRecordType',
      label: 'Inspection',
      companyOwnership: 'entityOwned',
      fields: [
        { label: 'Name', type: 'text' },
        { label: 'Outcome', type: 'choice', options: ['Pass', 'Fail'] },
        { label: 'Due', type: 'date' },
        { label: 'Score', type: 'number' },
      ],
    },
    {
      kind: 'addLink',
      entity: 'northstar.app:entity.custom_inspection',
      label: 'Site',
      target: 'northstar.app:entity.custom_site',
    },
    {
      kind: 'addLineTable',
      entity: 'northstar.app:entity.custom_inspection',
      label: 'Checks',
      fields: [
        { label: 'Item', type: 'text' },
        { label: 'Points', type: 'number' },
      ],
    },
  ],
});

/** The packet's eight-date aging fixture, as-of 2026-11-20. */
export const AGING_AS_OF = '2026-11-20';
export const AGING_DUE_DATES = [
  '2026-11-21',
  '2026-11-20',
  '2026-10-21',
  '2026-10-20',
  '2026-09-21',
  '2026-09-20',
  '2026-08-22',
  '2026-08-21',
] as const;
