import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCUMENT_POSTING_OPERATION_READER,
  documentPostingDeclarationProblem,
  type DocumentPostingContext,
} from '../../packages/canonical-model/src/document-posting.js';
import { DOCUMENT_POSTING_ENGINES } from '../../packages/canonical-model/src/document-posting-engines.js';
import {
  CanonicalModelError,
  normalizeApplicationPackage,
  type VersionedNormalizedApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { assertPinnedOperationDefinition } from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  compilerInput,
  mustCompile,
  normalizedBytes,
  projectionPayload,
} from './helpers.js';

// DOCUMENT-POSTING slice 1: the general document-posting block on Books'
// post. The compiler checks every block against its registered engine; the
// Customize candidate compiles through the same compiler, so a customized
// package that would unfreeze a posted document is refused there too.

type Json = Record<string, unknown> & {
  operations: Json[];
  fields: Json[];
  relations: Json[];
  stateMachines: Json[];
  capabilityRequirements: Json[];
  surfaces: Json[];
};
const NS = 'northstar.app';
const id = (kind: string, local: string) => `${NS}:${kind}.${local}`;
const POST = id('operation', 'bookkeeping_draft_post');

function source(): Json {
  return structuredClone(composedApplicationDefinition()) as Json;
}
const post = (app: Json) => app.operations.find((o) => o.operationId === POST)!;
const block = (app: Json) =>
  post(app).documentPosting as Json & {
    roles: Record<string, string>;
    options: Record<string, string>;
  };
const machine = (app: Json) =>
  app.stateMachines.find(
    (m) => m.machineId === id('machine', 'bookkeeping_draft_lifecycle'),
  )! as Json & { transitions: Json[] };

const context = (companyScoped = true): DocumentPostingContext => ({
  engines: DOCUMENT_POSTING_ENGINES,
  companyScopedRelation: () => companyScoped,
});
function problem(
  mutate: (app: Json) => void,
  companyScoped = true,
): string | undefined {
  const app = source();
  // The journal's document editor names the line relation; the binding's
  // own refusals are measured without it.
  for (const surface of app.surfaces as Json[]) delete surface.documentEditor;
  mutate(app);
  let normalized: VersionedNormalizedApplicationPackage;
  try {
    normalized = normalizeApplicationPackage(
      app as never,
    ) as unknown as VersionedNormalizedApplicationPackage;
  } catch (error) {
    // Refused before the binding is checked: the language's own rule.
    if (!(error instanceof CanonicalModelError)) throw error;
    return `canonical.${error.diagnostics[0]?.code}`;
  }
  return documentPostingDeclarationProblem(normalized, context(companyScoped))
    ?.reason;
}

test('DOCUMENT-POSTING: the product post compiles, its catalog carries the block and the release needs reader 9', () => {
  const compiled = mustCompile(compilerInput(normalizedBytes(source())));
  const family = PROJECTION_FAMILY_IDS.operationCatalog;
  const payload = projectionPayload<{ operations: Json[] }>(compiled, family);
  const declared = payload.operations.find((o) => o.operationId === POST)!;
  assert.deepEqual(declared.documentPosting, block(source()));
  assertPinnedOperationDefinition(declared);
  assert.equal(
    compiled.bundle.releaseManifest.projections.find(
      (p) => p.familyId === family,
    )!.requiredRuntimeCapability.minimumVersion,
    DOCUMENT_POSTING_OPERATION_READER,
  );
  // A block on a record effect is refused by the runtime's catalog parser.
  const update = payload.operations.find(
    (o) => o.operationId === id('operation', 'bookkeeping_draft_update'),
  )!;
  assert.throws(
    () =>
      assertPinnedOperationDefinition({
        ...update,
        documentPosting: declared.documentPosting,
      }),
    /document-posting operation requires its engine capability/u,
  );
});

