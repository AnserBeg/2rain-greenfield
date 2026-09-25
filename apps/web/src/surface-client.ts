import { createHash } from 'node:crypto';

/**
 * ADR-0036: presentation only. Native dialog owns focus containment; forms remain
 * SSR. The draft-editor block adds keyboard search and selection for reference
 * controls; every action it triggers is an existing server-rendered submit.
 */
export const SURFACE_CLIENT_SCRIPT = String.raw`(() => {
  const task = document.querySelector('dialog[data-composition-task]');
  const resume = document.querySelector('[data-task-resume]');
  if (!task || !resume || typeof task.showModal !== 'function') return;
  const open = resume.querySelector('[data-task-open]');
  const close = task.querySelector('[data-task-close]');
  const initial = () => task.querySelector('[data-task-initial-focus]') || task.querySelector('input:not([type="hidden"]), select') || task.querySelector('[data-task-heading]');
  // A resume control marked closed-only is offered only while the dialog is hidden.
  const closedOnly = resume.hasAttribute('data-task-resume-closed-only');
  const show = () => {
    if (task.open) return;
    task.showModal();
    if (closedOnly) resume.hidden = true;
    initial()?.focus();
  };
  task.removeAttribute('open');
  resume.hidden = false;
  close.hidden = false;
  task.classList.add('task-dialog-enhanced');
  open.addEventListener('click', show);
  close.addEventListener('click', () => task.close());
  task.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...task.querySelectorAll('button:not([disabled]):not([hidden]), a[href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')].filter(control => control.getClientRects().length);
    const index = controls.indexOf(document.activeElement);
    if (controls.length && (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  });
  task.addEventListener('close', () => {
    resume.hidden = false;
    open.focus();
  });
  // A draft-editor create is cancelled on the server, which writes nothing and
  // returns focus to the originating field; Escape takes that same path.
  const create = task.querySelector('[data-editor-create]');
  if (create) task.addEventListener('cancel', (event) => {
    event.preventDefault();
    create.querySelector('button[value="cancel"]')?.click();
  });
  show();
})();
(() => {
  // Draft-editor reference controls: presentation only. Every action is still the
  // server-rendered submit button; this makes Enter search the focused field
  // instead of submitting the order, and lets the keyboard move through results.
  for (const control of document.querySelectorAll('[data-reference-control]')) {
    const input = control.querySelector('[data-reference-search]');
    const submit = control.querySelector('[data-reference-submit]');
    if (!input || !submit) continue;
    const options = () => [...control.querySelectorAll('.reference-option')];
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit.click();
      } else if (event.key === 'ArrowDown' && options().length) {
        event.preventDefault();
        options()[0].focus();
      }
    });
    control.addEventListener('keydown', (event) => {
      const list = options();
      const index = list.indexOf(document.activeElement);
      if (index < 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = list[index + (event.key === 'ArrowDown' ? 1 : -1)];
        (next || (event.key === 'ArrowUp' ? input : list[index])).focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        input.focus();
      }
    });
    for (const button of control.querySelectorAll('button[name="draftAction"]'))
      button.addEventListener('click', () => {
        control.setAttribute('aria-busy', 'true');
        if (button === submit) submit.textContent = 'Searching…';
      });
  }
})();`;

export const SURFACE_CLIENT_CSP_HASH = `sha256-${createHash('sha256').update(SURFACE_CLIENT_SCRIPT).digest('base64')}`;
