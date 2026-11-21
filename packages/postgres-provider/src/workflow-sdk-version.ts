export const LEGACY_WORKFLOW_SDK_VERSION = 'northstar.workflow-sdk/v1';
export const WORKFLOW_SDK_VERSION = 'northstar.workflow-sdk/v2';

export function supportsWorkflowSdk(
  version: string,
): version is typeof WORKFLOW_SDK_VERSION | typeof LEGACY_WORKFLOW_SDK_VERSION {
  return (
    version === WORKFLOW_SDK_VERSION || version === LEGACY_WORKFLOW_SDK_VERSION
  );
}

export class RemovedWorkflowAction extends Error {
  constructor() {
    super(
      'waitForEvent is unavailable in this SDK. Durable external-event waits are unsupported.',
    );
  }
}
