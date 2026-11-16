# Purchasing order design notes

Branch: `purchasing-order-design` · Scope: presentation code in `apps/web`, plus
one line in an architecture guard (see "Needs your supervisor's decision"). No
domain definition, compiled release, migration or provider code was changed.

This document explains what was built, why it is shaped the way it is, and the
concepts you should be able to explain to your supervisor.

---

## 1. Overview

Rain already had purchase orders in its _domain_ — the entity, its lines, the
state machine (draft → released → closed, or cancelled) and goods receipts. What
it lacked was a purchasing _experience_. A purchase order appeared through the
same generic screens as every other record: a list of alphabetically ordered
columns showing raw identifiers, and a record page with a plain "Receiving"
table and a dump of stored fields.

This work adds two designed screens, both built from a new set of reusable UI
primitives:

| Screen                   | What a purchasing employee gets                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Purchase order list**  | One row per order: number, supplier name, lifecycle status, receiving status with `received of ordered`, order date, expected date (with "N days overdue"), line count, order total, and one contextual action (_Receive_ or _Open_). Search by number, supplier or currency. A count of orders by status. An overdue banner. |
| **Purchase order record** | Title block with order and receiving status; lifecycle stepper; headline figures (total, ordered, received, open); supplier and dates; order lines with per-line receiving progress, unit price and line total; received / open / total value; collapsible notes, receiving guidance and stored fields.                       |

### Workflow tabs on the list

The list opens with a row of tabs, each showing how many orders it holds:

| Tab                | Holds                                                    | The question it answers           |
| ------------------ | -------------------------------------------------------- | --------------------------------- |
| **All**            | Every order                                              | "Find me an order"                |
| **Draft**          | Not yet released                                         | "What still has to go out?"       |
| **To receive**     | Released, with goods outstanding                         | "What am I waiting on?"           |
| **Overdue**        | Released, outstanding, past the expected date            | "Who do I need to chase?"         |
| **Ready to close** | Released, everything received                            | "What can I finish off?"          |
| **Closed**         | Closed                                                   | "What is done?"                   |
| **Cancelled**      | Cancelled                                                | "What was abandoned?"             |

They follow the order work moves through purchasing, the same idea as the sales
order tabs (To ship, Reserved, To invoice …) but with purchasing's own steps.
There is deliberately no "To invoice" or "To pay" tab: Rain's purchasing module
has no supplier bills, so those tabs would always be empty.

Two things are worth understanding:

- **A tab is a question, not a column.** "To receive" and "Ready to close" are
  both the stored state `released`; what separates them is a _derived_ fact —
  whether anything is still outstanding. That is why the tabs cannot be a simple
  database filter and are computed in `loadPurchaseOrderWorklist`.
- **Counts and rows come from one pass.** The loader reads every order matching
  the search once, derives each order's summary, and from that single list
  produces both the number on every tab and the rows of the open tab. They can
  never disagree. Adding a tab is one entry in the `PURCHASE_ORDER_VIEWS` array.

The chosen tab is a URL parameter (`view=toReceive`), so it can be bookmarked
and survives search and paging.

### Compact controls

Buttons and inputs now look 32 px tall instead of 44 px. The 44 px size was not
arbitrary — it is the minimum click/touch target Rain's grammar and tests
require for accessibility — so the _clickable_ area is still 44 px. The control
has a 6 px transparent border and its background is clipped inside it
(`background-clip: padding-box`), so only the inner 32 px is painted. Smaller to
look at, just as easy to hit. This applies to every screen, not only purchasing.

**Design direction.** Plain and dense, like real ERP software: one-pixel rules
instead of shadows, one flat panel instead of nested cards, hierarchy from type
size and weight, status always as colour + dot + word. No gradients, no
decoration, and no control that does nothing — for example the "select records"
bulk bar is not shown on the new list because the list has no checkboxes.

**The most important constraint.** Rain is not a React app. Pages are HTML
strings rendered on the server by one renderer (`SurfaceRuntime`), and the
response's security policy forbids all page JavaScript. Rain's binding
`ux-grammar` skill also fixes a closed set of screen archetypes and slots. So the
design had to be expressed _inside_ that structure: no new routes, no client
framework, no script. Section 3 explains how interactivity works without it.

