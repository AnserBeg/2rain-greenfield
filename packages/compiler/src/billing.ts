import type { VersionedNormalizedApplicationPackage } from '@north-star/canonical-model';
import {
  BILLING_QUOTE_CAPABILITY,
  BILLING_TERMS_CAPABILITY,
  billingEvidenceQuery,
} from '../../canonical-model/src/billing.js';
import { serviceUseProvider } from '../../canonical-model/src/service-evidence.js';

// Quote declarations can be compiled before sources attach. A live binding
// must resolve every dependency to a scoped, permissioned release member.
export function billingBindingProblem(
  def: VersionedNormalizedApplicationPackage,
) {
  if (def.languageVersion !== 'v6') return;
  const plans = def.billingPlans ?? [];
  const owners = new Set<string>(),
    publishers = new Set<string>();
  // Every bound plan's quote query and terms writes sit inside the Billing
  // grants: several plans may share one grant pair, as the old names forced.
  const boundQuotes = new Set<string>(),
    boundWrites = new Set<string>();
  for (const { bindings } of plans)
    if (bindings) {
      boundQuotes.add(bindings.quoteQueryId);
      boundWrites
        .add(bindings.publishOperationId)
        .add(bindings.overrideOperationId)
        .add(bindings.assignmentOperationId);
    }
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
    // Permissions are bound by their declared role, never by name: the quote
    // reads the billed record type under its own read grant (not the source
    // query's), and the three terms writes share one write grant on the terms
    // record type that is not a read.
    const declared = (permissionId: string) =>
      def.permissions.find(
        (a) => a.permissionId === permissionId && a.lifecycle === 'active',
      );
    // Each grant is dedicated, as the old names forced: no active query but a
    // bound quote reads under the quote grant, and no operation but a bound
    // plan's terms writes holds the terms grant.
    const quotePermission = (permissionId: string) =>
      declared(permissionId)?.action === 'read' &&
      declared(permissionId)?.resource.targetId ===
        source?.sourceEntity.targetId &&
      permissionId !== source?.permission.targetId &&
      !def.queries.some(
        (q) =>
          !boundQuotes.has(q.queryId) &&
          q.lifecycle === 'active' &&
          q.permission.targetId === permissionId,
      );
    const termsPermissionId = def.operations.find(
      (o) => o.operationId === b.publishOperationId,
    )?.permission.targetId;
    const termsPermission = (permissionId: string) =>
      permissionId === termsPermissionId &&
      ['create', 'update', 'transition'].includes(
        declared(permissionId)?.action ?? 'read',
      ) &&
      declared(permissionId)?.resource.targetId ===
        terms?.sourceEntity.targetId &&
      !def.operations.some(
        (o) =>
          !boundWrites.has(o.operationId) &&
          o.lifecycle === 'active' &&
          o.permission.targetId === permissionId,
      );
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
      // A meter rates readings: it has no commercial quantity to multiply by.
      if (p.components.some((c) => c.kind === 'fixed' && c.perQuantity))
        return 'BILLING_METER_SOURCE_REQUIRED';
    }
    const evidence = billingEvidenceQuery(arrears);
    if (evidence) {
      // Any read model that implements the declared service-use protocol can
      // supply actual use. The protocol's provider checks its own subject.
      const usage = def.queries.find((q) => q.queryId === evidence.queryId);
      const model = usage && 'readModel' in usage ? usage.readModel : null;
      const provider = serviceUseProvider(model?.binding);
      if (
        !usage ||
        !model ||
        !provider ||
        usage.queryType !== 'get' ||
        usage.legalEntityScope?.cardinality !== 'exactlyOne' ||
        model.queries.owner?.targetId !== source?.queryId ||
        usage.sourceEntity.targetId !== source?.sourceEntity.targetId ||
        provider.subjectProblem(def, usage, evidence.subjectId, p.serviceUnit)
      )
        return 'BILLING_EVIDENCE_SOURCE_REQUIRED';
    }
    const interval = b.agreedInterval;
    // B7: a record quantity is read only where the agreed band is billed. An
    // evidence source rates its legs' quantity and a meter its readings, so a
    // record quantity bound beside either would be declared and never read.
    if (
      interval?.quantityFieldId !== undefined &&
      arrears !== undefined &&
      arrears.kind !== 'agreedInterval'
    )
      return 'BILLING_SOURCE_FIELDS_REQUIRED';
    // The plan declares which source field holds each commercial role. The
    // role is checked by the field's declaration, never by its name: both are
    // required stored text on the billed entity, and a currency holds exactly
    // one ISO 4217 code. An optional free-text field such as notes cannot bind.
    const roleField = (fieldId: string) => {
      const field = selectedField(source, fieldId);
      return field?.fieldType.kind === 'textFieldType' &&
        field.presence === 'required'
        ? field.fieldType
        : undefined;
    };
    // B7: a bound record quantity is a required exact number on the billed
    // record, in the service unit when it carries one.
    const quantityProblem = (fieldId: string | undefined) => {
      if (fieldId === undefined) return false;
      const field = selectedField(source, fieldId);
      const type = field?.fieldType;
      return (
        field?.presence !== 'required' ||
        !(
          type?.kind === 'integerFieldType' ||
          ((type?.kind === 'exactDecimalFieldType' ||
            (type?.kind === 'quantityFieldType' &&
              type.baseUnit.targetId === p.serviceUnit)) &&
            type.scale <= 9 &&
            type.precision - type.scale <= 18)
        )
      );
    };
    if (
      b.evidenceFieldId ||
      !interval ||
      quantityProblem(interval.quantityFieldId) ||
      interval.customerFieldId === interval.currencyFieldId ||
      !roleField(interval.customerFieldId) ||
      roleField(interval.currencyFieldId)?.maximumLength !== 3 ||
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
      !quotePermission(outer.permission.targetId) ||
      model?.capability.targetId !== BILLING_QUOTE_CAPABILITY ||
      model.queries.evidence?.targetId !== b.evidenceQueryId ||
      !model.resultFields.explanation ||
      Object.keys(model.queries).length !== 1 ||
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
          !termsPermission(op.permission.targetId) ||
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
