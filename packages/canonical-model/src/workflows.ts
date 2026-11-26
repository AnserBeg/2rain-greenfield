export const WORKFLOW_SURFACE_FLOOR = 29;
/**
 * ADR-0073 A1: a release with a general trigger member needs a reader that
 * parses it. Rung 50, assigned at TRAIN-Q (main's highest was 49).
 */
export const RECORD_CREATED_TRIGGER_READER = 50;
/** The platform event type a recordCreated definition persists. */
export const RECORD_CREATED_EVENT_TYPE =
  'northstar.runtime:event.record-created';
export const WORKFLOW_PAYLOAD_VERSION = 'northstar.workflow-payload/v1';
export const WORKFLOW_PROJECTION_FAMILY =
  'northstar.compiler:projection-family.workflow';
export const WORKFLOW_RUNTIME_CAPABILITY =
  'northstar.runtime:capability.workflow';
