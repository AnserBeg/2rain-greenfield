import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SurfaceProjectionError,
  readCompiledSurfaceManifest,
} from '../../apps/web/src/surface-contract.js';
import {
  ADOPTED_LANGUAGE_VERSION,
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  compileApplication,
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  type CompileSuccess,
  type CompilerSemanticProfileVersion,
} from '../../packages/compiler/src/index.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { partyRuntimeProjections } from '../fixtures/g2/party/compiler.js';

const identity = {
  environmentId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000002',
  tenantId: 'c1000000-0000-4000-8000-000000000003',
} as const;

const BREADCRUMB_SLOT = 'northstar.bootstrap:slot.item_detail_breadcrumb';

/**
 * The authored package this gate compiles: `vertical-v1` upgraded to the ADOPTED
 * language version, with `breadcrumb` declared `always` -- the only honourable
 * tier, since `progressive` and `onDemand` are refused by name.
 *
 * The declaration is deliberate even though lowering would resolve to the same
 * value without it: it keeps the package one whose tier is AUTHORED, which is
 * what the v1 refusal below needs a subject for.
 *
 * The upgrade is applied to a CLONE; `vertical-v1.authored.json` is pinned at v3
 * by golden vectors.
 */
function authoredWithDeclaredTier(): Record<string, unknown> {
  const raw = readFileSync(
    'test/fixtures/g1/compiler/vertical-v1.authored.json',
    'utf8',
  );
  const authored = JSON.parse(
    raw.replaceAll('"v3"', `"${ADOPTED_LANGUAGE_VERSION}"`),
  ) as {
    surfaces: {
      surfaceId: string;
      slots: { slot: string; disclosureTier?: string }[];
    }[];
  };
  const detail = authored.surfaces.find((surface) =>
    surface.surfaceId.endsWith('item_detail'),
  );
  assert.ok(
    detail,
    'fixture must still declare the item_detail record surface',
  );
  const breadcrumb = detail.slots.find((slot) => slot.slot === 'breadcrumb');
  assert.ok(breadcrumb, 'fixture must still declare a breadcrumb slot');
  breadcrumb.disclosureTier = 'always';
  return authored as unknown as Record<string, unknown>;
}

function compileAt(
  authored: Record<string, unknown>,
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion,
) {
  const normalized = normalizeApplicationPackage(authored) as unknown as {
    languageVersion: string;
    normalizationProfileVersion: string;
  };
  return compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: {
      ...DEFAULT_COMPILER_PROFILE,
      compilerSemanticProfileVersion,
      languageVersion:
        normalized.languageVersion as typeof DEFAULT_COMPILER_PROFILE.languageVersion,
      normalizationProfileVersion:
        normalized.normalizationProfileVersion as typeof DEFAULT_COMPILER_PROFILE.normalizationProfileVersion,
    },
  });
}

const policy: CurrentPolicyGateway = {
  async authorize() {
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'disclosure-tier-round-trip/v1',
    };
  },
  async readCurrentVersion() {
    return { policyVersion: 'disclosure-tier-round-trip/v1' };
  },
};

async function viewOf(
  compiled: CompileSuccess,
  transform: (
    projections: LoadedRequestRuntimeDefinition['projections'],
  ) => LoadedRequestRuntimeDefinition['projections'] = (projections) =>
    projections,
): Promise<RequestRuntimeView> {
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: identity.environmentId,
          pointer: {
            fence: 1,
            pointerId: 'c1000000-0000-4000-8000-000000000006',
          },
          projections: transform(partyRuntimeProjections(compiled)),
          release: {
            contentHash: compiled.releaseRoot,
            releaseId: 'c1000000-0000-4000-8000-000000000007',
          },
          tenantId: identity.tenantId,
        };
      },
    },
    policy,
  );
  return entry.run({}, (view) => view);
}

/**
 * The round trip through the PRODUCTION reader rather than a test-local parse:
 * compile at v2, take the payload the compiler actually emitted, and require the
 * tier to survive `readCompiledSurfaceManifest`.
 *
 * **What this proves, stated no wider than it is.** Lowering resolves
 * `slot.disclosureTier ?? DEFAULT_DISCLOSURE_TIER`, so an explicit `always` and
 * an absent declaration produce identical output -- a mutation that ignored the
 * authored value entirely would survive this test. The claim is therefore that a
 * RESOLVED v2 tier survives the reader, not that the authored declaration drove
 * lowering. Projection erases that distinction by design, and no test here can
 * recover it.
 *
 * What it does close is real: `parseSlot` builds a fresh object from the keys it
 * recognises, so before this gate it would have silently DROPPED the field the
 * moment v2 was adopted. Paired with the absence test below, the two together
 * distinguish CARRIED from INVENTED -- present at v2, absent at v1 -- which is
 * exactly what the reader contract's own comment claims.
 *
 * It needs no adoption: the profile version is passed explicitly, so nothing is
 * recorded and no lineage entry is minted (ADR-0047 §4a).
 */
