import process from 'node:process';

const { changes, quality, ...matrix } = JSON.parse(process.env.CI_JOB_RESULTS);
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
for (const [job, { result }] of Object.entries(matrix)) {
  if (result !== expected) {
    throw new Error(`${job} was ${result}; expected ${expected}`);
  }
}
console.log(
  `All ${Object.keys(matrix).length} matrix jobs reported ${expected}.`,
);
