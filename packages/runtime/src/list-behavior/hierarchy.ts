import type { ImmutableJsonValue } from '../request-runtime-view.js';
import { assertExactKeys, isRecord, malformed } from './contract.js';

export interface SharedListHierarchy {
  readonly queryId: string;
  readonly relationId: string;
  readonly rootId: string;
  readonly rootFilter: { readonly fieldId: string; readonly value: string };
  readonly rows?: true;
  readonly figures?: readonly {
    readonly figureId: string;
    readonly referenceFieldId: string;
  }[];
}
export interface AuthorizedSharedListHierarchy extends SharedListHierarchy {
  readonly entityId: string;
}
const id =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function parseSharedListHierarchy(
  value: ImmutableJsonValue,
): SharedListHierarchy {
  if (!isRecord(value)) throw malformed('hierarchy must be an object');
  const { rows, figures, ...closed } = value;
  assertExactKeys(closed, ['queryId', 'relationId', 'rootId', 'rootFilter']);
  if (
    typeof value.queryId !== 'string' ||
    !id.test(value.queryId) ||
    typeof value.relationId !== 'string' ||
    !id.test(value.relationId) ||
    typeof value.rootId !== 'string' ||
    !uuid.test(value.rootId)
  )
    throw malformed('hierarchy requires query, relation and root identities');
  const filter = value.rootFilter;
  if (!isRecord(filter))
    throw malformed('hierarchy root filter must be an object');
  assertExactKeys(filter, ['fieldId', 'value']);
  if (
    typeof filter.fieldId !== 'string' ||
    !id.test(filter.fieldId) ||
    typeof filter.value !== 'string' ||
    !filter.value ||
    filter.value.length > 240
  )
    throw malformed('hierarchy requires an exact root filter');
  if (rows !== undefined && rows !== true)
    throw malformed('hierarchy rows must be true');
  if (
    figures !== undefined &&
    (!Array.isArray(figures) || !figures.length || figures.length > 8)
  )
    throw malformed('hierarchy figures must contain one to eight entries');
  const seen = new Set<string>();
  const parsed =
    figures === undefined
      ? undefined
      : (figures as ImmutableJsonValue[]).map((entry) => {
          if (!isRecord(entry))
            throw malformed('hierarchy figure must be an object');
          assertExactKeys(entry, ['figureId', 'referenceFieldId']);
          if (
            typeof entry.figureId !== 'string' ||
            !id.test(entry.figureId) ||
            typeof entry.referenceFieldId !== 'string' ||
            !id.test(entry.referenceFieldId) ||
            seen.has(entry.figureId)
          )
            throw malformed(
              'hierarchy figures require unique canonical identities',
            );
          seen.add(entry.figureId);
          return Object.freeze({
            figureId: entry.figureId,
            referenceFieldId: entry.referenceFieldId,
          });
        });
  if (rows !== true && !parsed)
    throw malformed('hierarchy must narrow rows or figures');
  return Object.freeze({
    queryId: value.queryId,
    relationId: value.relationId,
    rootId: value.rootId,
    rootFilter: Object.freeze({ fieldId: filter.fieldId, value: filter.value }),
    ...(rows ? { rows: true as const } : {}),
    ...(parsed ? { figures: Object.freeze(parsed) } : {}),
  });
}
