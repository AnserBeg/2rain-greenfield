import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import { DocumentsProjectionSchema } from '../../../packages/canonical-model/src/schemas.js';
import { escapeHtml } from './html.js';

export function renderDocumentSection(
  view: RequestRuntimeView,
  target: {
    surfaceId: string;
    recordId: string;
    companyId: string | null;
    entityId: string;
  },
  scannerLabel: string | null,
): string {
  const projection = view.projections.documents;
  const declaration = projection
    ? DocumentsProjectionSchema.parse(projection.payload)
    : null;
  const fields =
    declaration?.fields.filter((field) => field.entityId === target.entityId) ??
    [];
  const path =
    '/documents?' +
    new URLSearchParams({
      surface: target.surfaceId,
      record: target.recordId,
      ...(target.companyId ? { company: target.companyId } : {}),
    });
  const section = (field?: (typeof fields)[number]) => {
    const categories =
      declaration?.categories.filter(
        (category) => category.fieldId === field?.fieldId,
      ) ?? [];
    const label = escapeHtml(field?.label ?? 'Attachments');
    const id = escapeHtml(field?.fieldId ?? '');
    const categoryControl = categories.length
      ? `<label>Category <select name="category" required><option value="">Choose a category</option>${categories.map((category) => `<option value="${escapeHtml(category.categoryId)}">${escapeHtml(category.label)}</option>`).join('')}</select></label>`
      : '';
    const form = scannerLabel
      ? `<form data-document-upload data-field="${id}">${categoryControl}<label>Choose file <input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required></label><button type="submit">Attach</button></form>`
      : '';
    return `<div data-document-field="${id}"><h3>${label}</h3>${field ? `<p>Up to ${field.maxCount} files${field.required ? ' · Required for document tasks' : ''}</p>` : ''}<ul data-document-rows></ul>${form}</div>`;
  };
  return `<section class="panel data-panel"><details data-documents="${escapeHtml(path)}"><summary><h2>Files</h2></summary>${scannerLabel ? `<p>${escapeHtml(scannerLabel)}</p>` : ''}<p role="status" data-documents-status></p>${section()}${fields.map((field) => section(field)).join('')}</details></section>`;
}
