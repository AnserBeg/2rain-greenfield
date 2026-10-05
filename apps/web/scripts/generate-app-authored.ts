import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';

const root = resolve(import.meta.dirname, '../../..');
const authoredPath = resolve(
  process.env.NORTH_STAR_APP_AUTHORED_PATH ??
    resolve(root, 'apps/web/release/app.authored.json'),
);
// Compact JSON, as every test that hands the release script a candidate
// writes it. The canonical model refuses an authored package over
// `STRUCTURAL_LIMITS_V0.maximumAuthoredBytes`, measured in memory on its
// compact canonical bytes and by the release script on this file's bytes;
// pretty-printing added about half again in indentation alone, so the file is
// not formatted (`.prettierignore`).
const serialized = `${JSON.stringify(composedApplicationDefinition())}\n`;

await writeFile(authoredPath, serialized);
