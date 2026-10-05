export type ReachabilityRunner = 'node:test' | 'playwright';

export interface ReachabilityProducer {
  readonly id: string;
  readonly runner: ReachabilityRunner;
  readonly command: string;
  readonly argv: readonly string[];
  readonly ciJob: string;
  readonly ciInvocation: string;
  readonly evidencePath: string;
  readonly rawEvidencePath?: string;
  readonly invocationEvidencePath?: string;
  readonly implementation:
    | {
        readonly kind: 'script';
        readonly manifestPath: 'package.json' | 'apps/web/package.json';
        readonly script: string;
      }
    | { readonly kind: 'helper'; readonly sourcePath: string };
}

export const observabilityTestFiles = [
  'test/unit/observability.test.ts',
  'test/integration/observability-ci-contract.test.ts',
  'test/postgres/observability-health.test.ts',
] as const;

export const reachabilityProducers = [
  nodeProducer('unit', 'quality', 'test:unit', [
    'test/unit/canonical-model/diagnostic-ordering.test.ts',
    'test/unit/canonical-model/disclosure-tier.test.ts',
    'test/unit/canonical-model/field-numbering.test.ts',
    'test/unit/canonical-model/negative-contracts.test.ts',
    'test/unit/canonical-model/normalization.test.ts',
    'test/unit/canonical-model/predicate-admission.test.ts',
    'test/unit/canonical-model/surface-composition.test.ts',
    'test/unit/canonical-model/surface-list.test.ts',
    'test/unit/catalog-definition.test.ts',
    'test/unit/commercial-amounts.test.ts',
    'test/unit/dev-environment.test.ts',
    'test/unit/inventory-definition.test.ts',
    'test/unit/language-conformance-ledger.test.ts',
    'test/unit/location-definition.test.ts',
    'test/unit/module-provider-error-mappings.test.ts',
    'test/unit/observability.test.ts',
    'test/unit/party-definition.test.ts',
    'test/unit/purchasing-definition.test.ts',
    'test/unit/sales-definition.test.ts',
    'test/unit/web-surface-hex-literal-ratchet.test.ts',
    'test/unit/workspace-contract.test.ts',
  ]),
  nodeProducer('compiler', 'quality', 'test:compiler', [
    'test/compiler/adopted-language-shape.test.ts',
    'test/compiler/compiler-semantic-profile.test.ts',
    'test/compiler/determinism.test.ts',
    'test/compiler/disclosure-tier-projection.test.ts',
    'test/compiler/field-kind-projection.test.ts',
    'test/compiler/freeze-b.test.ts',
    'test/compiler/g2-module-conformance.test.ts',
    'test/compiler/g2-module-storage.test.ts',
    'test/compiler/golden-vectors.test.ts',
    'test/compiler/legal-entity-query-scope.test.ts',
    'test/compiler/predicate-lowering.test.ts',
    'test/compiler/publish-path-breadth-envelope.test.ts',
    'test/compiler/relation-target-projection.test.ts',
  ]),
  nodeProducer('performance', 'performance', 'test:performance', [
    'test/compiler/performance-budget.test.ts',
  ]),
  nodeProducer('integration', 'quality', 'test:integration', [
    'test/integration/**/*.test.ts',
  ]),
  nodeProducer('agent', 'quality', 'test:agent', [
    'test/agent/catalog-discovery.test.ts',
    'test/agent/location-discovery.test.ts',
    'test/agent/party-discovery.test.ts',
  ]),
  nodeProducer('architecture', 'quality', 'test:architecture', [
    'test/architecture/**/*.test.ts',
  ]),
  nodeProducer(
    'contracts',
    'quality',
    'test:contracts',
    ['test/surface-runtime-contract.test.ts'],
    'apps/web/package.json',
  ),
  // The composed application's replay of every release runs in its own job,
  // and so do the commercial document workflows, each under the same bound,
  // so no job nears it.
  nodeProducer('postgres', 'postgres', 'test:postgres', [
    'test/postgres/**/!(composed-application|commercial-totals|expected-receipts|fulfillment|order-lists|order-lists-supply|order-pages|packing-retrieval|payables|purchase-order-ending|receivables|receiving-authorization).test.ts',
  ]),
  nodeProducer(
    'postgres-composed',
    'postgres-composed',
    'test:postgres:composed',
    ['test/postgres/composed-application.test.ts'],
  ),
  nodeProducer(
    'postgres-commercial',
    'postgres-commercial',
    'test:postgres:commercial',
    [
      'test/postgres/commercial-totals.test.ts',
      'test/postgres/expected-receipts.test.ts',
      'test/postgres/fulfillment.test.ts',
      'test/postgres/order-lists-supply.test.ts',
      'test/postgres/order-lists.test.ts',
      'test/postgres/order-pages.test.ts',
      'test/postgres/packing-retrieval.test.ts',
      'test/postgres/payables.test.ts',
      'test/postgres/purchase-order-ending.test.ts',
      'test/postgres/receivables.test.ts',
      'test/postgres/receiving-authorization.test.ts',
    ],
  ),
  // The browser suite runs as three jobs under the same bound, split by file
  // name (apps/web/playwright.shared.ts): the Sales and platform specs, the
  // operations specs, and the composed application's journeys.
  playwrightProducer(
    'browser',
    'test:browser',
    'apps/web/playwright.config.ts',
  ),
  playwrightProducer(
    'browser-operations',
    'test:browser:operations',
    'apps/web/playwright.operations.config.ts',
  ),
  playwrightProducer(
    'browser-composed',
    'test:browser:composed',
    'apps/web/playwright.composed.config.ts',
  ),
  {
    id: 'observability',
    runner: 'node:test',
    command: 'node --import tsx test/helpers/run-observability-producer.ts',
    argv: observabilityTestFiles,
    ciJob: 'observability',
    ciInvocation:
      'node --import tsx test/helpers/run-observability-producer.ts',
    evidencePath: 'test-results/reachability/observability.json',
    implementation: {
      kind: 'helper',
      sourcePath: 'test/helpers/run-observability-producer.ts',
    },
  },
] as const satisfies readonly ReachabilityProducer[];

