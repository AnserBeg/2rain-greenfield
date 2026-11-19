/** On-demand map-size measurement over a compiled, synthetic tenant release. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  compileInSandbox,
  parseCustomizationPatch,
  serializeRelease,
} from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import {
  businessMapStructure,
  businessMapSummary,
  renderBusinessMap,
} from '../../packages/operations-agent/src/business-map.js';
import { compiledProjectionView } from './compiled-view.js';

async function measure() {
  const path = resolve('apps/web/release/app.authored.json');
  const base = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  const tip = parseCompiledApplication(
    JSON.parse(
      readFileSync('apps/web/release/app.compiled.json', 'utf8'),
    ) as unknown,
  ).application;
  const patches = Array.from({ length: 50 }, (_, i) => ({
    kind: 'addRecordType',
    label: `Map sample ${i + 1}`,
    fields: [
      { label: 'Name', type: 'text' },
      { label: 'Capacity', type: 'number' },
      { label: 'In use', type: 'yesNo' },
    ],
  }));
  const chain = [0, 13, 26, 39].map((start) => {
    const result = parseCustomizationPatch({
      kind: 'changeSet',
      patches: patches.slice(start, start + 13),
    });
    assert.equal(result.status, 'parsed');
    return result.patch;
  });
  const release = await compileInSandbox({
    acknowledgement: readUnboundPermissionAcknowledgementFor(
      path,
      'northstar.app:package.application',
    ),
    base,
    chain,
    tip: serializeRelease(tip),
  });
  assert.equal(
    release.status,
    'compiled',
    JSON.stringify(release.status === 'compiled' ? null : release),
  );
  const view = compiledProjectionView(
    release.steps.at(-1)!.release as unknown as Parameters<
      typeof compiledProjectionView
    >[0],
  );
  const begin = performance.now();
  const map = businessMapStructure(view);
  const coldMs = performance.now() - begin;
  assert.equal(
    map.entities.filter((entity) =>
      entity.entityId.includes('.custom_map_sample_'),
    ).length,
    50,
  );
  const usable = {
    operations: new Set(
      map.entities.flatMap((e) => e.operations.map((o) => o.operationId)),
    ),
    queries: new Set(
      map.entities.flatMap((e) => e.queries.map((q) => q.queryId)),
    ),
  };
  const previous = renderBusinessMap(map, usable);
  const summary = businessMapSummary(map, usable);
  const sample = map.entities.find((e) =>
    e.entityId.endsWith('.custom_map_sample_50'),
  )!;
  const detail = renderBusinessMap({ ...map, entities: [sample] }, usable);
  assert.match(detail, /capacity/u);
  assert.ok(summary.length < previous.length);
  process.stdout.write(
    JSON.stringify({
      root: map.releaseRoot,
      customTypes: 50,
      coldMs,
      previousChars: previous.length,
      summaryChars: summary.length,
      detailChars: detail.length,
    }) + '\n',
  );
}

void measure();
