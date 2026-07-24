export const TRUSTED_ACTOR_ENVELOPE_VERSION =
  'northstar.trusted-actor-envelope/v1' as const;
export const ACTION_INVOCATION_VERSION =
  'northstar.action-invocation/v1' as const;
export const BUSINESS_CHANGE_DOCUMENT_VERSION =
  'northstar.business-change-document/v1' as const;
export const TRUST_DOMAIN_EVENT_VERSION =
  'northstar.trust-domain-event/v1' as const;
export const TRUST_OUTBOX_VERSION = 'northstar.trust-outbox/v1' as const;
export const POLICY_DECISION_EVIDENCE_VERSION =
  'northstar.policy-decision-evidence/v1' as const;

export type ActorKind = 'AGENT' | 'AUTOMATION' | 'HUMAN' | 'SERVICE' | 'SYSTEM';

export type InvocationChannel =
  'AGENT' | 'API' | 'IMPORT' | 'SYSTEM' | 'UI' | 'WORKFLOW';

export type NonAcceptedInvocationOutcome = 'DENIED' | 'FAILED' | 'TIMED_OUT';
export type ActionInvocationOutcome =
  NonAcceptedInvocationOutcome | 'SUCCEEDED';
export type EvidenceClassification =
  'INTERNAL' | 'PUBLIC' | 'SECRET' | 'SENSITIVE';

export type TrustJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly TrustJsonValue[]
  | { readonly [key: string]: TrustJsonValue };

export interface TrustedContextIdentity {
  readonly environmentId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly tenantId: string;
}

export interface ActorIdentity {
  readonly kind: ActorKind;
  readonly principalId: string;
}

export interface DelegationEvidence {
  readonly delegatedTo: ActorIdentity;
  readonly delegatingPrincipal: ActorIdentity;
  readonly delegationId: string;
}

export interface ResolvedActorAttribution {
  readonly approvingHumanId: string | null;
  readonly delegation: DelegationEvidence | null;
  readonly executionPrincipal: ActorIdentity;
  readonly initiatingHumanId: string | null;
  readonly subject: ActorIdentity | null;
}

export interface TrustedActorEnvelope extends TrustedContextIdentity {
  readonly actor: ResolvedActorAttribution;
  readonly schemaVersion: typeof TRUSTED_ACTOR_ENVELOPE_VERSION;
}

export interface TrustedActorAttributionGateway<
  TContext extends TrustedContextIdentity,
> {
  resolve(context: TContext): Promise<ResolvedActorAttribution>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const evidenceKeyPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;
const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export type ClassifiedEvidenceValueInput =
  | {
      readonly classification: 'INTERNAL' | 'PUBLIC';
      readonly value: unknown;
    }
  | {
      readonly classification: 'SECRET' | 'SENSITIVE';
      /** Accepted only so the boundary can discard it before persistence. */
      readonly value?: unknown;
    };

export type EvidenceMetadataInput = Readonly<
  Record<string, ClassifiedEvidenceValueInput>
>;

export type PersistedClassifiedEvidenceValue =
  | {
      readonly classification: 'INTERNAL' | 'PUBLIC';
      readonly representation: 'VALUE';
      readonly value: TrustJsonValue;
    }
  | {
      readonly classification: 'SECRET' | 'SENSITIVE';
      readonly representation: 'REDACTED';
    };

export type PersistedEvidenceMetadata = Readonly<
  Record<string, PersistedClassifiedEvidenceValue>
>;

export interface PolicyDecisionEvidenceInput {
  readonly decision: 'ALLOW' | 'DENY';
  readonly evaluatorVersion: string;
  readonly policyVersion: string;
  readonly relevantInputs: EvidenceMetadataInput;
  readonly schemaVersion: typeof POLICY_DECISION_EVIDENCE_VERSION;
}

export type BusinessValueStateInput =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'CLEARED' }
  | { readonly state: 'VALUE'; readonly value: unknown };

export interface BusinessFieldChangeInput {
  readonly classification: EvidenceClassification;
  readonly fieldId: string;
  readonly newState: BusinessValueStateInput;
  readonly oldState: BusinessValueStateInput;
}

export type PersistedBusinessValueState =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'CLEARED' }
  | {
      readonly representation: 'VALUE';
      readonly state: 'VALUE';
      readonly value: TrustJsonValue;
    }
  | {
      readonly classification: 'SECRET' | 'SENSITIVE';
      readonly representation: 'REDACTED';
      readonly state: 'VALUE';
    };

export interface PersistedBusinessFieldChange {
  readonly classification: EvidenceClassification;
  readonly fieldId: string;
  readonly newState: PersistedBusinessValueState;
  readonly oldState: PersistedBusinessValueState;
}

export interface InvocationEvidenceCommand {
  readonly actionId: string;
  readonly causationId: string | null;
  readonly channel: InvocationChannel;
  readonly correlationId: string;
  readonly invocationId: string;
  readonly metadata: EvidenceMetadataInput;
  readonly policy: PolicyDecisionEvidenceInput;
  readonly releaseContentHash: string;
  readonly releaseId: string;
}

