import type { DraftOutcome } from '../../packages/postgres-provider/src/customization-service.js';
import { withArchivedCustomizationRuntime } from './archived-runtime-process.js';

// Produce genuine pre-index change sets for witnesses isolating earlier reader floors.
export async function draftBeforeCompanyAccessIndex(
  options: {
    databaseUrl: string;
    tenantSlug: string;
    compiledApplication: unknown;
  },
  patch: unknown,
  channel: 'declarativeEditor' | 'visualBuilder',
  request?: string,
): Promise<DraftOutcome> {
  return withArchivedCustomizationRuntime(
    '0a9f7ca52304969c65092893f50375c90f8c2265',
    async (run) =>
      (await run(
        `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { openCustomizeService } from './apps/api/src/composition-root.ts';
      import { DRAFT_CUSTOMIZATION_TOOL } from './packages/customization/src/ai-draft.ts';
      import { scriptedModel } from './packages/operations-agent/src/model.ts';
      const { options, patch, channel, request } = JSON.parse(await readFile(process.argv[2], 'utf8'));
      const opened = await openCustomizeService({
        ...options,
        draftingProvider: async () => scriptedModel([(conversation) => {
          assert.deepEqual(conversation, [{ role: 'user', text: request }]);
          return { toolCalls: [{ name: DRAFT_CUSTOMIZATION_TOOL, input: patch }] };
        }]),
      });
      try {
        const draft = request
          ? await opened.service.draftFromRequest(request)
          : await opened.service.draft(patch, channel);
        console.log(JSON.stringify(draft));
      } finally { await opened.close(); }
    `,
        { options, patch, channel, request },
      )) as DraftOutcome,
  );
}