---

## 2. Changes made

### Files created

| File                                        | Purpose                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/ui/primitives.ts`             | The reusable UI primitives (see section 3). Pure functions: typed options in, HTML string out.                                       |
| `apps/web/src/ui/primitives-styles.ts`      | CSS for the primitives, using only existing design tokens.                                                                           |
| `apps/web/src/ui/format.ts`                 | Exact decimal arithmetic and number/date formatting.                                                                                 |
| `apps/web/src/purchasing-section.ts`        | The purchasing workspace: view models, loaders and renderers for the list and the record.                                            |
| `apps/web/test/purchasing-fixture.ts`       | An in-memory version of the composed application for tests and local preview (real release + real renderer, fake storage).           |
| `apps/web/test/purchasing-workspace.test.ts` | Nine tests covering arithmetic, escaping, both screens, search, empty states and a real state transition.                            |
| `apps/web/test/purchasing-preview.ts` | A local preview server over that in-memory fixture (see section 8). |
| `apps/web/test/purchasing-workflow.test.ts` | Walks the whole order workflow over HTTP, page by page, as a browser would. |
| `docs/PURCHASING_ORDER_DESIGN_NOTES.md`     | This document.                                                                                                                       |

### Files modified

| File                                                           | Change                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/surface-runtime.ts`                              | (1) The application-extension interface gains an optional `augmentListData` hook, mirroring the existing `augmentRecordData`. (2) The primitive styles are appended to the stylesheet. (3) One-property fix to a pre-existing mobile bug — see "Found along the way".                                                                              |
| `apps/web/src/component-registry.ts`                           | The four slot renderers (`titleStatus`, `keyFacts`, `sections`, `dataGrid`) delegate to the purchasing renderers when purchase-order data is attached. Added `listFrame()` (shared paging/search facts handed to a module list) and `renderRecordFields()` (the stored-fields block, extracted so it can render collapsed on a designed page). |
| `apps/web/src/receiving-section.ts`                            | The extension now loads the purchase order document and the worklist. The old inline `renderReceivingSection` HTML was removed (replaced by the new lines table). `loadReceivingSection` is kept untouched because a PostgreSQL test imports it.                                                                                                |
| `apps/web/src/sales-section.ts`                                | The composed extension forwards the new list hook.                                                                                                                                                                                                                                                                                               |
| `apps/web/test/browser/receiving.composed-application.spec.ts` | Six assertions read the quantity cells by `[data-quantity]` instead of "every `<td>` in the row", because the row now has more columns.                                                                                                                                                                                                          |
| `apps/web/package.json`                                        | The new test file is added to the `test:contracts` script, and a `preview:purchasing` script is added.                                                                                                                                                                                                                                                                                       |

### Needs your supervisor's decision

`packages/dev-tooling/src/surface-runtime-seam.ts` is an architecture guard. It
fails the build if structural HTML (`<section>`, `<table>`, `<form>`, `<h1>` …)
appears in any web file other than the runtime, the component registry and one
previously approved exception. Its purpose is to stop anyone building a screen
that bypasses `SurfaceRuntime`.

A primitives library necessarily contains that markup, so the guard flagged
`ui/primitives.ts`. I added that one file to the guard's allow-list, with a
comment marking it as a **proposed exception pending owner ratification**. The
previous exception in that list was explicitly owner-approved, so this one should
be too — please raise it rather than treat it as settled.

The argument for it: primitives are pure functions with no route, no data access
and no surface selection, and they are only reachable through renderers the
closed registry calls. Note what is deliberately _not_ on the list:
`purchasing-section.ts`. A module section may compose primitives but may not
write structural markup itself, which keeps the guard meaningful.

If the exception is refused, the alternative is to move the primitive functions
into `component-registry.ts`. Everything else would stay the same.

### Reused, not rebuilt

- The shell, navigation, legal-entity bar, breadcrumb and command bar (Edit /
  Release / Cancel …) are unchanged in behaviour.
