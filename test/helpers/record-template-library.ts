import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { draftTemplateBinding } from '../../packages/customization/src/record-template-binding.js';
import type { RecordTemplateContent } from '../../packages/canonical-model/src/record-template-content.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';

export async function exerciseTemplateLibrary(
  databaseUrl: string,
  pool: pg.Pool,
) {
  const options = { databaseUrl, tenantSlug: 'template-library' };
  const app = await startComposedApplication({ ...options, port: 0 });
  const opened = await openCustomizeService(options);
  const { runtime } = app,
    library = runtime.recordTemplates;
  const run = <T>(
    work: (v: RequestRuntimeView) => Promise<T>,
    actor = 'manager',
  ) =>
    runtime.entry.run(
      { headers: { cookie: 'northstar-demo-actor=' + actor } },
      work,
    );
  const activate = async (input: unknown) => {
    const r = await opened.service.draft(input, 'visualBuilder');
    assert.ok(r.status === 'drafted', JSON.stringify(r));
    await opened.service.approve(r.patchId);
    await opened.service.activate(r.patchId);
    return r.releaseId;
  };
  const ns = 'northstar.app:';
  const world = worldOver(
    runtime,
    'template-library',
    databaseUrl,
    'template-library',
  );
  try {
    const otherCompany = randomUUID();
    const created = await world.invoke('legal_entity_create', {
      recordId: otherCompany,
      relations: {},
      values: {
        [ns + 'field.legal_entity_name']: 'Second company',
        [ns + 'field.legal_entity_code']: 'SECONDT',
        [ns + 'field.legal_entity_is_default']: false,
        [ns + 'field.legal_entity_status']:
          ns + 'option.legal_entity_status_active',
      },
    });
    assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
    for (const [type, context, line, label, kind] of [
      ['Inspection', 'Class', 'Results', 'Brake holds', 'question'],
      ['Job ticket', 'Job class', 'Steps', 'Run', 'row'],
      ['Enrolment', 'Intake', 'Contacts', 'Guardian', 'section'],
    ] as const) {
      const local = 'custom_' + type.toLowerCase().replaceAll(' ', '_');
      const entity = ns + 'entity.' + local;
      const form = ns + 'surface.' + local + '_form';
      await activate({
        kind: 'changeSet',
        patches: [
          {
            kind: 'addRecordType',
            label: type,
            companyOwnership: 'entityOwned',
            fields: [
              { label: 'Name', type: 'text' },
              { label: context, type: 'choice', options: ['Standard'] },
            ],
          },
          {
            kind: 'addLineTable',
            entity,
            label: line,
            fields: [
              { label: 'Caption', type: 'text' },
              { label: 'Copies', type: 'number' },
            ],
          },
        ],
      });
      const offers = (await opened.service.targets()).templateBindings!;
      const offer = offers.find((o) => o.frame.formId === form)!;
      assert.ok(offer);
      const cls =
        ns +
        'field.' +
        local +
        '_' +
        context.toLowerCase().replaceAll(' ', '_');
      const contextId = cls.replace(':field.', ':option.') + '_standard';
      const patch = draftTemplateBinding(offers, {
        formId: form,
        contextId: cls,
        required: true,
        lifecycle: 'active',
        fields: offer.columns.map((c) => ({
          fieldId: c.fieldId,
          copyEligible: true,
        })),
      });
      await activate(patch);
      const target = { company: COMPANY, form },
        other = { company: otherCompany, form };
      const content: RecordTemplateContent = {
        version: 1,
        label,
        columns: offer.columns.map((c) => ({
          fieldId: c.fieldId,
          caption: c.label,
        })),
        members: [{ key: 'first', kind, caption: label, cells: {} }],
      };
      const review = await run((v) =>
        library.review(v, target, null, 0, content),
      );
      await assert.rejects(
        run((v) => library.publish(v, review.reviewId, '0'.repeat(64))),
      );
      const published = await run((v) =>
        library.publish(v, review.reviewId, review.digest),
      );
      assert.equal(published.number, 1);
      const copy = await run((v) =>
        library.review(v, other, null, 0, {
          ...content,
          label: 'Private ' + label,
        }),
      );
      const elsewhere = await run((v) =>
        library.publish(v, copy.reviewId, copy.digest),
      );
      await assert.rejects(
        run((v) =>
          library.assign(v, target, contextId, 0, elsewhere.revisionId),
        ),
      );
      assert.equal(
        await run((v) =>
          library.assign(v, target, contextId, 0, published.revisionId),
        ),
        1,
      );
      await assert.rejects(
        run((v) =>
          library.assign(v, target, contextId, 0, published.revisionId),
        ),
      );
      const successor = await run((v) =>
        library.review(v, target, published.templateId, 1, {
          ...content,
          label: 'Second ' + label,
        }),
      );
      const concurrent = await run((v) =>
        library.review(v, target, published.templateId, 1, {
          ...content,
          label: 'Competing ' + label,
        }),
      );
      const race = await Promise.allSettled(
        [successor, concurrent].map((r) =>
          run((v) => library.publish(v, r.reviewId, r.digest)),
        ),
      );
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      const history = await run((v) => library.history(v, target));
      assert.deepEqual(
        history.map((r) => r.number),
        [2, 1],
      );
      assert.deepEqual(history[1]!.content, content);
      await run((v) => library.retire(v, published.templateId, 2));
      await assert.rejects(
        run((v) =>
          library.assign(v, target, contextId, 1, published.revisionId),
        ),
      );
      assert.ok(
        (await run((v) => library.history(v, target))).every((r) => r.retired),
      );
      await assert.rejects(
        run((v) => library.review(v, target, null, 0, content), 'buyer'),
      );
      assert.equal(
        (await run((v) => library.history(v, target, elsewhere.revisionId)))
          .length,
        0,
      );
      const buyer = runtime.identity;
      await pool.query(
        'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND revoked_at IS NULL',
        [buyer.tenantId, buyer.environmentId, buyer.principalId, COMPANY],
      );
      assert.equal(
        (
          await run(
            (v) => library.history(v, target, published.revisionId),
            'buyer',
          )
        ).length,
        1,
      );
      await assert.rejects(
        run((v) => library.history(v, other, elsewhere.revisionId), 'buyer'),
      );
    }
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege('north_star_runtime','platform.record_template_revisions','SELECT') AS granted",
        )
      ).rows[0].granted,
      false,
    );
  } finally {
    await opened.close();
    await app.close();
  }
}