export interface NonAcceptedInvocationCommand extends InvocationEvidenceCommand {
  readonly failureCode: string;
  readonly outcome: NonAcceptedInvocationOutcome;
}

export interface BusinessChangeInput {
  readonly changeDocumentId: string;
  readonly changes: readonly BusinessFieldChangeInput[];
  readonly recordId: string;
  readonly recordType: string;
  readonly revision: number;
}

export interface TrustDomainEventInput {
  readonly eventId: string;
  readonly eventSchemaVersion: string;
  readonly eventType: string;
  readonly payload: EvidenceMetadataInput;
}

export interface TrustOutboxInput {
  readonly deduplicationKey: string;
  readonly outboxId: string;
}

export interface AcceptedMutationCommand extends InvocationEvidenceCommand {
  readonly change: BusinessChangeInput;
  readonly event: TrustDomainEventInput;
  readonly outbox: TrustOutboxInput;
}

export interface IdempotentMutationBinding {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly releaseContentHash: string;
  readonly releaseId: string;
}

export interface ActionInvocation extends TrustedContextIdentity {
  readonly actionId: string;
  readonly actor: ResolvedActorAttribution;
  readonly causationId: string | null;
  readonly channel: InvocationChannel;
  readonly correlationId: string;
  readonly invocationId: string;
  readonly metadata: PersistedEvidenceMetadata;
  readonly outcome: ActionInvocationOutcome;
  readonly policy: Omit<PolicyDecisionEvidenceInput, 'relevantInputs'> & {
    readonly relevantInputs: PersistedEvidenceMetadata;
  };
  readonly recordedAt: string;
  readonly releaseContentHash: string;
  readonly releaseId: string;
  readonly schemaVersion: typeof ACTION_INVOCATION_VERSION;
}

export interface BusinessChangeDocument extends TrustedContextIdentity {
  readonly actionId: string;
  readonly actor: ResolvedActorAttribution;
  readonly changeDocumentId: string;
  readonly changes: readonly PersistedBusinessFieldChange[];
  readonly correlationId: string;
  readonly domainEventId: string;
  readonly invocationId: string;
  readonly outboxId: string;
  readonly recordId: string;
  readonly recordType: string;
  readonly recordedAt: string;
  readonly releaseContentHash: string;
  readonly releaseId: string;
  readonly revision: number;
  readonly schemaVersion: typeof BUSINESS_CHANGE_DOCUMENT_VERSION;
}

export function redactEvidenceMetadata(
  input: EvidenceMetadataInput,
): PersistedEvidenceMetadata {
  if (!isRecord(input)) {
    throw new TypeError('evidence metadata must be an object');
  }
  const entries = Object.entries(input).map(([key, classified]) => {
    if (!evidenceKeyPattern.test(key)) {
      throw new TypeError(
        'evidence metadata keys must use the closed key form',
      );
    }
    if (!isRecord(classified)) {
      throw new TypeError(`evidence metadata ${key} must be classified`);
    }
    const classification = classified.classification;
    if (classification === 'SECRET' || classification === 'SENSITIVE') {
      return [
        key,
        Object.freeze({ classification, representation: 'REDACTED' as const }),
      ] as const;
    }
    if (classification !== 'INTERNAL' && classification !== 'PUBLIC') {
      throw new TypeError(
        `evidence metadata ${key} has an invalid classification`,
      );
    }
    if (!Object.hasOwn(classified, 'value')) {
      throw new TypeError(`evidence metadata ${key} requires a value`);
    }
    return [
      key,
      Object.freeze({
        classification,
        representation: 'VALUE' as const,
        value: cloneTrustJson(classified.value, `$.${key}.value`),
      }),
    ] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function redactBusinessChanges(
  input: readonly BusinessFieldChangeInput[],
): readonly PersistedBusinessFieldChange[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(
      'business change document requires at least one field change',
    );
  }
  const fieldIds = new Set<string>();
  return Object.freeze(
    input.map((change, index) => {
      if (
        typeof change !== 'object' ||
        change === null ||
        Array.isArray(change)
      ) {
        throw new TypeError(
          `business change ${String(index)} must be an object`,
        );
      }
      if (!evidenceKeyPattern.test(String(change.fieldId))) {
        throw new TypeError(
          'business change fieldId must use the closed key form',
        );
      }
      if (fieldIds.has(change.fieldId)) {
        throw new TypeError(
          `business change repeats fieldId ${change.fieldId}`,
        );
      }
      fieldIds.add(change.fieldId);
      const classification = assertClassification(change.classification);
      return Object.freeze({
        classification,
        fieldId: change.fieldId,
        newState: redactBusinessValueState(
          change.newState,
          classification,
          `$.changes[${String(index)}].newState`,
        ),
        oldState: redactBusinessValueState(
          change.oldState,
          classification,
          `$.changes[${String(index)}].oldState`,
        ),
      });
    }),
  );
}

export function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`${name} must be a UUID`);
}

