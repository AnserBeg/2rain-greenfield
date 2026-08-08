import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readCompiledSurfaceManifest } from '../../apps/web/src/surface-contract.js';
import {
  ADOPTED_LANGUAGE_VERSION,
  CanonicalModelError,
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

const COMMAND_BAR_SLOT = 'northstar.bootstrap:slot.item_detail_command_bar';
const BREADCRUMB_SLOT = 'northstar.bootstrap:slot.item_detail_breadcrumb';

/**
 * The authored package this gate compiles: `vertical-v1` upgraded to the ADOPTED
 * language version, with a slot declared `progressive`.
 *
 * **The slot is `breadcrumb`, and the previous round had this wrong.** It used
 * `commandBar` and justified it as "bears no field" -- but this fixture's
 * `item_archive` declares `confirmation: 'humanRequired'` on an
 * `archiveRecordEffect` over `entity.item`, which is `item_get`'s source entity,
 * so that command bar renders an operation the user must confirm. Under the
 * allow-list it is forced, and the old assertion required the opposite.
 *
 * The round trip's subject is *does an authored tier survive compilation and the
 * production reader*, and it does not need a forbidden slot to prove that.
 * `breadcrumb` is unconditionally deferrable, so it isolates the round trip from
 * the deferrability rule entirely.
 *
 * `progressive` rather than `always` is still the only value whose survival
 * proves anything, because `always` is exactly what a reader invents when it
 * drops an unknown key. The upgrade is applied to a CLONE;
 * `vertical-v1.authored.json` is pinned at v3 by golden vectors.
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
  assert.ok(
    detail,
    'fixture must still declare the item_detail record surface',
  );
  const breadcrumb = detail.slots.find((slot) => slot.slot === 'breadcrumb');
  assert.ok(breadcrumb, 'fixture must still declare a breadcrumb slot');
  breadcrumb.disclosureTier = 'progressive';
  return authored as unknown as Record<string, unknown>;
}

/**
 * The reviewer's paired control, isolating the ACTION arm from fields, business
 * keys and any new fixture. Same package, same slot, one property changed.
 */
function authoredWithProgressiveCommandBar(
  confirmation: 'humanRequired' | 'none',
): Record<string, unknown> {
  const authored = authoredWithProgressiveSlot() as unknown as {
    operations: { operationId: string; confirmation?: string }[];
    surfaces: {
      surfaceId: string;
      slots: { slot: string; disclosureTier?: string }[];
    }[];
  };
  const detail = authored.surfaces.find((surface) =>
    surface.surfaceId.endsWith('item_detail'),
  )!;
  for (const slot of detail.slots) delete slot.disclosureTier;
  detail.slots.find((slot) => slot.slot === 'commandBar')!.disclosureTier =
    'progressive';
  const archive = authored.operations.find((operation) =>
    operation.operationId.endsWith('item_archive'),
  );
  assert.ok(archive, 'fixture must still declare item_archive');
  archive.confirmation = confirmation;
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
  const breadcrumb = slots.find((slot) => slot.slotId === BREADCRUMB_SLOT);
  assert.equal(
    breadcrumb?.disclosureTier,
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
  assert.equal(compiled.diagnostics[0]?.subjectId, BREADCRUMB_SLOT);
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

/**
 * The action arm, refusing. `item_archive` demands confirmation and binds to
 * `item_detail` through `entity.item`, so the command bar renders an operation
 * the user must confirm and cannot be deferred.
 */
test('RED: progressive on commandBar is refused when a bound operation confirms', () => {
  // The refusal is raised by normalization, which THROWS rather than returning a
  // failed compile, so the code is asserted off the diagnostic set.
  // `CanonicalModelError` covers every canonical rule; the class alone would not
  // distinguish this from a neighbouring refusal.
  try {
    compileAt(
      authoredWithProgressiveCommandBar('humanRequired'),
      COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    );
    throw new Error('expected normalization to refuse, and it accepted');
  } catch (error) {
    assert.ok(
      error instanceof CanonicalModelError,
      `expected a canonical refusal, got ${String(error)}`,
    );
    assert.deepEqual(
      error.diagnostics.map((entry) => entry.code),
      ['CANON_SURFACE_DISCLOSURE_TIER_ACTION_FORCED'],
    );
    assert.equal(error.diagnostics[0]?.objectId, COMMAND_BAR_SLOT);
    assert.match(error.diagnostics[0]?.rule ?? '', /item_archive/u);
  }
});

/**
 * The same slot, the same package, one property changed: with no confirmed
 * operation bound, the command bar is deferrable. Without this the refusal above
 * is indistinguishable from "commandBar is never deferrable".
 */
test('CONTROL: the same commandBar compiles when no bound operation confirms', () => {
  const compiled = compileAt(
    authoredWithProgressiveCommandBar('none'),
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  );
  assert.equal(
    compiled.status,
    'compiled',
    'the action arm must read the confirmation, not the slot name',
  );
});
