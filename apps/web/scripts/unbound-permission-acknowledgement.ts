import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { CompilerExecutionOptions } from '@north-star/compiler';

/** The option type the compiler exposes, named once here rather than exported from its index. */
export type UnboundPermissionAcknowledgementInput = NonNullable<
  CompilerExecutionOptions['unboundPermissionAcknowledgement']
>;

export const UNBOUND_PERMISSION_ACKNOWLEDGEMENT_VERSION =
  'northstar.web:unbound-permission-acknowledgement/v1' as const;
export const UNBOUND_PERMISSION_ACKNOWLEDGEMENT_FILE =
  'unbound-permission-acknowledgement.json' as const;
export const CURRENT_POLICY_BINDINGS_VERSION =
  'northstar.web:current-policy-bindings/v1' as const;
export const CURRENT_POLICY_BINDINGS_FILE =
  'current-policy-bindings.json' as const;

/**
 * The checked-in acknowledgement of every declared permission no evaluator
 * binds, read for ONE package. It lives beside the release input it
 * acknowledges -- `app.authored.json`, `shell.authored.json` -- so whatever
 * redirects the release input (the `NORTH_STAR_APP_AUTHORED_PATH` override the
 * tests use) redirects its acknowledgement with it, and there is no separate
 * path to point elsewhere.
 *
 * Everything here fails closed. A document that is not exactly the versioned
 * shape, or one that carries no entry for the requested package, throws before
 * any compile runs: a release build is never silently ungoverned. Shrinking is
 * the policy over this file; the compiler enforces the snapshot invariant.
 */
