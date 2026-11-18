/**
 * The assistant panel's endpoint (AGENT-3 slice 2): one conversation per
 * person, held in this process (v1: no migration, nothing durable), driven by
 * the same operations-agent session and loop the terminal uses.
 *
 * The browser sends text and the screen it is on (surface id and record id).
 * The screen is a claim: the session names the surface only if the release
 * declares it and reads the record fresh, as the person, through the query
 * gateway. Identity is the request's, never the body's; a conversation belongs
 * to the principal that started it and refuses anyone else. Every request is
 * same-origin JSON. Replies stream as NDJSON events.
 *
 * Spend is capped per conversation at USD 1.50 (AGENT-3 decision), priced at
 * the model's list prices; a run never starts a model call past the cap.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  agentPreamble,
  CUSTOMIZE_HANDOFF,
  OperationsAgentSession,
  runOperationsAgent,
  SpendMeter,
  type AgentEvent,
  type BusinessCalendar,
  type ConversationEntry,
  type ModelAdapter,
  type ModelPrices,
  type PlanForApproval,
} from '@north-star/operations-agent';
import type { ComposedApplicationRuntime } from '../../../packages/postgres-provider/src/composed-application-runtime.js';

/** USD per conversation (AGENT-3: at or below the charter's 2.00). */
export const ASSISTANT_CONVERSATION_CAP_USD = 1.5;

/**
 * Claude Opus 5.5 list prices, USD per million tokens, read from
 * platform.claude.com/docs/en/about-claude/pricing on 2026-11-17 (input 4,
 * output 20, 5-minute cache write 5, cache hit 0.20).
 */
export const ASSISTANT_DEFAULT_PRICES: ModelPrices = Object.freeze({
  input: 4,
  output: 20,
  cacheRead: 0.2,
  cacheWrite: 5,
});

/** How long a plan waits for the person's yes before it counts as a no. */
const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export interface AssistantEndpointOptions {
  readonly runtime: Pick<
    ComposedApplicationRuntime,
    'entry' | 'operationGateway' | 'operationMediation' | 'queryGateway'
  >;
  readonly companyId: string;
  readonly businessCalendar?: BusinessCalendar;
  /** The model, or a sentence saying why there is none. */
  readonly model: () => Promise<ModelAdapter | { unavailable: string }>;
  readonly prices?: ModelPrices;
  readonly capUsd?: number;
  /**
   * The customization lane (CUSTOMIZE's service): a change to the
   * application is handed to its AI draft, shown as a plain diff, and never
   * approved or activated from here (plan §9.1). Absent, the panel says where
   * to make the change.
   */
  readonly customize?: () => Promise<CustomizeDrafter>;
}

/** The one call the panel makes into the customization lane. */
export interface CustomizeDrafter {
  draftFromRequest(
    request: string,
  ): Promise<
    | { status: 'drafted'; renderedDiff: string; reused: boolean }
    | { status: string; message: string; missingCapability?: string }
  >;
}

interface PendingPlan {
  readonly planId: string;
  readonly digest: string;
  readonly decide: (approved: boolean) => void;
}

interface Conversation {
  readonly id: string;
  readonly principalId: string;
  readonly cookie: string;
  readonly session: OperationsAgentSession;
  readonly meter: SpendMeter;
  history: readonly ConversationEntry[];
  running: AbortController | null;
  pending: PendingPlan | null;
  /** Where the current run's events go. */
  emit: (event: Record<string, unknown>) => void;
}

export interface AssistantEndpoint {
  /** Handles `/?assistant=...`; false when the request is not the panel's. */
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean>;
  /** Stops every run (server shutdown). */
  close(): void;
}

