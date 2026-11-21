import { slug } from './apply.js';
import type { CustomizationPatch } from './patch.js';

/**
 * Address, map and files members derive their stable IDs from the record
 * type and the label, the same way the Customize screen's forms do, so a
 * channel that chooses only a record type and a label (the AI drafter)
 * produces the same member as the form.
 */
type Member = Extract<
  CustomizationPatch,
  {
    kind:
      | 'addAddressField'
      | 'addMapPlacement'
      | 'addDocumentField'
      | 'addUploadCategory';
  }
>;

function split(entityId: string): [string, string] {
  const [namespace, local] = entityId.split(':entity.');
  if (!namespace || !local) throw new Error('Choose a record type.');
  return [namespace, local];
}

export function addressFieldId(entityId: string, label: string): string {
  const [namespace, local] = split(entityId);
  return `${namespace}:field.custom_${local}_${slug(label)}`;
}

export function addressFieldMember(
  entityId: string,
  label: string,
  required = false,
): Extract<Member, { kind: 'addAddressField' }> {
  return {
    kind: 'addAddressField',
    schemaVersion: 'v6',
    entity: entityId,
    fieldId: addressFieldId(entityId, label.trim()),
    label: label.trim(),
    required,
  };
}

export function mapPlacementMember(
  fieldId: string,
  surfaceId: string,
  sectionId: string,
): Extract<Member, { kind: 'addMapPlacement' }> {
  return {
    kind: 'addMapPlacement',
    schemaVersion: 'v6',
    placementId: fieldId.replace(':field.', ':placement.') + '_map',
    surfaceId,
    sectionId,
    fieldId,
  };
}

export function uploadCategoryMember(
  entityId: string,
  fieldId: string,
  fieldLabel: string,
  name: string,
  maxCount: number,
): Extract<Member, { kind: 'addUploadCategory' }> {
  const [namespace, entity] = split(entityId);
  return {
    kind: 'addUploadCategory',
    schemaVersion: 'northstar.document-category/v1',
    categoryId: `${namespace}:category.custom_${entity}_${slug(fieldLabel)}_${slug(name)}`,
    fieldId,
    entityId,
    label: name.trim(),
    maxCount,
    required: false,
    visibility: 'internal',
    retentionClass: 'northstar.documents:retention.manual',
    documentExpiryDate: null,
    maxBytes: 20 * 1024 * 1024,
    contentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  } as Extract<Member, { kind: 'addUploadCategory' }>;
}

/** A files field and its categories: the field first, then each category. */
export function documentFieldMembers(
  entityId: string,
  label: string,
  options: {
    readonly required?: boolean;
    readonly maxCount?: number;
    readonly categories?: readonly string[];
  } = {},
): Member[] {
  const [namespace, entity] = split(entityId);
  const fieldLabel = label.trim();
  const maxCount = options.maxCount ?? 1;
  const fieldId = `${namespace}:field.custom_${entity}_${slug(fieldLabel)}`;
  const categories = (options.categories ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) =>
      uploadCategoryMember(entityId, fieldId, fieldLabel, name, maxCount),
    );
  return [
    {
      kind: 'addDocumentField',
      schemaVersion: 'northstar.document-field/v1',
      type: 'files',
      fieldId,
      entityId,
      label: fieldLabel,
      required: options.required ?? false,
      maxCount,
      allowedCategoryIds: categories.map(({ categoryId }) => categoryId),
    } as Extract<Member, { kind: 'addDocumentField' }>,
    ...categories,
  ];
}
