import type { Pool } from 'pg';
import type { TrustedRequestContext } from '@north-star/runtime';
import { withTrustedRequestTransaction } from './request-context.js';
import {
  DISCUSSION_INBOX_CHANNEL,
  type DiscussionInboxPort,
  type DiscussionMessageRef,
  type DiscussionNoticeReason,
} from '../../runtime/src/discussion-inbox.js';
import {
  withWorkflowTransaction,
  type WorkflowScope,
} from './workflow-consumer.js';

/** The scheduler supplies the environment. A committed claim supplies the
 * company and message. None of the three phases shares a connection lease. */
export function discussionInboxPort(
  pool: Pool,
  scope: WorkflowScope,
): DiscussionInboxPort {
  const locators = (m: DiscussionMessageRef) => {
    if (
      m.channel !== DISCUSSION_INBOX_CHANNEL ||
      m.tenantId !== scope.tenant_id ||
      m.environmentId !== scope.environment_id
    )
      throw new Error('Inbox message scope changed');
    return [m.companyId, m.threadId, m.messageId];
  };
  return {
    async claimOne(channel) {
      if (channel !== DISCUSSION_INBOX_CHANNEL)
        throw new Error('Unsupported inbox channel');
      const {
        rows: [claim],
      } = await withWorkflowTransaction(pool, scope, (client) =>
        client.query<{
          company_id: string;
          thread_id: string;
          message_id: string;
          lease_token: string;
        }>('SELECT * FROM platform.claim_discussion_notice()'),
      );
      return claim
        ? {
            leaseToken: claim.lease_token,
            message: {
              channel,
              tenantId: scope.tenant_id,
              environmentId: scope.environment_id,
              companyId: claim.company_id,
              threadId: claim.thread_id,
              messageId: claim.message_id,
            },
          }
        : null;
    },
    async withLockedMessage(message, work) {
      const ids = locators(message);
      await withWorkflowTransaction(pool, scope, async (client) => {
        await client.query(
          'SELECT platform.lock_discussion_notice($1,$2,$3)',
          ids,
        );
        await work({
          message,
          async currentMessage() {
            const {
              rows: [source],
            } = await client.query<{
              author_id: string | null;
              mentioned_ids: string[];
              parent_id: string | null;
              parent_author_id: string | null;
            }>(
              'SELECT * FROM platform.discussion_notice_source($1,$2,$3)',
              ids,
            );
            if (!source?.author_id) return null;
            return {
              authorId: source.author_id,
              mentionedPrincipalIds: source.mentioned_ids,
              replyTo:
                source.parent_id && source.parent_author_id
                  ? {
                      messageId: source.parent_id,
                      authorId: source.parent_author_id,
                    }
                  : null,
            };
          },
          async canReadMessage(person, id) {
            const {
              rows: [result],
            } = await client.query<{ allowed: boolean }>(
              'SELECT platform.discussion_notice_readable($1,$2,$3,$4) AS allowed',
              [message.companyId, message.threadId, id, person],
            );
            return result!.allowed;
          },
          async reconcileRecipients(recipients) {
            await client.query(
              'SELECT platform.reconcile_discussion_notice($1,$2,$3,$4)',
              [...ids, JSON.stringify(Object.fromEntries(recipients))],
            );
          },
        });
      });
    },
    async acknowledge({ message, leaseToken }) {
      const ids = locators(message);
      await withWorkflowTransaction(pool, scope, (client) =>
        client.query(
          'SELECT platform.acknowledge_discussion_notice($1,$2,$3,$4)',
          [...ids, leaseToken],
        ),
      );
    },
  };
}

export interface PersonalInboxEntry {
  entry_id: string;
  thread_id: string;
  message_id: string;
  reasons: DiscussionNoticeReason[];
  unread: boolean;
}

/** Read and receipt operations always enter with the authenticated person.
 * A link returns its current scoped locator only after checking its reasons. */
export class PostgresPersonalInbox {
  constructor(private readonly pool: Pool) {}

  page(
    person: TrustedRequestContext,
    companyId: string,
    before: string | null = null,
  ) {
    return withTrustedRequestTransaction(
      this.pool,
      person,
      async (client) =>
        (
          await client.query<PersonalInboxEntry>(
            'SELECT * FROM platform.personal_inbox_page($1,$2,$3)',
            [companyId, DISCUSSION_INBOX_CHANNEL, before],
          )
        ).rows,
    );
  }

  entry(person: TrustedRequestContext, companyId: string, entryId: string) {
    return withTrustedRequestTransaction(
      this.pool,
      person,
      async (client) =>
        (
          await client.query<PersonalInboxEntry>(
            'SELECT * FROM platform.personal_inbox_entry($1,$2,$3)',
            [companyId, DISCUSSION_INBOX_CHANNEL, entryId],
          )
        ).rows[0] ?? null,
    );
  }

  unread(person: TrustedRequestContext, companyId: string) {
    return withTrustedRequestTransaction(this.pool, person, async (client) => {
      const {
        rows: [count],
      } = await client.query<{ count: number }>(
        'SELECT platform.personal_inbox_unread($1,$2) AS count',
        [companyId, DISCUSSION_INBOX_CHANNEL],
      );
      return count!.count >= 100 ? '99+' : String(count!.count);
    });
  }

  mark(
    person: TrustedRequestContext,
    companyId: string,
    entryId: string,
    action: 'read' | 'archive',
  ) {
    return withTrustedRequestTransaction(
      this.pool,
      person,
      async (client) =>
        (
          await client.query<{ changed: boolean }>(
            'SELECT platform.personal_inbox_mark($1,$2,$3,$4) AS changed',
            [companyId, DISCUSSION_INBOX_CHANNEL, entryId, action],
          )
        ).rows[0]!.changed,
    );
  }
}
