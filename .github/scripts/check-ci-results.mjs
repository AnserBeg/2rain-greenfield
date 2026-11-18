import process from 'node:process';

const jobs = JSON.parse(process.env.CI_JOB_RESULTS);
for (const [job, { result }] of Object.entries(jobs)) {
  if (result !== 'success') {
    throw new Error(`${job} was ${result}; expected success`);
  }
}
if (jobs['postgres-composed'].outputs.replay !== 'success') {
  throw new Error('The composed PostgreSQL replay must succeed');
}
process.stdout.write(
  `All ${Object.keys(jobs).length} required jobs succeeded.\n`,
);
