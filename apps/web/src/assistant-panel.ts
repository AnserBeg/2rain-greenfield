/**
 * The assistant panel (AGENT-3 slice 2): one chat panel on every app page,
 * docked right on desktop and a full-height sheet on narrow screens
 * (ux-grammar decision log). It sits outside SurfaceRuntime under a ratified
 * seam exception, local demo only; it renders no surface and reads no
 * business data itself. Everything it shows comes from the assistant
 * endpoint (`apps/api/src/assistant-endpoint.ts`), which acts as the person.
 *
 * Its script is static text pinned by hash in the page's CSP, like the
 * surface client. It writes model text with `textContent` only (a small
 * Markdown subset: paragraphs, bold, bullets and pipe tables), so nothing the
 * model or a record says becomes markup.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { registerStaticAsset } from './surface-assets.js';

/** The transport seam the app server mounts: `/?assistant=...` requests. */
export interface AssistantMount {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean>;
}

/**
 * The only typed answers that approve a plan on screen: a whole, plain yes,
 * with trailing punctuation at most. "Okay, don't ship it" is not one.
 */
export const ASSISTANT_AFFIRMATIVE =
  /^(?:y|yes|yeah|yep|ok|okay|sure|go|go ahead|do it|confirm|approve|yes please|yes,? do it)[.!\s]*$/iu;

