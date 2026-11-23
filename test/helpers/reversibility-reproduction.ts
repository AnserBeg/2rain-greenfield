/**
 * AI-UNDO-1: the agent-discovery chunk gained the reversibility declaration on
 * the adopted profile, re-baselined by owner ruling (ADR-0066, no profile cut).
 * A test that reproduces release bytes across binaries is narrowed to exactly
 * that change: every projection family keeps its artifact root and reader
 * floor, the agent-discovery payload is the prior one plus `reversibility`
 * behind floor 5, and a storage transition differs only in the predecessor
 * release root it names (which hashes that predecessor's agent chunk). Any
 * other drift still fails.
 */
import assert from 'node:assert/strict';

import { REVERSIBILITY_AGENT_READER } from '../../packages/canonical-model/src/reversibility.js';

export interface ProjectionFingerprint {
  readonly families: Record<
    string,
    {
      readonly artifactRoot: string;
      readonly requiredRuntimeCapability: unknown;
    }
  >;
  readonly agent: Record<string, unknown> | null;
  readonly transition: Record<string, unknown> | null;
}

interface CompiledLike {
  readonly bundle: {
    readonly releaseManifest: {
      readonly projections: readonly {
        readonly familyId: string;
        readonly artifactRoot: string;
        readonly requiredRuntimeCapability?: unknown;
      }[];
    };
    readonly artifacts: readonly {
      readonly contentHash: string;
      readonly canonicalBytes: Uint8Array;
    }[];
  };
}

/** Per family: artifact root and floor; the agent and transition payloads. */
export function projectionFingerprint(
  compiled: CompiledLike,
): ProjectionFingerprint {
  const decode = (hash: string): unknown =>
    JSON.parse(
      new TextDecoder().decode(
        compiled.bundle.artifacts.find((a) => a.contentHash === hash)!
          .canonicalBytes,
      ),
    );
  const payload = (root: string) =>
    decode(
      (decode(root) as { chunks: { contentHash: string }[] }).chunks[0]!
        .contentHash,
    ) as Record<string, unknown>;
  const families: Record<
    string,
    { artifactRoot: string; requiredRuntimeCapability: unknown }
  > = {};
  let agent: Record<string, unknown> | null = null;
  let transition: Record<string, unknown> | null = null;
  for (const p of compiled.bundle.releaseManifest.projections) {
    families[p.familyId] = {
      artifactRoot: p.artifactRoot,
      requiredRuntimeCapability: p.requiredRuntimeCapability ?? null,
    };
    if (p.familyId === 'northstar.compiler:projection-family.agent-discovery')
      agent = payload(p.artifactRoot);
    if (
      p.familyId === 'northstar.compiler:projection-family.storage-transition'
    )
      transition = payload(p.artifactRoot);
  }
  return { families, agent, transition };
}

/** The same function as source, for an archived tree to run on its result. */
export const FINGERPRINT_SOURCE = `const __name = (f) => f; const projectionFingerprint = ${projectionFingerprint.toString()};`;

export function assertReproducedExceptReversibility(
  current: ProjectionFingerprint,
  prior: ProjectionFingerprint,
  /** The predecessor roots each side's storage transition must name. */
  predecessors?: { readonly current: string; readonly prior: string },
): void {
  const agentFamily = 'northstar.compiler:projection-family.agent-discovery';
  const transitionFamily =
    'northstar.compiler:projection-family.storage-transition';
  assert.deepEqual(
    Object.keys(current.families).sort(),
    Object.keys(prior.families).sort(),
  );
  for (const [family, entry] of Object.entries(prior.families)) {
    if (family === agentFamily) continue;
    if (
      family === transitionFamily &&
      current.families[family]?.artifactRoot !== entry.artifactRoot
    ) {
      assert.ok(predecessors, 'a moved transition names its predecessors');
      const { fromReleaseRoot: now, ...currentRest } = current.transition!;
      const { fromReleaseRoot: then, ...priorRest } = prior.transition!;
      assert.equal(now, predecessors.current);
      assert.equal(then, predecessors.prior);
      assert.deepEqual(currentRest, priorRest);
      assert.deepEqual(
        current.families[family]?.requiredRuntimeCapability,
        entry.requiredRuntimeCapability,
      );
      continue;
    }
    assert.deepEqual(current.families[family], entry, family);
  }
  assert.ok(current.agent && prior.agent);
  const { reversibility, ...rest } = current.agent;
  assert.ok(reversibility, 'the current release carries the declaration');
  assert.ok(!Object.hasOwn(prior.agent, 'reversibility'));
  assert.deepEqual(rest, prior.agent);
  assert.deepEqual(current.families[agentFamily]?.requiredRuntimeCapability, {
    capabilityId: 'northstar.runtime:capability.agent-discovery',
    minimumVersion: REVERSIBILITY_AGENT_READER,
  });
}
