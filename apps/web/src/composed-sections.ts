import type { LayoutBody } from '@north-star/canonical-model';

/** Each caller supplies HTML from its original bound control or governed read. */
export function renderLayoutSection(
  section: LayoutBody['sections'][number],
  fieldHtml: (
    field: LayoutBody['sections'][number]['fields'][number],
  ) => string | undefined,
  escape: (value: string) => string,
  mode: 'form' | 'detail',
): string {
  const wrap = (html: string) =>
    mode === 'form'
      ? `<div class="form-fields">${html}</div>`
      : `<dl class="record-fields">${html}</dl>`;
  const shown: string[] = [],
    more: string[] = [],
    names: string[] = [];
  for (const field of section.fields) {
    const html = fieldHtml(field);
    if (!html) continue;
    if (field.tier === 'progressive') {
      more.push(html);
      names.push(escape(field.label.text));
    } else shown.push(html);
  }
  const content =
    wrap(shown.join('')) +
    (more.length
      ? `<details class="draft-more"${more.some((s) => s.includes('aria-invalid="true"')) ? ' open' : ''}><summary>More details <span class="draft-more__names">${names.join(', ')}</span></summary>${wrap(more.join(''))}</details>`
      : '');
  const id = escape(section.id),
    label = escape(section.label.text);
  return mode === 'form'
    ? `<fieldset class="form-field--wide" data-layout-section="${id}"><legend>${label}</legend>${content}</fieldset>`
    : `<section class="panel" data-composition-fields data-layout-section="${id}"><h2>${label}</h2>${content}</section>`;
}
