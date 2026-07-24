import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryResultEnvelope,
} from '../../../../packages/runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../../../packages/runtime/src/request-runtime-view.js';

import { PARTY_IDS } from './definition.js';
import type { RealPartyRuntime } from './runtime-harness.js';

export function resolvePartyName(
  runtime: RealPartyRuntime,
  view: RequestRuntimeView,
  text: string,
): Promise<SemanticQueryResultEnvelope> {
  return runtime.queryGateway.invoke(view, {
    arguments: { text },
    queryId: `${PARTY_IDS.namespace}:query.party_resolve`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}
