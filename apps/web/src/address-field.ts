import { randomUUID } from 'node:crypto';
import { addressEditor, selectedPlace } from './address-context.js';
import {
  AddressWriteSchema,
  AddressInputSchema,
  SavedAddressSchema,
} from '@north-star/canonical-model';

const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function renderAddressField(
  name: string,
  value: unknown,
  attributes: string,
) {
  const context = addressEditor.getStore();
  const binding = context?.projection.bindings.find((b) =>
    name.endsWith(b.fieldId),
  );
  const session = randomUUID();
  const accounts = context?.accounts ?? [];
  const lookup =
    binding && accounts.length
      ? `<label>Map provider<select name="${name}.installation"><option value="">Save text only</option>${accounts.map((a) => `<option value="${a.installationId}" data-company="${a.companyId}"${accounts.length === 1 && a.enrichment ? ' selected' : ''}>${escape(a.account)} · ${a.provider === 'fake' ? 'Demo Maps' : 'Google Maps'}</option>`).join('')}</select></label><input type="hidden" name="${name}.session" value="${session}"><input type="hidden" name="${name}.choice"><span data-address-results aria-live="polite"></span>`
      : '';
  const address = SavedAddressSchema.safeParse(value);
  const draft = AddressInputSchema.safeParse(value);
  const current = address.success ? address.data : draft.data;
  const component = (
    key: string,
    label: string,
    text: string | undefined,
    max: number,
  ) =>
    '<label>' +
    label +
    '<input name="' +
    name +
    '.' +
    key +
    '" maxlength="' +
    max +
    '" value="' +
    escape(text ?? '') +
    '"></label>';
  return (
    `<span data-address-editor data-field="${escape(binding?.fieldId ?? '')}" data-query="${escape(binding?.suggestQueryId ?? '')}" data-record="${escape(context?.recordId ?? '')}">` +
    '<input type="text" autocomplete="street-address" maxlength="512" name="' +
    name +
    '"' +
    attributes +
    ' value="' +
    escape(current?.text ?? '') +
    '">' +
    lookup +
    '</span>' +
    '<details><summary>Address details and pin</summary>' +
    '<label>Street lines<textarea name="' +
    name +
    '.lines" maxlength="643">' +
    escape(current?.lines?.join('\n') ?? '') +
    '</textarea></label>' +
    component('city', 'City', current?.city, 120) +
    component('region', 'State or province', current?.region, 120) +
    component('postalCode', 'Postal code', current?.postalCode, 24) +
    component('country', 'Country code', current?.country, 2) +
    component('latitude', 'Your pin latitude', current?.pin?.latitude, 14) +
    component('longitude', 'Your pin longitude', current?.pin?.longitude, 14) +
    '</details>'
  );
}
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
  return AddressWriteSchema.parse({
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
  });
}
