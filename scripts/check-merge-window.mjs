// Read the token immediately before pushing the already-created integration
// commit. A successful check is bound to both sides of that exact update.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { git, requiresFull } from '../.github/scripts/ci-selection.mjs';
export { docsOnly } from '../.github/scripts/ci-selection.mjs';

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
const attemptJobs = (run) =>
  api(
    `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  ).jobs;

function reached(run, jobs, tier) {
  return jobs.some(
    (job) =>
      job.name === `Executed-file reachability (${tier} ${run.head_sha})` &&
      job.conclusion === 'success',
  );
}

export function lastMainConclusion(
  runs,
  previousAttempt,
  jobsFor = attemptJobs,
) {
  // The API yields main pushes newest first. A quick green can establish
  // neither recovery from an older red nor completion of a pending full.
  for (const run of runs) {
    if (run.status !== 'completed') {
      if (run.run_attempt > 1) {
        const prior = previousAttempt(run);
        if (prior.conclusion !== 'success') return prior;
      }
      if (
        jobsFor(run).some(
          (job) =>
            job.name === `Executed-file reachability (quick ${run.head_sha})`,
        )
      )
        continue;
      return run; // Pending full, or too early to identify the tier.
    }
    if (run.conclusion !== 'success') return run;
    const jobs = jobsFor(run);
    if (reached(run, jobs, 'full')) return run;
    if (!reached(run, jobs, 'quick'))
      return { ...run, conclusion: 'missing reachability' };
  }
  return { conclusion: 'no completed full main run' };
}

export function exactFull(run, candidate, jobs) {
  return (
    run.event === 'workflow_dispatch' &&
    run.head_sha === candidate &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    reached(run, jobs, 'full')
  );
}

function checkTrain(base, candidate) {
  const chain = git(
    'rev-list',
    '--first-parent',
    '--parents',
    '--max-count=4',
    `${base}..${candidate}`,
  )
    .trim()
    .split('\n')
    .map((line) => line.split(' '));
  if (chain.length > 3)
    throw new Error('A train may contain at most three merges');
  if (chain.some((commit) => commit.length !== 3))
    throw new Error('Every train commit must be a two-parent merge');
  if (chain.at(-1)[1] !== base)
    throw new Error('Train first-parent chain must end at current origin/main');
}

function checkWindow(packet, candidate) {
  if (!packet || !/^[a-f0-9]{40}$/u.test(candidate ?? ''))
    throw new Error(
      'Usage: node scripts/check-merge-window.mjs PACKET EXACT_INTEGRATION_SHA',
    );
  process.chdir(git('rev-parse', '--show-toplevel').trim());
  git('fetch', 'origin', 'main');
  const base = git('rev-parse', 'origin/main').trim();
  checkTrain(base, candidate);
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
  const fullRange = requiresFull(base, candidate);
  if (redMain)
    console.log(
      `Main CI is not green: ${latest.html_url} (${latest.conclusion ?? latest.status}); exact full CI required`,
    );
  if (redMain || fullRange) {
    const runs = workflowRuns(
      `head_sha=${candidate}&event=workflow_dispatch&status=success`,
    );
    let green = false;
    for (const run of runs) {
      if (exactFull(run, candidate, attemptJobs(run))) {
        console.log(`Full CI: ${run.html_url} (attempt ${run.run_attempt})`);
        green = true;
        break;
      }
    }
    if (!green)
      throw new Error(
        `Missing green full CI on exact integration commit ${candidate}${redMain ? ` (main CI ${latest.conclusion ?? latest.status}: ${latest.html_url})` : ''}`,
      );
  }
  const owner = readFileSync(
    process.env.MERGE_WINDOW_FILE ??
      '/home/rvham/2rain-missions/merge-window.txt',
    'utf8',
  ).trim();
  if (owner && owner !== packet && owner !== `packet/${packet}` && fullRange)
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
