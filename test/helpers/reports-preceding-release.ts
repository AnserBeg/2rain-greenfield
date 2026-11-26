import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  narrowAcknowledgementToDeclared,
  readUnboundPermissionAcknowledgementFor,
} from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  compileInSandbox,
  parseSerializedRelease,
  serializeRelease,
  type CustomizationPatch,
} from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

import { reportsPredecessor } from './archived-runtime-process.js';

export { reportsPredecessor };
export const readReportsPredecessor = (file: string) =>
  JSON.parse(
    execFileSync('git', ['show', reportsPredecessor + ':' + file], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );

/**
 * Today's acknowledgement for an archived first-party base: narrowed to the
 * permissions that base declares, as the release build narrows it for each
 * recorded revision. A permission bound after the base was archived is not
 * the base's, so it is neither stale there nor unbound.
 */
export function acknowledgementForBase(base: Record<string, unknown>) {
  return narrowAcknowledgementToDeclared(
    readUnboundPermissionAcknowledgementFor(
      'apps/web/release/app.authored.json',
      'northstar.app:package.application',
    ),
    new Set(
      (base.permissions as readonly { readonly permissionId: string }[]).map(
        (permission) => permission.permissionId,
      ),
    ),
  );
}

export async function compileReportFixture(chain: CustomizationPatch[]) {
  const path = 'apps/web/release/app.authored.json';
  const result = await compileInSandbox({
    acknowledgement: acknowledgementForBase(readReportsPredecessor(path)),
    base: readReportsPredecessor(path),
    tip: serializeRelease(
      parseCompiledApplication(
        readReportsPredecessor('apps/web/release/app.compiled.json'),
      ).application,
    ),
    chain,
  });
  assert.ok(
    result.status === 'compiled',
    result.status === 'compiled' ? '' : JSON.stringify(result),
  );
  return parseSerializedRelease(result.steps[0]!.release);
}
