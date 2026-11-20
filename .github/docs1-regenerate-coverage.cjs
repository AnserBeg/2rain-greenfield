const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  deriveLanguageCoverageLedger,
  deriveLanguageCoverageDecisionId,
  deriveDecisionSetDigest,
  deriveObligationSetDigest,
  encodeLanguageCoverageObservationSnapshot,
  observeLanguageCoverage,
} = require(resolve('test/helpers/language-conformance-ledger.ts'));
const { languageCoverageApplicationPackages } = require(resolve('test/helpers/language-coverage-packages.ts'));
const { lowerStorageTargetV1 } = require(resolve('packages/compiler/src/index.ts'));
const { normalizeApplicationPackage } = require(resolve('packages/canonical-model/src/index.ts'));
const path = 'test/fixtures/g2/language-conformance/coverage-decisions.json';
const document = JSON.parse(readFileSync(path, 'utf8'));
const ledger = deriveLanguageCoverageLedger(process.cwd());
const applicationPackages = languageCoverageApplicationPackages();
const storageTargets = applicationPackages.map((definition) => lowerStorageTargetV1(normalizeApplicationPackage(definition)));
const observed = observeLanguageCoverage(ledger, { applicationPackages, storageTargets });
const observationSnapshot = encodeLanguageCoverageObservationSnapshot(ledger, observed);
const oldSnapshot = document.observationSnapshot;
const defectIds = new Set(document.acceptedButUnhonoredObligationIds);
const known = new Set(ledger.obligations.map(({ id }) => id));
assert.ok([...defectIds].every((id) => known.has(id)));
const templateObligations = ledger.obligations.filter(({ id }) => id.includes('documentTemplate'));
assert.ok(templateObligations.length > 0);
assert.ok(templateObligations.every(({ id }) => !observed.has(id)));
assert.equal(observed.size, oldSnapshot.observedCount);
document.decisions = document.decisions.map(({ decisionId, ...body }) => {
  const obligationSetDigest = deriveDecisionSetDigest(ledger, observed, body.category);
  if (body.category !== 'unobserved') assert.equal(obligationSetDigest, body.obligationSetDigest);
  const updated = {
    ...body,
    ledgerDigest: ledger.digest,
    obligationSetDigest,
    acceptedButUnhonoredSetDigest: deriveObligationSetDigest(defectIds),
    rationale: body.category === 'unobserved'
      ? body.rationale + ' DOCS-1 adds optional v6 document-template declarations. The first-party coverage fixtures leave them absent. The PostgreSQL issuance test exercises templates in customized releases.'
      : body.rationale,
  };
  return { ...updated, decisionId: deriveLanguageCoverageDecisionId(decisionId.split('@')[0], updated) };
});
document.ledgerDigest = ledger.digest;
document.observationSnapshot = observationSnapshot;
writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
console.log('Obligations:', oldSnapshot.obligationCount, '->', observationSnapshot.obligationCount);
console.log('Observed:', oldSnapshot.observedCount, '->', observationSnapshot.observedCount);
console.log('Optional template obligations:', templateObligations.length);
console.log('Ledger:', ledger.digest);
