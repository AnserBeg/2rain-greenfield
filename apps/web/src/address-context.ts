import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  AddressProjectionSchema,
  type AddressProjection,
} from '@north-star/canonical-model';
import type {
  AddressGateway,
  AddressInstallation,
} from '../../../packages/runtime/src/address-gateway.js';
import type { RequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';

type Editing = {
  view: RequestRuntimeView;
  recordId: string;
  projection: AddressProjection;
  accounts: readonly AddressInstallation[];
};
export const addressEditor = new AsyncLocalStorage<Editing>();
export async function withAddressEditor<T>(
  view: RequestRuntimeView,
  url: string,
  gateway: AddressGateway | undefined,
  work: () => Promise<T>,
) {
  if (!view.projections.connector || !gateway || addressEditor.getStore())
    return work();
  const projection = AddressProjectionSchema.parse(
    view.projections.connector.payload,
  );
  const accounts = await gateway.installations(view).catch(() => []);
  const recordId =
    new URL(url, 'http://loopback.invalid').searchParams.get('record') ?? '';
  return addressEditor.run({ view, accounts, recordId, projection }, work);
}

// Only handles cross the editing form. Predictions expire in memory and never
// enter the release, operation receipt, logs or business record.
type Choice = {
  expires: number;
  scope: string;
  session: string;
  place: { namespace: 'demo.places' | 'google.places'; id: string };
};
const choices = new Map<string, Choice>();
function scope(
  view: RequestRuntimeView,
  recordId: string,
  fieldId: string,
  company: string,
) {
  return JSON.stringify([
    view.principalId,
    view.tenantId,
    view.environmentId,
    view.release.releaseId,
    recordId,
    fieldId,
    company,
  ]);
}
export function offerPlaces(
  view: RequestRuntimeView,
  recordId: string,
  fieldId: string,
  account: AddressInstallation,
  session: string,
  rows: readonly { label: string; placeId: string }[],
  attribution: string,
) {
  const now = performance.now();
  const scopeKey = scope(view, recordId, fieldId, account.installationId);
  for (const [handle, entry] of choices)
    if (
      entry.expires <= now ||
      (entry.scope === scopeKey && entry.session === session)
    )
      choices.delete(handle);
  return rows.map((r) => {
    while (choices.size >= 1024) choices.delete(choices.keys().next().value!);
    const handle = randomUUID();
    choices.set(handle, {
      expires: now + 180000,
      scope: scopeKey,
      session,
      place: {
        namespace:
          attribution === 'Google Maps' ? 'google.places' : 'demo.places',
        id: r.placeId,
      },
    });
    return { label: r.label, handle };
  });
}
export function selectedPlace(
  key: string,
  session: string,
  fieldId: string,
  installationId: string,
) {
  const ctx = addressEditor.getStore(),
    entry = choices.get(key);
  if (
    !ctx ||
    !entry ||
    entry.expires <= performance.now() ||
    entry.session !== session ||
    entry.scope !== scope(ctx.view, ctx.recordId, fieldId, installationId)
  )
    return undefined;
  return entry.place;
}
