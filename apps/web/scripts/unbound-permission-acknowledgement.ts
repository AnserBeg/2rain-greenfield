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
  return { entries, packageId };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