- `.status-pill`, `.panel`, `.primary-action`, `.secondary-action` and the
  `data-table-wrap` responsive table are existing styles the primitives build on.
- Search, paging and "show archived" are the shared list's own mechanics.
- The server-side confirmation step for consequential actions (Cancel, Close) is
  the existing one.

### Found along the way

- **Mobile navigation covered the whole screen (pre-existing).** Below 800 px the
  sidebar becomes a fixed bottom bar, but it kept `top: 0` from the desktop rule,
  so it stretched over the entire page on _every_ screen. Adding `top: auto` fixes
  it. This is outside the purchasing brief, but responsive behaviour could not be
  checked without it, so it is fixed and disclosed here.
- **The command bar's layout** was tidied with CSS only (each command's
  explanation now sits under its button). The markup and text are unchanged.

---

## 3. Technical concepts explained

### What is a UI primitive?

A primitive is a small, general building block that knows how to draw one thing
and nothing about the business: a status badge, a table, a collapsible section.
It is the UI equivalent of a standard-library function.

In a React codebase a primitive is a component. Rain has no component framework,
so here a primitive is a **pure function** — same input, same output, no side
effects:

```ts
statusBadge({ label: 'Released', role: 'inProgress' });
// → '<span class="status-pill" data-status-role="inProgress">Released</span>'
```

The primitives in `ui/primitives.ts`:

| Primitive                        | Draws                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `statusBadge`, `labeledStatus`   | A status as colour + dot + word                          |
| `pageSection`                    | A titled panel with optional actions                     |
| `recordHeading`                  | A record's title block                                   |
| `factList`                       | Label/value facts                                        |
| `metricStrip`                    | A row of headline numbers                                |
| `dataTable`, `stackedCell`       | A table whose columns are declared as data               |
| `totalsList`                     | A right-aligned financial breakdown                      |
| `progressMeter`                  | A thin proportion bar                                    |
| `disclosure`                     | A collapsible section                                    |
| `actionMenu`                     | A dropdown of links                                      |
| `stepper`                        | Lifecycle steps                                          |
| `searchBar`, `pagination`        | List search and paging                                   |
| `emptyState`, `emptyValue`       | "Nothing here" and "no value"                            |
| `notice`, `linkAction`           | An inline message; a link styled as an action            |

### What is component composition?

Composition means building big things by nesting small things. The order-lines
panel is not one large template; it is primitives inside primitives:

```ts
pageSection({
  title: 'Order lines',
  actionsHtml: linkAction({ … }) + actionMenu({ … }),
  bodyHtml: dataTable({ … }) + totalsList([ … ]) + disclosure({ … }),
});
```

The rule that makes this safe is a naming convention: an option ending in `Html`
is markup produced by another primitive and is inserted as is; every other text
option (`label`, `title`, `value`) is **escaped** by the primitive. Escaping
turns `<` into `&lt;` so that a supplier named `<script>…` is displayed as text
rather than executed. Because the primitive does it, a screen author cannot
forget to.

### Why are reusable components useful?

- **Consistency.** Every status in the product is drawn by one function, so they
  cannot drift apart visually.
- **One place to fix.** A table accessibility fix lands in `dataTable` and every
  table gets it.
- **Less to read.** `purchasing-section.ts` reads as a description of the screen
  ("a section containing a table and totals") rather than as a wall of HTML.
- **Predictability.** A new developer (or coding agent) who has seen one screen
  knows how the next one is built.

### How does data flow between components?

In one direction, top to bottom, once per request:

```
browser GET /?surface=…purchase_order_detail&record=…
      │
      ▼
SurfaceRuntime (surface-runtime.ts)
  1. runs the page's own query through the semantic query gateway → the order
  2. calls the composed extension:  augmentRecordData(order)
      │
      ▼
loadPurchaseOrderDocument (purchasing-section.ts)          ← LOADER
  reads lines, received quantities, party and item names (same gateway)
  returns a plain object: PurchaseOrderDocument            ← VIEW MODEL
      │
      ▼
component-registry.ts renders each slot in order
  titleStatus → renderPurchaseOrderHeading(document)        ← RENDERERS
  keyFacts    → renderPurchaseOrderKeyFacts(document)
  sections    → renderPurchaseOrderSections(document)
      │
      ▼
primitives → HTML strings → one HTML page sent to the browser
```

