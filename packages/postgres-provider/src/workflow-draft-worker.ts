import { canonicalize } from '@north-star/canonical-model';
import { SANDBOX_PROTOCOL_VERSION } from '../../customization/src/sandbox.js';
import { compileWorkflowBody } from './workflow-compile.js';
import {
  verifyWorkflowReplay,
  type WorkflowVerificationFixture,
} from './workflow-run.js';
import type { WorkflowSdk } from './workflow-sdk.js';

export interface WorkflowVerificationRequest {
  readonly body: string;
  readonly declarations: string;
  readonly release: WorkflowSdk['release'];
  readonly fixtures: readonly WorkflowVerificationFixture[];
}

// Only the parent reads the release and admits the fixture calls against its
// contracts. The child can replay precisely that finite set of mocked effects.
process.once(
  'message',
  async (envelope: {
    protocol: string;
    kind: string;
    request: WorkflowVerificationRequest;
  }) => {
    let response;
    try {
      if (
        envelope.protocol !== SANDBOX_PROTOCOL_VERSION ||
        envelope.kind !== 'verifyWorkflowDraft'
      )
        throw new Error('Unexpected verification request');
      const { body, declarations, release, fixtures } = envelope.request;
      const mocks = new Map(
        fixtures.flatMap(({ effects }) =>
          effects.map(({ call }) => [canonicalize(call), call] as const),
        ),
      );
      const compiled = compileWorkflowBody(body, {
        declarations,
        release,
        admitCall(value) {
          const call = mocks.get(canonicalize(value));
          if (!call) throw new Error('Workflow attempted an unmocked call');
          return call;
        },
      });
      const { journals, coverage } = await verifyWorkflowReplay(
        compiled,
        fixtures,
        {
          executable: compiled.traced,
          methods: compiled.sites.map((site) => site.method),
        },
      );
      response = JSON.stringify({
        status: 'passed',
        executable: compiled.executable,
        journals,
        sites: compiled.sites,
        coverage,
      });
      if (Buffer.byteLength(response) > 1024 * 1024)
        throw new Error('Workflow verification output exceeds 1 MiB');
    } catch (error) {
      response = JSON.stringify({
        status: 'refused',
        message: String(error instanceof Error ? error.message : error).slice(
          0,
          8192,
        ),
      });
    }
    process.send?.({ protocol: SANDBOX_PROTOCOL_VERSION, response });
  },
);
