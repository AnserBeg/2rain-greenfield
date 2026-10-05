# UNITS — Test it yourself (setup checkpoint)

This checkpoint provides setup and exact arithmetic. Document entry in alternate
units is stopped on [UNITS-VERIFICATION](UNITS-VERIFICATION.md), which requires a
separate Critical change. Existing document quantities remain base quantities.

## Unit setup (under five minutes)

1. Open the application and expand **More → Catalog → Unit**. Choose **New**.
2. Enter code `EA`, name `Each`, decimals `0`; save. The list shows the code,
   name and precision. A second `ea` refuses as a duplicate; code identity uses
   the existing case-insensitive business-key contract. Existing item base-unit
   text is not changed by creating the master.
3. Create `BOX`, `Box of twelve`, decimals `0`. Decimals offers only 0 through 18.
4. Open **Unit conversion**, choose **New**, enter code `BOX-EA`, From unit
   `BOX`, To unit `EA`, numerator `12`, denominator `1`. Leave its item reference
   blank for a company rule; save. Its company is the authorized current company.
5. Create a second conversion `NOTEBOOK-BOX-EA` with numerator `24`, denominator
   `1`, and select Field notebook as its item. Its rule belongs to that item;
   the company-wide rule remains a separate record.

The setup forms use shared canonical controls. The stopped slice will validate
unit existence and positive factors at document entry; setup does not yet make
alternate units available on documents. Do not use a factor of zero.

## Exact arithmetic (under one minute; no container)

Run in `/home/rvham/2rain-greenfield-units`:

```sh
node --import tsx --test test/unit/units.test.ts test/integration/units.test.ts
```

Expect four passing tests. They cover item/company/reverse lookup, exact decimal
conversion, explicit non-exact/invalid-factor/overflow refusals, quantities above
JavaScript's safe integer range, and the compiled unit setup's company scope.
Two boxes at factor 12 produce 24 each; one third of an each at 18 decimals refuses
`UNIT_CONVERSION_NON_EXACT` instead of rounding. This helper is not yet mounted
on document mutations.

## Hosted evidence

The main PostgreSQL suite runs `test/postgres/units.test.ts`, which creates the
masters through governed operations, reads persisted factors and independently
computes two item-specific boxes as 48 each. The operations browser suite runs
`purchase-units.spec.ts` through the shared forms. CI links are in [UNITS.md](UNITS.md).
