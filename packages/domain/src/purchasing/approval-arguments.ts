export type ApprovalAction =
  'submit' | 'release' | 'amend' | 'approve' | 'reject';
export function approvalAction(operation: string): ApprovalAction | undefined {
  const actions: Record<string, ApprovalAction> = {
    purchase_order_submit: 'submit',
    purchase_order_release: 'release',
    purchase_order_line_amend: 'amend',
    purchase_order_approval_approve: 'approve',
    purchase_order_approval_reject: 'reject',
  };
  return actions[operation];
}
export function validateApprovalArguments(
  operation: string,
  args: unknown,
): void {
  const action = approvalAction(operation);
  if (!action) throw new Error('Unsupported approval operation');
  checkApprovalArguments(action, args);
}
export function checkApprovalArguments(
  action: ApprovalAction,
  args: unknown,
): void {
  const invalid = (message: string): never => {
    throw new Error(message);
  };

  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Capability arguments must be an object');
  const allowed =
    action === 'release'
      ? ['supplierReference']
      : action === 'amend'
        ? ['quantity', 'reason']
        : action === 'approve' || action === 'reject'
          ? ['reason']
          : [];
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    invalid('Unsupported purchase-order approval argument');
  const parsed = args as Record<string, unknown>;
  if (
    action === 'approve' ||
    action === 'reject' ||
    (action === 'amend' && 'quantity' in parsed)
  ) {
    if (
      typeof parsed.reason !== 'string' ||
      !parsed.reason.trim() ||
      parsed.reason.length > 1000
    )
      invalid('A reason of 1-1000 characters is required');
  }
  if (
    action === 'release' &&
    parsed.supplierReference !== undefined &&
    parsed.supplierReference !== null &&
    (typeof parsed.supplierReference !== 'string' ||
      parsed.supplierReference.length > 80)
  )
    invalid('Supplier reference must be at most 80 characters');
  if (
    action === 'amend' &&
    'quantity' in parsed &&
    (typeof parsed.quantity !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(parsed.quantity))
  )
    invalid('Ordered quantity must be a non-negative exact decimal');
}
