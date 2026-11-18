import process from 'node:process';

const {
  changes,
  quality,
  'postgres-composed': composed,
  ...matrix
} = JSON.parse(process.env.CI_JOB_RESULTS);
const proseOnly = changes.outputs.prose_only;
if (
  changes.result !== 'success' ||
  quality.result !== 'success' ||
  !['true', 'false'].includes(proseOnly)
) {
  throw new Error(
    'CI requires a successful change classification and quality job',
  );
}

const expected = proseOnly === 'true' ? 'skipped' : 'success';
if (composed.result !== 'success' || composed.outputs.replay !== expected) {
  throw new Error(
    `PostgreSQL composed job was ${composed.result}, replay was ${composed.outputs.replay}; expected success and ${expected}`,
  );
}
for (const [job, { result }] of Object.entries(matrix)) {
  if (result !== expected) {
    throw new Error(`${job} was ${result}; expected ${expected}`);
  }
}
process.stdout.write(
  `All ${Object.keys(matrix).length} matrix jobs reported ${expected}.\n`,
);
