import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { templateLibraryPanel } from '../../apps/web/src/surface-runtime.js';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { draftPatchFromRequest } from '../../packages/customization/src/ai-draft.js';
import { draftRecordTemplateContent } from '../../packages/customization/src/record-template-content-draft.js';
import { draftTemplateBinding } from '../../packages/customization/src/record-template-binding.js';
import { literalValidationDraft } from '../../packages/customization/src/validation-draft.js';
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
    let heldReview: { reviewId: string; digest: string } | undefined;
    const kinds = [
      ['Inspection', 'Class', 'Results', 'Brake holds', 'question'],
      ['Job ticket', 'Job class', 'Steps', 'Run', 'row'],
      ['Enrolment', 'Intake', 'Contacts', 'Guardian', 'section'],
    ] as const;
    // Each release activation runs full release verification, so the three
    // businesses share one structure release and one declaring release.
    const structureFor = ([
      type,
      context,
      line,
      ,
      kind,
    ]: (typeof kinds)[number]) => {
      const local = 'custom_' + type.toLowerCase().replaceAll(' ', '_');
      const entity = ns + 'entity.' + local;
      return [
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
      ];
    };
    const structure = {
      kind: 'changeSet',
      patches: kinds.flatMap(structureFor),
    };
    const compatibleId = await activate(structure);
    // Phase 1 (before any binding) runs for each business in order, then the
    // one declaring release activates, then phase 2 runs for each in order.
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    };
    const first = kinds.map(gate),
      second = kinds.map(gate),
      declared = gate();
    const bindings: unknown[] = [];
    let reader:
      | Omit<Parameters<typeof exercisePrecedingReader>[0], 'declare'>
      | undefined;
    const runs = kinds.map(
      async ([type, context, line, label, kind], index) => {
        await first[index]!.opened;
        const local = 'custom_' + type.toLowerCase().replaceAll(' ', '_');
        const form = ns + 'surface.' + local + '_form';
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
          ? (await world.create('custom_programme', { name: 'Primary' }))
              .recordId
          : cls.replace(':field.', ':option.') + '_standard';
        if (selector)
          assert.equal(
            (
              await world.invoke('custom_programme_create', {
                recordId: otherContext,
                legalEntityId: otherCompany,
                relations: {},
                values: {
                  [ns + 'field.custom_programme_name']: 'Second school',
                },
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
            ...(c.label === 'Copies' && {
              audienceValues: ['1', '250', '750'],
            }),
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
        const caption = offer.columns.find(
          (c) => c.label === 'Caption',
        )!.fieldId;
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
        const restrictedSource = source
          ? await world.create(
              local + '_lines',
              {
                line_number: '2',
                copies: '999',
                caption: 'Restricted original',
              },
              { parent: source.recordId },
            )
          : undefined;
        const before =
          kind === 'question'
            ? await world.create(local, { name: 'Compatible inspection' })
            : undefined;
        if (before)
          reader = {
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
          };
        bindings.push(patch);
        (first[index + 1] ?? declared).open();
        await second[index]!.opened;
        if (before)
          assert.equal(
            (await world.read(local, before.recordId)).recordId,
            before.recordId,
          );
        await assert.rejects(
          world.create(local, { name: 'Unprepared record' }),
          {
            code: 'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
          },
        );
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
        const labels = new Map(
          offer.columns.map((column) => [column.fieldId, column.label]),
        );
        let calls = 0;
        const describe = (view: RequestRuntimeView) =>
          templateLibraryPanel(
            view,
            library,
            target,
            patch,
            labels,
            new Map(),
            { templateAction: 'draftContent', request: 'Draft ' + line },
            async () => {
              calls++;
              return spoken;
            },
          );
        await assert.rejects(run(describe, 'buyer'), /template.unavailable/u);
        assert.equal(
          calls,
          0,
          'denying the author must happen before invoking the provider',
        );
        const editable = await run(describe);
        assert.equal(calls, 1);
        assert.ok(editable.includes('value="Suggested ' + label + '"'));
        assert.ok(editable.includes('Preview publication'));
        assert.deepEqual(await run((v) => library.history(v, target)), []);

        if (kind === 'row') {
          const revised = (
            cells: Record<string, string>,
            sourceRowId?: string,
          ) => ({
            ...content,
            members: content.members.map((m) => ({
              ...m,
              cells,
              ...(sourceRowId &&
                m.source && { source: { ...m.source, rowId: sourceRowId } }),
            })),
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
              library.review(
                v,
                target,
                null,
                0,
                revised({ [copies]: '999' }, restrictedSource!.recordId),
              ),
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
          for (const choice of [
            { ...a.choices[0]!, id: 'unknown' },
            { ...a.choices[0]!, meaning: 'Different meaning' },
          ])
            await assert.rejects(
              run((v) =>
                library.review(v, target, null, 0, {
                  ...content,
                  members: [
                    {
                      ...m,
                      answer: {
                        ...a,
                        choices: [choice],
                      },
                    },
                  ],
                }),
              ),
              /template.invalidChoice/u,
            );
        }
        for (const invalid of [
          { ...content, members: [content.members[0]!, content.members[0]!] },
          { ...content, columns: [content.columns[0]!, content.columns[0]!] },
          {
            ...content,
            columns: [
              { fieldId: 'northstar.app:field.outside', caption: 'Outside' },
            ],
          },
        ]) {
          await assert.rejects(
            run((v) => library.review(v, target, null, 0, invalid)),
            /template.invalidSelection/u,
          );
        }
        const review = await run((v) =>
          library.review(v, target, null, 0, content),
        );
        await assert.rejects(
          run((v) => library.publish(v, review.reviewId, '0'.repeat(64))),
        );
        if (sourceLine) {
          const {
            rows: [sourceQuery],
          } = await pool.query<{ permission: string }>(
            `SELECT q#>>'{permission,targetId}' AS permission
          FROM platform.tenant_releases r JOIN platform.app_package_revisions d ON (r.tenant_id,r.app_package_revision_id)=(d.tenant_id,d.revision_id)
          CROSS JOIN LATERAL jsonb_array_elements(convert_from(d.desired_state,'UTF8')::jsonb->'queries') q
          WHERE r.release_id=$1 AND q->>'queryId'=$2`,
            [compatibleId, ns + 'query.' + local + '_lines_get'],
          );
          assert.ok(sourceQuery);
          for (const [grantId, refusal] of [
            [sourceQuery.permission, /communication.unavailable/u],
            [
              copies.replace(':field.', ':permission.template_disclose_'),
              /template.audienceDenied/u,
            ],
          ] as const) {
            const scoped = await pool.query<{ role_id: string }>(
              'UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND environment_id=$2 AND permission_id=$3 AND revoked_at IS NULL RETURNING role_id',
              [
                runtime.identity.tenantId,
                runtime.identity.environmentId,
                grantId,
              ],
            );
            assert.ok(
              scoped.rowCount,
              'revoke only the selected source or disclosure grant',
            );
            try {
              if (grantId === sourceQuery.permission)
                await assert.rejects(
                  run((v) => library.history(v, target)),
                  /communication.unavailable/u,
                );
              await assert.rejects(
                run((v) => library.publish(v, review.reviewId, review.digest)),
                refusal,
              );
            } finally {
              await pool.query(
                'UPDATE platform.current_policy_permission_grants SET revoked_at=NULL WHERE (tenant_id,environment_id,permission_id)=($1,$2,$3) AND role_id=ANY($4::uuid[])',
                [
                  runtime.identity.tenantId,
                  runtime.identity.environmentId,
                  grantId,
                  scoped.rows.map((r) => r.role_id),
                ],
              );
            }
            assert.equal(
              (await run((v) => library.history(v, target))).length,
              0,
            );
          }
        }
        const published = await run((v) =>
          library.publish(v, review.reviewId, review.digest),
        );
        assert.equal(published.number, 1);
        if (kind === 'section') {
          const member = readable.members[0]!;
          const first = await run((v) =>
            library.review(v, target, null, 0, {
              ...readable,
              members: [member, { ...member, key: 'spare' }],
            }),
          );
          const created = await run((v) =>
            library.publish(v, first.reviewId, first.digest),
          );
          const drop = await run((v) =>
            library.review(v, target, created.templateId, 1, readable),
          );
          await run((v) => library.publish(v, drop.reviewId, drop.digest));
          for (const members of [
            [member, { ...member, key: 'spare' }],
            [{ ...member, kind: 'instruction' as const }],
          ]) {
            const invalid = await run((v) =>
              library.review(v, target, created.templateId, 2, {
                ...readable,
                members,
              }),
            );
            await assert.rejects(
              run((v) => library.publish(v, invalid.reviewId, invalid.digest)),
              /template.memberKeyReused/u,
            );
          }
          assert.equal(
            (await run((v) => library.history(v, target))).filter(
              (r) => r.templateId === created.templateId,
            ).length,
            2,
          );
          await run((v) => library.retire(v, created.templateId, 2));
        } else {
          await assert.rejects(
            run((v) =>
              library.assign(v, target, 'undeclared', 0, published.revisionId),
            ),
            /template.invalidContext/u,
          );
        }
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
        heldReview = await run((v) =>
          library.review(v, target, null, 0, readable),
        );
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
          /template.revisionUnavailable/u,
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
          /template.assignmentChanged/u,
        );
        await assert.rejects(
          run(
            (v) =>
              library.assign(v, target, contextId, 1, published.revisionId),
            'buyer',
          ),
          /template.unavailable/u,
        );
        await assert.rejects(
          run((v) => library.requireAuthor(v, target), 'buyer'),
          /template.unavailable/u,
        );
        const header = {
          recordId: randomUUID(),
          legalEntityId: COMPANY,
          values: {
            [ns + 'field.' + local + '_name']: 'Created from ' + label,
            ...(!selector && { [cls]: contextId }),
          },
          relations:
            selector?.kind === 'link'
              ? { [selector.relationId]: contextId }
              : {},
        };
        const key = randomUUID();
        const prepare = (k: string, h: typeof header = header) =>
          run((v) => library.prepareCreate(v, form, k, h));
        const create = (k: string, h: typeof header = header) =>
          world.invoke(local + '_create', h, { idempotencyKey: k });
        const application = () =>
          run((v) => library.application(v, target, header.recordId));
        const prepared = await prepare(key);
        assert.equal(prepared.assignment?.revision_id, published.revisionId);
        const staged = { ...header, recordId: randomUUID() };
        const staleKey = randomUUID();
        await prepare(staleKey, staged);
        const results = await Promise.all([create(key), create(key)]);
        assert.ok(results[0].trust?.invocationId);
        assert.deepEqual(results[1].trust, results[0].trust);
        assert.equal(results[0].readBack?.recordId, header.recordId);
        const pin = await application();
        assert.deepEqual(pin?.assignment?.content, readable);
        assert.equal(pin?.context, contextId);
        if (kind === 'section') assert.deepEqual(pin?.memberRows, {});
        else {
          const rowId = pin?.memberRows.first;
          assert.ok(rowId);
          const row = await world.read(local + '_lines', rowId);
          assert.equal(row.recordId, rowId);
          if (kind === 'row') assert.equal(row.values[copies], '750');
          await world.invoke(local + '_lines_update', {
            recordId: rowId,
            expectedRevision: 1,
            patch: { [caption]: 'Edited on the record' },
          });
        }
        await assert.rejects(
          create(key, {
            ...header,
            values: {
              ...header.values,
              [ns + 'field.' + local + '_name']: 'Changed request',
            },
          }),
        );
        await world.invoke(local + '_update', {
          recordId: header.recordId,
          expectedRevision: 1,
          patch: { [ns + 'field.' + local + '_name']: 'Edited parent' },
        });
        assert.equal(
          (await create(key)).readBack?.values[ns + 'field.' + local + '_name'],
          'Edited parent',
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
        await run((v) =>
          library.assign(v, target, contextId, 1, history[0]!.revisionId),
        );
        await assert.rejects(
          create(staleKey, staged),
          /template.freshPreviewRequired/u,
        );
        const newer = { ...header, recordId: randomUUID() };
        const nextKey = randomUUID();
        assert.equal(
          (await prepare(nextKey, newer)).assignment?.revision_id,
          history[0]!.revisionId,
        );
        assert.equal((await create(nextKey, newer)).outcome, 'succeeded');
        // A reviewed key no create has used: the operation layer holds no
        // receipt to compare, so only the template review can refuse a create
        // whose payload changed after the preview.
        const reviewed = { ...header, recordId: randomUUID() };
        const reviewedKey = randomUUID();
        await prepare(reviewedKey, reviewed);
        await assert.rejects(
          create(reviewedKey, {
            ...reviewed,
            values: {
              ...reviewed.values,
              [ns + 'field.' + local + '_name']: 'Changed after review',
            },
          }),
          /template.requestChanged/u,
        );
        assert.equal(
          (await application())?.assignment?.revision_id,
          published.revisionId,
        );
        if (pin?.memberRows.first)
          assert.equal(
            (await world.read(local + '_lines', pin.memberRows.first)).values[
              caption
            ],
            'Edited on the record',
          );
        // Preview (rule 2): the assigner holds the same grants in both
        // companies and each company has an assigned revision, so a second
        // company preview succeeds; removing only that company membership
        // then refuses it while the first company still previews.
        const otherKey = selector ? otherContext : contextId;
        await run((v) =>
          library.assign(v, other, otherKey, 0, elsewhere.revisionId),
        );
        const crossed = () => ({
          recordId: randomUUID(),
          legalEntityId: otherCompany,
          values: {
            [ns + 'field.' + local + '_name']: 'Second company ' + label,
            ...(!selector && { [cls]: otherKey }),
          },
          relations:
            selector?.kind === 'link'
              ? { [selector.relationId]: otherKey }
              : {},
        });
        const home = () => ({ ...header, recordId: randomUUID() });
        assert.equal(
          (
            await run((v) =>
              library.prepareCreate(v, form, randomUUID(), crossed()),
            )
          ).assignment?.revision_id,
          elsewhere.revisionId,
        );
        // A real second-company instance: a record created in company B from
        // B's assigned revision, so the company checks below guard B's data.
        // The header type pins company A; this parent is company B by design.
        const secondParent = crossed() as unknown as typeof header;
        const secondKey = randomUUID();
        await prepare(secondKey, secondParent);
        assert.equal(
          (await create(secondKey, secondParent)).outcome,
          'succeeded',
        );
        assert.equal(
          (
            await run((v) =>
              library.application(v, other, secondParent.recordId),
            )
          )?.assignment?.revision_id,
          elsewhere.revisionId,
        );
        const assigner = await run((v) => Promise.resolve(v.principalId));
        const memberships = (
          await pool.query<{
            membership_id: string;
            legal_entity_id: string | null;
          }>(
            'SELECT membership_id, legal_entity_id FROM platform.current_policy_memberships WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND revoked_at IS NULL AND legal_entity_id IS DISTINCT FROM $4',
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              assigner,
              COMPANY,
            ],
          )
        ).rows;
        const moved: typeof memberships = [],
          revoked: string[] = [];
        for (const m of memberships) {
          try {
            await pool.query(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$2 WHERE membership_id=$1',
              [m.membership_id, COMPANY],
            );
            moved.push(m);
          } catch {
            await pool.query(
              'UPDATE platform.current_policy_memberships SET revoked_at=clock_timestamp() WHERE membership_id=$1',
              [m.membership_id],
            );
            revoked.push(m.membership_id);
          }
        }
        try {
          await assert.rejects(
            run((v) => library.prepareCreate(v, form, randomUUID(), crossed())),
            /template.unavailable/u,
          );
          assert.equal(
            (
              await run((v) =>
                library.prepareCreate(v, form, randomUUID(), home()),
              )
            ).assignment?.revision_id,
            history[0]!.revisionId,
          );
        } finally {
          for (const m of moved)
            await pool.query(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$2 WHERE membership_id=$1',
              [m.membership_id, m.legal_entity_id],
            );
          if (revoked.length)
            await pool.query(
              'UPDATE platform.current_policy_memberships SET revoked_at=NULL WHERE membership_id = ANY($1::uuid[])',
              [revoked],
            );
        }
        await run((v) => library.retire(v, published.templateId, 2));
        await assert.rejects(
          run((v) =>
            library.assign(v, target, contextId, 1, published.revisionId),
          ),
          /template.revisionUnavailable/u,
        );
        assert.ok(
          (await run((v) => library.history(v, target))).every(
            (r) => r.retired,
          ),
        );
        await assert.rejects(
          run((v) => library.review(v, target, null, 0, content), 'buyer'),
        );
        assert.equal(
          (await run((v) => library.history(v, target, elsewhere.revisionId)))
            .length,
          0,
        );
        assert.deepEqual((await create(key)).trust, results[0].trust);
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
          /template.unavailable/u,
        );
        // Same principal and the known parent ID: only the stored company
        // differs, so the company check alone refuses the second company's
        // application.
        assert.equal(
          (
            await run(
              (v) => library.application(v, target, header.recordId),
              'buyer',
            )
          )?.assignment?.revision_id,
          published.revisionId,
        );
        await assert.rejects(
          run((v) => library.application(v, other, header.recordId), 'buyer'),
          /template.unavailable/u,
        );
        // Company B's own application, read by the A-only worker: under A it
        // is not found (the stored-company lookup), under B it is refused (the
        // company-scoped read authority). Each check reds alone.
        assert.equal(
          await run(
            (v) => library.application(v, target, secondParent.recordId),
            'buyer',
          ),
          null,
          'a company A lookup finds no application for a company B parent',
        );
        await assert.rejects(
          run(
            (v) => library.application(v, other, secondParent.recordId),
            'buyer',
          ),
          /template.unavailable/u,
        );
        if (kind === 'row') {
          const updated = draftTemplateBinding(
            (await opened.service.targets()).templateBindings!,
            {
              ...choices,
              fields: choices.fields.map((c) =>
                c.fieldId === copies ? { ...c, audienceValues: ['250'] } : c,
              ),
            },
          );
          const stale = heldReview!;
          await activate(updated);
          await assert.rejects(
            run((v) => library.publish(v, stale.reviewId, stale.digest)),
            /template.staleRelease/u,
          );
          assert.deepEqual(
            await run(
              (v) => library.history(v, target, published.revisionId),
              'buyer',
            ),
            [],
          );
        }
        if (selector?.kind === 'link') {
          // A link binding that is not required: a record created without the
          // link stores no context, so its applied retry and its application
          // read must not ask for read authority on the linked type (Fable
          // check, item B). Every grant of the link's get query is revoked.
          await activate(
            draftTemplateBinding(
              (await opened.service.targets()).templateBindings!,
              { ...choices, required: false },
            ),
          );
          const unlinked = { ...header, recordId: randomUUID(), relations: {} };
          const unlinkedKey = randomUUID();
          await prepare(unlinkedKey, unlinked);
          const applied = await create(unlinkedKey, unlinked);
          assert.equal(applied.outcome, 'succeeded', JSON.stringify(applied));
          const releaseId = await run((v) =>
            Promise.resolve(v.release.releaseId),
          );
          const {
            rows: [linkQuery],
          } = await pool.query<{ permission: string }>(
            `SELECT q#>>'{permission,targetId}' AS permission
          FROM platform.tenant_releases r JOIN platform.app_package_revisions d ON (r.tenant_id,r.app_package_revision_id)=(d.tenant_id,d.revision_id)
          CROSS JOIN LATERAL jsonb_array_elements(convert_from(d.desired_state,'UTF8')::jsonb->'queries') q
          WHERE r.release_id=$1 AND q->>'queryId'=$2`,
            [releaseId, selector.getQueryId],
          );
          assert.ok(linkQuery);
          const revoked = await pool.query<{ role_id: string }>(
            'UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND environment_id=$2 AND permission_id=$3 AND revoked_at IS NULL RETURNING role_id',
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              linkQuery.permission,
            ],
          );
          assert.ok(revoked.rowCount, 'revoke the linked type read');
          try {
            const retried = await create(unlinkedKey, unlinked);
            assert.deepEqual(
              retried.trust,
              applied.trust,
              'an unlinked applied retry returns its receipt without the link read',
            );
            assert.ok(
              await run((v) =>
                library.application(v, target, unlinked.recordId),
              ),
              'the unlinked application read needs no link read',
            );
          } finally {
            await pool.query(
              'UPDATE platform.current_policy_permission_grants SET revoked_at=NULL WHERE (tenant_id,environment_id,permission_id)=($1,$2,$3) AND role_id=ANY($4::uuid[])',
              [
                runtime.identity.tenantId,
                runtime.identity.environmentId,
                linkQuery.permission,
                revoked.rows.map((r) => r.role_id),
              ],
            );
          }
        }
        second[index + 1]?.open();
      },
    );
    first[0]!.open();
    await Promise.race([declared.opened, Promise.all(runs)]);
    assert.equal(bindings.length, kinds.length);
    // A validation rule joins the declaring release (Fable finding 1): the
    // release with both must compile and activate, the rule must still refuse
    // a bad write, and phase 2's template creates must still apply under it.
    // Validation needs its own draft, so it activates right after the
    // bindings and before phase 2.
    const price = ns + 'field.item_price_cad';
    const ruleMessage = 'Enter a price of at least $10.';
    const validation = literalValidationDraft(
      (await opened.service.targets()).validationTargets!.find(
        (t) => t.entityId === ns + 'entity.item',
      )!,
      { fieldId: price, check: 'minimum', limit: '10', message: ruleMessage },
    );
    await exercisePrecedingReader({
      ...reader!,
      declare: () => activate({ kind: 'changeSet', patches: bindings }),
    });
    await activate(validation);
    second[0]!.open();
    await Promise.all(runs);
    await assert.rejects(
      world.invoke('item_create', {
        recordId: randomUUID(),
        relations: {},
        values: {
          [ns + 'field.item_name']: 'Below the floor',
          [price]: '1',
          [ns + 'field.item_sku']: 'TPL-RULE',
          [ns + 'field.item_base_unit']: 'EA',
        },
      }),
      { code: 'MODULE_VALIDATION_REFUSED', message: ruleMessage },
    );
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
