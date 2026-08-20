/**
 * The compiled-surface message catalog.
 *
 * [ADR-0048](../../../docs/decisions/ADR-0048-the-message-catalog-is-platform-vocabulary-held-in-code.md)
 * §1 rules that this is platform vocabulary held in code rather than a compiled
 * projection: every code is platform-raised, no module authors a message, and
 * compiling a constant would spend a scarce append-only profile version on a
 * projection nothing populates. The precedent is `COMPILER_DIAGNOSTIC_COPY`
 * (`packages/compiler/src/diagnostics.ts:7`), which holds its 39 codes exactly
 * this way and derives its code type at `:205`.
 *
 * §2 rules the direction: **the catalog is the authority and the code type
 * derives from it.** Under `keyof typeof` an unregistered code is not a compile
 * error, it is inexpressible — strictly stronger than the two `copy[code]`
 * tables this module replaces, which only failed when their union grew.
 */

/**
 * Does the user's work stop? ADR-0048 §3, and there is deliberately no
 * `severity`: the proposal's column stacked a scope and a consequence under a
 * header naming neither.
 *
 * `advisory` — the work continues. The message asks for an input the user
 * already has, and supplying it completes the same task.
 * `blocking` — the work stops. Nothing the user can supply on this screen
 * completes the task. A blocking message may still carry a next action;
 * "try again" is not an input, so it does not make a message advisory.
 */
export const MESSAGE_CONSEQUENCES = Object.freeze([
  'advisory',
  'blocking',
] as const);

export type MessageConsequence = (typeof MESSAGE_CONSEQUENCES)[number];

/**
 * ADR-0048 §4. Placement is **derived, never authored** — an entry declares
 * which placements are admissible and the runtime picks by where the fault
 * arose relative to slot composition. Selecting between them is `U6b`; this
 * module only registers the admissible set.
 */
export const MESSAGE_PLACEMENTS = Object.freeze(['page', 'slot'] as const);

export type MessagePlacement = (typeof MESSAGE_PLACEMENTS)[number];

/**
 * Refused by name rather than omitted, so the absence is declared and
 * observable (ADR-0044's sense) instead of silently accepted-and-ignored.
 * `toast` needs an ADR-0036 amendment and a durable-record substrate; `modal`
 * needs a rectifying-action capability. Neither exists.
 */
export const REFUSED_MESSAGE_PLACEMENTS = Object.freeze([
  'modal',
  'toast',
] as const);

/**
 * The closed subject-kind vocabulary. A message never interpolates a value into its
 * sentence; where it must name something, it names it in a separate element.
 * See the template ruling in this packet's report — the short form is that a
 * held-out subject keeps every catalog sentence a literal, which is what lets
 * the gate compare rendered text against a string it never computed.
 */
export const MESSAGE_SUBJECT_KINDS = Object.freeze([
  'componentId',
  'legalEntityId',
  'relationId',
] as const);

export type MessageSubjectKind = (typeof MESSAGE_SUBJECT_KINDS)[number];

export interface SurfaceMessage {
  /** Does the user's work stop? */
  readonly consequence: MessageConsequence;
  /** What happened. Never an instruction — that is `nextAction`. */
  readonly detail: string;
  /**
   * What to do about it, or `null` when there is genuinely nothing the user
   * can do. `null` is a claim, not a placeholder: inventing an action the
   * platform cannot honour is the same defect as inventing a sentence.
   */
  readonly nextAction: string | null;
  /** Non-empty. Where this message may be rendered. */
  readonly placements: readonly MessagePlacement[];
  /** The headline. A literal, always — never a template. */
  readonly sentence: string;
  /** The one value this message may name, or `null`. */
  readonly subject: MessageSubjectKind | null;
}

