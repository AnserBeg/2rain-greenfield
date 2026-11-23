import { canonicalize } from '../../canonical-model/src/canonicalize.js';
import {
  compilePresentation,
  type PresentationSource,
} from '../../canonical-model/src/surface-presentation.js';

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
const object = (value: unknown) => (value ?? {}) as Row;

/**
 * The compiled surface key equals what the approved declaration compiles to,
 * on every surface that declares one, and no other surface carries it.
 */
export function presentationDeclarationProblem(
  definition: unknown,
  manifest: unknown,
): string | null {
  const def = object(definition) as unknown as PresentationSource;
  const declared = rows(def.surfaces).filter((s) =>
    Object.hasOwn(s, 'presentation'),
  );
  const actual = rows(object(manifest).surfaces).filter((s) =>
    Object.hasOwn(s, 'presentation'),
  );
  if (declared.length !== actual.length)
    return 'The declared presentation and the compiled surfaces disagree.';
  for (const surface of declared) {
    const content = actual.find((a) => a.surfaceId === surface.surfaceId);
    let expected: string;
    try {
      expected = canonicalize(compilePresentation(def, surface));
    } catch (error) {
      return String(error);
    }
    if (!content || canonicalize(content.presentation) !== expected)
      return 'The compiled presentation differs from the approved revision.';
  }
  return null;
}
