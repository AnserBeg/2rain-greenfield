import { resolve } from 'node:path';

import {
  checkArchitecture,
  formatViolations,
} from './architecture-boundaries.js';

const rootArgumentIndex = process.argv.indexOf('--root');
const suppliedRoot =
  rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : undefined;

if (rootArgumentIndex >= 0 && !suppliedRoot) {
  console.error('architecture-boundaries: --root requires a directory');
  process.exitCode = 2;
} else {
  const result = checkArchitecture(resolve(suppliedRoot ?? process.cwd()));
  const output = formatViolations(result);
  if (result.violations.length === 0) {
    console.log(output);
  } else {
    console.error(output);
    process.exitCode = 1;
  }
}
