# INTERACT-1 spike — in-place receiving and shipping

Base `c2c12e7f7395900967bfb4d45731d54ce28435a0`. The journey uses the distributor
seed and counts from an open, released order to the verified outcome with the
order ready for the next action. Selecting a location counts as a click. The
receipt enters the supplier's actual cost and uses the quantity already filled
from the order's open quantity. The shipment chooses a stock location.

| Posting | Existing path, measured clicks / loads | Fragment path, measured clicks / loads | Typed fields |
| --- | ---: | ---: | ---: |
| Receive in full | 4 / 4 | 2 / 0 | 1 |
| Reserve and ship | 5 / 4 | 4 / 0 | 0 |

Chromium measured both paths at `ce29b09e3c74356886ce8ac7d3959bd86d843150`.
Both tests passed and verified the received and shipped quantities. The fragment
path meets the Phase 3 targets. [Spike browser job](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44368685795/job/135029254114)

The baseline Chromium job measured 5 / 5 for receipt and 6 / 5 for shipment
at the base SHA. It clicked Fill open quantities on both paths. LOOK-1 fills
those quantities when the Task opens, reducing each baseline route by one
click and one load in the measured paths above. [Baseline browser job](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44365508565/job/135018241022)

- **Existing receipt** opens the task, enters the actual cost, clicks Review,
  clicks Confirm and goes back to the order. **Fragment receipt** opens the task
  and enters the same cost. A read-only preparation displays the server's review
  after the input settles. The second click explicitly confirms that prepared
  submission.
- **Existing shipment** opens the task, chooses a location, clicks Review, clicks
  Confirm and goes back to the order. **Fragment shipment** keeps the same
  selection, review and confirmation. The result updates the originating order
  and keeps the server's visible success status in place.

The prototype runs only in the browser test. It carries the existing same-origin
form bodies and pulls the task and record content out of the real server's
document responses. The production amendment would replace that test transport
with behaviour 7's bounded fragment responses and keep the regular page submit
available. Receipt and shipment use `humanRequired` operations. Their explicit
confirmation and the gateway's verified read-back are used in both paths.

## Final production scorecard

Counts start at the ready order form (PO/SO) or the record's Task opener and
end at the verified result with the record ready for its next action. Full
navigation and data-entry journeys are separate from this posting boundary.

| Posting | Before, clicks / loads | After, clicks / loads |
| --- | ---: | ---: |
| Place purchase order | 5 / 5 | 1 / 1 |
| Receive | 4 / 4 | 2 / 0 |
| Place sales order | 2 / 2 | 1 / 1 |
| Ship | 5 / 4 | 3 / 0 |
| Invoice | 4 / 4 | 2 / 0 |
| Record payment | 4 / 4 | 2 / 0 |

After values are the six `INTERACT_POSTING` measurements from
[Chromium CI 44552179864](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44552179864/job/135658777872).
All six names and their limits are asserted; receive-in-full requires two clicks.
The fixture also verifies the posted quantities, invoice and payment outcomes.

PO's former ready-form path was Save draft, open Place order, Review, Confirm
and Back (5 / 5); SO was Save draft and confirm the order (2 / 2). These actions
are in the recorded baseline helper. The older whole create journeys were
10 / 7 and 6 / 4, respectively; they include navigation and picker choices.
Invoice and payment were four Task clicks and four loads each (8 / 8 together).
[Recorded baseline job](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44368685795/job/135029254114).

## Test it yourself

Open the composed application browser job in the linked CI run and find
`INTERACT_SPIKE`. Compare each case's `clicks`, `loads`, and `typed` values. The
journey also checks that the order reports all 10 units received and 4 shipped.
