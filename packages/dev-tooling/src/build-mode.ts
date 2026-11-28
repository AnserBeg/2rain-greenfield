// BUILD-MODE-1: the dev-tooling reader of `build-mode.json`. It mirrors
// scripts/build-mode.mjs exactly (test/architecture/build-mode.test.ts pins the
// two to the same answers); it exists so the name guard does not import a
// script from outside its package. Missing file means strict; the environment
// (NORTH_STAR_BUILD_MODE=off) can only force strict.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_MODE_FILE = 'build-mode.json';
export const BUILD_MODE_SWITCHES = [
  'migrationListByGlob',
  'recordChecksReportOnly',
  'languageCoverageDigestRegeneration',
  'nameGuardReportOnly',
  'trainCapLifted',
] as const;
export type BuildModeSwitchName = (typeof BUILD_MODE_SWITCHES)[number];

export function buildModeSwitch(
  name: BuildModeSwitchName,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly root?: string;
  } = {},
): boolean {
  if (!(BUILD_MODE_SWITCHES as readonly string[]).includes(name)) {
    throw new Error(`unknown build-mode switch ${String(name)}`);
  }
  const env = options.env ?? process.env;
  if (env.NORTH_STAR_BUILD_MODE === 'off') return false;
  const path = join(options.root ?? process.cwd(), BUILD_MODE_FILE);
  if (!existsSync(path)) return false;
  const config = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (
    typeof config !== 'object' ||
    config === null ||
    (config as { version?: unknown }).version !== 1 ||
    typeof (config as { enabled?: unknown }).enabled !== 'boolean' ||
    typeof (config as { switches?: unknown }).switches !== 'object' ||
    (config as { switches?: unknown }).switches === null
  ) {
    throw new Error(`${BUILD_MODE_FILE} is malformed`);
  }
  const { enabled, switches } = config as {
    enabled: boolean;
    switches: Record<string, unknown>;
  };
  for (const [key, value] of Object.entries(switches)) {
    if (
      !(BUILD_MODE_SWITCHES as readonly string[]).includes(key) ||
      typeof value !== 'boolean'
    ) {
      throw new Error(
        `${BUILD_MODE_FILE}: unknown or non-boolean switch ${key}`,
      );
    }
  }
  return enabled && switches[name] === true;
}
