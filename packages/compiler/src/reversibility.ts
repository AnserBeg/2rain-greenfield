/**
 * Derives the reversibility declaration (see
 * `packages/canonical-model/src/reversibility.ts`) from a release's own facts:
 * its compiled operation contracts, preconditions, state machines, relations
 * and field declarations. No id, namespace or name decides a class.
 */
import type {
  LifecycleCondition,
  OperationReversibility,
  ParentLifecycleCondition,
  ReversibilityClass,
  ReversibilityDeclaration,
  ReversibilityReach,
  ReversibilityReason,
  ReversibilityUndo,
} from '../../canonical-model/src/reversibility.js';
import { REVERSIBILITY_DECLARATION_VERSION } from '../../canonical-model/src/reversibility.js';

export {
  REVERSIBILITY_AGENT_READER,
  type ReversibilityDeclaration,
} from '../../canonical-model/src/reversibility.js';

/** The parts of a compiled operation catalog entry the derivation reads. */
interface CatalogOperation {
  readonly operationId: string;
  readonly tier?: unknown;
  readonly confirmation?: unknown;
  readonly effect: {
    readonly kind: string;
    readonly entity?: { readonly targetId: string };
    readonly transition?: { readonly targetId: string };
  };
  readonly precondition?: unknown;
  readonly readBackQueryId?: string;
  readonly inputContract?: {
    readonly closedArgumentKeys: readonly string[];
    readonly writableFieldIds: readonly string[];
  };
  readonly infrastructure?: { readonly optimisticRevision?: string };
}

/** The parts of the normalized release the derivation reads. */
export interface ReversibilitySource {
  readonly fields: readonly {
    readonly fieldId: string;
    readonly entity: { readonly targetId: string };
    readonly lifecycle?: string;
    readonly classification?: string;
    readonly numbering?: unknown;
    readonly fieldType: {
      readonly kind: string;
      readonly options?: readonly {
        readonly optionId: string;
        readonly label: string;
        readonly orderKey: number;
      }[];
    };
  }[];
  readonly relations: readonly {
    readonly relationId: string;
    readonly ownership?: string;
    readonly lifecycle?: string;
    readonly sourceEntity: { readonly targetId: string };
    readonly targetEntity: { readonly targetId: string };
  }[];
  readonly stateMachines: readonly {
    readonly entity: { readonly targetId: string };
    readonly lifecycle?: string;
    readonly initialState: { readonly targetId: string };
    readonly stateField?: { readonly fieldId: string };
    readonly states: readonly {
      readonly stateId: string;
      readonly label: string;
    }[];
    readonly transitions: readonly {
      readonly transitionId: string;
      readonly fromState: { readonly targetId: string };
      readonly toState: { readonly targetId: string };
    }[];
  }[];
}

/** Every field id a predicate (or any declared tree) reads. */
function fieldsRead(tree: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(tree)) for (const item of tree) fieldsRead(item, into);
  else if (tree && typeof tree === 'object') {
    const node = tree as Record<string, unknown>;
    if (node.kind === 'fieldReference' && typeof node.targetId === 'string')
      into.add(node.targetId);
    for (const value of Object.values(node)) fieldsRead(value, into);
  }
  return into;
}

const REDACTED_CLASSIFICATIONS = new Set(['confidential', 'restricted']);