export const SURFACE_MESSAGE_CATALOG = Object.freeze({
  AUTHENTICATION_REQUIRED: {
    consequence: 'blocking',
    detail:
      'An authenticated request is required before a release can be pinned.',
    nextAction: 'Sign in, then open this page again.',
    placements: ['page'],
    sentence: 'Sign-in required',
    subject: null,
  },
  COMPONENT_RENDER_FAILED: {
    consequence: 'blocking',
    detail:
      'The release-defined component could not be rendered. The rest of the pinned surface is unchanged.',
    nextAction: null,
    placements: ['slot'],
    sentence: 'Component unavailable',
    subject: null,
  },
  DUPLICATE_SURFACE_ID: {
    consequence: 'blocking',
    detail:
      'The pinned release names one surface identifier twice, so the requested screen is ambiguous.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Repeated surface identifier',
    subject: null,
  },
  INVALID_SURFACE_BINDING: {
    consequence: 'blocking',
    detail:
      'The selected surface does not have a valid pinned semantic binding.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Surface binding unreadable',
    subject: null,
  },
  INVALID_SURFACE_FIELD: {
    consequence: 'blocking',
    detail:
      'A surface in the pinned release describes its fields in a way this runtime cannot render a control for.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Compiled field description unreadable',
    subject: null,
  },
  INVALID_SURFACE_MANIFEST: {
    consequence: 'blocking',
    detail:
      'The pinned release does not contain a surface projection this runtime can read.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Compiled surface unavailable',
    subject: null,
  },
  INVALID_SURFACE_NAVIGATION: {
    consequence: 'blocking',
    detail:
      'The compiled navigation tree is unreadable, so no screen can be reached safely.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Compiled navigation unavailable',
    subject: null,
  },
  INVALID_SURFACE_SLOT: {
    consequence: 'blocking',
    detail:
      'A surface in the pinned release declares an anatomy this runtime cannot lay out.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Compiled surface anatomy unreadable',
    subject: null,
  },
  METHOD_NOT_ALLOWED: {
    consequence: 'blocking',
    detail: 'The application shell does not accept this request method.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Method not allowed',
    subject: null,
  },
  NO_ACTIVE_SURFACE: {
    consequence: 'blocking',
    detail: 'The pinned release contains no active browser surface.',
    nextAction: null,
    placements: ['page'],
    sentence: 'No active surface',
    subject: null,
  },
  OPERATION_CONFIRMATION_REQUIRED: {
    consequence: 'advisory',
    detail: 'This semantic operation requires explicit human confirmation.',
    nextAction: 'Review the predicted effects, then confirm.',
    placements: ['page'],
    sentence: 'Confirmation required',
    subject: null,
  },
  OPERATION_CONFIRMATION_STALE: {
    consequence: 'advisory',
    detail:
      'The operation input or expected revision changed after the preview.',
    nextAction: 'Preview this operation again before confirming.',
    placements: ['page'],
    sentence: 'Confirmation expired',
    subject: null,
  },
  OPERATION_PERMISSION_DENIED: {
    consequence: 'blocking',
    // No next action: §3.8's "Request access" needs a rectifying-action
    // capability the platform does not have (ADR-0048 §4). Naming one here
    // would be the fabricated affordance `nextAction: null` exists to refuse.
    detail: 'Current policy does not allow this operation.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Access denied',
    subject: null,
  },
  OPERATION_INPUT_INVALID: {
    consequence: 'advisory',
    detail:
      'A submitted field value does not match the form input contract in this release.',
    nextAction: 'Review the form choices, then save again.',
    placements: ['page'],
    sentence: 'Form input invalid',
    subject: null,
  },
  OPERATION_LEGAL_ENTITY_INACTIVE: {
    consequence: 'blocking',
    detail:
      'The selected legal entity is not active and cannot own a new business record.',
    nextAction: 'Choose an active legal entity, then save again.',
    placements: ['page'],
    sentence: 'Legal entity unavailable for new work',
    subject: 'legalEntityId',
  },
  OPERATION_UNAVAILABLE: {
    consequence: 'blocking',
    detail: 'The semantic operation could not be completed safely.',
    nextAction: 'Check the record, then ask for this operation again.',
    placements: ['page'],
    sentence: 'Save unavailable',
    subject: null,
  },
  OPERATION_UNSUPPORTED: {
    consequence: 'blocking',
    detail: 'The pinned release does not provide this semantic operation.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Operation unavailable',
    subject: null,
  },
  QUERY_AMBIGUOUS: {
    consequence: 'advisory',
    detail: 'More than one record matched this request.',
    nextAction: 'Refine the search before choosing a record.',
    placements: ['slot'],
    sentence: 'More than one record matched',
    subject: null,
  },
  QUERY_LEGAL_ENTITY_SCOPE_REQUIRED: {
    consequence: 'advisory',
    detail: 'This data is scoped to a legal entity and none is selected.',
    nextAction: 'Choose a legal entity in the workspace context bar.',
    placements: ['slot'],
    sentence: 'Legal entity required',
    subject: null,
  },
  QUERY_NOT_FOUND: {
    consequence: 'blocking',
    detail: 'No visible record matched this request in the pinned release.',
    nextAction: 'Return to the list and choose a visible record.',
    placements: ['slot'],
    sentence: 'Record not found',
    subject: null,
  },
  QUERY_PARAMETER_REQUIRED: {
    consequence: 'advisory',
    detail: 'This lookup needs every declared input before it can answer.',
    nextAction: 'Complete every lookup input, then ask for the result.',
    placements: ['slot'],
    sentence: 'Lookup parameters required',
    subject: null,
  },
  QUERY_PERMISSION_DENIED: {
    consequence: 'blocking',
    // Same refusal as OPERATION_PERMISSION_DENIED, for the same reason.
    detail: 'Current policy does not allow this data to be shown.',
    nextAction: null,
    placements: ['slot'],
    sentence: 'Access denied',
    subject: null,
  },
  QUERY_UNAVAILABLE: {
    consequence: 'blocking',
    detail: 'Live data could not be loaded safely.',
    nextAction: 'Ask for this data again.',
    placements: ['slot'],
    sentence: 'Data unavailable',
    subject: null,
  },
  QUERY_UNSUPPORTED: {
    consequence: 'blocking',
    detail:
      'The pinned release does not provide this semantic data capability.',
    nextAction: null,
    placements: ['page', 'slot'],
    sentence: 'Capability unavailable',
    subject: null,
  },
  RELATION_ENUMERATION_UNAVAILABLE: {
    consequence: 'blocking',
    detail:
      'The complete set of permitted target records could not be loaded for this relation.',
    nextAction:
      'Return after the relation target list is available and complete.',
    placements: ['slot'],
    sentence: 'Relation choices unavailable',
    subject: 'relationId',
  },
  REQUEST_RUNTIME_VIEW_UNAVAILABLE: {
    consequence: 'blocking',
    detail: 'The request could not construct its pinned runtime view.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Application shell unavailable',
    subject: null,
  },
  ROUTE_NOT_FOUND: {
    consequence: 'blocking',
    detail:
      'The requested route is not part of the compiled application shell.',
    nextAction: 'Open the application shell at its root.',
    placements: ['page'],
    sentence: 'Route not found',
    subject: null,
  },
  UNKNOWN_SURFACE: {
    consequence: 'blocking',
    detail: 'The requested surface is not present in this pinned release.',
    nextAction: 'Choose a surface from the release navigation.',
    placements: ['page'],
    sentence: 'Surface not found',
    subject: null,
  },
  UNSUPPORTED_COMPONENT: {
    consequence: 'blocking',
    detail: 'This runtime does not register the component the release names.',
    nextAction: null,
    placements: ['slot'],
    sentence: 'Unsupported release capability',
    subject: 'componentId',
  },
  UNSUPPORTED_SURFACE_VERSION: {
    consequence: 'blocking',
    detail:
      'The compiled surface projection is stamped with a payload version this runtime does not read.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Unsupported surface projection version',
    subject: null,
  },
  UNTRUSTED_CONTEXT_REJECTED: {
    consequence: 'blocking',
    detail:
      'Tenant and environment identity cannot be selected by browser input.',
    nextAction: null,
    placements: ['page'],
    sentence: 'Untrusted context rejected',
    subject: null,
  },
} as const satisfies Readonly<Record<string, SurfaceMessage>>);

