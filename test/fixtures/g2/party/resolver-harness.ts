import { type SemanticQueryResultEnvelope } from '../../../../packages/runtime/src/semantic-query-gateway.js';
import { resolveByName } from '../../../../packages/runtime/src/resolve-by-name.js';
import type { RequestRuntimeView } from '../../../../packages/runtime/src/request-runtime-view.js';

import { PARTY_IDS } from './definition.js';
import type { RealPartyRuntime } from './runtime-harness.js';

export function resolvePartyName(
  runtime: RealPartyRuntime,
  view: RequestRuntimeView,
  text: string,
): Promise<SemanticQueryResultEnvelope> {
  return resolveByName(
    runtime.queryGateway,
    view,
    {
      exactIdentifierFieldIds: [PARTY_IDS.fieldIds.number],
      listQueryId: `${PARTY_IDS.namespace}:query.party_list`,
      nameFieldIds: [PARTY_IDS.fieldIds.name],
      resolveQueryId: `${PARTY_IDS.namespace}:query.party_resolve`,
    },
    text,
  );
}
