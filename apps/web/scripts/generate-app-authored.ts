import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';
import { format } from 'prettier';

const root = resolve(import.meta.dirname, '../../..');
const authoredPath = resolve(
  process.env.NORTH_STAR_APP_AUTHORED_PATH ??
    resolve(root, 'apps/web/release/app.authored.json'),
);
const serialized = await format(
  JSON.stringify(composedApplicationDefinition()),
  { parser: 'json' },
);

await writeFile(authoredPath, serialized);
