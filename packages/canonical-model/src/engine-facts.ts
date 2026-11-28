/**
 * ADR-0073 A1 engineFactChanged (WORKFLOW-3 s1b). An engine that keeps its own
 * state outside a declared record machine owns a catalog of facts: each fact
 * names a subject the engine keeps (one occurrence per subject and revision),
 * the record type that owns each subject (the run's trigger record and its
 * company), the values the fact takes and every move between them.
 *
 * Generic code never imports an engine. An engine registers a provider when
 * its own module loads (as service-use providers do), and generic admission
 * reads the declarations the provider derives from the package revision's own
 * engine bindings. No release byte changes: the declarations are computed, not
 * compiled into a catalog.
 */

/** The canonical ID shape (schemas.ts CanonicalIdSchema), kept local so an
 * engine module can import this file without a cycle through schemas.ts. */
const CANONICAL_ID =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

export interface EngineFactMove {
  readonly from: string;
  readonly to: string;
  /**
   * `command`: a governed command moves it under the release that command
   * runs on. `timer`: the engine's own sweep moves it under the release of
   * the command that armed the timer (an older release after any change), so
   * a run on a value any timer enters would silently never start (E3).
   */
  readonly via: 'command' | 'timer';
}

export interface EngineFactDeclaration {
  readonly factId: string;
  /** The engine-owned subject type each occurrence names. */
  readonly subjectId: string;
  /** The record type that owns each subject: trigger record and company. */
  readonly ownerTypeId: string;
  readonly values: readonly {
    readonly valueId: string;
    readonly label: string;
  }[];
  readonly moves: readonly EngineFactMove[];
}

export interface EngineFactProvider {
  /** A stable provider key; one provider per key. */
  readonly provider: string;
  /** The facts the package revision's own engine bindings declare. */
  declarations(revision: unknown): readonly EngineFactDeclaration[];
}

const providers = new Map<string, EngineFactProvider>();

function assertDeclaration(declaration: EngineFactDeclaration): void {
  const ids = [
    declaration.factId,
    declaration.subjectId,
    declaration.ownerTypeId,
    ...declaration.values.map(({ valueId }) => valueId),
  ];
  const values = new Set(declaration.values.map(({ valueId }) => valueId));
  if (
    ids.some((id) => !CANONICAL_ID.test(id) || id.length > 180) ||
    values.size !== declaration.values.length ||
    declaration.moves.some(
      ({ from, to }) => from === to || !values.has(from) || !values.has(to),
    )
  )
    throw new Error(`Engine fact ${declaration.factId} is not well formed`);
}

export function registerEngineFactProvider(provider: EngineFactProvider) {
  const prior = providers.get(provider.provider);
  if (prior && prior !== provider)
    throw new Error(
      `Engine fact provider ${provider.provider} is registered twice`,
    );
  providers.set(provider.provider, provider);
}

/** Every fact the revision's engine bindings declare, in a stable order. */
export function engineFactDeclarations(
  revision: unknown,
): readonly EngineFactDeclaration[] {
  return [...providers.keys()]
    .sort()
    .flatMap((key) => providers.get(key)!.declarations(revision))
    .map((declaration) => {
      assertDeclaration(declaration);
      return declaration;
    })
    .sort((left, right) =>
      `${left.factId}\u0000${left.ownerTypeId}`.localeCompare(
        `${right.factId}\u0000${right.ownerTypeId}`,
      ),
    );
}

/**
 * The values a trigger may name (E3): entered by at least one move and by no
 * timer move, with the values each is entered from by command.
 */
export function engineFactTriggerValues(
  declaration: EngineFactDeclaration,
): ReadonlyMap<
  string,
  { readonly label: string; readonly fromValueIds: readonly string[] }
> {
  const timed = new Set(
    declaration.moves.filter(({ via }) => via === 'timer').map(({ to }) => to),
  );
  const result = new Map<string, { label: string; fromValueIds: string[] }>();
  for (const { valueId, label } of declaration.values) {
    if (timed.has(valueId)) continue;
    const from = [
      ...new Set(
        declaration.moves
          .filter(({ to }) => to === valueId)
          .map(({ from: source }) => source),
      ),
    ];
    if (from.length) result.set(valueId, { label, fromValueIds: from });
  }
  return result;
}
