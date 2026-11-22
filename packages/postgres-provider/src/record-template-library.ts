import type { Pool } from 'pg';
import type { RecordTemplateBinding } from '@north-star/canonical-model';
import {
  RecordTemplateContentSchema,
  type RecordTemplateContent,
} from '../../canonical-model/src/record-template-content.js';
import type {
  RecordTemplateLibrary,
  RecordTemplateRevision,
  RecordTemplateReview,
  TemplateLibraryTarget,
} from '../../runtime/src/record-template-library.js';
import {
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import { withTrustedRequestTransaction } from './request-context.js';

export function templatePermissionBindings(
  surfaces: readonly {
    surfaceId: string;
    recordTemplateBinding?: RecordTemplateBinding | undefined;
  }[],
) {
  return surfaces.flatMap((s) => {
    const binding = s.recordTemplateBinding;
    if (!binding) return [];
    return [
      ...['publish', 'assign', 'read'].map((action) => ({
        action,
        permissionId: s.surfaceId.replace(
          ':surface.',
          ':permission.template_' + action + '_',
        ),
        resourceId: s.surfaceId,
      })),
      ...binding.body.columns
        .filter((c) => c.copyEligible)
        .map((c) => ({
          action: 'disclose',
          permissionId: c.fieldId.replace(
            ':field.',
            ':permission.template_disclose_',
          ),
          resourceId: c.fieldId,
        })),
    ];
  });
}
export class PostgresRecordTemplateLibrary implements RecordTemplateLibrary {
  constructor(private readonly pool: Pool) {}
  private call<T>(view: RequestRuntimeView, sql: string, params: unknown[]) {
    return withTrustedRequestTransaction(
      this.pool,
      trustedContextForRequestRuntimeView(view),
      async (client) =>
        (await client.query<{ result: T }>(sql, params)).rows.map(
          (r) => r.result,
        ),
    );
  }
  async requireAuthor(view: RequestRuntimeView, target: TemplateLibraryTarget) {
    await this.call(
      view,
      'SELECT platform.record_template_author($1,$2,$3,$4) AS result',
      [target.company, view.release.releaseId, view.pointer.fence, target.form],
    );
  }
  async history(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    revisionId?: string,
  ) {
    return this.call<RecordTemplateRevision>(
      view,
      'SELECT platform.record_template_history($1,$2,$3,$4,$5) AS result',
      [
        target.company,
        view.release.releaseId,
        view.pointer.fence,
        target.form,
        revisionId ?? null,
      ],
    );
  }
  async review(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    templateId: string | null,
    predecessor: number,
    content: RecordTemplateContent,
  ) {
    return (
      await this.call<RecordTemplateReview>(
        view,
        'SELECT platform.review_record_template($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          target.company,
          view.release.releaseId,
          view.pointer.fence,
          target.form,
          templateId,
          predecessor,
          RecordTemplateContentSchema.parse(content),
        ],
      )
    )[0]!;
  }
  async publish(view: RequestRuntimeView, reviewId: string, digest: string) {
    return (
      await this.call<
        Pick<RecordTemplateRevision, 'revisionId' | 'templateId' | 'number'>
      >(view, 'SELECT platform.publish_record_template($1,$2) AS result', [
        reviewId,
        digest,
      ])
    )[0]!;
  }
  async assignmentVersion(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    context: string,
  ) {
    return (
      await this.call<number>(
        view,
        'SELECT platform.record_template_assignment_version($1,$2,$3,$4,$5) AS result',
        [
          target.company,
          view.release.releaseId,
          view.pointer.fence,
          target.form,
          context,
        ],
      )
    )[0]!;
  }
  async assign(
    view: RequestRuntimeView,
    target: TemplateLibraryTarget,
    ctx: string,
    version: number,
    revisionId: string,
  ) {
    return (
      await this.call<number>(
        view,
        'SELECT platform.assign_record_template($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          target.company,
          view.release.releaseId,
          view.pointer.fence,
          target.form,
          ctx,
          version,
          revisionId,
        ],
      )
    )[0]!;
  }
  async retire(view: RequestRuntimeView, templateId: string, number: number) {
    await this.call(
      view,
      'SELECT platform.retire_record_template($1,$2,$3,$4) AS result',
      [view.release.releaseId, view.pointer.fence, templateId, number],
    );
  }
}
