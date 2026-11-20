/** Text fields used as record references by the shipped modules. Typed relations
 * use the target declared in the pinned operation contract instead. */
const fieldsByTarget: Readonly<Record<string, readonly string[]>> = {
  party: [
    'customer_invoice_customer_party_id',
    'party_default_salesperson_party_id',
    'price_list_assignment_party_id',
    'purchase_order_supplier_party_id',
    'sales_order_customer_party_id',
    'sales_order_salesperson_party_id',
    'vendor_bill_supplier_party_id',
  ],
  party_address: [
    'party_default_ship_to_address_id',
    'sales_order_ship_to_address_id',
  ],
  item: [
    'customer_invoice_line_item_id',
    'goods_receipt_line_item_id',
    'inventory_transaction_line_item_id',
    'price_list_entry_item_id',
    'purchase_order_line_item_id',
    'reservation_item_id',
    'sales_order_line_item_id',
    'shipment_line_item_id',
    'stock_count_line_item_id',
    'vendor_bill_line_item_id',
  ],
  location: [
    'goods_receipt_location_id',
    'inventory_transaction_line_from_location_id',
    'inventory_transaction_line_to_location_id',
    'item_preferred_location_id',
    'purchase_order_receiving_location_id',
    'reservation_location_id',
    'shipment_location_id',
    'stock_count_location_id',
  ],
  tax_code: [
    'party_default_tax_code_id',
    'purchase_order_freight_tax_code_id',
    'purchase_order_line_tax_code_id',
    'purchase_order_other_fee_tax_code_id',
    'purchase_order_tax_code_id',
    'sales_order_freight_tax_code_id',
    'sales_order_line_tax_code_id',
    'sales_order_other_fee_tax_code_id',
    'sales_order_tax_code_id',
  ],
  inventory_movement: [
    'goods_receipt_line_reversal_of_movement_id',
    'shipment_line_reversal_of_movement_id',
    'stock_count_line_reversal_of_movement_id',
  ],
  price_list: ['sales_order_line_price_list_id'],
};

export const referenceTargets = new Map<string, string>(
  Object.entries(fieldsByTarget).flatMap(([entity, fields]) =>
    fields.map(
      (field) =>
        [
          `northstar.app:field.${field}`,
          `northstar.app:entity.${entity}`,
        ] as const,
    ),
  ),
);

/** An edit is reversible only when the owning record is visible in this state. */
export const parentEditApprovals = new Map([
  [
    'northstar.app:entity.stock_count_line',
    {
      relationId: 'northstar.app:relation.stock_count_line_session',
      queryId: 'northstar.app:query.stock_count_get',
      stateFieldId: 'northstar.app:field.stock_count_state',
      reversibleStateId: 'northstar.app:option.stock_count_state_draft',
      reason: 'Editing a count outside draft needs your OK.',
    },
  ],
]);
