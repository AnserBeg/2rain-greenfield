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

/**
 * Conversations live in this process only, so they are bounded (end review
 * X13): one idle this long is dropped, a person holds at most this many,
 * and the process at most this many. A working one is never dropped.
 */
export const ASSISTANT_CONVERSATION_LIMITS = Object.freeze({
  idleMs: 30 * 60 * 1000,
  perPrincipal: 5,
  total: 200,
});

export interface AssistantEndpointOptions {
  readonly runtime: Pick<
    ComposedApplicationRuntime,
    'entry' | 'operationGateway' | 'operationMediation' | 'queryGateway'
  >;
  /**
   * The company the person's page works in, proved through their workspace
   * entry (end review X9); null when the page settles on none.
   */
  readonly company: (page: {
    readonly cookie: string;
    readonly surfaceId: string | null;
    readonly search: string;
  }) => Promise<{ readonly companyId: string; readonly label: string } | null>;
  readonly businessCalendar?: BusinessCalendar;
  /** The model, or a sentence saying why there is none. */
  readonly model: () => Promise<ModelAdapter | { unavailable: string }>;
  readonly prices?: ModelPrices;
  readonly capUsd?: number;
  /**
   * The `Host` values this server answers to (its loopback host and port);
   * absent, the Host is not checked (unit tests).
   */
  readonly authorities?: () => readonly string[] | null;
  /**
   * The customization lane (CUSTOMIZE's service): a change to the
   * application is handed to its AI draft, shown as a plain diff, and never
   * approved or activated from here (plan §9.1). Absent, the panel says where
   * to make the change.
   */
  readonly customize?: () => Promise<CustomizeDrafter>;
  /** Source of session plan and record IDs. Production uses random UUIDs. */
  readonly mintId?: () => string;
  /** The clock conversations idle by; a test moves it. */
  readonly now?: () => number;
}

/** The one call the panel makes into the customization lane. */
export interface CustomizeDrafter {
  /**
   * `budget` is the asking conversation's meter and Stop: the draft's model
   * calls are charged to the same cap and end on the same Stop (X13).
   */
  draftFromRequest(
    request: string,
    budget?: { readonly meter: SpendMeter; readonly signal?: AbortSignal },
    cookie?: string,
  ): Promise<
    | { status: 'drafted'; renderedDiff: string; reused: boolean }
    | { status: string; message: string; missingCapability?: string }
  >;
}

type PanelEvent = Record<string, unknown>;

interface PendingPlan {
  readonly card: PanelEvent;
  readonly planId: string;
  readonly digest: string;
  readonly decide: (approved: boolean) => void;
}

interface Conversation {
  readonly id: string;
  readonly principalId: string;
  /** The company it works in, bound when it opened; another is another conversation. */
  readonly company: { readonly companyId: string; readonly label: string };
  readonly cookie: string;
  readonly session: OperationsAgentSession;
  readonly meter: SpendMeter;
  history: readonly ConversationEntry[];
  /** Events visible to the person. Model prompts, tool results and deltas stay out. */
  readonly transcript: PanelEvent[];
  step: string;
  /** When the person last used it, on the endpoint's clock. */
  lastUsed: number;
  recentStart: number;
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
  const now = options.now ?? Date.now;
  const limits = ASSISTANT_CONVERSATION_LIMITS;
  const working = (conversation: Conversation) =>
    conversation.running !== null || conversation.pending !== null;

  /** Drops idle conversations; nothing working is ever dropped. */
  const sweep = () => {
    const cutoff = now() - limits.idleMs;
    for (const [id, conversation] of conversations)
      if (!working(conversation) && conversation.lastUsed < cutoff)
        conversations.delete(id);
  };

