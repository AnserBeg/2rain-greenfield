import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';

interface InboxFixture {
  tenant: string;
  environment: string;
  company: string;
  otherCompany: string;
  person: string;
  author: string;
  parentAuthor: string;
  thread: string;
  message: string;
  parent: string;
}

/** Each observation enters as the request or worker role. Restoring the
 * savepoint after each observation makes both executions see identical rows.
 * The outer rollback removes the changed function, including on failure. */
export async function checkInboxGuards(admin: PoolClient, f: InboxFixture) {
  const args = [
    f.tenant,
    f.environment,
    f.company,
    f.otherCompany,
    f.person,
    f.author,
    f.parentAuthor,
    f.thread,
    f.message,
    f.parent,
  ];
  // One SQL parameter list for the cases; unused parameters still have types.
  const params =
    'WITH ids AS (SELECT $1::uuid t,$2::uuid e,$3::uuid c,$4::uuid other,$5::uuid person,$6::uuid author,$7::uuid parent_author,$8::uuid th,$9::uuid msg,$10::uuid parent) ';
  const member = 'north_star_internal.inbox_member(uuid,uuid)';
  const reasons = 'north_star_internal.inbox_reasons(uuid,uuid,uuid,uuid)';
  const rows =
    'north_star_internal.personal_inbox_rows(uuid,text,uuid,uuid,boolean,integer)';
  const read =
    'SELECT platform.discussion_notice_readable(c,th,msg,person) AS value FROM ids';
  const visible = `SELECT EXISTS(SELECT FROM platform.personal_inbox_page(c,'staffDiscussion/v1',NULL) p WHERE p.message_id=msg) AS value FROM ids`;
  const worker = 'north_star_workflow_worker';
  const runtime = 'north_star_runtime';
  interface Control {
    name: string;
    fn: string;
    guard: string;
    removed: string;
    query: string;
    setup?: string;
    role?: typeof worker | typeof runtime;
    normal?: unknown;
    changed?: unknown;
  }
  const cases: Control[] = [
    {
      name: 'active account',
      fn: member,
      guard: "s.status='active'",
      removed: 'true',
      setup:
        "UPDATE platform.staff_accounts SET status='inactive' FROM ids WHERE principal_id=person",
      query: read,
    },
    {
      name: 'current company',
      fn: member,
      guard: 'm.legal_entity_id=c',
      removed: 'true',
      setup:
        'UPDATE platform.current_policy_memberships SET legal_entity_id=other FROM ids WHERE principal_id=person',
      query: read,
    },
    {
      name: 'active membership',
      fn: member,
      guard: 'm.revoked_at IS NULL',
      removed: 'true',
      setup:
        'UPDATE platform.current_policy_memberships SET revoked_at=clock_timestamp() FROM ids WHERE principal_id=person',
      query: read,
    },
    {
      name: 'active role',
      fn: member,
      guard: 'r.revoked_at IS NULL',
      removed: 'true',
      setup:
        'UPDATE platform.current_policy_roles SET revoked_at=clock_timestamp() FROM ids WHERE tenant_id=t AND environment_id=e',
      query: read,
    },
    {
      name: 'message visibility',
      fn: reasons,
      guard: 'OR NOT north_star_internal.inbox_can_read(c,th,msg,person)',
      removed: '',
      setup:
        "UPDATE public.fixture_discussion_messages SET visible_to='{}' FROM ids WHERE message_id=msg",
      query: visible,
      role: runtime,
    },
    {
      name: 'own posts',
      fn: reasons,
      guard: 'OR s.author_id=person',
      removed: '',
      setup:
        'UPDATE public.fixture_discussion_messages SET author_id=person FROM ids WHERE message_id=msg',
      query: visible,
      role: runtime,
    },
    {
      name: 'current mention',
      fn: reasons,
      guard: 'IF person=ANY(s.mentioned_ids)',
      removed: 'IF true',
      setup:
        "UPDATE public.fixture_discussion_messages SET mentions='{}' FROM ids WHERE message_id=msg",
      query: visible,
      role: runtime,
    },
    {
      name: 'parent visibility',
      fn: reasons,
      guard: 'AND north_star_internal.inbox_can_read(c,th,s.parent_id,person)',
      removed: '',
      setup: `UPDATE public.fixture_discussion_messages SET author_id=person,visible_to='{}' FROM ids WHERE message_id=parent`,
      query: `SELECT 'reply'=ANY(p.reasons) AS value FROM ids, LATERAL platform.personal_inbox_page(c,'staffDiscussion/v1',NULL) p WHERE p.message_id=msg`,
      role: runtime,
    },
    {
      name: 'archived entry',
      fn: rows,
      guard: 'AND n.archived_at IS NULL',
      removed: '',
      setup:
        'UPDATE platform.personal_inbox SET archived_at=clock_timestamp() FROM ids WHERE recipient_id=person AND message_id=msg',
      query: visible,
      role: runtime,
    },
    {
      name: 'withdrawn persisted entry',
      fn: rows,
      guard: 'AND cardinality(n.reasons)>0',
      removed: '',
      setup:
        "UPDATE platform.personal_inbox SET reasons='{}' FROM ids WHERE recipient_id=person AND message_id=msg",
      query: visible,
      role: runtime,
    },
    {
      name: 'fixed page size',
      fn: 'platform.personal_inbox_page(uuid,text,uuid)',
      guard: 'NULL,false,25',
      removed: 'NULL,false,26',
      query:
        "SELECT count(*)::integer AS value FROM ids,LATERAL platform.personal_inbox_page(c,'staffDiscussion/v1',NULL)",
      role: runtime,
      normal: 25,
      changed: 26,
    },
    {
      name: 'capped unread',
      fn: 'platform.personal_inbox_unread(uuid,text)',
      guard: 'NULL,true,100',
      removed: 'NULL,true,101',
      query:
        "SELECT platform.personal_inbox_unread(c,'staffDiscussion/v1') AS value FROM ids",
      role: runtime,
      normal: 100,
      changed: 101,
    },
    {
      name: 'stored recipient decisions',
      fn: 'platform.reconcile_discussion_notice(uuid,uuid,uuid,jsonb)',
      guard: 'IF decision IS DISTINCT FROM expected',
      removed: 'IF false',
      query:
        "SELECT platform.reconcile_discussion_notice(c,th,msg,'{}') IS NOT NULL AS value FROM ids",
      normal: 'inbox.recipientsChanged',
      changed: true,
    },
    {
      name: 'bound before resolving the message',
      fn: 'north_star_internal.inbox_source(uuid,uuid,uuid)',
      guard: 'person)>10',
      removed: 'person)>11',
      setup:
        'UPDATE public.fixture_discussion_messages SET mentions=ARRAY(SELECT gen_random_uuid() FROM generate_series(1,11)) FROM ids WHERE message_id=msg',
      query:
        'SELECT (platform.discussion_notice_source(c,th,msg)).author_id IS NOT NULL AS value FROM ids',
      normal: 'inbox.recipientLimit',
      changed: true,
    },
  ];
  for (const control of cases) {
    await admin.query('BEGIN');
    try {
      await admin.query(
        params +
          `SELECT set_config('north_star.tenant_id',t::text,true),
        set_config('north_star.environment_id',e::text,true),set_config('north_star.principal_id',person::text,true) FROM ids`,
        args,
      );
      await admin.query(
        params +
          `UPDATE public.fixture_discussion_messages SET mentions=ARRAY[person],visible_to=ARRAY[person,parent_author] FROM ids WHERE message_id=msg`,
        args,
      );
      await admin.query(
        params +
          `UPDATE platform.personal_inbox SET reasons=ARRAY['mention'],archived_at=NULL,read_at=NULL FROM ids WHERE recipient_id=person AND message_id=msg`,
        args,
      );
      // Keep the single message inside the fixed page even with the cap fixture.
      if (control.query.includes('p.message_id=msg'))
        await admin.query(
          params +
            'UPDATE platform.personal_inbox SET archived_at=clock_timestamp() FROM ids WHERE recipient_id=person AND message_id<>msg',
          args,
        );
      if (control.setup) await admin.query(params + control.setup, args);
      const observe = async () => {
        await admin.query('SAVEPOINT observation');
        try {
          await admin.query(
            control.role === runtime
              ? 'SET LOCAL ROLE north_star_runtime'
              : 'SET LOCAL ROLE north_star_workflow_worker',
          );
          return (
            await admin.query<{ value: unknown }>(params + control.query, args)
          ).rows[0]?.value;
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'P0001'
          )
            return error.message;
          throw error;
        } finally {
          await admin.query('ROLLBACK TO observation');
        }
      };
      assert.deepEqual(
        await observe(),
        control.normal ?? false,
        control.name + ' allowed the unmodified request',
      );
      const {
        rows: [definition],
      } = await admin.query<{ body: string }>(
        'SELECT pg_get_functiondef($1::regprocedure) AS body',
        [control.fn],
      );
      const parts = definition!.body.split(control.guard);
      assert.equal(
        parts.length,
        2,
        'expected one guard in ' + control.fn + ' for ' + control.name,
      );
      // Both SQL fragments and the function identity are fixed test data. Only
      // this test database's migration owner can replace the function.
      await admin.query(parts.join(control.removed));
      assert.deepEqual(
        await observe(),
        control.changed ?? true,
        control.name + ' survived removal',
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  }
}
