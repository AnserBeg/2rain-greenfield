import { BOOKING_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/booking-capability-executor';
import type { PostgresCapabilityOperationExecutorFactory } from '../../../packages/postgres-provider/src/capability-operation-executor-factory.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/inventory-posting-capability-executor';
import { FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/fulfillment-capability-executor';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/receiving-capability-executor';
import { RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/receivables-capability-executor';
import { PAYABLES_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/payables-capability-executor';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '@north-star/postgres-provider/purchase-order-approval-executor';

export const CAPABILITY_EXECUTOR_FACTORIES: readonly PostgresCapabilityOperationExecutorFactory[] =
  Object.freeze([
    BOOKING_CAPABILITY_EXECUTOR_FACTORY,
    INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
    RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
    FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY,
    RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY,
    PAYABLES_CAPABILITY_EXECUTOR_FACTORY,
    PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
  ]);
