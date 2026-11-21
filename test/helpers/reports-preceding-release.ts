import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  compileInSandbox,
  parseSerializedRelease,
  serializeRelease,
  type CustomizationPatch,
} from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

export const reportsPredecessor = '0a9f7ca52304969c65092893f50375c90f8c2265';
export const readReportsPredecessor = (file: string) =>
  JSON.parse(
    execFileSync('git', ['show', reportsPredecessor + ':' + file], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );

export async function compileReportFixture(chain: CustomizationPatch[]) {
  const path = 'apps/web/release/app.authored.json';
  const result = await compileInSandbox({
    acknowledgement: readUnboundPermissionAcknowledgementFor(
      path,
      'northstar.app:package.application',
    ),
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
