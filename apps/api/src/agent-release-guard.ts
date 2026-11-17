/**
 * The terminal agent runs the release it was compiled with, and opening a
 * runtime installs and activates that release on whatever database it points
 * at. A checkout whose release differs from the dev database's would therefore
 * switch the dev database's pointer from a terminal command. This guard reads
 * the pointer first, changes nothing, and says in plain words when the two
 * differ; the caller then stops before any runtime is opened.
 */
import { readActiveReleaseRoot } from '@north-star/postgres-provider/active-release-root';

export type TerminalReleaseCheck =
  | { readonly kind: 'match' }
  | { readonly kind: 'not-installed'; readonly message: string }
  | { readonly kind: 'differs'; readonly message: string };

/** The serving release root of a compiled application envelope. */
export function compiledReleaseRoot(compiled: unknown): string {
  const applications = (compiled as { applications?: unknown }).applications;
  const last = Array.isArray(applications) ? applications.at(-1) : undefined;
  const root = (last as { releaseRoot?: unknown } | undefined)?.releaseRoot;
  if (typeof root !== 'string')
    throw new TypeError('the compiled application has no release root');
  return root;
}

const shortRoot = (root: string) => root.slice(0, 12);

export async function checkTerminalRelease(options: {
  readonly databaseUrl: string;
  readonly tenantSlug: string;
  readonly compiledRoot: string;
}): Promise<TerminalReleaseCheck> {
  let active: string | null;
  try {
    active = await readActiveReleaseRoot(options);
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
  if (active === options.compiledRoot) return { kind: 'match' };
  return {
    kind: 'differs',
    message: `The dev database is serving release ${shortRoot(active)}, but this checkout is release ${shortRoot(options.compiledRoot)}. The agent does not switch releases. Run it from the checkout that started \`corepack pnpm dev\`, or restart dev from this one.`,
  };
}
