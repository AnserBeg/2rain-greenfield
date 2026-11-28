/**
 * The composed application without Books' document-posting operation
 * (DOCUMENT-POSTING slice 1). Its reader tops the operation-catalog ladder,
 * so a test that measures a lower feature's floor on the composed
 * application measures it without the post; the post's own floor is proved
 * in test/compiler/document-posting.test.ts.
 */
export function withoutDocumentPosting<T>(authored: T): T {
  const source = authored as Record<string, unknown>;
  return {
    ...source,
    operations: (source.operations as Record<string, unknown>[]).filter(
      (operation) => !Object.hasOwn(operation, 'documentPosting'),
    ),
  } as T;
}
