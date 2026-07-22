import type { UntrustedRequestInput } from './request-context.js';
import type { AuthenticatedRequestRuntimeEntryAdapter } from './request-runtime-view.js';
import type { SemanticOperationGateway } from './semantic-operation-gateway.js';
import type { SemanticQueryGateway } from './semantic-query-gateway.js';

export class AuthenticatedSemanticQueryApiAdapter {
  constructor(
    private readonly requestEntry: AuthenticatedRequestRuntimeEntryAdapter,
    private readonly queryGateway: SemanticQueryGateway,
  ) {}

  async handle(
    authenticationInput: UntrustedRequestInput,
    semanticEnvelope: unknown,
  ): Promise<never> {
    return this.requestEntry.run(authenticationInput, (view) =>
      this.queryGateway.invoke(view, semanticEnvelope),
    );
  }
}

export class AuthenticatedSemanticOperationApiAdapter {
  constructor(
    private readonly requestEntry: AuthenticatedRequestRuntimeEntryAdapter,
    private readonly operationGateway: SemanticOperationGateway,
  ) {}

  async handle(
    authenticationInput: UntrustedRequestInput,
    semanticEnvelope: unknown,
  ): Promise<never> {
    return this.requestEntry.run(authenticationInput, (view) =>
      this.operationGateway.invoke(view, semanticEnvelope),
    );
  }
}
