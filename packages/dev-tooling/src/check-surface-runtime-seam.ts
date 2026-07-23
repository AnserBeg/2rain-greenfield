import { resolve } from 'node:path';

import {
  checkSurfaceRuntimeSeam,
  checkUxGrammarPin,
  formatSurfaceContractViolations,
} from './surface-runtime-seam.js';

const rootArgumentIndex = process.argv.indexOf('--root');
const suppliedRoot =
  rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : undefined;

if (rootArgumentIndex >= 0 && !suppliedRoot) {
  console.error('surface-runtime-seam: --root requires a directory');
  process.exitCode = 2;
} else {
  const root = resolve(suppliedRoot ?? process.cwd());
  const pin = checkUxGrammarPin(root);
  const seam = checkSurfaceRuntimeSeam(root);
  const output = [
    formatSurfaceContractViolations('ux-grammar-pin', pin),
    formatSurfaceContractViolations('surface-runtime-seam', seam),
  ].join('\n');
  if (pin.violations.length === 0 && seam.violations.length === 0) {
    console.log(output);
  } else {
    console.error(output);
    process.exitCode = 1;
  }
}
