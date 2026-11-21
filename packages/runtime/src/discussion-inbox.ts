/** ADR-0090 §§1,4. A committed occurrence locates a message. Its payload
 * carries neither recipients nor message text into COMMS-1. */
export const DISCUSSION_INBOX_CHANNEL = 'staffDiscussion/v1';

export interface DiscussionMessageRef {
  readonly channel: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly companyId: string;
  readonly threadId: string;
  readonly messageId: string;
}

export interface DiscussionNoticeSource {
  /** Original author and reply parent survive an edit. */
  readonly authorId: string;
  readonly mentionedPrincipalIds: readonly string[];
  readonly replyTo: {
    readonly messageId: string;
    readonly authorId: string;
  } | null;
}

export type DiscussionNoticeReason = 'mention' | 'reply';

export interface DiscussionNoticeReader {
  readonly message: DiscussionMessageRef;
  /** Current non-tombstoned revision, within this exact company, thread and channel. */
  currentMessage(): Promise<DiscussionNoticeSource | null>;
  /** Governed read including every record link and the specific message's original creation boundary. */
  canReadMessage(principalId: string, messageId: string): Promise<boolean>;
}

interface DiscussionNoticeClaim {
  readonly message: DiscussionMessageRef;
  readonly leaseToken: string;
}

/** COMMS-1 supplies this port. Claim and acknowledgement each complete their
 * own transaction. withLockedMessage takes the shared thread lock before any
 * message or inbox row, then commits after the callback succeeds. */
export interface DiscussionInboxPort {
  claimOne(
    channel: typeof DISCUSSION_INBOX_CHANNEL,
  ): Promise<DiscussionNoticeClaim | null>;
  withLockedMessage(
    message: DiscussionMessageRef,
    work: (
      transaction: DiscussionNoticeReader & {
        /** Replace reasons for the complete scoped message, withdrawing obsolete rows. */
        reconcileRecipients(
          recipients: ReadonlyMap<string, readonly DiscussionNoticeReason[]>,
        ): Promise<void>;
      },
    ) => Promise<void>,
  ): Promise<void>;
  acknowledge(claim: DiscussionNoticeClaim): Promise<void>;
}

/** The inbox also uses this decision before listing, counting, previewing or
 * following a notice. The caller reads the current revision in the same scope
 * and snapshot as canReadMessage. */
export async function discussionNoticeReasons(
  reader: DiscussionNoticeReader,
  principalId: string,
): Promise<DiscussionNoticeReason[]> {
  if (reader.message.channel !== DISCUSSION_INBOX_CHANNEL) return [];
  return reasonsFor(reader, await reader.currentMessage(), principalId);
}

async function reasonsFor(
  reader: DiscussionNoticeReader,
  current: DiscussionNoticeSource | null,
  principalId: string,
): Promise<DiscussionNoticeReason[]> {
  if (!current || principalId === current.authorId) return [];
  const mentioned = current.mentionedPrincipalIds.includes(principalId);
  const parent =
    current.replyTo?.authorId === principalId ? current.replyTo : null;
  if (!(await reader.canReadMessage(principalId, reader.message.messageId)))
    return [];
  const reasons: DiscussionNoticeReason[] = mentioned ? ['mention'] : [];
  if (parent && (await reader.canReadMessage(principalId, parent.messageId)))
    reasons.push('reply');
  return reasons;
}

export async function reconcileNextDiscussionNotice(
  port: DiscussionInboxPort,
): Promise<void> {
  const claim = await port.claimOne(DISCUSSION_INBOX_CHANNEL);
  if (!claim) return;
  if (claim.message.channel !== DISCUSSION_INBOX_CHANNEL)
    throw new Error('Unsupported discussion inbox channel');
  await port.withLockedMessage(claim.message, async (transaction) => {
    const current = await transaction.currentMessage();
    const candidates = new Set(current?.mentionedPrincipalIds);
    if (current?.replyTo) candidates.add(current.replyTo.authorId);
    const recipients = new Map<string, DiscussionNoticeReason[]>();
    for (const principalId of [...candidates].sort()) {
      const reasons = await reasonsFor(transaction, current, principalId);
      if (reasons.length) recipients.set(principalId, reasons);
    }
    await transaction.reconcileRecipients(recipients);
  });
  await port.acknowledge(claim);
}
