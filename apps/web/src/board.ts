import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { BoardBody, SurfaceBoard } from '@north-star/canonical-model';
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '@north-star/runtime/request-runtime-view';
import { evaluateRegisteredOperationPrecondition } from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  declaredViewFilters,
  readDeclaredListState,
} from './list-declaration.js';
import { escapeHtml as h } from './html.js';
import type {
  CompiledSurfaceDefinition,
  CompiledSurfaceDataBinding,
  CompiledSurfaceOperationBinding,
} from './surface-contract.js';
import type {
  SurfaceRuntimeGateways,
  SurfaceRuntimeSubmission,
} from './surface-runtime.js';

const key = randomBytes(32);
function seal(binding: string, values: readonly (string | number)[]) {
  const data = Buffer.from(JSON.stringify(values)).toString('base64url');
  return (
    data +
    '.' +
    createHmac('sha256', key)
      .update(binding)
      .update('\0')
      .update(data)
      .digest('base64url')
  );
}
function unseal(binding: string, token: string) {
  const [data, signature, extra] = token.split('.');
  if (!data || !signature || extra || token.length > 4096) return null;
  const expected = createHmac('sha256', key)
    .update(binding)
    .update('\0')
    .update(data)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  const values: unknown = JSON.parse(
    Buffer.from(data, 'base64url').toString('utf8'),
  );
  return Array.isArray(values) ? (values as unknown[]) : null;
}
const hidden = (name: string, value: string | number) =>
  `<input type="hidden" name="${h(name)}" value="${h(String(value))}">`;
