// SPEED-1 slice 6: a resolve hook for running the `build` output (tsc) with
// plain Node. Workspace packages export their TypeScript sources; any module
// that resolves to a `.ts` file inside this repository is redirected to its
// compiled twin under `dist/`. Everything else resolves unchanged.
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const root = pathToFileURL(fileURLToPath(new URL('../', import.meta.url))).href;
const dist = new URL('dist/', root).href;

export async function resolve(specifier, context, nextResolve) {
  // A bare package specifier from a compiled module is looked up from its
  // source twin's directory, where the workspace's node_modules are.
  const parent = context.parentURL;
  const bare = !/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/iu.test(specifier);
  const resolved = await nextResolve(
    specifier,
    bare && parent?.startsWith(dist)
      ? { ...context, parentURL: `${root}${parent.slice(dist.length)}` }
      : context,
  );
  const url = resolved.url;
  if (
    url.startsWith(root) &&
    !url.startsWith(dist) &&
    !url.includes('/node_modules/') &&
    url.endsWith('.ts')
  ) {
    return {
      ...resolved,
      format: 'module',
      url: `${dist}${url.slice(root.length, -'.ts'.length)}.js`,
    };
  }
  return resolved;
}
