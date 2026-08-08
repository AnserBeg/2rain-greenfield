/**
 * Reads what a surface-slot renderer consumes, from the registry source.
 *
 * Extracted from the gate so the gate's OWN mutation harness can import it and
 * demonstrate that each predicate fires. A gate whose predicates were never seen
 * to fire is the defect this module exists to prevent: `U5b`'s round-2 table
 * claimed eleven mutations and no survivors from a harness that was never in the
 * tree, and an independent replay against the same predicates found four.
 *
 * This is a PROXY, not an observation (AGENTS.md §6). It reads source text, so
 * it cannot follow dispatch through `componentRegistry[contentReferenceId]` --
 * which is why reaching that dispatch is itself disqualifying rather than a
 * documented gap.
 */

/** A read of the surface's own data. */
export const FIELD_TOKENS =
  /\bfieldIds\b|\bdisplayFieldId\b|\bvalues\s*\[|\bdisplayValues\b/u;

/** Anything the user can type into. */
export const INPUT_TOKENS = /<input\b|<textarea\b|<select\b|\brequired\b/u;

/** Anything the user can act through: a control that submits or mutates. */
export const ACTION_TOKENS = /<button\b|<form\b|submit/u;

/**
 * Navigation. Watched as its own category rather than folded into `action`,
 * because the two are not the same fact and only one of them is protected --
 * see `proven-deferrable-slots.test.ts` for the admission and its reason.
 */
export const LINK_TOKENS = /<a\s|\bhref=/u;

/** Runtime dispatch, which no source reading can resolve. */
export const DYNAMIC_DISPATCH = /\brenderReferencedComponent\s*\(/u;

export const PROTECTED_TOKENS: ReadonlyArray<readonly [string, RegExp]> =
  Object.freeze([
    ['field', FIELD_TOKENS],
    ['input', INPUT_TOKENS],
    ['action', ACTION_TOKENS],
    ['link', LINK_TOKENS],
    ['dynamic', DYNAMIC_DISPATCH],
  ] as const);

const DECLARATION =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*[:=])/u;

/**
 * Splits the source into top-level declarations. Deliberately covers BOTH
 * `function name(...)` and `const name = (...) => ...`: a helper moved into an
 * arrow function was one of the four survivors an independent replay found
 * against the previous walk, which followed only `function` declarations.
 */
export function declarations(source: string): ReadonlyMap<string, string> {
  const lines = source.split('\n');
  const starts: { index: number; name: string }[] = [];
  lines.forEach((line, index) => {
    const match = DECLARATION.exec(line);
    if (match) starts.push({ index, name: match[1] ?? match[2]! });
  });
  const bodies = new Map<string, string>();
  starts.forEach((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    bodies.set(start.name, lines.slice(start.index, end).join('\n'));
  });
  return bodies;
}

/**
 * Whether `name`, or anything it calls that is declared in the same source,
 * reaches `token`.
 */
export function reaches(
  bodies: ReadonlyMap<string, string>,
  name: string,
  token: RegExp,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = bodies.get(name);
  if (body === undefined) return false;
  if (token.test(body)) return true;
  for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const callee = call[1]!;
    if (
      callee !== name &&
      bodies.has(callee) &&
      reaches(bodies, callee, token, seen)
    ) {
      return true;
    }
  }
  return false;
}

/** The `(archetype, slot)` -> renderer map, read from the slot registry. */
export function slotRenderers(source: string): ReadonlyMap<string, string> {
  const renderers = new Map<string, string>();
  for (const entry of source.matchAll(
    /'([a-z]+):([A-Za-z]+)':\s*\{([\s\S]*?)\n {4}\}/gu,
  )) {
    const renderer = /renderer:\s*([A-Za-z_$][\w$]*)/u.exec(entry[3]!);
    if (renderer) renderers.set(`${entry[1]!}:${entry[2]!}`, renderer[1]!);
  }
  return renderers;
}

/** Every protected category `name` reaches, in declaration order. */
export function protectedCategories(
  bodies: ReadonlyMap<string, string>,
  name: string,
): readonly string[] {
  return PROTECTED_TOKENS.filter(([, token]) =>
    reaches(bodies, name, token),
  ).map(([category]) => category);
}
