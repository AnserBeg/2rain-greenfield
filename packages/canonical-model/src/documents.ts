export const DOCUMENT_FILES_SURFACE_FLOOR = 27;
export const DOCUMENTS_PROJECTION_FAMILY =
  'northstar.compiler:projection-family.documents' as const;
export const DOCUMENTS_PAYLOAD_VERSION =
  'northstar.documents-payload/v1' as const;

export const DOCUMENT_BLOB_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_STAGING_MAX_BYTES = 40 * 1024 * 1024;
export const DOCUMENT_TENANT_MAX_BYTES = 100 * 1024 * 1024;
export const DOCUMENT_RESPONSE_MILLISECONDS = 30_000;

export const DOCUMENT_DEMO_SCANNER_LABEL =
  'Demo only — malware scanning disabled';

export const DOCUMENT_PERMISSIONS = Object.freeze({
  view: 'northstar.documents:permission.view',
  download: 'northstar.documents:permission.download',
  upload: 'northstar.documents:permission.upload',
});

export function documentAttachPermission(entityId: string): string {
  const [namespace, local] = entityId.split(':entity.');
  return `${namespace}:permission.document_attach_${local}`;
}
