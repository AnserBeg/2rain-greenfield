import { escapeHtml } from './html.js';
import {
  messageStatusRole,
  surfaceMessage,
  type SurfaceMessageRef,
} from './message-catalog.js';

export {
  messageStatusRole,
  surfaceMessage,
  type SurfaceMessageRef,
} from './message-catalog.js';

/**
 * One authority for the inside of every user-facing message, so the two page
 * renderers and the slot renderer cannot drift into three dialects again. The
 * defect ADR-0048 was ruled on was exactly that: `QUERY_UNSUPPORTED` registered
 * with one sentence in `component-registry.ts` and rendered with another in
 * `surface-runtime.ts`.
 *
 * **The sentence is emitted as a literal from the catalog and never composed.**
 * `data-message-sentence` exists so the gate can read the rendered text and
 * compare it against a string it did not compute — see ADR-0048 §5.
 *
 * A message's one declared subject is rendered in its **own** element rather
 * than interpolated into the sentence. Two reasons, either sufficient: it keeps
 * every catalog sentence a comparable literal, and ADR-0035 §6 reserves
 * monospace for identifiers, codes and hashes, so an identifier inside prose was
 * already the wrong typography.
 */
export function messageBody(
  ref: SurfaceMessageRef,
  eyebrow: string,
  headingTag: 'h1' | 'h2',
): string {
  const message = surfaceMessage(ref.code);
  // Both of these are observed per element by the gate, not merely concatenated
  // here: deleting them from this template used to keep every check green while
  // the user lost every next action and the component identifier.
  const subject =
    ref.subject === undefined
      ? ''
      : `<code data-message-subject>${escapeHtml(ref.subject)}</code>`;
  const nextAction =
    message.nextAction === null
      ? ''
      : `<p data-message-next-action>${escapeHtml(message.nextAction)}</p>`;
  return `<p class="eyebrow">${escapeHtml(eyebrow)}</p><${headingTag} data-message-sentence>${escapeHtml(message.sentence)}</${headingTag}><p data-message-detail>${escapeHtml(message.detail)}</p>${nextAction}${subject}<code data-message-code>${escapeHtml(ref.code)}</code>`;
}

/**
 * The attributes every rendered catalog treatment carries.
 *
 * **`data-message` is the census marker, and it is deliberately not a role.**
 * The first version of the gate sampled `[role="alert"]`, which fixed its census
 * to diagnostics — success confirmations carry `role="status"` and empty states
 * carry neither, so half of ADR-0048's scope could never have been seen. That is
 * the ADR-0035 §2.2 error the ADR itself cites: a completeness claim derived
 * from what the gate happens to look at rather than from the consumers.
 *
 * Every treatment routes through here, so a success confirmation or empty state
 * that uses this helper is *sampled* by the existing gate rather than falling
 * outside its selector. **That is a mechanism, not an observation, and it is not
 * coverage.** Nothing here proves `U6b`'s success and empty renderers emit the
 * right text, or that they route through this helper at all; `U6b` owes
 * real-path observations of those renderers. An earlier version of this comment
 * claimed they were "covered by construction", which was false.
 *
 * `data-status-role` resolves through the pinned roles per ADR-0048 §3, derived
 * from the entry's consequence rather than written at the call site, so a
 * message cannot declare itself advisory and render as blocked.
 */
export function messageAttributes(ref: SurfaceMessageRef): string {
  return `data-message="${escapeHtml(ref.code)}" data-diagnostic-code="${escapeHtml(ref.code)}" data-status-role="${messageStatusRole(ref.code)}"`;
}
