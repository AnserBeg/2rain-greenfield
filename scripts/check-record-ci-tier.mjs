import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { git } from '../.github/scripts/ci-selection.mjs';

// Legacy records predate tiers. Resolve the introduction on the current
// first-parent lineage, so other packets that landed before rollout are legacy.
const introduced = git(
  'log',
  '--first-parent',
  '--diff-filter=A',
  '--format=%H',
  '--',
  'scripts/check-record-ci-tier.mjs',
)
  .trim()
  .split('\n')[0];
const baseline = introduced ? `${introduced}^1` : 'HEAD';
const directory = 'docs/execution/packets';
const legacy = new Set(
  git('ls-tree', '-rz', '--name-only', baseline, '--', directory).split('\0'),
);
const line =
  /^CI tier: (?:quick|full) https:\/\/github\.com\/AnserBeg\/2rain-greenfield\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*)?$/gmu;
for (const path of readdirSync(directory, { recursive: true }).map((path) =>
  join(directory, path),
)) {
  if (!path.endsWith('.md') || legacy.has(path) || !existsSync(path)) continue;
  if (/-(?:charter|test-it-yourself|review-prompt|design)\.md$/u.test(path))
    continue;
  const body = readFileSync(path, 'utf8');
  if ([...body.matchAll(line)].length !== 1) {
    console.error(
      `${path}: expected one "CI tier: quick|full https://github.com/AnserBeg/2rain-greenfield/actions/runs/<id>" line`,
    );
    process.exitCode = 1;
  }
}
