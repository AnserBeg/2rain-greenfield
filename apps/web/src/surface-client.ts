import { createHash } from 'node:crypto';

/**
 * ADR-0036: presentation only. Native dialog owns focus containment; forms remain
 * SSR. The draft-editor block answers reference fields in place with
 * server-rendered fragments (behaviour 7); every request it sends is that
 * field's own server-rendered action, and every answer is server HTML.
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
  // ADR-0036 behaviour 7: draft-editor reference fields answered in place.
  // Each request is the field's own server-rendered action sent as a same-origin
  // fragment POST; each answer is escaped server HTML naming the one element it
  // replaces -- this field's lookup region, this field, a dependent in the same
  // row, or the create slot. The script decides nothing: it keeps focus, the
  // highlighted option and which request is newest. Anything the server does
  // not answer in place is repeated as the ordinary submit.
  const form = document.getElementById('draft-editor-form');
  if (!form || !document.querySelector('[data-reference-field]') || typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
  const endpoint = form.getAttribute('action');
  const valueOf = (name) => form.querySelector('input[name="' + name + '"]')?.value ?? '';
  const states = new Map();
  let inflight = 0;
  let native = false;
  document.body.setAttribute('data-reference-enhanced', '');
  const fieldOf = (node) => node instanceof Element ? node.closest('[data-reference-field]') : null;
  const inputOf = (field) => field.querySelector('[data-reference-search]');
  const lookupOf = (field) => field.querySelector('[data-reference-lookup]');
  const optionsOf = (field) => [...field.querySelectorAll('[data-reference-popup] [role="option"]')];
  const state = (field) => {
    let known = states.get(field.id);
    if (!known) {
      known = { seq: Number(lookupOf(field)?.getAttribute('data-reference-seq') || 0), timer: 0, controller: null, active: -1, term: null, quiet: false, pending: false, enter: 0 };
      states.set(field.id, known);
    }
    return known;
  };
  const prepare = (field) => {
    for (const option of optionsOf(field)) option.tabIndex = -1;
  };
  const setOpen = (field, open) => {
    const input = inputOf(field);
    field.toggleAttribute('data-reference-open', open);
    input?.setAttribute('aria-expanded', open && field.querySelector('[data-reference-popup]') ? 'true' : 'false');
    if (!open) highlight(field, -1);
  };
  const highlight = (field, index) => {
    const options = optionsOf(field);
    const known = state(field);
    known.active = options.length && index >= 0 ? index % options.length : -1;
    options.forEach((option, position) => option.setAttribute('aria-selected', position === known.active ? 'true' : 'false'));
    const input = inputOf(field);
    if (known.active < 0) input?.removeAttribute('aria-activedescendant');
    else {
      input?.setAttribute('aria-activedescendant', options[known.active].id);
      options[known.active].scrollIntoView({ block: 'nearest' });
    }
  };
  const restore = (field) => {
    const input = inputOf(field);
    const label = input?.getAttribute('data-selected-label');
    if (input && label !== null && input.value !== label) input.value = label;
  };
  const say = (html) => {
    const region = document.getElementById('draft-editor-live');
    if (!region) return;
    const doc = new DOMParser().parseFromString('<template>' + html + '</template>', 'text/html');
    region.replaceChildren(document.importNode(doc.querySelector('template').content, true));
  };
  const post = async (body, signal) => {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal, headers: { 'x-rain-fragment': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    if (response.headers.get('x-rain-fragment-fallback') === 'page' || response.headers.get('x-rain-fragment') !== 'fragment') {
      const error = new Error('fallback');
      error.fallback = true;
      throw error;
    }
    return { status: response.status, html: await response.text() };
  };
  // Only bound targets: controls of the row the request named, or the create slot.
  const apply = (html, row) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const template of doc.querySelectorAll('template[data-fragment-target]')) {
      const id = template.getAttribute('data-fragment-target') || '';
      const next = template.content.firstElementChild;
      const target = document.getElementById(id);
      if (!target || !next || next.id !== id || (id !== 'editor-create-slot' && !id.startsWith('editor-' + row + '-'))) continue;
      target.replaceWith(document.importNode(next, true));
    }
    const live = doc.querySelector('template[data-fragment-live]');
    if (live) say(live.innerHTML);
  };
  const fallback = (control) => {
    native = true;
    form.requestSubmit(control);
  };
  const lookup = (field, verb) => {
    const input = inputOf(field);
    const button = field.querySelector(verb === 'more' ? '[data-reference-more]' : '[data-reference-submit]');
    if (!input || !button) return;
    const known = state(field);
    clearTimeout(known.timer);
    known.controller?.abort();
    known.controller = new AbortController();
    const seq = ++known.seq;
    const term = input.value === input.getAttribute('data-selected-label') ? '' : input.value;
    const row = field.getAttribute('data-reference-row');
    known.pending = true;
    field.setAttribute('aria-busy', 'true');
    post({ draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: button.value, draftLookupSeq: String(seq), [input.name]: term }, known.controller.signal)
      .then(({ html }) => {
        // A newer request owns the field; an older answer is dropped unseen.
        if (seq !== known.seq || !html) return;
        apply(html, row);
        known.term = term;
        prepare(field);
        if (field.contains(document.activeElement)) {
          setOpen(field, true);
          // A typed term highlights its best match, so Enter takes it; the
          // initial options on focus wait for an arrow key.
          const first = optionsOf(field)[0];
          highlight(field, verb === 'more' ? known.active : term && first && !first.hasAttribute('data-reference-create') && !first.hasAttribute('data-reference-more') ? 0 : -1);
          // Enter pressed before this answer arrived takes its best match.
          const option = optionsOf(field)[known.active];
          if (known.enter === seq && option && !option.hasAttribute('data-reference-create') && !option.hasAttribute('data-reference-more')) choose(field, option);
        }
      })
      .catch((error) => {
        if (error.fallback) fallback(button);
      })
      .finally(() => {
        if (seq === known.seq) {
          known.pending = false;
          field.removeAttribute('aria-busy');
        }
      });
  };
  const refocus = (id) => {
    const field = document.getElementById(id);
    if (!field) return;
    prepare(field);
    state(field).quiet = true;
    inputOf(field)?.focus();
    state(field).quiet = false;
  };
  const choose = (field, option) => {
    if (option.hasAttribute('data-reference-more')) return lookup(field, 'more');
    if (option.hasAttribute('data-reference-create')) return openCreate(field, option);
    const id = field.id;
    const known = state(field);
    known.seq++;
    known.controller?.abort();
    known.pending = false;
    known.enter = 0;
    const row = field.getAttribute('data-reference-row');
    const input = inputOf(field);
    if (input) input.readOnly = true;
    field.setAttribute('aria-busy', 'true');
    inflight++;
    post({ draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: option.value, draftLookupSeq: lookupOf(field)?.getAttribute('data-reference-seq') || '', draftFieldGeneration: field.getAttribute('data-reference-generation') || '' })
      .then(({ html }) => {
        apply(html, row);
        known.term = null;
        refocus(id);
      })
      .catch((error) => {
        if (error.fallback) fallback(option);
        else {
          if (input) input.readOnly = false;
          field.removeAttribute('aria-busy');
        }
      })
      .finally(() => inflight--);
  };
  const clear = (field, button) => {
    const id = field.id;
    const row = field.getAttribute('data-reference-row');
    const known = state(field);
    known.seq++;
    known.controller?.abort();
    known.pending = false;
    inflight++;
    post({ draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: button.value, draftFieldGeneration: field.getAttribute('data-reference-generation') || '' })
      .then(({ html }) => {
        apply(html, row);
        refocus(id);
      })
      .catch((error) => {
        if (error.fallback) fallback(button);
      })
      .finally(() => inflight--);
  };
  // The create flow opens as a modal over the live order and returns to the
  // same field. Cancel (and Escape) is a server submit that reports anything
  // already created; the order itself is never re-rendered.
  const openCreate = (field, option) => {
    const input = inputOf(field);
    const row = field.getAttribute('data-reference-row');
    const term = input && input.value !== input.getAttribute('data-selected-label') ? input.value : '';
    setOpen(field, false);
    inflight++;
    post({ draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: option.value, [input?.name || '']: term })
      .then(({ html }) => {
        apply(html, row);
        showCreate(field.id, row);
      })
      .catch((error) => {
        if (error.fallback) fallback(option);
      })
      .finally(() => inflight--);
  };
  const showCreate = (fieldId, row) => {
    const dialog = document.querySelector('#editor-create-slot dialog[data-editor-create-fragment]');
    if (!dialog || typeof dialog.showModal !== 'function') {
      refocus(fieldId);
      return;
    }
    dialog.removeAttribute('open');
    dialog.showModal();
    dialog.querySelector('[data-task-initial-focus], input:not([type="hidden"]):not([disabled]), select, textarea, button')?.focus();
    const createForm = dialog.querySelector('form');
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      const cancel = createForm?.querySelector('button[value="cancel"]');
      if (cancel) submitCreate(createForm, cancel, fieldId, row);
    });
    createForm?.addEventListener('submit', (event) => {
      if (native) return;
      event.preventDefault();
      submitCreate(createForm, event.submitter, fieldId, row);
    });
  };
  const submitCreate = (createForm, submitter, fieldId, row) => {
    if (createForm.hasAttribute('aria-busy')) return;
    createForm.setAttribute('aria-busy', 'true');
    const body = new URLSearchParams(new FormData(createForm));
    if (submitter?.name) body.set(submitter.name, submitter.value);
    inflight++;
    post(Object.fromEntries(body), undefined)
      .then(({ html }) => {
        apply(html, row);
        showCreate(fieldId, row);
      })
      .catch((error) => {
        createForm.removeAttribute('aria-busy');
        if (error.fallback) {
          native = true;
          createForm.requestSubmit(submitter);
        }
      })
      .finally(() => inflight--);
  };
  for (const field of document.querySelectorAll('[data-reference-field]')) {
    prepare(field);
    if (field.contains(document.activeElement) && lookupOf(field)?.getAttribute('data-reference-shown') === 'true') setOpen(field, true);
  }
  document.addEventListener('focusin', (event) => {
    const field = fieldOf(event.target);
    if (!field || event.target !== inputOf(field) || state(field).quiet) return;
    const input = inputOf(field);
    const term = input.value === input.getAttribute('data-selected-label') ? '' : input.value;
    if (state(field).term === term && field.querySelector('[data-reference-popup], .reference-status p')) setOpen(field, true);
    else lookup(field, 'search');
  });
  document.addEventListener('focusout', (event) => {
    const field = fieldOf(event.target);
    if (!field) return;
    setTimeout(() => {
      if (field.isConnected && !field.contains(document.activeElement)) {
        setOpen(field, false);
        restore(field);
      }
    }, 0);
  });
  document.addEventListener('input', (event) => {
    const field = fieldOf(event.target);
    if (!field || event.target !== inputOf(field)) return;
    const known = state(field);
    clearTimeout(known.timer);
    known.timer = setTimeout(() => {
      known.timer = 0;
      lookup(field, 'search');
    }, 150);
  });
  document.addEventListener('keydown', (event) => {
    const field = fieldOf(event.target);
    if (!field || event.target !== inputOf(field)) return;
    const known = state(field);
    const open = field.hasAttribute('data-reference-open');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return lookup(field, 'search');
      const count = optionsOf(field).length;
      highlight(field, known.active < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1) : known.active + (event.key === 'ArrowDown' ? 1 : count - 1));
    } else if (event.key === 'Enter') {
      // Enter chooses in the popup; it never submits the order. While the
      // answer to what was typed is still coming, it waits for that answer.
      event.preventDefault();
      if (known.timer) {
        clearTimeout(known.timer);
        known.timer = 0;
        lookup(field, 'search');
      }
      const option = optionsOf(field)[known.active];
      if (known.pending) known.enter = known.seq;
      else if (open && option) choose(field, option);
      else if (!open) lookup(field, 'search');
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(field, false);
      restore(field);
    } else if (event.key === 'Tab') {
      setOpen(field, false);
    }
  });
  document.addEventListener('mousedown', (event) => {
    // Keep focus in the box while an option is pressed.
    if (event.target instanceof Element && event.target.closest('[data-reference-popup]')) event.preventDefault();
  });
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const field = fieldOf(target);
    if (!field || native) return;
    const option = target.closest('[data-reference-popup] [role="option"]');
    const clearButton = target.closest('[data-reference-clear]');
    if (option) {
      event.preventDefault();
      choose(field, option);
    } else if (clearButton) {
      event.preventDefault();
      clear(field, clearButton);
    }
  });
  // The order is not submitted while a field is being changed in place.
  form.addEventListener('submit', (event) => {
    if (native || !inflight) return;
    event.preventDefault();
    say('<p class="draft-note">Wait for the field to finish updating, then try again.</p>');
  });
})();`;

export const SURFACE_CLIENT_CSP_HASH = `sha256-${createHash('sha256').update(SURFACE_CLIENT_SCRIPT).digest('base64')}`;