export function assertCanonicalId(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length > 180 ||
    !canonicalIdPattern.test(value)
  ) {
    throw new TypeError(`${name} must be a canonical ID`);
  }
}

export function assertNonBlank(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank`);
  }
}

export function validateTrustedContextIdentity(
  context: TrustedContextIdentity,
): void {
  assertUuid(context.tenantId, 'tenantId');
  assertUuid(context.environmentId, 'environmentId');
  assertUuid(context.principalId, 'principalId');
  assertUuid(context.requestId, 'requestId');
}

export function freezeResolvedActorAttribution(
  input: ResolvedActorAttribution,
  expectedExecutionPrincipalId: string,
): ResolvedActorAttribution {
  if (!isRecord(input)) {
    throw new TypeError('actor attribution gateway returned an invalid result');
  }
  const executionPrincipal = cloneActorIdentity(
    input.executionPrincipal,
    'executionPrincipal',
  );
  if (executionPrincipal.principalId !== expectedExecutionPrincipalId) {
    throw new TypeError(
      'actor execution principal must match the issued request context',
    );
  }
  const subject =
    input.subject === null
      ? null
      : cloneActorIdentity(input.subject, 'subject');
  const initiatingHumanId = cloneNullableHumanId(
    input.initiatingHumanId,
    'initiatingHumanId',
  );
  const approvingHumanId = cloneNullableHumanId(
    input.approvingHumanId,
    'approvingHumanId',
  );
  let delegation: DelegationEvidence | null = null;
  if (input.delegation !== null) {
    if (!isRecord(input.delegation)) {
      throw new TypeError('delegation must be null or an object');
    }
    assertUuid(input.delegation.delegationId, 'delegationId');
    const delegatingPrincipal = cloneActorIdentity(
      input.delegation.delegatingPrincipal,
      'delegatingPrincipal',
    );
    const delegatedTo = cloneActorIdentity(
      input.delegation.delegatedTo,
      'delegatedTo',
    );
    if (
      delegatedTo.kind !== executionPrincipal.kind ||
      delegatedTo.principalId !== executionPrincipal.principalId
    ) {
      throw new TypeError(
        'delegation target must be the trusted execution principal',
      );
    }
    delegation = Object.freeze({
      delegatedTo,
      delegatingPrincipal,
      delegationId: input.delegation.delegationId,
    });
  }
  return Object.freeze({
    approvingHumanId,
    delegation,
    executionPrincipal,
    initiatingHumanId,
    subject,
  });
}

function cloneActorIdentity(value: ActorIdentity, name: string): ActorIdentity {
  if (!isRecord(value) || !isActorKind(value.kind)) {
    throw new TypeError(`${name} must be a typed actor identity`);
  }
  assertUuid(value.principalId, `${name}.principalId`);
  return Object.freeze({ kind: value.kind, principalId: value.principalId });
}

function cloneNullableHumanId(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a UUID`);
  assertUuid(value, name);
  return value;
}

function isActorKind(value: unknown): value is ActorKind {
  return (
    value === 'AGENT' ||
    value === 'AUTOMATION' ||
    value === 'HUMAN' ||
    value === 'SERVICE' ||
    value === 'SYSTEM'
  );
}

function assertClassification(value: unknown): EvidenceClassification {
  if (
    value !== 'INTERNAL' &&
    value !== 'PUBLIC' &&
    value !== 'SECRET' &&
    value !== 'SENSITIVE'
  ) {
    throw new TypeError('business change has an invalid classification');
  }
  return value;
}

function redactBusinessValueState(
  input: BusinessValueStateInput,
  classification: EvidenceClassification,
  path: string,
): PersistedBusinessValueState {
  if (!isRecord(input)) throw new TypeError(`${path} must be an object`);
  if (input.state === 'ABSENT') return Object.freeze({ state: 'ABSENT' });
  if (input.state === 'CLEARED') return Object.freeze({ state: 'CLEARED' });
  if (input.state !== 'VALUE' || !Object.hasOwn(input, 'value')) {
    throw new TypeError(`${path} has an invalid state`);
  }
  if (classification === 'SECRET' || classification === 'SENSITIVE') {
    return Object.freeze({
      classification,
      representation: 'REDACTED',
      state: 'VALUE',
    });
  }
  return Object.freeze({
    representation: 'VALUE',
    state: 'VALUE',
    value: cloneTrustJson(input.value, `${path}.value`),
  });
}

function cloneTrustJson(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): TrustJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
    seen.add(value);
    const cloned = Object.freeze(
      value.map((entry, index) =>
        cloneTrustJson(entry, `${path}[${String(index)}]`, seen),
      ),
    );
    seen.delete(value);
    return cloned;
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
    seen.add(value);
    const cloned = Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneTrustJson(entry, `${path}.${key}`, seen),
        ]),
      ),
    );
    seen.delete(value);
    return cloned;
  }
  throw new TypeError(`${path} must contain only immutable JSON values`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
