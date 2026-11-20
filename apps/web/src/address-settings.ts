import type { RequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';
import type { AddressGateway } from '../../../packages/runtime/src/address-gateway.js';
import type { SemanticQueryGateway } from '../../../packages/runtime/src/semantic-query-gateway.js';
import { workspaceList } from './workspace-entry.js';

const escape = (v: string) =>
  v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export async function addressSettings(
  view: RequestRuntimeView,
  addresses: AddressGateway,
  queries: SemanticQueryGateway,
  form?: Readonly<Record<string, string>>,
) {
  const catalog = view.projections.query.payload as unknown as {
    queries: {
      queryId: string;
      sourceEntityId: string;
      tier: string;
      queryType: string;
    }[];
  };
  const list = catalog.queries.find(
    (q) =>
      q.queryType === 'list' &&
      q.tier === 'q0' &&
      q.queryId.endsWith(':query.legal_entity_list'),
  );
  if (!list) throw Error('Company list unavailable.');
  const companies = (
    await workspaceList(view, queries, list.queryId, null)
  ).filter(
    (r) =>
      !r.archived &&
      !Object.entries(r.values).some(
        ([k, v]) =>
          k.endsWith('legal_entity_status') &&
          typeof v === 'string' &&
          !v.endsWith('_active'),
      ),
  );
  if (form) {
    if (!companies.some((c) => c.recordId === form.companyId))
      throw Error('Choose an available company.');
    await addresses.configure(view, form.companyId!, {
      account: form.account ?? '',
      provider: form.provider === 'google' ? 'google' : 'fake',
      enabled: form.action === 'enable',
      enrichment: form.enrichment === 'on',
      calls: Number(form.calls),
      budgetMicros: Number(form.budget) * 1000000,
    });
  }
  const accounts = await addresses.installations(view);
  const options = companies.map((c) => {
    const label = Object.entries(c.values).find(
      ([field, value]) => field.endsWith('name') && typeof value === 'string',
    )?.[1];
    return `<option value="${escape(c.recordId)}">${escape(typeof label === 'string' ? label : c.recordId)}</option>`;
  });
  const active = accounts
    .map(
      (i) =>
        `<li>${escape(i.account)} · ${i.provider === 'fake' ? 'Demo Maps' : 'Google Maps'} · ${i.enrichment ? 'Geocoding enabled' : 'Suggestions only'}</li>`,
    )
    .join('');
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Address and Maps</title><main><a href="/?customize">Customize</a><h1>Address and Maps</h1><p>Local demo company settings</p>' +
    (active ? '<ul>' + active + '</ul>' : '<p>No enabled accounts.</p>') +
    '<form method="post"><label>Company<select name="companyId" required>' +
    options.join('') +
    '</select></label>' +
    '<label>Provider<select name="provider"><option value="fake">Demo Maps</option><option value="google">Google Maps (supported non-EEA demo)</option></select></label>' +
    '<label>Provider account reference<input name="account" required pattern="[A-Za-z0-9_.-]+" maxlength="120" value="demo"></label>' +
    '<label>Monthly lookup limit<input name="calls" type="number" min="1" max="10000" value="100" required></label>' +
    '<label>Monthly spend limit (USD)<input name="budget" type="number" min="0" max="1000" step="0.01" value="0" required></label>' +
    '<label><input name="enrichment" type="checkbox" checked> Locate saved addresses</label><button name="action" value="enable">Enable for this company</button><button name="action" value="pause">Pause</button></form></main></html>'
  );
}
