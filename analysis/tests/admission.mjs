import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { FixtureController, transportTimeoutMs } from '../controller.mjs';

export async function checkAdmission(owner, pool, first, image, boot) {
  async function actor(tenant = id()) {
    const scope = { tenant, environment: id(), company: id(), person: id() };
    const role = id();
    await owner.query(
      'INSERT INTO platform.tenants(id,slug) VALUES($1::uuid,$1::uuid::text) ON CONFLICT DO NOTHING',
      [tenant],
    );
    await owner.query(
      'INSERT INTO platform.environments(tenant_id,id,slug) VALUES($1,$2::uuid,$2::uuid::text)',
      [tenant, scope.environment],
    );
    await owner.query(
      "INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES($1,$2,$3,'analyst')",
      [tenant, scope.environment, role],
    );
    await owner.query(
      "INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES($1,$2,$3,'northstar.runtime:permission.analysis_run','northstar.runtime:analysis.fixture')",
      [tenant, scope.environment, role],
    );
    await owner.query(
      'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [tenant, scope.environment, id(), scope.person, role, scope.company],
    );
    return new FixtureController(pool, scope);
  }
  const other = await actor();
  const sibling = await actor(first.scope.tenant);
  // Pause one dispatch after SQL commits the lease and before the worker starts.
  // The other tenant's controller observes exactly the transport deadline.
  const host = {
    machine: 'startup-race',
    boot,
    tick: 1,
    image,
    available: 8 * 1024 ** 3,
  };
  const started = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const dispatcher = new FixtureController(pool, first.scope);
  const recovery = new FixtureController(pool, other.scope);
  dispatcher.probe = async () => host;
  dispatcher.worker = async (op) => {
    if (op === 'ack') return { status: 'unreconciled' }; // retry after SQL settlement
    assert.equal(op, 'run');
    started.resolve();
    await resume.promise;
    return { status: 'scriptFailure', launched: true };
  };
  let age = transportTimeoutMs;
  recovery.probe = async () => ({ ...host, tick: host.tick + age / 1000 });
  const calls = [];
  recovery.worker = async (op, job) => {
    calls.push([op, job]);
    return op === 'ack'
      ? { status: 'acknowledged' }
      : { status: 'hostFailure', launched: false };
  };
  const starting = await dispatcher.enqueue();
  const running = dispatcher.dispatch();
  try {
    await Promise.race([
      started.promise,
      running.then(() => {
        throw Error('dispatch never started');
      }),
    ]);
    await recovery.recover();
    assert.deepEqual(calls, []);
    assert.equal((await dispatcher.result(starting)).status, 'reserved');
  } finally {
    resume.resolve();
    await running;
  }
  assert.equal((await dispatcher.result(starting)).status, 'scriptFailure');
  await recovery.recover();
  assert.deepEqual(calls.splice(0), [['ack', starting]]);
  const stale = await dispatcher.enqueue();
  const [reserved] = await dispatcher.query(
    'SELECT platform.analysis_dispatch($1,$2,1000,$3,1,false) j',
    [host.machine, boot, host.available],
  );
  assert.equal(reserved.j, stale);
  age += 2;
  await recovery.recover();
  assert.deepEqual(calls, [
    ['reconcile', stale],
    ['ack', stale],
  ]);
  assert.equal((await dispatcher.result(stale)).status, 'hostFailure');
  const enqueue = async (who, host = 'fair') =>
    (
      await who.query('SELECT platform.analysis_enqueue($1,$2,$3,$4,$5,0) j', [
        who.scope.company,
        id(),
        image,
        host,
        boot,
      ])
    )[0].j;
  const dispatch = async (host = 'fair', available = 10 * 1024 ** 3) =>
    (
      await first.query(
        'SELECT platform.analysis_dispatch($1,$2,5,$3,2,true) j',
        [host, boot, available],
      )
    )[0].j;
  const finish = (job) =>
    first.query("SELECT platform.analysis_settle($1,'refused',false,NULL)", [
      job,
    ]);
  await owner.query(
    "INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) SELECT tenant_id,environment_id,role_id,'northstar.runtime:permission.analysis_admin',resource_id FROM platform.current_policy_permission_grants WHERE tenant_id=$1 AND environment_id=$2",
    [other.scope.tenant, other.scope.environment],
  );
  await owner.query(
    'UPDATE platform.current_policy_memberships SET legal_entity_id=NULL WHERE tenant_id=$1 AND principal_id=$2',
    [other.scope.tenant, other.scope.person],
  );
  await other.query('SELECT platform.analysis_tenant_switch(true)');
  await assert.rejects(enqueue(other), /analysis.stopped/u);
  const unaffected = await enqueue(first, 'tenant-switch');
  await first.cancel(unaffected);
  assert.deepEqual(
    (
      await owner.query(
        'SELECT tenant_id FROM platform.analysis_run_controls WHERE disabled',
      )
    ).rows,
    [{ tenant_id: other.scope.tenant }],
  );
  await other.query('SELECT platform.analysis_tenant_switch(false)');
  const previous = await enqueue(first);
  assert.equal(await dispatch(), previous);
  await finish(previous);
  const earlier = await enqueue(first),
    later = await enqueue(other);
  assert.equal(await dispatch(), later, 'round-robin tenant fairness');
  assert.equal(
    await dispatch('fair', 6 * 1024 ** 3 - 1),
    null,
    'outstanding collector and worker memory',
  );
  assert.equal(await dispatch('fair', 6 * 1024 ** 3), earlier);
  const crossEnvironment = await enqueue(sibling);
  await finish(later);
  assert.equal(await dispatch(), null, 'one tenant slot across environments');
  const secondHost = await enqueue(first, 'second-host');
  assert.equal(
    await dispatch('second-host'),
    null,
    'one person slot across hosts',
  );
  await finish(earlier);
  assert.equal(await dispatch(), crossEnvironment);
  assert.equal(await dispatch('second-host'), secondHost);
  await finish(crossEnvironment);
  await finish(secondHost);

  const crowd = [first, other, await actor(), await actor()];
  for (const who of crowd) {
    await enqueue(who, 'crowd');
    await enqueue(who, 'crowd');
  }
  await assert.rejects(enqueue(await actor(), 'crowd'), /queueFull/u);
  await assert.rejects(
    first.query(
      "SELECT platform.analysis_dispatch('crowd',$1,0,9000000000,1,true)",
      [boot],
    ),
    /hostConfiguration/u,
  );

  // Probe the two independent budget predicates at their exact ceilings. Every
  // mutation is transaction-local to this disposable cluster and rolled back.
  const queued = await enqueue(first, 'mutation');
  for (const [subject, clause, cap] of [
    [first.scope.person, 'b.starts>=18', 18],
    ['tenant', 'b.starts>=90', 90],
  ]) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE platform.analysis_budget_counters SET starts=$1 WHERE tenant_id=$2 AND environment_id=$3 AND subject=$4',
        [cap, first.scope.tenant, first.scope.environment, subject],
      );
      const sql =
        "SELECT platform.analysis_dispatch('mutation',$1,1,8589934592,1,false) j";
      await client.query('SAVEPOINT baseline');
      assert.equal((await client.query(sql, [boot])).rows[0].j, null);
      await client.query('ROLLBACK TO baseline');
      const {
        rows: [{ body }],
      } = await client.query(
        "SELECT pg_get_functiondef('platform.analysis_dispatch(text,uuid,bigint,bigint,integer,boolean)'::regprocedure) AS body",
      );
      assert.equal(body.split(clause).length, 2);
      await client.query(body.replace(clause, 'false'));
      const observed = (await client.query(sql, [boot])).rows[0].j;
      assert.equal(
        observed,
        queued,
        'removing only ' + clause + ' admits the over-budget job',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  await first.cancel(queued);
}