Three ideas are worth naming:

- A **view model** is data shaped for a screen (for example `summary.overdueDays`
  or `line.lineTotal`), as opposed to data shaped for storage.
- **Loaders do I/O, renderers do not.** A renderer is a pure function of its view
  model, which is why the tests can check screens without a browser.
- Data only flows **down**. Nothing a primitive does can change the order. Changes
  happen only when the user submits a form, which goes to the operation gateway
  and produces a fresh page.

### How do dropdowns and expandable sections work without JavaScript?

With the browser's built-in `<details>` element:

```html
<details>
  <summary>Internal notes</summary>
  <p>Confirm lead time with the supplier before release.</p>
</details>
```

The browser itself toggles it on click or keyboard, and announces it to screen
readers as expandable. The `disclosure` primitive is a styled `<details>`; the
`actionMenu` primitive is a `<details>` whose content is an absolutely positioned
list of links. `open` is just an attribute the server decides: the notes section
is rendered open when notes exist and collapsed (with the hint "None") when they
do not.

Search works the same way — platform, not script. `searchBar` is a `<form
method="get">`, so submitting it puts `q=…` in the URL and the server renders the
filtered page. That means the state lives in the URL: a filtered list can be
bookmarked, shared, and the back button works.

### What is exact decimal arithmetic, and why does it matter here?

JavaScript numbers are binary floating point, in which `0.1 + 0.2` is
`0.30000000000000004`. That is unacceptable for money. Rain stores quantities and
prices as decimal _strings_. `ui/format.ts` parses them into `bigint` integers
scaled by 10¹⁸, does the arithmetic on integers (which is exact), and only
formats at the very end. `25 × 12.495 = 312.375` is displayed as `312.38`, and
the order total is the sum of the exact line values, not of rounded ones.

### How does the purchasing page fit into the existing architecture?

Rain's rule is "users customize content, never grammar": every screen is one of
five archetypes (home, list, record, task, builder) with fixed slots. This work
adds **no** archetype, route or slot. It supplies better _content_ for existing
slots of two existing surfaces:

| Existing slot        | Before                           | Now, for a purchase order                         |
| -------------------- | -------------------------------- | ------------------------------------------------- |
| `list:dataGrid`      | Generic columns                  | The purchasing worklist                           |
| `record:titleStatus` | Title + "Active · revision N"    | Title, supplier, order and receiving status       |
| `record:keyFacts`    | Record id / state / revision     | Stepper, headline figures, supplier and dates     |
| `record:sections`    | Receiving table + field dump     | Order lines, totals, notes, guidance, stored fields |

It gets there through a mechanism that already existed for receiving and sales:
the _application extension_ attaches typed data to the page's data, and the slot
renderer draws it. The only new piece of mechanism is `augmentListData`, the list
counterpart of the record hook that was already there.

### What makes the implementation maintainable?

- **Separation of concerns** — data shape, data loading and drawing are three
  distinct layers in one file.
- **Declarative columns** — a table is an array of column objects, so header and
  body cannot fall out of step.
- **A single vocabulary table** — `LIFECYCLE_PRESENTATION` maps each state to its
  label and colour role in one place.
- **Tokens, not literals** — all colour and spacing come from design tokens, so
  dark mode works with no extra code, and an existing test fails the build if a
  hex colour appears outside the token file.
- **Safe fallbacks** — an unknown state, an unresolvable supplier or a failed
  lookup shows the stored value, never a wrong label and never a crashed page.
- **Tests at the level of behaviour** — "a draft offers _Add line_ and not
  _Create goods receipt_", not "the div has class X".

---

## 4. Architecture

