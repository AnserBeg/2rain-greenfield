import type { VersionedNormalizedApplicationPackage } from '@north-star/canonical-model';
import {
  BOOKING_USAGE_BINDING,
  BOOKING_USAGE_CAPABILITY,
} from '../../canonical-model/src/booking.js';
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
    const selectedField = (q: typeof source, fieldId: string) =>
      q?.queryType === 'get' &&
      q.legalEntityScope?.cardinality === 'exactlyOne' &&
      !q.readModel &&
      q.lifecycle === 'active' &&
      q.selections.some((s) => s.field.targetId === fieldId)
        ? def.fields.find(
            (f) =>
              f.fieldId === fieldId &&
              f.entity.targetId === q.sourceEntity.targetId,
          )
        : undefined;
    const arrears = b.arrearsSource;
    if (arrears?.kind === 'periodMeter') {
      const boundFields = [
        arrears.openingReadingFieldId,
        arrears.closingReadingFieldId,
        arrears.openingInstantFieldId,
        arrears.closingInstantFieldId,
      ];
      if (
        new Set(boundFields).size !== 4 ||
        ![arrears.openingReadingFieldId, arrears.closingReadingFieldId].every(
          (id) => {
            const type = selectedField(source, id)?.fieldType;
            return (
              type?.kind === 'quantityFieldType' &&
              type.baseUnit.targetId === arrears.unit &&
              type.scale <= 9 &&
              type.precision - type.scale <= 18
            );
          },
        ) ||
        ![arrears.openingInstantFieldId, arrears.closingInstantFieldId].every(
          (id) =>
            selectedField(source, id)?.fieldType.kind === 'dateTimeFieldType',
        ) ||
        !p.components.some((c) => c.kind === 'meter') ||
        p.components.some(
          (c) =>
            c.kind === 'time' ||
            (c.kind === 'meter' &&
              (c.allowanceBasis.kind !== 'perCycle' ||
                c.streamId !== arrears.streamId ||
                c.unit !== arrears.unit)),
        )
      )
        return 'BILLING_METER_SOURCE_REQUIRED';
    }
    if (arrears?.kind === 'bookingActuals') {
      const usage = def.queries.find((q) => q.queryId === arrears.queryId);
      const declaredSlot = def.operations.some(
        (op) =>
          op.lifecycle === 'active' &&
          'booking' in op &&
          op.booking &&
          op.booking.slotId === arrears.slotId &&
          op.booking.ownerEntity === source?.sourceEntity.targetId &&
          op.booking.fulfilmentMode === 'tracked' &&
          op.booking.unit === p.serviceUnit &&
          op.booking.scale <= 9,
      );
      if (
        !declaredSlot ||
        model?.queries.usage?.targetId !== arrears.queryId ||
        usage?.queryType !== 'get' ||
        usage.legalEntityScope?.cardinality !== 'exactlyOne' ||
        usage.readModel?.capability.targetId !== BOOKING_USAGE_CAPABILITY ||
        usage.readModel.binding !== BOOKING_USAGE_BINDING ||
        usage.readModel.queries.owner?.targetId !== source?.queryId ||
        usage.sourceEntity.targetId !== source?.sourceEntity.targetId
      )
        return 'BILLING_BOOKING_SOURCE_REQUIRED';
    }
    const interval = b.agreedInterval;
    const sourcePrefix = source?.sourceEntity.targetId.replace(
      ':entity.',
      ':field.',
    );
    if (
      b.evidenceFieldId ||
      !interval ||
      interval.customerFieldId !== sourcePrefix + '_customer_party_id' ||
      interval.currencyFieldId !== sourcePrefix + '_currency' ||
      selectedField(source, interval.customerFieldId)?.fieldType.kind !==
        'textFieldType' ||
      selectedField(source, interval.currencyFieldId)?.fieldType.kind !==
        'textFieldType' ||
      outer?.queryType !== 'get' ||
      !outer.selections.some(
        (s) => s.field.targetId === interval.customerFieldId,
      ) ||
      !outer.selections.some(
        (s) => s.field.targetId === interval.currencyFieldId,
      ) ||
      interval.startFieldId === interval.endFieldId ||
      selectedField(source, interval.startFieldId)?.fieldType.kind !==
        'dateTimeFieldType' ||
      selectedField(source, interval.endFieldId)?.fieldType.kind !==
        'dateTimeFieldType' ||
      (arrears?.kind !== 'periodMeter' &&
        p.components.some((c) => c.kind === 'meter'))
    )
      return 'BILLING_SOURCE_FIELDS_REQUIRED';
    if (
      owners.has(b.quoteQueryId) ||
      publishers.has(b.publishOperationId) ||
      outer.lifecycle !== 'active' ||
      outer.legalEntityScope?.cardinality !== 'exactlyOne' ||
      outer.permission.targetId !==
        def.package.namespace + ':permission.billing_quote' ||
      model?.capability.targetId !== BILLING_QUOTE_CAPABILITY ||
      model.queries.evidence?.targetId !== b.evidenceQueryId ||
      !model.resultFields.explanation ||
      Object.keys(model.queries).length !==
        (arrears?.kind === 'bookingActuals' ? 2 : 1) ||
      Object.keys(model.resultFields).length !== 1 ||
      outer.sourceEntity.targetId !== source?.sourceEntity.targetId ||
      selectedField(terms, b.termsFieldId)?.fieldType.kind !==
        'textFieldType' ||
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
