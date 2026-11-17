import { AsyncLocalStorage } from 'node:async_hooks';

import { assertTrustedRequestContext } from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import type { TrustedRequestContext } from '@north-star/runtime';

export class UnsafeDatabaseRoleError extends Error {
  override readonly name = 'UnsafeDatabaseRoleError';
}

/**
 * The live policy epoch moved while a page's read snapshot was held: the page
 * was assembled under a policy that is no longer current, so it is discarded
 * (assembled once more, then refused) rather than sent.
 */
export class ReadSnapshotPolicyChangedError extends Error {
  readonly code = 'READ_SNAPSHOT_POLICY_CHANGED' as const;
  override readonly name = 'ReadSnapshotPolicyChangedError';
}

/** A read snapshot was misused: a transaction of its own inside a joined read. */
export class ReadSnapshotIntegrityError extends Error {
  readonly code = 'READ_SNAPSHOT_INTEGRITY' as const;
  override readonly name = 'ReadSnapshotIntegrityError';
}

export async function withTrustedRequestTransaction<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertTrustedRequestContext(context);
  // A transaction of its own never runs beside a held read snapshot on the
  // same pool: the snapshot is ended first, so one request never holds two
  // connections and a full pool cannot deadlock.
  await currentReadSnapshot(pool)?.suspend();
  return runTrustedTransaction(pool, context, run);
}

async function runTrustedTransaction<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let hasPrimaryError = false;
  let primaryError: unknown;
  let result: T | undefined;
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await assertRuntimeLoginRole(client);
    await setTrustedIdentity(client, context);
    result = await run(client);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        primaryError = new AggregateError(
          [error, rollbackError],
          'request transaction and rollback both failed',
        );
      }
    }
  }

  const cleanupError = await releaseConnection(client);
  if (hasPrimaryError) {
    if (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'request transaction and connection cleanup both failed',
      );
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return result as T;
}

/**
 * A read that joins the request's read snapshot when one is held for `pool`;
 * otherwise an ordinary trusted transaction of its own. Only reads use this
 * entry point, and the snapshot is `READ ONLY`, so a write sent through it
 * fails at the database. `snapshot` is the open snapshot's handle (its policy
 * epoch and a memo that lives as long as it), null outside a snapshot; the
 * snapshot sees (null outside a snapshot).
 */
export async function withTrustedRequestRead<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient, snapshot: ReadSnapshotHandle | null) => Promise<T>,
  /**
   * The role the read runs as inside a snapshot (the snapshot assumes it, and
   * verifies the switch once per snapshot); absent, the trusted runtime login
   * role. Outside a snapshot `run` receives `null` and switches itself.
   */
  role: SnapshotRoleSwitch | null = null,
): Promise<T> {
  assertTrustedRequestContext(context);
  const snapshot = currentReadSnapshot(pool);
  if (snapshot) return snapshot.join(context, run, role);
  return withTrustedRequestTransaction(pool, context, (client) =>
    run(client, null),
  );
}

/**
 * SPEED-1: hold one read-only `REPEATABLE READ` snapshot for the reads `work`
 * makes on `pool`. It opens at the first joined read with one envelope (the
 * login-role check, the identity `set_config`, the snapshot's policy epoch)
 * and ends when `work` calls `finishReads` or returns. Ending it commits, then
 * reads the live policy epoch in a transaction of its own; if the epoch moved
 * since the snapshot was taken, `work`'s result is discarded and `work` runs
 * once more, and a second change refuses the request with
 * `ReadSnapshotPolicyChangedError`.
 */
export async function withReadSnapshot<T>(
  pool: Pool,
  work: (finishReads: () => Promise<void>) => Promise<T>,
  /**
   * `false` for work that is not safe to run twice (a task step's POST):
   * a policy change then refuses the request at once.
   */
  options: { readonly retry?: boolean } = {},
): Promise<T> {
  const attempts = options.retry === false ? 1 : 2;
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = new ReadSnapshot(pool);
    try {
      const result = await heldSnapshots.run(snapshot, () =>
        work(() => snapshot.finish()),
      );
      await snapshot.finish();
      return result;
    } catch (error) {
      await snapshot.abandon();
      if (error instanceof ReadSnapshotPolicyChangedError && attempt < attempts)
        continue;
      throw error;
    }
  }
}

