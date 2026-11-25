import { spawn } from 'node:child_process';

/**
 * A browser spec's fixture server, run as a child process.
 *
 * CI-7. `meta-sales.spec.ts` hit its 480-second test timeout three times on
 * CI with no assertion and no pending Playwright action in the report (runs
 * 45002907794, 45054641061 and 45110643699). Every Playwright call in that
 * spec carries a 30-second timeout, so a stall that long can only be in a wait
 * that is not a Playwright call: the fixture child printing its URL, or the
 * fixture child exiting after SIGTERM. Both waits were unbounded, and a failure
 * in the test body was held back behind the second one, so the report named
 * neither the stage nor the child's own output.
 *
 * Here each wait has a deadline and a failure that carries the child's output,
 * the test body's own failure is never replaced by a teardown failure, and a
 * child that ignores SIGTERM is killed.
 */
export interface FixtureProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The first capture group is the URL the test opens. */
  readonly readyPattern: RegExp;
  readonly startupMilliseconds: number;
  readonly stopMilliseconds: number;
}

export interface FixtureProcess {
  readonly url: string;
  output(): string;
  /** SIGTERM, then SIGKILL at the deadline. Never throws. */
  stop(): Promise<{
    readonly exited: boolean;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly output: string;
  }>;
}

export async function startFixtureProcess(
  options: FixtureProcessOptions,
): Promise<FixtureProcess> {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exitedAlready = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      exitedAlready = true;
      resolve();
    });
    child.once('error', () => {
      exitedAlready = true;
      resolve();
    });
  });
  const stop = async () => {
    if (!exitedAlready) child.kill('SIGTERM');
    const stalled = await didNotSettleWithin(exited, options.stopMilliseconds);
    if (stalled) {
      child.kill('SIGKILL');
      await didNotSettleWithin(exited, 5_000);
    }
    return { exited: !stalled, code: exitCode, signal: exitSignal, output };
  };
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `the fixture printed no URL within ${String(options.startupMilliseconds)} ms; output so far:\n${output}`,
        ),
      );
    }, options.startupMilliseconds);
    const look = () => {
      const match = options.readyPattern.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', look);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`the fixture exited before it was ready:\n${output}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return { url, output: () => output, stop };
}

/** True when the promise did NOT settle within the deadline. */
async function didNotSettleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), milliseconds);
  });
  try {
    return (
      (await Promise.race([promise.then(() => 'done' as const), deadline])) ===
      'late'
    );
  } finally {
    clearTimeout(timer);
  }
}
