declare const mintedUuidBrand: unique symbol;

/** A UUID minted for record identity, never derived from content bytes. */
export type MintedUuid = string & { readonly [mintedUuidBrand]: true };

export interface TenantEnvironmentIdentity {
  readonly environmentId: string;
  readonly tenantId: string;
}

export interface AppPackageRevisionIdentity {
  readonly revisionId: MintedUuid;
  readonly tenantId: string;
}

export interface TenantReleaseIdentity extends TenantEnvironmentIdentity {
  readonly releaseId: MintedUuid;
}

export interface AppPackageRevision extends AppPackageRevisionIdentity {
  readonly canonicalizationProfileVersion: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly desiredState: Uint8Array;
  readonly hashAlgorithm: 'sha256';
  readonly languageVersion: string;
  readonly normalizationProfileVersion: string;
  readonly parentRevisionId: MintedUuid | null;
  readonly provenance: string;
  readonly schemaVersion: string;
}

export interface TenantRelease extends TenantReleaseIdentity {
  readonly appPackageRevisionId: MintedUuid;
  readonly compilerAttestationDigest: string;
  readonly compilerSemanticProfileVersion: string;
  readonly compilerVersion: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly outputProtocolVersion: string;
  readonly verificationEvidenceId: MintedUuid;
}

export interface PersistedReleaseArtifact {
  readonly artifactKind:
    'projectionChunk' | 'projectionManifest' | 'releaseManifest';
  readonly canonicalBytes: Uint8Array;
  readonly contentHash: string;
  readonly domainTag: string;
  readonly mediaType: 'application/vnd.northstar.canonical+json';
}

export interface PersistedTenantRelease {
  readonly artifacts: readonly PersistedReleaseArtifact[];
  readonly release: TenantRelease;
}

export interface StoreAppPackageRevisionCommand extends AppPackageRevisionIdentity {
  readonly canonicalizationProfileVersion: string;
  readonly contentHash: string;
  readonly createdBy: string;
  readonly desiredState: Uint8Array;
  readonly hashAlgorithm: 'sha256';
  readonly languageVersion: string;
  readonly normalizationProfileVersion: string;
  readonly parentRevisionId: MintedUuid | null;
  readonly provenance: string;
  readonly schemaVersion: string;
}

export interface RegisterTenantReleaseCommand<
  TCompiledRelease,
> extends TenantReleaseIdentity {
  readonly appPackageRevisionId: MintedUuid;
  readonly compiledRelease: TCompiledRelease;
  readonly createdBy: string;
  readonly verificationEvidenceId: MintedUuid;
}

export interface ImmutableReleaseRepository<TTrustedContext, TCompiledRelease> {
  getAppPackageRevision(
    context: TTrustedContext,
    revisionId: MintedUuid,
  ): Promise<AppPackageRevision | null>;
  getTenantRelease(
    context: TTrustedContext,
    releaseId: MintedUuid,
  ): Promise<PersistedTenantRelease | null>;
  registerTenantRelease(
    context: TTrustedContext,
    command: RegisterTenantReleaseCommand<TCompiledRelease>,
  ): Promise<PersistedTenantRelease>;
  storeAppPackageRevision(
    context: TTrustedContext,
    command: StoreAppPackageRevisionCommand,
  ): Promise<AppPackageRevision>;
}

// Freeze C reserves identity/reference shapes only. G1-P4 owns their records,
// decisions, mutation protocol, and persistence.
export interface ActiveReleasePointerIdentity extends TenantEnvironmentIdentity {
  readonly pointerId: MintedUuid;
}

export interface VerificationEvidenceIdentity extends TenantReleaseIdentity {
  readonly verificationEvidenceId: MintedUuid;
}

export interface ReleaseApprovalIdentity extends TenantReleaseIdentity {
  readonly approvalId: MintedUuid;
  readonly verificationEvidenceId: MintedUuid;
}

export interface ReleaseActivationAttemptIdentity extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly approvalId: MintedUuid;
}
