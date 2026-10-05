import { readFileSync, writeFileSync } from 'node:fs';
import { format } from 'prettier';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';
import {
  deriveLanguageCoverageLedger,
  observeLanguageCoverage,
  encodeLanguageCoverageObservationSnapshot,
  deriveDecisionSetDigest,
  deriveLanguageCoverageDecisionId,
  type LanguageCoverageDecision,
} from './language-conformance-ledger.js';

// Re-derive identity-bound declaration inventory; never invent execution receipts.
async function main() {
  const path = 'test/fixtures/g2/language-conformance/coverage-decisions.json';
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    ledgerDigest: string;
    observationSnapshot: unknown;
    decisions: LanguageCoverageDecision[];
  };
  const note =
    'DROP-SHIP re-derives optional additional List progress and scalar capability Task bindings; this is declaration inventory, not per-obligation execution evidence. Existing unhonored join eligibility is unchanged.';
  const ledger = deriveLanguageCoverageLedger();
  const applicationPackages = [
    composedApplicationDefinition(),
    platformModuleDefinition(),
  ];
  const storageTargets = applicationPackages.map((definition) =>
    lowerStorageTargetV1(
      normalizeApplicationPackage(definition) as Parameters<
        typeof lowerStorageTargetV1
      >[0],
    ),
  );
  const observed = observeLanguageCoverage(ledger, {
    applicationPackages,
    storageTargets,
  });
  document.ledgerDigest = ledger.digest;
  document.observationSnapshot = encodeLanguageCoverageObservationSnapshot(
    ledger,
    observed,
  );
  document.decisions = document.decisions.map((decision) => {
    const { decisionId, ...body } = decision;
    const updated = {
      ...body,
      ledgerDigest: ledger.digest,
      obligationSetDigest: deriveDecisionSetDigest(
        ledger,
        observed,
        body.category,
      ),
      rationale: body.rationale.includes(note)
        ? body.rationale
        : `${body.rationale} ${note}`,
    };
    return {
      ...updated,
      decisionId: deriveLanguageCoverageDecisionId(
        decisionId.slice(0, decisionId.lastIndexOf('@')),
        updated,
      ),
    };
  });
  writeFileSync(
    path,
    await format(JSON.stringify(document), { parser: 'json' }),
  );
  console.log(
    JSON.stringify({
      ledger: ledger.digest,
      obligations: ledger.obligations.length,
      observed: observed.size,
    }),
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
