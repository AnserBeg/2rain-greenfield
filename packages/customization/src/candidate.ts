import {
  replayCustomizationPatches,
  type ReplayFailure,
} from './upgrade-replay.js';
import type { ReplayOrigin } from './upgrade-diagnostics.js';
import {
  canonicalize,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  narrowAcknowledgementToDeclared,
  PROJECTION_FAMILY_IDS,
  compileApplicationRelease,
  diffCompiledReleases,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerExecutionOptions,
  type ReleaseDiffEnvelope,
  type UntrustedDefinitionSandboxAttestation,
} from '@north-star/compiler';

import {
  applyCustomizationPatches,
  checkCreateTimeLinks,
  type CustomizationRefusal,
} from './apply.js';
import type { CustomizationPatch, UnsupportedCustomization } from './patch.js';
import {
  renderReleaseDiff,
  type DiffDefinition,
  type RenderedReleaseDiff,
} from './render.js';

export type AcknowledgementInput = NonNullable<
  CompilerExecutionOptions['unboundPermissionAcknowledgement']
>;

export interface CompiledCustomization {
  readonly compiled: CompileSuccess;
  readonly normalizedDefinitionBytes: Uint8Array;
}

export interface CustomizationCandidate extends CompiledCustomization {
  readonly diff: ReleaseDiffEnvelope;
  readonly rendered: RenderedReleaseDiff;
  readonly status: 'compiled';
}

export interface CustomizationCompileFailure {
  readonly diagnostics: readonly unknown[];
  readonly message: string;
  readonly status: 'rejected';
}

export type CustomizationCandidateResult =
  | CustomizationCandidate
  | ReplayFailure
  | CustomizationCompileFailure
  | (CustomizationRefusal & { readonly patchIndex: number })
  | (UnsupportedCustomization & { readonly patchIndex: number });

/**
 * One customization step: the first-party authored base plus the ordered
 * patch chain (the parent's patches, then the new one), normalized into the
 * child revision and compiled with the parent as the expected active release.
 * Pure: the same base, chain and parent give the same release root, which is
 * what makes a persisted patch re-applicable (ADR-0013's determinism gate).
 */
export function compileCustomizationCandidate(input: {
  readonly acknowledgement: AcknowledgementInput;
  readonly upgradeReplay?: boolean;
  readonly origins?: readonly ReplayOrigin[];
  readonly historical?: boolean;
  readonly base: Readonly<Record<string, unknown>>;
  readonly chain: readonly CustomizationPatch[];
  readonly parent: CompiledCustomization;
  /**
   * Only the isolated worker supplies this (`sandbox-worker.ts`); without it
   * the compiler refuses tenant-authored input.
   */
  readonly sandbox?: UntrustedDefinitionSandboxAttestation;
}): CustomizationCandidateResult {
  // Admission applies to the new change. A recorded prefix must still replay.
  const change = input.chain.at(-1);
  if (change && !input.historical && !input.upgradeReplay) {
    const refusal = checkCreateTimeLinks(change);
    if (refusal) return { ...refusal, patchIndex: input.chain.length - 1 };
  }
  const applied = input.upgradeReplay
    ? replayCustomizationPatches(input.base, input.chain, input.origins)
    : applyCustomizationPatches(input.base, input.chain, input.origins);
  if (applied.status !== 'applied') return applied;
  let normalizedDefinitionBytes: Uint8Array;
  try {
    normalizedDefinitionBytes = new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(applied.authored)),
    );
  } catch (error) {
    return rejected(error);
  }
  const normalized = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  const acknowledgement = input.historical
    ? narrowAcknowledgementToDeclared(
        input.acknowledgement,
        new Set(normalized.permissions.map((p) => p.permissionId)),
      )
    : input.acknowledgement;
  let result: ReturnType<typeof compileApplicationRelease>;
  try {
    result = compileApplicationRelease(
      {
        dependencies: [],
        expectedActiveRelease: expectedActiveReleaseFrom(input.parent.compiled),
        kind: 'compilerInput',
        limits: { ...DEFAULT_COMPILER_LIMITS },
        normalizedDefinitionBytes,
        profile: {
          ...MODULE_COMPILER_PROFILE,
          languageVersion: normalized.languageVersion,
          normalizationProfileVersion: normalized.normalizationProfileVersion,
        },
      },
      {
        ...acknowledgement,
        evaluatorBindings: [
          ...(acknowledgement.evaluatorBindings ?? []),
          ...applied.permissionBindings,
        ],
      },
      input.sandbox ? { untrustedDefinitionSandbox: input.sandbox } : {},
    );
  } catch (error) {
    return rejected(error);
  }
  if (result.status !== 'compiled') {
    return Object.freeze({
      diagnostics: result.diagnostics,
      message: 'the compiler refused the customized application',
      status: 'rejected' as const,
    });
  }
  const diff = diffCompiledReleases(input.parent.compiled, result);
  return Object.freeze({
    compiled: result,
    diff,
    normalizedDefinitionBytes,
    rendered: renderCompiledDiff(
      input.parent,
      {
        compiled: result,
        normalizedDefinitionBytes,
      },
      diff,
    ),
    status: 'compiled' as const,
  });
}

/** The plain-language rendering of a compiled pair's diff. */
export function renderCompiledDiff(
  from: CompiledCustomization,
  to: CompiledCustomization,
  diff: ReleaseDiffEnvelope,
  direction: 'forward' | 'reverse' = 'forward',
): RenderedReleaseDiff {
  return renderReleaseDiff({
    diff,
    direction,
    from: definitionOf(from.normalizedDefinitionBytes),
    storage: storageElements(to.compiled),
    to: definitionOf(to.normalizedDefinitionBytes),
  });
}

/** Element kinds of a release's storage transition, in plan order. */
export function storageElements(
  compiled: CompileSuccess,
): readonly { readonly kind: string }[] {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTransition,
  );
  if (!reference) return [];
  const manifest = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!manifest) return [];
  const chunkHash = (
    JSON.parse(new TextDecoder().decode(manifest.canonicalBytes)) as {
      chunks: { contentHash: string }[];
    }
  ).chunks[0]?.contentHash;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === chunkHash,
  );
  if (!chunk) return [];
  const payload = JSON.parse(
    new TextDecoder().decode(chunk.canonicalBytes),
  ) as {
    elements?: { kind: string }[];
  };
  return Object.freeze(
    (payload.elements ?? []).map((element) =>
      Object.freeze({ kind: element.kind }),
    ),
  );
}

function definitionOf(bytes: Uint8Array): DiffDefinition {
  return parseNormalizedApplicationPackageJson(
    bytes,
  ) as unknown as DiffDefinition;
}

function rejected(error: unknown): CustomizationCompileFailure {
  const diagnostics =
    typeof error === 'object' && error !== null && 'diagnostics' in error
      ? ((error as { diagnostics: unknown[] }).diagnostics ?? [])
      : [];
  return Object.freeze({
    diagnostics,
    message: error instanceof Error ? error.message : String(error),
    status: 'rejected' as const,
  });
}
