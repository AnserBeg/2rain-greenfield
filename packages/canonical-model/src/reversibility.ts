/**
 * The reversibility declaration (AI-UNDO-1 slice 2; AI review, "The proposed
 * reversibility declaration").
 *
 * What it is: for every operation of a release, and for every field an update
 * writes, what taking the change back costs — derived by the compiler from the
 * release's own facts, never from an id, a namespace or a name. Any reader can
 * use it unchanged: an autonomy policy (act at once, or ask), a person's Undo,
 * a workflow that must know whether a step can be reversed, and audit, which
 * reads the `because` codes to say why.
 *
 * - `undo`: `exact` (the inverse returns an identical read-back), `residue`
 *   (Undo works but leaves a trace: an archived record, a used number),
 *   `compensate` (only a new business transaction reverses it), `none`.
 * - `inverse`: `restorePriorValues`, the operation that reverses it, or `none`.
 * - `reach`: what else moves. `record` (only this record), `internal` (other
 *   facts or people's actions inside the system: a gate another operation
 *   reads, stock, money, state), `outward` (something that leaves the system).
 * - `basis`: `derived` from the release's facts, or `declared` when an
 *   authored declaration made it stricter (`requiresAssistantConfirmation`).
 *   A declaration can only make a class stricter, never looser.
 * - `holdsWhile`: an update's `exact, record` holds only while its record (and
 *   each declared parent) is in its lifecycle's initial state. Outside it the
 *   document may already have been acted on, so the reader must ask.
 *
 * Absence is the worst case: an operation or field with no declaration is
 * `none, outward` to every reader (as MCP's tool annotations default).
 */

import { z } from 'zod';

export const REVERSIBILITY_DECLARATION_VERSION =
  'northstar.reversibility-declaration/v1' as const;

/**
 * The agent-discovery reader floor that carries the declaration: a reader
 * below it refuses a release that has one, by family and version (rule 13).
 */
export const REVERSIBILITY_AGENT_READER = 5;

export type ReversibilityUndo = 'exact' | 'residue' | 'compensate' | 'none';
export type ReversibilityReach = 'record' | 'internal' | 'outward';

/** Why a class is what it is; stable codes an audit trail or a card renders. */
export type ReversibilityReason =
  | 'revisionCheckedPatch'
  | 'notRevisionChecked'
  | 'notInputContract'
  | 'movesStockOrMoney'
  | 'confirmationRequired'
  | 'declaredConfirmation'
  | 'readAsGate'
  | 'confirmedWriter'
  | 'numbered'
  | 'oldValueRedacted'
  | 'archiveInverse'
  | 'noArchive'
  | 'restoreInverse'
  | 'reverseTransition'
  | 'noReverseTransition'
  | 'capabilityUndeclared'
  | 'removesRecord'
  | 'unknownEffect';

export interface ReversibilityClass {
  readonly undo: ReversibilityUndo;
  readonly inverse:
    'restorePriorValues' | { readonly operationId: string } | 'none';
  readonly reach: ReversibilityReach;
  readonly basis: 'derived' | 'declared';
  readonly because: readonly ReversibilityReason[];
}

export interface LifecycleCondition {
  /** The field that holds the record's state. */
  readonly stateFieldId: string;
  /** The states in which the class holds, and their declared labels. */
  readonly stateIds: readonly string[];
  readonly stateLabels: readonly string[];
}

export interface ParentLifecycleCondition extends LifecycleCondition {
  /** The parent-scoped child relation that names the parent. */
  readonly relationId: string;
  /** The query that reads the parent. */
  readonly queryId: string;
}

export interface OperationReversibility extends ReversibilityClass {
  readonly operationId: string;
  readonly fields?: readonly (ReversibilityClass & {
    readonly fieldId: string;
  })[];
  readonly holdsWhile?: {
    readonly state?: LifecycleCondition;
    readonly parents?: readonly ParentLifecycleCondition[];
  };
}

export interface ReversibilityDeclaration {
  readonly schemaVersion: typeof REVERSIBILITY_DECLARATION_VERSION;
  readonly operations: readonly OperationReversibility[];
}

const reason = z.enum([
  'revisionCheckedPatch',
  'notRevisionChecked',
  'notInputContract',
  'movesStockOrMoney',
  'confirmationRequired',
  'declaredConfirmation',
  'readAsGate',
  'confirmedWriter',
  'numbered',
  'oldValueRedacted',
  'archiveInverse',
  'noArchive',
  'restoreInverse',
  'reverseTransition',
  'noReverseTransition',
  'capabilityUndeclared',
  'removesRecord',
  'unknownEffect',
]);
const reversibilityClass = {
  undo: z.enum(['exact', 'residue', 'compensate', 'none']),
  inverse: z.union([
    z.literal('restorePriorValues'),
    z.literal('none'),
    z.strictObject({ operationId: z.string().min(1) }),
  ]),
  reach: z.enum(['record', 'internal', 'outward']),
  basis: z.enum(['derived', 'declared']),
  because: z.array(reason),
};
const lifecycleCondition = {
  stateFieldId: z.string().min(1),
  // Empty: the lifecycle is ambiguous, so the class holds in no state.
  stateIds: z.array(z.string().min(1)),
  stateLabels: z.array(z.string()),
};
const declarationSchema = z.strictObject({
  schemaVersion: z.literal(REVERSIBILITY_DECLARATION_VERSION),
  operations: z.array(
    z.strictObject({
      operationId: z.string().min(1),
      ...reversibilityClass,
      fields: z
        .array(
          z.strictObject({ fieldId: z.string().min(1), ...reversibilityClass }),
        )
        .optional(),
      holdsWhile: z
        .strictObject({
          state: z.strictObject(lifecycleCondition).optional(),
          parents: z
            .array(
              z.strictObject({
                ...lifecycleCondition,
                relationId: z.string().min(1),
                queryId: z.string().min(1),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  ),
});

/**
 * A release's declaration, or `undefined` when it has none or one this reader
 * cannot read. Every reader treats `undefined` as the worst case for every
 * operation: `none, outward`.
 */
export function parseReversibilityDeclaration(
  value: unknown,
): ReversibilityDeclaration | undefined {
  const parsed = declarationSchema.safeParse(value);
  return parsed.success ? (parsed.data as ReversibilityDeclaration) : undefined;
}

/** The worst case, which an undeclared operation or field gets from every reader. */
export const UNDECLARED_REVERSIBILITY: ReversibilityClass = Object.freeze({
  undo: 'none',
  inverse: 'none',
  reach: 'outward',
  basis: 'derived',
  because: Object.freeze([]) as readonly ReversibilityReason[],
});
