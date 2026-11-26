import { z } from 'zod';

import {
  CanonicalIdSchema,
  type WorkflowTrigger,
  type WorkflowTriggerMember,
} from './schemas.js';

/**
 * ADR-0073 A1: the one declaration of what each trigger member hands a run.
 * The SDK type, the fixture schema and the drafter's text are all generated
 * from this table, so a member cannot drift between authoring and execution.
 * Record text and field values never ride in the event; the body reads them
 * through a granted query.
 */
export const WORKFLOW_TRIGGER_EVENT_FIELDS = Object.freeze({
  goodsReceiptPosted: Object.freeze(['eventId', 'receiptId', 'legalEntityId']),
  recordCreated: Object.freeze([
    'eventId',
    'recordTypeId',
    'recordId',
    'legalEntityId',
  ]),
} satisfies Record<WorkflowTriggerMember, readonly string[]>);

/** The TypeScript name the body's `event` parameter has for each member. */
export function workflowEventTypeName(trigger: WorkflowTrigger): string {
  return typeof trigger === 'string' ? 'ReceiptEvent' : 'TriggerEvent';
}

/**
 * The generated SDK declaration of the event. The receipt line is the exact
 * text earlier SDK pins hashed. A general member pins its record type as a
 * literal, so a body cannot confuse two record types.
 */
export function workflowEventDeclaration(trigger: WorkflowTrigger): string {
  const member = typeof trigger === 'string' ? trigger : trigger.kind;
  const fields = WORKFLOW_TRIGGER_EVENT_FIELDS[member].map((field) =>
    field === 'recordTypeId' && typeof trigger !== 'string'
      ? `${field}: ${JSON.stringify(trigger.recordTypeId).replaceAll('"', "'")}`
      : `${field}: string`,
  );
  return `type ${workflowEventTypeName(trigger)} = Readonly<{ type: '${member}'; ${fields.join('; ')} }>;`;
}

/**
 * The fixture event schema, one strict object per member. Its keys equal
 * WORKFLOW_TRIGGER_EVENT_FIELDS (asserted by the trigger coverage test).
 */
export const WorkflowFixtureEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('goodsReceiptPosted'),
    eventId: z.uuid(),
    receiptId: z.uuid(),
    legalEntityId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('recordCreated'),
    eventId: z.uuid(),
    recordTypeId: CanonicalIdSchema,
    recordId: z.uuid(),
    legalEntityId: z.uuid(),
  }),
]);
export type WorkflowFixtureEvent = z.infer<typeof WorkflowFixtureEventSchema>;

/** A fixture event belongs to the trigger it replays. */
export function fixtureEventMatchesTrigger(
  event: { readonly type: string; readonly recordTypeId?: unknown },
  trigger: WorkflowTrigger,
): boolean {
  return typeof trigger === 'string'
    ? event.type === trigger
    : event.type === trigger.kind &&
        event.recordTypeId === trigger.recordTypeId;
}

/** The drafter's line for each member, generated from the same table. */
export function workflowTriggerDrafterLines(
  recordTypes: readonly string[],
): readonly string[] {
  const fields = (member: WorkflowTriggerMember) =>
    WORKFLOW_TRIGGER_EVENT_FIELDS[member].join(', ');
  return [
    `trigger "goodsReceiptPosted": runs once for each posted goods receipt; fixture event {type:"goodsReceiptPosted", ${fields('goodsReceiptPosted')}} (UUIDs).`,
    `trigger {kind:"recordCreated", triggerVersion:"v1", recordTypeId}: runs once for each record of that type when it is first saved, including each line a single command creates; fixture event {type:"recordCreated", ${fields('recordCreated')}} with recordTypeId equal to the trigger's and UUIDs for the rest. The event carries no field values: read the record through a granted query.`,
    recordTypes.length
      ? `recordTypeId is one of: ${recordTypes.join(', ')}.`
      : 'No record type in this release can start a workflow yet.',
  ];
}
