import { layoutDigest } from '@north-star/canonical-model';
import { layoutCommand, type LayoutTarget } from '@north-star/customization';
import { escapeHtml as h } from './html.js';

export function layoutPicker(targets: readonly LayoutTarget[]) {
  if (!targets.length) return '';
  return `<form method="get"><input type="hidden" name="customize" value=""><fieldset><legend>Arrange a form or record page</legend><label>Page <select name="layout">${targets.map((t) => `<option value="${h(t.body.surfaceId + '/' + t.body.mode)}">${h(t.label)} · ${t.body.mode}</option>`).join('')}</select></label> <button>Choose page</button></fieldset></form>`;
}
export function layoutEditor(target: LayoutTarget) {
  const { body } = target;
  const input = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${h(value)}">`;
  const start =
    '<form method="post">' +
    input('action', 'draft') +
    input('kind', 'addLayoutRevision') +
    input('layout', body.surfaceId + '/' + body.mode) +
    input('source', layoutDigest(target.body)) +
    input('predecessor', target.predecessor ?? '');
  const moveControls = (
    id: string,
    label: string,
    siblings: string[],
    field: boolean,
    rename: boolean,
  ) => {
    const i = siblings.indexOf(id);
    return (
      start +
      input('member', id) +
      `<fieldset><legend>${h(label)}</legend>${rename ? `<label>New label <input name="label" maxlength="240" value="${h(label)}"></label> <button name="edit" value="rename">Rename</button>` : ''}
    ${i > 0 ? '<button name="edit" value="up">Move up</button>' : ''}
    ${i + 1 < siblings.length ? '<button name="edit" value="down">Move down</button>' : ''}
    ${
      field && body.sections.length > 1
        ? `<label>Destination <select name="destination">${body.sections
            .filter((s) => !s.fields.some((f) => f.id === id))
            .map(
              (s) => `<option value="${h(s.id)}">${h(s.label.text)}</option>`,
            )
            .join(
              '',
            )}</select></label> <button name="edit" value="move">Move field</button>`
        : ''
    }</fieldset></form>`
    );
  };
  return (
    `<h1>Arrange ${h(target.label)} · ${h(body.mode)}</h1>${start}<label>Section name <input name="label" required maxlength="240"></label> <button name="edit" value="create">Draft new section</button></form>` +
    body.order
      .map((id) => {
        const section = body.sections.find((s) => s.id === id);
        if (!section)
          return moveControls(
            id,
            body.blocks.find((b) => b.id === id)!.label.text,
            body.order,
            false,
            false,
          );
        return `<section><h2>${h(section.label.text)}</h2>${moveControls(id, section.label.text, body.order, false, true)}${section.fields
          .map((f) =>
            moveControls(
              f.id,
              f.label.text,
              section.fields.map((entry) => entry.id),
              true,
              true,
            ),
          )
          .join('')}</section>`;
      })
      .join('')
  );
}
export function layoutSubmission(
  targets: readonly LayoutTarget[],
  form: Readonly<Record<string, string>>,
) {
  const target = targets.find(
    (t) => t.body.surfaceId + '/' + t.body.mode === form.layout,
  );
  if (
    !target ||
    layoutDigest(target.body) !== form.source ||
    (target.predecessor ?? '') !== form.predecessor
  )
    throw new Error(
      'The page has changed. Open its current layout and draft again.',
    );
  return layoutCommand(target, {
    action: form.edit ?? '',
    member: form.member,
    destination: form.destination,
    label: form.label,
  });
}
