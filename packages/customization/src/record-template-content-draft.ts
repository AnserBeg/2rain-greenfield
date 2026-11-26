import { z } from 'zod';
import type { RecordTemplateBinding } from '@north-star/canonical-model';
import { RecordTemplateContentSchema } from '../../canonical-model/src/record-template-content.js';
import type { DraftingModel } from './ai-draft.js';

export async function draftRecordTemplateContent(
  model: DraftingModel,
  binding: RecordTemplateBinding,
  request: string,
) {
  if (!request.trim() || request.length > 4000)
    throw new Error('Describe the template in 1 to 4000 characters.');
  const name = 'draft_record_template_content';
  const result = await model.next({
    system:
      'Draft ordered reusable template content. Use the selected field IDs and their contracts. Leave answers empty. Use no source record IDs. A person edits the proposal before publication.\n' +
      JSON.stringify(binding.body.columns),
    conversation: [{ role: 'user', text: request }],
    tools: [
      {
        name,
        description:
          'Propose an editable template for the selected collection.',
        inputSchema: z.toJSONSchema(RecordTemplateContentSchema),
      },
    ],
  });
  const call = result.toolCalls[0];
  if (result.toolCalls.length !== 1 || call?.name !== name)
    throw new Error('A structured template draft is required.');
  const content = RecordTemplateContentSchema.parse(call.input);
  if (
    content.members.some((m) => m.source) ||
    content.columns.some(
      (c) => !binding.body.columns.some((f) => f.fieldId === c.fieldId),
    )
  )
    throw new Error('The draft must use fields from this collection.');
  return content;
}
