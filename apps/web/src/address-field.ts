import { addressEditor, selectedPlace } from './address-context.js';
import { AddressWriteSchema, addressJson } from '@north-star/canonical-model';

export function addressFromForm(
  name: string,
  submission: Readonly<Record<string, string | undefined>>,
) {
  const text = submission[name] ?? '';
  const components = Object.fromEntries(
    ['city', 'region', 'postalCode', 'country'].flatMap((key) => {
      const value = submission[name + '.' + key]?.trim();
      return value ? [[key, value]] : [];
    }),
  );
  const lines = submission[name + '.lines']
    ?.split(/\r?\n/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const latitude = submission[name + '.latitude']?.trim(),
    longitude = submission[name + '.longitude']?.trim();
  const ctx = addressEditor.getStore();
  const account = ctx?.accounts.find(
    (a) => a.installationId === submission[name + '.installation'],
  );
  const binding = ctx?.projection.bindings.find((b) =>
    name.endsWith(b.fieldId),
  );
  const place =
    account &&
    binding &&
    selectedPlace(
      submission[name + '.choice'] ?? '',
      submission[name + '.session'] ?? '',
      binding.fieldId,
      account.installationId,
    );
  return addressJson(
    AddressWriteSchema.parse({
      ...(place && { place }),
      ...(account?.enrichment && {
        locateFor: {
          installationId: account.installationId,
          companyId: account.companyId,
        },
      }),
      schemaVersion: 'northstar.address-value/v1',
      text,
      ...components,
      ...(lines?.length && { lines }),
      ...((latitude || longitude) && {
        pin: { kind: 'user', latitude, longitude },
      }),
    }),
  );
}
