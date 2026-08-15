# ADR-0053: Form submissions carry validated strings and explicit empty intent

Date: 2026-08-14
Status: accepted — ruled by the `form-wire-semantics` writer under the authority
granted in that packet's charter
Tier: Critical (the ruling changes which write inputs reach semantic execution)

## Context

An HTML form encoded as `application/x-www-form-urlencoded` carries strings.
The web runtime previously copied those strings into `values` or `patch`
unchanged. That worked for the provider's string-represented field kinds, but a
`booleanFieldType` accepts only a JSON boolean. A browser could therefore render
Yes or No and could never write either value.

The same copy treated every blank control as `""`. Empty text is a real text
value, but `""` is not a valid date, time, decimal, quantity, money, enum,
date-time, integer or boolean. The provider already distinguishes two other
meanings: a missing update patch key leaves the stored value alone, while `null`
clears an optional value and is refused for a required field. The old form wire
collapsed all three meanings into one string.

ADR-0052 deliberately left both questions to `form-write-untyped-wire` and
`form-empty-means-nothing`; U7 concerns field chunking, inline validation and
Postel normalisation and does not own write-wire meaning.

## Decision

### 1. The raw form wire is string-only

The browser posts URL-encoded strings. `SurfaceRuntimeSubmission` remains a
`Readonly<Record<string, string>>`; the form does not embed typed JSON.

The already-pinned operation input contract is the authority at the one
normalisation seam before semantic invocation:

- an exact `"true"` or `"false"` for a declared boolean becomes its JSON boolean;
- every non-boolean, non-empty field value remains the validated string the
  control posted;
- any other boolean spelling is refused as `OPERATION_INPUT_INVALID` before the
  gateway is called.

Typed JSON on the raw wire is **unrepresentable** in the TypeScript carrier and
in the renderer's native form encoding. A hostile HTTP client can still send an
arbitrary string, so conformance of untrusted bytes to a declared field kind is
necessarily **detectable**, not unrepresentable. The closed field-kind union is
read from the operation contract; the surface does not infer it and no compiler
profile version changes.

The adopted profile-v1 release shape deliberately mixes two authorities:
operation input fields are present because they are gated on whether an
operation writes fields, while per-surface field metadata is absent until
compiler-semantic profile v2. A profile-v1 form therefore renders bare one-line
text inputs but still reads the selected operation contract to classify the
stored value, render the companion intent and convert booleans. Profile v2
changes the control, not the wire authority. Neither profile treats an HTML
attribute string as proof that the browser's live control value is lossless:
one-line text inputs remove CR and LF, and typed controls may sanitize or
de-select other values.

### 2. A blank optional control carries an explicit intent

Every rendered optional field has a native companion `<select>` named
`empty:<fieldId>`. Its vocabulary is closed:

| Intent | Create | Update |
|---|---|---|
| `nothing` | omit the value | leave the stored value alone |
| `clear` | refused | send JSON `null` |
| `emptyText` | send the real text value `""` | send the real text value `""` |

`emptyText` is offered only for `textFieldType`; `clear` is offered only on an
update. A required text control may still submit `""`, because zero-length text
is a real value. A required non-text blank is refused. A missing, unknown or
inapplicable companion spelling is also refused as `OPERATION_INPUT_INVALID`.
On update only, an unavailable stored value on a required text field carries a
server-rendered `nothing | emptyText` choice. `nothing` is selected by default;
`emptyText` makes the valid replacement `""` explicit. An unavailable required
non-text field carries a hidden `nothing` marker because blank is not a value in
its domain. In both cases, entering a non-empty valid replacement is still
`set`. Neither form adds a clear intent or appears on create, so neither can
make a required create value optional.

Before the provider input object is built, the runtime represents the result as
the discriminated union `set | clear | nothing`. Those three intents are
**unrepresentable as one another** in that internal carrier. After construction,
`nothing` has no object key, `clear` has a key whose value is `null`, and `set`
has a key whose value is a string or boolean. A forged raw companion spelling is
untrusted input, so its rejection remains **detectable**.

The select is server-rendered and needs none of ADR-0036 §2's four authorised
client behaviours. It never materialises a field default. Its selected option
preserves only observed state: stored empty text selects `emptyText`; every
other stored value defaults to `nothing`; and `clear` occurs only when the
operator explicitly selects it. A non-empty primary value remains `set`
regardless of the conditional choice beside it.

This rule applies to every rendered control, not to an enumerated list of field
kinds. If the selected operation contract and the live native control cannot
faithfully round-trip a stored value, the primary control is rendered blank and
the exact stored JSON value is shown beside it. This includes a profile-v1 bare
input carrying contract-incompatible runtime types or line-bearing text, as well
as profile-v2 boolean, short-enum, date, time, number and one-line text controls.
An optional companion remains on `nothing`; an unavailable required text update
offers the explicit `nothing | emptyText` choice above; and an unavailable
required non-text update carries the hidden `nothing` marker. Choosing any valid
replacement is `set`, including explicit empty text, and choosing `clear` remains
available only for an optional field. Thus editing an unrelated field neither
invents a value, sanitizes one, nor clears one the control could not carry.

### 3. Refusal is before invocation and cannot partially apply

The whole submission is normalised before a semantic request is made. One
malformed boolean or empty intent returns the named page diagnostic and the
gateway is not called. No subset of fields can be persisted. This is
ADR-0041's honour-or-refuse rule and ADR-0044's prohibition on plausible partial
success at the form boundary.

Browser doubles that ask the real `parseMutationInput` must throw its refusal.
They have no mode that records a refusal and then returns success, and they
persist the parser's returned patch rather than the pre-validated request.

## Consequences

- A native server-rendered form can set Yes or No, omit a blank optional
  non-text value, explicitly clear an optional value on update, and preserve
  empty text as text.
- Profile-v1 bare inputs exercise the same operation-contract normalisation
  today. They are one-line controls rather than lossless carriers, so historical
  line-bearing text and contract-incompatible runtime types use the same blank,
  disclosed preservation path as unavailable profile-v2 values. Both profiles
  are controlled explicitly.
- The selected operation's pinned input contract now reaches the web binding as
  a narrow list of field id, field kind and requiredness. It is derived from the
  existing operation catalog and changes no compiled bytes.
- Existing surface definitions that omit a required create field remain a
  separate honour-or-refuse problem. This packet corrects its browser fixture so
  the converted create assertions exercise a satisfiable form; it does not rule
  how production surfaces and create contracts must be reconciled.

## What this ADR does not decide

- Relation rendering, relation submission, enumeration or update semantics.
- Adoption of compiler-semantic profile v2 or any new compiled field.
- Field-level diagnostic anchors, chunking, inline validation, or broader
  Postel-style input normalisation owned by U7.
- The wider audit of executors and stand-ins outside the browser assertions
  converted by this packet.
