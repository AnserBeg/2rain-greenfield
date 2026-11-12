/**
 * UI primitives: the small, reusable building blocks document sections are
 * composed from.
 *
 * Rain renders on the server. There is no component framework and, by
 * ADR-0036 and the response's content-security policy, no page script. A
 * "component" here is therefore a pure function: typed options in, an HTML
 * string out. That keeps the three properties a component needs —
 *
 *   - one responsibility each (a badge, a table, a disclosure);
 *   - predictable inputs (a typed options object, never positional strings);
 *   - composability (a primitive's output is another primitive's `…Html`).
 *
 * TWO RULES every primitive follows, so callers never have to think about them:
 *
 *   1. **Text is escaped here, markup is not.** An option named `label`,
 *      `title`, `value` or `caption` is plain text and is escaped by the
 *      primitive. An option whose name ends in `Html` is markup the caller
 *      already built from primitives, and is inserted as is.
 *   2. **Colour comes from role tokens only.** Status colour is selected with
 *      `data-status-role`, never a class per colour and never a literal — the
 *      ux-grammar status rule, enforced by the hex-literal ratchet.
 *
 * Interaction without script uses the platform: `<details>` for anything that
 * opens (disclosures, action menus), links and GET forms for anything that
 * navigates or filters. State lives in the URL, as ADR-0015 requires.
 *
 * The matching styles are in `primitives-styles.ts`.
 */
import { escapeHtml } from '../html.js';

/** Markup that was produced by a primitive and needs no further escaping. */
export type Html = string;

/** The closed status vocabulary of the ux-grammar, plus an unroled neutral. */
export type StatusRole =
  'attention' | 'blocked' | 'inProgress' | 'neutral' | 'success';

export type DataAttributes = Readonly<Record<string, string>>;

