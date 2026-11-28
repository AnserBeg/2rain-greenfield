import type { PoolClient } from 'pg';
import type { ServiceUseOwnerCursor } from '../../canonical-model/src/service-evidence.js';

/** The PostgreSQL half of the service-use protocol: a provider compares every
 * owner's cursor with the one a consumer read, on the consumer's transaction
 * and in the provider's own lock order, so the comparison holds until commit.
 * It throws when any cursor moved. */
export type ServiceUseFence = (
  client: PoolClient,
  releaseId: string,
  fence: number,
  owners: readonly ServiceUseOwnerCursor[],
) => Promise<void>;

const fences = new Map<string, ServiceUseFence>();

export function registerServiceUseFence(
  binding: string,
  fence: ServiceUseFence,
) {
  const prior = fences.get(binding);
  if (prior && prior !== fence)
    throw new Error(`Service-use binding ${binding} has two fences`);
  fences.set(binding, fence);
}

/** The fence for a read-model binding, or undefined when no provider
 * registered one (the consumer refuses). */
export function serviceUseFence(binding: string): ServiceUseFence | undefined {
  return fences.get(binding);
}