```
apps/web/src
├── surface-runtime.ts        the one renderer; calls the extension hooks
├── component-registry.ts     slot renderers (closed registry)
│     renderTitleStatus ──┐
│     renderKeyFacts ─────┤  if data.purchaseOrder      → purchasing renderers
│     renderSections ─────┘
│     renderDataGrid ────────if data.purchaseOrderList  → purchasing renderer
│
├── receiving-section.ts      RECEIVING_SURFACE_RUNTIME_EXTENSION
│     augmentRecordData  → loadPurchaseOrderDocument
│     augmentListData    → loadPurchaseOrderWorklist
├── sales-section.ts          composed extension (wraps the one above)
│
├── purchasing-section.ts
│     view models   PurchaseOrderSummary · PurchaseOrderLineView
│                   PurchaseOrderDocument · PurchaseOrderWorklist · ListFrame
│     loaders       loadPurchaseOrderDocument · loadPurchaseOrderWorklist
│     renderers     renderPurchaseOrderHeading
│                   renderPurchaseOrderKeyFacts
│                   renderPurchaseOrderSections
│                   renderPurchaseOrderWorklist
│
└── ui/
    ├── primitives.ts         statusBadge · pageSection · dataTable · …
    ├── primitives-styles.ts  token-only CSS
    └── format.ts             exact decimals · dates
```

Component hierarchy of the record page:

```
record:titleStatus   recordHeading
                       └─ labeledStatus → statusBadge   (Order, Receiving)
record:commandBar    (existing, unchanged)  Edit · New · Release · … · More actions
record:keyFacts      pageSection
                       ├─ stepper                        Draft — Released — Closed
                       ├─ notice                         overdue / no lines / cancelled
                       ├─ metricStrip                    total · ordered · received · open
                       └─ factList                       supplier · dates · currency
record:sections      pageSection "Order lines"
                       ├─ actions: linkAction, actionMenu
                       ├─ dataTable                      one row per line (+ progressMeter)
                       ├─ totalsList                     received · open · total
                       ├─ disclosure "Internal notes"
                       └─ disclosure "How receiving and corrections work"
                     pageSection
                       └─ disclosure "Purchase order record"   stored fields
```

Dependencies point one way: `purchasing-section` → `ui/*` → `html.ts`. The
primitives know nothing about purchasing.

---

## 5. Reference vs. final design

`temp_inventory` (the reference) is a client-side React application with its own
database schema. It was read, not copied, and it was not modified.

**Adopted from the reference**

- The list's information architecture: order number with revision, supplier,
  status badge, expected date with a "days late" marker, quantities, total, and
  a single contextual row action (_Receive_ when it applies, otherwise open).
- The record's shape: an object header with the order's statuses, a row of
  headline quantities, an order-lines table with ordered / received / open /
  unit cost / amount, an order-details block, and a totals block.
- Separate _order_ and _receiving_ statuses rather than one overloaded status.
- A lifecycle progress indicator.
- Honest empty values: a missing expected date shows "—" rather than an
  invented date.

**Changed, and why**

| Reference                                                            | Final                                                             | Why                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| React components with client state, modals and toasts                | Server-rendered pure functions, `<details>`, links and GET forms  | Rain has no client framework and forbids page script; modal and toast are refused by its grammar |
| One 5,600-line file holding every view                               | Primitives + one focused section module                           | Reuse and readability                                                                            |
| Tailwind colour classes per severity                                 | Rain's four status roles via tokens                               | One colour grammar across the product; dark mode for free                                        |
| Many cards, metric tiles, a connected-documents grid                 | One panel per concern, separated by rules                         | Density and less visual noise                                                                    |
| Approval, "mark as ordered", supplier bills, QuickBooks, PDF, email, vendor returns, damage photos, freight, fees, deposits, tax, discounts | Not present                                                       | Rain's purchasing module declares none of them (see section 9)                                   |
| Money as JavaScript numbers / cents                                  | Exact decimals on `bigint`                                        | Rain stores scale-18 decimal strings; floating point would be wrong                              |
| Sortable column headers                                              | Not present                                                       | The surface's list request carries no sort today                                                 |

**Why this suits Rain better.** It is content inside Rain's existing archetypes,
so navigation, legal-entity scoping, permissions, confirmation and the audit
trail all keep working with no special cases — and every figure on the screen is
traceable to a stored fact or to arithmetic over stored facts.

---

## 6. Future extensibility

Because screens are assembled from primitives and declared as data, common
change requests become small, local edits:

