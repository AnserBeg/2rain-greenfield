import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PopupRevisionSchema,
  resolvePopup,
  type PopupOption,
} from '../../canonical-model/src/popup-actions.js';

export const popupOptionId = (o: PopupOption) =>
  [
    o.surface,
    o.target.kind === 'update' ? o.target.operationId : o.target.taskId,
  ].join('/');
const entry = z.strictObject({
  binding: z.string(),
  source: z.literal('entry'),
});
const selection = z.discriminatedUnion('source', [
  entry,
  entry.extend({ source: z.literal('constant'), value: z.string() }),
  entry.extend({ source: z.literal('record'), fieldId: z.string() }),
]);
const command = z.strictObject({
  option: z.string(),
  label: z.string(),
  inputs: z.array(selection).max(12),
  actionId: z.string().optional(),
  predecessor: z.string().optional(),
  retire: z.boolean().optional(),
  contract: z.string().optional(),
});
export function popupCommand(options: readonly PopupOption[], input: unknown) {
  const c = command.parse(input);
  const o = options.find((o) => popupOptionId(o) === c.option);
  if (!o || (c.contract && c.contract !== o.target.contractVersion))
    throw new Error('The action contract changed. Reopen the button editor.');
  const prior = o.existing.find((r) => r.actionId === c.actionId);
  if (
    (c.actionId && !prior) ||
    (prior?.revisionId ?? '') !== (c.predecessor ?? '')
  )
    throw new Error('The button has changed. Reopen the button editor.');
  const schemaVersion = 'v6' as const;
  const revisionId = randomUUID();
  if (c.retire && prior)
    return {
      ...prior,
      kind: 'addPopupActionRevision' as const,
      revisionId,
      predecessor: prior.revisionId,
      status: 'retired' as const,
    };
  const revision = PopupRevisionSchema.parse({
    schemaVersion,
    actionId:
      prior?.actionId ??
      o.surface.split(':')[0] + ':action.custom_' + randomUUID(),
    revisionId,
    predecessor: prior?.revisionId ?? null,
    status: 'active',
    surface: o.surface,
    slot: o.slot,
    label: { schemaVersion, text: c.label },
    target: o.target,
    inputs: c.inputs.map((i) => {
      const f = o.fields.find((f) => f.id === i.binding);
      if (!f) throw new Error('Choose an available Task input.');
      const source =
        i.source === 'entry'
          ? { kind: 'userEntry', schemaVersion }
          : i.source === 'constant'
            ? { kind: 'constant', schemaVersion, type: 'text', value: i.value }
            : {
                kind: 'recordField',
                schemaVersion,
                fieldId: i.fieldId,
                contractVersion: o.sources.find((s) => s.id === i.fieldId)
                  ?.contractVersion,
              };
      return {
        schemaVersion,
        binding: f.id,
        contractVersion: f.contractVersion,
        source,
      };
    }),
  });
  resolvePopup([o], revision);
  return { ...revision, kind: 'addPopupActionRevision' as const };
}