export const ASSISTANT_PANEL_SCRIPT = String.raw`(() => {
  const root = document.querySelector('[data-assistant-panel]');
  if (!root) return;
  const toggle = document.querySelector('[data-assistant-toggle]');
  const log = root.querySelector('[data-assistant-log]');
  const form = root.querySelector('form[data-assistant-form]');
  const input = form.querySelector('textarea');
  const status = root.querySelector('[data-assistant-status]');
  const label = root.querySelector('[data-assistant-step]');
  const timer = root.querySelector('[data-assistant-elapsed]');
  const stop = root.querySelector('[data-assistant-stop]');
  const fresh = root.querySelector('[data-assistant-new]');
  const spend = root.querySelector('[data-assistant-spend]');
  // What the conversation has spent, in the panel's foot, once it is not zero.
  const showSpend = (usd) => {
    const amount = Number(usd) || 0;
    spend.hidden = amount <= 0;
    spend.textContent = amount <= 0 ? '' : amount < 0.01 ? 'This conversation has used less than USD 0.01.' : 'This conversation has used USD ' + amount.toFixed(2) + '.';
  };
  const key = 'northstar-assistant-conversation';
  const read = (suffix) => {
    try { return sessionStorage.getItem(key + suffix); } catch { return null; }
  };
  const remember = (suffix, value) => {
    try {
      if (value === null) sessionStorage.removeItem(key + suffix);
      else sessionStorage.setItem(key + suffix, value);
    } catch { /* Storage may be unavailable in this tab. */ }
  };
  let conversation = read('');
  let running = false;
  let pending = null;
  let started = 0;
  let ticking = null;

  const handle = root.querySelector('[role=separator]');
  let preferred = Number(read('-width')) || 420;
  const size = () => {
    const max = Math.max(320, Math.floor(document.documentElement.clientWidth / 2));
    const width = Math.round(Math.min(max, Math.max(320, preferred)));
    document.documentElement.style.setProperty('--assistant-width', width + 'px');
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width));
    return width;
  };
  const resize = (requested) => {
    preferred = requested;
    preferred = size();
    remember('-width', String(preferred));
  };
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    resize(size() + (event.key === 'ArrowLeft' ? 16 : -16));
  });
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    handle.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, width: size() };
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag && handle.hasPointerCapture(event.pointerId)) resize(drag.width + drag.x - event.clientX);
  });
  handle.addEventListener('lostpointercapture', () => { drag = null; });
  window.addEventListener('resize', size);
  size();

  const setOpen = (open, focus = false) => {
    root.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    remember('-open', open ? '1' : '0');
    if (focus) (open ? input : toggle).focus();
  };
  toggle.addEventListener('click', () => setOpen(root.hidden, true));
  root.querySelector('[data-assistant-close]').addEventListener('click', () => setOpen(false, true));
  setOpen(read('-open') === '1');

  const post = (action, body) => fetch('/?assistant=' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-northstar-assistant': '1' },
    body: JSON.stringify({ ...body, page: location.search }),
    keepalive: action === 'ask',
  });
  const element = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  // Bold runs inside one line, as text nodes only.
  const inline = (parent, text) => {
    const parts = text.split('**');
    parts.forEach((part, index) => {
      if (!part) return;
      parent.appendChild(index % 2 === 1 ? element('strong', part) : document.createTextNode(part));
    });
  };
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const render = (target, text) => {
    target.textContent = '';
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] || '')) {
        const table = element('table');
        const head = element('tr');
        cells(line).forEach((cell) => { const th = element('th'); inline(th, cell); head.appendChild(th); });
        table.appendChild(element('thead')).appendChild(head);
        const body = table.appendChild(element('tbody'));
        index += 2;
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
          const row = element('tr');
          cells(lines[index]).forEach((cell) => { const td = element('td'); inline(td, cell); row.appendChild(td); });
          body.appendChild(row);
          index += 1;
        }
        index -= 1;
        target.appendChild(table);
      } else if (/^\s*[-*] /.test(line)) {
        let list = target.lastChild;
        if (!list || list.tagName !== 'UL') list = target.appendChild(element('ul'));
        const item = element('li');
        inline(item, line.replace(/^\s*[-*] /, ''));
        list.appendChild(item);
      } else if (/^#+ /.test(line)) {
        const heading = element('p', null, 'assistant-heading');
        inline(heading, line.replace(/^#+ /, ''));
        target.appendChild(heading);
      } else if (line.trim()) {
        const paragraph = element('p');
        inline(paragraph, line);
        target.appendChild(paragraph);
      }
    }
  };

  const busy = (on) => {
    status.hidden = !on;
    stop.hidden = !on;
    form.querySelector('button[type=submit]').disabled = on && !pending;
    if (on && !ticking) {
      timer.textContent = '0 s';
      started = performance.now();
      ticking = setInterval(() => {
        timer.textContent = ((performance.now() - started) / 1000).toFixed(0) + ' s';
      }, 250);
    } else if (!on && ticking) {
      clearInterval(ticking);
      ticking = null;
    }
  };

  // A card settles once: its buttons go dead and never speak for another plan.
  const settle = (card) => {
    card.setAttribute('data-assistant-settled', '');
    card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  };
  // Each card answers only for its own conversation, plan and digest.
  const decideCard = async (card, own, approve, typed) => {
    if (card.hasAttribute('data-assistant-settled')) return;
    settle(card);
    if (pending && pending.card === card) pending = null;
    await post('decide', { conversation: own.conversation, planId: own.planId, digest: own.digest, approve, typed });
  };
  const decide = (approve, typed) => pending ? decideCard(pending.card, pending.own, approve, typed) : undefined;
  const affirmative = new RegExp(${JSON.stringify(ASSISTANT_AFFIRMATIVE.source)}, 'iu');
  let queued = null;

  const planCard = (event) => {
    const card = element('section', null, 'assistant-plan');
    card.setAttribute('data-assistant-plan', event.planId);
    card.appendChild(element('p', 'This needs your yes before it runs:', 'assistant-heading'));
    if (event.company) card.appendChild(element('p', 'In ' + event.company + '.', 'assistant-muted'));
    (event.reasons || []).forEach((reason) => card.appendChild(element('p', reason, 'assistant-muted')));
    const list = card.appendChild(element('ol'));
    event.steps.forEach((step) => {
      const item = list.appendChild(element('li', step.text));
      if (step.target) item.appendChild(element('div', 'On: ' + step.target, 'assistant-muted'));
      if (step.inputs) item.appendChild(element('div', step.inputs, 'assistant-muted'));
    });
    const yes = card.appendChild(element('button', 'Yes, do it'));
    yes.type = 'button';
    yes.setAttribute('data-assistant-yes', '');
    const no = card.appendChild(element('button', 'No'));
    no.type = 'button';
    no.setAttribute('data-assistant-no', '');
    const own = { conversation, planId: event.planId, digest: event.digest };
    yes.addEventListener('click', () => decideCard(card, own, true));
    no.addEventListener('click', () => decideCard(card, own, false));
    pending = { own, card };
    form.querySelector('button[type=submit]').disabled = false;
    log.appendChild(card);
    scroll();
  };

  // "Did: ..." with Undo for the conversation's latest change. Shown after
  // an answer, and again after a Stop or a page load (from ?assistant=latest).
  const showDid = (container, change) => {
    if (log.querySelector('[data-assistant-did="' + change.changeId + '"]')) return;
    log.querySelectorAll('[data-assistant-undo]').forEach((button) => { button.disabled = true; });
    const did = container.appendChild(element('p', 'Did: ' + change.summary + '. ', 'assistant-did'));
    did.setAttribute('data-assistant-did', change.changeId);
    if (change.href) {
      const open = did.appendChild(element('a', 'Open'));
      open.href = change.href;
      did.appendChild(document.createTextNode(' '));
    }
    const undo = did.appendChild(element('button', 'Undo'));
    undo.type = 'button';
    undo.setAttribute('data-assistant-undo', '');
    const owner = conversation;
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      const answer = await post('undo', { conversation: owner, changeId: change.changeId });
      const result = await answer.json().catch(() => ({ text: 'Undo failed.' }));
      did.appendChild(element('span', ' ' + result.text, result.outcome === 'undone' ? 'assistant-muted' : 'assistant-error'));
      if (result.outcome !== 'undone') undo.disabled = false;
    });
    scroll();
  };
  let reply;
  let streamed = '';
  let generation = 0;
  const beginReply = (text) => {
    const mine = log.appendChild(element('div', text, 'assistant-me'));
    mine.setAttribute('data-assistant-said', '');
    reply = log.appendChild(element('div', null, 'assistant-reply'));
    reply.setAttribute('data-assistant-reply', '');
    streamed = '';
    scroll();
  };
  const display = (event) => {
    if (event.type === 'said') { beginReply(event.text); return; }
    if (event.type === 'confirmation') { log.appendChild(element('div', event.text, 'assistant-me')); return; }
    if (event.type === 'undo') {
      const did = log.querySelector('[data-assistant-did="' + event.changeId + '"]');
      if (did) did.appendChild(element('span', ' ' + event.text, 'assistant-muted'));
      return;
    }
    if (event.type === 'step') {
      label.textContent = event.label;
    } else if (event.type === 'delta') {
      streamed += event.text;
      render(reply, streamed);
      scroll();
    } else if (event.type === 'text') {
      streamed += '\n';
    } else if (event.type === 'plan') {
      planCard(event);
    } else if (event.type === 'decided') {
      const card = log.querySelector('[data-assistant-plan="' + event.planId + '"]');
      if (card) {
        settle(card);
        if (pending?.card === card) pending = null;
        card.appendChild(element('p', event.approved ? 'You said yes.' : 'Not done.', 'assistant-muted'));
      }
    } else if (event.type === 'answer') {
      render(reply, event.text);
      reply.setAttribute('data-assistant-stop-reason', event.stop);
      // Records the answer names; what this turn changed is on the Did row.
      const named = (event.links || []).filter((link) => !link.wrote);
      if (named.length) {
        const links = reply.appendChild(element('p', null, 'assistant-links'));
        named.forEach((link) => {
          const anchor = links.appendChild(element('a', link.label));
          anchor.href = link.href;
        });
      }
      if (event.draft) {
        const draft = reply.appendChild(element('section', null, 'assistant-plan'));
        draft.setAttribute('data-assistant-draft', '');
        draft.appendChild(element('pre', event.draft.diff, 'assistant-diff'));
        const open = draft.appendChild(element('a', 'Review it on the Customize screen'));
        open.href = '/?customize';
      }
      if (event.did) showDid(reply, event.did);
      showSpend(event.spentUsd);
    } else if (event.type === 'error') {
      reply.appendChild(element('p', event.message, 'assistant-error'));
      if (event.did) showDid(reply, event.did);
    }
  };

  const finish = () => {
    pending = null;
    running = false;
    log.querySelectorAll('[data-assistant-plan]:not([data-assistant-settled])').forEach(settle);
    busy(false);
    scroll();
    if (queued) {
      const next = queued;
      queued = null;
      ask(next);
    }
  };
  // Only a reconnected page polls. Apply the suffix after its last rendered
  // event so a live plan retains its keyboard focus while waiting for a yes.
  const restore = async (owner, version, after = 0, missing = 0) => {
    if (generation !== version) return;
    running = true;
    busy(true);
    try {
      const response = await post('history', { conversation: owner, after });
      if (version !== generation) return;
      if (response.status === 204 || response.status === 409) {
        // Navigation can overtake creation of a just-submitted conversation.
        if (response.status === 204 && missing < 4) {
          setTimeout(() => restore(owner, version, after, missing + 1), 500);
          return;
        }
        conversation = null;
        remember('', null);
        finish();
        return;
      }
      if (!response.ok) throw new Error('Could not reconnect.');
      const state = await response.json();
      if (version !== generation) return;
      state.transcript.forEach(display);
      if (pending && (!state.pending || pending.own.digest !== state.pending.digest)) {
        settle(pending.card);
        pending = null;
      }
      if (state.did && !state.running) showDid(log, state.did);
      log.querySelectorAll('[data-assistant-did]').forEach((row) => {
        row.querySelector('button').disabled = state.running || row.dataset.assistantDid !== state.did?.changeId;
      });
      if (!state.running) { finish(); return; }
      label.textContent = state.step;
      after += state.transcript.length;
    } catch {
      if (version !== generation) return;
      label.textContent = 'Reconnecting';
    }
    setTimeout(() => restore(owner, version, after), 600);
  };

  const ask = async (text) => {
    const version = ++generation;
    const startId = conversation ? undefined : crypto.randomUUID();
    if (startId) {
      conversation = startId;
      remember('', startId);
    }
    beginReply(text);
    running = true;
    busy(true);
    label.textContent = 'Starting';
    try {
      const params = new URLSearchParams(location.search);
      const response = await post('ask', {
        conversation, startId, text,
        screen: params.get('surface') ? { surfaceId: params.get('surface'), recordId: params.get('record') } : null,
      });
      if (!response.ok || !response.body) throw new Error('The assistant did not answer (' + response.status + ').');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (version !== generation) { await reader.cancel(); return; }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (event.type === 'conversation') {
            if (event.id !== conversation) {
              log.replaceChildren();
              beginReply(text);
            }
            conversation = event.id;
            remember('', conversation);
          } else display(event);
        }
      }
    } catch (error) {
      if (version !== generation) return;
      reply.appendChild(element('p', String(error && error.message || error), 'assistant-error'));
    }
    finish();
  };
  if (conversation) restore(conversation, generation);
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    generation += 1;
    queued = null;
    finish();
    log.replaceChildren();
    showSpend(0);
    setOpen(read('-open') === '1');
    preferred = Number(read('-width')) || 420;
    size();
    conversation = read('');
    if (conversation) restore(conversation, generation);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (pending) {
      // Only a whole, plain yes approves the plan on screen. Anything else
      // ("okay, don't ship it", "yes but 5") declines it and is sent to the
      // assistant as the next request once this run ends.
      if (affirmative.test(text)) {
        log.appendChild(element('div', text, 'assistant-me'));
        decide(true, text);
      } else {
        queued = text;
        decide(false);
      }
      return;
    }
    if (running) return;
    ask(text);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  stop.addEventListener('click', () => {
    if (running) post('stop', { conversation });
  });
  fresh.addEventListener('click', () => {
    generation += 1;
    conversation = null;
    remember('', null);
    queued = null;
    finish();
    log.textContent = '';
    showSpend(0);
  });
})();`;