test('an authored tier survives compile-at-v2 through the production reader', async () => {
  const compiled = compileAt(
    authoredWithDeclaredTier(),
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  );
  assert.equal(
    compiled.status,
    'compiled',
    `expected a v2 compile to succeed: ${JSON.stringify(compiled.status === 'failed' ? compiled.diagnostics : [])}`,
  );
  assert.ok(compiled.status === 'compiled');

  const manifest = readCompiledSurfaceManifest(await viewOf(compiled));
  const slots = manifest.surfaces.flatMap((surface) => surface.slots);
  assert.ok(slots.length > 0, 'the reader must return slots to inspect');
  const breadcrumb = slots.find((slot) => slot.slotId === BREADCRUMB_SLOT);
  assert.equal(
    breadcrumb?.disclosureTier,
    'always',
    'the reader dropped the declared tier, which is the adoption trap this gate exists to close',
  );
  const keyFacts = slots.find((slot) => slot.slot === 'keyFacts');
  assert.equal(
    keyFacts?.disclosureTier,
    'always',
    'an undeclared tier must resolve at projection time, not go missing',
  );
});

/**
 * The other half of ADR-0041 §2, measured end to end: under a profile that
 * cannot emit the field, the same authored package is REFUSED rather than
 * compiled into a manifest with no tier at all.
 */
test('RED: the same authored package is refused under the adopted v1 profile', () => {
  const compiled = compileAt(
    authoredWithDeclaredTier(),
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  );
  assert.equal(compiled.status, 'failed');
  assert.ok(compiled.status === 'failed');
  assert.deepEqual(
    compiled.diagnostics.map((entry) => entry.code),
    ['COMPILER_DISCLOSURE_TIER_NOT_EMITTED'],
  );
  assert.equal(compiled.diagnostics[0]?.subjectId, BREADCRUMB_SLOT);
});

/**
 * The vacuity control for the refusal above: a package declaring NO tier
 * compiles cleanly at v1, so the refusal reads the declaration rather than the
 * profile alone.
 */
test('CONTROL: a package declaring no tier still compiles under v1', () => {
  const authored = authoredWithDeclaredTier() as unknown as {
    surfaces: { slots: Record<string, unknown>[] }[];
  };
  for (const surface of authored.surfaces) {
    for (const slot of surface.slots) delete slot.disclosureTier;
  }
  const compiled = compileAt(
    authored as unknown as Record<string, unknown>,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  );
  assert.equal(compiled.status, 'compiled');
});

/**
 * The control `parseSlot`'s unknown-tier refusal was shipping without, found by
 * this packet's own mutation harness rather than by review: removing the refusal
 * left every suite green.
 *
 * `parseSlot` builds a fresh object from the keys it recognises, so an
 * unrecognised value would otherwise be DROPPED rather than refused -- the
 * reader would silently serve a manifest whose tier it did not understand. The
 * refusal is the difference between that and an honest failure, and it is now
 * observed.
 */
test('RED: the reader refuses a tier value outside the closed vocabulary', async () => {
  const compiled = compileAt(
    authoredWithDeclaredTier(),
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  );
  assert.ok(compiled.status === 'compiled');
  const view = await viewOf(compiled, (projections) => {
    const payload = structuredClone(projections.surface.payload) as {
      surfaces: { slots: { disclosureTier?: string }[] }[];
    };
    const slot = payload.surfaces.flatMap((surface) => surface.slots)[0];
    assert.ok(slot, 'the payload must carry a slot to corrupt');
    slot.disclosureTier = 'hidden';
    return {
      ...projections,
      surface: { ...projections.surface, payload },
    };
  });
  assert.throws(
    () => readCompiledSurfaceManifest(view),
    (error: unknown) => {
      assert.ok(error instanceof SurfaceProjectionError);
      assert.equal(error.code, 'INVALID_SURFACE_SLOT');
      return true;
    },
    'an unknown tier must be refused, not dropped',
  );
});

/**
 * The other half of the reader contract, and the one nothing covered. The v2 test
 * proves a PRESENT recognized field is carried; this proves an ABSENT field stays
 * absent.
 *
 * Without it a `parseSlot` that invented `{ disclosureTier: 'always' }` from an
 * absent input would survive the whole packet -- and that reader would be
 * claiming, on every pre-v2 artifact ever recorded, to know a tier the projection
 * never emitted. Every entry in the lineage is compiled at v0 or v1, so this is
 * the shape the production artifact actually has.
 */
test('an absent tier stays absent through the production reader at v1', async () => {
  const authored = authoredWithDeclaredTier() as unknown as {
    surfaces: { slots: { disclosureTier?: string }[] }[];
  };
  for (const surface of authored.surfaces) {
    for (const slot of surface.slots) delete slot.disclosureTier;
  }
  const compiled = compileAt(
    authored as unknown as Record<string, unknown>,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  );
  assert.ok(
    compiled.status === 'compiled',
    'a package declaring no tier must compile at v1',
  );

  const manifest = readCompiledSurfaceManifest(await viewOf(compiled));
  const slots = manifest.surfaces.flatMap((surface) => surface.slots);
  assert.ok(slots.length > 0, 'the reader must return slots to inspect');
  for (const slot of slots) {
    assert.equal(
      Object.hasOwn(slot, 'disclosureTier'),
      false,
      `${slot.slotId}: the reader invented a tier the v1 projection never emitted`,
    );
  }
});
