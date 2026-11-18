/**
 * The customization draft a panel conversation asks for is metered against
 * that conversation's spend cap and stopped by its Stop (end review X13).
 * The customization service calls its drafting model deep inside its own
 * code, so the conversation's budget travels in async context: the panel's
 * handoff runs the draft inside `DRAFT_BUDGET.run(...)`, and the drafting
 * model reads it on every call. A draft started anywhere else (the
 * Customize screen's own box) has no budget here and runs unmetered.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  meteredNext,
  type ModelAdapter,
  type SpendMeter,
} from '@north-star/operations-agent';

export interface DraftBudget {
  readonly meter: SpendMeter;
  readonly signal?: AbortSignal;
}

export const DRAFT_BUDGET = new AsyncLocalStorage<DraftBudget>();

/** The drafting model, metered and stoppable when a budget is in context. */
export function budgetedDraftingModel(adapter: ModelAdapter): ModelAdapter {
  return {
    modelId: adapter.modelId,
    async next(request) {
      const budget = DRAFT_BUDGET.getStore();
      if (!budget) return adapter.next(request);
      if (budget.signal?.aborted) throw new Error('stopped by the person');
      const { turn } = await meteredNext(adapter, budget.meter, {
        ...request,
        ...(budget.signal ? { signal: budget.signal } : {}),
      });
      return turn;
    },
  };
}
