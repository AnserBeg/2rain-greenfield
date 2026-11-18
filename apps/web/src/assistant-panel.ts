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
  const key = 'northstar-assistant-conversation';
  let conversation = sessionStorage.getItem(key) || null;
  let running = null;
  let pending = null;
  let started = 0;
  let ticking = null;

  const setOpen = (open) => {
    root.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    sessionStorage.setItem(key + '-open', open ? '1' : '0');
    if (open) input.focus();
  };
  toggle.addEventListener('click', () => setOpen(root.hidden));
  root.querySelector('[data-assistant-close]').addEventListener('click', () => setOpen(false));
  if (sessionStorage.getItem(key + '-open') === '1') setOpen(true);

  const post = (action, body, signal) => fetch('/?assistant=' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-northstar-assistant': '1' },
    body: JSON.stringify(body),
    signal,
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
    if (on) {
      started = performance.now();
      ticking = setInterval(() => {
        timer.textContent = ((performance.now() - started) / 1000).toFixed(0) + ' s';
      }, 250);
    } else if (ticking) {
      clearInterval(ticking);
      ticking = null;
    }
  };

  const decide = async (approve) => {
    if (!pending) return;
    const { planId, digest, card } = pending;
    pending = null;
    card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    await post('decide', { conversation, planId, digest, approve });
  };

  const planCard = (event) => {
    const card = element('section', null, 'assistant-plan');
    card.setAttribute('data-assistant-plan', event.planId);
    card.appendChild(element('p', 'This needs your yes before it runs:', 'assistant-heading'));
    (event.reasons || []).forEach((reason) => card.appendChild(element('p', 'Because ' + reason + '.', 'assistant-muted')));
    const list = card.appendChild(element('ol'));
    event.steps.forEach((step) => {
      const item = list.appendChild(element('li', step.text));
      if (step.inputs) item.appendChild(element('div', step.inputs, 'assistant-muted'));
    });
    const yes = card.appendChild(element('button', 'Yes, do it'));
    yes.type = 'button';
    yes.setAttribute('data-assistant-yes', '');
    const no = card.appendChild(element('button', 'No'));
    no.type = 'button';
    no.setAttribute('data-assistant-no', '');
    yes.addEventListener('click', () => decide(true));
    no.addEventListener('click', () => decide(false));
    pending = { planId: event.planId, digest: event.digest, card };
    form.querySelector('button[type=submit]').disabled = false;
    log.appendChild(card);
    scroll();
  };

  const ask = async (text) => {
    const mine = log.appendChild(element('div', text, 'assistant-me'));
    mine.setAttribute('data-assistant-said', '');
    const reply = log.appendChild(element('div', null, 'assistant-reply'));
    reply.setAttribute('data-assistant-reply', '');
    let streamed = '';
    scroll();
    const controller = new AbortController();
    running = controller;
    busy(true);
    label.textContent = 'Starting';
    try {
      const params = new URLSearchParams(location.search);
      const response = await post('ask', {
        conversation,
        text,
        screen: params.get('surface') ? { surfaceId: params.get('surface'), recordId: params.get('record') } : null,
      }, controller.signal);
      if (!response.ok || !response.body) throw new Error('The assistant did not answer (' + response.status + ').');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (event.type === 'conversation') {
            conversation = event.id;
            sessionStorage.setItem(key, conversation);
          } else if (event.type === 'step') {
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
            if (card) card.appendChild(element('p', event.approved ? 'You said yes.' : 'Not done.', 'assistant-muted'));
          } else if (event.type === 'answer') {
            render(reply, event.text);
            reply.setAttribute('data-assistant-stop-reason', event.stop);
            if (event.links && event.links.length) {
              const links = reply.appendChild(element('p', null, 'assistant-links'));
              event.links.forEach((link) => {
                const anchor = links.appendChild(element('a', (link.wrote ? 'Changed: ' : '') + link.label));
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
            if (event.did) {
              const did = reply.appendChild(element('p', 'Did: ' + event.did.summary + ' ', 'assistant-did'));
              did.setAttribute('data-assistant-did', event.did.changeId);
              const undo = did.appendChild(element('button', 'Undo'));
              undo.type = 'button';
              undo.setAttribute('data-assistant-undo', '');
              undo.addEventListener('click', async () => {
                undo.disabled = true;
                const answer = await post('undo', { conversation, changeId: event.did.changeId });
                const result = await answer.json().catch(() => ({ text: 'Undo failed.' }));
                did.appendChild(element('span', ' ' + result.text, result.outcome === 'undone' ? 'assistant-muted' : 'assistant-error'));
                if (result.outcome !== 'undone') undo.disabled = false;
              });
            }
            reply.appendChild(element('p', 'USD ' + Number(event.spentUsd).toFixed(2) + ' used in this conversation', 'assistant-muted'));
          } else if (event.type === 'error') {
            reply.appendChild(element('p', event.message, 'assistant-error'));
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) reply.appendChild(element('p', String(error && error.message || error), 'assistant-error'));
      else reply.appendChild(element('p', 'Stopped.', 'assistant-muted'));
    } finally {
      running = null;
      pending = null;
      busy(false);
      scroll();
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (pending) {
      // A typed answer to the plan on screen: yes runs exactly that plan.
      log.appendChild(element('div', text, 'assistant-me'));
      decide(/^(y|yes|yeah|yep|ok|okay|go|do it|confirm)\b/i.test(text));
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
    if (running) {
      post('stop', { conversation });
      running.abort();
    }
  });
  fresh.addEventListener('click', () => {
    if (running) return;
    conversation = null;
    sessionStorage.removeItem(key);
    log.textContent = '';
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
@media (max-width:800px){.assistant-panel{width:100vw;border-left:0}.assistant-panel button,.assistant-panel form button[type=submit]{height:44px;min-height:44px;padding:0 14px}.assistant-toggle--inline{height:36px}}
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

const PANEL_MARKUP = `<aside id="assistant-panel" class="assistant-panel" data-assistant-panel aria-label="Assistant" hidden><header><h2>Assistant</h2><button type="button" data-assistant-new>New conversation</button><button type="button" data-assistant-close aria-label="Close the assistant">Close</button></header><div class="assistant-log" data-assistant-log aria-live="polite"></div><div class="assistant-status" data-assistant-status role="status" hidden><span data-assistant-step>Working</span><span data-assistant-elapsed>0 s</span><button type="button" data-assistant-stop hidden>Stop</button></div><form data-assistant-form><label class="visually-hidden" for="assistant-input">Ask the assistant</label><textarea id="assistant-input" name="text" rows="2" placeholder="Ask or tell the assistant…"></textarea><button type="submit">Send</button></form></aside>`;

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
    ? result.html.replace(SHELL_ACCOUNT, `${TOGGLE('inline')}${SHELL_ACCOUNT}`)
    : result.html;
  const index = html.lastIndexOf('</body>');
  return {
    ...result,
    html: `${html.slice(0, index)}<link rel="stylesheet" href="${ASSISTANT_PANEL_STYLESHEET_HREF}">${inShell ? '' : TOGGLE('floating')}${PANEL_MARKUP}<script data-assistant-script>${ASSISTANT_PANEL_SCRIPT}</script>${html.slice(index)}`,
  };
}