/**
 * A role a snapshot's reads may assume (SPEED-1 slice 4: the module role).
 * `assume` sets it; `restore` returns to the trusted runtime login role. Each
 * verifies the resulting role facts when `verify` is set, which the snapshot
 * asks for the first time each direction is taken in that snapshot; the
 * login role itself is verified when the snapshot opens.
 */
export interface SnapshotRoleSwitch {
  assume(client: PoolClient, verify: boolean): Promise<void>;
  restore(client: PoolClient, verify: boolean): Promise<void>;
}

/**
 * What a joined read sees of the open snapshot: the live-policy epoch it was
 * taken at, and a memo that lives exactly as long as it. A memoised read is
 * reused only within this one snapshot of this one request.
 */
export interface ReadSnapshotHandle {
  readonly policyVersion: string;
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

function snapshotHandle(policyVersion: string): ReadSnapshotHandle {
  const memo = new Map<string, Promise<unknown>>();
  return Object.freeze({
    policyVersion,
    memo<T>(key: string, load: () => Promise<T>): Promise<T> {
      let value = memo.get(key) as Promise<T> | undefined;
      if (!value) {
        value = load();
        memo.set(key, value);
      }
      return value;
    },
  });
}

const heldSnapshots = new AsyncLocalStorage<ReadSnapshot>();
/** Set while a joined read runs, so a nested read reuses its turn. */
const joinedReads = new AsyncLocalStorage<ReadSnapshot>();

function currentReadSnapshot(pool: Pool): ReadSnapshot | undefined {
  const snapshot = heldSnapshots.getStore();
  return snapshot?.pool === pool ? snapshot : undefined;
}

const SNAPSHOT_POLICY_VERSION_SQL = `SELECT COALESCE(
           (SELECT policy_version::text
              FROM platform.current_policy_epochs
             WHERE tenant_id = $1 AND environment_id = $2),
           '0'
         ) AS policy_version`;

const LIVE_POLICY_VERSION_SQL = `SELECT COALESCE(
           (SELECT policy_version::text
              FROM platform.current_policy_epochs
             WHERE tenant_id = $1 AND environment_id = $2),
           '0'
         ) AS live_policy_version`;

class ReadSnapshot {
  #client: PoolClient | null = null;
  #identity: TrustedRequestContext | null = null;
  /** The epoch the request's first snapshot saw; every later one must agree. */
  #policyVersion: string | null = null;
  #held: ReadSnapshotHandle | null = null;
  /** The role the open snapshot runs as (null: the runtime login role). */
  #role: SnapshotRoleSwitch | null = null;
  /** Role switches already verified in the open snapshot, per direction. */
  #assumed = new Set<SnapshotRoleSwitch>();
  #restored = new Set<SnapshotRoleSwitch>();
  #finished = false;
  #turn: Promise<unknown> = Promise.resolve();

  constructor(readonly pool: Pool) {}

