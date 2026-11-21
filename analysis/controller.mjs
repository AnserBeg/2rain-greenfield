import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import pg from 'pg';

const worker = fileURLToPath(new URL('./runner/worker.py', import.meta.url));
const responseLimit = 8 * 1024 * 1024;

export async function requestWorker(op, job, remote, image) {
  if (remote && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(remote))
    throw Error('Invalid configured SSH host');
  const command = remote ? 'ssh' : 'python3';
  const args = remote
    ? [
        ...(process.env.ANALYSIS_SSH_CONFIG
          ? ['-F', process.env.ANALYSIS_SSH_CONFIG]
          : []),
        '-T',
        '-oBatchMode=yes',
        '-oStrictHostKeyChecking=yes',
        '--',
        remote,
        'analysis-worker',
      ]
    : ['-B', worker];
  // SSH reads the operator’s host alias and known_hosts. The worker never receives PG credentials.
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME };
  if (remote && process.env.SSH_AUTH_SOCK)
    env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const child = spawn(command, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      op,
      ...(job ? { job } : {}),
      ...(image ? { image, input: { units: [3, 6, 9] } } : {}),
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const prefix = Buffer.alloc(4);
  let received = 0;
  let result;
  return new Promise((accept, reject) => {
    const fail = (error) => {
      child.kill('SIGKILL');
      reject(error);
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      if (received < 4) {
        const count = Math.min(chunk.length, 4 - received);
        chunk.copy(prefix, received, 0, count);
        received += count;
        chunk = chunk.subarray(count);
        if (received < 4) return;
        const size = prefix.readUInt32BE();
        if (size === 0 || size > responseLimit)
          return fail(Error('worker response length'));
        result = Buffer.alloc(size);
      }
      if (!result || chunk.length > result.length - (received - 4))
        return fail(Error('worker response overflow'));
      chunk.copy(result, received - 4);
      received += chunk.length;
    });
    child.on('close', (code) => {
      if (code !== 0 || !result || received !== result.length + 4)
        return reject(Error('worker transport interrupted'));
      try {
        accept(JSON.parse(result.toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(Buffer.concat([header, body]));
  });
}

export class FixtureController {
  constructor(
    pool,
    scope,
    {
      remote = process.env.ANALYSIS_RUNNER_HOST,
      slots = 1,
      shared = false,
    } = {},
  ) {
    this.pool = pool;
    this.scope = scope;
    this.remote = remote;
    this.slots = slots;
    this.shared = shared;
  }
  worker(op, job, image) {
    return requestWorker(op, job, this.remote, image);
  }
  async query(sql, args = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (this.scope) {
        await client.query(
          "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true),set_config('north_star.principal_id',$3,true)",
          [this.scope.tenant, this.scope.environment, this.scope.person],
        );
      }
      const { rows } = await client.query(sql, args);
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async probe() {
    const host = await this.worker('probe');
    if (!host.image)
      throw Error(host.reason || 'ANALYSIS_RUNTIME_UNAVAILABLE host probe');
    return host;
  }
  async enqueue(key = randomUUID()) {
    const host = await this.probe();
    const [row] = await this.query(
      'SELECT platform.analysis_enqueue($1,$2,$3,$4,$5,$6) AS id',
      [
        this.scope.company,
        key,
        host.image,
        host.machine,
        host.boot,
        Math.floor(host.tick * 1000),
      ],
    );
    return row.id;
  }
  async result(job) {
    const [row] = await this.query(
      'SELECT platform.analysis_result($1) AS result',
      [job],
    );
    if (!row.result) throw Error('analysis.denied');
    return row.result;
  }
  async settle(job, evidence) {
    if (
      ![
        'success',
        'hostFailure',
        'scriptFailure',
        'refused',
        'cancelled',
      ].includes(evidence.status)
    )
      return;
    const receipt =
      evidence.status === 'success'
        ? { run: evidence.receipt, output: evidence.output }
        : null;
    await this.query('SELECT platform.analysis_settle($1,$2,$3,$4)', [
      job,
      evidence.status,
      evidence.launched === true,
      receipt,
    ]);
    await this.worker('ack', job);
  }
  async recover() {
    const host = await this.probe();
    const pending = await this.query(
      'SELECT * FROM platform.analysis_pending($1)',
      [host.machine],
    );
    for (const { job, status } of pending) {
      if (status === 'stopping') await this.worker('cancel', job);
      await this.settle(job, await this.worker('reconcile', job));
    }
  }
  async cancel(job) {
    const [row] = await this.query(
      'SELECT platform.analysis_cancel($1) AS status',
      [job],
    );
    if (row.status === 'stopping') await this.worker('cancel', job);
    return row.status;
  }
  async dispatch() {
    const host = await this.probe();
    const [row] = await this.query(
      'SELECT platform.analysis_dispatch($1,$2,$3,$4,$5,$6) AS job',
      [
        host.machine,
        host.boot,
        Math.floor(host.tick * 1000),
        host.available,
        this.slots,
        this.shared,
      ],
    );
    if (!row.job) return false;
    // A lost reply leaves the lease and both reservations intact for reconciliation.
    let running = true;
    const monitor = async () => {
      while (running) {
        await sleep(200);
        if (!running) return;
        const leases = await this.query(
          'SELECT * FROM platform.analysis_pending($1)',
          [host.machine],
        );
        if (
          leases.some(
            (lease) => lease.job === row.job && lease.status === 'stopping',
          )
        ) {
          await this.worker('cancel', row.job);
          return;
        }
      }
    };
    const lease = (
      await this.query('SELECT * FROM platform.analysis_pending($1)', [
        host.machine,
      ])
    ).find((l) => l.job === row.job);
    if (!lease) return true;
    const execution = this.worker('run', row.job, lease.image).finally(() => {
      running = false;
    });
    const [evidence] = await Promise.all([execution, monitor()]);
    if (evidence.status === 'unreconciled')
      throw Error('analysis.reconciliationRequired');
    await this.settle(row.job, evidence);
    return true;
  }
  async run(key) {
    await this.recover();
    const job = await this.enqueue(key);
    for (;;) {
      const current = await this.result(job);
      if (!['queued', 'reserved', 'stopping'].includes(current.status))
        return { job, ...current };
      if (!(await this.dispatch())) await this.recover();
      await sleep(50);
    }
  }
  async switch(target, disabled) {
    const rows =
      target === 'tenant'
        ? await this.query(
            'SELECT platform.analysis_tenant_switch($1) AS job',
            [disabled],
          )
        : await this.query(
            'SELECT platform.analysis_operator_switch($1,$2) AS job',
            [target, disabled],
          );
    for (const { job } of rows) await this.worker('cancel', job);
    return rows.map(({ job }) => job);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [op, arg, setting] = process.argv.slice(2);
  const pool = new pg.Pool();
  const controller = new FixtureController(
    pool,
    {
      tenant: process.env.ANALYSIS_TENANT,
      environment: process.env.ANALYSIS_ENVIRONMENT,
      company: process.env.ANALYSIS_COMPANY,
      person: process.env.ANALYSIS_PERSON,
    },
    {
      remote: process.env.ANALYSIS_RUNNER_HOST,
      slots: Number(process.env.ANALYSIS_SLOTS || 1),
      shared: process.env.ANALYSIS_SHARED === '1',
    },
  );
  try {
    let result;
    if (op === 'run') result = await controller.run(arg);
    else if (op === 'cancel') result = await controller.cancel(arg);
    else if (op === 'recover') result = await controller.recover();
    else if (op === 'status') result = await controller.result(arg);
    else if (op === 'probe') result = await controller.probe();
    else if (op === 'switch' && ['on', 'off'].includes(setting))
      result = await controller.switch(arg, setting === 'off');
    else
      throw Error(
        'Expected run [request UUID], status JOB, recover, probe, or switch TARGET on|off',
      );
    process.stdout.write(JSON.stringify(result ?? null) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
