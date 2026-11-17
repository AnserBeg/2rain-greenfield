/**
 * The terminal agent runs the release it was compiled with, and opening a
 * runtime installs and activates that release on whatever database it points
 * at. A checkout whose release differs from the dev database's would therefore
 * switch the dev database's pointer from a terminal command. This guard reads
 * the pointer first, changes nothing, and says in plain words when the two
 * differ; the caller then stops before any runtime is opened.
 */
import { parseCompiledApplication } from '@north-star/postgres-provider/composed-application-runtime';
import { readActiveRelease } from '@north-star/postgres-provider/active-release-root';

export type TerminalReleaseCheck =
  | { readonly kind: 'match' }
  | { readonly kind: 'not-installed'; readonly message: string }
  | { readonly kind: 'differs'; readonly message: string };

/** The serving release root of a compiled application envelope (either lineage form). */
export function compiledReleaseRoot(compiled: unknown): string {
  return parseCompiledApplication(compiled).application.compiled.releaseRoot;
}

const shortRoot = (root: string) => root.slice(0, 12);

export async function checkTerminalRelease(options: {
  readonly databaseUrl: string;
  readonly tenantSlug: string;
  readonly compiledRoot: string;
}): Promise<TerminalReleaseCheck> {
  let active;
  try {
    active = await readActiveRelease(options);
  } catch {
    return {
      kind: 'not-installed',
      message:
        'The agent could not read the dev database. Start it with `corepack pnpm dev` and try again.',
    };
  }
  if (active === null)
    return {
      kind: 'not-installed',
      message:
        'The dev database has no installed release. Start `corepack pnpm dev` from this checkout first; the agent never installs one.',
    };
  if (active.releaseRoot === options.compiledRoot) return { kind: 'match' };
  if (active.customized && active.baseReleaseRoot === options.compiledRoot)
    return { kind: 'match' };
  if (active.customized)
    return {
      kind: 'differs',
      message: `A customization of a different application version is active in the dev database (it builds on release ${shortRoot(active.baseReleaseRoot ?? 'unknown')}, but this checkout is release ${shortRoot(options.compiledRoot)}). The agent does not switch releases. Run it from the checkout that started \`corepack pnpm dev\`, or restart dev from this one.`,
    };
  return {
    kind: 'differs',
    message: `The dev database is serving release ${shortRoot(active.releaseRoot)}, but this checkout is release ${shortRoot(options.compiledRoot)}. The agent does not switch releases. Run it from the checkout that started \`corepack pnpm dev\`, or restart dev from this one.`,
  };
}
