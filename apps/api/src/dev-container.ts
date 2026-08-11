/**
 * One resolver for the dev database container's identity, shared by the dev
 * server and by the `dev:stop` / `dev:reset` scripts.
 *
 * It exists because three surfaces disagreed. `main.ts` read one environment
 * variable, four packet records set a different one that nothing read, and the
 * helper scripts hard-coded the default name — so a configured container was
 * started under one name and `dev:stop` operated on another, which is exactly
 * the residual `dev-container-unguarded` claimed was bounded.
 */

/** Reserved for ephemeral TEST containers; see `refuseReservedPrefix`. */
export const RESERVED_CONTAINER_PREFIX = 'north-star-';
export const DEFAULT_DEV_CONTAINER_NAME = 'dev-composed-app-postgres';
export const DEV_CONTAINER_VARIABLE = 'NORTH_STAR_DEV_DATABASE_CONTAINER';
export const RETIRED_CONTAINER_VARIABLE = 'NORTH_STAR_DATABASE_CONTAINER';

export interface DevContainerIdentity {
  readonly name: string;
  readonly volume: string;
}

/**
 * Resolves the container identity, refusing two things rather than warning
 * about them.
 *
 * `north-star-*` is refused because `scripts/guard-ephemeral-postgres.mjs`
 * scans that prefix and `scripts/run-matrix.sh` invokes it AFTER taking the
 * exclusive lock: a dev container under that name makes the matrix exit 76
 * with the slot already burned, and past an hour the age sweep removes it with
 * no check on whether its owner is alive.
 *
 * The retired variable is refused because it is NOT a synonym — it is the name
 * four packet records still pass, and silently ignoring it starts a container
 * the caller did not ask for while `dev:stop` targets a third name.
 */
export function resolveDevContainer(
  environment: Readonly<Record<string, string | undefined>>,
): DevContainerIdentity {
  const retired = environment[RETIRED_CONTAINER_VARIABLE];
  if (retired !== undefined) {
    throw new TypeError(
      `${RETIRED_CONTAINER_VARIABLE} is no longer read. It named the dev ` +
        `database container, and every recorded use sets a "north-star-" ` +
        `name that breaks the test matrix. Use ${DEV_CONTAINER_VARIABLE} ` +
        `with a name outside that prefix, or unset it to accept ` +
        `${DEFAULT_DEV_CONTAINER_NAME}. Got ${retired}`,
    );
  }
  const name =
    environment[DEV_CONTAINER_VARIABLE] ?? DEFAULT_DEV_CONTAINER_NAME;
  if (name.trim() === '') {
    throw new TypeError(`${DEV_CONTAINER_VARIABLE} must not be blank`);
  }
  if (name.startsWith(RESERVED_CONTAINER_PREFIX)) {
    throw new TypeError(
      `${DEV_CONTAINER_VARIABLE} must not start with ` +
        `"${RESERVED_CONTAINER_PREFIX}": that prefix is reserved for ` +
        `ephemeral test containers, and scripts/run-matrix.sh refuses to run ` +
        `while one is present. Got ${name}`,
    );
  }
  return Object.freeze({ name, volume: `${name}-data` });
}