export const ASSISTANT_PANEL_CSP_HASH = `sha256-${createHash('sha256').update(ASSISTANT_PANEL_SCRIPT).digest('base64')}`;

// The panel in the Ledger look (LOOK-1 follow-up): the same tokens, type
// and buttons as the pages beside it, light and dark; a full-height sheet at
// phone width. Markup and behaviour are AGENT-3's, unchanged.
const PANEL_STYLES = `
.assistant-toggle{display:inline-flex;align-items:center;gap:6px;height:32px;min-height:32px;padding:0 12px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font:500 13px/1 var(--f-ui);cursor:pointer}
.assistant-toggle:hover{background:var(--sunk)}
.assistant-toggle[aria-expanded=true]{border-color:var(--accent);color:var(--accent-text)}
.assistant-toggle--inline{margin-left:auto}
.assistant-toggle--inline+.shell-account{margin-left:0}
.assistant-toggle--floating{position:fixed;right:16px;bottom:16px;z-index:40;height:44px;min-height:44px;border-color:var(--accent);background:var(--accent);color:var(--paper);box-shadow:var(--shadow-dlg)}
.assistant-panel{position:fixed;top:0;right:0;bottom:0;z-index:70;width:min(420px,100vw);display:flex;flex-direction:column;border-left:1px solid var(--rule);background:var(--sheet);color:var(--ink);box-shadow:var(--shadow-dlg);font:400 13px/1.45 var(--f-ui)}
.assistant-panel[hidden]{display:none}
.assistant-panel .visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.assistant-panel header{display:flex;align-items:center;gap:8px;min-height:48px;padding:8px 16px;border-bottom:1px solid var(--rule)}
.assistant-panel header h2{flex:1;margin:0;color:var(--ink);font-size:14px;font-weight:600}
.assistant-panel button{display:inline-flex;align-items:center;justify-content:center;height:30px;min-height:30px;padding:0 10px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font:500 12px/1 var(--f-ui);cursor:pointer}
.assistant-panel button:hover{background:var(--sunk)}
.assistant-log{flex:1;display:flex;flex-direction:column;gap:12px;overflow:auto;padding:14px 16px;background:var(--paper)}
.assistant-me{align-self:flex-end;max-width:85%;padding:8px 12px;border-radius:6px;background:var(--accent-soft);color:var(--ink);white-space:pre-wrap}
.assistant-reply{max-width:100%;color:var(--ink-2)}
.assistant-reply p{margin:0 0 6px}
.assistant-reply ul{margin:0 0 6px;padding-left:18px}
.assistant-reply table{width:100%;margin:6px 0;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.assistant-reply th{padding:5px 6px;border-bottom:1px solid var(--rule);color:var(--muted);font-size:11px;font-weight:500;text-align:left}
.assistant-reply td{padding:5px 6px;border-bottom:1px solid var(--rule);color:var(--ink);text-align:left}
.assistant-heading{margin:0 0 6px;color:var(--ink);font-weight:600}
.assistant-muted{color:var(--muted);font-size:12px}
.assistant-error{color:var(--status-blocked-ink)}
.assistant-links{display:flex;flex-wrap:wrap;gap:6px 10px}
.assistant-links a,.assistant-plan a{color:var(--accent-text);font-family:var(--f-mono);font-size:12px;text-decoration:none}
.assistant-links a:hover,.assistant-plan a:hover{text-decoration:underline}
.assistant-diff{margin:0 0 8px;padding:8px 10px;border-radius:4px;background:var(--sunk);color:var(--ink);font:400 12px/1.5 var(--f-mono);white-space:pre-wrap}
.assistant-did{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:6px 0 0;padding:8px 10px;border-radius:4px;background:var(--status-success-ground);color:var(--status-success-ink)}
.assistant-plan{margin:6px 0 0;padding:10px 12px;border:1px solid var(--rule-2);border-radius:6px;background:var(--sheet)}
.assistant-plan ol,.assistant-plan ul{margin:0 0 8px;padding-left:18px}
.assistant-plan button{margin:4px 8px 0 0}
.assistant-plan button:first-of-type{border-color:var(--accent);background:var(--accent);color:var(--paper)}
.assistant-status{display:flex;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid var(--rule);background:var(--status-inprogress-ground);color:var(--status-inprogress-ink);font-size:12px}
.assistant-status[hidden]{display:none}
.assistant-status [data-assistant-elapsed]{margin-left:auto;font-family:var(--f-mono)}
.assistant-panel form{display:flex;align-items:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--rule);background:var(--sheet)}
.assistant-panel textarea{flex:1;min-height:44px;padding:8px 10px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font:inherit;resize:vertical}
.assistant-panel form button[type=submit]{height:36px;border-color:var(--accent);background:var(--accent);color:var(--paper)}

.assistant-resize{display:none}
.assistant-panel textarea{min-width:0}
.assistant-log{overflow-wrap:anywhere}
@media (min-width:960px){
  body:has(.assistant-panel:not([hidden])){--dock-width:clamp(320px,var(--assistant-width,420px),50vw)}
  .ledger-viewport{container:ledger / inline-size;margin-right:var(--dock-width,0px)}
  .ledger-viewport .topbar{margin-right:calc(-1 * var(--dock-width,0px));position:sticky;top:0;z-index:58}
  body:has(.assistant-panel:not([hidden])) .topbar{height:48px;flex-wrap:nowrap}
  body:has(.assistant-panel:not([hidden])) .shell-search{order:0;flex:0 1 340px}
  body.standalone:has(.assistant-panel:not([hidden])){padding-right:var(--dock-width)}
  .assistant-panel{width:var(--dock-width);box-shadow:none}
  .ledger-viewport~.assistant-panel{top:48px}
  .assistant-resize{display:block;position:absolute;left:-5px;top:0;bottom:0;width:10px;cursor:col-resize;touch-action:none;user-select:none}
  .assistant-resize::after{content:"";position:absolute;inset:0 auto 0 4px;width:1px;background:var(--rule)}
  .assistant-resize:is(:hover,:focus-visible)::after{width:3px;background:var(--accent)}
}
@media (max-width:800px){.assistant-panel{width:100%;border-left:0}.assistant-panel button,.assistant-panel form button[type=submit]{height:44px;min-height:44px;padding:0 14px}.assistant-toggle--inline{height:36px}}
`;