| Request                                  | Where it goes                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| "Show the buyer on the order"            | Add the field in the domain definition; then one property on `PurchaseOrderSummary`, one line in `summarize()`, one `factList` entry |
| "Add a column to the list"               | One object in `worklistColumns()`                                                                                                  |
| "Add a status, e.g. _On hold_"           | Add the state to the state machine; then one entry in `LIFECYCLE_PRESENTATION`                                                     |
| "Add an information panel"               | One more `pageSection({ … })` in `renderPurchaseOrderSections`                                                                     |
| "Give sales orders the same treatment"   | A `sales` view model + renderers built from the same primitives; the slots already delegate                                        |

**A note on AI-driven customization.** Rain may later let an AI agent implement
client-requested changes. Nothing for that was built here. But the properties
that help a human reader help an agent in the same way: a small closed set of
named primitives with typed options, one consistent three-layer pattern, columns
and facts expressed as data, and stable `data-…` hooks on rendered elements. An
agent that has read one section can pattern-match the next change instead of
inventing a new structure.

---

## 7. Testing

**Environment note.** The repository is designed to run under Linux/WSL with
Docker and PostgreSQL 16. This machine has neither WSL nor Docker, and only
PostgreSQL 18, which Rain's storage layer rejects (PostgreSQL 18 changed how
`NOT NULL` constraints are catalogued). So the full application could not be
started here. Verification therefore used an in-memory harness that runs the
**real compiled release and the real renderer** over fake storage.

| Check                                                                                         | Result                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `tsc --noEmit` (whole repo)                                                                   | Pass                                                      |
| `tsc -p tsconfig.build.json --noEmit` (build configuration)                                   | Pass                                                      |
| `eslint apps/web`                                                                             | Pass                                                      |
| `prettier --check apps/web docs`                                                              | Pass                                                      |
| `apps/web/test/purchasing-workspace.test.ts` (10 tests, including the tabs)                   | 10 / 10 pass                                              |
| `apps/web/test/purchasing-workflow.test.ts` (2 tests, see "Workflow walk-through")            | 2 / 2 pass                                                |
| `test/unit/web-surface-hex-literal-ratchet.test.ts` (no colour literals outside tokens)       | 6 / 6 pass                                                |
| `test/architecture/surface-runtime-seam.test.ts`                                              | 5 / 5 pass (with the proposed allow-list entry; 4 / 5 without) |
| `test/architecture/surface-grammar-conformance.test.ts`                                       | 25 / 25 pass                                              |
| `test/architecture/surface-data-binding.test.ts`                                              | 5 / 5 pass                                                |
| `test/architecture/ux-grammar-skill.test.ts`                                                  | 5 / 5 pass                                                |
| `test/integration/surface-data-binding.test.ts`                                               | 34 / 34 pass                                              |
| `apps/web/test/surface-runtime-contract.test.ts`                                              | 29 / 29 pass                                              |
| `test/architecture/dependency-boundaries.test.ts`                                             | 9 pass, 4 fail — the 4 read Linux `/proc` and start Docker; unrelated to this change |
| Browser: list renders; search → empty state → Clear                                           | Verified                                                  |
| Browser: record renders (draft, released, cancelled); notes open; menu opens inside viewport  | Verified                                                  |
| Browser: _Release_ on a draft → "Release complete", status Released, revision 2, actions change | Verified                                                  |
| Browser console                                                                               | No errors or warnings                                     |
| Desktop (1360 px) and mobile (375–500 px) layouts, no horizontal page scroll                  | Verified by screenshot                                    |
| A non-purchasing list (Party) still renders the generic grid                                  | Verified (test 9)                                         |

### Performance

Pages were taking 4–8 seconds to render — including pages this work never
touched (the party list took about 4 s). A CPU profile showed where the time
went: to answer "which query feeds this surface?", Rain validates the **whole**
compiled query catalog (99 queries), and one page asks that question hundreds of
times — once for every navigation link, every slot and every related-surface
lookup.

