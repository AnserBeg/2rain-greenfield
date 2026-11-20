import { AsyncLocalStorage } from 'node:async_hooks';

/** Carry the ingress monotonic budget across authentication, policy and provider transactions. */
export const requestDeadline = new AsyncLocalStorage<() => number>();
