import { createHash } from 'node:crypto';

/** ADR-0036: presentation only. Native dialog owns focus containment; forms remain SSR. */
export const SURFACE_CLIENT_SCRIPT = String.raw`(() => {
  const task = document.querySelector('dialog[data-composition-task]');
  const resume = document.querySelector('[data-task-resume]');
  if (!task || !resume || typeof task.showModal !== 'function') return;
  const open = resume.querySelector('[data-task-open]');
  const close = task.querySelector('[data-task-close]');
  const initial = () => task.querySelector('[data-task-initial-focus]') || task.querySelector('input:not([type="hidden"]), select') || task.querySelector('[data-task-heading]');
  const show = () => {
    if (task.open) return;
    task.showModal();
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
  task.addEventListener('close', () => open.focus());
  show();
})();`;

export const SURFACE_CLIENT_CSP_HASH = `sha256-${createHash('sha256').update(SURFACE_CLIENT_SCRIPT).digest('base64')}`;
