console.error('Loading coverage helpers');
const fs=require('node:fs'), root=process.cwd(), path=root+'/test/fixtures/g2/language-conformance/coverage-decisions.json';
const {deriveLanguageCoverageLedger,observeLanguageCoverage,encodeLanguageCoverageObservationSnapshot,deriveDecisionSetDigest,deriveLanguageCoverageDecisionId}=require(root+'/test/helpers/language-conformance-ledger.ts');
const {languageCoverageApplicationPackages}=require(root+'/test/helpers/language-coverage-packages.ts');
const {normalizeApplicationPackage}=require(root+'/packages/canonical-model/src/index.ts');
const {lowerStorageTargetV1}=require(root+'/packages/compiler/src/index.ts');
console.error('Deriving authored obligations');
const ledger=deriveLanguageCoverageLedger(root);
console.error('Loading fixture packages');
const applicationPackages=languageCoverageApplicationPackages();
console.error('Observing coverage fixtures');
const observed=observeLanguageCoverage(ledger,{applicationPackages,storageTargets:applicationPackages.map(p=>lowerStorageTargetV1(normalizeApplicationPackage(p)))});
const doc=JSON.parse(fs.readFileSync(path));
doc.ledgerDigest=ledger.digest;
doc.observationSnapshot=encodeLanguageCoverageObservationSnapshot(ledger,observed);
for(const d of doc.decisions){const name=d.decisionId.split('@')[0];delete d.decisionId;d.ledgerDigest=ledger.digest;if(!d.rationale.includes('WORKFLOW-1 derives the optional'))d.rationale+=' WORKFLOW-1 derives the optional v6 receipt workflow declarations and observes a declaring fixture. Compiler and release verifier controls cover SDK, trigger and byte identity, with execution exercised by the browser journey.';d.obligationSetDigest=deriveDecisionSetDigest(ledger,observed,d.category);d.decisionId=deriveLanguageCoverageDecisionId(name,d);}
console.error('Writing re-derived decisions');
fs.writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