/**
 * ADR-0048 §2. An unregistered code is inexpressible, not merely a compile
 * error, because there is no code list anywhere else for it to be spelled in.
 */
export type SurfaceMessageCode = keyof typeof SURFACE_MESSAGE_CATALOG;

export const SURFACE_MESSAGE_CODES: readonly SurfaceMessageCode[] =
  Object.freeze(
    (Object.keys(SURFACE_MESSAGE_CATALOG) as SurfaceMessageCode[]).sort(),
  );

/**
 * The read path's diagnostic subset, declared here so the render state, the
 * gateway-error mapping and the catalog cannot disagree about which codes a
 * slot may resolve to. Every member declares `slot` among its placements, which
 * the contract test asserts rather than trusting this comment.
 */
export const QUERY_DIAGNOSTIC_CODES = Object.freeze([
  'QUERY_AMBIGUOUS',
  'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED',
  'QUERY_NOT_FOUND',
  'QUERY_PARAMETER_REQUIRED',
  'QUERY_PERMISSION_DENIED',
  'QUERY_UNAVAILABLE',
  'QUERY_UNSUPPORTED',
] as const satisfies readonly SurfaceMessageCode[]);

export type QueryDiagnosticCode = (typeof QUERY_DIAGNOSTIC_CODES)[number];

