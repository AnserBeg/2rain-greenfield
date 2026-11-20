import { z } from 'zod';

export const BOOKING_CAPABILITY = 'northstar.booking:capability.commitments';
export const BOOKING_OPERATION_READER = 5;
const id = z
  .string()
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );

/** Resolved inputs to a single operation in a booking slot. The immutable
 * release supplies the slot, both endpoint types, permissions and pack dials. */
export const BookingOperationBinding = z
  .strictObject({
    schemaVersion: z.literal('booking.commitment/v1'),
    declarationRevision: id,
    slotRevision: id,
    slotId: id,
    resourceEntity: id,
    ownerEntity: id,
    ownerReadPermission: id,
    resourceReadPermission: id,
    operation: z.enum([
      'hold',
      'confirm',
      'cancel',
      'changeInterval',
      'setCapacity',
    ]),
    kind: z.enum(['unit', 'pool']),
    fulfilmentMode: z.enum(['tracked', 'scheduled']),
    maxBackdateDays: z.int().min(0).max(31),
    holdSeconds: z.int().min(1).max(86400),
    unit: z.string().min(1).max(120),
    scale: z.int().min(0).max(18),
  })
  .refine((binding) => binding.kind !== 'unit' || binding.scale === 0)
  .refine(
    (binding) =>
      binding.operation !== 'setCapacity' ||
      (binding.kind === 'pool' &&
        binding.resourceEntity === binding.ownerEntity),
  );
export type BookingOperationBinding = z.infer<typeof BookingOperationBinding>;

export function hasBookingOperations(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operations' in value &&
    Array.isArray(value.operations) &&
    value.operations.some(
      (op: unknown) => typeof op === 'object' && op !== null && 'booking' in op,
    )
  );
}