const link = (url: URL, changes: Record<string, string | null>) => {
  const params = new URLSearchParams(url.search);
  for (const [name, value] of Object.entries(changes))
    value === null ? params.delete(name) : params.set(name, value);
  return '/?' + params.toString();
};
type Move = BoardBody['moves'][number];
interface BoardContext {
  view: RequestRuntimeView;
  surface: CompiledSurfaceDefinition;
  board: SurfaceBoard;
  owner: CompiledSurfaceDefinition;
  binding: CompiledSurfaceDataBinding;
  url: URL;
  scope: Readonly<Record<string, ImmutableJsonValue>>;
  company: string | null;
  gateways: SurfaceRuntimeGateways;
}
export function boardContext(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  binding: CompiledSurfaceDataBinding,
  url: URL,
  scope: BoardContext['scope'],
  gateways: SurfaceRuntimeGateways,
): BoardContext {
  const board = surface.board!;
  const owner = surfaces.find(
    (s) => s.surfaceId === board.body.listSurfaceId && s.lifecycle === 'active',
  );
  if (!owner?.list) throw new Error('The Board collection is unavailable.');
  const company = binding.query.legalEntityScope
    ? url.searchParams.get(binding.query.legalEntityScope.operand.parameterId)
    : null;
  return {
    view,
    surface,
    owner,
    board,
    binding,
    url,
    scope,
    company,
    gateways,
  };
}
function viewFilters(c: BoardContext) {
  const list = c.owner.list!;
  const state = readDeclaredListState(list, c.url);
  const selected = list.views.find(
    (v) => v.viewId === c.url.searchParams.get('view'),
  );
  // A progress/figure predicate needs the List's projections. It cannot be
  // represented as a stored-field filter on a Board.
  if (selected && !compatible(selected))
    throw new Error('This saved view needs the List.');
  return [...declaredViewFilters(list, state, selected)];
}
function compatible(
  v: NonNullable<CompiledSurfaceDefinition['list']>['views'][number],
) {
  return !v.open && !v.supply && !v.before && !v.band;
}
function bindingKey(c: BoardContext, purpose: string) {
  return JSON.stringify([
    purpose,
    c.view.principalId,
    c.view.tenantId,
    c.view.environmentId,
    c.view.release.contentHash,
    c.view.pointer.fence,
    c.company,
    c.surface.surfaceId,
    c.board.revisionId,
    viewFilters(c),
  ]);
}
async function readRows(
  c: BoardContext,
  stages: string[],
  position: { after?: string; recordId?: string } = {},
) {
  if (c.company === null && c.binding.query.legalEntityScope)
    throw new Error('Choose a company.');
  if (
    c.owner.dataSourceQueryId !== c.board.body.listQueryId &&
    (await c.gateways.queryGateway.previewEligibility(
      c.view,
      c.owner.dataSourceQueryId,
      c.company,
    )) !== 'eligible'
  )
    throw new Error('The collection is unavailable.');
  const result = await c.gateways.queryGateway.invoke(c.view, {
    queryId: c.board.body.listQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    arguments: {
      ...c.scope,
      boardPage: {
        surfaceId: c.surface.surfaceId,
        revisionId: c.board.revisionId,
        stages,
        filters: viewFilters(c),
        ...position,
      },
    },
  });
  if (
    result.outcome !== 'exact' ||
    result.boardCoverage?.revisionId !== c.board.revisionId
  )
    throw new Error('Board coverage is unavailable.');
  return {
    records: result.records,
    partial: result.boardCoverage.scanLimitReached,
  };
}
async function authorizedMoves(c: BoardContext, moves: Move[]) {
  const allowed = await Promise.all(
    moves.map(
      async (m) =>
        (await c.gateways.operationGateway.previewTaskEligibility(
          c.view,
          [m.operationId],
          c.company,
        )) === 'eligible',
    ),
  );
  return moves.filter((_, i) => allowed[i]);
}
function recordMoves(
  c: BoardContext,
  record: SemanticRecordDto,
  moves: Move[],
) {
  return moves.filter((m) => {
    const operation = c.binding.operations.find(
      (o) => o.operationId === m.operationId,
    );
    return (
      operation &&
      operation.intent === 'command' &&
      m.fromStateId === record.values[c.board.body.grouping.stateFieldId] &&
      evaluateRegisteredOperationPrecondition(
        operation.precondition,
        record.values,
      ).outcome === 'holds'
    );
  });
}
export async function boardSlots(c: BoardContext) {
  const { body } = c.board;
  const { url } = c;
  const stages = body.grouping.stages;
  const perStage = Math.min(10, c.binding.query.maximumResultCount - 1);
  const maxStages = Math.min(
    6,
    Math.floor(c.binding.query.maximumResultCount / (perStage + 1)),
  );
  const selected = url.searchParams.get('stage');
  const index = selected ? stages.findIndex((s) => s.stateId === selected) : 0;
  if (index < 0) throw new Error('Unknown Board stage.');
  const visible = stages.slice(
    Math.floor(index / maxStages) * maxStages,
    Math.floor(index / maxStages) * maxStages + maxStages,
  );
  const cursor = url.searchParams.get('cards');
  let after: string | undefined;
  let message = '';
  if (cursor) {
    const anchor = unseal(bindingKey(c, 'page'), cursor);
    if (
      anchor &&
      anchor[0] === selected &&
      selected &&
      typeof anchor[1] === 'string'
    ) {
      const row = (await readRows(c, [selected], { recordId: anchor[1] }))
        .records[0];
      if (row && row.revision === anchor[2]) after = row.recordId;
    }
    if (!after)
      message =
        '<p role="status">This page changed. Showing the first cards.</p>';
  }
  const pageStages =
    after && selected ? visible.filter((s) => s.stateId === selected) : visible;
  const page = await readRows(
    c,
    pageStages.map((s) => s.stateId),
    after ? { after } : {},
  );
  const moves = await authorizedMoves(
    c,
    body.moves.filter((m) =>
      page.records.some(
        (r) => r.values[body.grouping.stateFieldId] === m.fromStateId,
      ),
    ),
  );
  const columns = pageStages
    .map((stage) => {
      const matches = page.records.filter(
        (r) => r.values[body.grouping.stateFieldId] === stage.stateId,
      );
      const cards = matches.slice(0, perStage);
      const next = matches.length > perStage ? cards.at(-1) : null;
      const more = next
        ? `<a href="${h(link(url, { stage: stage.stateId, cards: seal(bindingKey(c, 'page'), [stage.stateId, next.recordId, next.revision]) }))}">More ${h(stage.label)} cards</a>`
        : page.partial
          ? '<p role="status">Narrow the search. This stage is partially loaded.</p>'
          : '';
      return `<section class="board-column" data-selected="${stage.stateId === stages[index]!.stateId}"><h2>${h(stage.label)}</h2>${
        cards.length
          ? `<ul>${cards
              .map((r) => {
                const title = String(r.values[body.titleFieldId] ?? r.recordId);
                const controls = recordMoves(c, r, moves).length
                  ? `<form method="post" action="${h(link(url, {}))}">${hidden('boardAction', 'open')}${hidden('recordId', r.recordId)}${hidden('expectedRevision', r.revision)}${hidden('sourceState', stage.stateId)}<button id="move-${h(r.recordId)}" aria-label="Move card: ${h(title)}">Move card</button></form>`
                  : '';
                const facts = body.facts
                  .filter((f) => r.values[f.fieldId] != null)
                  .map(
                    (f) =>
                      `<div><dt>${h(f.label)}</dt><dd>${h(String(r.displayValues?.[f.fieldId] ?? r.values[f.fieldId]))}</dd></div>`,
                  )
                  .join('');
                return `<li><a href="${h(link(url, { surface: body.recordSurfaceId, record: r.recordId, cards: null, stage: null, view: null }))}">${h(title)}</a><span class="status-chip" data-status-role="${h(stage.role ?? 'neutral')}">● ${h(stage.label)}</span>${facts ? `<dl>${facts}</dl>` : ''}${controls}</li>`;
              })
              .join('')}</ul>`
          : page.partial
            ? ''
            : '<p>No cards</p>'
      }${more}</section>`;
    })
    .join('');
  const tabs = c.owner
    .list!.views.filter(compatible)
    .map(
      (v) =>
        `<a href="${h(link(url, { view: v.viewId, cards: null }))}">${h(v.label)}</a>`,
    )
    .join(' ');
  return {
    title: `<h1 id="board-heading" tabindex="-1">${h(c.surface.label)}</h1>`,
    savedViews: tabs ? `<nav aria-label="Saved views">${tabs}</nav>` : '',
    stageSelector: `<nav aria-label="Select stage">${stages.map((s) => `<a href="${h(link(url, { stage: s.stateId, cards: null }))}"${s.stateId === stages[index]!.stateId ? ' aria-current="true"' : ''}>${h(s.label)}</a>`).join(' ')}</nav>`,
    columns: message + `<div class="board-columns">${columns}</div>`,
  };
}

