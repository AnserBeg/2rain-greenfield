import assert from 'node:assert/strict';
import test from 'node:test';

import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/index.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import type { Pool } from 'pg';

import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';
import {
  Q1_CORPUS_FIELD_IDS,
  evaluatePredicateCase,
  loadPredicateParityCorpus,
} from '../helpers/q1-predicate-corpus.js';

const perturbTotalization =
  process.env.Q1P2_PERTURB_TOTALIZATION === 'absent_not_less_decimal_zero';
const demonstrateSelfConfirmation =
  process.env.Q1P2_DEMONSTRATE_SELF_CONFIRMATION === '1';

test('committed Q1 parity cases agree through independent IR and PostgreSQL executions', async () => {
  const corpus = loadPredicateParityCorpus();
  const definition = corpusPartyDefinition(corpus.cases);
  let modelFetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelFetchCount += 1;
    throw new Error('network/model access is forbidden during corpus replay');
  };
  try {
    await withRealPartyRuntime(
      'q1-p2-predicate-parity',
      async (runtime) => {
        const party = runtime.storage.entities.find(
          (entity) => entity.entityId === PARTY_IDS.entityIds.party,
        );
        assert.ok(party);
        const decimalColumn = requiredColumn(
          party,
          Q1_CORPUS_FIELD_IDS.exactDecimal,
        );
        for (const [index, row] of corpus.rows.entries()) {
          try {
            await invokePartyOperation(
              runtime,
              runtime.views.a,
              'party_create',
              {
                recordId: row.recordId,
                values: {
                  [PARTY_IDS.fieldIds.name]: row.label,
                  [PARTY_IDS.fieldIds.number]:
                    `Q1P2-${String(index + 1).padStart(3, '0')}`,
                  ...row.values,
                },
              },
            );
          } catch (error) {
            throw new Error(`failed to create parity row ${row.label}`, {
              cause: error,
            });
          }
        }

        let irExecutionCount = 0;
        let postgresExecutionCount = 0;
        const firstPass = new Map<string, readonly string[]>();
        for (let replay = 0; replay < 2; replay += 1) {
          for (const candidate of corpus.cases) {
            const irIds = corpus.rows
              .filter((row) => {
                irExecutionCount += 1;
                return evaluatePredicateCase(candidate, row);
              })
              .map((row) => row.recordId)
              .sort();
            let postgresIds: string[];
            if (demonstrateSelfConfirmation) {
              postgresIds = [...irIds];
            } else if (
              perturbTotalization &&
              candidate.caseId === 'absent_not_less_decimal_zero'
            ) {
              postgresExecutionCount += 1;
              postgresIds = await rawNotLessThanZero(
                runtime.runtimePool,
                runtime.contexts.a,
                party,
                decimalColumn.physicalName,
                corpus.rows.map((row) => row.recordId),
              );
            } else {
              postgresExecutionCount += 1;
              const result = await invokePartyQuery(
                runtime,
                runtime.views.a,
                `party_q1p2_${candidate.caseId}`,
                { limit: 100 },
              );
              postgresIds = result.records
                .map((record) => record.recordId)
                .filter((recordId) =>
                  corpus.rows.some((row) => row.recordId === recordId),
                )
                .sort();
            }
            assert.deepEqual(
              postgresIds,
              irIds,
              `Q1-P2 parity case ${candidate.caseId} replay ${String(replay + 1)}`,
            );
            if (replay === 0) {
              firstPass.set(candidate.caseId, Object.freeze([...postgresIds]));
            } else {
              assert.deepEqual(
                postgresIds,
                firstPass.get(candidate.caseId),
                `Q1-P2 deterministic replay ${candidate.caseId}`,
              );
            }
          }
        }

        assert.equal(
          postgresExecutionCount,
          corpus.cases.length * 2,
          'every verdict must come from PostgreSQL rather than the IR oracle',
        );
        assert.equal(
          irExecutionCount,
          corpus.cases.length * corpus.rows.length * 2,
        );

        const absentId = corpus.rows[0]!.recordId;
        const totalizedIds = firstPass.get('absent_not_less_decimal_zero');
        assert.ok(totalizedIds);
        const rawIds = await rawNotLessThanZero(
          runtime.runtimePool,
          runtime.contexts.a,
          party,
          decimalColumn.physicalName,
          corpus.rows.map((row) => row.recordId),
        );
        assert.equal(rawIds.includes(absentId), false);
        assert.equal(totalizedIds.includes(absentId), true);
        assert.notDeepEqual(rawIds, totalizedIds);
        assert.equal(modelFetchCount, 0);

        console.log(
          `Q1-P2 corpus cases=${String(corpus.cases.length)} rows=${String(corpus.rows.length)} ir=${String(irExecutionCount)} postgres=${String(postgresExecutionCount)} axes=${[...new Set(corpus.cases.map((candidate) => candidate.axis))].sort().join(',')} raw_absent=${String(rawIds.includes(absentId))} total_absent=${String(totalizedIds.includes(absentId))} model_fetches=${String(modelFetchCount)}`,
        );
      },
      definition,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function corpusPartyDefinition(
  cases: ReturnType<typeof loadPredicateParityCorpus>['cases'],
): Record<string, unknown> {
  const definition = structuredClone(partyModuleDefinition()) as {
    fields: Array<Record<string, unknown>>;
    queries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const contact = definition.fields.find(
    (field) => field.fieldId === PARTY_IDS.fieldIds.contactSummary,
  );
  assert.ok(contact);
  contact.collation = 'binary';
  definition.fields.push({
    classification: 'internal',
    collation: 'unicodeCaseInsensitive',
    defaultSemantics: 'nullable',
    entity: reference(PARTY_IDS.entityIds.party),
    fieldId: Q1_CORPUS_FIELD_IDS.foldedText,
    fieldType: {
      kind: 'textFieldType',
      maximumLength: 500,
      schemaVersion: 'v2',
    },
    kind: 'fieldDefinition',
    label: 'Parity folded text',
    orderKey: 40,
    presence: 'optional',
    reportable: true,
    schemaVersion: 'v2',
    searchable: false,
  });
  definition.fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'nullable',
    entity: reference(PARTY_IDS.entityIds.party),
    fieldId: Q1_CORPUS_FIELD_IDS.exactDecimal,
    fieldType: {
      kind: 'exactDecimalFieldType',
      precision: 20,
      representation: 'canonicalString',
      scale: 6,
      schemaVersion: 'v2',
    },
    kind: 'fieldDefinition',
    label: 'Parity exact decimal',
    orderKey: 50,
    presence: 'optional',
    reportable: true,
    schemaVersion: 'v2',
    searchable: false,
  });
  const template = definition.queries.find(
    (query) => query.queryId === `${PARTY_IDS.namespace}:query.party_list`,
  );
  assert.ok(template);
  for (const candidate of cases) {
    const query = structuredClone(template);
    query.queryId = `${PARTY_IDS.namespace}:query.party_q1p2_${candidate.caseId}`;
    query.tier = 'q1';
    query.filter = candidate.predicate;
    query.selections = (query.selections as Array<Record<string, unknown>>).map(
      (selection, index) => ({
        ...selection,
        selectionId: `${PARTY_IDS.namespace}:selection.party_q1p2_${candidate.caseId}_${String(index + 1)}`,
      }),
    );
    definition.queries.push(query);
  }
  return definition;
}

async function rawNotLessThanZero(
  pool: Pool,
  context: Parameters<typeof withTrustedRequestTransaction>[1],
  entity: StorageTargetPayloadV1['entities'][number],
  decimalColumn: string,
  recordIds: readonly string[],
): Promise<string[]> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    try {
      const result = await client.query<{ record_id: string }>(
        `SELECT ${quoted(entity.recordIdentity.column)} AS record_id
           FROM north_star_module.${quoted(entity.physicalTableName)}
          WHERE ${quoted(entity.archive.archivedAtColumn)} IS NULL
            AND ${quoted(entity.recordIdentity.column)} = ANY($1::uuid[])
            AND NOT (${quoted(decimalColumn)} < 0::numeric)
          ORDER BY ${quoted(entity.recordIdentity.column)}`,
        [recordIds],
      );
      return result.rows.map((row) => row.record_id);
    } finally {
      await client.query('RESET ROLE');
    }
  });
}

function requiredColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  fieldId: string,
): StorageTargetPayloadV1['entities'][number]['columns'][number] {
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column;
}

function reference(targetId: string): Record<string, unknown> {
  return { kind: 'entityReference', schemaVersion: 'v2', targetId };
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
