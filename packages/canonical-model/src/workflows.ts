export const WORKFLOW_SURFACE_FLOOR = 29;
/**
 * ADR-0073 A1: a release with a general trigger member needs a reader that
 * parses it. Rung 50, assigned at TRAIN-Q (main's highest was 49).
 */
export const RECORD_CREATED_TRIGGER_READER = 50;
/** The platform event type a recordCreated definition persists. */
export const RECORD_CREATED_EVENT_TYPE =
  'northstar.runtime:event.record-created';
/**
 * ADR-0073 A1 recordTransitioned (WORKFLOW-3 s1). Its own rung: a rung-50
 * reader strict-parses the trigger union and would refuse the member without
 * naming it. 55, assigned at TRAIN-Y (main's highest was BILLING's 54).
 */
export const RECORD_TRANSITIONED_TRIGGER_READER = 55;
/** The platform event type a recordTransitioned definition persists. */
export const RECORD_TRANSITIONED_EVENT_TYPE =
  'northstar.runtime:event.record-transitioned';
/**
 * ADR-0073 A1 engineFactChanged (WORKFLOW-3 s1b). Its own rung, never
 * reserved: provisional 57 (main's highest is BILLING's 56); assigned at merge.
 */
export const ENGINE_FACT_TRIGGER_READER = 57;
/** The platform event type an engineFactChanged definition persists. */
export const ENGINE_FACT_CHANGED_EVENT_TYPE =
  'northstar.runtime:event.engine-fact-changed';
export const WORKFLOW_PAYLOAD_VERSION = 'northstar.workflow-payload/v1';
export const WORKFLOW_PROJECTION_FAMILY =
  'northstar.compiler:projection-family.workflow';
export const WORKFLOW_RUNTIME_CAPABILITY =
  'northstar.runtime:capability.workflow';