  async join<T>(
    context: TrustedRequestContext,
    run: (
      client: PoolClient,
      snapshot: ReadSnapshotHandle | null,
    ) => Promise<T>,
    role: SnapshotRoleSwitch | null,
  ): Promise<T> {
    if (joinedReads.getStore() === this) {
      // A read nested inside a joined read: same turn, client and role.
      if (
        !this.#client ||
        !sameIdentity(this.#identity, context) ||
        this.#role !== role
      )
        throw new ReadSnapshotIntegrityError(
          'a nested read must use the open snapshot, its identity and its role',
        );
      return run(this.#client, this.#held);
    }
    return this.#exclusive(async () => {
      if (this.#finished)
        return runTrustedTransaction(this.pool, context, (client) =>
          run(client, null),
        );
      if (this.#client && !sameIdentity(this.#identity, context))
        await this.#end();
      if (!this.#client) await this.#open(context);
      const client = this.#client!;
      try {
        await this.#switchRole(client, role);
        return await joinedReads.run(this, () => run(client, this.#held));
      } catch (error) {
        // A failed read leaves the shared transaction unusable, and may have
        // left the module role assumed: end it; a later read opens anew.
        await this.#discard();
        throw error;
      }
    });
  }

  /** Assume `role` (null: the runtime login role) on the open snapshot. */
  async #switchRole(
    client: PoolClient,
    role: SnapshotRoleSwitch | null,
  ): Promise<void> {
    if (this.#role === role) return;
    if (this.#role) {
      const verify = !this.#restored.has(this.#role);
      await this.#role.restore(client, verify);
      this.#restored.add(this.#role);
      this.#role = null;
    }
    if (role) {
      const verify = !this.#assumed.has(role);
      await role.assume(client, verify);
      this.#assumed.add(role);
      this.#role = role;
    }
  }

  /** End the open snapshot before a transaction of its own on this pool. */
  async suspend(): Promise<void> {
    if (joinedReads.getStore() === this)
      throw new ReadSnapshotIntegrityError(
        'a joined read may not open a transaction of its own',
      );
    await this.#exclusive(() => this.#end());
  }

  /** No more reads join; the snapshot ends and the live policy is checked. */
  async finish(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#finished) return;
      this.#finished = true;
      if (this.#client) await this.#endWithLivePolicy();
      else await this.#checkLivePolicy();
    });
  }

  /**
   * Commit the open snapshot, then read the live epoch in a transaction of
   * its own on the same connection (its identity set again; the login role
   * was verified when the connection opened the snapshot) before releasing it.
   */
  async #endWithLivePolicy(): Promise<void> {
    const client = this.#client!;
    const identity = this.#identity!;
    this.#client = null;
    this.#held = null;
    this.#role = null;
    let live: string | undefined;
    let failure: unknown;
    let open = true;
    try {
      await client.query('COMMIT');
      open = false;
      await client.query('BEGIN READ ONLY');
      open = true;
      await setTrustedIdentity(client, identity);
      live =
        (
          await client.query<{ live_policy_version: string }>(
            LIVE_POLICY_VERSION_SQL,
            [identity.tenantId, identity.environmentId],
          )
        ).rows[0]?.live_policy_version ?? '0';
      await client.query('COMMIT');
      open = false;
    } catch (error) {
      failure = error;
      if (open) await client.query('ROLLBACK').catch(() => undefined);
    }
    const cleanupError = await releaseConnection(client, failure);
    if (failure !== undefined) throw failure;
    if (cleanupError) throw cleanupError;
    if (live !== this.#policyVersion)
      throw new ReadSnapshotPolicyChangedError(
        'the live policy changed while the page was read',
      );
  }

  /** On failure: end without the policy check, keeping the original error. */
  async abandon(): Promise<void> {
    this.#finished = true;
    await this.#exclusive(() => this.#discard());
  }

  #exclusive<T>(step: () => Promise<T>): Promise<T> {
    const result = this.#turn.then(step, step);
    this.#turn = result.catch(() => undefined);
    return result;
  }

  async #open(context: TrustedRequestContext): Promise<void> {
    const client = await this.pool.connect();
    this.#client = client;
    this.#identity = context;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assertRuntimeLoginRole(client);
      await setTrustedIdentity(client, context);
      const result = await client.query<{ policy_version: string }>(
        SNAPSHOT_POLICY_VERSION_SQL,
        [context.tenantId, context.environmentId],
      );
      const version = result.rows[0]?.policy_version ?? '0';
      this.#held = snapshotHandle(version);
      if (this.#policyVersion === null) this.#policyVersion = version;
      else if (this.#policyVersion !== version)
        throw new ReadSnapshotPolicyChangedError(
          'the live policy changed between two read snapshots of one request',
        );
    } catch (error) {
      await this.#discard();
      throw error;
    }
  }

  /** Commit and release the open snapshot, if any; a later read reopens one. */
  async #end(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#client = null;
    this.#held = null;
    this.#role = null;
    this.#assumed = new Set();
    this.#restored = new Set();
    let commitError: unknown;
    try {
      await client.query('COMMIT');
    } catch (error) {
      commitError = error;
    }
    const cleanupError = await releaseConnection(client, commitError);
    if (commitError !== undefined) throw commitError;
    if (cleanupError) throw cleanupError;
  }

  /** Roll back and release the open snapshot, if any. */
  async #discard(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#client = null;
    this.#held = null;
    this.#role = null;
    this.#assumed = new Set();
    this.#restored = new Set();
    let rollbackError: unknown;
    try {
      await client.query('ROLLBACK');
    } catch (error) {
      rollbackError = error;
    }
    await releaseConnection(client, rollbackError);
  }

  /** The epoch read live after the snapshot ends: unchanged, or the page is discarded. */
  async #checkLivePolicy(): Promise<void> {
    const identity = this.#identity;
    if (!identity || this.#policyVersion === null) return;
    const live = await runTrustedTransaction(
      this.pool,
      identity,
      async (client) =>
        (
          await client.query<{ live_policy_version: string }>(
            LIVE_POLICY_VERSION_SQL,
            [identity.tenantId, identity.environmentId],
          )
        ).rows[0]?.live_policy_version ?? '0',
    );
    if (live !== this.#policyVersion)
      throw new ReadSnapshotPolicyChangedError(
        'the live policy changed while the page was read',
      );
  }
}

function sameIdentity(
  left: TrustedRequestContext | null,
  right: TrustedRequestContext,
): boolean {
  return (
    left !== null &&
    left.tenantId === right.tenantId &&
    left.environmentId === right.environmentId &&
    left.principalId === right.principalId &&
    left.requestId === right.requestId
  );
}

async function assertRuntimeLoginRole(client: PoolClient): Promise<void> {
  const role = await client.query<{
    bypass_rls: boolean;
    can_login: boolean;
    create_database: boolean;
    create_role: boolean;
    inherits_privileges: boolean;
    replication: boolean;
    role: string;
    session_role: string;
    superuser: boolean;
  }>(`
      SELECT current_user AS role,
             session_user AS session_role,
             r.rolbypassrls AS bypass_rls,
             r.rolcanlogin AS can_login,
             r.rolcreatedb AS create_database,
             r.rolcreaterole AS create_role,
             r.rolinherit AS inherits_privileges,
             r.rolreplication AS replication,
             r.rolsuper AS superuser
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user
    `);
  const runtimeRole = role.rows[0];
  if (
    runtimeRole?.role !== 'north_star_runtime' ||
    runtimeRole.session_role !== 'north_star_runtime' ||
    runtimeRole.bypass_rls ||
    !runtimeRole.can_login ||
    runtimeRole.create_database ||
    runtimeRole.create_role ||
    runtimeRole.inherits_privileges ||
    runtimeRole.replication ||
    runtimeRole.superuser
  ) {
    throw new UnsafeDatabaseRoleError(
      'trusted request transactions require the unprivileged north_star_runtime login role',
    );
  }
}

async function setTrustedIdentity(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<void> {
  // ADR-0015 keeps legal entity as explicit business scope. Only tenancy,
  // environment, and request identity are ambient database context axes.
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true),
              set_config('north_star.principal_id', $3, true),
              set_config('north_star.request_id', $4, true)`,
    [
      context.tenantId,
      context.environmentId,
      context.principalId,
      context.requestId,
    ],
  );
}

/**
 * Reset the session and return the connection to the pool. A failed reset, or
 * a transaction end that failed (`failure`), destroys the connection instead.
 */
async function releaseConnection(
  client: PoolClient,
  failure?: unknown,
): Promise<unknown> {
  let cleanupError: unknown;
  try {
    await client.query('RESET ROLE');
    await client.query('RESET ALL');
  } catch (error) {
    cleanupError = error;
  } finally {
    const destroy = cleanupError ?? failure;
    client.release(destroy === undefined ? undefined : asError(destroy));
  }
  return cleanupError;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
