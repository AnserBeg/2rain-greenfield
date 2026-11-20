import { createHash } from 'node:crypto';

/**
 * ADR-0036: presentation only. Native dialog owns focus containment; forms remain
 * SSR. The draft-editor block answers reference fields in place with
 * server-rendered fragments (behaviour 7); every request it sends is that
 * field's own server-rendered action, and every answer is server HTML.
 */
export const SURFACE_CLIENT_SCRIPT = String.raw`(() => {
  for (const form of document.querySelectorAll('[data-customize-action]')) {
    const progress = form.querySelector('[role="status"]');
    if (!progress) continue;
    form.addEventListener('submit', () => {
      progress.hidden = false;
      form.querySelector('button').disabled = true;
    });
    window.addEventListener('pageshow', () => {
      progress.hidden = true;
      form.querySelector('button').disabled = false;
    });
  }
})();
(() => {
  const enhanceTask = (root) => {
    const task = root.querySelector('dialog[data-composition-task]');
    const resume = root.querySelector('[data-task-resume]');
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
  };
  enhanceTask(document);
  if (!document.getElementById('record-task-region') || typeof fetch !== 'function' || typeof DOMParser !== 'function' || typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;

  let submitting = false;
  let pageFallback = false;
  let previewTimer;
  let previewGeneration = 0;
  let previewRequest = Promise.resolve();
  const sendTask = async (form, fields) => {
    const body = new URLSearchParams();
    for (const [name, value] of fields) if (typeof value === 'string') body.append(name, value);
    const csrf = document.querySelector('meta[name=erp-csrf]')?.content;
    const response = await fetch(form.action, {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'x-rain-fragment': 'task', ...(csrf ? { 'x-erp-csrf': csrf } : {}) }, body,
    });
    if (response.headers.get('x-rain-fragment') !== 'fragment') throw new Error('Task response unavailable');
    const refresh = response.headers.get('x-rain-fragment-refresh');
    const fallback = response.headers.get('x-rain-fragment-fallback') === 'page';
    const rendered = new DOMParser().parseFromString(await response.text(), 'text/html');
    return { refresh, fallback, rendered };
  };

  const scheduleReview = (form) => {
    if (!form) return;
    clearTimeout(previewTimer);
    const generation = ++previewGeneration;
    const region = form.parentElement.querySelector('[data-task-inline-review]');
    const review = form.querySelector('footer button[value="prepare"]');
    if (!region || !review) return;
    form.querySelector('[data-task-entry-impact]')?.setAttribute('hidden', '');
    region.hidden = true;
    region.replaceChildren();
    review.hidden = false;
    if (!form.checkValidity()) return;
    previewTimer = setTimeout(() => {
      previewRequest = previewRequest.then(async () => {
        if (submitting || generation !== previewGeneration || !form.isConnected) return;
        try {
          const { refresh, rendered } = await sendTask(form, new FormData(form, review));
          if (generation !== previewGeneration || !form.isConnected) return;
          if (refresh) {
            const destination = new URL(refresh, location.href);
            if (destination.origin === location.origin) location.assign(destination.href);
            return;
          }
          const preview = rendered.querySelector('#record-task-region [data-task-prepared]');
          if (preview) {
            const errors = [...form.querySelectorAll('.field-error')];
            const errorIds = new Set(errors.map(error => error.id).filter(Boolean));
            for (const control of form.querySelectorAll('[aria-invalid], [aria-describedby]')) {
              control.removeAttribute('aria-invalid');
              const described = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && !errorIds.has(id));
              if (described.length) control.setAttribute('aria-describedby', described.join(' '));
              else control.removeAttribute('aria-describedby');
            }
            errors.forEach(error => error.remove());
            form.parentElement.querySelector('[data-task-input-error]')?.remove();
            preview.querySelector('[data-task-row-review]')?.setAttribute('hidden', '');
            preview.querySelector('button[value="edit"]')?.setAttribute('hidden', '');
            region.replaceChildren(preview);
            region.hidden = false;
            review.hidden = true;
          }
        } catch {
          // The ordinary Review control still offers this read.
        }
      });
    }, 350);
  };

  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLSelectElement) return;
    scheduleReview(event.target.closest?.('form[data-task-live-review]'));
  });
  document.addEventListener('change', (event) => {
    // Text controls already prepared on input; blur is not another edit.
    if (!(event.target instanceof HTMLSelectElement)) return;
    scheduleReview(event.target.closest?.('form[data-task-live-review]'));
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (pageFallback || !(form instanceof HTMLFormElement) || form.method !== 'post') return;
    const source = new URL(form.action, location.href);
    if (source.origin !== location.origin || source.pathname !== location.pathname) return;
    const fields = new FormData(form, event.submitter);
    if (!fields.has('compositionAction')) return;
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    clearTimeout(previewTimer);
    ++previewGeneration;
    form.setAttribute('aria-busy', 'true');
    // A stage response replaces the form. Hold its controls while it is in
    // flight so a late replacement cannot discard edits made after submit.
    const pendingRoot = form.closest('[data-composition-task]') || form;
    const pendingControls = [...pendingRoot.querySelectorAll('button, input:not([type="hidden"]), select, textarea')].filter(control => !control.disabled);
    const restoreControls = () => pendingControls.forEach(control => { control.disabled = false; });
    pendingControls.forEach(control => { control.disabled = true; });
    const error = document.querySelector('dialog[open] [data-task-transport-error]') || document.querySelector('#record-task-region [data-task-transport-error]');
    if (error) error.hidden = true;
    try {
      await previewRequest;
      const { refresh, fallback, rendered } = await sendTask(form, fields);
      if (refresh) {
        const destination = new URL(refresh, location.href);
        if (destination.origin !== location.origin) throw new Error('Task refresh unavailable');
        location.assign(destination.href);
        return;
      }
      if (fallback) {
        restoreControls();
        pageFallback = true;
        try {
          form.requestSubmit(event.submitter || undefined);
        } finally {
          pageFallback = false;
        }
        return;
      }
      const replacement = rendered.getElementById('surface-content') || rendered.getElementById('record-task-region');
      const original = replacement && document.getElementById(replacement.id);
      if (!original) throw new Error('Task response unavailable');
      const previous = document.querySelector('dialog[data-composition-task]');
      if (previous) {
        previous.close();
        if (!original.contains(previous)) {
          const resume = previous.previousElementSibling;
          if (resume?.hasAttribute('data-task-resume')) resume.remove();
          previous.remove();
        }
      }
      original.replaceWith(replacement);
      const queues = rendered.getElementById('shell-work-queues');
      if (queues) document.getElementById('shell-work-queues')?.replaceWith(queues);
      enhanceTask(replacement);
      (replacement.querySelector('#record-task-region [data-task-result]') || replacement.querySelector('[data-task-recovery]'))?.focus();
      scheduleReview(replacement.querySelector('form[data-task-live-review]'));
    } catch {
      // A missing response cannot say whether a write committed. Keep the
      // task and its server-issued keys and let the person choose to retry.
      if (error) error.hidden = false;
    } finally {
      restoreControls();
      form.removeAttribute('aria-busy');
      submitting = false;
    }
  });
  document.body.setAttribute('data-task-stages-enhanced', '');
  scheduleReview(document.querySelector('form[data-task-live-review]'));
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
      known = { seq: Number(lookupOf(field)?.getAttribute('data-reference-seq') || 0), timer: 0, controller: null, active: -1, term: null, quiet: false, pending: false, enter: 0, deferred: '', mutating: false };
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
  // A request the script cancelled on purpose (a superseded lookup) is dropped;
  // every other failure -- a page answer, a refused redirect, a lost or broken
  // response -- is repeated as the ordinary submit by whoever still owns it.
  const fallbackError = () => {
    const error = new Error('fallback');
    error.fallback = true;
    return error;
  };
  // Header values priced lines read, as the page shows them now: the server
  // answers by the page when one moved since it last saw it.
  const lineSources = () => Object.fromEntries([...document.querySelectorAll('[data-line-source]')].map((control) => [control.name, control.value]));
  const post = async (body, signal) => {
    try {
      const csrf = document.querySelector('meta[name=erp-csrf]')?.content;
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal, headers: { ...(csrf ? { 'x-erp-csrf': csrf } : {}), 'x-rain-fragment': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
      if (response.headers.get('x-rain-fragment-fallback') === 'page' || response.headers.get('x-rain-fragment') !== 'fragment') throw fallbackError();
      return { status: response.status, html: await response.text() };
    } catch (error) {
      if (error && (error.fallback || error.name === 'AbortError')) throw error;
      throw fallbackError();
    }
  };
  // Only bound targets: the requesting field, its lookup region, the same-row
  // dependents the server declared for it, and the create slot.
  const allowedFor = (field) => {
    const control = field.id.replace(/-field$/, '');
    return new Set([field.id, control + '-lookup', 'editor-create-slot', ...(field.getAttribute('data-reference-dependents') || '').split(' ').filter(Boolean)]);
  };
  const apply = (html, allowed) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const template of doc.querySelectorAll('template[data-fragment-target]')) {
      const id = template.getAttribute('data-fragment-target') || '';
      const next = template.content.firstElementChild;
      const target = document.getElementById(id);
      if (!target || !next || next.id !== id || !allowed.has(id)) continue;
      target.replaceWith(document.importNode(next, true));
    }
    const live = doc.querySelector('template[data-fragment-live]');
    if (live) say(live.innerHTML);
  };
  // Leaving the page cancels outstanding requests; that is not a failure to
  // repeat as a submit.
  let leaving = false;
  window.addEventListener('beforeunload', () => {
    leaving = true;
  });
  window.addEventListener('pageshow', () => {
    leaving = false;
  });
  const fallback = (control) => {
    if (leaving || native) return;
    native = true;
    form.requestSubmit(control);
  };
  const lookup = (field, verb) => {
    const input = inputOf(field);
    const button = field.querySelector(verb === 'more' ? '[data-reference-more]' : '[data-reference-submit]');
    if (!input || !button) return;
    const known = state(field);
    if (known.mutating) return;
    clearTimeout(known.timer);
    known.timer = 0;
    known.controller?.abort();
    known.controller = new AbortController();
    const seq = ++known.seq;
    const term = input.value === input.getAttribute('data-selected-label') ? '' : input.value;
    const allowed = allowedFor(field);
    known.pending = true;
    field.setAttribute('aria-busy', 'true');
    post({ draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: button.value, draftLookupSeq: String(seq), [input.name]: term }, known.controller.signal)
      .then(({ html }) => {
        // A newer request owns the field; an older answer is dropped unseen.
        if (seq !== known.seq || !html) return;
        known.pending = false;
        apply(html, allowed);
        known.term = term;
        prepare(field);
        if (field.contains(document.activeElement)) {
          setOpen(field, true);
          // A typed term highlights its best match, so Enter takes it; the
          // initial options on focus wait for an arrow key.
          const first = optionsOf(field)[0];
          highlight(field, verb === 'more' ? known.active : term && first && !first.hasAttribute('data-reference-create') && !first.hasAttribute('data-reference-more') ? 0 : -1);
          // Enter pressed before this answer arrived takes its best match; a
          // result chosen from an older answer is taken only if still offered.
          const option = optionsOf(field)[known.active];
          const deferred = known.deferred && optionsOf(field).find((candidate) => candidate.value === known.deferred);
          known.deferred = '';
          if (deferred) choose(field, deferred);
          else if (known.enter === seq && option && !option.hasAttribute('data-reference-create') && !option.hasAttribute('data-reference-more')) choose(field, option);
        }
      })
      .catch((error) => {
        if (error.fallback && seq === known.seq) fallback(button);
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
  // A field changes one thing at a time: while a selection, clear or create is
  // answering, further clicks and lookups on it wait. Each request takes the
  // field's next number, and only the newest request's answer is applied, so a
  // delayed answer can never replace a newer selection.
  const choose = (field, option) => {
    const known = state(field);
    if (known.mutating) return;
    if (option.hasAttribute('data-reference-more')) return lookup(field, 'more');
    if (option.hasAttribute('data-reference-create')) return openCreate(field, option);
    const id = field.id;
    // A newer search is still answering: choose once it has, from what it offers.
    if (known.pending || known.timer) {
      known.deferred = option.value;
      if (known.timer) {
        clearTimeout(known.timer);
        known.timer = 0;
        lookup(field, 'search');
      }
      return;
    }
    const mine = ++known.seq;
    known.controller?.abort();
    known.pending = false;
    known.enter = 0;
    known.mutating = true;
    const allowed = allowedFor(field);
    const input = inputOf(field);
    if (input) input.readOnly = true;
    field.setAttribute('aria-busy', 'true');
    inflight++;
    post({ ...lineSources(), draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: option.value, draftLookupSeq: lookupOf(field)?.getAttribute('data-reference-seq') || '', draftFieldGeneration: field.getAttribute('data-reference-generation') || '' })
      .then(({ html }) => {
        if (mine !== known.seq) return;
        apply(html, allowed);
        known.term = null;
        refocus(id);
      })
      .catch((error) => {
        if (error.fallback && mine === known.seq) fallback(option);
      })
      .finally(() => {
        known.mutating = false;
        if (input) input.readOnly = false;
        field.removeAttribute('aria-busy');
        inflight--;
      });
  };
  const clear = (field, button) => {
    const id = field.id;
    const known = state(field);
    if (known.mutating) return;
    const mine = ++known.seq;
    known.controller?.abort();
    known.pending = false;
    known.mutating = true;
    const allowed = allowedFor(field);
    const input = inputOf(field);
    if (input) input.readOnly = true;
    field.setAttribute('aria-busy', 'true');
    inflight++;
    post({ ...lineSources(), draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: button.value, draftFieldGeneration: field.getAttribute('data-reference-generation') || '' })
      .then(({ html }) => {
        if (mine !== known.seq) return;
        apply(html, allowed);
        refocus(id);
      })
      .catch((error) => {
        if (error.fallback && mine === known.seq) fallback(button);
      })
      .finally(() => {
        known.mutating = false;
        if (input) input.readOnly = false;
        field.removeAttribute('aria-busy');
        inflight--;
      });
  };
  // The create flow opens as a modal over the live order and returns to the
  // same field. Cancel (and Escape) is a server submit that reports anything
  // already created; the order itself is never re-rendered.
  const openCreate = (field, option) => {
    const known = state(field);
    if (known.mutating) return;
    const input = inputOf(field);
    const term = input && input.value !== input.getAttribute('data-selected-label') ? input.value : '';
    const mine = ++known.seq;
    known.controller?.abort();
    known.pending = false;
    known.mutating = true;
    const allowed = allowedFor(field);
    setOpen(field, false);
    field.setAttribute('aria-busy', 'true');
    inflight++;
    post({ ...lineSources(), draftSession: valueOf('draftSession'), draftVersion: valueOf('draftVersion'), draftAction: option.value, draftFieldGeneration: field.getAttribute('data-reference-generation') || '', [input?.name || '']: term })
      .then(({ html }) => {
        if (mine !== known.seq) return;
        apply(html, allowed);
        showCreate(field.id, allowed);
      })
      .catch((error) => {
        if (error.fallback && mine === known.seq) fallback(option);
      })
      .finally(() => {
        known.mutating = false;
        field.removeAttribute('aria-busy');
        inflight--;
      });
  };
  const showCreate = (fieldId, allowed) => {
    const dialog = document.querySelector('#editor-create-slot dialog[data-editor-create-fragment]');
    if (!dialog || typeof dialog.showModal !== 'function') {
      refocus(fieldId);
      return;
    }
    dialog.removeAttribute('open');
    dialog.showModal();
    // The marked field (first problem, else first field) wins; only without one
    // does focus fall to the first control.
    (dialog.querySelector('[data-task-initial-focus]') || dialog.querySelector('input:not([type="hidden"]):not([disabled]), select, textarea, button'))?.focus();
    const createForm = dialog.querySelector('form');
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      const cancel = createForm?.querySelector('button[value="cancel"]');
      if (cancel) submitCreate(createForm, cancel, fieldId, allowed);
    });
    createForm?.addEventListener('submit', (event) => {
      if (native) return;
      event.preventDefault();
      submitCreate(createForm, event.submitter, fieldId, allowed);
    });
  };
  const submitCreate = (createForm, submitter, fieldId, allowed) => {
    if (createForm.hasAttribute('aria-busy')) return;
    createForm.setAttribute('aria-busy', 'true');
    const body = new URLSearchParams(new FormData(createForm));
    for (const [name, value] of Object.entries(lineSources())) body.set(name, value);
    if (submitter?.name) body.set(submitter.name, submitter.value);
    inflight++;
    post(Object.fromEntries(body), undefined)
      .then(({ html }) => {
        apply(html, allowed);
        showCreate(fieldId, allowed);
      })
      .catch((error) => {
        createForm.removeAttribute('aria-busy');
        if (error.fallback && !leaving && !native) {
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
})();
(() => {
  for (const panel of document.querySelectorAll('[data-documents]')) {
    const status = panel.querySelector('[data-documents-status]');
    const requestURL = (mode) => {
      const url = new URL(panel.dataset.documents, window.location.origin);
      url.searchParams.set('mode', mode);
      return url;
    };
    const refresh = async () => {
      const response = await fetch(requestURL('list'), { cache: 'no-store' });
      if (!response.ok) throw new Error('Files are unavailable for this record.');
      const records = await response.json();
      for (const field of panel.querySelectorAll('[data-document-field]')) {
        const list = field.querySelector('[data-document-rows]');
        list.replaceChildren();
        const files = records.filter((record) => (record.fieldId || '') === field.dataset.documentField);
        for (const file of files) {
          const item = document.createElement('li');
          item.textContent = file.fileName + ' ';
          for (const mode of ['preview', 'download']) {
            const url = requestURL(mode);
            url.searchParams.set('link', file.linkId);
            url.searchParams.set('version', file.versionId);
            const link = document.createElement('a');
            link.href = url.href;
            link.textContent = mode === 'preview' ? 'Preview' : 'Download';
            link.setAttribute('aria-label', link.textContent + ' ' + file.fileName);
            if (mode === 'preview') {
              link.target = '_blank';
              link.rel = 'noopener';
            }
            item.append(link, ' ');
          }
          list.append(item);
        }
        if (!files.length) {
          const item = document.createElement('li');
          item.textContent = 'No files yet';
          list.append(item);
        }
      }
    };
    const showError = (error) => { status.textContent = error.message || 'Files are unavailable.'; };
    panel.addEventListener('toggle', () => {
      if (panel.open) void refresh().catch(showError);
    });
    for (const form of panel.querySelectorAll('[data-document-upload]')) {
      let retryKey = null;
      const input = form.elements.namedItem('file');
      const photo = form.elements.namedItem('photo');
      const category = form.elements.namedItem('category');
      const camera = form.querySelector('[data-document-camera]');
      const canCapture = 'capture' in photo && window.matchMedia('(pointer: coarse)').matches;
      const refreshCamera = () => {
        camera.hidden = !canCapture || (category && category.selectedOptions[0]?.dataset.image !== 'true');
        if (camera.hidden) photo.value = '';
      };
      refreshCamera();
      form.addEventListener('change', (event) => {
        retryKey = null;
        if (event.target === photo) input.value = '';
        if (event.target === input) photo.value = '';
        refreshCamera();
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = input.files[0] || photo.files[0];
        if (!file) {
          status.textContent = 'Choose a file to attach.';
          return;
        }
        const url = requestURL('upload');
        retryKey ??= window.crypto.randomUUID();
        url.searchParams.set('retryKey', retryKey);
        url.searchParams.set('fileName', file.name);
        if (form.dataset.field) url.searchParams.set('field', form.dataset.field);
        if (category?.value) url.searchParams.set('category', category.value);
        const button = form.querySelector('button');
        button.disabled = true;
        status.textContent = '';
        try {
          const csrf = document.querySelector('meta[name=erp-csrf]')?.content;
          const response = await fetch(url, { method: 'POST', headers: csrf ? { 'x-erp-csrf': csrf } : {}, body: file });
          if (!response.ok) {
            const refusal = await response.json();
            throw new Error(refusal.message);
          }
          form.reset();
          refreshCamera();
          retryKey = null;
          await refresh();
          status.textContent = 'File attached.';
        } catch (error) {
          showError(error);
        } finally {
          button.disabled = false;
        }
      });
    }
  }
})();`;

export const SURFACE_CLIENT_CSP_HASH = `sha256-${createHash('sha256').update(SURFACE_CLIENT_SCRIPT).digest('base64')}`;
