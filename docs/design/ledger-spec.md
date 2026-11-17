# Ledger: visual spec for the generated renderer

Reference: `look-final.html` (seven tabs, light/dark, compact/comfortable). The renderer builds every screen
from a record definition plus that record's data. Nothing on a screen is written by hand for that screen.

## 1. Colour tokens

All colours are CSS custom properties on `:root`. Dark values are redefined under `@media (prefers-color-scheme: dark)`
guarded by `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`. Components use tokens only.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--paper` | page ground | #F5F5F2 | #131416 |
| `--side` | sidebar ground | #EDEDE9 | #17181B |
| `--sheet` | panels, sheets, inputs | #FFFFFF | #1B1D20 |
| `--sunk` | table heads, notes, row hover | #F3F3EF | #202226 |
| `--hover` | nav and ghost-button hover | #E8E8E3 | #272A2E |
| `--ink` / `--ink-2` | primary text / secondary text, done steps | #17191C / #40454B | #E8E8E4 / #C3C5C8 |
| `--muted` / `--faint` | labels, metadata / zeros, placeholders | #6B7077 / #A1A5AA | #92969C / #666A70 |
| `--rule` / `--rule-2` | hairlines / input borders, strong rules | #E3E3DE / #CDCDC7 | #2B2E32 / #3B3F44 |
| `--accent` | the one primary button, current step, focus ring, partial progress | #0E6670 | #4FB0BB |
| `--accent-hover` / `--on-accent` | primary hover / text on accent | #0A525A / #FFFFFF | #68C0CA / #071A1D |
| `--accent-soft` / `--accent-text` | in-progress badge, impact box / links, next-step label | #E1EEF0 / #0C5E67 | #12303A / #80CCD5 |
| `--success` / `--success-soft` | complete, posted, in service | #2E7A2F / #E4F2E1 | #86CF84 / #1A3119 |
| `--attention` / `--attention-soft` | due today, low stock | #8A5300 / #F9EED5 | #E2B25E / #33280F |
| `--blocked` / `--blocked-soft` | on hold, failed, required mark | #A3261B / #FAE8E5 | #F1907F / #3A1D19 |
| `--scrim`, `--shadow-dlg`, `--shadow-bar` | dialog backdrop, dialog lift, sticky form bar | ink at 38% | black at 60% |

Accent (teal, hue about 186°) means "you can act / in motion". Success (green, hue about 122°) means "done".
They never share a meaning.

## 2. Status kinds

The definition maps every status value to one kind. The kind sets colour and glyph, so badges read apart in greyscale.

| Kind | Glyph | Examples |
|---|---|---|
| neutral | hollow ring, outlined pill | Draft, Not started, Not reserved |
| progress | half-filled ring on `--accent-soft` | Receiving, Confirmed, Partly reserved |
| success | check on `--success-soft` | Posted, Reserved, In service, Paid |
| attention | filled dot on `--attention-soft` | Today, Low, Due soon |
| blocked | filled square on `--blocked-soft` | On credit hold, Failed |

## 3. Type

- IBM Plex Sans 400/500/600 for all UI; IBM Plex Serif 500 for the record number only; IBM Plex Mono 400/500 for
  SKUs, serials and document numbers inside tables and links. Fallbacks: system-ui, Georgia, ui-monospace.
- `font-variant-numeric: tabular-nums` on body. Numbers sit right-aligned in their own column.
- Scale (px/weight): record number 28/500 serif (24 on phone) · page title 20/600 · next-step sentence 14/500 ·
  body 13/400 · panel heading 13/600 · table cell 12/400 · labels and table heads 11/500 · tile number 28/500
  (24 in stat strips) · badge 11/500. Section labels only are uppercase with 0.06em tracking.
- Money: two decimals, thousands separators, currency code once per totals block, never per cell.

## 4. Spacing, density, radii, rules

Density tokens: `:root` holds compact; `:root[data-density="comfortable"]` overrides only these.

| Token | Compact | Comfortable | Used for |
|---|---|---|---|
| `--row-y` | 8 | 12 | table cells, list rows, tiles, timeline items |
| `--ctl-h` | 30 | 36 | buttons, inputs, selects |
| `--nav-h` | 30 | 34 | sidebar items |
| `--gap` | 18 | 26 | between panels and page sections |
| `--pad-x` | 14 | 18 | panel inner padding |
| `--sheet-y` / `--sheet-x` | 26 / 30 | 34 / 40 | record sheet padding |

- Fixed: sidebar 212px, rail 300px, page max 1240px, gutter 28px; at 900px and below the gutter is
  `max(16px, env(safe-area-inset-*))` and the sidebar collapses to a menu button.
- Radii: 4px panels, inputs, buttons; 6px dialog; pill badges; round avatars and step dots.
- Rules: 1px `--rule` between rows and sections; 1px `--rule-2` on inputs; 1px `--ink` above document line tables;
  3px double `--ink` under the grand total. Shadows only on the dialog and the sticky form bar.

## 5. Components (parts · data · when it appears)

- **Shell**: sidebar, top bar (search, notifications, avatar), page. Data: user, organisation, location. Always.
- **Sidebar with queues**: organisation switcher; Today; queue items (icon, label, count chip); area groups (heading,
  items, optional count); a Custom group listing customer-defined record types; user footer. Data: queue definitions
  (label, query, count) for the user's role, area registry, custom types. Queues keep a fixed order; a zero count
  stays visible so positions never move.
- **Page header**: breadcrumb (area / type plural / number), eyebrow (type name), title (record number in serif, or the
  list name), status badge, subtitle `{title_field} · {secondary_field}`, secondary actions (Edit, More, declared
  non-primary transitions). Never carries the primary action.
- **Status badge**: label + kind (section 2). Header, table cells, linked documents, status fields in facts.
- **Stepper**: ordered states marked done/current/future, caption per step (date entered, or a metric template for the
  current one). Appears only when the definition declares an ordered lifecycle of 3 or more states. A flat status gets
  only the badge. Phone: dots plus "Step {n} of {m} · {state}".
- **Next-step card**: sits under the stepper in the same bordered block. Label "Next step", one templated sentence,
  one templated detail line, one primary button. Data: the transition the definition marks primary for the current
  state, its open quantities. Appears only if that transition exists and the user may perform it.
- **Parties block**: two address columns (Supplier / Deliver to, Bill to / Ship to). When the definition has party
  references with addresses.
- **Facts grid**: label over value, 4 columns on desktop, 2 on phone, definition order. Empty values show "—",
  status fields show badges, identifiers use mono, long text spans the full row. Always on records.
- **Lines table with progress**: # · item (name, mono SKU · unit) · progress (3px bar + "{done} of {qty}") · open ·
  unit price or cost · amount. Bar is accent while partial, success when complete, empty at zero. When the definition
  has a line collection; the progress column only when the lifecycle tracks a per-line quantity.
- **Totals block**: Subtotal, one row per tax ("{tax} {rate}%"), Total + currency code, right edge on the amount
  column. With any money line collection.
- **Linked documents**: icon, mono number, "{type} · {date} · {qty} units", amount, badge. Expected-but-missing
  documents show as a neutral "Not started" row. When the definition declares linked or child types.
- **Activity list**: hairline timeline, newest first. An optional first "now" item (accent dot) states what the record
  waits for. Every event comes from a template (section 6). Always on records.
- **Dialog with impact line**: title (action), "{number} · {counterparty}", defaulted fields, line grid (open,
  quantity input, unit cost, value), an "After you post" box with before → after rows for each affected measure,
  status change and value change, footer naming the document it creates, Cancel, one primary "{Verb} {qty}".
  Phone: bottom sheet with a pinned footer.
- **Form**: at most 4 required header fields, everything else inside a "More details" disclosure whose summary lists
  the hidden field names; line editor (product combo, quantity, unit cost, computed amount, remove, Add line);
  totals; sticky bar with running total, quiet "Save draft", one primary "Save and {primary transition}". Defaults:
  today, the user's default location, the counterparty's terms and currency.
- **Table / list**: toolbar (search, location select, segmented filters with counts, one note), numeric columns
  right-aligned, footer totals only when every numeric column is additive, attention rows tinted. Phone: the table
  scrolls inside its container.
- **Empty state**: one centred line in the list body: "No {plural} match. Clear the search to see all {n}." or
  "No {plural} yet." plus the create action when allowed.
- **Tiles**: a ruled strip of 4 (2 on phone): label with icon, number, one metric line. Clickable when tied to a queue
  or list. Home shows queue tiles; lists show summary tiles for additive measures.

## 6. Rules that keep it generatable

- No per-screen prose. Every generated sentence is a template filled from the record:
  - next step, one open line: "{open} of {qty} {item} still to {verb}."
  - next step, several lines: "{open_units} units on {open_lines} lines still to {verb}."
  - detail line: "{date_label} {date} · {location_phrase}"; button: "{Verb} {open} remaining" or "{Verb} {qty}"
  - activity: "{user} {verb_past} {number}", "{user} changed {field} from {old} to {new}",
    "{user} posted {doc} · {summary}", "{user} added a note"
  - impact: "{measure} at {location}: {before} → {after}"
- Text people type (notes) appears verbatim in a Notes block with author and date, never inside a generated sentence.
- One primary button per screen: next step, dialog or form. Everything else is secondary or ghost.
- 3 fields: the facts grid fills one row and the sheet keeps its padding; no empty cells are drawn.
- 30 fields: rows of 4. Declared field groups each get an uppercase label and a hairline. Without groups, the first 12
  show and the rest sit in a "More details" disclosure, as in forms.
- Long values wrap; numbers and badges never wrap. Columns come from the definition's list columns.
- Every screen works at 390px: grids drop to 2 columns, tables scroll in their container, form lines stack, dialogs
  become bottom sheets, nothing scrolls the page sideways.
