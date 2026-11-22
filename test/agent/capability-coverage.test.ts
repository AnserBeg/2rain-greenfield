/**
 * AI-RELY-1 slice 1, gate (c): every registered-capability operation of the
 * checked-in release is one the assistant can plan. A capability step reads
 * its child collections through `capabilityChildren`, which throws for an
 * operation it does not list (AI-REVIEW R4), so an operation the table lacks
 * would fail only when a person asks for it. This fails first, naming it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilityChildren } from '../../packages/domain/src/app/capability-children.js';
import {
  effectKind,
  localName,
  pinnedCatalog,
} from '../../packages/operations-agent/src/catalog.js';

import { compiledAppView } from './compiled-view.js';

test('(c) every capability operation of the release can be planned', () => {
  const catalog = pinnedCatalog(compiledAppView());
  const capabilities = catalog.operations.filter(
    (operation) => effectKind(operation) === 'registeredCapabilityEffect',
  );
  assert.ok(capabilities.length > 0, 'the release declares capabilities');
  const queries = new Set(catalog.queries.map((q) => localName(q.queryId)));
  const unplannable: string[] = [];
  const unreadable: string[] = [];
  for (const operation of capabilities) {
    const name = localName(operation.operationId);
    let reads;
    try {
      reads = capabilityChildren(name);
    } catch {
      unplannable.push(name);
      continue;
    }
    for (const read of reads)
      if (!queries.has(read.query)) unreadable.push(`${name} -> ${read.query}`);
  }
  assert.deepEqual(unplannable, [], 'capabilities the planner cannot plan');
  assert.deepEqual(unreadable, [], 'child reads the release does not offer');
});
