import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  narrowAcknowledgementToDeclared,
  readUnboundPermissionAcknowledgementFor,
} from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  DEFAULT_COMPILER_LIMITS,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
} from '../../packages/compiler/src/index.js';
import { serializeRelease } from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

export const STOCK_COUNT_PRECEDING_READER =
  '7900ebd0448cc81699dbb61e5060ee16d841d7e8';
let fixture: ReturnType<typeof compileFixture> | undefined;
let historical: Record<string, unknown> | undefined;

/** Isolate earlier surface features on a base with the original stock-count evidence. */
export function applicationBeforeStockCountWorkflow() {
  return (fixture ??= compileFixture());
}

function compileFixture() {
  const authoredPath = resolve('apps/web/release/app.authored.json');
  const authored = withoutStockCountWorkflow(
    JSON.parse(readFileSync(authoredPath, 'utf8')),
  );
  // The compatibility fixtures also predate DOCS-1's optional PO approval
  // dependencies. Keep those reads mandatory for their older query catalogs.
  for (const { readModel } of authored.queries as {
    readModel?: { queries: Record<string, { required?: boolean }> };
  }[]) {
    for (const dependency of Object.values(readModel?.queries ?? {}))
      delete dependency.required;
  }
  // Older-reader witnesses must reach the feature they exercise.
  for (const entity of authored.entities as { reportSource?: unknown }[])
    delete entity.reportSource;
  return singleTransitionApplication(withoutBooks(authored));
}

/**
 * Books (ACCOUNTING-1 1a-ii) postdates every archived reader these fixtures
 * feed: its permission is bound only in today's current-policy bindings, so
 * an archived compiler would refuse it as unbound. The fixture keeps the
 * features it isolates and leaves the Books module out, with the company
 * page it composes restored to the archived declaration.
 */
function withoutBooks(authored: Record<string, unknown>) {
  const books = ':module.bookkeeping_books';
  type Entry = Record<string, unknown> & {
    module?: { targetId: string };
    permission?: { targetId: string };
    effect?: { capability?: { targetId: string } };
    entity?: { targetId: string };
  };
  const list = (key: string) => (authored[key] as Entry[] | undefined) ?? [];
  const ofBooks = (entry: Entry) =>
    entry.module?.targetId.endsWith(books) ?? false;
  const operations = list('operations');
  const removed = operations.filter(ofBooks);
  // DOCUMENT-POSTING: Books also declares the journal draft and its lines.
  const entities = new Set(
    list('entities')
      .filter(ofBooks)
      .map((entity) => entity.entityId as string),
  );
  const queries = new Set(
    list('queries')
      .filter(ofBooks)
      .map((query) => query.queryId as string),
  );
  const inEntity = (entry: Entry) =>
    entry.entity !== undefined && entities.has(entry.entity.targetId);
  const permissions = new Set(removed.map((o) => o.permission?.targetId));
  const capabilities = new Set(
    removed.map((o) => o.effect?.capability?.targetId),
  );
  const archivedSurfaces = new Map(
    (historical!.surfaces as Entry[]).map((surface) => [
      surface.surfaceId,
      surface,
    ]),
  );
  return {
    ...authored,
    assertions: list('assertions').filter(
      (assertion) =>
        !queries.has(
          String(
            (assertion.invocation as { query?: { targetId?: string } })?.query
              ?.targetId,
          ),
        ),
    ),
    capabilityRequirements: list('capabilityRequirements').filter(
      (requirement) => !capabilities.has(requirement.capabilityId as string),
    ),
    entities: list('entities').filter((entity) => !ofBooks(entity)),
    fields: list('fields').filter((field) => !inEntity(field)),
    modules: list('modules').filter(
      (module) => !String(module.moduleId).endsWith(books),
    ),
    operations: operations.filter((operation) => !removed.includes(operation)),
    permissions: list('permissions').filter(
      (permission) =>
        !permissions.has(permission.permissionId as string) &&
        !entities.has(
          String((permission.resource as { targetId?: string })?.targetId),
        ),
    ),
    queries: list('queries').filter((query) => !ofBooks(query)),
    relations: list('relations').filter(
      (relation) =>
        !entities.has(
          String((relation.sourceEntity as { targetId?: string })?.targetId),
        ) &&
        !entities.has(
          String((relation.targetEntity as { targetId?: string })?.targetId),
        ),
    ),
    stateMachines: list('stateMachines').filter(
      (machine) => !inEntity(machine),
    ),
    storageMappings: list('storageMappings').filter(
      (mapping) => !inEntity(mapping),
    ),
    surfaces: list('surfaces')
      .filter((surface) => !ofBooks(surface))
      .map((surface) =>
        JSON.stringify(surface).includes(':operation.bookkeeping_')
          ? archivedSurfaces.get(surface.surfaceId)!
          : surface,
      ),
  };
}

