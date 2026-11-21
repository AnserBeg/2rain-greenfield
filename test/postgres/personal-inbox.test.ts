import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import {
  DISCUSSION_INBOX_CHANNEL,
  reconcileNextDiscussionNotice,
} from '../../packages/runtime/src/discussion-inbox.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  discussionInboxPort,
  PostgresPersonalInbox,
} from '../../packages/postgres-provider/src/personal-inbox.js';
import { checkInboxGuards } from '../helpers/personal-inbox-controls.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

test('personal inbox on committed discussion occurrences', async (t) => {
  await withEphemeralPostgres(
    'personal-inbox',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      const runtime = new pg.Pool({
        ...connection,
        user: 'north_star_runtime',
      });
      const worker = new pg.Pool({
        ...connection,
        user: 'north_star_workflow_worker',
      });
      const tId = randomUUID(),
        env = randomUUID(),
        west = randomUUID(),
        east = randomUUID();
      const author = randomUUID(),
        parentAuthor = randomUUID(),
        mentioned = randomUUID(),
        role = randomUUID();
      const thread = randomUUID(),
        message = randomUUID(),
        parent = randomUUID();
      const args = [tId, env, west, thread, message];
      const scope = { tenant_id: tId, environment_id: env };
      const port = discussionInboxPort(worker, scope);
      const inbox = new PostgresPersonalInbox(runtime);
      const person = (principalId: string) =>
        new AuthenticatedRequestEntryAdapter(async () => ({
          tenantId: tId,
          environmentId: env,
          principalId,
        })).enter({});
      const reader = await person(mentioned),
        parentReader = await person(parentAuthor);
      const poll = () => reconcileNextDiscussionNotice(port);
      const publish = async (event: string, msg = message) => {
        await admin.query('BEGIN');
        try {
          await admin.query(
            'SET LOCAL ROLE north_star_communication_operation',
          );
          await admin.query(
            "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true)",
            [tId, env],
          );
          await admin.query(
            'SELECT platform.enqueue_discussion_notice($1,$2,$3,$4)',
            [west, thread, msg, event],
          );
          await admin.query('COMMIT');
        } catch (error) {
          await admin.query('ROLLBACK');
          throw error;
        }
      };
      try {
        await runMigrations(admin, await loadMigrations('db/migrations'));
        await admin.query(
          "INSERT INTO platform.tenants(id,slug) VALUES($1,'inbox')",
          [tId],
        );
        await admin.query(
          "INSERT INTO platform.environments(tenant_id,id,slug) VALUES($1,$2,'demo')",
          [tId, env],
        );
        await admin.query(
          "INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,'dispatch')",
          [tId, env, role],
        );
        for (const staff of [author, parentAuthor, mentioned]) {
          await admin.query(
            `INSERT INTO platform.staff_accounts(tenant_id,environment_id,principal_id,user_handle,display_name,recovery_contact,status)
          VALUES ($1,$2,$3::uuid,sha256(convert_to($3::uuid::text,'UTF8')),'Staff','local','active')`,
            [tId, env, staff],
          );
          await admin.query(
            `INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,role_id,principal_id,membership_id,legal_entity_id)
          VALUES($1,$2,$3,$4,gen_random_uuid(),$5)`,
            [tId, env, role, staff, west],
          );
        }
        await admin.query(
          `INSERT INTO platform.communication_threads(tenant_id,environment_id,company_id,thread_id,audience,primary_entity,primary_record,linked_records)
        VALUES($1,$2,$3,$4,'record','example.case:entity.case',gen_random_uuid(),'{}')`,
          args.slice(0, 4),
        );
        const event = randomUUID();
        await publish(event);
        await t.test(
          'an uninstalled channel leaves a retryable occurrence',
          async () => {
            await assert.rejects(poll(), /inbox.channelUnavailable/);
            assert.deepEqual(await inbox.page(reader, west), []);
            assert.equal(
              (
                await admin.query(
                  'SELECT reconciled_at FROM platform.discussion_notice_occurrences',
                )
              ).rows[0]!.reconciled_at,
              null,
            );
          },
        );
        await admin.query(
          await readFile('test/fixtures/discussion-inbox-channel.sql', 'utf8'),
        );
        await admin.query(
          `INSERT INTO public.fixture_discussion_messages(tenant_id,environment_id,company_id,thread_id,message_id,author_id,mentions,parent_id,visible_to)
      VALUES($1,$2,$3,$4,$5,$6,ARRAY[$7,$8,$6]::uuid[],$9,ARRAY[$6,$7,$8]::uuid[]),
        ($1,$2,$3,$4,$9,$7,'{}',NULL,ARRAY[$6,$7]::uuid[])`,
          [...args, author, parentAuthor, mentioned, parent],
        );
        const expire = () =>
          admin.query(
            "UPDATE platform.discussion_notice_occurrences SET available_at=clock_timestamp()-interval '1 second' WHERE reconciled_at IS NULL",
          );
        await expire();
        await t.test(
          'the worker commits one notice per recipient and a replay preserves read receipts',
          async () => {
            const claim = await port.claimOne(DISCUSSION_INBOX_CHANNEL);
            assert.ok(claim);
            await reconcileNextDiscussionNotice({
              ...port,
              claimOne: async () => claim,
              acknowledge: async () => {},
            });
            const [notice] = await inbox.page(reader, west);
            assert.deepEqual(notice?.reasons, ['mention']);
            assert.equal(
              notice?.preview,
              'You were mentioned in a discussion.',
            );
            assert.deepEqual(notice?.link, {
              tenantId: tId,
              environmentId: env,
              companyId: west,
              threadId: thread,
              messageId: message,
              channel: DISCUSSION_INBOX_CHANNEL,
            });
            assert.equal(
              (await inbox.page(parentReader, west))[0]?.preview,
              'You were mentioned in a reply to your message.',
            );
            assert.deepEqual(
              (await inbox.page(parentReader, west))[0]?.reasons,
              ['mention', 'reply'],
            );
            assert.deepEqual(await inbox.page(await person(author), west), []);
            assert.equal(await inbox.unread(reader, west), '1');
            assert.equal(
              await inbox.mark(reader, west, notice!.id, 'read'),
              true,
            );
            await expire();
            const replacement = await port.claimOne(DISCUSSION_INBOX_CHANNEL);
            assert.ok(replacement);
            await port.acknowledge(claim);
            assert.equal(
              (
                await admin.query(
                  'SELECT lease_token FROM platform.discussion_notice_occurrences',
                )
              ).rows[0]!.lease_token,
              replacement.leaseToken,
            );
            await reconcileNextDiscussionNotice({
              ...port,
              claimOne: async () => replacement,
            });
            await publish(event);
            assert.equal(
              (
                await admin.query(
                  'SELECT count(*)::int AS n FROM platform.personal_inbox',
                )
              ).rows[0]!.n,
              2,
            );
            assert.equal(await inbox.unread(reader, west), '0');
            assert.equal(
              (await inbox.entry(reader, west, notice!.id))?.unread,
              false,
            );
            await assert.rejects(
              publish(event, parent),
              /inbox.occurrenceConflict/,
            );
          },
        );
        await t.test(
          'recipient, channel and current company independently scope every link',
          async () => {
            const [entry] = await inbox.page(reader, west);
            assert.equal(
              await inbox.entry(parentReader, west, entry!.id),
              null,
            );
            assert.equal(
              await inbox.mark(parentReader, west, entry!.id, 'archive'),
              false,
            );
            assert.deepEqual(await inbox.page(reader, east), []);
            // Move just this recipient's membership. The ID, message access and recipient all still match.
            await admin.query(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$1 WHERE principal_id=$2',
              [east, mentioned],
            );
            assert.equal(await inbox.entry(reader, west, entry!.id), null);
            assert.equal(
              await inbox.mark(reader, west, entry!.id, 'archive'),
              false,
            );
            await admin.query(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$1 WHERE principal_id=$2',
              [west, mentioned],
            );
            await admin.query(
              "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false)",
              [tId, env, mentioned],
            );
            for (const channel of ['email/v1', 'unknown']) {
              assert.equal(
                (
                  await admin.query(
                    'SELECT * FROM platform.personal_inbox_page($1,$2,NULL)',
                    [west, channel],
                  )
                ).rowCount,
                0,
              );
              assert.equal(
                (
                  await admin.query(
                    'SELECT * FROM platform.personal_inbox_entry($1,$2,$3)',
                    [west, channel, entry!.id],
                  )
                ).rowCount,
                0,
              );
            }
          },
        );
        await t.test(
          'withdrawn mention is invisible before reconciliation and stays withdrawn on delayed replay',
          async () => {
            const [entry] = await inbox.page(reader, west);
            await publish(randomUUID());
            const claim = await port.claimOne(DISCUSSION_INBOX_CHANNEL);
            assert.ok(claim);
            await admin.query(
              "UPDATE public.fixture_discussion_messages SET mentions='{}' WHERE message_id=$1",
              [message],
            );
            assert.deepEqual(await inbox.page(reader, west), []);
            assert.equal(await inbox.entry(reader, west, entry!.id), null);
            assert.equal(await inbox.unread(parentReader, west), '1');
            await reconcileNextDiscussionNotice({
              ...port,
              claimOne: async () => claim,
            });
            assert.deepEqual(
              (
                await admin.query(
                  'SELECT reasons FROM platform.personal_inbox WHERE recipient_id=$1',
                  [mentioned],
                )
              ).rows,
              [{ reasons: [] }],
            );
            assert.deepEqual(
              (await inbox.page(parentReader, west))[0]?.reasons,
              ['reply'],
            );
            await admin.query(
              "UPDATE public.fixture_discussion_messages SET visible_to='{}' WHERE message_id=$1",
              [parent],
            );
            assert.equal(await inbox.unread(parentReader, west), '0');
            await admin.query(
              'UPDATE public.fixture_discussion_messages SET visible_to=ARRAY[$1::uuid] WHERE message_id=$2',
              [parentAuthor, parent],
            );
            await admin.query(
              "UPDATE public.fixture_discussion_messages SET visible_to='{}' WHERE message_id=$1",
              [message],
            );
            assert.deepEqual(await inbox.page(parentReader, west), []);
            await admin.query(
              'UPDATE public.fixture_discussion_messages SET visible_to=ARRAY[$1::uuid] WHERE message_id=$2',
              [parentAuthor, message],
            );
            const [reply] = await inbox.page(parentReader, west);
            assert.equal(
              await inbox.mark(parentReader, west, reply!.id, 'archive'),
              true,
            );
            await publish(randomUUID());
            await poll();
            assert.deepEqual(await inbox.page(parentReader, west), []);
          },
        );
        await t.test(
          'pages order visible rows by keyset and report at most 99+ unread',
          async () => {
            await admin.query(
              `WITH added AS (INSERT INTO public.fixture_discussion_messages
            (tenant_id,environment_id,company_id,thread_id,message_id,author_id,mentions,visible_to)
            SELECT $1,$2,$3,$4,gen_random_uuid(),$5,ARRAY[$6::uuid],ARRAY[$6::uuid] FROM generate_series(1,103)
            RETURNING *) INSERT INTO platform.personal_inbox(tenant_id,environment_id,company_id,channel,thread_id,message_id,recipient_id,reasons)
            SELECT tenant_id,environment_id,company_id,'staffDiscussion/v1',thread_id,message_id,$6,ARRAY['mention'] FROM added`,
              [tId, env, west, thread, author, mentioned],
            );
            assert.equal(
              await inbox.unread(reader, west),
              '99+',
              'unread display exceeded its cap',
            );
            assert.equal(
              (
                await admin.query(
                  'SELECT platform.personal_inbox_unread($1,$2) AS n',
                  [west, DISCUSSION_INBOX_CHANNEL],
                )
              ).rows[0]!.n,
              100,
              'SQL unread exceeded its cap',
            );
            const first = await inbox.page(reader, west);
            assert.equal(first.length, 25, 'SQL page exceeded its fixed size');
            const second = await inbox.page(reader, west, first.at(-1)!.id);
            assert.equal(second.length, 25);
            const ordered = await admin.query<{ entry_id: string }>(
              `SELECT entry_id FROM platform.personal_inbox WHERE recipient_id=$1
              AND cardinality(reasons)>0 AND archived_at IS NULL ORDER BY entry_number DESC LIMIT 50`,
              [mentioned],
            );
            assert.deepEqual(
              [...first, ...second].map((row) => row.id),
              ordered.rows.map((row) => row.entry_id),
              'keyset repeated or reordered entries',
            );
            const other = await admin.query<{ entry_id: string }>(
              'SELECT entry_id FROM platform.personal_inbox WHERE recipient_id=$1',
              [parentAuthor],
            );
            assert.deepEqual(
              await inbox.page(reader, west, other.rows[0]!.entry_id),
              [],
              'a copied cursor positioned a different inbox',
            );
            const cursor = first.at(-1)!;
            await admin.query(
              "UPDATE public.fixture_discussion_messages SET mentions='{}' WHERE message_id=$1",
              [cursor.link.messageId],
            );
            assert.deepEqual(
              await inbox.page(reader, west, cursor.id),
              [],
              'a withdrawn notice positioned the inbox',
            );
            assert.equal(
              (
                await admin.query(
                  'SELECT * FROM platform.personal_inbox_entry($1,$2,NULL)',
                  [west, DISCUSSION_INBOX_CHANNEL],
                )
              ).rowCount,
              0,
              'an absent ID resolved a different entry',
            );
            await admin.query(
              "UPDATE platform.staff_accounts SET status='inactive' WHERE principal_id=$1",
              [mentioned],
            );
            assert.equal(
              await inbox.unread(reader, west),
              '0',
              'inactive staff retained their unread count',
            );
            await admin.query(
              "UPDATE platform.staff_accounts SET status='active' WHERE principal_id=$1",
              [mentioned],
            );
          },
        );
        await t.test(
          'the worker holds the shared row before inbox writes and refuses changed recipients',
          async () => {
            const ref = {
              tenantId: tId,
              environmentId: env,
              companyId: west,
              threadId: thread,
              messageId: message,
              channel: DISCUSSION_INBOX_CHANNEL,
            };
            await port.withLockedMessage(ref, async (tx) => {
              await assert.rejects(
                admin.query(
                  'SELECT FROM platform.communication_threads WHERE thread_id=$1 FOR UPDATE NOWAIT',
                  [thread],
                ),
                { code: '55P03' },
                'message reconciliation had no shared thread lock',
              );
              assert.deepEqual(
                (await tx.currentMessage())?.mentionedPrincipalIds,
                [],
              );
            });
            await assert.rejects(
              port.withLockedMessage(ref, (tx) =>
                tx.reconcileRecipients(new Map([[mentioned, ['mention']]])),
              ),
              /inbox.recipientsChanged/,
              'writer accepted recipients missing from the current source',
            );
            await assert.rejects(
              port.withLockedMessage(
                { ...ref, environmentId: randomUUID() },
                async () => {},
              ),
              /scope changed/,
              'worker admitted another environment',
            );
            // Test the database writer directly: the host checks the same boundary before reaching it.
            await admin.query(
              'UPDATE public.fixture_discussion_messages SET mentions=ARRAY(SELECT gen_random_uuid() FROM generate_series(1,12)) WHERE message_id=$1',
              [message],
            );
            await assert.rejects(
              port.withLockedMessage(ref, (tx) =>
                tx.reconcileRecipients(new Map()),
              ),
              /inbox.recipientLimit/,
              'oversize fan-out was silently truncated',
            );
            await admin.query(
              "UPDATE public.fixture_discussion_messages SET mentions='{}' WHERE message_id=$1",
              [message],
            );
            await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            try {
              await assert.rejects(
                admin.query(
                  "SELECT platform.personal_inbox_mark($1,$2,gen_random_uuid(),'archive')",
                  [west, DISCUSSION_INBOX_CHANNEL],
                ),
                /inbox.requiresReadCommitted/,
                'archive accepted a stale snapshot',
              );
            } finally {
              await admin.query('ROLLBACK');
            }
            await assert.rejects(
              admin.query(
                "SELECT platform.personal_inbox_mark($1,$2,gen_random_uuid(),'reset')",
                [west, DISCUSSION_INBOX_CHANNEL],
              ),
              /inbox.invalidAction/,
            );
          },
        );
        await t.test(
          'runtime cannot publish or inspect either private relation',
          async () => {
            for (const query of [
              'SELECT * FROM platform.personal_inbox',
              'SELECT * FROM platform.discussion_notice_occurrences',
              'SELECT platform.claim_discussion_notice()',
              'SELECT platform.enqueue_discussion_notice(NULL,NULL,NULL,NULL)',
              "SELECT platform.reconcile_discussion_notice(NULL,NULL,NULL,'{}')",
            ])
              await assert.rejects(runtime.query(query), { code: '42501' });
          },
        );
        await t.test(
          'each live inbox visibility and fan-out guard changes its own database decision',
          () =>
            checkInboxGuards(admin, {
              tenant: tId,
              environment: env,
              company: west,
              otherCompany: east,
              person: mentioned,
              author,
              parentAuthor,
              thread,
              message,
              parent,
            }),
        );
      } finally {
        admin.release();
        await runtime.end();
        await worker.end();
      }
    },
  );
});