export function readUnboundPermissionAcknowledgementFor(
  releaseInputPath: string,
  packageId: string,
): UnboundPermissionAcknowledgementInput {
  const path = resolve(
    dirname(releaseInputPath),
    UNBOUND_PERMISSION_ACKNOWLEDGEMENT_FILE,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `unbound-permission acknowledgement at ${path} cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const document = readAcknowledgementDocument(parsed, path);
  const entries = document.packages.get(packageId);
  if (entries === undefined) {
    throw new Error(
      `unbound-permission acknowledgement at ${path} names no entries for package ${packageId}; a release build cannot proceed ungoverned -- add the package with one entry per declared permission, or stop declaring permissions`,
    );
  }
  const evaluatorBindings = readCurrentPolicyBindingsFor(
    releaseInputPath,
    packageId,
  );
  return { entries, evaluatorBindings, packageId };
}

function readCurrentPolicyBindingsFor(
  releaseInputPath: string,
  packageId: string,
): readonly {
  readonly action: string;
  readonly availability?: 'active' | 'compatibleExtension';
  readonly permissionId: string;
  readonly resource: string;
}[] {
  const path = resolve(dirname(releaseInputPath), CURRENT_POLICY_BINDINGS_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `current-policy bindings at ${path} cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const refuse = (detail: string): never => {
    throw new Error(
      `current-policy bindings at ${path} are not the versioned shape: ${detail}`,
    );
  };
  if (!isRecord(parsed)) return refuse('the document is not an object');
  if (
    Object.keys(parsed).sort().join(',') !== 'packages,schemaVersion' ||
    parsed.schemaVersion !== CURRENT_POLICY_BINDINGS_VERSION ||
    !isRecord(parsed.packages)
  ) {
    return refuse('expected exactly the current schemaVersion and packages');
  }
  const raw = parsed.packages[packageId];
  if (!Array.isArray(raw)) {
    return refuse(`packages.${packageId} must be an array`);
  }
  return raw.map((binding, index) => {
    const keys = isRecord(binding) ? Object.keys(binding).sort().join(',') : '';
    if (
      !isRecord(binding) ||
      (keys !== 'action,permissionId,resource' &&
        keys !== 'action,availability,permissionId,resource') ||
      typeof binding.action !== 'string' ||
      typeof binding.permissionId !== 'string' ||
      typeof binding.resource !== 'string' ||
      (binding.availability !== undefined &&
        binding.availability !== 'active' &&
        binding.availability !== 'compatibleExtension') ||
      binding.action.length === 0 ||
      binding.permissionId.length === 0 ||
      binding.resource.length === 0
    ) {
      return refuse(
        `packages.${packageId}[${String(index)}] must be exactly {action, permissionId, resource} with an optional supported availability`,
      );
    }
    return Object.freeze({
      action: binding.action,
      ...(binding.availability === undefined
        ? {}
        : { availability: binding.availability }),
      permissionId: binding.permissionId,
      resource: binding.resource,
    });
  });
}

interface AcknowledgementDocument {
  readonly packages: ReadonlyMap<
    string,
    readonly { readonly permissionId: string; readonly resource: string }[]
  >;
}

export function readAcknowledgementDocument(
  value: unknown,
  path: string,
): AcknowledgementDocument {
  const refuse = (detail: string): never => {
    throw new Error(
      `unbound-permission acknowledgement at ${path} is not the versioned shape: ${detail}`,
    );
  };
  if (!isRecord(value)) return refuse('the document is not an object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'header,packages,schemaVersion') {
    return refuse(
      `expected exactly the keys header, packages, schemaVersion; received ${keys.join(', ') || 'none'}`,
    );
  }
  if (value.schemaVersion !== UNBOUND_PERMISSION_ACKNOWLEDGEMENT_VERSION) {
    return refuse(
      `schemaVersion must be ${UNBOUND_PERMISSION_ACKNOWLEDGEMENT_VERSION}`,
    );
  }
  if (
    !Array.isArray(value.header) ||
    value.header.length === 0 ||
    !value.header.every(
      (line) => typeof line === 'string' && line.trim().length > 0,
    )
  ) {
    return refuse('header must be a non-empty array of non-empty strings');
  }
  if (!isRecord(value.packages)) return refuse('packages must be an object');
  const packages = new Map<
    string,
    { readonly permissionId: string; readonly resource: string }[]
  >();
  for (const [packageId, entries] of Object.entries(value.packages)) {
    if (!Array.isArray(entries)) {
      return refuse(`packages.${packageId} must be an array`);
    }
    const parsed: { permissionId: string; resource: string }[] = [];
    entries.forEach((entry, index) => {
      if (
        !isRecord(entry) ||
        Object.keys(entry).sort().join(',') !== 'permissionId,resource' ||
        typeof entry.permissionId !== 'string' ||
        typeof entry.resource !== 'string' ||
        entry.permissionId.length === 0 ||
        entry.resource.length === 0
      ) {
        refuse(
          `packages.${packageId}[${String(index)}] must be exactly {permissionId, resource} with non-empty strings`,
        );
        return;
      }
      parsed.push({
        permissionId: entry.permissionId,
        resource: entry.resource,
      });
    });
    packages.set(packageId, parsed);
  }
  return { packages };
}

/**
 * The acknowledgement for a package that MAY NOT BE GOVERNED AT ALL, used only
 * for a recorded revision inside `--truncate-invalid-lineage`.
 *
 * Truncation must be able to JUDGE a recorded entry in order to decide whether
 * to drop it, so a recorded revision belonging to a package the checked-in list
 * does not key must not crash the script -- that would remove the ADR-0043
 * recovery mechanism entirely. It returns an EMPTY acknowledgement instead,
 * which is strictly stricter than throwing would be at that entry: every
 * permission the revision declares is then unacknowledged, the compile is
 * refused as unbound, and truncation drops that entry and everything after it.
 * A revision declaring no permissions is retained, which is correct.
 *
 * The head path never uses this: `readUnboundPermissionAcknowledgementFor`
 * still throws, because a head whose package is unlisted must stop the build
 * rather than be judged against nothing.
 */
export function readRetainableAcknowledgementFor(
  releaseInputPath: string,
  packageId: string,
): UnboundPermissionAcknowledgementInput {
  try {
    return readUnboundPermissionAcknowledgementFor(releaseInputPath, packageId);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('names no entries for package') ||
        error.message.includes('must be an array'))
    ) {
      return { entries: [], evaluatorBindings: [], packageId };
    }
    throw error;
  }
}

/**
 * The acknowledgement for ONE RECORDED revision of a lineage.
 *
 * A recorded entry declares the permission census it declared when it was
 * written, which is not today's. Handing it today's whole list would report
 * every newer entry as stale; handing it nothing would ungovern it, which is
 * the defect round 3 exists to remove. So the checked-in list is NARROWED to
 * the permissions that revision actually declares.
 *
 * This can only ever REMOVE entries, never invent one, so it cannot certify a
 * revision against itself: a permission that revision declares and the
 * checked-in list does not name is simply absent from the result, and the
 * compiler refuses that entry as unbound. That is the correct answer -- it
 * means a recorded release declared a permission nothing ever acknowledged,
 * and a recovery truncation must not retain it silently.
 */
export function narrowAcknowledgementToDeclared(
  acknowledgement: UnboundPermissionAcknowledgementInput,
  declaredPermissionIds: ReadonlySet<string>,
): UnboundPermissionAcknowledgementInput {
  return {
    ...(acknowledgement.evaluatorBindings
      ? {
          evaluatorBindings: acknowledgement.evaluatorBindings.filter((entry) =>
            declaredPermissionIds.has(entry.permissionId),
          ),
        }
      : {}),
    entries: acknowledgement.entries.filter((entry) =>
      declaredPermissionIds.has(entry.permissionId),
    ),
    packageId: acknowledgement.packageId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
