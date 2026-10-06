import { CUSTOMER_ACCOUNT_PAGE } from './list-declarations.js';

/**
 * REPORTS-HOME: the customer account page and the Today view.
 *
 * A customer's account is the party read in one company: its invoices there
 * with what each still owes -- printed as its statement -- and its sales
 * orders. A party is shared by every company and its invoices and orders
 * belong to one, each holding the party as plain text, so each dataset is
 * scoped by that field and read in the company the page's entry chose, as
 * the item page reads its stock. The page is entered like the Invoices List
 * and authorized by that List's query; the two customer Lists open their
 * rows here (`list.record`).
 *
 * Today is a launcher Task over the Lists that already hold each piece of the
 * day's work (PaneFlow's home: late receipts, blocked sales, approvals
 * waiting, receipts due, ready to ship, inventory at risk): each tile opens
 * its List at one view and shows that view's count, asked exactly as the List
 * counts its tab, under current policy -- a count a person may not read is
 * left out, never guessed. It reads nothing else and posts nothing.
 */
const version = 'v6';

function ids(namespace: string) {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });
  const slot = (surface: string, name: string, orderKey: number) => ({
    content: ref(
      'opaqueSurfaceContentReference',
      id('capability', 'standard_surface_content'),
    ),
    kind: 'surfaceSlot',
    orderKey,
    schemaVersion: version,
    slot: name,
    slotId: id(
      'slot',
      `${surface}_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
    ),
  });
  // Entered with the caller's authorized company, as the Lists are.
  const entry = (authorization: string) => ({
    companyQueryId: id('query', 'legal_entity_list'),
    authorizationQueryId: id('query', authorization),
    companyNameFieldId: id('field', 'legal_entity_name'),
    companyStateFieldId: id('field', 'legal_entity_status'),
    activeStateId: id('option', 'legal_entity_status_active'),
    policy: 'authorizedSingleOrPreference',
  });
  return { id, ref, slot, entry };
}

/** The customer account page: a party's invoices and orders in one company. */
export function customerAccountSurface(
  namespace: string,
): Record<string, unknown> {
  const { id, ref, slot, entry } = ids(namespace);
  const f = (name: string) => id('field', name);
  const q = (name: string) => ref('queryReference', id('query', name));
  const column = (
    name: string,
    label: string,
    orderKey: number,
    field: string,
    declared: Record<string, unknown> = {},
  ) => ({
    columnId: id('column', `customer_account_${name}`),
    label,
    orderKey,
    field,
    ...declared,
  });
  const role = (kind: string, priority: number) => ({
    presentation: { role: kind, priority },
  });
  const money = { format: 'money' };
  const scopedBy = (field: string) => ({
    fieldId: f(field),
    value: { source: 'record', field: 'recordId' },
  });
  const invoice = (name: string) => f(`customer_invoice_${name}`);
  const order = (name: string) => f(`sales_order_${name}`);
  const invoices = id('dataset', 'customer_account_invoices');
  const surface = CUSTOMER_ACCOUNT_PAGE;
  return {
    archetype: 'record',
    dataSource: q('party_get'),
    kind: 'surfaceDefinition',
    label: 'Customer account',
    // Party's own record, as its query is; its sections are Sales' content.
    module: ref('moduleReference', id('module', 'party')),
    schemaVersion: version,
    slots: [
      slot(surface, 'breadcrumb', 10),
      slot(surface, 'titleStatus', 20),
      // The statement is printed from here.
      slot(surface, 'commandBar', 30),
      { ...slot(surface, 'keyFacts', 90), disclosureTier: 'always' },
      slot(surface, 'sections', 50),
      slot(surface, 'childTables', 60),
    ],
    statusRoles: [],
    surfaceId: id('surface', surface),
    surfaceRole: 'record',
    workspace: {
      membership: 'contextual',
      entry: entry('customer_invoice_list'),
    },
    composition: {
      kind: 'surfaceComposition',
      schemaVersion: version,
      presentation: {
        header: {
          title: id('column', 'customer_account_name'),
          subtitle: [id('column', 'customer_account_number')],
          facts: [
            id('column', 'customer_account_currency'),
            id('column', 'customer_account_terms'),
            id('column', 'customer_account_contact'),
          ],
        },
        context: {
          label: 'Account',
          description:
            "This customer's invoices, with what each still owes, and its sales orders, in the company chosen above. Amounts stay in each document's own currency.",
        },
        recordActions: 'progressive',
        technicalDetails: 'progressive',
        // The customer's statement (owner ruling G): every invoice in this
        // company with what was paid, credited and is still owed, printed or
        // saved as PDF by the browser. Nothing is emailed.
        print: { label: 'Statement', datasets: [invoices] },
      },
      fields: [
        column('name', 'Name', 10, f('party_name')),
        column('number', 'Party number', 20, f('party_number')),
        column('contact', 'Contact', 30, f('party_contact_summary')),
        column('currency', 'Default currency', 40, f('party_default_currency')),
        column('terms', 'Payment terms', 50, f('party_payment_terms')),
      ],
      children: [
        {
          datasetId: invoices,
          presentation: {
            selection: 'none',
            description:
              'Every invoice posted to this customer in this company, oldest first, with what was paid and credited against it and its balance. Each amount is in the invoice’s own currency.',
          },
          label: 'Invoices',
          orderKey: 10,
          query: q('customer_invoice_list'),
          sort: [{ fieldId: invoice('invoice_date'), direction: 'ascending' }],
          fieldScope: scopedBy('customer_invoice_customer_party_id'),
          columns: [
            column('invoice_number', 'Invoice', 10, invoice('number'), {
              ...role('primary', 10),
            }),
            column('invoice_date', 'Invoiced', 20, invoice('invoice_date')),
            column('invoice_due', 'Due', 30, invoice('due_date')),
            column('invoice_state', 'Status', 40, invoice('state'), {
              ...role('secondary', 40),
            }),
            column('invoice_total', 'Total', 50, invoice('total'), money),
            column('invoice_paid', 'Paid', 60, invoice('paid_amount'), money),
            column(
              'invoice_credited',
              'Credited',
              70,
              invoice('credited_amount'),
              money,
            ),
            column('invoice_balance', 'Balance', 80, invoice('balance'), {
              ...money,
              ...role('quantity', 80),
            }),
            column('invoice_currency', 'Currency', 90, invoice('currency')),
          ],
        },
        {
          datasetId: id('dataset', 'customer_account_orders'),
          presentation: {
            selection: 'none',
            compact: 'scrollTable',
            description:
              "This customer's sales orders in this company, newest first. A released order is open until it is closed.",
          },
          label: 'Sales orders',
          orderKey: 20,
          query: q('sales_order_list'),
          sort: [{ fieldId: order('order_date'), direction: 'descending' }],
          fieldScope: scopedBy('sales_order_customer_party_id'),
          columns: [
            column('order_number', 'Order', 10, order('number'), {
              ...role('primary', 10),
            }),
            column('order_date', 'Ordered', 20, order('order_date')),
            column('order_requested', 'Requested', 30, order('requested_date')),
            column(
              'order_status',
              'Status',
              40,
              id('derived_state_field', 'machine.sales_order_lifecycle'),
              { ...role('secondary', 40) },
            ),
            column('order_currency', 'Currency', 50, order('currency')),
          ],
        },
      ],
      actions: [],
    },
  };
}

/** The six counts PaneFlow's home leads with, each opening its List's view. */
export function todaySurface(namespace: string): Record<string, unknown> {
  const { id, ref, slot, entry } = ids(namespace);
  const tile = (
    name: string,
    label: string,
    description: string,
    orderKey: number,
    list: string,
    view: string,
  ) => ({
    tileId: id('launcher_tile', `sales_today_${name}`),
    label,
    description,
    orderKey,
    surface: id('surface', list),
    view: id('list_view', `${list}_${view}`),
  });
  return {
    archetype: 'task',
    dataSource: ref('queryReference', id('query', 'sales_order_list')),
    kind: 'surfaceDefinition',
    label: 'Today',
    launcher: {
      kind: 'surfaceLauncher',
      schemaVersion: version,
      tiles: [
        tile(
          'late_receipts',
          'Late receipts',
          'Purchase orders past their expected date with something still to arrive.',
          10,
          'expected_receipt_list',
          'late',
        ),
        tile(
          'blocked_sales',
          'Blocked sales orders',
          'Released orders short of the stock they need now.',
          20,
          'sales_order_list',
          'blocked',
        ),
        tile(
          'approvals',
          'Approvals waiting',
          'Purchase order approvals waiting for a decision.',
          30,
          'purchase_order_approval_list',
          'pending',
        ),
        tile(
          'receipts_due',
          'Receipts due',
          'Released purchase orders with something still to arrive.',
          40,
          'expected_receipt_list',
          'to_receive',
        ),
        tile(
          'ready_to_ship',
          'Ready to ship',
          'Released orders with reserved stock still to ship.',
          50,
          'sales_order_list',
          'reserved',
        ),
        tile(
          'inventory_risks',
          'Inventory risks',
          'Items at or below their reorder point once incoming and open demand are counted.',
          60,
          'item_buying_list',
          'to_buy',
        ),
      ],
    },
    module: ref('moduleReference', id('module', 'sales')),
    schemaVersion: version,
    slots: [
      slot('sales_today', 'decision', 10),
      slot('sales_today', 'scanInput', 20),
      slot('sales_today', 'primaryAction', 30),
    ],
    statusRoles: [],
    surfaceId: id('surface', 'sales_today'),
    // A destination of its own in the Sales group, entered with the caller's
    // company and authorized by the Sales orders List's query.
    workspace: { membership: 'operational', entry: entry('sales_order_list') },
  };
}
