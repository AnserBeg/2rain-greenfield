import type { VersionedNormalizedApplicationPackage } from '@north-star/canonical-model';
import {
  BILLING_QUOTE_CAPABILITY,
  BILLING_TERMS_CAPABILITY,
} from '../../canonical-model/src/billing.js';

// Quote declarations can be compiled before sources attach. A live binding
// must resolve every dependency to a scoped, permissioned release member.
export function billingBindingProblem(
  def: VersionedNormalizedApplicationPackage,
) {
  if (def.languageVersion !== 'v6') return;
  const plans = def.billingPlans ?? [];
  const owners = new Set<string>(),
    publishers = new Set<string>();
  for (const p of plans) {
    const b = p.bindings;
    if (!b) continue;
    const outer = def.queries.find((q) => q.queryId === b.quoteQueryId);
    const source = def.queries.find((q) => q.queryId === b.evidenceQueryId);
    const terms = def.queries.find((q) => q.queryId === b.termsQueryId);
    const writes = [
      b.publishOperationId,
      b.overrideOperationId,
      b.assignmentOperationId,
    ];
    const model = outer && 'readModel' in outer ? outer.readModel : null;
    const entityFor = (queryId: string, fieldId: string) => {
      const q = def.queries.find((q) => q.queryId === queryId);
      const field = def.fields.find((f) => f.fieldId === fieldId);
      return (
        !!q &&
        q.queryType === 'get' &&
        q.legalEntityScope?.cardinality === 'exactlyOne' &&
        !q.readModel &&
        q.lifecycle === 'active' &&
        field?.entity.targetId === q.sourceEntity.targetId &&
        q.selections.some((s) => s.field.targetId === fieldId)
      );
    };
    if (
      owners.has(b.quoteQueryId) ||
      publishers.has(b.publishOperationId) ||
      outer?.queryType !== 'get' ||
      outer.lifecycle !== 'active' ||
      outer.legalEntityScope?.cardinality !== 'exactlyOne' ||
      outer.permission.targetId !==
        def.package.namespace + ':permission.billing_quote' ||
      model?.capability.targetId !== BILLING_QUOTE_CAPABILITY ||
      model.queries.evidence?.targetId !== b.evidenceQueryId ||
      !model.resultFields.explanation ||
      Object.keys(model.queries).length !== 1 ||
      Object.keys(model.resultFields).length !== 1 ||
      outer.sourceEntity.targetId !== source?.sourceEntity.targetId ||
      !entityFor(b.evidenceQueryId, b.evidenceFieldId) ||
      !entityFor(b.termsQueryId, b.termsFieldId) ||
      new Set(writes).size !== 3 ||
      writes.some((id) => {
        const op = def.operations.find((o) => o.operationId === id);
        return (
          publishers.has(id) ||
          op?.effect.kind !== 'registeredCapabilityEffect' ||
          op.effect.capability.targetId !== BILLING_TERMS_CAPABILITY ||
          op.lifecycle !== 'active' ||
          op.permission.targetId !==
            def.package.namespace + ':permission.billing_publish_terms' ||
          op.readBack.targetId !== terms?.queryId
        );
      })
    )
      return 'Billing requires distinct registered operations and exact scoped source, terms and explanation queries under the Billing grants.';
    owners.add(b.quoteQueryId);
    writes.forEach((id) => publishers.add(id));
  }
  for (const q of def.queries)
    if (
      'readModel' in q &&
      q.readModel?.capability.targetId === BILLING_QUOTE_CAPABILITY &&
      !owners.has(q.queryId)
    )
      return 'Unbound billing quote query';
  for (const op of def.operations)
    if (
      op.effect.kind === 'registeredCapabilityEffect' &&
      op.effect.capability.targetId === BILLING_TERMS_CAPABILITY &&
      !publishers.has(op.operationId)
    )
      return 'Unbound billing terms operation';
}
