import type { RecordTemplateBinding } from '../../canonical-model/src/record-template.js';
import type { RecordTemplateContent } from '../../canonical-model/src/record-template-content.js';
import type { RequestRuntimeView } from './request-runtime-view.js';

export interface RecordTemplateRevision {
  templateId: string;
  number: number;
  revisionId: string;
  digest: string;
  retired: boolean;
  content: RecordTemplateContent;
}
export interface RecordTemplateReview {
  reviewId: string;
  digest: string;
  templateId: string;
  content: RecordTemplateContent;
}
export interface TemplateLibraryTarget {
  company: string;
  form: string;
}
export interface TemplateApplicationSelection {
  binding: RecordTemplateBinding;
  context: string | null;
  assignment: {
    version: number;
    revision_id: string;
    template_id: string;
    digest: string;
    content: RecordTemplateContent;
  } | null;
}
export function templateCreateSurface(
  view: RequestRuntimeView,
  operationId: string,
) {
  const manifest = view.projections.surface.payload as unknown as {
    surfaces?: {
      recordTemplateBinding?: RecordTemplateBinding;
      documentEditor?: { lineNumberFieldId: string };
      surfaceId: string;
    }[];
  };
  const matched =
    manifest.surfaces?.filter(
      (s) =>
        s.recordTemplateBinding?.status === 'active' &&
        s.recordTemplateBinding.body.createOperationId === operationId,
    ) ?? [];
  if (matched.length > 1)
    throw new Error('Ambiguous template binding on create.');
  const surface = matched[0];
  if (!surface) return undefined;
  if (!surface.documentEditor || !surface.recordTemplateBinding)
    throw new Error('Template editor is unavailable.');
  return {
    ...surface,
    documentEditor: surface.documentEditor,
    recordTemplateBinding: surface.recordTemplateBinding,
  };
}

export interface RecordTemplateLibrary {
  prepareCreate(
    view: RequestRuntimeView,
    form: string,
    requestKey: string,
    input: unknown,
  ): Promise<TemplateApplicationSelection>;
  application(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    parentId: string,
  ): Promise<
    | (TemplateApplicationSelection & { memberRows: Record<string, string> })
    | null
  >;
  requireAuthor(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
  ): Promise<void>;
  history(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    revisionId?: string,
  ): Promise<RecordTemplateRevision[]>;
  review(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    templateId: string | null,
    predecessor: number,
    content: RecordTemplateContent,
  ): Promise<RecordTemplateReview>;
  publish(
    view: RequestRuntimeView,
    reviewId: string,
    digest: string,
  ): Promise<
    Pick<RecordTemplateRevision, 'revisionId' | 'templateId' | 'number'>
  >;
  assignmentVersion(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    context: string,
  ): Promise<number>;
  assign(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    context: string,
    version: number,
    revisionId: string,
  ): Promise<number>;
  retire(
    view: RequestRuntimeView,
    templateId: string,
    number: number,
  ): Promise<void>;
}
