import type { UntrustedRequestInput } from './request-context.js';
import type { AuthenticatedRequestRuntimeEntryAdapter } from './request-runtime-view.js';
import type {
  SemanticOperationMediationAuthority,
  SemanticOperationGateway,
  SemanticOperationResultEnvelope,
} from './semantic-operation-gateway.js';
import type {
  SemanticQueryGateway,
  SemanticQueryResultEnvelope,
} from './semantic-query-gateway.js';

export class AuthenticatedSemanticQueryApiAdapter {
  constructor(
    private readonly requestEntry: AuthenticatedRequestRuntimeEntryAdapter,
    private readonly queryGateway: SemanticQueryGateway,
  ) {}

  async handle(
    authenticationInput: UntrustedRequestInput,
    semanticEnvelope: unknown,
  ): Promise<SemanticQueryResultEnvelope> {
    return this.requestEntry.run(authenticationInput, (view) =>
      this.queryGateway.invoke(view, semanticEnvelope),
    );
  }
}

export class AuthenticatedSemanticOperationApiAdapter {
  constructor(
    private readonly requestEntry: AuthenticatedRequestRuntimeEntryAdapter,
    private readonly operationGateway: SemanticOperationGateway,
    private readonly mediation: SemanticOperationMediationAuthority,
  ) {}

  async handle(
    authenticationInput: UntrustedRequestInput,
    semanticEnvelope: unknown,
  ): Promise<SemanticOperationResultEnvelope> {
    return this.requestEntry.run(authenticationInput, (view) =>
      this.operationGateway.invoke(
        view,
        semanticEnvelope,
        this.mediation.issueInvocation(view, 'API'),
      ),
    );
  }
}
