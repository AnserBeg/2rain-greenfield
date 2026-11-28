import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { git } from '../.github/scripts/ci-selection.mjs';
import { buildModeSwitch } from './build-mode.mjs';

// The repository moved from AnserBeg to rainerp-com; run URLs under either owner
// (exactly those two) are valid, and rainerp-com is the canonical form.
// Legacy records predate tiers. Resolve the introduction on the current
// first-parent lineage, so other packets that landed before rollout are legacy.
const main = git('branch', '--remotes', '--list', 'origin/main').trim();
const history = main || 'HEAD';
const introduced = git(
  'log',
  '--first-parent',
  '--diff-filter=A',
  '--format=%H',
  history,
  '--',
  'scripts/check-record-ci-tier.mjs',
)
  .trim()
  .split('\n')[0];
const baseline = introduced
  ? `${introduced}^1`
  : git('merge-base', history, 'HEAD').trim();
const directory = 'docs/execution/packets';
const legacy = new Set(
  git('ls-tree', '-rz', '--name-only', baseline, '--', directory).split('\0'),
);
const modified = new Set(
  git('diff', '--name-only', '-z', baseline, '--', directory).split('\0'),
);
const runLinks = (text) =>
  text.match(
    /https:\/\/github\.com\/(?:AnserBeg|rainerp-com)\/2rain-greenfield\/actions\/runs\/\d+/gu,
  ) ?? [];
const line =
  /^CI tier: (?:quick|full) https:\/\/github\.com\/(?:AnserBeg|rainerp-com)\/2rain-greenfield\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*)?$/gmu;
// CI-8: a lane declares `CI tier: pending quick|full` in its first commit and
// replaces it with the run URL when the run exists, so no second docs-only
// commit is needed after the first dispatch. Only a packet branch may carry the
// marker: the integrator train (candidate/*, main, a detached merge) still
// requires the real run URL.
const pendingLine = /^CI tier: pending (?:quick|full)$/gmu;
const branch = (
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF_NAME ||
  git('rev-parse', '--abbrev-ref', 'HEAD')
).trim();
const pendingAllowed = /^packet\//u.test(branch);
// BUILD-MODE-1, switch `recordChecksReportOnly`: before the first tenant a
// record's tier line is reported but does not fail the run. With the switch
// off (or NORTH_STAR_BUILD_MODE=off) every finding fails, as before.
const reportOnly = buildModeSwitch('recordChecksReportOnly', {
  root: git('rev-parse', '--show-toplevel').trim(),
});
const report = (message) => {
  if (reportOnly) {
    console.error(`WARNING (build mode, not failing): ${message}`);
    return;
  }
  console.error(message);
  process.exitCode = 1;
};
for (const path of readdirSync(directory, { recursive: true }).map((path) =>
  join(directory, path),
)) {
  if (!path.endsWith('.md') || (legacy.has(path) && !modified.has(path)))
    continue;
  const body = readFileSync(path, 'utf8');
  if (
    !body.includes('record-claim') &&
    /-(?:charter|test-it-yourself|review-prompt|design)\.md$/u.test(path)
  )
    continue;
  if (legacy.has(path)) {
    const before = new Set(runLinks(git('show', `${baseline}:${path}`)));
    if (runLinks(body).every((link) => before.has(link))) continue;
  }
  const pending = [...body.matchAll(pendingLine)].length;
  if ([...body.matchAll(line)].length + pending !== 1) {
    report(
      `${path}: expected one "CI tier: quick|full https://github.com/rainerp-com/2rain-greenfield/actions/runs/<id>" line (or "CI tier: pending quick|full" on a packet/* branch)`,
    );
  } else if (pending === 1 && !pendingAllowed) {
    report(
      `${path}: "CI tier: pending" is allowed only on a packet/* branch (this is "${branch}"); replace it with the real run URL: CI tier: <quick|full> https://github.com/rainerp-com/2rain-greenfield/actions/runs/<id>`,
    );
  }
}
