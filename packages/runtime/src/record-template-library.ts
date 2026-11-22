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
export interface RecordTemplateLibrary {
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
