# LOCATIONS-2 — Test it yourself

This is a blocked draft checkpoint. Release installation needs
[LOCATIONS-2-VERIFICATION](LOCATIONS-2-VERIFICATION.md) before these product steps
can run. The status writer is deliberately closed; the current Critical verifier
still tries to write it through the generic update. Two-step transfer receipt is
pending and is not included in these steps.

## Start after the prerequisite lands

In `/home/rvham/2rain-greenfield-locations-2`, check memory before taking the lock:

```sh
powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"
```

Proceed only with at least 1.2 GB free and no other container-backed test running.
If memory is low, leave the lock free. Then:

```sh
node scripts/run-with-test-lock.mjs exclusive -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify
```

Open the printed URL. Type `{"phase":"locations-2"}` and Enter into that terminal.
The fixture moves 4 of Calgary warehouse's 10 Field notebooks into a nested bin,
creates Second warehouse, and gives the notebook a reorder point of 10 and target
of 20. Ctrl-C stops the fixture and removes its container.

## Status and parent warehouse

1. More → Location → New: Code, Name, Type and Parent are available; status,
   status reason and changed-at are absent. A created location reads Usable.
2. Location List: Movable bin and Nested bin both show Warehouse **Calgary warehouse**.
3. Open Movable bin → Change status: choose Quarantine. An empty reason is
   refused. Enter a reason → Review → Confirm. The page shows the new status,
   reason and time. Change it back to Usable with a reason for the stock steps.
4. Edit still offers Code, Name and Type. Status changes through Change status;
   moving the parent uses Move location.

## Move and warehouse scope

1. Inventory → Stock by item → Warehouse Calgary warehouse → Apply: the notebook
   reads On hand **10**. Second warehouse reads **0**.
2. Location → Movable bin → Move location → New warehouse Second warehouse →
   Review → Confirm: “Move location: done”. Nested bin now names Second warehouse.
3. Stock by item: Calgary warehouse **6**, Second warehouse **4**, All **10**.
   Incoming stays company-wide when the Warehouse selection changes.
4. Buying worklist → Second warehouse: the notebook reads Usable **4**. Its
   incoming orders and open sales demand stay company-wide.
5. Location List → Second warehouse: it includes that warehouse, Movable bin and
   Nested bin; Calgary warehouse is absent. Changing the selector preserves the
   ordinary List filters and applies before counting and paging.
6. Self/indirect/concurrent cycle refusals are gateway witnesses in
   `test/postgres/locations-2.test.ts`; the UI offers warehouse choices only.

## Preferred receiving location

1. Set an item's Preferred location on its item form. On a purchase order draft,
   leave Receive into empty, add that item, save and confirm the order.
2. Start its Receive Task: Location starts at the item's preferred location and
   remains editable. Starting the Task posts nothing.
3. An explicit order Receive into takes precedence over the item preference.
4. Receive lines uses a common preference across its offered lines. Different,
   missing or unavailable preferences leave Location blank for an explicit choice.

The PostgreSQL witness recomputes warehouse quantities from stored movement and
parent rows independently of the provider's recursive SQL. The operations browser
journey is `inventory-locations-2.spec.ts`, pending CI after the prerequisite.
