import type { AuthoredBillingPlan } from './billing.js';

export function normalizeBillingPlan(plan: AuthoredBillingPlan) {
  return {
    ...plan,
    pricingWindow: plan.pricingWindow ?? ('month' as const),
    components: plan.components.map((component) => {
      switch (component.kind) {
        case 'time':
          return {
            ...component,
            partialTime: component.partialTime ?? ('wholeStarted' as const),
            minimumScope: component.minimumScope ?? ('perEnrollment' as const),
          };
        case 'meter':
          return {
            ...component,
            allowanceProration:
              component.allowanceProration ?? ('activeCoverage' as const),
          };
        case 'fixed': {
          const fee = component.occurrence;
          return {
            ...component,
            occurrence:
              fee.kind === 'oneOff'
                ? fee
                : {
                    ...fee,
                    fixedFeeDuringPause:
                      fee.fixedFeeDuringPause ?? ('suspend' as const),
                    feeProration:
                      fee.feeProration ?? ('activeCoverage' as const),
                  },
          };
        }
      }
    }),
  };
}

export type BillingPlan = ReturnType<typeof normalizeBillingPlan>;
export type TimeComponent = Extract<
  BillingPlan['components'][number],
  { kind: 'time' }
>;