test('DOCUMENT-POSTING: Customize cannot unfreeze a posted document; the compiler refuses by name', () => {
  // Retiring the header's update operation removes the guard the lines
  // inherit; a transition into Posted lets anyone but the engine post.
  for (const [label, mutate, reason] of [
    [
      'a header update guard that leaves Ready editable',
      (app: Json) => {
        const update = app.operations.find(
          (o) => o.operationId === id('operation', 'bookkeeping_draft_update'),
        )!;
        const guard = update.precondition as Json & { terms: Json[] };
        update.precondition = { ...guard, terms: guard.terms.slice(1) };
      },
      'freeze',
    ],
    [
      'a transition into Posted',
      (app: Json) => {
        machine(app).transitions.push({
          ...machine(app).transitions[0],
          transitionId: id('transition', 'bookkeeping_draft_force'),
          orderKey: 30,
          toState: {
            kind: 'stateReference',
            schemaVersion: 'v6',
            targetId: id('state', 'bookkeeping_draft_state_posted'),
          },
          fromState: {
            kind: 'stateReference',
            schemaVersion: 'v6',
            targetId: id('state', 'bookkeeping_draft_state_ready'),
          },
        } as never);
      },
      'postedReachable',
    ],
  ] as const) {
    const app = source();
    mutate(app);
    const result = compileApplication(compilerInput(normalizedBytes(app)));
    const refusal =
      result.status === 'failed'
        ? result.diagnostics.find(
            (d) => d.code === 'COMPILER_DOCUMENT_POSTING_INVALID',
          )
        : undefined;
    assert.equal(
      refusal?.rule,
      reason,
      `a customized package with ${label} compiled: ${result.status}`,
    );
  }
  // Retiring the header's update operation is refused before the binding is
  // checked: every company-owned entity needs its update projection.
  const retired = source();
  retired.operations.find(
    (o) => o.operationId === id('operation', 'bookkeeping_draft_update'),
  )!.lifecycle = 'retired';
  assert.equal(
    compileApplication(compilerInput(normalizedBytes(retired))).status,
    'failed',
    'a customized package with the header update retired compiled',
  );
});

test('DOCUMENT-POSTING: each misbound block is refused with its reason', () => {
  const cases: readonly (readonly [
    string,
    (app: Json) => void,
    string | RegExp,
  ])[] = [
    [
      'an unregistered engine',
      (app) => {
        block(app).engine = 'northstar.ledger:capability.other_engine';
      },
      'engineUnregistered',
    ],
    [
      'an engine other than the effect capability',
      (app) => {
        (post(app).effect as Json).capability = {
          kind: 'capabilityReference',
          schemaVersion: 'v6',
          targetId: 'northstar.ledger:capability.ledger_books_start',
        };
      },
      'effect',
    ],
    [
      'a missing role',
      (app) => {
        delete block(app).roles.memo;
      },
      'roles',
    ],
    [
      'an extra role',
      (app) => {
        block(app).roles.extra = id('field', 'bookkeeping_draft_memo');
      },
      'roles',
    ],
    [
      'an amount of scale 2',
      (app) => {
        const amount = app.fields.find(
          (f) => f.fieldId === id('field', 'bookkeeping_draft_line_amount'),
        )!;
        amount.fieldType = { ...(amount.fieldType as Json), scale: 2 };
      },
      'role.amount',
    ],
    [
      'an amount stored as text',
      (app) => {
        block(app).roles.amount = id(
          'field',
          'bookkeeping_draft_line_account_code',
        );
      },
      'role.amount',
    ],
    [
      'an unbound option',
      (app) => {
        delete block(app).options.credit;
      },
      'option.credit',
    ],
    [
      'a reference relation',
      (app) => {
        app.relations.find(
          (r) =>
            r.relationId === id('relation', 'bookkeeping_draft_line_draft'),
        )!.ownership = 'reference';
      },
      /^(lines|canonical\.CANON_RELATION_PARENT_SCOPE_INVALID)$/u,
    ],
    [
      'an optional relation',
      (app) => {
        app.relations.find(
          (r) =>
            r.relationId === id('relation', 'bookkeeping_draft_line_draft'),
        )!.required = false;
      },
      /^(lines|canonical\.CANON_RELATION_PARENT_SCOPE_INVALID)$/u,
    ],
    [
      'a Posted state that is not terminal',
      (app) => {
        (machine(app).states as Json[]).find(
          (s) => s.stateId === id('state', 'bookkeeping_draft_state_posted'),
        )!.terminal = false;
      },
      'state',
    ],
    [
      'a header guard that leaves Ready editable',
      (app) => {
        const update = app.operations.find(
          (o) => o.operationId === id('operation', 'bookkeeping_draft_update'),
        )!;
        const guard = update.precondition as Json & { terms: Json[] };
        update.precondition = { ...guard, terms: guard.terms.slice(1) };
      },
      'freeze',
    ],
    [
      'no confirmation',
      (app) => {
        post(app).confirmation = 'none';
      },
      'confirmation',
    ],
  ];
  assert.equal(
    problem(() => undefined),
    undefined,
  );
  for (const [label, mutate, reason] of cases)
    if (typeof reason === 'string')
      assert.equal(problem(mutate), reason, `${label} was not refused`);
    else
      assert.match(problem(mutate) ?? '', reason, `${label} was not refused`);
  assert.equal(
    problem(() => undefined, false),
    'lines',
    'a relation whose key does not carry the company was not refused',
  );
});