export function createAssistantEndpoint(
  options: AssistantEndpointOptions,
): AssistantEndpoint {
  const conversations = new Map<string, Conversation>();
  const prices = options.prices ?? ASSISTANT_DEFAULT_PRICES;
  const capUsd = options.capUsd ?? ASSISTANT_CONVERSATION_CAP_USD;

  const principalOf = (request: IncomingMessage) =>
    options.runtime.entry.run({ headers: request.headers }, (view) =>
      Promise.resolve(view.principalId),
    );

  const open = (request: IncomingMessage, principalId: string) => {
    const conversation: Conversation = {
      id: randomUUID(),
      principalId,
      cookie: String(request.headers.cookie ?? ''),
      meter: new SpendMeter(prices, capUsd),
      history: [],
      running: null,
      pending: null,
      emit: () => undefined,
      session: new OperationsAgentSession({
        runtime: options.runtime,
        personHeaders: { cookie: String(request.headers.cookie ?? '') },
        companyId: options.companyId,
        ...(options.businessCalendar
          ? { businessCalendar: options.businessCalendar }
          : {}),
        approve: (plan) => askThePerson(conversation, plan),
        // The panel offers Undo, so a reversible change runs at once here.
        autoApproveReversible: true,
      }),
    };
    conversations.set(conversation.id, conversation);
    return conversation;
  };

  return {
    close() {
      for (const conversation of conversations.values()) {
        conversation.running?.abort();
        conversation.pending?.decide(false);
      }
    },
    async handle(request, response, url) {
      const action = url.searchParams.get('assistant');
      if (action === null) return false;
      if (request.method !== 'POST' || !sameOrigin(request)) {
        response.statusCode = 403;
        response.end();
        return true;
      }
      const body = await readJson(request);
      let principalId: string;
      try {
        principalId = await principalOf(request);
      } catch {
        response.statusCode = 401;
        response.end();
        return true;
      }
      const named =
        typeof body.conversation === 'string'
          ? conversations.get(body.conversation)
          : undefined;
      // A conversation is its starter's; anyone else gets a fresh one (ask)
      // or nothing (decide, stop).
      const mine = named?.principalId === principalId ? named : undefined;
      if (action === 'decide') {
        const pending = mine?.pending;
        const bound =
          pending &&
          body.planId === pending.planId &&
          body.digest === pending.digest;
        if (bound) pending.decide(body.approve === true);
        response.statusCode = bound ? 204 : 409;
        response.end();
        return true;
      }
      if (action === 'undo') {
        // The person's Undo click: the latest change of their conversation,
        // named by its id, and never while a run is working.
        response.setHeader('content-type', 'application/json; charset=utf-8');
        if (!mine || mine.running || typeof body.changeId !== 'string') {
          response.statusCode = 409;
          response.end(
            JSON.stringify({
              outcome: 'refused',
              text: 'Nothing to undo now.',
            }),
          );
          return true;
        }
        // Undo holds the conversation like a run: no ask or second Undo
        // interleaves with it.
        mine.running = new AbortController();
        const undone = await mine.session.undo(body.changeId).finally(() => {
          mine.running = null;
        });
        response.statusCode = 200;
        response.end(
          JSON.stringify(
            undone.outcome === 'undone'
              ? {
                  outcome: 'undone',
                  text: `${undone.summary}${undone.verified ? ' (checked)' : ' (the check did not confirm it; look at the record)'}`,
                }
              : { outcome: 'refused', text: `Not undone: ${undone.reason}` },
          ),
        );
        return true;
      }
      if (action === 'latest') {
        // The conversation's current undoable change, for a panel that
        // reopened after a navigation or a Stop.
        response.setHeader('content-type', 'application/json; charset=utf-8');
        const change = mine?.session.latestChange();
        response.statusCode = 200;
        response.end(
          JSON.stringify({
            running: Boolean(mine?.running),
            did:
              change && !change.undone && !mine?.running
                ? { changeId: change.changeId, summary: change.summary }
                : null,
          }),
        );
        return true;
      }
      if (action === 'stop') {
        mine?.running?.abort();
        mine?.pending?.decide(false);
        response.statusCode = 204;
        response.end();
        return true;
      }
      if (action !== 'ask') {
        response.statusCode = 404;
        response.end();
        return true;
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 4_000) {
        response.statusCode = 400;
        response.end();
        return true;
      }
      const conversation = mine ?? open(request, principalId);
      if (conversation.running) {
        response.statusCode = 409;
        response.end();
        return true;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      const emit = (event: Record<string, unknown>) => {
        if (!response.writableEnded)
          response.write(`${JSON.stringify(event)}\n`);
      };
      conversation.emit = emit;
      const controller = new AbortController();
      conversation.running = controller;
      // Closing the panel's request is a Stop.
      response.on('close', () => {
        if (!response.writableFinished) {
          controller.abort();
          conversation.pending?.decide(false);
        }
      });
      emit({ type: 'conversation', id: conversation.id, capUsd });
      const before = conversation.session.latestChange()?.changeId ?? null;
      try {
        await runTurn(conversation, text, screenOf(body.screen), controller);
      } catch (error) {
        // An error is an exit path too: what was written is still checked
        // and still offered for Undo.
        await conversation.session.verifyPending().catch(() => []);
        emit({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'the assistant failed',
          ...didThisTurn(conversation.session.latestChange(), before),
        });
      } finally {
        conversation.running = null;
        conversation.pending = null;
        response.end();
      }
      return true;
    },
  };

  async function runTurn(
    conversation: Conversation,
    text: string,
    screen: { surfaceId: string; recordId: string | null } | null,
    controller: AbortController,
  ): Promise<void> {
    const emit = conversation.emit;
    if (conversation.meter.exhausted()) {
      emit({
        type: 'answer',
        text: `This conversation has used its spending limit of USD ${capUsd.toFixed(2)}. Start a new conversation to keep going.`,
        stop: 'spend-cap',
        links: [],
        usd: 0,
        spentUsd: conversation.meter.usd,
      });
      return;
    }
    const model = await options.model();
    if ('unavailable' in model) {
      emit({
        type: 'answer',
        text: model.unavailable,
        stop: 'unavailable',
        links: [],
        usd: 0,
        spentUsd: conversation.meter.usd,
      });
      return;
    }
    const changeBefore = conversation.session.latestChange()?.changeId ?? null;
    emit({ type: 'step', label: 'Reading the screen' });
    const preamble = await agentPreamble(conversation.session, screen);
    const run = await runOperationsAgent({
      model,
      session: conversation.session,
      request: text,
      meter: conversation.meter,
      preamble,
      history: conversation.history,
      signal: controller.signal,
      onEvent: (event) => {
        const label = stepLabel(event);
        if (label) emit({ type: 'step', label });
        if (event.kind === 'delta') emit({ type: 'delta', text: event.text });
        if (event.kind === 'text') emit({ type: 'text', text: event.text });
      },
    });
    conversation.history = run.conversation;
    // Whatever cut the model off (Stop, a handoff, a cap), the host reads
    // back every write of this turn that the model did not verify.
    const checked = await conversation.session.verifyPending();
    const unverified = checked.filter((entry) => !entry.verified).length;
    const handoff =
      run.stop === 'answered' ? CUSTOMIZE_HANDOFF.exec(run.answer) : null;
    if (handoff) {
      emit({ type: 'step', label: 'Drafting the change' });
      emit({
        type: 'answer',
        ...(await handOff(text)),
        stop: 'handoff',
        links: await links(conversation, run.answer),
        ...didThisTurn(conversation.session.latestChange(), changeBefore),
        usd: run.usd,
        spentUsd: conversation.meter.usd,
      });
      return;
    }
    emit({
      type: 'answer',
      text:
        run.stop === 'spend-cap'
          ? `This conversation reached its spending limit of USD ${capUsd.toFixed(2)}, so I stopped. Start a new conversation to keep going.`
          : run.stop === 'stopped'
            ? `Stopped. Nothing more will run; anything already done stays done${checked.length > 0 ? ` and was checked${unverified > 0 ? ` (${String(unverified)} check(s) did not confirm it; look at the records)` : ''}` : ''}.`
            : run.answer || '(no answer)',
      stop: run.stop,
      links: await links(conversation, run.answer),
      ...didThisTurn(conversation.session.latestChange(), changeBefore),
      usd: run.usd,
      spentUsd: conversation.meter.usd,
    });
  }

  /** The person's own words go to the customization lane's AI draft. */
  async function handOff(
    request: string,
  ): Promise<{ text: string; draft?: { diff: string } }> {
    if (!options.customize)
      return {
        text: 'That is a change to the application, not to your records. Make it on the Customize screen.',
      };
    try {
      const drafted = await (
        await options.customize()
      ).draftFromRequest(request);
      if (drafted.status === 'drafted' && 'renderedDiff' in drafted)
        return {
          text: `That is a change to the application. I drafted it${drafted.reused ? ' (the same draft already existed)' : ''}; nothing is live yet. Read the change below, then approve and activate it on the Customize screen.`,
          draft: { diff: drafted.renderedDiff },
        };
      return {
        text: `That is a change to the application, and it could not be drafted: ${'message' in drafted ? drafted.message : drafted.status}. Nothing was changed.`,
      };
    } catch (error) {
      return {
        text: `That is a change to the application, and drafting it failed: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
      };
    }
  }

  function askThePerson(
    conversation: Conversation,
    plan: PlanForApproval,
  ): Promise<boolean> {
    const digest = planDigest(plan);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => decide(false), DECISION_TIMEOUT_MS);
      const decide = (approved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (conversation.pending?.planId === plan.planId)
          conversation.pending = null;
        conversation.emit({
          type: 'decided',
          planId: plan.planId,
          approved,
        });
        resolve(approved);
      };
      if (conversation.running?.signal.aborted) {
        decide(false);
        return;
      }
      conversation.pending = { planId: plan.planId, digest, decide };
      conversation.emit({
        type: 'plan',
        planId: plan.planId,
        digest,
        reasons: plan.reasons ?? [],
        // Exactly what the yes covers: the operation, the record it acts on
        // (as the host read it), and every bound input, arguments included.
        steps: plan.steps.map((step) => ({
          text: `${step.operationLabel}: ${step.effect}`,
          target: step.targetLabel
            ? `${step.targetLabel} (${step.target})`
            : step.target,
          inputs: plainInputs(step.inputs),
        })),
      });
    });
  }

  /** Records read or written, as links: written ones and those the answer names. */
  async function links(
    conversation: Conversation,
    answer: string,
  ): Promise<{ href: string; label: string; wrote: boolean }[]> {
    const touched = conversation.session
      .touchedRecords()
      .filter(
        (record) =>
          record.wrote ||
          (record.label !== null && answer.includes(record.label)),
      )
      .slice(-8);
    if (touched.length === 0) return [];
    const surfaces = await options.runtime.entry
      .run({ headers: { cookie: conversation.cookie } }, (view) =>
        Promise.resolve(detailSurfaces(view.projections)),
      )
      .catch(() => new Map<string, string>());
    return touched.flatMap((record) => {
      const surface = surfaces.get(record.entityId);
      if (!surface) return [];
      const href = `/?surface=${encodeURIComponent(surface)}&record=${encodeURIComponent(record.recordId)}`;
      return [
        {
          href,
          label: record.label ?? local(record.entityId).replaceAll('_', ' '),
          wrote: record.wrote,
        },
      ];
    });
  }
}

/** "Did: ..." with Undo, when this turn made a change at once. */
function didThisTurn(
  change: { changeId: string; summary: string; undone: boolean } | null,
  before: string | null,
): { did?: { changeId: string; summary: string } } {
  return change && change.changeId !== before && !change.undone
    ? { did: { changeId: change.changeId, summary: change.summary } }
    : {};
}

/** The record page of each record type: its `<type>_detail` surface. */
function detailSurfaces(projections: {
  surface: { payload: unknown };
  query: { payload: unknown };
}): Map<string, string> {
  const queries = new Map(
    (
      (
        projections.query.payload as {
          queries?: readonly { queryId: string; sourceEntityId: string }[];
        }
      ).queries ?? []
    ).map((query) => [query.queryId, query.sourceEntityId]),
  );
  const out = new Map<string, string>();
  for (const surface of (
    projections.surface.payload as {
      surfaces?: readonly {
        surfaceId: string;
        archetype: string;
        dataSourceQueryId?: string;
      }[];
    }
  ).surfaces ?? []) {
    const entity = surface.dataSourceQueryId
      ? queries.get(surface.dataSourceQueryId)
      : undefined;
    if (
      entity &&
      surface.archetype === 'record' &&
      local(surface.surfaceId) === `${local(entity)}_detail`
    )
      out.set(entity, surface.surfaceId);
  }
  return out;
}

/** What the panel shows while a run works: one short plain label. */
export function stepLabel(event: AgentEvent): string | null {
  if (event.kind === 'thinking') return 'Thinking';
  if (event.kind !== 'tool') return null;
  const input = (event.input ?? {}) as Record<string, unknown>;
  switch (event.name) {
    case 'erp_discover':
      return input.mode === 'resolve' && typeof input.search === 'string'
        ? `Looking up "${input.search.slice(0, 40)}"`
        : 'Checking what the system can do';
    case 'erp_query':
      return typeof input.queryId === 'string'
        ? `Reading ${local(input.queryId).replaceAll('_', ' ')}`
        : 'Reading records';
    case 'erp_plan':
      return 'Preparing the change';
    case 'erp_execute':
      return 'Making the change';
    case 'erp_verify':
      return 'Checking the result';
    default:
      return null;
  }
}

function plainInputs(inputs: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const bag of ['values', 'patch', 'relations', 'arguments'] as const) {
    const values = inputs[bag];
    if (values === undefined || values === null) continue;
    if (typeof values !== 'object' || Array.isArray(values)) {
      parts.push(`${bag}: ${shownValue(values)}`);
      continue;
    }
    for (const [id, value] of Object.entries(values as object)) {
      if (value === null || value === undefined) continue;
      parts.push(`${local(id).replaceAll('_', ' ')}: ${shownValue(value)}`);
    }
  }
  return parts.join(' · ');
}

/**
 * A bound value as the person reads it. Only a declared identifier (an id
 * with a namespace, `northstar.app:option.net_30`) is shortened; a number,
 * a date or free text is shown exactly as bound (10.25 stays 10.25).
 */
function shownValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    if (!Array.isArray(value) && 'fromStep' in value)
      return `the record step ${String((value as { fromStep: number }).fromStep)} makes`;
    return JSON.stringify(value);
  }
  const text = String(value);
  return /^[a-z][\w.-]*:[a-z_]+\.[\w-]+$/u.test(text)
    ? local(text).replaceAll('_', ' ')
    : text;
}

function planDigest(plan: PlanForApproval): string {
  return createHash('sha256')
    .update(JSON.stringify({ planId: plan.planId, steps: plan.steps }))
    .digest('hex');
}

function screenOf(
  value: unknown,
): { surfaceId: string; recordId: string | null } | null {
  if (typeof value !== 'object' || value === null) return null;
  const screen = value as { surfaceId?: unknown; recordId?: unknown };
  if (typeof screen.surfaceId !== 'string' || screen.surfaceId.length > 200)
    return null;
  return {
    surfaceId: screen.surfaceId,
    recordId:
      typeof screen.recordId === 'string' && screen.recordId.length <= 64
        ? screen.recordId
        : null,
  };
}

function local(id: string): string {
  const afterColon = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const dot = afterColon.indexOf('.');
  return dot >= 0 ? afterColon.slice(dot + 1) : afterColon;
}

function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers['x-northstar-assistant'] !== '1') return false;
  const site = request.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  if (site !== undefined) return false;
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (
    !String(request.headers['content-type'] ?? '').startsWith(
      'application/json',
    )
  )
    return {};
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    bytes += buffer.byteLength;
    if (bytes > 32 * 1024) return {};
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    ) as unknown;
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
