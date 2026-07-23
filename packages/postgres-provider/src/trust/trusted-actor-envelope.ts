import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';

import {
  TRUSTED_ACTOR_ENVELOPE_VERSION,
  freezeResolvedActorAttribution,
  validateTrustedContextIdentity,
  type TrustedActorAttributionGateway,
  type TrustedActorEnvelope,
} from '../../../platform-runtime/src/trust/contracts.js';

const issuedActorEnvelopes = new WeakSet<object>();

/**
 * Trusted identity-adapter composition. Context authority is the accepted
 * ADR-0004 issuer directly; it is not an injectable operation dependency.
 */
export class TrustedActorEnvelopeIssuer {
  constructor(
    private readonly attributionGateway: TrustedActorAttributionGateway<TrustedRequestContext>,
  ) {}

  async issue(context: TrustedRequestContext): Promise<TrustedActorEnvelope> {
    assertTrustedRequestContext(context);
    validateTrustedContextIdentity(context);
    const actor = freezeResolvedActorAttribution(
      await this.attributionGateway.resolve(context),
      context.principalId,
    );
    const envelope: TrustedActorEnvelope = Object.freeze({
      actor,
      environmentId: context.environmentId,
      principalId: context.principalId,
      requestId: context.requestId,
      schemaVersion: TRUSTED_ACTOR_ENVELOPE_VERSION,
      tenantId: context.tenantId,
    });
    issuedActorEnvelopes.add(envelope);
    return envelope;
  }
}

export function assertTrustedActorEnvelope(
  value: unknown,
): asserts value is TrustedActorEnvelope {
  if (
    typeof value !== 'object' ||
    value === null ||
    !issuedActorEnvelopes.has(value)
  ) {
    throw new TypeError(
      'trusted actor envelope must be issued by TrustedActorEnvelopeIssuer',
    );
  }
}
