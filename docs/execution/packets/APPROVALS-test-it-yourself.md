# APPROVALS — Test it yourself

Run from `/home/rvham/2rain-greenfield-approvals`:

```sh
node scripts/run-with-test-lock.mjs exclusive -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor --approvals
```

Open the printed `ORDER_ENTRY_URL`. Ctrl-C closes the fixture and removes its
disposable PostgreSQL container. The fixture opts into approval; an ordinary
tenant with no setting does not require it. This laptop may fail PostgreSQL
startup before the page is served; no readiness bound has been increased.
After each completed task, choose **Close task** (×), then **Refresh record**
before navigating or switching person.

## 1. Submit and reject (about three minutes)

1. Leave **Acting as: Buyer** selected. Purchasing → Purchase orders → New.
   Choose Alpine as vendor; add OFF-100, quantity 5 and a unit cost; Save draft.
2. **Place order** is absent. Choose **Submit for approval** → Review → Confirm.
   The order stays Draft and its Approval requests section shows Pending.
3. Purchasing → **Approvals** shows the request in the Pending tab. Open it:
   Buyer has neither Approve nor Reject.
4. Select **Acting as: Manager**, then **Switch person**. Choose Reject, enter
   a reason, Review, Confirm. The request shows Rejected and the saved reason.

## 2. Approve the current revision and place it (about three minutes)

1. Return to the purchase order, switch to Buyer and submit again.
2. Switch to Manager, open the pending request from Approvals, Approve with
   a reason, Review, Confirm.
3. Back on the purchase order, switch to Buyer: **Place order** is offered.
   Enter an optional supplier reference (e.g. `SUP-7781`), Review, Confirm.
   The state is **Released**, not a new approval state; receiving is open.
4. On another draft, submit and then Edit its header or a line. The old request
   cannot approve that revision; submit the current revision instead. An old
   pending request may still be rejected with a reason.

## 3. Amend without interrupting receiving (about three minutes)

1. On the released order, select its line → **Request quantity amendment**.
   Enter 8 and a reason, Review, Confirm. Ordered still reads 5.
2. While approval is pending, receive 2 through the existing Receive task.
   Ordered remains 5; Received and Open change to 2 and 3.
3. Manager → Approvals → approve the amendment with a reason. Ordered becomes
   8; Received remains 2 and Open becomes 6. The request is Consumed.
4. Stage another quantity amendment and reject it: the current quantities and
   receipts stay unchanged. An amendment below what was received is refused
   when approved, and stays pending until rejected.

## 4. Default-off setting and boundaries

Manager can edit Purchasing → Purchasing settings → the `purchase-orders` row:
**Purchase orders require approval**. Turning it off permits placing a draft
without an approval. Buyer cannot change the setting. With the setting on,
both the offered Task and the server enforce current-revision approval.

The acting-as control is LOCAL_DEMO-only; it is not real sign-in. PO approval
does not impose maker-checker (A2); the fixture gives approve permission to
Manager only. Inventory approvals and threshold changes (A6) are not built.