/** The panel's styles, served from a content-hash route (`style-src 'self'`). */
export const ASSISTANT_PANEL_STYLESHEET_HREF = registerStaticAsset(
  'assistant-panel',
  'css',
  'text/css; charset=utf-8',
  Buffer.from(PANEL_STYLES, 'utf8'),
  true,
);

const TOGGLE = (placement: 'inline' | 'floating') =>
  `<button type="button" class="assistant-toggle assistant-toggle--${placement}" data-assistant-toggle aria-expanded="false" aria-controls="assistant-panel">Assistant</button>`;

/** Where the shell's top bar puts its account menu: the toggle sits before it. */
const SHELL_ACCOUNT = '<details class="shell-account">';

const PANEL_MARKUP = `<aside id="assistant-panel" class="assistant-panel" data-assistant-panel aria-label="Assistant" hidden><div class="assistant-resize" role="separator" tabindex="0" aria-label="Resize assistant" aria-orientation="vertical" aria-controls="assistant-panel" aria-valuemin="320" aria-valuenow="420"></div><header><h2>Assistant</h2><button type="button" data-assistant-new>New conversation</button><button type="button" data-assistant-close aria-label="Close the assistant">Close</button></header><div class="assistant-log" data-assistant-log aria-live="polite"></div><div class="assistant-status" data-assistant-status role="status" hidden><span data-assistant-step>Working</span><span data-assistant-elapsed>0 s</span><button type="button" data-assistant-stop hidden>Stop</button></div><form data-assistant-form><label class="visually-hidden" for="assistant-input">Ask the assistant</label><textarea id="assistant-input" name="text" rows="2" placeholder="Ask or tell the assistant…"></textarea><button type="submit">Send</button></form><p class="assistant-muted" data-assistant-spend hidden></p></aside>`;

