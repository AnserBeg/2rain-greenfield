// SPEED-1 slice 6: start the composed application from the `build` output
// (`corepack pnpm build`, tsconfig.build.json) with plain Node instead of tsx.
//
//   corepack pnpm build && corepack pnpm start
//   node scripts/start-production.mjs dist/apps/api/src/measure-page.js
//
// The compiled modules read the release and the migrations relative to
// themselves, so `dist/` gets links to the checked-in `apps/web/release`,
// `db/` and the web package's dependencies (created once; never copies).
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const entry = resolve(root, process.argv[2] ?? 'dist/apps/api/src/main.js');
if (!existsSync(entry)) {
  process.stderr.write(
    `START_PRODUCTION_FAILED ${relative(root, entry)} is missing: run \`corepack pnpm build\` first\n`,
  );
  process.exit(1);
}
for (const [link, target] of [
  ['dist/apps/web/release', 'apps/web/release'],
  ['dist/db', 'db'],
  // `createRequire` lookups (the web package's fonts) bypass the resolve hook.
  ['dist/apps/web/node_modules', 'apps/web/node_modules'],
]) {
  const at = resolve(root, link);
  if (existsSync(at) || isLink(at)) continue;
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(relative(dirname(at), resolve(root, target)), at, 'dir');
}
register('./production-resolve.mjs', import.meta.url);
await import(pathToFileURL(entry).href);

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
