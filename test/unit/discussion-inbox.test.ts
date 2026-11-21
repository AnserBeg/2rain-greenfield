import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discussionNoticeReasons,
  reconcileNextDiscussionNotice,
  type DiscussionInboxPort,
  type DiscussionNoticeReader,
  type DiscussionNoticeReason,
  type DiscussionNoticeSource,
} from '../../packages/runtime/src/discussion-inbox.js';

const reference = {
  tenantId: 'tenant',
  environmentId: 'production',
  companyId: 'north',
  threadId: 'purchase-order-thread',
  messageId: 'message',
  channel: 'staffDiscussion/v1',
} as const;
const original: DiscussionNoticeSource = {
  authorId: 'alex',
  mentionedPrincipalIds: ['bee', 'chris'],
  replyTo: { authorId: 'bee', messageId: 'parent' },
};

// COMMS-1 has no inbox on this trunk. This double stores one scoped message's
// notices. Each claim deliberately replays the same original occurrence.
function inbox() {
  let current: DiscussionNoticeSource | null = original;
  let notices = new Map<string, readonly DiscussionNoticeReason[]>();
  const hidden = new Set<string>();
  const phases: string[] = [];
  let failWrite = false;
  const reader: DiscussionNoticeReader = {
    message: reference,
    currentMessage: () => Promise.resolve(current),
    canReadMessage: (principal, messageId) =>
      Promise.resolve(!hidden.has(principal + '/' + messageId)),
  };
  const port: DiscussionInboxPort = {
    claimOne: (channel) => {
      assert.equal(channel, reference.channel);
      phases.push('claim committed');
      return Promise.resolve({ message: reference, leaseToken: 'lease-1' });
    },
    async withLockedMessage(message, work) {
      assert.deepEqual(
        message,
        reference,
        'an unsupported occurrence entered the thread transaction',
      );
      phases.push('thread locked');
      await work({
        ...reader,
        async reconcileRecipients(recipients) {
          if (failWrite) throw new Error('inbox offline');
          notices = new Map(recipients);
          phases.push('inbox written');
        },
      });
      phases.push('thread committed');
    },
    acknowledge(claim) {
      assert.equal(claim.leaseToken, 'lease-1');
      phases.push('lease acknowledged');
      return Promise.resolve();
    },
  };
  return {
    port,
    reader,
    hidden,
    phases,
    notices: () => [...notices],
    setMessage: (value: DiscussionNoticeSource | null) => {
      current = value;
    },
    failWrites: (value: boolean) => {
      failWrite = value;
    },
  };
}

test('a replay reconciles distinct recipients against the current in-app revision', async () => {
  const f = inbox();
  await reconcileNextDiscussionNotice(f.port);
  assert.deepEqual(f.notices(), [
    ['bee', ['mention', 'reply']],
    ['chris', ['mention']],
  ]);
  assert.deepEqual(f.phases, [
    'claim committed',
    'thread locked',
    'inbox written',
    'thread committed',
    'lease acknowledged',
  ]);
  f.setMessage({ ...original, mentionedPrincipalIds: [] });
  assert.deepEqual(
    await discussionNoticeReasons(f.reader, 'chris'),
    [],
    'withdrawal must suppress inbox reads before reconciliation',
  );
  await reconcileNextDiscussionNotice(f.port);
  assert.deepEqual(
    f.notices(),
    [['bee', ['reply']]],
    'replayed occurrence restored a withdrawn mention',
  );
  f.setMessage(null);
  assert.deepEqual(
    await discussionNoticeReasons(f.reader, 'bee'),
    [],
    'a tombstone returned a notice',
  );
  await reconcileNextDiscussionNotice(f.port);
  assert.deepEqual(f.notices(), [], 'tombstone left reasons behind');
});

test('notice reasons require visibility of this message and, for replies, its specific parent', async () => {
  const f = inbox();
  f.hidden.add('bee/message');
  assert.deepEqual(
    await discussionNoticeReasons(f.reader, 'bee'),
    [],
    'a hidden message supplied a notice',
  );
  await reconcileNextDiscussionNotice(f.port);
  assert.deepEqual(
    f.notices(),
    [['chris', ['mention']]],
    'an empty reason set left a countable recipient',
  );
  f.hidden.delete('bee/message');
  f.hidden.add('bee/parent');
  assert.deepEqual(
    await discussionNoticeReasons(f.reader, 'bee'),
    ['mention'],
    'a hidden parent supplied a reply notice',
  );
  f.setMessage({ ...original, mentionedPrincipalIds: ['alex'] });
  assert.deepEqual(
    await discussionNoticeReasons(f.reader, 'alex'),
    [],
    'the sender received a self-mention',
  );
  assert.deepEqual(
    await discussionNoticeReasons(f.reader, 'unmentioned'),
    [],
    'a non-recipient received a notice',
  );
});

test('a failed inbox write leaves the claim retryable and no partial notice', async () => {
  const f = inbox();
  f.failWrites(true);
  await assert.rejects(reconcileNextDiscussionNotice(f.port), /inbox offline/u);
  assert.deepEqual(f.notices(), []);
  assert.deepEqual(f.phases, ['claim committed', 'thread locked']);
  f.failWrites(false);
  await reconcileNextDiscussionNotice(f.port);
  await reconcileNextDiscussionNotice(f.port);
  assert.deepEqual(f.notices(), [
    ['bee', ['mention', 'reply']],
    ['chris', ['mention']],
  ]);
});

test('an email or unknown channel cannot resolve a discussion link or enter the thread transaction', async () => {
  for (const channel of ['email', 'future/v2']) {
    const f = inbox();
    const message = { ...reference, channel };
    const other = { ...f.reader, message };
    assert.deepEqual(
      await discussionNoticeReasons(other, 'chris'),
      [],
      'an unsupported channel resolved a staff notice',
    );
    const claim = { message, leaseToken: 'other-channel' };
    await assert.rejects(
      reconcileNextDiscussionNotice({ ...f.port, claimOne: async () => claim }),
      /Unsupported discussion inbox channel/u,
      'an unsupported occurrence entered the thread transaction',
    );
    assert.deepEqual(f.phases, []);
  }
});

test('an idle inbox worker acquires no thread or inbox lock', async () => {
  const f = inbox();
  await reconcileNextDiscussionNotice({
    ...f.port,
    claimOne: async () => null,
  });
  assert.deepEqual(f.phases, []);
});

test('an edit committed after a worker claims a notice wins at the thread lock', async () => {
  const f = inbox();
  const waiting = Promise.withResolvers<void>();
  const edited = Promise.withResolvers<void>();
  const worker = reconcileNextDiscussionNotice({
    ...f.port,
    async withLockedMessage(message, work) {
      waiting.resolve();
      await edited.promise;
      await f.port.withLockedMessage(message, work);
    },
  });
  await waiting.promise;
  assert.deepEqual(f.phases, ['claim committed']);
  f.setMessage({ ...original, mentionedPrincipalIds: [] });
  edited.resolve();
  await worker;
  assert.deepEqual(
    f.notices(),
    [['bee', ['reply']]],
    'the claim replayed a mention withdrawn before the thread lock',
  );
});
