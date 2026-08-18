import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const focusedSurfaceTest = [
  '--import',
  'tsx',
  '--test',
  '--test-name-pattern=scoped create carries each URL operand',
  'test/integration/surface-data-binding.test.ts',
];
const inactiveSubjectTest = [
  '--import',
  'tsx',
  '--test',
  '--test-name-pattern=inactive legal-entity refusal keeps its provider subject',
  'test/integration/surface-data-binding.test.ts',
];
const composedProviderTest = [
  '--import',
  'tsx',
  '--test',
  'test/postgres/composed-application.test.ts',
];

const mutations = [
  {
    expected: /rendered POST action must retain the selected operand/u,
    file: 'apps/web/src/component-registry.ts',
    name: 'rendered-form-action-drops-url-scope',
    original: 'surfaceHref(context.surface, undefined, false, context)',
    replacement: 'surfaceHref(context.surface)',
    test: focusedSurfaceTest,
  },
  {
    expected: /a second URL value must move the effective operand/u,
    file: 'apps/web/src/surface-runtime.ts',
    name: 'web-handoff-hardcodes-one-legal-entity',
    original:
      'return Object.freeze({ [argumentKey]: legalEntitySelection[0]! });',
    replacement:
      "return Object.freeze({ [argumentKey]: 'ac000000-0000-4000-8000-00000000000c' });",
    test: focusedSurfaceTest,
  },
  {
    expected: /200 !== 422|3 !== 2/u,
    file: 'apps/web/src/surface-runtime.ts',
    name: 'scoped-cardinality-refusal-removed',
    original: `  if (legalEntitySelection.length !== 1) {
    throw new InvalidSurfaceSubmissionError(
      'a scoped create requires exactly one legal-entity operand',
    );
  }
`,
    replacement: '',
    test: focusedSurfaceTest,
  },
  {
    expected: /200 !== 403/u,
    file: 'packages/runtime/src/semantic-operation-gateway.ts',
    name: 'registered-operation-permission-refusal-removed',
    original: `      if (operationDecision.decision === 'DENY') {
        throw new SemanticOperationPolicyDeniedError(request.operationId, view);
      }
`,
    replacement: '',
    test: focusedSurfaceTest,
  },
  {
    expected: /OPERATION_LEGAL_ENTITY_INACTIVE/u,
    file: 'apps/web/src/surface-runtime.ts',
    name: 'provider-refusal-subject-erased',
    original: `    return {
      code: 'OPERATION_LEGAL_ENTITY_INACTIVE',
      subject: error.subjectId,
    };`,
    replacement: `    return {
      code: 'OPERATION_UNAVAILABLE',
    };`,
    test: inactiveSubjectTest,
  },
  {
    expected: /Missing expected rejection/u,
    file: 'packages/runtime/src/semantic-operation-gateway.ts',
    name: 'effective-input-digest-collapsed',
    original: '        inputDigest: digestOperationInput(request.input),',
    replacement: "        inputDigest: '0'.repeat(64),",
    test: composedProviderTest,
  },
  {
    expected: /Missing expected rejection/u,
    file: 'packages/postgres-provider/src/module-runtime-interpreter.ts',
    name: 'unscoped-create-closed-key-fence-removed',
    original: `    case 'createRecordEffect':
      assertAllowedKeys(input, contract.closedArgumentKeys);
      return validateMutationInput(contract, {`,
    replacement: `    case 'createRecordEffect':
      return validateMutationInput(contract, {`,
    test: composedProviderTest,
  },
  {
    expected: /Missing expected rejection/u,
    file: 'packages/postgres-provider/src/module-runtime-interpreter.ts',
    name: 'active-legal-entity-enforcement-removed',
    original: `            await requireActiveCreateLegalEntity(
              client,
              currentStorage,
              currentEntity,
              request.definition,
              input,
            );
`,
    replacement: '',
    test: composedProviderTest,
  },
];

assertCleanTrackedTree();
const requestedNames = new Set(process.argv.slice(2));
for (const requestedName of requestedNames) {
  assert.ok(
    mutations.some((mutation) => mutation.name === requestedName),
    `unknown mutation: ${requestedName}`,
  );
}
for (const mutation of mutations.filter(
  (candidate) =>
    requestedNames.size === 0 || requestedNames.has(candidate.name),
)) {
  runMutation(mutation);
}
assertCleanTrackedTree();

function runMutation(mutation) {
  const path = resolve(repositoryRoot, mutation.file);
  const originalSource = readFileSync(path, 'utf8');
  assert.equal(
    occurrences(originalSource, mutation.original),
    1,
    `${mutation.name}: production victim must be unique`,
  );
  try {
    writeFileSync(
      path,
      originalSource.replace(mutation.original, mutation.replacement),
    );
    const result = spawnSync(process.execPath, mutation.test, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.notEqual(
      result.status,
      0,
      `${mutation.name}: mutation stayed green`,
    );
    assert.match(output, mutation.expected, `${mutation.name}: wrong red`);
    console.log(`MUTATION_RED ${mutation.name}`);
  } finally {
    writeFileSync(path, originalSource);
  }
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function assertCleanTrackedTree() {
  const result = spawnSync('git', ['diff', '--quiet'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    'mutation evidence requires a clean tracked tree',
  );
}
