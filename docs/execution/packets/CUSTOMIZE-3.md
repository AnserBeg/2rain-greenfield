# CUSTOMIZE-3 — the launch customization set

Status — Slice 0, optional list columns. Base `e61e90e2`. No Critical path edited.

## Claims

1. `arrangeLayout` offers every stored field of the listed entity, including standard and custom fields, and adds missing query selections for chosen columns. Fields of another entity are refused.
2. Party's generic list can acquire the same declared column layout. Existing patch chains retain their selections unless an arrangement requests another field.
3. The assistant's drafting prompt exposes available hidden fields and describes how to include them in an arrangement.

## Decisions

- The orchestrator approved one forward migration, 0033, admitting every new patch kind in this packet. The migration runner requires contiguous numbers, so 0032 must land first.
- List columns come first. Saved views and slices 2–6 remain pending. No new §10.2 support row is claimed before CI and integration.

## Gates

- The focused customization tests exercise compilation, refusal of a field from another entity and a scripted assistant request.
- GitHub CI runs the PostgreSQL and browser journeys for standard and custom columns, activation, live use and rollback.

## Test it yourself

After this work is integrated, open Customize and add **Person ordering** to **Purchase order**, then approve and activate. Create an order with **Person ordering** filled under **More details**. In Customize, choose **Arrange a list → Purchase orders → Choose columns**, clear **Hide Person ordering** and **Hide Notes**, then draft, approve and activate. The purchase order list shows both headings and the entered name. Roll back the latest change and both columns disappear while the name remains on the record.
