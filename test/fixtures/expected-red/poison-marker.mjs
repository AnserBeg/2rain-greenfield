import { fileURLToPath, URL } from 'node:url';

// Under test-results/, which is gitignored, so a control that leaves it behind
// cannot dirty the tracked tree the runner refuses to start against.
export const POISON_MARKER = fileURLToPath(
  new URL('../../../test-results/expected-red/self-test-poison', import.meta.url),
);