export function deriveReversibility(
  catalogOperations: readonly CatalogOperation[],
  release: ReversibilitySource,
  confirmationRequiredFor: ReadonlySet<string>,
): ReversibilityDeclaration {
  const active = <T extends { readonly lifecycle?: string }>(
    items: readonly T[],
  ) =>
    items.filter(
      (item) => item.lifecycle === undefined || item.lifecycle === 'active',
    );
  const fields = new Map(
    active(release.fields).map((field) => [field.fieldId, field]),
  );
  const entityOf = (operation: CatalogOperation) =>
    operation.effect.entity?.targetId;
  const byEntityAndKind = new Map<string, CatalogOperation[]>();
  for (const operation of catalogOperations) {
    const key = `${entityOf(operation) ?? ''}/${operation.effect.kind}`;
    byEntityAndKind.set(key, [...(byEntityAndKind.get(key) ?? []), operation]);
  }
  const firstOf = (entity: string, kind: string) =>
    byEntityAndKind.get(`${entity}/${kind}`)?.[0];

  // A field another operation's precondition reads is a gate: changing it
  // changes what other actions may do, so its reach is internal.
  const gates = new Set<string>();
  for (const operation of catalogOperations)
    fieldsRead(operation.precondition, gates);

  // A field another operation of the record type writes only with a yes (or
  // at a higher tier) is guarded: changing it, or putting it back, needs that
  // yes too.
  const confirmedWrites = new Map<string, Set<string>>();
  for (const operation of catalogOperations)
    if (operation.confirmation !== 'none' || operation.tier !== 'o0') {
      const entity = entityOf(operation);
      if (!entity) continue;
      const written = confirmedWrites.get(entity) ?? new Set<string>();
      for (const field of operation.inputContract?.writableFieldIds ?? [])
        written.add(field);
      confirmedWrites.set(entity, written);
    }

  const machines = new Map(
    active(release.stateMachines).map((machine) => [
      machine.entity.targetId,
      machine,
    ]),
  );
  /** A record type's lifecycle: its state machine, else an enum gate its own update reads. */
  const lifecycle = (entity: string): LifecycleCondition | undefined => {
    const machine = machines.get(entity);
    if (machine?.stateField) {
      const initial = machine.states.find(
        (state) => state.stateId === machine.initialState.targetId,
      );
      return initial
        ? {
            stateFieldId: machine.stateField.fieldId,
            stateIds: [initial.stateId],
            stateLabels: [initial.label],
          }
        : undefined;
    }
    const update = firstOf(entity, 'updateRecordEffect');
    if (!update) return undefined;
    for (const fieldId of [
      ...fieldsRead(update.precondition, new Set()),
    ].sort()) {
      const field = fields.get(fieldId);
      const options =
        field?.entity.targetId === entity ? field.fieldType.options : undefined;
      if (field?.fieldType.kind !== 'enumFieldType' || !options?.length)
        continue;
      // An enum lifecycle without a machine starts at its first declared option.
      const first = [...options].sort((a, b) => a.orderKey - b.orderKey)[0]!;
      return {
        stateFieldId: fieldId,
        stateIds: [first.optionId],
        stateLabels: [first.label],
      };
    }
    return undefined;
  };
  const parentsOf = (entity: string): ParentLifecycleCondition[] =>
    active(release.relations)
      .filter(
        (relation) =>
          relation.ownership === 'parentScopedChild' &&
          relation.sourceEntity.targetId === entity,
      )
      .flatMap((relation) => {
        const parent = relation.targetEntity.targetId;
        const condition = lifecycle(parent);
        const query =
          firstOf(parent, 'updateRecordEffect')?.readBackQueryId ??
          firstOf(parent, 'createRecordEffect')?.readBackQueryId;
        return condition && query
          ? [{ ...condition, relationId: relation.relationId, queryId: query }]
          : [];
      })
      .sort((a, b) =>
        a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0,
      );

  const cls = (
    undo: ReversibilityUndo,
    inverse: ReversibilityClass['inverse'],
    reach: ReversibilityReach,
    because: ReversibilityReason[],
    basis: ReversibilityClass['basis'] = 'derived',
  ): ReversibilityClass => ({ undo, inverse, reach, basis, because });
  const inverseOf = (entity: string | undefined, kind: string) => {
    const operation = entity ? firstOf(entity, kind) : undefined;
    return operation ? { operationId: operation.operationId } : undefined;
  };

  const operations = catalogOperations.map(
    (operation): OperationReversibility => {
      const entity = entityOf(operation);
      const elevated: ReversibilityReason[] = [
        ...(operation.tier !== 'o0' ? (['movesStockOrMoney'] as const) : []),
        ...(operation.confirmation !== 'none'
          ? (['confirmationRequired'] as const)
          : []),
      ];
      switch (operation.effect.kind) {
        case 'updateRecordEffect': {
          const contract = operation.inputContract;
          const revisionChecked =
            contract !== undefined &&
            contract.closedArgumentKeys.includes('patch') &&
            contract.closedArgumentKeys.includes('expectedRevision') &&
            operation.infrastructure?.optimisticRevision ===
              'compareAndIncrement';
          const base = revisionChecked
            ? cls(
                'exact',
                'restorePriorValues',
                elevated.length ? 'internal' : 'record',
                ['revisionCheckedPatch', ...elevated],
              )
            : cls('none', 'none', 'internal', [
                contract ? 'notRevisionChecked' : 'notInputContract',
                ...elevated,
              ]);
          const entityDeclared =
            entity !== undefined && confirmationRequiredFor.has(entity);
          const fieldClasses = [...(contract?.writableFieldIds ?? [])]
            .sort()
            .map((fieldId) => {
              const field = fields.get(fieldId);
              const because: ReversibilityReason[] = [];
              let undo: ReversibilityUndo = base.undo;
              let reach: ReversibilityReach = base.reach;
              let basis: ReversibilityClass['basis'] = 'derived';
              if (
                field?.classification &&
                REDACTED_CLASSIFICATIONS.has(field.classification)
              ) {
                undo = 'none';
                because.push('oldValueRedacted');
              } else if (field?.numbering !== undefined && undo === 'exact') {
                undo = 'residue';
                because.push('numbered');
              }
              if (gates.has(fieldId)) {
                reach = reach === 'outward' ? reach : 'internal';
                because.push('readAsGate');
              }
              if (
                entity &&
                operation.confirmation === 'none' &&
                confirmedWrites.get(entity)?.has(fieldId)
              ) {
                reach = reach === 'outward' ? reach : 'internal';
                because.push('confirmedWriter');
              }
              if (entityDeclared || confirmationRequiredFor.has(fieldId)) {
                reach = reach === 'outward' ? reach : 'internal';
                basis = 'declared';
                because.push('declaredConfirmation');
              }
              return {
                fieldId,
                undo,
                inverse: undo === 'none' ? ('none' as const) : base.inverse,
                reach,
                basis,
                because,
              };
            });
          const state = entity ? lifecycle(entity) : undefined;
          const parents = entity ? parentsOf(entity) : [];
          return {
            operationId: operation.operationId,
            ...base,
            fields: fieldClasses,
            ...(state || parents.length
              ? {
                  holdsWhile: {
                    ...(state ? { state } : {}),
                    ...(parents.length ? { parents } : {}),
                  },
                }
              : {}),
          };
        }
        case 'createRecordEffect': {
          const archive = inverseOf(entity, 'archiveRecordEffect');
          return {
            operationId: operation.operationId,
            ...(archive
              ? cls(
                  'residue',
                  archive,
                  elevated.length ? 'internal' : 'record',
                  ['archiveInverse', ...elevated],
                )
              : cls('none', 'none', 'internal', ['noArchive', ...elevated])),
          };
        }
        case 'archiveRecordEffect':
        case 'restoreRecordEffect': {
          const archive = operation.effect.kind === 'archiveRecordEffect';
          const inverse = inverseOf(
            entity,
            archive ? 'restoreRecordEffect' : 'archiveRecordEffect',
          );
          return {
            operationId: operation.operationId,
            ...(inverse
              ? cls('exact', inverse, elevated.length ? 'internal' : 'record', [
                  archive ? 'restoreInverse' : 'archiveInverse',
                  ...elevated,
                ])
              : cls('none', 'none', 'internal', [...elevated])),
          };
        }
        case 'transitionStateEffect': {
          const transitionId = operation.effect.transition?.targetId;
          const machine = [...machines.values()].find((candidate) =>
            candidate.transitions.some(
              (transition) => transition.transitionId === transitionId,
            ),
          );
          const transition = machine?.transitions.find(
            (candidate) => candidate.transitionId === transitionId,
          );
          const reverse = machine?.transitions.find(
            (candidate) =>
              transition !== undefined &&
              candidate.fromState.targetId === transition.toState.targetId &&
              candidate.toState.targetId === transition.fromState.targetId,
          );
          const reverseOperation = reverse
            ? catalogOperations.find(
                (candidate) =>
                  candidate.effect.kind === 'transitionStateEffect' &&
                  candidate.effect.transition?.targetId ===
                    reverse.transitionId,
              )
            : undefined;
          // A state is a gate other actions read, so its reach is internal.
          return {
            operationId: operation.operationId,
            ...(reverseOperation
              ? cls(
                  'exact',
                  { operationId: reverseOperation.operationId },
                  'internal',
                  ['reverseTransition', ...elevated],
                )
              : cls('none', 'none', 'internal', [
                  'noReverseTransition',
                  ...elevated,
                ])),
          };
        }
        case 'registeredCapabilityEffect':
          // A capability must declare its own inverse; until it does, the worst case.
          return {
            operationId: operation.operationId,
            ...cls('none', 'none', 'outward', [
              'capabilityUndeclared',
              ...elevated,
            ]),
          };
        case 'purgeRecordEffect':
        case 'destroyRecordEffect':
          return {
            operationId: operation.operationId,
            ...cls('none', 'none', 'internal', ['removesRecord', ...elevated]),
          };
        default:
          return {
            operationId: operation.operationId,
            ...cls('none', 'none', 'outward', ['unknownEffect', ...elevated]),
          };
      }
    },
  );
  return {
    schemaVersion: REVERSIBILITY_DECLARATION_VERSION,
    operations: [...operations].sort((a, b) =>
      a.operationId < b.operationId
        ? -1
        : a.operationId > b.operationId
          ? 1
          : 0,
    ),
  };
}