/** The write path's equivalent subset. */
export const OPERATION_DIAGNOSTIC_CODES = Object.freeze([
  'OPERATION_CONFIRMATION_REQUIRED',
  'OPERATION_CONFIRMATION_STALE',
  'OPERATION_INPUT_INVALID',
  'OPERATION_LEGAL_ENTITY_INACTIVE',
  'OPERATION_PERMISSION_DENIED',
  'OPERATION_UNAVAILABLE',
  'OPERATION_UNSUPPORTED',
] as const satisfies readonly SurfaceMessageCode[]);

export type OperationDiagnosticCode =
  (typeof OPERATION_DIAGNOSTIC_CODES)[number];

type CodesDeclaringSubject = {
  [
    Code in SurfaceMessageCode
  ]: (typeof SURFACE_MESSAGE_CATALOG)[Code]['subject'] extends MessageSubjectKind
    ? Code
    : never;
}[SurfaceMessageCode];

/**
 * The compile-time half of the template ruling. A code that declares a subject
 * cannot be rendered without one, and a code that declares none cannot be given
 * one — the same "an unfilled hole fails compilation" property a parameterised
 * template would have bought, without putting a hole in the sentence.
 */
export type SurfaceMessageRef =
  | {
      readonly code: Exclude<SurfaceMessageCode, CodesDeclaringSubject>;
      readonly subject?: undefined;
    }
  | { readonly code: CodesDeclaringSubject; readonly subject: string };

export function surfaceMessage(code: SurfaceMessageCode): SurfaceMessage {
  return SURFACE_MESSAGE_CATALOG[code];
}

/**
 * ADR-0048 §3: colour resolves through the pinned roles rather than adding a
 * hue, exactly as U4's resolution states already do. Both members of the range
 * are existing status roles, so the status vocabulary does not move — the
 * contract test asserts that against the canonical vocabulary rather than
 * leaving it to this comment. Nothing under `apps/web/src` imports
 * `@north-star/canonical-model`; the runtime holds its own copy of the
 * vocabulary and `checkUxGrammarPin` fails if the two disagree.
 */
export function messageStatusRole(
  code: SurfaceMessageCode,
): 'attention' | 'blocked' {
  return SURFACE_MESSAGE_CATALOG[code].consequence === 'blocking'
    ? 'blocked'
    : 'attention';
}
