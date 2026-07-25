export type ReachabilityRunner = 'node:test' | 'playwright';

export interface ReachabilityProducer {
  readonly id: string;
  readonly runner: ReachabilityRunner;
  readonly command: string;
  readonly ciJob: string;
  readonly ciInvocation: string;
  readonly evidencePath: string;
  readonly rawEvidencePath?: string;
}

export const observabilityTestFiles = [
  'test/unit/observability.test.ts',
  'test/integration/observability-ci-contract.test.ts',
  'test/postgres/observability-health.test.ts',
] as const;

export const reachabilityProducers = [
  nodeProducer('unit', 'quality', 'test:unit'),
  nodeProducer('compiler', 'quality', 'test:compiler'),
  nodeProducer('integration', 'quality', 'test:integration'),
  nodeProducer('agent', 'quality', 'test:agent'),
  nodeProducer('architecture', 'quality', 'test:architecture'),
  nodeProducer('contracts', 'quality', 'test:contracts'),
  nodeProducer('postgres', 'postgres', 'test:postgres'),
  {
    id: 'browser',
    runner: 'playwright',
    command: 'corepack pnpm test:browser',
    ciJob: 'browser',
    ciInvocation: 'corepack pnpm test:browser',
    evidencePath: 'test-results/reachability/browser.json',
    rawEvidencePath: 'test-results/reachability/browser.raw.json',
  },
  {
    id: 'observability',
    runner: 'node:test',
    command: `node --import tsx --test ${observabilityTestFiles.join(' ')}`,
    ciJob: 'observability',
    ciInvocation: 'REACHABILITY_SUITE_ID: observability',
    evidencePath: 'test-results/reachability/observability.json',
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

function nodeProducer(
  id: string,
  ciJob: string,
  script: string,
): ReachabilityProducer {
  const command = `corepack pnpm ${script}`;
  return {
    id,
    runner: 'node:test',
    command,
    ciJob,
    ciInvocation: command,
    evidencePath: `test-results/reachability/${id}.json`,
  };
}
