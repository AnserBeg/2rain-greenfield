// Read the token immediately before pushing the already-created integration
// commit. A successful check is bound to both sides of that exact update.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { criticalDiff, git } from '../.github/scripts/ci-selection.mjs';
import nonExecutablePaths from './non-executable-pathspec.json' with { type: 'json' };

const api = (path) =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
function* workflowRuns(query) {
  for (let page = 1; ; page++) {
    const { workflow_runs: runs } = api(
      `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?${query}&per_page=50&page=${page}`,
    );
    yield* runs;
    if (runs.length < 50) return;
  }
}
export function lastMainConclusion(runs, previousAttempt) {
  for (const run of runs) {
    if (run.status === 'completed') return run;
    // An in-progress rerun of red main must keep the window closed.
    if (run.run_attempt > 1) return previousAttempt(run);
  }
  throw new Error('No completed main CI run');
}
export function exactFull(run, candidate, jobs) {
  return (
    run.event === 'workflow_dispatch' &&
    run.head_sha === candidate &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    jobs.some(
      (job) =>
        job.name === `Executed-file reachability (full ${candidate})` &&
        job.conclusion === 'success',
    )
  );
}

export function docsOnly(base, candidate) {
  return !git(
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    base,
    candidate,
    '--',
    '.',
    ...nonExecutablePaths,
    ':!README.md',
  );
}

function checkWindow(packet, candidate) {
  if (!packet || !/^[a-f0-9]{40}$/u.test(candidate ?? ''))
    throw new Error(
      'Usage: node scripts/check-merge-window.mjs PACKET EXACT_INTEGRATION_SHA',
    );
  git('fetch', 'origin', 'main');
  const base = git('rev-parse', 'origin/main').trim();
  const parents = git('show', '-s', '--format=%P', candidate).trim().split(' ');
  if (parents.length !== 2 || parents[0] !== base)
    throw new Error(
      'Candidate must be a two-parent integration commit on current origin/main',
    );
  const latest = lastMainConclusion(
    workflowRuns('branch=main&event=push'),
    (run) =>
      api(
        `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt - 1}`,
      ),
  );
  // A red or cancelled main must not deadlock its own fix or revert. It
  // raises the bar instead: the exact candidate needs a full green.
  const redMain = latest.conclusion !== 'success';
  if (redMain)
    console.log(
      `Main CI is not green: ${latest.html_url} (${latest.conclusion}); exact full CI required`,
    );
  if (redMain || criticalDiff(base, candidate)) {
    const runs = workflowRuns(
      `head_sha=${candidate}&event=workflow_dispatch&status=success`,
    );
    let green = false;
    for (const run of runs) {
      const { jobs } = api(
        `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      );
      if (exactFull(run, candidate, jobs)) {
        console.log(`Full CI: ${run.html_url} (attempt ${run.run_attempt})`);
        green = true;
        break;
      }
    }
    if (!green)
      throw new Error(
        `Missing green full CI on exact integration commit ${candidate}${redMain ? ` (main CI ${latest.conclusion}: ${latest.html_url})` : ''}`,
      );
  }
  const owner = readFileSync(
    process.env.MERGE_WINDOW_FILE ??
      '/home/rvham/2rain-missions/merge-window.txt',
    'utf8',
  ).trim();
  if (
    owner &&
    owner !== packet &&
    owner !== `packet/${packet}` &&
    !docsOnly(base, candidate)
  )
    throw new Error(`Merge window belongs to ${owner}`);
  if (
    git('ls-remote', '--exit-code', 'origin', 'refs/heads/main').split(
      /\s/u,
    )[0] !== base
  )
    throw new Error('origin/main advanced during the check');
  console.log(`Merge window open for ${packet}: ${base} -> ${candidate}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  checkWindow(...process.argv.slice(2));
