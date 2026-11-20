import { appendFileSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import process from 'node:process';

import { reachabilityProducers } from '../../test/helpers/reachability-producers.ts';

import { quickSelection } from '../../test/helpers/quick-ci.ts';

const producers =
  process.env.CI_TIER === 'quick'
    ? quickSelection().producers
    : reachabilityProducers;
const rows = ['| Suite | Slowest files |', '| --- | --- |'];
for (const producer of producers) {
  const { files } = JSON.parse(readFileSync(producer.evidencePath, 'utf8'));
  const slowest = files
    .filter((file) => Number.isFinite(file.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map(
      ({ path, durationMs }) =>
        `\`${relative(process.cwd(), path)}\` ${Math.round(durationMs / 1000)}s`,
    );
  rows.push(`| ${producer.id} | ${slowest.join(', ')} |`);
}
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  [
    '### Test file timings',
    '',
    'Slowest three per suite. Node reports file elapsed time. Browser times sum test attempts and can overlap across workers. All file timings are in the reachability artifacts.',
    '',
    ...(process.env.CI_TIER === 'quick'
      ? [
          `Expected skipped producers: ${reachabilityProducers
            .filter((p) => !producers.some((active) => active.id === p.id))
            .map((p) => p.id)
            .join(', ')}`,
          '',
        ]
      : []),
    ...rows,
    '',
  ].join('\n'),
);
