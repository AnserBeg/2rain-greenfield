import type { ImmutableJsonValue } from './request-runtime-view.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ADR-0087 ruling (2026-11-21): a company-sourced dateTime field on a shared
 * record type resolves through the writer's authorized working company. The
 * company named in the entry is authorized by this operation's own policy,
 * exactly as a create's company is; an owned record ignores it and uses its
 * stored company. Returns the authorized company, or undefined.
 */
export async function authorizedDateTimeWorkingCompany(
  operationPayload: unknown,
  definition: { readonly effect: unknown; readonly inputContract?: unknown },
  input: ImmutableJsonValue,
  authorize: (input: ImmutableJsonValue) => Promise<unknown>,
): Promise<string | undefined> {
  const effect = definition.effect as {
    kind?: string;
    entity?: { targetId?: string };
  };
  const contract = definition.inputContract as
    { systemInput?: unknown } | undefined;
  if (
    (effect.kind !== 'createRecordEffect' &&
      effect.kind !== 'updateRecordEffect') ||
    contract?.systemInput ||
    !isRecord(input)
  )
    return undefined;
  const bindings = isRecord(operationPayload)
    ? operationPayload.dateTimeBindings
    : undefined;
  const companyFields = new Set(
    (Array.isArray(bindings) ? bindings : []).flatMap((binding) =>
      isRecord(binding) &&
      binding.entityId === effect.entity?.targetId &&
      isRecord(binding.zoneSource) &&
      binding.zoneSource.kind === 'companyBusinessCalendar' &&
      typeof binding.fieldId === 'string'
        ? [binding.fieldId]
        : [],
    ),
  );
  if (companyFields.size === 0) return undefined;
  const values = isRecord(input.values)
    ? input.values
    : isRecord(input.patch)
      ? input.patch
      : {};
  const named = new Set(
    [...companyFields].flatMap((fieldId) => {
      const value = values[fieldId];
      return isRecord(value) && typeof value.companyId === 'string'
        ? [value.companyId]
        : [];
    }),
  );
  if (named.size !== 1) return undefined;
  const [company] = [...named];
  await authorize(Object.freeze({ legalEntityId: company! }));
  return company;
}
