import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { draftPatchFromRequest } from '../../packages/customization/src/ai-draft.js';
import { draftRecordTemplateContent } from '../../packages/customization/src/record-template-content-draft.js';
import { draftTemplateBinding } from '../../packages/customization/src/record-template-binding.js';
import type { RecordTemplateContent } from '../../packages/canonical-model/src/record-template-content.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import { raceFirstAssignmentWithRetirement } from './record-template-locks.js';
import { exercisePrecedingReader } from './record-template-reader.js';
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
    const firstPartyId = await run((v) => Promise.resolve(v.release.releaseId));
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
      const structure = {
        kind: 'changeSet',
        patches: [
          {
            kind: 'addRecordType',
            label: type,
            companyOwnership: 'entityOwned',
            fields: [
              { label: 'Name', type: 'text' },
              {
                label: context,
                type: 'choice',
                options: ['Standard', 'First', 'Second'],
              },
            ],
          },
          ...(kind === 'section'
            ? [
                {
                  kind: 'addRecordType',
                  label: 'Programme',
                  companyOwnership: 'entityOwned',
                  fields: [{ label: 'Name', type: 'text' }],
                },
                {
                  kind: 'addLink',
                  entity,
                  target: ns + 'entity.custom_programme',
                  label: 'Programme',
                },
              ]
            : []),
          {
            kind: 'addLineTable',
            entity,
            label: line,
            fields: [
              { label: 'Caption', type: 'text' },
              { label: 'Copies', type: 'number' },
              ...(kind === 'question'
                ? [
                    {
                      label: 'Result',
                      type: 'choice',
                      options: ['Pass', 'Fail', 'N/A'],
                    },
                  ]
                : []),
            ],
          },
        ],
      };
      const compatibleId = await activate(structure);
      const offers = (await opened.service.targets()).templateBindings!;
      const offer = offers.find((o) => o.frame.formId === form)!;
      assert.ok(offer);
      const cls =
        ns +
        'field.' +
        local +
        '_' +
        context.toLowerCase().replaceAll(' ', '_');
      const selector =
        kind === 'section'
          ? offer.contexts.find((c) => c.selector.kind === 'link')?.selector
          : undefined;
      if (kind === 'section') assert.ok(selector?.kind === 'link');
      const otherContext = randomUUID();
      const contextId = selector
        ? (await world.create('custom_programme', { name: 'Primary' })).recordId
        : cls.replace(':field.', ':option.') + '_standard';
      if (selector)
        assert.equal(
          (
            await world.invoke('custom_programme_create', {
              recordId: otherContext,
              legalEntityId: otherCompany,
              relations: {},
              values: { [ns + 'field.custom_programme_name']: 'Second school' },
            })
          ).outcome,
          'succeeded',
        );

      const choices = {
        formId: form,
        contextId: selector?.kind === 'link' ? selector.relationId : cls,
        required: true,
        lifecycle: 'active' as const,
        fields: offer.columns.map((c) => ({
          fieldId: c.fieldId,
          copyEligible: c.label !== 'Result' && c.label !== 'Caption',
          ...(c.label === 'Copies' && { audienceValues: ['1', '250', '750'] }),
        })),
      };
      const patch = draftTemplateBinding(offers, choices);
      const drafted = await draftPatchFromRequest(
        {
          modelId: 'template-binding-proof',
          next: async ({ tools }) => {
            const schema = tools[0]!.inputSchema as {
              properties: {
                kind: { enum: string[] };
                templateBinding: { properties: { fields: unknown } };
              };
            };
            assert.ok(schema.properties.kind.enum.includes(patch.kind));
            assert.ok(schema.properties.templateBinding.properties.fields);
            return {
              text: '',
              toolCalls: [
                {
                  id: 'binding',
                  name: tools[0]!.name,
                  input: { kind: patch.kind, templateBinding: choices },
                },
              ],
            };
          },
        },
        'Enable a template for ' + line,
        await opened.service.targets(),
      );
      assert.ok(
        drafted.status === 'parsed' && drafted.patch.kind === patch.kind,
      );
      assert.deepEqual(drafted.patch.body, patch.body);
      const caption = offer.columns.find((c) => c.label === 'Caption')!.fieldId;
      const copies = offer.columns.find((c) => c.label === 'Copies')!.fieldId;
      const answer = offer.columns.find((c) => c.label === 'Result')?.fieldId;
      const source =
        kind === 'row'
          ? await world.create(local, { name: 'Original print job' })
          : undefined;
      const sourceLine = source
        ? await world.create(
            local + '_lines',
            { line_number: '1', copies: '750', caption: 'Private original' },
            { parent: source.recordId },
          )
        : undefined;
      if (kind === 'question') {
        const before = await world.create(local, {
          name: 'Compatible inspection',
        });
        await exercisePrecedingReader({
          pool,
          databaseUrl,
          identity: runtime.identity,
          firstPartyId,
          compatibleId,
          compatiblePatch: structure,
          patch,
          recordId: before.recordId,
          queryId: ns + 'query.' + local + '_get',
          args: {
            recordId: before.recordId,
            [ns + 'parameter.' + local + '_get_legal_entity_scope']: COMPANY,
          },
          declare: () => activate(patch),
        });
        assert.equal(
          (await world.read(local, before.recordId)).recordId,
          before.recordId,
        );
      } else await activate(patch);
      const target = { company: COMPANY, form },
        other = { company: otherCompany, form };
      const content: RecordTemplateContent = {
        version: 1,
        label,
        columns: offer.columns.map((c) => ({
          fieldId: c.fieldId,
          caption: c.label,
        })),
        members: [
          {
            key: 'first',
            kind,
            caption: label,
            cells: kind === 'row' ? { [copies]: '750' } : {},
            ...(answer && {
              answer: {
                fieldId: answer,
                required: true,
                noteFieldId: caption,
                choices: ['pass', 'fail'].map((v) => ({
                  id: answer.replace(':field.', ':option.') + '_' + v,
                  meaning: v === 'pass' ? 'Pass' : 'Fail',
                  requiresNote: v === 'fail',
                  blocksTransition: v === 'fail',
                })),
              },
            }),
            ...(source &&
              sourceLine && {
                source: {
                  parentId: source.recordId,
                  rowId: sourceLine.recordId,
                },
              }),
          },
        ],
      };
      const readable = {
        ...content,
        members: content.members.map((m) => {
          const copy = { ...m };
          delete copy.source;
          return copy;
        }),
      };
      const spoken = await draftRecordTemplateContent(
        {
          modelId: 'template-content-proof',
          next: async ({ tools }) => ({
            text: '',
            toolCalls: [
              {
                id: 'content',
                name: tools[0]!.name,
                input: {
                  ...content,
                  members: readable.members.map((m) => ({
                    ...m,
                    caption: 'Suggested ' + label,
                  })),
                },
              },
            ],
          }),
        },
        patch,
        'Draft ' + line,
      );
      assert.equal(spoken.members[0]!.caption, 'Suggested ' + label);
      if (kind === 'row') {
        const revised = (cells: Record<string, string>) => ({
          ...content,
          members: content.members.map((m) => ({ ...m, cells })),
        });
        await assert.rejects(
          run((v) =>
            library.review(
              v,
              target,
              null,
              0,
              revised({ [caption]: 'Private original' }),
            ),
          ),
          /template.copyIneligible/u,
        );
        await assert.rejects(
          run((v) =>
            library.review(v, target, null, 0, revised({ [copies]: '999' })),
          ),
          /template.audienceDenied/u,
        );
        await assert.rejects(
          run((v) =>
            library.review(v, target, null, 0, revised({ [copies]: '250' })),
          ),
          /template.sourceChanged/u,
        );
      }
      if (answer) {
        const m = content.members[0]!,
          a = m.answer!;
        await assert.rejects(
          run((v) =>
            library.review(v, target, null, 0, {
              ...content,
              members: [{ ...m, cells: { [answer]: a.choices[0]!.id } }],
            }),
          ),
          /template.invalidAnswer/u,
        );
        await assert.rejects(
          run((v) =>
            library.review(v, target, null, 0, {
              ...content,
              members: [
                {
                  ...m,
                  answer: {
                    ...a,
                    choices: [{ ...a.choices[0]!, id: 'unknown' }],
                  },
                },
              ],
            }),
          ),
          /template.invalidChoice/u,
        );
      }
      const review = await run((v) =>
        library.review(v, target, null, 0, content),
      );
      await assert.rejects(
        run((v) => library.publish(v, review.reviewId, '0'.repeat(64))),
      );
      if (sourceLine) {
        const grantId = ns + 'query.' + local + '_lines_get';
        const scoped = await pool.query<{ role_id: string }>(
          'UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND environment_id=$2 AND resource_id=$3 AND revoked_at IS NULL RETURNING role_id',
          [runtime.identity.tenantId, runtime.identity.environmentId, grantId],
        );
        assert.ok(
          scoped.rowCount,
          'revoke the source read while retaining publish',
        );
        try {
          await assert.rejects(
            run((v) => library.publish(v, review.reviewId, review.digest)),
          );
        } finally {
          await pool.query(
            'UPDATE platform.current_policy_permission_grants SET revoked_at=NULL WHERE (tenant_id,environment_id,resource_id)=($1,$2,$3) AND role_id=ANY($4::uuid[])',
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              grantId,
              scoped.rows.map((r) => r.role_id),
            ],
          );
        }
        assert.equal((await run((v) => library.history(v, target))).length, 0);
      }
      const published = await run((v) =>
        library.publish(v, review.reviewId, review.digest),
      );
      assert.equal(published.number, 1);
      if (selector)
        await assert.rejects(
          run((v) =>
            library.assign(v, target, otherContext, 0, published.revisionId),
          ),
          /template.invalidContext/u,
        );
      if (kind === 'row') {
        for (const [suffix, first] of [
          ['first', 'assign'],
          ['second', 'retire'],
        ] as const) {
          const ctx = cls.replace(':field.', ':option.') + '_' + suffix;
          const reviewed = await run((v) =>
            library.review(v, target, null, 0, readable),
          );
          const r = await run((v) =>
            library.publish(v, reviewed.reviewId, reviewed.digest),
          );
          await run((v) =>
            raceFirstAssignmentWithRetirement(
              pool,
              databaseUrl,
              v,
              library,
              target,
              ctx,
              r,
              first,
            ),
          );
        }
      }
      const copy = await run((v) =>
        library.review(v, other, null, 0, {
          ...readable,
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
      const firstAssignments = await Promise.allSettled(
        [0, 1].map(() =>
          run((v) =>
            library.assign(v, target, contextId, 0, published.revisionId),
          ),
        ),
      );
      assert.equal(
        firstAssignments.filter((r) => r.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        await run((v) => library.assignmentVersion(v, target, contextId)),
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
      const history = (await run((v) => library.history(v, target))).filter(
        (r) => r.templateId === published.templateId,
      );
      assert.deepEqual(
        history.map((r) => r.number),
        [2, 1],
      );
      assert.deepEqual(history[1]!.content, readable);
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
