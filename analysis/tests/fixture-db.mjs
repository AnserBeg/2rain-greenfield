import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
import pg from 'pg';
import { checkAdmission } from './admission.mjs';
import { FixtureController } from '../controller.mjs';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.ts';

const owner = new pg.Pool();
const hostPool = new pg.Pool({ user: 'north_star_analysis_controller' });
const opPool = new pg.Pool({ user: 'north_star_analysis_operator' });
const scope = { tenant: id(), environment: id(), company: id(), person: id() };
const image = 'sha256:' + 'd'.repeat(64);
const boot = id();
const controller = new FixtureController(hostPool, scope);
const admin = new FixtureController(opPool);
const read = async (sql, args) => (await owner.query(sql, args)).rows;
const query = (sql, args) => controller.query(sql, args);
const enqueue = async (
  key = id(),
  company = scope.company,
  tick = 0,
  runner = 'host',
) =>
  (
    await query('SELECT platform.analysis_enqueue($1,$2,$3,$4,$5,$6) j', [
      company,
      key,
      image,
      runner,
      boot,
      tick,
    ])
  )[0].j;
const dispatch = async (available = 8 * 1024 ** 3, tick = 1, runner = 'host') =>
  (
    await query('SELECT platform.analysis_dispatch($1,$2,$3,$4,1,false) j', [
      runner,
      boot,
      tick,
      available,
    ])
  )[0].j;
const settle = (j, status, launched) =>
  query('SELECT platform.analysis_settle($1,$2,$3,$4)', [
    j,
    status,
    launched,
    status === 'success' ? { run: { profile: { image } } } : null,
  ]);
const counters = async () =>
  (
    await read(
      'SELECT starts FROM platform.analysis_budget_counters ORDER BY subject',
    )
  ).map((r) => r.starts);
const expectStatus = async (j, s) =>
  assert.equal((await controller.result(j)).status, s);