/**
 * The page with the panel added before `</body>`. Only a full page served
 * with 200 gets it; fragments, downloads, redirects and diagnostics do not.
 */
export function withAssistantPanel<
  T extends { statusCode: number; html: string; download?: unknown },
>(result: T): T {
  if (
    result.statusCode !== 200 ||
    result.download !== undefined ||
    !result.html.includes('</body>') ||
    result.html.includes('data-assistant-panel')
  )
    return result;
  // In the shell the toggle is a top-bar button, so it never floats over a
  // page's own controls (a sticky Save bar); a page without the shell gets a
  // floating one.
  const inShell = result.html.includes(SHELL_ACCOUNT);
  const html = inShell
    ? result.html
        .replace(
          '<div class="app-shell"',
          '<div class="ledger-viewport"><div class="app-shell"',
        )
        .replace(SHELL_ACCOUNT, `${TOGGLE('inline')}${SHELL_ACCOUNT}`)
    : result.html;
  const index = html.lastIndexOf('</body>');
  return {
    ...result,
    html: `${html.slice(0, index)}${inShell && html.includes('<div class="ledger-viewport">') ? '</div>' : ''}<link rel="stylesheet" href="${ASSISTANT_PANEL_STYLESHEET_HREF}">${inShell ? '' : TOGGLE('floating')}${PANEL_MARKUP}<script data-assistant-script>${ASSISTANT_PANEL_SCRIPT}</script>${html.slice(index)}`,
  };
}