export type BoardTaskResult =
  | { html: string; statusCode: number }
  | {
      operation: CompiledSurfaceOperationBinding;
      submission: SurfaceRuntimeSubmission;
    };
export async function boardTask(
  c: BoardContext,
  form: SurfaceRuntimeSubmission,
): Promise<BoardTaskResult> {
  const { body } = c.board;
  const back = `<a href="${h(link(c.url, { cards: null }))}#board-heading">Back to Board</a>`;
  const refuse = (message: string, statusCode = 409) => ({
    html: `<section role="alert"><h1>Move card</h1><p>${h(message)}</p>${back}</section>`,
    statusCode,
  });
  const recordId = form.recordId ?? '',
    revision = Number(form.expectedRevision),
    state = form.sourceState ?? '';
  if (
    !body.grouping.stages.some((s) => s.stateId === state) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return refuse('The move is invalid.');
  const frame = bindingKey(c, 'move');
  const key = form.idempotencyKey ?? '';
  const intent = [recordId, revision, state, key];
  const valid = (suffix: string) =>
    JSON.stringify(unseal(frame, form.boardTicket ?? '')) ===
    JSON.stringify([...intent, suffix]);
  const opId = form.operationId ?? '';
  if (form.boardAction === 'confirm' && !valid(opId))
    return refuse('Open the move again.');
  if (form.boardAction === 'choose' && !valid('choose'))
    return refuse('Open the move again.');
  const permissions = await authorizedMoves(
    c,
    body.moves.filter((m) => m.fromStateId === state),
  );
  const current = (
    await readRows(
      c,
      body.grouping.stages.map((s) => s.stateId),
      { recordId },
    )
  ).records[0];
  const currentStage = body.grouping.stages.find(
    (s) => s.stateId === current?.values[body.grouping.stateFieldId],
  );
  const changed = () =>
    refuse(
      currentStage
        ? 'This card changed. Its current stage is ' +
            currentStage.label +
            '. Review the card before moving it again.'
        : 'This card changed or is unavailable. Refresh the Board.',
    );
  if (!current) return changed();
  // A signed confirmation uses exactly the reviewed operation and revision. Let
  // the gateway distinguish a replay of its own receipt from a stale new request.
  if (form.boardAction === 'confirm') {
    const bound = permissions.find((m) => m.operationId === opId);
    const operation = c.binding.operations.find(
      (o) => o.operationId === bound?.operationId,
    );
    if (
      !operation ||
      (operation.confirmation === 'humanRequired' && !form.confirmationGrant)
    )
      return refuse('Review this move before confirming.', 403);
    return { operation, submission: form };
  }
  if (current.revision !== revision || currentStage?.stateId !== state)
    return changed();
  const moves = recordMoves(c, current, permissions);
  const start = body.grouping.stages.find((s) => s.stateId === state)!.label;
  const formStart = (action: string, reqKey: string, token: string) =>
    `<form method="post" action="${h(link(c.url, {}))}">${hidden('boardAction', action)}${hidden('recordId', recordId)}${hidden('expectedRevision', revision)}${hidden('sourceState', state)}${hidden('idempotencyKey', reqKey)}${hidden('boardTicket', token)}`;
  const title = h(String(current.values[body.titleFieldId] ?? recordId));
  const task = (html: string) => ({
    html: `<section class="composition-task-context" data-board-task><h1>Move card</h1><p>${title} · ${h(start)}</p>${html}${back}</section>`,
    statusCode: 200,
  });
  if (form.boardAction === 'open') {
    if (!moves.length)
      return refuse('No move is available for this card.', 403);
    const nonce = randomUUID();
    return task(
      formStart(
        'choose',
        nonce,
        seal(frame, [recordId, revision, state, nonce, 'choose']),
      ) +
        `<label>Destination and action <select name="operationId">${moves.map((m) => `<option value="${h(m.operationId)}">${h(body.grouping.stages.find((s) => s.stateId === m.toStateId)!.label)} · ${h(m.label)}</option>`).join('')}</select></label><button>Review move</button></form>`,
    );
  }
  const move = moves.find((m) => m.operationId === opId);
  const operation = c.binding.operations.find(
    (o) => o.operationId === move?.operationId,
  );
  if (!move || !operation) return refuse('This move is unavailable.', 403);
  if (form.boardAction === 'choose') {
    const grant =
      operation.confirmation === 'humanRequired'
        ? c.gateways.operationMediation.issueConfirmationGrant(
            c.view,
            operation.operationId,
            { recordId, expectedRevision: revision },
          )
        : null;
    return task(
      `<p>${h(move.label)} moves ${title} from ${h(start)} to ${h(body.grouping.stages.find((s) => s.stateId === move.toStateId)!.label)}.</p>` +
        formStart('confirm', key, seal(frame, [...intent, opId])) +
        hidden('operationId', opId) +
        (grant ? hidden('confirmationGrant', grant) : '') +
        `<button>Confirm ${h(move.label)}</button></form>`,
    );
  }
  return refuse('Review this move before confirming.');
}

export async function changedBoardCard(
  c: BoardContext,
  form: SurfaceRuntimeSubmission,
) {
  const { body } = c.board;
  const current = (
    await readRows(
      c,
      body.grouping.stages.map((s) => s.stateId),
      { recordId: form.recordId ?? '' },
    )
  ).records[0];
  if (!current || current.revision === Number(form.expectedRevision))
    return null;
  const stage = body.grouping.stages.find(
    (s) => s.stateId === current.values[body.grouping.stateFieldId],
  );
  if (!stage) return null;
  return (
    '<section role="alert"><h1>Move card</h1><p>This card changed. Its current stage is ' +
    h(stage.label) +
    '.</p><a href="' +
    h(link(c.url, { stage: stage.stateId, cards: null })) +
    '#board-heading">Review the card</a></section>'
  );
}
