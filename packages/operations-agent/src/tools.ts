/**
 * The five model-facing tools, and nothing else (ADR-0009, plan §9.2). Their
 * ids come from the compiler's `OPERATIONS_AGENT_TOOL_IDS`; their schemas are
 * constant whatever the release contains. Final answers are plain text: there
 * is no answer tool, no ask tool, no approval tool.
 */
import { OPERATIONS_AGENT_TOOL_IDS } from '../../compiler/src/index.js';

export type OperationsAgentToolId = (typeof OPERATIONS_AGENT_TOOL_IDS)[number];

export interface ModelToolDefinition {
  readonly name: OperationsAgentToolId;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const descriptions: Record<OperationsAgentToolId, string> = {
  erp_discover:
    'Find what this ERP can do. mode "context": who you act as, the business date and default currency of the company, and which record types exist. mode "search" with search text: matching operation and query ids. mode "contracts" with canonicalIds (up to 5): the full contract of each (fields, options, relations, precondition, effect, read-back). mode "resolve" with search text and canonicalIds [entity id or local name, e.g. "party"]: turn a name or number into a record id (exact, ambiguous or not-found).',
  erp_query:
    'Run one registered query by queryId. get: arguments {"recordId"}. list: arguments {"search"?, "view"? (a viewId from the contract), "filters"? [{"fieldId","value"}] exact match on returned fields (record ids and option ids are values), "parent"? {"relationId","recordId"} for the rows that belong to one record}. search/resolve: {"text"}. aggregate: the declared parameters. Optional selection (field ids to return), limit, cursor. The company and permissions are applied by the host.',
  erp_plan:
    'Create a plan for one or more writes; nothing is written. intents is an ordered list of steps: {"operationId", "target"? (recordId of an existing record, or {"fromStep": n} for a record an earlier step creates), "values"? / "patch"? (field id -> value), "relations"? (relation id -> recordId or {"fromStep": n}), "arguments"?}. Creates never take a target: the host mints the id. Exact decimals are strings ("12.5"), integers are strings ("1"), dates are ISO-8601 UTC. A reversible in-app change is approved by its risk class and runs when executed (the person can Undo it); any other plan is shown to the person, who approves or declines it. The result says which.',
  erp_execute:
    'Run an approved plan exactly as approved, step by step, through the same operations the screens use. Give planId and a new executionIdempotencyKey (any unique string; reusing it replays the same result). A step that fails stops the plan; earlier steps stay committed.',
  erp_verify:
    "Read back every executed step through its operation's declared read-back query and compare it with what was planned. Give operationSessionId (the planId). Report success only when this says verified.",
};

const schemas: Record<OperationsAgentToolId, Record<string, unknown>> = {
  erp_discover: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['context', 'search', 'contracts', 'resolve'],
      },
      search: { type: 'string' },
      canonicalIds: { type: 'array', items: { type: 'string' } },
      cursor: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  erp_query: {
    type: 'object',
    properties: {
      queryId: { type: 'string' },
      arguments: { type: 'object' },
      selection: { type: 'array', items: { type: 'string' } },
      cursor: { type: 'string' },
      limit: { type: 'integer' },
      outputMode: { type: 'string', enum: ['records'] },
    },
    required: ['queryId'],
    additionalProperties: false,
  },
  erp_plan: {
    type: 'object',
    properties: {
      intents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            operationId: { type: 'string' },
            target: {},
            values: { type: 'object' },
            patch: { type: 'object' },
            relations: { type: 'object' },
            arguments: { type: 'object' },
          },
          required: ['operationId'],
        },
      },
      targetSet: { type: 'object' },
      dependencyBindings: { type: 'object' },
      requestedBulkMode: { type: 'string' },
    },
    required: ['intents'],
    additionalProperties: false,
  },
  erp_execute: {
    type: 'object',
    properties: {
      planId: { type: 'string' },
      confirmationGrantIds: { type: 'array', items: { type: 'string' } },
      executionIdempotencyKey: { type: 'string' },
    },
    required: ['planId', 'executionIdempotencyKey'],
    additionalProperties: false,
  },
  erp_verify: {
    type: 'object',
    properties: {
      operationSessionId: { type: 'string' },
      verificationScope: { type: 'string' },
      cursor: { type: 'string' },
    },
    required: ['operationSessionId'],
    additionalProperties: false,
  },
};

/** Exactly the compiled five, in the compiler's order. */
export const OPERATIONS_AGENT_TOOLS: readonly ModelToolDefinition[] =
  Object.freeze(
    OPERATIONS_AGENT_TOOL_IDS.map((name) =>
      Object.freeze({
        name,
        description: descriptions[name],
        inputSchema: schemas[name],
      }),
    ),
  );

export const OPERATIONS_AGENT_SYSTEM_PROMPT = `You operate an ERP for an office worker, acting as them with exactly their permissions. You have five tools and nothing else.

How to work:
- The business map at the end of this prompt lists every record type, query and operation you may use, with their fields and the steps each screen button runs. Take ids from it: do not search for them. Load erp_discover contracts only for detail the map leaves out (an operation that takes arguments, a precondition), all you need in one call. Today's date, the default currency, the screens' defaults and the page the person is on come with the request; you do not need erp_discover context. If there is no map, use erp_discover search and contracts. Never guess an id, field or option.
- Turn names and numbers into record ids with erp_discover resolve or a list query. Make lookups that do not depend on each other in the same turn, together.
- Answer questions with erp_query. Quote the figures the queries return; do not estimate.
- For any change: read what you need first, then erp_plan. Before planning anything that consumes stock, money or capacity, read the current availability; if the request cannot be met, say so and plan nothing.
- Only do what the person asked. If what they ask is not something a registered operation does, say that plainly; you may name the nearest operations that exist, but do not run one they did not ask for.
- Never ask "shall I?" in text before planning: plan, and the host decides. A reversible in-app change (creating or editing a record) runs at once and the person can Undo it; anything that moves stock, posts money or archives waits for the person's yes, which erp_plan reports.
- After erp_plan is approved, erp_execute it, then erp_verify it. Report success only when erp_verify says verified; otherwise report exactly which step stopped and why.
- Values you were not given: first take them from the request, then from erp_discover context (today, now, default currency, formDefaults: what the screens pre-select, such as a payment method), then from records you resolved or read: the customer's or supplier's own defaults and addresses (currency, terms, salesperson, tax code, default ship-to address; read the address record and copy its fields into the order's ship-to fields). Take "today" and relative dates from context, never memory. Only when a value exists in none of those places (a quantity or price the request did not give, a date or currency context lacks, a payment method nobody named) do not invent it: leave an optional field out, and for a required one plan nothing and ask the person in your answer.
- Finish with a short plain answer: what you found or did, with document numbers and figures.`;