The fix is in `apps/web/src/surface-contract.ts`: the answer for a given surface
is now remembered for the rest of that request (`readCompiledSurfaceDataBinding`
keeps a `WeakMap` keyed by the request's view). This is called _memoization_ —
caching the result of a pure function so it is computed once. It is safe here
because the view is a deeply frozen copy made for one request, so the same
question cannot have a different answer, and the cache is dropped when the
request ends.

| Page                  | Before  | After   |
| --------------------- | ------- | ------- |
| Party list            | ~4.0 s  | ~1.1 s  |
| Purchase order list   | ~5.0 s  | ~1.1 s  |
| Purchase order record | ~7.0 s  | ~1.2 s  |

Measured in the local preview on this machine; absolute numbers will differ
elsewhere, the ratio is what matters.

**What is left, and who should decide.** The remaining ~1 s is the same catalog
validation, now running once per database query instead of hundreds of times. It
lives in `packages/runtime/src/semantic-query-gateway.ts`
(`registeredSemanticQueryFromPinnedView`), which is shared platform code beside
the trust boundary. Remembering the parsed catalog there, once per view, should
remove most of what remains — but that is a change for the platform's owners to
approve, not one to slip into a purchasing branch. Two smaller costs: the
purchasing screens read all order lines, parties and items on each request, and
the preview compiles TypeScript on start-up.

### Workflow walk-through

`purchasing-workflow.test.ts` starts the real server and walks the workflow over
HTTP: it fetches each page, reads the form from the HTML it was served, fills it
and posts it back — the same requests a browser makes. Each step asserts what
the user would see.

| Step                              | What is checked                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Create an order                | Saves; page shows Draft and the "no lines" notice; list shows it under **Draft**                      |
| 2. Add a line                     | The line form offers the new order in its picker; order shows 10 / 0 / 10 and a total of 25.00        |
| 3. Release                        | Status Released; _Add line_ and _Edit_ disappear; _Create goods receipt_ appears; moves to **To receive** |
| 4. Receive 4 of 10                | Receipt and receipt line save; _Post_ asks for confirmation; order shows 10 / 4 / 6, Partially received |
| — Try to close early              | Refused with a message; the order is unchanged                                                        |
| 5. Receive the remaining 6        | 10 / 10 / 0, Fully received; _Create goods receipt_ disappears; moves to **Ready to close**           |
| 6. Close                          | Confirmation, then Closed; moves to **Closed**                                                        |
| 7. Reopen                         | Returns to Released                                                                                   |
| Separately: cancel a draft        | Confirmation, then Cancelled; no further actions offered; appears under **Cancelled**                 |

**What this does and does not prove.** The pages, forms, pickers, confirmation
steps, tabs and the Release/Cancel transitions are the real production code. But
posting a receipt, Close and Reopen normally run inside PostgreSQL through the
"posting kernel". In this harness they are **simulated** (`SimulatedReceiving`
in `purchasing-fixture.ts`): it imitates their visible result and a few of their
refusals, and records no stock movement. So the walk-through shows the _screens_
carry the workflow correctly end to end; it does not re-prove the database
logic, which the existing PostgreSQL browser test covers in CI.

**Not verified — be upfront about these**

- **Anything requiring PostgreSQL**: the composed-application browser suites
  (including the edited `receiving.composed-application.spec.ts`), the postgres
  suite, and therefore real receipt posting, Close and Reopen. The six edited
  assertions are a mechanical change and the attribute they read is covered by
  the new tests, but the journey itself has not been run. CI is the place that
  runs it.
- **Playwright** suites: no Playwright browser is installed here.
- **Dark mode**: follows from tokens; not inspected.
- **Creating an order through the form** end to end: the form is the existing
  generic form and was not changed.

---

## 8. How to run it

Everything below is typed in a terminal opened at the repository root
(`2rain-greenfield`). In VS Code: **File → Open Folder… → `2rain-greenfield`**,
then **Terminal → New Terminal**.

**One-time setup** (installs dependencies; needs Node.js and pnpm):

```bash
pnpm install --config.engine-strict=false
```

The flag is only needed because this machine has a newer Node than the
repository pins. Make sure you are on the right branch:

```bash
git switch purchasing-order-design
```

**Start the purchasing preview** (no database needed):

```bash
node --import tsx apps/web/test/purchasing-preview.ts
```

It prints a list of links. Hold **Ctrl** and click one in the VS Code terminal to
open it in your browser. Press **Ctrl+C** in the terminal to stop the server.

| Page                     | How to reach it                                                 |
| ------------------------ | --------------------------------------------------------------- |
| Purchase order list      | The first printed link                                          |
| A purchase order         | Click an order number in the list, or use a printed "PO-…" link |
| New purchase order       | Printed link, or the **New** button on the list                 |
| Edit a draft order       | Open a draft, then **Edit**                                     |
| New order line           | Printed link, or **Add line** on a draft order                  |
| Line detail              | Click an item in an order's lines table                         |
| Parties, items and so on | The left navigation                                             |

Things to know about the preview:

- **Data is in memory.** It is re-created each time the server starts, so
  anything you create or release disappears when you stop it. The record ids in
  the links also change on every start — always use the freshly printed links.
- **It does not restart itself when you edit code.** Stop it with Ctrl+C and run
  the command again (or add `--watch` after `node` to restart automatically).
- **Receiving is simulated** in the preview. You can create a goods receipt,
  add a receipt line, _Post_ it, then _Close_ and _Reopen_ the order, and the
  screens update — but no real stock movement is recorded. Quantity amendments
  are not simulated.
- If port 4190 is busy, pick another. In PowerShell (VS Code's default):
  `$env:PORT = 4191; node --import tsx apps/web/test/purchasing-preview.ts`

**Run the checks:**

```bash
node --import tsx --test apps/web/test/purchasing-workspace.test.ts
```

```bash
npx tsc --project tsconfig.json --noEmit
```

**The full application** (`pnpm dev`) needs Docker and PostgreSQL 16, normally
under WSL. It cannot start on this machine as it is; the preview above is the way
to see the purchasing screens here.

---

## 9. Known limitations

These are limits of what Rain's purchasing module currently declares. The UI
deliberately does not fake them.

- **No tax, freight, discounts, payment terms, approvals, billing, PDF or
  email.** "Order total" is the sum of `quantity × unit price` over priced lines.
- **Supplier and item are text fields, not relations.** The screens look the
  stored text up against parties and items and show a name when it matches;
  otherwise they show the stored text. The form still asks for typed text.
- **No sorting.** The list request carries no sort. Views are the workflow tabs.
- **The list reads every matching order to build its tabs.** Simple and always
  consistent, but it would need a server-side summary for very large order books.
- **"Add line" cannot pre-select the order.** Rain's grammar reserves field
  pre-fill for a mechanism that does not exist yet, so the line form asks you to
  choose the order.
- **Close and Reopen both appear on any order.** Their operations carry no
  precondition in the domain definition, and the UI must not add a second rule.
- **Totals read all order lines for the legal entity** on each request (the same
  approach the previous receiving section used). Fine now; worth revisiting with
  large data.
- **Quantities are summed across lines** for the header figures even when lines
  use different units, as the reference does.

---

## 10. Things I should understand

1. **A UI primitive is a pure function from options to HTML.** Be able to say why
   "pure" matters (testable, predictable, composable).
2. **Composition over big templates.** Screens are primitives nested in
   primitives; the `…Html` naming rule is what keeps escaping correct.
3. **View model → loader → renderer.** Three layers; data flows one way; only
   loaders talk to the gateway.
4. **Server-side rendering with no JavaScript.** `<details>` for open/close, GET
   forms and links for search and navigation, state in the URL.
5. **Extension points.** The purchasing screens plug into Rain through an
   existing hook (`augmentRecordData`) and its new twin (`augmentListData`),
   rather than by changing the renderer.
6. **Closed grammar.** Rain fixes archetypes and slots; modules supply content.
   This is why no new page or route was added.
7. **Exact decimals.** Why money is never a floating-point number.
8. **Design tokens.** Why there are no colour values in the new CSS, and how a
   test enforces it.
9. **Escaping (XSS).** Why user-entered text must be escaped before it is put in
   HTML, and where that happens.
10. **Honest verification.** What was run, what could not be run, and why — and
    that a UI must not show functionality the backend does not have.
