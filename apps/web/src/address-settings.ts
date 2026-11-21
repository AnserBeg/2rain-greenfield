import type { RequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';
import type { AddressGateway } from '../../../packages/runtime/src/address-gateway.js';
import type { SemanticQueryGateway } from '../../../packages/runtime/src/semantic-query-gateway.js';
import { workspaceList } from './workspace-entry.js';

import { renderCompanyAddressSettings } from './customize-screen.js';

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
  const activeCompanies = (
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
  const companies = [];
  for (const company of activeCompanies) {
    if (await addresses.canConfigure(view, company.recordId))
      companies.push(company);
  }
  if (companies.length === 0) throw Error('Company settings unavailable.');
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
  const companyIds = new Set(companies.map((company) => company.recordId));
  const accounts = (await addresses.installations(view)).filter((account) =>
    companyIds.has(account.companyId),
  );
  const choices = companies.map((c) => {
    const label = Object.entries(c.values).find(
      ([field, value]) => field.endsWith('name') && typeof value === 'string',
    )?.[1];
    return {
      id: c.recordId,
      label: typeof label === 'string' ? label : c.recordId,
    };
  });
  return renderCompanyAddressSettings(choices, accounts);
}
