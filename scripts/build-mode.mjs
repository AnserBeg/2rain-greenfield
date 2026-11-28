// BUILD-MODE-1: the one switch file for the pre-tenant gate relaxations.
//
// `build-mode.json` at the root of the tree being checked names five switches.
// A switch is on only when the file exists, `enabled` is true, the switch is
// true, and NORTH_STAR_BUILD_MODE is not "off". A missing file means strict:
// a fixture tree, or a tree after the hardening pass deletes the file, gets the
// old behaviour. The environment can only force strict, never relax.
// packages/dev-tooling/src/build-mode.ts mirrors this for the name guard; a
// test pins the two readers to the same answers.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export const BUILD_MODE_FILE = 'build-mode.json';
export const BUILD_MODE_SWITCHES = Object.freeze([
  'migrationListByGlob',
  'recordChecksReportOnly',
  'languageCoverageDigestRegeneration',
  'nameGuardReportOnly',
  'trainCapLifted',
]);

/**
 * @param {string} name one of BUILD_MODE_SWITCHES
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {boolean}
 */
export function buildModeSwitch(name, options = {}) {
  if (!BUILD_MODE_SWITCHES.includes(name))
    throw new Error(`unknown build-mode switch ${name}`);
  const env = options.env ?? process.env;
  if (env.NORTH_STAR_BUILD_MODE === 'off') return false;
  const path = join(options.root ?? process.cwd(), BUILD_MODE_FILE);
  if (!existsSync(path)) return false;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof config !== 'object' ||
    config === null ||
    config.version !== 1 ||
    typeof config.enabled !== 'boolean' ||
    typeof config.switches !== 'object' ||
    config.switches === null
  )
    throw new Error(`${BUILD_MODE_FILE} is malformed`);
  for (const [key, value] of Object.entries(config.switches)) {
    if (!BUILD_MODE_SWITCHES.includes(key) || typeof value !== 'boolean')
      throw new Error(
        `${BUILD_MODE_FILE}: unknown or non-boolean switch ${key}`,
      );
  }
  return config.enabled && config.switches[name] === true;
}
