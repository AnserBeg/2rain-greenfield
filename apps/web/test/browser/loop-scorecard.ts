import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';

import {
  expect,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import pg from 'pg';

import {
  catalogParseCount,
  type CatalogParseCount,
} from '../../../../packages/runtime/src/catalog-parse-count.js';

/**
 * The loop scorecard (LOOP-1): what an office person does, step by step, to
 * walk the purchase order -> inventory -> sales order loop. Every interaction
 * the journey makes goes through this class, so the counts are the journey's
 * own: a click is a pointer press on a control (choosing from a drop-down
 * included), a page load is a full document load in the main frame, a typed
 * field is one field typed into, and an invented value is a typed value the
 * person does not have and makes up to get past a required field.
 *
 * Raw codes are read from the rendered text (`innerText`, so CSS case
 * transforms apply) before every interaction and at the end of the step:
 * message-catalog style tokens (`COMPOSITION_CHILD_EMPTY`), the "(UTC)"
 * suffix, the misplaced "SELECT A PRODUCT" placeholder, and the developer
 * sentences the plan names. A step counts each distinct one once.
 */
export class LoopScorecard {
  readonly steps: ScorecardStep[] = [];
  /** Every page and fragment request, with the database work it caused. */
  readonly requests: RequestTally[] = [];
  private current: ScorecardStep | undefined;
  /** The step is still on the page the step before ended on. */
  private carried = false;
  private readonly started = new Map<Request, RequestStart>();

  constructor(
    readonly page: Page,
    private readonly database?: {
      readonly meter: DatabaseMeter;
      readonly statistics?: DatabaseStatistics;
    },
  ) {
    page.on('load', () => {
      this.carried = false;
      if (this.current) this.current.loads += 1;
    });
    const meter = database?.meter;
    if (!meter) return;
    page.on('request', (request) => {
      if (measured(request))
        this.started.set(request, {
          count: meter.count(),
          cpu: process.cpuUsage(),
          at: performance.now(),
          parses: catalogParseCount(),
        });
    });
    const finish = (request: Request) => {
      const before = this.started.get(request);
      if (!before) return;
      this.started.delete(request);
      const after = meter.count();
      const cpu = process.cpuUsage(before.cpu);
      const tally: RequestTally = {
        step: this.current?.name ?? '(start)',
        page: requestLabel(request),
        transactions: after.transactions - before.count.transactions,
        statements: after.statements - before.count.statements,
        wallMs: Math.round(performance.now() - before.at),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        parses: parsesSince(before.parses),
      };
      this.requests.push(tally);
      if (this.current) {
        this.current.transactions += tally.transactions;
        this.current.statements += tally.statements;
      }
    };
    page.on('requestfinished', finish);
    page.on('requestfailed', finish);
  }

  begin(name: string): void {
    if (this.current) throw new Error(`step still open: ${this.current.name}`);
    this.current = {
      name,
      clicks: 0,
      loads: 0,
      typed: 0,
      invented: 0,
      codes: new Set(),
      sentences: new Set(),
      transactions: 0,
      statements: 0,
      statisticsTransactions: null,
      result: 'not finished',
    };
    this.carried = this.steps.length > 0;
    this.steps.push(this.current);
  }

  /**
   * Read the database's own transaction count before the first step, so the
   * first step's `pg_stat_database` delta has a start.
   */
  async baseline(): Promise<void> {
    this.statisticsMark = (await this.database?.statistics?.settled()) ?? null;
  }

  async end(result: string): Promise<void> {
    await this.page.waitForLoadState('load');
    await this.scan();
    const step = this.step();
    step.result = result;
    const statistics = this.database?.statistics;
    if (statistics && this.statisticsMark !== null) {
      const mark = await statistics.settled();
      step.statisticsTransactions =
        mark - this.statisticsMark - statistics.readCost;
      this.statisticsMark = mark;
    }
    this.current = undefined;
  }

  private statisticsMark: number | null = null;

  /** Close the open step as not possible, recording why. */
  abandon(reason: string): void {
    if (!this.current) return;
    this.current.result = reason;
    this.current = undefined;
  }

  async click(target: Locator): Promise<void> {
    await this.scan();
    await target.click();
    this.step().clicks += 1;
  }

  async choose(target: Locator, option: { label: string }): Promise<void> {
    await this.scan();
    await target.selectOption(option);
    this.step().clicks += 1;
  }

  async fill(
    target: Locator,
    value: string,
    options: { readonly invented?: boolean } = {},
  ): Promise<void> {
    await this.scan();
    await target.fill(value);
    this.step().typed += 1;
    if (options.invented) this.step().invented += 1;
  }

  /** Read the page as the person sees it now. */
  async scan(): Promise<void> {
    const step = this.step();
    // Until the step's first load, the page is the one the step before
    // ended on, already read there.
    if (this.carried) return;
    const text = await this.page
      .evaluate(() => document.body.innerText)
      .catch(() => '');
    for (const code of rawCodes(text)) step.codes.add(code);
    for (const sentence of developerSentences(text))
      step.sentences.add(sentence);
  }

  table(
    title: string,
    totals: readonly (readonly [string, readonly string[]])[] = [],
  ): string {
    const row = (cells: readonly (string | number)[]) =>
      `| ${cells.join(' | ')} |`;
    const tally = (step: Tally) => [
      step.clicks,
      step.loads,
      step.typed,
      step.invented,
      step.codes.size,
      step.sentences.size,
      step.transactions,
      step.statements,
      step.statisticsTransactions ?? '—',
    ];
    const lines = [
      `# ${title}`,
      '',
      'Written by `apps/web/test/browser/loop-scorecard.composed-application.spec.ts`',
      '(LOOP-1): fresh `distributor` seed, Chromium 1440x900, acting as Buyer,',
      'starting each step where the last one left off. Clicks include choosing',
      'from a drop-down or a search result; a page load is a full document',
      'load; an invented value is one typed only to get past a required field;',
      'raw codes are the charter patterns (`[A-Z]+_[A-Z_]+` tokens, "(UTC)",',
      '"SELECT A PRODUCT") and developer sentences are the plan\'s, each counted',
      'once per step.',
      '',
      row([
        'step',
        'clicks',
        'page loads',
        'typed fields',
        'invented values',
        'raw codes',
        'developer sentences',
        'db xacts incl. resets',
        'db statements',
        'pg_stat xacts incl. resets',
        'result',
      ]),
      row(Array.from({ length: 11 }, () => '---')),
      ...this.steps.map((step) =>
        row([step.name, ...tally(step), step.result]),
      ),
      ...totals.map(([name, steps]) =>
        row([`**${name}**`, ...tally(this.sum(steps)), 'total']),
      ),
      '',
      'Database work: `db xacts incl. resets` and `db statements` are counted in',
      "the test process at the application's PostgreSQL client for every page",
      'and fragment request of the step. A statement outside BEGIN … COMMIT',
      'counts as its own transaction, so the RESET ROLE / RESET ALL after each',
      'transaction is counted too: this over-counts the BEGIN … COMMIT pairs',
      '(SPEED-1 measured 148 pairs on a PO detail page this counts as ~405);',
      "SPEED-1's request meter replaces it once merged. BEGIN, COMMIT and",
      'ROLLBACK are not counted as statements. `pg_stat xacts incl. resets` is',
      "the database's own count (`xact_commit + xact_rollback`) across the step,",
      'read after its statistics settle, less the reads themselves; it counts',
      'the resets the same way and work outside a request.',
      '',
      '## Raw codes and developer sentences seen',
      '',
      ...this.steps.flatMap((step) =>
        step.codes.size + step.sentences.size
          ? [
              `- ${step.name}: ${[...step.codes, ...step.sentences]
                .map((code) => `\`${code}\``)
                .join(', ')}`,
            ]
          : [],
      ),
      '',
      '## Database work per request',
      '',
      'Wall and CPU are milliseconds from the browser sending the request to',
      "its last byte arriving; CPU is this process's (the application and the",
      'test client share it). Seconds vary between runners: compare counts.',
      'Parses are the full parses the request caused (catalogParseCount in',
      'packages/runtime): the operation catalog and surface manifest are reused',
      'by a warm request; a binding is resolved once per surface per request and',
      'the query catalog once per request.',
      '',
      row([
        'step',
        'request',
        'db xacts incl. resets',
        'db statements',
        'wall ms',
        'cpu ms',
        'parses: operation / manifest / binding / query',
      ]),
      row(['---', '---', '---', '---', '---', '---', '---']),
      ...this.requests.map((request) =>
        row([
          request.step,
          request.page,
          request.transactions,
          request.statements,
          request.wallMs,
          request.cpuMs,
          `${String(request.parses.operationCatalog)} / ${String(request.parses.surfaceManifest)} / ${String(request.parses.surfaceBinding)} / ${String(request.parses.queryCatalog)}`,
        ]),
      ),
      '',
    ];
    return lines.join('\n');
  }

  /** The named steps, summed; raw codes and sentences as distinct unions. */
  sum(names: readonly string[]): Tally {
    const chosen = this.steps.filter((step) => names.includes(step.name));
    const add = (
      key:
        | 'clicks'
        | 'loads'
        | 'typed'
        | 'invented'
        | 'transactions'
        | 'statements',
    ) => chosen.reduce((total, step) => total + step[key], 0);
    const statistics = chosen.map((step) => step.statisticsTransactions);
    return {
      clicks: add('clicks'),
      loads: add('loads'),
      typed: add('typed'),
      invented: add('invented'),
      transactions: add('transactions'),
      statements: add('statements'),
      statisticsTransactions: statistics.every((value) => value !== null)
        ? statistics.reduce<number>((total, value) => total + value!, 0)
        : null,
      codes: new Set(chosen.flatMap((step) => [...step.codes])),
      sentences: new Set(chosen.flatMap((step) => [...step.sentences])),
    };
  }

  private step(): ScorecardStep {
    if (!this.current) throw new Error('no scorecard step is open');
    return this.current;
  }
}

export interface Tally {
  readonly clicks: number;
  readonly loads: number;
  readonly typed: number;
  readonly invented: number;
  readonly transactions: number;
  readonly statements: number;
  readonly statisticsTransactions: number | null;
  readonly codes: ReadonlySet<string>;
  readonly sentences: ReadonlySet<string>;
}

export interface ScorecardStep {
  readonly name: string;
  clicks: number;
  loads: number;
  typed: number;
  invented: number;
  readonly codes: Set<string>;
  readonly sentences: Set<string>;
  transactions: number;
  statements: number;
  statisticsTransactions: number | null;
  result: string;
}

export interface RequestTally {
  readonly step: string;
  readonly page: string;
  readonly transactions: number;
  readonly statements: number;
  readonly wallMs: number;
  readonly cpuMs: number;
  /** Full catalog parses the request caused, by kind. */
  readonly parses: CatalogParseCount;
}

interface RequestStart {
  readonly count: DatabaseCount;
  readonly cpu: NodeJS.CpuUsage;
  readonly at: number;
  readonly parses: CatalogParseCount;
}

function parsesSince(before: CatalogParseCount): CatalogParseCount {
  const now = catalogParseCount();
  return {
    operationCatalog: now.operationCatalog - before.operationCatalog,
    surfaceManifest: now.surfaceManifest - before.surfaceManifest,
    surfaceBinding: now.surfaceBinding - before.surfaceBinding,
    queryCatalog: now.queryCatalog - before.queryCatalog,
  };
}

export interface DatabaseCount {
  readonly transactions: number;
  readonly statements: number;
}

/**
 * Counts what the application sends to PostgreSQL, in this process: every
 * \`pg\` client query is a statement, and a statement outside an explicit
 * transaction is a transaction of its own. Installed by the test that starts
 * the application in-process; clients it ignores (the test's own) are not
 * counted.
 */
export class DatabaseMeter {
  readonly ignored = new WeakSet<object>();
  private transactions = 0;
  private statements = 0;
  private readonly open = new WeakMap<object, boolean>();
  private restore: (() => void) | undefined;

  install(): void {
    if (this.restore) return;
    const prototype = pg.Client.prototype as unknown as {
      query: (...parameters: unknown[]) => unknown;
    };
    const original = prototype.query;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const meter = this;
    prototype.query = function (this: object, ...parameters: unknown[]) {
      if (!meter.ignored.has(this)) meter.observe(this, parameters[0]);
      return original.apply(this, parameters);
    };
    this.restore = () => {
      prototype.query = original;
    };
  }

  uninstall(): void {
    this.restore?.();
    this.restore = undefined;
  }

  count(): DatabaseCount {
    return { transactions: this.transactions, statements: this.statements };
  }

  private observe(client: object, query: unknown): void {
    const text =
      typeof query === 'string'
        ? query
        : typeof (query as { text?: unknown } | null)?.text === 'string'
          ? (query as { text: string }).text
          : '';
    const head = text.trimStart().slice(0, 24).toUpperCase();
    if (/^(BEGIN|START TRANSACTION)\b/u.test(head)) {
      this.open.set(client, true);
      this.transactions += 1;
      return;
    }
    if (
      /^(COMMIT|END|ABORT)\b/u.test(head) ||
      /^ROLLBACK(?!\s+TO)\b/u.test(head)
    ) {
      this.open.set(client, false);
      return;
    }
    this.statements += 1;
    if (!this.open.get(client)) this.transactions += 1;
  }
}

/**
 * The database's own transaction count, \`xact_commit + xact_rollback\` for
 * the test database, read on a client the meter ignores. A backend flushes
 * its counts when it goes idle, at most once a second and otherwise after
 * PostgreSQL's ten-second idle interval, so a read waits that out first.
 */
export class DatabaseStatistics {
  /** Each read is one transaction of its own, counted by the next read. */
  readonly readCost = 1;

  constructor(
    private readonly client: pg.ClientBase,
    private readonly settleMs = 11_000,
  ) {}

  async settled(): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    const result = await this.client.query<{ count: string }>(
      `SELECT (xact_commit + xact_rollback)::text AS count
         FROM pg_stat_database WHERE datname = current_database()`,
    );
    return Number(result.rows[0]!.count);
  }
}

function measured(request: Request): boolean {
  return (
    request.frame() === request.frame().page().mainFrame() &&
    (request.isNavigationRequest() || request.resourceType() === 'fetch')
  );
}

/** A request named by the page it asks for and the stage of a Task it moves. */
function requestLabel(request: Request): string {
  const url = new URL(request.url());
  const surface = (url.searchParams.get('surface') ?? 'home').replace(
    /^.*:surface\./u,
    '',
  );
  const body = request.method() === 'POST' ? (request.postData() ?? '') : '';
  const form = new URLSearchParams(body);
  const stage = form.get('taskStage')
    ? `task ${form.get('taskStage')!}`
    : form.get('compositionAction') || url.searchParams.get('compositionAction')
      ? 'task open'
      : request.resourceType() === 'fetch'
        ? 'fragment'
        : request.method() === 'POST'
          ? 'submit'
          : '';
  return `${request.method()} ${surface}${stage ? ` (${stage})` : ''}`;
}

const DEVELOPER_SENTENCES = [
  'Save commits the header',
  'Draft staged.',
  'No child records',
  'required parent selection',
] as const;

/**
 * The raw codes in a page's rendered text, each once: the charter's three
 * patterns. "SELECT A PRODUCT" is matched as rendered (uppercase), so a
 * reworded prompt in ordinary case does not count.
 */
export function rawCodes(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu))
    found.add(match[0]);
  if (text.includes('(UTC)')) found.add('(UTC)');
  if (text.includes('SELECT A PRODUCT')) found.add('SELECT A PRODUCT');
  return [...found];
}

/** The developer sentences the plan names, each once. */
export function developerSentences(text: string): readonly string[] {
  return DEVELOPER_SENTENCES.filter((sentence) => text.includes(sentence));
}

/** The loop's step names, in order, and the totals the plan sets targets on. */
export const LOOP_STEPS = Object.freeze({
  placePurchase: 'Purchase order: create and place (1 line)',
  receive: 'Purchase order: receive in full',
  findStock: 'Stock: find the item',
  createSale: 'Sales order: create and confirm (1 line)',
  reserve: 'Sales order: reserve',
  ship: 'Sales order: ship',
  invoiceAndPay: 'Sales order: invoice and record payment',
});
export const LOOP_TOTALS: readonly (readonly [string, readonly string[]])[] =
  Object.freeze([
    [
      'Sales side, create to shipped',
      [LOOP_STEPS.createSale, LOOP_STEPS.reserve, LOOP_STEPS.ship],
    ],
  ]);

/**
 * What the journey buys and sells: a distributor catalogue item (it has a
 * list price, no standard cost), from a supplier, to a customer whose
 * address book gives the order a complete ship-to.
 */
export const LOOP_FIXTURE = Object.freeze({
  vendor: ['Cascade', 'Cascade Fastener Works'],
  location: ['Calgary', 'Calgary warehouse'],
  item: ['FST-0120', 'Hex bolt — M8 × 40 mm'],
  customer: ['Lethbridge', 'Lethbridge Millwork'],
  purchased: '10',
  unitCost: '12.00',
  sold: '4',
} as const);

/**
 * The journey's rule, so before and after are comparable: start from the
 * page the last step left; reach the next job through the menu or the page's
 * own controls; type only what a required field or the job needs (the vendor,
 * the item, the quantity and the cost the vendor quoted; the customer, the
 * item and the quantity sold) and accept every default offered.
 */
export async function walkToShipped(
  card: LoopScorecard,
  baseUrl: string,
): Promise<void> {
  card.page.setDefaultTimeout(30_000);
  await card.page.goto(baseUrl);
  await card.baseline();
  await placePurchaseOrder(card);
  await receiveInFull(card);
  await findStock(card);
  await createSale(card);
  await reserve(card);
  await ship(card);
}

export async function placePurchaseOrder(card: LoopScorecard): Promise<void> {
  const { page } = card;
  const f = LOOP_FIXTURE;
  card.begin(LOOP_STEPS.placePurchase);
  await openFromMenu(card, 'Purchasing', 'Purchase orders');
  await card.click(page.getByRole('link', { name: 'New', exact: true }));
  await pick(card, 'Vendor', ...f.vendor);
  await card.fill(
    page.getByLabel(/^Order date/u),
    new Date().toISOString().slice(0, 16),
  );
  await pick(card, 'Receive into', ...f.location);
  await pick(card, 'Line 1 product', ...f.item);
  await card.fill(
    page.getByLabel('Line 1 quantity', { exact: true }),
    f.purchased,
  );
  await card.fill(
    page.getByLabel('Line 1 unit cost', { exact: true }),
    f.unitCost,
  );
  await card.click(
    page.getByRole('button', { name: 'Save draft', exact: true }),
  );
  await expect(page).toHaveURL(/purchase_order_detail/u);
  await runTask(card, nextAction(page), 'Place order');
  await expect(status(page)).toHaveText(/Released/u);
  await card.end('done');
}

export async function receiveInFull(card: LoopScorecard): Promise<void> {
  const { page } = card;
  const f = LOOP_FIXTURE;
  card.begin(LOOP_STEPS.receive);
  await runTask(card, nextAction(page), 'Receive lines with actual cost', {
    async enter() {
      await card.click(
        page.getByRole('button', { name: 'Fill open quantities', exact: true }),
      );
      await card.fill(
        page.getByLabel(/Actual received unit cost/u).first(),
        f.unitCost,
      );
    },
  });
  await expect(cell(page, 'purchasing_lines', 'Received')).toHaveText(
    f.purchased,
  );
  await card.end('done');
}

export async function findStock(card: LoopScorecard): Promise<void> {
  const { page } = card;
  const f = LOOP_FIXTURE;
  card.begin(LOOP_STEPS.findStock);
  await openFromMenu(card, 'Inventory', 'Stock by item');
  await card.fill(page.getByRole('searchbox').first(), f.item[0]);
  await card.click(page.getByRole('button', { name: 'Apply', exact: true }));
  await expect(
    page
      .locator('tbody tr')
      .filter({ hasText: f.item[0] })
      .first()
      .locator('td[data-column-label="On hand"]'),
  ).toHaveText(f.purchased);
  await card.end('done');
}

export async function createSale(card: LoopScorecard): Promise<void> {
  const { page } = card;
  const f = LOOP_FIXTURE;
  card.begin(LOOP_STEPS.createSale);
  await openFromMenu(card, 'Sales', 'Sales orders');
  await card.click(page.getByRole('link', { name: 'New', exact: true }));
  await pick(card, 'Customer', ...f.customer);
  await card.fill(
    page.getByLabel(/^Order date/u),
    new Date().toISOString().slice(0, 16),
  );
  await pick(card, 'Line 1 product', ...f.item);
  await card.fill(page.getByLabel('Line 1 quantity', { exact: true }), f.sold);
  await card.click(
    page.getByRole('button', { name: 'Save draft', exact: true }),
  );
  await expect(page).toHaveURL(/sales_order_detail/u);
  await card.click(nextAction(page));
  await expect(status(page)).toHaveText(/Released/u);
  await card.end('done');
}

export async function reserve(card: LoopScorecard): Promise<void> {
  const { page } = card;
  const f = LOOP_FIXTURE;
  card.begin(LOOP_STEPS.reserve);
  await card.click(
    dataset(page, 'fulfillment_lines').getByRole('link', {
      name: 'Select',
      exact: true,
    }),
  );
  await runTask(card, control(page, 'Reserve stock'), 'Reserve stock', {
    async enter() {
      await card.fill(taskField(page, 'Quantity to reserve'), f.sold);
      await chooseReference(card, 'Stock location', f.location[1]);
    },
    review: 'Review reservation',
    confirm: 'Confirm reservation',
  });
  await expect(cell(page, 'fulfillment_lines', 'Reserved')).toHaveText(f.sold);
  await card.end('done');
}

export async function ship(card: LoopScorecard): Promise<void> {
  const { page } = card;
  const f = LOOP_FIXTURE;
  card.begin(LOOP_STEPS.ship);
  await card.click(
    dataset(page, 'line_reservations').getByRole('link', {
      name: 'Select',
      exact: true,
    }),
  );
  await runTask(
    card,
    control(page, 'Ship reserved stock'),
    'Ship reserved stock',
    {
      async enter() {
        await card.fill(taskField(page, 'Quantity to ship'), f.sold);
        await card.fill(taskField(page, 'Carrier'), 'N/A', { invented: true });
        await card.fill(taskField(page, 'Tracking or BOL number'), 'N/A', {
          invented: true,
        });
      },
      review: 'Review shipment',
      confirm: 'Confirm shipment',
    },
  );
  await expect(cell(page, 'fulfillment_lines', 'Shipped')).toHaveText(f.sold);
  await card.end('done');
}

/**
 * Invoice the shipped order and record its payment of the whole balance.
 * Invoicing is the shipped order's next action. The payment is recorded
 * from the order when the order offers it as its next action; otherwise
 * the way the screens offer today: open the invoice, record the payment
 * there. Returns whether the payment was recorded from the order.
 */
export async function invoiceAndPay(card: LoopScorecard): Promise<boolean> {
  const { page } = card;
  card.begin(LOOP_STEPS.invoiceAndPay);
  await expect(page).toHaveURL(/sales_order_detail/u);
  await runTask(card, nextAction(page), 'Invoice shipped quantities');
  const balance = (await cell(page, 'order_invoices', 'Balance').innerText())
    .trim()
    .replaceAll(',', '');
  expect(Number(balance)).toBeGreaterThan(0);
  const next = page.locator('.composition-progression-next');
  const fromOrder =
    (await next.count()) > 0 &&
    (await next.getAttribute('data-next-action')) ===
      'northstar.app:action.order_record_payment';
  if (fromOrder) {
    await runTask(card, nextAction(page), 'Record payment');
    await expect(cell(page, 'order_invoices', 'Balance')).toHaveText('0.00');
  } else {
    await card.click(
      page
        .getByRole('list', { name: 'Invoicing documents' })
        .getByRole('link')
        .first(),
    );
    await expect(page).toHaveURL(/customer_invoice_detail/u);
    await runTask(card, control(page, 'Record payment'), 'Record payment', {
      async enter() {
        await card.fill(taskField(page, 'Amount received'), balance);
        // Required today; an EFT payment has no cheque number to give.
        await card.fill(taskField(page, 'Reference'), 'N/A', {
          invented: true,
        });
      },
    });
    await expect(
      page
        .locator('.composition-header-facts > div')
        .filter({ has: page.locator('dt', { hasText: /^Balance$/u }) })
        .locator('dd'),
    ).toHaveText('0.00');
  }
  await card.end(fromOrder ? 'done' : 'done, through the invoice page');
  return fromOrder;
}

async function openFromMenu(
  card: LoopScorecard,
  group: string,
  destination: string,
): Promise<void> {
  const { page } = card;
  const link = page
    .getByRole('navigation', { name: 'Release navigation' })
    .getByRole('link', { name: destination });
  if (!(await link.isVisible()))
    await card.click(
      page
        .getByRole('navigation', { name: 'Release navigation' })
        .locator('summary')
        .filter({ hasText: group }),
    );
  await card.click(link);
}

/** A draft-editor picker: type a term, choose the offered result. */
async function pick(
  card: LoopScorecard,
  name: string,
  term: string,
  option: string,
): Promise<void> {
  const { page } = card;
  const box = page.getByRole('combobox', { name, exact: true });
  await card.fill(box, term);
  await card.click(
    page
      .getByRole('option')
      .filter({ has: page.locator('strong', { hasText: option }) })
      .first(),
  );
  await expect(box).toHaveAttribute('data-selected-label', option);
}

/** A Task's reference input: a drop-down of the declared choices. */
async function chooseReference(
  card: LoopScorecard,
  label: string,
  option: string,
): Promise<void> {
  const control = taskField(card.page, label);
  const chosen = await control
    .locator('option:checked')
    .textContent()
    .catch(() => null);
  if (chosen?.trim() !== option) await card.choose(control, { label: option });
}

/** A Task's input by the label wrapped around it. */
function taskField(page: Page, label: string): Locator {
  return page
    .locator('[data-composition-task] label')
    .filter({ hasText: label })
    .locator('input, select, textarea')
    .first();
}

/**
 * A Task from its opening control to its result: enter the details, review,
 * confirm. A Task the page answers at once (no review stage) ends at its
 * first click.
 */
async function runTask(
  card: LoopScorecard,
  opener: Locator,
  label: string,
  stages: {
    readonly enter?: () => Promise<void>;
    readonly review?: string;
    readonly confirm?: string;
  } = {},
): Promise<void> {
  const { page } = card;
  await card.click(opener);
  const dialog = page.locator('[data-composition-task]');
  await expect(dialog).toBeVisible();
  await stages.enter?.();
  const review = dialog.getByRole('button', {
    name: stages.review ?? `Review ${label}`,
    exact: true,
  });
  if (await review.isVisible()) await card.click(review);
  await card.click(
    dialog.getByRole('button', {
      name: stages.confirm ?? `Confirm ${label}`,
      exact: true,
    }),
  );
  await expect(dialog).toHaveAttribute('data-task-phase', 'result');
  // Back to the record, where the next step is offered.
  await card.click(dialog.getByRole('link', { name: /^Back to/u }));
  await expect(dialog).toHaveCount(0);
}

function nextAction(page: Page): Locator {
  return page
    .locator('.composition-progression-next')
    .getByRole('link')
    .or(page.locator('.composition-progression-next').getByRole('button'))
    .first();
}

/** A control by its accessible name, link or button. */
function control(page: Page, name: string): Locator {
  return page
    .getByRole('link', { name, exact: true })
    .or(page.getByRole('button', { name, exact: true }))
    .first();
}

function status(page: Page): Locator {
  return page.locator('.composition-business-status');
}

/** The first row's cell under a column label, in one of the page's datasets. */
function cell(page: Page, local: string, column: string): Locator {
  return dataset(page, local)
    .locator('tbody tr')
    .first()
    .locator(`td[data-column-label="${column}"]`);
}

function dataset(page: Page, local: string): Locator {
  return page.locator(`[data-composition-dataset$="dataset.${local}"]`);
}

/** Write the table where the caller asked, and return it. */
export function writeScorecard(
  card: LoopScorecard,
  path: string | undefined,
  title: string,
): string {
  const table = card.table(title, LOOP_TOTALS);
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, table);
  }
  return table;
}
