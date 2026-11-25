import {
  canonicalize,
  RECORD_TEMPLATE_READER,
} from '@north-star/canonical-model';

function bindings(value: unknown) {
  const model = value as {
    surfaces?: { surfaceId: string; recordTemplateBinding?: unknown }[];
  } | null;
  return (model?.surfaces ?? [])
    .filter((s) => s.recordTemplateBinding !== undefined)
    .map((s) => [s.surfaceId, s.recordTemplateBinding] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
export function recordTemplateDeclarationProblem(
  definition: unknown,
  manifest: unknown,
  floor: number,
) {
  const declared = bindings(definition);
  if (
    declared.length
      ? floor < RECORD_TEMPLATE_READER
      : floor === RECORD_TEMPLATE_READER
  )
    return 'The record template declaration and its reader floor disagree.';
  if (canonicalize(declared) !== canonicalize(bindings(manifest)))
    return 'The record template binding differs from the verified definition.';
  return null;
}
