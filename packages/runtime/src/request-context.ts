import { randomUUID } from 'node:crypto';

export interface AuthenticatedIdentity {
  readonly environmentId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface UntrustedRequestInput {
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
}

export interface TrustedRequestContext extends AuthenticatedIdentity {
  readonly requestId: string;
}

export type AuthenticateRequest = (
  request: UntrustedRequestInput,
) => Promise<AuthenticatedIdentity | null>;

export class AuthenticationRequiredError extends Error {
  override readonly name = 'AuthenticationRequiredError';
}

export class InvalidAuthenticatedIdentityError extends Error {
  override readonly name = 'InvalidAuthenticatedIdentityError';
}

export class UntrustedIdentityInputError extends Error {
  override readonly name = 'UntrustedIdentityInputError';
}

const issuedContexts = new WeakSet<object>();
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const forbiddenArgumentNames = new Set([
  'environmentId',
  'environment_id',
  'legalEntityId',
  'legal_entity_id',
  'principalId',
  'principal_id',
  'tenantId',
  'tenant_id',
]);
const forbiddenHeaderNames = new Set([
  'environment-id',
  'legal-entity-id',
  'principal-id',
  'tenant-id',
  'x-environment-id',
  'x-legal-entity-id',
  'x-principal-id',
  'x-tenant-id',
]);

export class AuthenticatedRequestEntryAdapter {
  constructor(private readonly authenticate: AuthenticateRequest) {}

  async enter(request: UntrustedRequestInput): Promise<TrustedRequestContext> {
    rejectCallerSuppliedIdentity(request);
    const identity = await this.authenticate(request);
    if (!identity) {
      throw new AuthenticationRequiredError(
        'authenticated request identity is required',
      );
    }
    validateAuthenticatedIdentity(identity);

    const context: TrustedRequestContext = Object.freeze({
      environmentId: identity.environmentId,
      principalId: identity.principalId,
      requestId: randomUUID(),
      tenantId: identity.tenantId,
    });
    issuedContexts.add(context);
    return context;
  }
}

export function assertTrustedRequestContext(
  value: unknown,
): asserts value is TrustedRequestContext {
  if (
    typeof value !== 'object' ||
    value === null ||
    !issuedContexts.has(value)
  ) {
    throw new TypeError(
      'trusted request context must be issued by AuthenticatedRequestEntryAdapter',
    );
  }
}

function rejectCallerSuppliedIdentity(request: UntrustedRequestInput): void {
  for (const headerName of Object.keys(request.headers ?? {})) {
    if (forbiddenHeaderNames.has(headerName.toLowerCase())) {
      throw new UntrustedIdentityInputError(
        `caller-supplied identity header is forbidden: ${headerName}`,
      );
    }
  }

  for (const argumentName of Object.keys(request.arguments ?? {})) {
    if (forbiddenArgumentNames.has(argumentName)) {
      throw new UntrustedIdentityInputError(
        `caller-supplied identity argument is forbidden: ${argumentName}`,
      );
    }
  }
}

function validateAuthenticatedIdentity(identity: AuthenticatedIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (!uuidPattern.test(value)) {
      throw new InvalidAuthenticatedIdentityError(
        `authenticated ${name} must be a UUID`,
      );
    }
  }
}
