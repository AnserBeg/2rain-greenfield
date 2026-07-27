import assert from 'node:assert/strict';
import test from 'node:test';

import { SharedListContractError } from '../../packages/runtime/src/list-behavior/index.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';

const parentIds = Array.from(
  { length: 6 },
  (_, index) => `a1000000-0000-4000-8000-00000000000${String(index + 1)}`,
);
const roleIds = Array.from(
  { length: 6 },
  (_, index) => `b1000000-0000-4000-8000-00000000000${String(index + 1)}`,
);

test('shared list SQL searches authorized display values before stable covered paging', async () => {
  await withRealPartyRuntime('g2-p5a-list-behavior', async (runtime) => {
    for (const [index, parentId] of parentIds.entries()) {
      await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: parentId,
        values: {
          [PARTY_IDS.fieldIds.contactSummary]:
            `not-visible-${String(index + 1)}`,
          [PARTY_IDS.fieldIds.name]:
            index === 4 ? 'Page Three Needle' : `Relation ${String(index + 1)}`,
          [PARTY_IDS.fieldIds.number]: `P-LIST-${String(index + 1)}`,
        },
      });
      await invokePartyOperation(
        runtime,
        runtime.views.a,
        'party_role_create',
        {
          recordId: roleIds[index]!,
          relations: { [PARTY_IDS.relationIds.roleParty]: parentId },
          values: {
            [PARTY_IDS.fieldIds.roleKind]:
              `${PARTY_IDS.namespace}:option.customer`,
            [PARTY_IDS.fieldIds.roleStatus]:
              `${PARTY_IDS.namespace}:option.active`,
          },
        },
      );
    }

    const pageOne = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ pageSize: 2 }),
    );
    assert.deepEqual(
      pageOne.records.map((record) => record.recordId),
      roleIds.slice(0, 2),
    );
    assert.equal(pageOne.listCoverage?.totalCount, 6);
    assert.equal(pageOne.listCoverage?.returnedCount, 2);
    assert.equal(pageOne.listCoverage?.hasMore, true);
    assert.equal(pageOne.listCoverage?.projectedSearchValueCount, 0);
    assert.ok(pageOne.listCoverage?.nextCursor);
    assert.equal(
      pageOne.records.some(
        (record) =>
          record.relationLabels?.[PARTY_IDS.relationIds.roleParty]?.label ===
          'Page Three Needle',
      ),
      false,
      'the naive filter-after-page implementation has no match on page one',
    );

    const pageTwo = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({
        cursor: pageOne.listCoverage!.nextCursor,
        pageSize: 2,
      }),
    );
    const pageThree = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({
        cursor: pageTwo.listCoverage!.nextCursor,
        pageSize: 2,
      }),
    );
    const pagedIds = [
      ...pageOne.records,
      ...pageTwo.records,
      ...pageThree.records,
    ].map((record) => record.recordId);
    assert.deepEqual(pagedIds, roleIds);
    assert.equal(new Set(pagedIds).size, roleIds.length);
    assert.equal(pageThree.listCoverage?.hasMore, false);
    assert.equal(pageThree.listCoverage?.nextCursor, null);

    const relationSearch = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ pageSize: 2, search: 'Page Three Needle' }),
    );
    assert.deepEqual(
      relationSearch.records.map((record) => record.recordId),
      [roleIds[4]],
    );
    assert.equal(relationSearch.listCoverage?.pageOffset, 0);
    assert.equal(relationSearch.listCoverage?.totalCount, 1);
    assert.equal(relationSearch.listCoverage?.projectedSearchValueCount, 3);
    assert.equal(
      relationSearch.records[0]?.relationLabels?.[
        PARTY_IDS.relationIds.roleParty
      ]?.label,
      'Page Three Needle',
    );

    const formattedSearch = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ pageSize: 2, search: 'Customer' }),
    );
    assert.equal(formattedSearch.listCoverage?.totalCount, 6);
    assert.equal(
      formattedSearch.records[0]?.displayValues?.[PARTY_IDS.fieldIds.roleKind],
      'Customer',
    );

    const visibleUnindexedSearch = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_list',
      listArguments({
        includeRelationLabel: false,
        pageSize: 2,
        search: 'not-visible-3',
        sortFieldId: PARTY_IDS.fieldIds.name,
      }),
    );
    assert.deepEqual(
      visibleUnindexedSearch.records.map((record) => record.recordId),
      [parentIds[2]],
    );
    const unrequestedTargetField = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ pageSize: 2, search: 'not-visible-3' }),
    );
    assert.equal(unrequestedTargetField.listCoverage?.totalCount, 0);
    assert.deepEqual(unrequestedTargetField.records, []);

    await invokePartyOperation(runtime, runtime.views.a, 'party_role_archive', {
      expectedRevision: 1,
      recordId: roleIds[0],
    });
    const activeOnly = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ pageSize: 100 }),
    );
    assert.equal(activeOnly.listCoverage?.totalCount, 5);
    assert.equal(
      activeOnly.records.some((record) => record.recordId === roleIds[0]),
      false,
    );
    const withArchived = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ includeArchived: true, pageSize: 100 }),
    );
    assert.equal(withArchived.listCoverage?.totalCount, 6);
    assert.equal(
      withArchived.records.find((record) => record.recordId === roleIds[0])
        ?.archived,
      true,
    );

    const clamped = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      listArguments({ includeArchived: true, pageSize: 500 }),
    );
    assert.equal(clamped.listCoverage?.requestedPageSize, 500);
    assert.equal(clamped.listCoverage?.effectivePageSize, 100);
    assert.equal(clamped.listCoverage?.truncatedByMaximum, true);

    await assert.rejects(
      invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_role_list',
        listArguments({
          cursor: pageOne.listCoverage!.nextCursor,
          pageSize: 2,
          search: 'changed binding',
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof SharedListContractError);
        assert.equal(error.code, 'LIST_CURSOR_INVALID');
        return true;
      },
    );

    await assert.rejects(
      invokePartyQuery(runtime, runtime.views.a, 'party_role_list', {
        ...listArguments({
          pageSize: 2,
          sortFieldId: PARTY_IDS.fieldIds.name,
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof SharedListContractError);
        assert.equal(error.code, 'LIST_FIELD_NOT_AUTHORIZED');
        assert.equal(error.subjectId, PARTY_IDS.fieldIds.name);
        return true;
      },
    );
  });
});

function listArguments(input: {
  cursor?: string | null;
  includeArchived?: boolean;
  includeRelationLabel?: boolean;
  pageSize: number;
  search?: string;
  sortFieldId?: string;
}): Record<string, unknown> {
  return {
    includeArchived: input.includeArchived ?? false,
    list: {
      cursor: input.cursor ?? null,
      matchMode: 'substring',
      pageSize: input.pageSize,
      relationLabels:
        input.includeRelationLabel === false
          ? []
          : [
              {
                fieldId: PARTY_IDS.fieldIds.name,
                queryId: `${PARTY_IDS.namespace}:query.party_list`,
                relationId: PARTY_IDS.relationIds.roleParty,
              },
            ],
      schemaVersion: 'northstar.shared-list-query/v1',
      search: input.search ?? '',
      sort: [
        {
          direction: 'ascending',
          fieldId: input.sortFieldId ?? PARTY_IDS.fieldIds.roleKind,
        },
      ],
    },
  };
}