/** Install a test's chosen first-party source directly after the retained bootstrap. */
export function singleTransitionApplication(authored: Record<string, unknown>) {
  const { bootstrap } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  return {
    authored,
    release: {
      schemaVersion: 'northstar.web:compiled-application-release/v1',
      application: compileAfter(authored, bootstrap),
      bootstrap: serializeRelease(bootstrap),
    },
  };
}

/** Stage a new first-party base above the exact lineage installed by the test. */
export function nextPlatformRelease(
  previous: unknown,
  authored: Record<string, unknown>,
) {
  const { application, applications, bootstrap } =
    parseCompiledApplication(previous);
  return {
    schemaVersion: 'northstar.web:compiled-application-release/v2',
    applications: [
      ...applications.map(serializeRelease),
      compileAfter(authored, application),
    ],
    bootstrap: serializeRelease(bootstrap),
  };
}

function compileAfter(
  authored: Record<string, unknown>,
  parent: ReturnType<typeof parseCompiledApplication>['bootstrap'],
) {
  const authoredPath = resolve('apps/web/release/app.authored.json');
  const normalized = normalizeApplicationPackage(authored);
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(normalized),
  );
  const compiled = compileApplicationRelease(
    {
      kind: 'compilerInput',
      dependencies: [],
      expectedActiveRelease: expectedActiveReleaseFrom(parent.compiled),
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    },
    // Narrowed to what this first party declares (it may leave Books out).
    narrowAcknowledgementToDeclared(
      readUnboundPermissionAcknowledgementFor(
        authoredPath,
        normalized.package.packageId,
      ),
      new Set(normalized.permissions.map((p) => p.permissionId)),
    ),
  );
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.status === 'compiled' ? [] : compiled.diagnostics),
  );
  return serializeRelease({ compiled, normalizedDefinitionBytes });
}

/**
 * Restore the archived count definitions, including the legacy queries and
 * surfaces. The fixture shares the current permission acknowledgement file,
 * so it keeps the transition permission declarations without their operations.
 */
export function withoutStockCountWorkflow(authored: Record<string, unknown>) {
  historical ??= JSON.parse(
    execFileSync(
      'git',
      [
        'show',
        `${STOCK_COUNT_PRECEDING_READER}:apps/web/release/app.authored.json`,
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  ) as Record<string, unknown>;
  const collections = {
    fields: 'fieldId',
    operations: 'operationId',
    queries: 'queryId',
    relations: 'relationId',
    surfaces: 'surfaceId',
  } as const;
  return {
    ...authored,
    ...Object.fromEntries(
      Object.entries(collections).map(([collection, key]) => {
        const isCount = (entry: Record<string, unknown>) =>
          /:(?:field|operation|query|relation|surface)\.stock_count_/u.test(
            String(entry[key]),
          );
        const current = authored[collection] as Record<string, unknown>[];
        const prior = historical![collection] as Record<string, unknown>[];
        return [
          collection,
          [
            ...current.filter((entry) => !isCount(entry)),
            ...prior.filter(isCount),
          ],
        ];
      }),
    ),
  };
}