function attributes(values: DataAttributes | undefined): string {
  return Object.entries(values ?? {})
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusBadgeOptions {
  readonly label: string;
  readonly role: StatusRole;
  /** Names what the badge describes, for example `lifecycle` or `receiving`. */
  readonly kind?: string;
}

/**
 * A status as colour + dot + word on a tinted ground — never colour alone.
 * Reuses the shell's `.status-pill`, so a badge on a purchase order is
 * indistinguishable from one anywhere else in the product.
 */
export function statusBadge({ kind, label, role }: StatusBadgeOptions): Html {
  const roleAttribute =
    role === 'neutral' ? '' : ` data-status-role="${escapeHtml(role)}"`;
  const kindAttribute = kind ? ` data-status-kind="${escapeHtml(kind)}"` : '';
  return `<span class="status-pill"${roleAttribute}${kindAttribute}>${escapeHtml(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface PageSectionOptions {
  /** Omit for a panel that carries its own leading content. */
  readonly title?: string;
  /** One line under the title: a count, a unit, a scope. */
  readonly description?: string;
  /** Section-level actions, right-aligned in the header. */
  readonly actionsHtml?: Html;
  readonly bodyHtml: Html;
  /** `flush` lets a table run edge to edge inside the section. */
  readonly density?: 'flush' | 'padded';
  readonly attributes?: DataAttributes;
}

/** A titled region of a page: heading row, optional actions, body. */
export function pageSection({
  actionsHtml = '',
  attributes: extra,
  bodyHtml,
  density = 'padded',
  description,
  title,
}: PageSectionOptions): Html {
  const header = title
    ? `<header class="ui-section__header"><div><h2>${escapeHtml(title)}</h2>${description ? `<p class="ui-section__description">${escapeHtml(description)}</p>` : ''}</div>${actionsHtml ? `<div class="ui-section__actions">${actionsHtml}</div>` : ''}</header>`
    : '';
  return `<section class="panel data-panel ui-section" data-density="${density}"${attributes(extra)}>${header}<div class="ui-section__body">${bodyHtml}</div></section>`;
}

export interface LinkActionOptions {
  readonly href: string;
  readonly label: string;
  readonly variant?: 'primary' | 'quiet' | 'secondary';
  readonly attributes?: DataAttributes;
}

/** A navigation action. Links navigate; only forms mutate. */
export function linkAction({
  attributes: extra,
  href,
  label,
  variant = 'secondary',
}: LinkActionOptions): Html {
  const className =
    variant === 'quiet' ? 'ui-quiet-action' : `${variant}-action`;
  return `<a class="${className}" href="${escapeHtml(href)}"${attributes(extra)}>${escapeHtml(label)}</a>`;
}

export interface RecordHeadingOptions {
  /** Small line above the title: what kind of record this is. */
  readonly kicker?: string;
  readonly title: string;
  /** Small line below the title: who or what the record belongs to. */
  readonly subtitle?: string;
  /** Status badges, usually built with `labeledStatus`. */
  readonly statusHtml?: Html;
}

/** The title block of a record page: what it is, which one, what state. */
export function recordHeading({
  kicker,
  statusHtml = '',
  subtitle,
  title,
}: RecordHeadingOptions): Html {
  return `<header class="surface-heading surface-heading--slot ui-record-heading"><div>${kicker ? `<p class="eyebrow">${escapeHtml(kicker)}</p>` : ''}<h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="ui-record-heading__subtitle">${escapeHtml(subtitle)}</p>` : ''}</div>${statusHtml ? `<div class="ui-record-heading__status">${statusHtml}</div>` : ''}</header>`;
}

/** A badge with a caption saying WHICH status it is, when a record has two. */
export function labeledStatus(caption: string, badgeHtml: Html): Html {
  return `<span class="ui-labeled-status"><small>${escapeHtml(caption)}</small>${badgeHtml}</span>`;
}

// ---------------------------------------------------------------------------
// Facts and figures
// ---------------------------------------------------------------------------

export interface Fact {
  readonly label: string;
  readonly valueHtml: Html;
  /** Stable hook for tests and for a future reader locating this fact. */
  readonly key?: string;
}

/** A dense label/value list for a record's descriptive facts. */
export function factList(facts: readonly Fact[]): Html {
  return `<dl class="ui-facts">${facts
    .map(
      (fact) =>
        `<div${fact.key ? ` data-fact="${escapeHtml(fact.key)}"` : ''}><dt>${escapeHtml(fact.label)}</dt><dd>${fact.valueHtml}</dd></div>`,
    )
    .join('')}</dl>`;
}

export interface Metric {
  readonly label: string;
  readonly value: string;
  /** Unit or qualifier shown beside the value, for example a currency code. */
  readonly unit?: string;
  readonly caption?: string;
  readonly key?: string;
}

/** A single row of headline figures. Numbers are tabular and right-sized. */
export function metricStrip(metrics: readonly Metric[]): Html {
  return `<dl class="ui-metrics">${metrics
    .map(
      (metric) =>
        `<div${metric.key ? ` data-metric="${escapeHtml(metric.key)}"` : ''}><dt>${escapeHtml(metric.label)}</dt><dd><span class="ui-metrics__value">${escapeHtml(metric.value)}</span>${metric.unit ? `<span class="ui-metrics__unit">${escapeHtml(metric.unit)}</span>` : ''}</dd>${metric.caption ? `<dd class="ui-metrics__caption">${escapeHtml(metric.caption)}</dd>` : ''}</div>`,
    )
    .join('')}</dl>`;
}

export interface TotalRow {
  readonly label: string;
  readonly valueHtml: Html;
  /** The row that carries the figure a reader is looking for. */
  readonly emphasis?: boolean;
  readonly key?: string;
}

/** A right-aligned financial breakdown: components first, total last. */
export function totalsList(rows: readonly TotalRow[]): Html {
  return `<dl class="ui-totals">${rows
    .map(
      (row) =>
        `<div${row.emphasis ? ' data-emphasis="true"' : ''}${row.key ? ` data-total="${escapeHtml(row.key)}"` : ''}><dt>${escapeHtml(row.label)}</dt><dd>${row.valueHtml}</dd></div>`,
    )
    .join('')}</dl>`;
}

export interface ProgressMeterOptions {
  /** 0–100. */
  readonly percent: number;
  /** Read by assistive technology, for example `3 of 5 received`. */
  readonly label: string;
  readonly role: StatusRole;
}

/** A thin proportion bar. The exact figures always sit beside it as text. */
export function progressMeter({
  label,
  percent,
  role,
}: ProgressMeterOptions): Html {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return `<span class="ui-meter" role="img" aria-label="${escapeHtml(label)}" data-status-role="${escapeHtml(role)}"><span style="width:${String(clamped)}%"></span></span>`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableColumn<Row> {
  readonly key: string;
  readonly label: string;
  /** `end` right-aligns numbers so their digits line up. */
  readonly align?: 'end' | 'start';
  /** Keeps the header for assistive technology but hides it visually. */
  readonly hideLabel?: boolean;
  readonly cell: (row: Row) => Html;
  /** Extra attributes placed on every body cell of this column. */
  readonly cellAttributes?: DataAttributes;
}

export interface DataTableOptions<Row> {
  /** Names the table for assistive technology; not shown. */
  readonly caption: string;
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowAttributes?: (row: Row) => DataAttributes;
  /** Shown in place of the table when there are no rows. */
  readonly emptyHtml: Html;
}

/**
 * The one table. Columns are declared as data, so adding a column to a screen
 * is one entry in an array rather than edits to a header row and a body row
 * that must be kept in step by hand.
 *
 * It reuses the shell's `data-table-wrap` rendering, which is what turns each
 * row into a labelled card below 800 px (`data-compact-card` and
 * `data-column-label`) — the ux-grammar's list transformation, inherited
 * rather than reimplemented.
 */
export function dataTable<Row>({
  caption,
  columns,
  emptyHtml,
  rowAttributes,
  rows,
}: DataTableOptions<Row>): Html {
  if (rows.length === 0) return emptyHtml;
  const head = columns
    .map(
      (column) =>
        `<th scope="col"${column.align === 'end' ? ' class="ui-cell--end"' : ''}>${column.hideLabel ? `<span class="sr-only">${escapeHtml(column.label)}</span>` : escapeHtml(column.label)}</th>`,
    )
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr data-compact-card="true"${attributes(rowAttributes?.(row))}>${columns
          .map(
            (column) =>
              `<td data-column="${escapeHtml(column.key)}" data-column-label="${escapeHtml(column.label)}"${column.align === 'end' ? ' class="ui-cell--end"' : ''}${attributes(column.cellAttributes)}>${column.cell(row)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="data-table-wrap ui-table" data-list-rendering="responsive-single"><table><caption class="sr-only">${escapeHtml(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Two-line cell content: a primary value and quieter supporting text. */
export function stackedCell(primaryHtml: Html, secondary?: string): Html {
  return secondary
    ? `<span class="ui-stack">${primaryHtml}<small>${escapeHtml(secondary)}</small></span>`
    : primaryHtml;
}

/** The placeholder for "no value", distinct from an empty string or a zero. */
export function emptyValue(label = 'Not set'): Html {
  return `<span class="muted" aria-label="${escapeHtml(label)}">—</span>`;
}

export interface EmptyStateOptions {
  readonly title: string;
  readonly description: string;
  readonly actionHtml?: Html;
  readonly attributes?: DataAttributes;
}

/** "Nothing here yet" — never styled as, or confused with, a failure. */
export function emptyState({
  actionHtml = '',
  attributes: extra,
  description,
  title,
}: EmptyStateOptions): Html {
  return `<div class="ui-empty" data-data-state="empty"${attributes(extra)}><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${actionHtml}</div>`;
}

// ---------------------------------------------------------------------------
// Progressive disclosure
// ---------------------------------------------------------------------------

export interface DisclosureOptions {
  readonly summary: string;
  /** Quiet text after the summary: a count or a one-word state. */
  readonly hint?: string;
  readonly bodyHtml: Html;
  readonly open?: boolean;
  readonly attributes?: DataAttributes;
}

/**
 * Content that is present but collapsed — the ux-grammar `progressive` tier.
 * Native `<details>`: keyboard operable, announced as expandable, and working
 * with no script. The summary always states that the content exists.
 */
export function disclosure({
  attributes: extra,
  bodyHtml,
  hint,
  open = false,
  summary,
}: DisclosureOptions): Html {
  return `<details class="ui-disclosure"${open ? ' open' : ''}${attributes(extra)}><summary><span class="ui-disclosure__label">${escapeHtml(summary)}</span>${hint ? `<span class="ui-disclosure__hint">${escapeHtml(hint)}</span>` : ''}</summary><div class="ui-disclosure__body">${bodyHtml}</div></details>`;
}

export interface ActionMenuItem {
  readonly href: string;
  readonly label: string;
}

export interface ActionMenuOptions {
  /** Visible trigger text. */
  readonly label: string;
  /** What the menu acts on, for assistive technology: `Actions for PO-1001`. */
  readonly describedAs: string;
  readonly items: readonly ActionMenuItem[];
}

/**
 * A contextual dropdown of navigation actions for one row or one record.
 * Renders nothing when there are no items, so a menu never opens empty.
 */
export function actionMenu({
  describedAs,
  items,
  label,
}: ActionMenuOptions): Html {
  if (items.length === 0) return '';
  return `<details class="ui-menu"><summary aria-label="${escapeHtml(describedAs)}">${escapeHtml(label)}</summary><ul class="ui-menu__list">${items
    .map(
      (item) =>
        `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`,
    )
    .join('')}</ul></details>`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface Step {
  readonly label: string;
  readonly state: 'current' | 'done' | 'stopped' | 'upcoming';
}

/** Where a document is in its lifecycle, as an ordered list of steps. */
export function stepper(label: string, steps: readonly Step[]): Html {
  return `<ol class="ui-steps" aria-label="${escapeHtml(label)}">${steps
    .map(
      (step) =>
        `<li data-step-state="${step.state}"${step.state === 'current' ? ' aria-current="step"' : ''}><span class="ui-steps__mark" aria-hidden="true"></span><span>${escapeHtml(step.label)}</span></li>`,
    )
    .join('')}</ol>`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchBarOptions {
  /** Shown above the input and used as its accessible name. */
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  /** Query parameters to carry through the search, such as the surface id. */
  readonly preserved: readonly (readonly [string, string])[];
  /** Where "Clear" returns to; omitted while there is nothing to clear. */
  readonly clearHref?: string;
  /** Right-hand content on the same row, typically a result count. */
  readonly trailingHtml?: Html;
}

/**
 * A search row. It is a GET form, so the query lands in the URL: a filtered
 * list can be bookmarked, shared and returned to with the back button.
 */
export function searchBar({
  clearHref,
  label,
  placeholder,
  preserved,
  trailingHtml = '',
  value,
}: SearchBarOptions): Html {
  const hidden = preserved
    .map(
      ([name, preservedValue]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(preservedValue)}">`,
    )
    .join('');
  return `<form class="ui-search" data-list-search method="get" action="/" role="search">${hidden}<label class="ui-search__field"><span>${escapeHtml(label)}</span><input type="search" name="q" value="${escapeHtml(value)}" maxlength="240" autocomplete="off" placeholder="${escapeHtml(placeholder)}"></label><button type="submit">Search</button>${clearHref ? `<a class="secondary-action" href="${escapeHtml(clearHref)}">Clear</a>` : ''}${trailingHtml ? `<div class="ui-search__trailing">${trailingHtml}</div>` : ''}</form>`;
}

export interface PaginationOptions {
  readonly previousHref?: string;
  readonly nextHref?: string;
}

/** Previous/next page links. Renders nothing for a single-page result. */
export function pagination({
  nextHref,
  previousHref,
}: PaginationOptions): Html {
  if (!previousHref && !nextHref) return '';
  return `<nav class="list-pagination ui-pagination" aria-label="List pages">${previousHref ? `<a class="list-page-link" href="${escapeHtml(previousHref)}">Previous page</a>` : ''}${nextHref ? `<a class="list-page-link" href="${escapeHtml(nextHref)}">Next page</a>` : ''}</nav>`;
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export interface NoticeOptions {
  readonly role: Exclude<StatusRole, 'neutral'>;
  readonly title: string;
  readonly detail: string;
  readonly attributes?: DataAttributes;
}

/** An inline, non-blocking statement about the record being viewed. */
export function notice({
  attributes: extra,
  detail,
  role,
  title,
}: NoticeOptions): Html {
  return `<p class="ui-notice" role="note" data-status-role="${escapeHtml(role)}"${attributes(extra)}><strong>${escapeHtml(title)}</strong> ${escapeHtml(detail)}</p>`;
}
