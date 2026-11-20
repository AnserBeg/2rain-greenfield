import process from 'node:process';
import console from 'node:console';

const jobs = JSON.parse(process.env.CI_JOB_RESULTS);
const tier = jobs.select?.outputs?.tier;
if (
  !['quick', 'full'].includes(tier) ||
  jobs.select.result !== 'success' ||
  jobs.select.outputs.promote !== 'false'
)
  throw new Error('Missing successful tier selection');
const quick = tier === 'quick';
const fullJobs = [
  'performance',
  'postgres',
  'postgres-composed',
  'postgres-commercial',
  'postgres-sales',
  'postgres-inventory',
  'postgres-inventory-posting',
  'browser',
  'browser-operations',
  'browser-inventory',
  'browser-composed',
  'browser-customization',
  'browser-rules',
  'observability',
];
const expected = new Map([
  ['select', 'success'],
  ['quality', 'success'],
  ['security', 'success'],
  ['promote', 'skipped'],
]);
for (const job of fullJobs) expected.set(job, quick ? 'skipped' : 'success');
for (const [job, wanted] of expected) {
  if (jobs[job]?.result !== wanted)
    throw new Error(`${job} was ${jobs[job]?.result}; expected ${wanted}`);
}
for (const job of Object.keys(jobs))
  if (!expected.has(job)) throw new Error(`Unclassified CI job ${job}`);
if (!quick && jobs['postgres-composed'].outputs.replay !== 'success')
  throw new Error('The composed PostgreSQL replay must succeed');
console.log(
  `CI ${tier}: all required jobs succeeded. Expected skips: ${[...expected]
    .filter(([, result]) => result === 'skipped')
    .map(([job]) => job)
    .join(', ')}`,
);