  /**
   * Room for one more conversation of this person: their oldest idle one is
   * dropped at their bound, the process's oldest idle one at its bound.
   * False when everything over a bound is working.
   */
  const makeRoom = (principalId: string): boolean => {
    const oldestIdle = (of: (c: Conversation) => boolean) =>
      [...conversations.values()]
        .filter((c) => of(c) && !working(c))
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    const count = (of: (c: Conversation) => boolean) =>
      [...conversations.values()].filter(of).length;
    const theirs = (c: Conversation) => c.principalId === principalId;
    while (count(theirs) >= limits.perPrincipal) {
      const victim = oldestIdle(theirs);
      if (!victim) return false;
      conversations.delete(victim.id);
    }
    while (conversations.size >= limits.total) {
      const victim = oldestIdle(() => true);
      if (!victim) return false;
      conversations.delete(victim.id);
    }
    return true;
  };

  const principalOf = (request: IncomingMessage) =>
    options.runtime.entry.run({ headers: request.headers }, (view) =>
      Promise.resolve(view.principalId),
    );

  const open = (
    request: IncomingMessage,
    principalId: string,
    company: Conversation['company'],
    startId: unknown,
  ) => {
    const conversation: Conversation = {
      id:
        typeof startId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          startId,
        ) &&
        !conversations.has(startId)
          ? startId
          : randomUUID(),
      principalId,
      company,
      cookie: String(request.headers.cookie ?? ''),
      meter: new SpendMeter(prices, capUsd),
      history: [],
      transcript: [],
      step: 'Starting',
      lastUsed: now(),
      recentStart: 0,
      running: null,
      pending: null,
      emit: () => undefined,
      session: new OperationsAgentSession({
        runtime: options.runtime,
        personHeaders: { cookie: String(request.headers.cookie ?? '') },
        companyId: company.companyId,
        ...(options.businessCalendar
          ? { businessCalendar: options.businessCalendar }
          : {}),
        ...(options.mintId ? { mintId: options.mintId } : {}),
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
      if (
        request.method !== 'POST' ||
        !sameOrigin(request, options.authorities?.() ?? null)
      ) {
        response.statusCode = 403;
        response.end();
        return true;
      }
      sweep();
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
      if (mine) mine.lastUsed = now();
      if (action === 'decide') {
        const pending = mine?.pending;
        const bound =
          pending &&
          body.planId === pending.planId &&
          body.digest === pending.digest;
        if (bound) {
          if (body.approve === true && typeof body.typed === 'string')
            mine.emit({
              type: 'confirmation',
              text: body.typed.slice(0, 4_000),
            });
          pending.decide(body.approve === true);
        }
        response.statusCode = bound ? 204 : 409;
        response.end();
        return true;
      }
      const screen = screenOf(body.screen);
      // The page's company, proved for this person now (X9). A conversation
      // stays in the company it opened in: a page in another company starts
      // a new one.
      const pageCompany = () => {
        if (
          body.page !== undefined &&
          (typeof body.page !== 'string' || body.page.length > 2000)
        )
          return Promise.resolve(null);
        const search = typeof body.page === 'string' ? body.page : '';
        const selected = new URLSearchParams(search).getAll('surface');
        if (
          selected.length > 1 ||
          (selected[0] && screen && screen.surfaceId !== selected[0])
        )
          return Promise.resolve(null);
        return options
          .company({
            cookie: String(request.headers.cookie ?? ''),
            surfaceId: selected[0] ?? screen?.surfaceId ?? null,
            search,
          })
          .catch(() => null);
      };
      if (['undo', 'latest', 'history'].includes(action) && mine) {
        const page = typeof body.page === 'string' ? await pageCompany() : null;
        if (
          !page ||
          page.companyId !== mine.company.companyId ||
          conversations.get(mine.id) !== mine
        ) {
          response.statusCode = 409;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              outcome: 'refused',
              text: 'This conversation belongs to another company.',
            }),
          );
          return true;
        }
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
        mine.step = 'Undoing change';
        mine.running = new AbortController();
        const undone = await mine.session
          .undo(body.changeId, mine.running.signal)
          .finally(() => {
            mine.running = null;
          });
        const result =
          undone.outcome === 'undone'
            ? {
                outcome: 'undone',
                text: `${undone.summary}${undone.verified ? ' (checked)' : ' (the check did not confirm it; look at the record)'}`,
              }
            : { outcome: 'refused', text: `Not undone: ${undone.reason}` };
        mine.transcript.push({
          type: 'undo',
          changeId: body.changeId,
          ...result,
        });
        response.statusCode = 200;
        response.end(JSON.stringify(result));
        return true;
      }
      if (action === 'history') {
        response.setHeader('cache-control', 'no-store');
        if (!mine) {
          response.statusCode = 204;
          response.end();
          return true;
        }
        const change = mine.session.latestChange();
        const after =
          typeof body.after === 'number' &&
          Number.isSafeInteger(body.after) &&
          body.after >= 0
            ? body.after
            : 0;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(
          JSON.stringify({
            transcript: mine.transcript.slice(after),
            pending: mine.pending?.card ?? null,
            did: change?.undoable ? change : null,
            running: Boolean(mine.running),
            step: mine.running ? mine.step : null,
          }),
        );
        return true;
      }
      if (action === 'latest') {
        // The conversation's current undoable change, for a panel that
        // reopened after a navigation or a Stop.
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(
          JSON.stringify({
            running: Boolean(mine?.running),
            ...(mine && !mine.running
              ? await didSince(mine, mine.recentStart)
              : {}),
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
      const company = await pageCompany();
      if (!company) {
        response.statusCode = 200;
        response.setHeader(
          'content-type',
          'application/x-ndjson; charset=utf-8',
        );
        response.end(
          `${JSON.stringify({
            type: 'answer',
            text: 'I cannot tell which company this page is in. Open a page of the company you want me to work in, then ask again.',
            stop: 'no-company',
            links: [],
            usd: 0,
            spentUsd: mine?.meter.usd ?? 0,
          })}\n`,
        );
        return true;
      }
      const same =
        mine &&
        conversations.get(mine.id) === mine &&
        mine.company.companyId === company.companyId
          ? mine
          : undefined;
      if (!same && !makeRoom(principalId)) {
        response.statusCode = 429;
        response.end();
        return true;
      }
      const conversation =
        same ?? open(request, principalId, company, body.startId);
      if (conversation.running) {
        response.statusCode = 409;
        response.end();
        return true;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      conversation.transcript.push({ type: 'said', text });
      conversation.step = 'Starting';
      const emit = (event: PanelEvent) => {
        if (event.type === 'step') conversation.step = String(event.label);
        if (
          ['answer', 'error', 'plan', 'decided', 'confirmation'].includes(
            String(event.type),
          )
        )
          conversation.transcript.push(event);
        if (!response.destroyed && !response.writableEnded)
          response.write(`${JSON.stringify(event)}\n`);
      };
      conversation.emit = emit;
      const controller = new AbortController();
      conversation.running = controller;
      emit({
        type: 'conversation',
        id: conversation.id,
        capUsd,
        company: conversation.company.label,
      });
      const before = conversation.session.changes().length;
      try {
        await runTurn(conversation, text, screen, controller);
        conversation.lastUsed = now();
      } catch (error) {
        // An error is an exit path too: what was written is still checked
        // and still offered for Undo.
        await conversation.session.verifyPending().catch(() => []);
        emit({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'the assistant failed',
          ...(await didSince(conversation, before)),
        });
      } finally {
        conversation.emit = () => undefined;
        if (conversation.session.changes().length > before)
          conversation.recentStart = before;
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
    const changeBefore = conversation.session.changes().length;
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
    const answerLinks = await links(conversation, run.answer);
    // The typed handoff only (X11); the drafter gets the person's own words.
    if (run.handoff) {
      emit({ type: 'step', label: 'Drafting the change' });
      const beforeDraft = conversation.meter.usd;
      const drafted = await handOff(conversation, text, controller.signal);
      emit({
        type: 'answer',
        ...drafted,
        stop: 'handoff',
        links: answerLinks,
        ...(await didSince(conversation, changeBefore)),
        // The draft's own model calls count toward this turn and the cap.
        usd: run.usd + (conversation.meter.usd - beforeDraft),
        spentUsd: conversation.meter.usd,
      });
      return;
    }
    emit({
      type: 'answer',
      text:
        run.stop === 'spend-cap'
          ? `This request exceeds the conversation’s remaining budget. Try a shorter request or start a new conversation.`
          : run.stop === 'stopped'
            ? `Stopped. Nothing more will run; anything already done stays done${checked.length > 0 ? ` and was checked${unverified > 0 ? ` (${String(unverified)} check(s) did not confirm it; look at the records)` : ''}` : ''}.`
            : run.answer || '(no answer)',
      stop: run.stop,
      links: answerLinks,
      ...(await didSince(conversation, changeBefore)),
      usd: run.usd,
      spentUsd: conversation.meter.usd,
    });
  }

  /**
   * The person's own words go to the customization lane's AI draft, charged
   * to this conversation's cap and ended by its Stop (X13).
   */
  async function handOff(
    conversation: Conversation,
    request: string,
    signal: AbortSignal,
  ): Promise<{ text: string; draft?: { diff: string } }> {
    if (!options.customize)
      return {
        text: 'That is a change to the application, not to your records. Make it on the Customize screen.',
      };
    if (conversation.meter.exhausted())
      return {
        text: `That is a change to the application, and this conversation has used its spending limit of USD ${capUsd.toFixed(2)}, so it was not drafted. Make it on the Customize screen.`,
      };
    try {
      const drafted = await (
        await options.customize()
      ).draftFromRequest(
        request,
        { meter: conversation.meter, signal },
        conversation.cookie,
      );
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
    const digest = planDigest(plan, conversation.company.companyId);
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
      const card = {
        type: 'plan',
        planId: plan.planId,
        digest,
        // The company the yes acts in, by name (X9).
        company: conversation.company.label,
        reasons: plan.reasons ?? [],
        // Exactly what the yes covers: the operation, the record it acts on
        // (as the host read it), and every bound input, arguments included.
        steps: plan.steps.map((step) => ({
          text: step.operationLabel
            ? `${step.operationLabel}: ${step.effect}`
            : `${step.effect.charAt(0).toUpperCase()}${step.effect.slice(1)}`,
          target: step.targetLabel
            ? `${step.targetLabel} (${step.target})`
            : step.target,
          inputs: inputRows(step.inputs, step.fieldKinds ?? {}),
        })),
      };
      conversation.pending = { planId: plan.planId, digest, card, decide };
      conversation.emit(card);
    });
  }

  async function didSince(conversation: Conversation, start: number) {
    const receipts = conversation.session.changes().slice(start);
    if (!receipts.length) return { changes: [], did: null };
    const surfaces = await conversationSurfaces(conversation);
    const changes = receipts.map((change) => {
      const surface = surfaces.get(change.entity);
      return {
        ...change,
        ...(surface
          ? {
              href: recordHref(
                surface,
                change.recordId,
                conversation.company.companyId,
              ),
            }
          : {}),
      };
    });
    return { changes, did: changes.at(-1) };
  }
  function conversationSurfaces(conversation: Conversation) {
    return options.runtime.entry
      .run({ headers: { cookie: conversation.cookie } }, (view) =>
        Promise.resolve(detailSurfaces(view.projections)),
      )
      .catch(() => new Map<string, DetailSurface>());
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
    const surfaces = await conversationSurfaces(conversation);
    return touched.flatMap((record) => {
      const surface = surfaces.get(record.entityId);
      if (!surface) return [];
      // A company-owned record's page names the conversation's company.
      const href = recordHref(
        surface,
        record.recordId,
        conversation.company.companyId,
      );
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

function recordHref(
  surface: DetailSurface,
  recordId: string,
  company: string,
): string {
  const params = new URLSearchParams({
    surface: surface.surfaceId,
    record: recordId,
  });
  if (surface.companyParameter) params.set(surface.companyParameter, company);
  return '/?' + params.toString();
}
interface DetailSurface {
  readonly surfaceId: string;
  /** Its query's company parameter, when the record is company-owned. */
  readonly companyParameter: string | null;
}

/** The record page of each record type: its `<type>_detail` surface. */
function detailSurfaces(projections: {
  surface: { payload: unknown };
  query: { payload: unknown };
}): Map<string, DetailSurface> {
  const queries = new Map(
    (
      (
        projections.query.payload as {
          queries?: readonly {
            queryId: string;
            sourceEntityId: string;
            legalEntityScope?: { operand?: { parameterId?: string } } | null;
          }[];
        }
      ).queries ?? []
    ).map((query) => [query.queryId, query]),
  );
  const out = new Map<string, DetailSurface>();
  for (const surface of (
    projections.surface.payload as {
      surfaces?: readonly {
        surfaceId: string;
        archetype: string;
        dataSourceQueryId?: string;
      }[];
    }
  ).surfaces ?? []) {
    const query = surface.dataSourceQueryId
      ? queries.get(surface.dataSourceQueryId)
      : undefined;
    const entity = query?.sourceEntityId;
    if (
      entity &&
      surface.archetype === 'record' &&
      local(surface.surfaceId) === `${local(entity)}_detail`
    )
      out.set(entity, {
        surfaceId: surface.surfaceId,
        companyParameter: query.legalEntityScope?.operand?.parameterId ?? null,
      });
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

function inputRows(
  inputs: Readonly<Record<string, unknown>>,
  fieldKinds: Readonly<Record<string, string>>,
): { field: string; type: string; value: string }[] {
  return ['values', 'patch', 'relations', 'arguments'].flatMap((bag) => {
    const values = inputs[bag];
    if (!values || typeof values !== 'object' || Array.isArray(values))
      return [];
    return Object.entries(values).map(([id, value]) => {
      const field = local(id)
        .replaceAll('_', ' ')
        .replace(/([a-z])([A-Z])/gu, '$1 $2')
        .toLowerCase();
      if (value === null) return { field, type: 'clear', value: 'clears' };
      if (typeof value === 'object' && 'fromStep' in value)
        return {
          field,
          type: 'record',
          value: `the record step ${String(value.fromStep)} makes`,
        };
      const kind = fieldKinds[id];
      if (kind === 'enumFieldType')
        return {
          field,
          type: 'choice',
          value: local(String(value)).replaceAll('_', ' '),
        };
      if (kind === 'reference' || bag === 'relations')
        return { field, type: 'record', value: String(value) };
      if (
        [
          'moneyFieldType',
          'quantityFieldType',
          'exactDecimalFieldType',
          'integerFieldType',
        ].includes(kind ?? '')
      )
        return {
          field,
          type: kind === 'integerFieldType' ? 'integer' : 'decimal',
          value: String(value),
        };
      const type = kind
        ? kind.replace(/FieldType$/u, '')
        : typeof value === 'string'
          ? 'text'
          : typeof value;
      return {
        field,
        type,
        value: JSON.stringify(value).replace(
          /[\p{Cf}\p{Zl}\p{Zp}]/gu,
          (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`,
        ),
      };
    });
  });
}

function planDigest(plan: PlanForApproval, companyId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ companyId, planId: plan.planId, steps: plan.steps }),
    )
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

function sameOrigin(
  request: IncomingMessage,
  authorities: readonly string[] | null,
): boolean {
  if (request.headers['x-northstar-assistant'] !== '1') return false;
  // End review X10: the request must name this server's own loopback
  // authority before any fetch metadata or Origin is trusted; a rebound
  // hostname carries "same-origin" for itself, not for us.
  if (
    authorities !== null &&
    !authorities.includes(String(request.headers.host ?? '').toLowerCase())
  )
    return false;
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

/** The Host header values a loopback server at `host:port` is reached by. */
export function loopbackAuthorities(host: string, port: number): string[] {
  const names = new Set([
    host.toLowerCase(),
    '127.0.0.1',
    'localhost',
    '[::1]',
  ]);
  if (host === '::1') names.add('[::1]');
  return [...names]
    .filter((name) => name !== '::1')
    .flatMap((name) =>
      port === 80 ? [name, `${name}:80`] : [`${name}:${String(port)}`],
    );
}
