import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readCompiledSurfaceManifest } from '../../apps/web/src/surface-contract.js';
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
  type CurrentPolicyDecisionRequest,
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

const COMMAND_BAR_SLOT = 'northstar.bootstrap:slot.item_detail_command_bar';

/**
 * The authored package this gate compiles: `vertical-v1` upgraded to the ADOPTED
 * language version, with its `commandBar` slot declared `progressive`.
 *
 * Three choices are load-bearing. The fixture is one that actually passes
 * compiler conformance -- the canonical-model fixture normalizes but does not
 * compile, so it cannot reach a projection at all. `commandBar` bears no field,
 * so `progressive` is admissible there; a forcing slot could not carry it.
 * And `progressive` rather than `always` is the only value whose survival proves
 * anything, because `always` is exactly what a reader invents when it drops an
 * unknown key.
 *
 * The upgrade is applied to a CLONE. `vertical-v1.authored.json` is pinned at v3
 * by golden vectors and must not move.
 */
function authoredWithProgressiveSlot(): Record<string, unknown> {
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
  assert.ok(detail, 'fixture must still declare the item_detail record surface');
  const commandBar = detail.slots.find((slot) => slot.slot === 'commandBar');
  assert.ok(commandBar, 'fixture must still declare a commandBar slot');
  commandBar.disclosureTier = 'progressive';
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
  async authorize(request: CurrentPolicyDecisionRequest) {
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'disclosure-tier-round-trip/v1',
      requestId: request.requestId,
    };
  },
  async readCurrentVersion() {
    return { policyVersion: 'disclosure-tier-round-trip/v1' };
  },
};

async function viewOf(compiled: CompileSuccess): Promise<RequestRuntimeView> {
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
          projections: partyRuntimeProjections(compiled),
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
 * The whole round trip, through the PRODUCTION reader rather than a test-local
 * parse: compile an authored `progressive` explicitly at v2, take the payload
 * the compiler actually emitted, and require the tier to survive
 * `readCompiledSurfaceManifest`.
 *
 * This closes two holes at once. `parseSlot` builds a fresh object from the keys
 * it recognises, so before this it would have silently DROPPED the tier the
 * moment v2 was adopted -- a defect no gate would have reported. And every other
 * test in this packet asserts the default; this is the only one that compiles an
 * explicit non-default value and reads it back.
 *
 * It needs no adoption: the profile version is passed explicitly, so nothing is
 * recorded and no lineage entry is minted (ADR-0047 §4a).
 */
test('an authored progressive survives compile-at-v2 through the production reader', async () => {
  const compiled = compileAt(
    authoredWithProgressiveSlot(),
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
  const commandBar = slots.find((slot) => slot.slotId === COMMAND_BAR_SLOT);
  assert.equal(
    commandBar?.disclosureTier,
    'progressive',
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
    authoredWithProgressiveSlot(),
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  );
  assert.equal(compiled.status, 'failed');
  assert.ok(compiled.status === 'failed');
  assert.deepEqual(
    compiled.diagnostics.map((entry) => entry.code),
    ['COMPILER_DISCLOSURE_TIER_NOT_EMITTED'],
  );
  assert.equal(compiled.diagnostics[0]?.subjectId, COMMAND_BAR_SLOT);
});

/**
 * The vacuity control for the refusal above: a package declaring NO tier
 * compiles cleanly at v1, so the refusal reads the declaration rather than the
 * profile alone.
 */
test('CONTROL: a package declaring no tier still compiles under v1', () => {
  const authored = authoredWithProgressiveSlot() as unknown as {
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