try {
  const client = await owner.connect();
  try {
    await runMigrations(client, await loadMigrations('db/migrations'));
  } finally {
    client.release();
  }
  const role = id();
  await owner.query(
    "INSERT INTO platform.tenants(id,slug) VALUES($1,'analysis-fixture')",
    [scope.tenant],
  );
  await owner.query(
    "INSERT INTO platform.environments(tenant_id,id,slug) VALUES($1,$2,'dev')",
    [scope.tenant, scope.environment],
  );
  await owner.query(
    "INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES($1,$2,$3,'analyst')",
    [scope.tenant, scope.environment, role],
  );
  await owner.query(
    "INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES($1,$2,$3,'northstar.runtime:permission.analysis_run','northstar.runtime:analysis.fixture')",
    [scope.tenant, scope.environment, role],
  );
  await owner.query(
    'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES($1,$2,$3,$4,$5,$6)',
    [scope.tenant, scope.environment, id(), scope.person, role, scope.company],
  );
  const key = id();
  const [a, again] = await Promise.all([enqueue(key), enqueue(key)]);
  assert.equal(a, again);
  await assert.rejects(enqueue(key, id()), /analysis.denied/u);
  await assert.rejects(
    query('SELECT * FROM platform.analysis_runs'),
    /permission denied/u,
  );
  await assert.rejects(
    query('SELECT platform.analysis_tenant_switch(true)'),
    /analysis.denied/u,
  );
  await assert.rejects(
    query("SELECT platform.analysis_operator_switch('global',true)"),
    /permission denied/u,
  );
  const b = await enqueue();
  await assert.rejects(enqueue(), /analysis.queueFull/u);
  assert.equal(await dispatch(4 * 1024 ** 3 - 1), null);
  assert.equal(await dispatch(4 * 1024 ** 3), a);
  assert.equal(await dispatch(), null);
  assert.deepEqual(await counters(), [1, 1]);
  await settle(a, 'refused', false);
  assert.deepEqual(await counters(), [0, 0]);
  assert.equal(await dispatch(), b);
  await Promise.all([
    settle(b, 'hostFailure', true),
    settle(b, 'hostFailure', true),
  ]);
  assert.deepEqual(await counters(), [0, 0]);
  const charged = await enqueue();
  assert.equal(await dispatch(), charged);
  await settle(charged, 'scriptFailure', true);
  assert.deepEqual(await counters(), [1, 1]);
  const expired = await enqueue();
  assert.equal(await dispatch(8 * 1024 ** 3, 30000), null);
  await expectStatus(expired, 'expired');
  const active = await enqueue();
  assert.equal(await dispatch(), active);
  const queued = await enqueue();
  const switched = await admin.query(
    "SELECT platform.analysis_operator_switch('global',true) j",
  );
  assert.deepEqual(switched, [{ j: active }]);
  await expectStatus(queued, 'cancelled');
  await assert.rejects(enqueue(), /analysis.stopped/u);
  await admin.query("SELECT platform.analysis_operator_switch('global',false)");
  await settle(active, 'success', true);
  assert.deepEqual(await controller.result(active), {
    status: 'cancelled',
    receipt: null,
  });
  for (const [subject, cap] of [
    [scope.person, 18],
    ['tenant', 90],
  ]) {
    await owner.query(
      'UPDATE platform.analysis_budget_counters SET starts=CASE WHEN subject=$1 THEN $2::integer-1 ELSE 0 END',
      [subject, cap],
    );
    const last = await enqueue();
    assert.equal(await dispatch(), last);
    await settle(last, 'success', true);
    const overflow = await enqueue();
    assert.equal(await dispatch(), null);
    await expectStatus(overflow, 'refused');
  }
  await owner.query('UPDATE platform.analysis_budget_counters SET starts=0');
  process.stdout.write(
    'Start budget: both caps, refund once, replay, host headroom, company scope, expiry and stop fence passed.\n',
  );
  // The remaining layers have independent witnesses. Hold the person fixed and
  // remove only the stored company grant when checking a read.
  await owner.query(
    'UPDATE platform.current_policy_memberships SET legal_entity_id=$1 WHERE principal_id=$2',
    [id(), scope.person],
  );
  await assert.rejects(controller.result(a), /analysis.denied/u);
  await owner.query(
    'UPDATE platform.current_policy_memberships SET legal_entity_id=$1 WHERE principal_id=$2',
    [scope.company, scope.person],
  );
  const tx = await hostPool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(
      tx.query(
        "SELECT platform.analysis_dispatch('host',$1,0,8589934592,1,false)",
        [boot],
      ),
      /requiresReadCommitted/u,
    );
    await tx.query('ROLLBACK');
  } finally {
    tx.release();
  }
  const cancellable = await enqueue();
  assert.equal(await controller.cancel(cancellable), 'cancelled');
  const eligible = await enqueue();
  assert.equal(await dispatch(), eligible);
  await assert.rejects(
    query('SELECT platform.analysis_settle($1,$2,true,$3)', [
      eligible,
      'success',
      { run: { profile: { image: 'other' } } },
    ]),
    /imageMismatch/u,
  );
  await settle(eligible, 'success', true);
  await expectStatus(eligible, 'success');
  await admin.query('SELECT platform.analysis_operator_switch($1,true)', [
    'image/' + image,
  ]);
  await assert.rejects(enqueue(), /analysis.stopped/u);
  await admin.query('SELECT platform.analysis_operator_switch($1,false)', [
    'image/' + image,
  ]);
  // Separate scheduled headroom remains reserved even under parallel interactive traffic.
  await owner.query(
    'UPDATE platform.analysis_budget_counters SET starts=17 WHERE subject=$1',
    [scope.person],
  );
  const x = await enqueue(),
    y = await enqueue();
  const raced = await Promise.all([dispatch(), dispatch()]);
  assert.deepEqual(raced.filter(Boolean), [x]);
  await settle(x, 'scriptFailure', true);
  assert.equal(await dispatch(), null);
  await expectStatus(y, 'refused');
  await owner.query('UPDATE platform.analysis_budget_counters SET starts=0');
  await checkAdmission(owner, hostPool, controller, image, boot);
  if (process.argv.includes('--science')) {
    const key = id();
    const first = await controller.run(key);
    assert.equal(first.status, 'success', JSON.stringify(first));
    const interrupted = await controller.enqueue();
    const executing = controller.dispatch();
    const end = performance.now() + 15000;
    while (!(await controller.worker('status', interrupted)).launched) {
      assert.ok(performance.now() < end, 'fixture never launched');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await admin.switch('global', true);
    await executing;
    await expectStatus(interrupted, 'cancelled');
    await admin.switch('global', false);
    const second = await controller.run();
    assert.equal(
      second.receipt.run.outputSha256,
      first.receipt.run.outputSha256,
    );
    assert.equal((await controller.run(key)).job, first.job);
    assert.deepEqual(first.receipt.output.tables[0].rows, [[4, 12]]);
    assert.equal(first.receipt.output.charts[0].width, 240);
    assert.equal(first.receipt.output.charts[0].height, 160);
    assert.deepEqual(first.receipt.run.modelCallDisclosureDigests, []);
    process.stdout.write(
      JSON.stringify({
        job: first.job,
        table: first.receipt.output.tables[0],
        finding: first.receipt.output.findings,
        pixels: first.receipt.output.charts[0].pixelSha256,
      }) + '\n',
    );
  }
} finally {
  await Promise.all([owner.end(), hostPool.end(), opPool.end()]);
}