export type ReachabilityProducerId =
  (typeof reachabilityProducers)[number]['id'];

export function getReachabilityProducer(id: string): ReachabilityProducer {
  const producer = reachabilityProducers.find(
    (candidate) => candidate.id === id,
  );
  if (!producer) throw new Error(`Unknown reachability producer: ${id}`);
  return producer;
}

export interface PlaywrightReachabilityProducer extends ReachabilityProducer {
  readonly runner: 'playwright';
  readonly rawEvidencePath: string;
  readonly invocationEvidencePath: string;
}

/**
 * The Playwright producer a config's reporter or its normalization works for.
 * Each config names its own, so two browser jobs never read or write each
 * other's evidence; anything that is not a declared Playwright producer is
 * refused rather than defaulted.
 */
export function getPlaywrightReachabilityProducer(
  id: unknown,
): PlaywrightReachabilityProducer {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('A Playwright reachability producer id is required');
  }
  const producer = getReachabilityProducer(id);
  const { rawEvidencePath, invocationEvidencePath } = producer;
  if (
    producer.runner !== 'playwright' ||
    rawEvidencePath === undefined ||
    invocationEvidencePath === undefined
  ) {
    throw new Error(`Not a Playwright reachability producer: ${id}`);
  }
  return {
    ...producer,
    runner: 'playwright',
    rawEvidencePath,
    invocationEvidencePath,
  };
}

function nodeProducer(
  id: string,
  ciJob: string,
  script: string,
  argv: readonly string[],
  manifestPath: 'package.json' | 'apps/web/package.json' = 'package.json',
): ReachabilityProducer {
  const command = `corepack pnpm ${script}`;
  return {
    id,
    runner: 'node:test',
    command,
    argv,
    ciJob,
    ciInvocation: command,
    evidencePath: `test-results/reachability/${id}.json`,
    implementation: { kind: 'script', manifestPath, script },
  };
}

function playwrightProducer(
  id: string,
  script: string,
  config: string,
): ReachabilityProducer {
  const command = `corepack pnpm ${script}`;
  return {
    id,
    runner: 'playwright',
    command,
    argv: ['test', '--config', config],
    ciJob: id,
    ciInvocation: command,
    evidencePath: `test-results/reachability/${id}.json`,
    rawEvidencePath: `test-results/reachability/${id}.raw.json`,
    invocationEvidencePath: `test-results/reachability/${id}.argv.json`,
    implementation: { kind: 'script', manifestPath: 'package.json', script },
  };
}
