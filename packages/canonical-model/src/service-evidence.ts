import { z } from 'zod';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

/**
 * The service-use evidence protocol: what any engine or module that records
 * when something was actually used (a reservation's possession legs, a time
 * clock, telematics engine hours, gate events) hands to a consumer that
 * charges, reports or schedules on that use. A consumer names the protocol,
 * never the provider; a provider implements it for the read-model binding it
 * owns and registers here. A binding with no registered provider does not
 * implement the protocol, so a consumer refuses it (fail closed).
 */
export const SERVICE_USE_PROTOCOL =
  'northstar.evidence:protocol.service_use_v1';
export const SERVICE_USE_SNAPSHOT_VERSION = 'northstar.service-use/v1';

const id = z.string().min(1).max(180);
const instant = z.iso.datetime({ precision: 3 });
const span = { id, revision: id, start: instant, end: instant.nullable() };

/** One owner's use, complete through `asOf` at `cursor`. Each engagement is
 * one commitment of a provider subject (Booking: a slot) to the owner. Legs
 * are half-open use intervals with an exact quantity and unit; an open leg is
 * still in use. Voided facts are never included. */
export const ServiceUseSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(SERVICE_USE_SNAPSHOT_VERSION),
  owner: z.strictObject({ entityId: id, recordId: id, companyId: id }),
  asOf: instant,
  cursor: z.string().regex(/^(0|[1-9]\d{0,18})$/u),
  complete: z.boolean(),
  engagements: z.array(
    z.strictObject({
      id,
      subjectId: id,
      mode: z.enum(['actual', 'planned']),
      unit: id,
      legs: z.array(
        z.strictObject({
          ...span,
          quantity: z.string().max(64).nullable(),
          unit: id.nullable(),
        }),
      ),
      pauses: z.array(z.strictObject(span)),
    }),
  ),
});
export type ServiceUseSnapshot = z.infer<typeof ServiceUseSnapshotSchema>;

type Query = VersionedNormalizedApplicationPackage['queries'][number];
type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export interface ServiceUseProvider {
  /** The read-model binding whose results this provider attests. */
  readonly binding: string;
  /** The read model's result field that carries the provider's raw answer. */
  readonly resultKey: string;
  /** Compile time: why `subjectId` is not a subject this query can attest in
   * `unit` (undefined when it is). The provider checks its own declarations. */
  subjectProblem(
    pkg: VersionedNormalizedApplicationPackage,
    query: Query,
    subjectId: string,
    unit: string,
  ): string | undefined;
  /** The query arguments that ask for use inside the half-open window. */
  window(from: string, until: string): Readonly<Record<string, Json>>;
  /** The provider's raw answer as a protocol snapshot. */
  decode(value: unknown): ServiceUseSnapshot;
}

/** Per-owner revision fence a writer runs on its own transaction (the
 * PostgreSQL half lives with the provider; this is its declaration). */
export interface ServiceUseOwnerCursor {
  readonly queryId: string;
  readonly entityId: string;
  readonly recordId: string;
  readonly cursor: string;
}

const providers = new Map<string, ServiceUseProvider>();

export function registerServiceUseProvider(provider: ServiceUseProvider) {
  const prior = providers.get(provider.binding);
  if (prior && prior !== provider)
    throw new Error(
      `Service-use binding ${provider.binding} has two providers`,
    );
  providers.set(provider.binding, provider);
}

/** The provider for a read-model binding, or undefined when the binding does
 * not implement the service-use protocol. */
export function serviceUseProvider(
  binding: string | undefined,
): ServiceUseProvider | undefined {
  return binding === undefined ? undefined : providers.get(binding);
}
