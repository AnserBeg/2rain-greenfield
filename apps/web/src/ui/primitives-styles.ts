/**
 * Styles for `primitives.ts`, appended to the one stylesheet SurfaceRuntime
 * emits.
 *
 * Every value is a design token from `design-tokens.ts` (ADR-0035): spacing on
 * the 4 px grid, the shared type scale, role colours. There is no colour
 * literal here and there must not be one — the hex-literal ratchet reads this
 * file. Dark mode therefore needs nothing: the tokens it redefines flow
 * through.
 *
 * The visual language is deliberately plain: one-pixel rules instead of
 * shadows, a flat panel instead of nested cards, weight and size for
 * hierarchy. Density is a feature of an ERP screen, so rows stay at the
 * shared `--row-height` and sections are separated by rules, not by space.
 */
export const PRIMITIVE_STYLES = `
.command-bar{flex-wrap:wrap;align-items:flex-start}
.capability-command{display:grid;gap:var(--space-1);justify-items:start}
.capability-command>button{order:1}
.capability-command>span{order:2;max-width:28ch;color:var(--ink-muted);font-size:var(--text-micro);line-height:1.35}
.action-overflow summary{white-space:nowrap}
.ui-section{padding:0}
.ui-section__header{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:48px;padding:var(--space-2) var(--space-4);border-bottom:1px solid var(--line)}
.ui-section__header h2{margin:0;font-size:var(--text-base);line-height:1.3}
.ui-section__description{margin:2px 0 0;color:var(--ink-muted);font-size:var(--text-body)}
.ui-section__actions{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;justify-content:flex-end}
.ui-section__actions .primary-action,.ui-section__actions .secondary-action{min-height:36px;padding:var(--space-1) var(--space-3)}
.ui-section__body{padding:var(--space-4)}
.ui-section[data-density=flush]>.ui-section__body{padding:0}
.ui-section[data-density=flush] .data-table-wrap{margin-top:0}

.ui-record-heading{align-items:flex-start}
.ui-record-heading .eyebrow{margin-bottom:2px}
.ui-record-heading__subtitle{margin:var(--space-1) 0 0;color:var(--ink-muted);font-size:var(--text-base)}
.ui-record-heading__status{display:flex;flex-wrap:wrap;gap:var(--space-4);justify-content:flex-end}
.ui-labeled-status{display:grid;gap:var(--space-1);justify-items:start}
.ui-labeled-status small{color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.07em;text-transform:uppercase}

.ui-quiet-action{color:var(--accent-ink);font-size:var(--text-body);font-weight:var(--weight-emphasis);text-decoration:none;white-space:nowrap}
.ui-quiet-action:hover{text-decoration:underline}
.ui-quiet-action:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}

.ui-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3) var(--space-5);margin:0}
.ui-facts dt,.ui-metrics dt,.ui-totals dt{color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.07em;text-transform:uppercase}
.ui-facts dd{margin:2px 0 0;font-size:var(--text-base);overflow-wrap:anywhere}
.ui-facts dd small{display:block;color:var(--ink-muted);font-size:var(--text-micro)}

.ui-metrics{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);margin:0;border-bottom:1px solid var(--line)}
.ui-metrics>div{padding:var(--space-3) var(--space-4)}
.ui-metrics>div+div{border-left:1px solid var(--line)}
.ui-metrics dd{margin:var(--space-1) 0 0;font-variant-numeric:tabular-nums}
.ui-metrics__value{color:var(--ink-strong);font-size:var(--text-title);font-weight:var(--weight-emphasis);line-height:1.2}
.ui-metrics__unit{margin-left:var(--space-1);color:var(--ink-muted);font-size:var(--text-body)}
.ui-metrics dd.ui-metrics__caption{margin-top:2px;color:var(--ink-muted);font-size:var(--text-micro)}

.ui-meter{display:inline-block;width:64px;height:6px;overflow:hidden;border-radius:3px;background:var(--surface-sunken);vertical-align:middle}
.ui-meter>span{display:block;height:100%;background:var(--ink-muted)}
.ui-meter[data-status-role=success]>span{background:var(--status-success-ink)}
.ui-meter[data-status-role=attention]>span{background:var(--status-attention-ink)}
.ui-meter[data-status-role=blocked]>span{background:var(--status-blocked-ink)}
.ui-meter[data-status-role=inProgress]>span{background:var(--status-inprogress-ink)}

.ui-table thead th{background:var(--surface-sunken);white-space:nowrap}
.ui-table th:first-child,.ui-table td:first-child{padding-left:var(--space-4)}
.ui-table th:last-child,.ui-table td:last-child{padding-right:var(--space-4)}
.ui-table .ui-cell--end{text-align:right;white-space:nowrap}
.ui-table .record-link,.ui-table time,.ui-table .status-pill,.ui-table small{white-space:nowrap}
.ui-table tbody tr:last-child td{border-bottom:0}
.ui-stack{display:grid;gap:1px;padding:var(--space-1) 0;line-height:1.3}
.ui-stack>*{justify-self:start}
.ui-stack small{color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-body)}
.ui-inline{display:inline-flex;align-items:center;gap:var(--space-2);white-space:nowrap}

.ui-totals{display:grid;gap:var(--space-1);justify-content:end;margin:0;padding:var(--space-3) var(--space-4);border-top:1px solid var(--line)}
.ui-totals>div{display:grid;grid-template-columns:minmax(120px,auto) minmax(140px,auto);gap:var(--space-5);align-items:baseline}
.ui-totals dd{margin:0;text-align:right;font-size:var(--text-base);font-variant-numeric:tabular-nums}
.ui-totals>div[data-emphasis=true]{margin-top:var(--space-1);padding-top:var(--space-2);border-top:1px solid var(--line-strong)}
.ui-totals>div[data-emphasis=true] dd{color:var(--ink-strong);font-size:var(--text-section);font-weight:var(--weight-emphasis)}

.ui-empty{padding:var(--space-8) var(--space-4);text-align:center}
.ui-empty h3{margin:0;font-size:var(--text-base)}
.ui-empty p{max-width:56ch;margin:var(--space-1) auto var(--space-3);color:var(--ink-muted);font-size:var(--text-body)}

.ui-disclosure{border-top:1px solid var(--line)}
.ui-section__body>.ui-disclosure:first-child{border-top:0}
.ui-disclosure>summary{display:flex;align-items:center;gap:var(--space-2);min-height:44px;padding:0 var(--space-4);font-size:var(--text-body);cursor:pointer;list-style:none}
.ui-disclosure>summary::-webkit-details-marker{display:none}
.ui-disclosure>summary::before{content:"›";width:12px;color:var(--ink-muted);font-size:var(--text-section);line-height:1;text-align:center}
.ui-disclosure[open]>summary::before{transform:rotate(90deg)}
.ui-disclosure>summary:hover{background:var(--accent-soft)}
.ui-disclosure>summary:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:-3px}
.ui-disclosure__hint{color:var(--ink-muted);font-weight:var(--weight-body)}
.ui-disclosure__body{padding:var(--space-1) var(--space-4) var(--space-4) calc(var(--space-4) + 20px);font-size:var(--text-body)}
.ui-disclosure__body>p{max-width:80ch;margin:0 0 var(--space-2);line-height:1.55}
.ui-disclosure__body>p:last-child{margin-bottom:0}
.ui-disclosure__body .record-fields{margin:var(--space-2) 0 0}
.ui-prose{white-space:pre-wrap;overflow-wrap:anywhere}

.ui-menu{position:relative}
.ui-menu>summary{display:inline-grid;place-items:center;min-height:36px;padding:var(--space-1) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--accent-ink);font-size:var(--text-body);font-weight:var(--weight-emphasis);cursor:pointer;list-style:none}
.ui-menu>summary::-webkit-details-marker{display:none}
.ui-menu>summary::after{content:"▾";margin-left:var(--space-2);font-size:var(--text-micro)}
.ui-menu>summary{grid-auto-flow:column}
.ui-menu>summary:hover,.ui-menu[open]>summary{background:var(--accent-soft)}
.ui-menu>summary:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.ui-menu__list{position:absolute;z-index:2;top:calc(100% + var(--space-1));right:0;min-width:220px;margin:0;padding:var(--space-1);border:1px solid var(--line);border-radius:var(--radius-container);background:var(--surface-panel);box-shadow:var(--elevation-overlay);list-style:none}
.ui-menu__list a{display:flex;align-items:center;min-height:36px;padding:0 var(--space-3);border-radius:var(--radius-control);color:var(--ink);font-size:var(--text-body);text-decoration:none;white-space:nowrap}
.ui-menu__list a:hover{background:var(--accent-soft)}
.ui-menu__list a:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:-3px}

.ui-steps{display:flex;flex-wrap:wrap;align-items:center;margin:0;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line);font-size:var(--text-body);list-style:none}
.ui-steps li{display:flex;align-items:center;gap:var(--space-2);color:var(--ink-muted);font-weight:var(--weight-emphasis)}
.ui-steps li+li::before{content:"";width:32px;height:1px;margin:0 var(--space-2);background:var(--line-strong)}
.ui-steps__mark{width:10px;height:10px;border:2px solid var(--line-strong);border-radius:50%;background:var(--surface-panel)}
.ui-steps li[data-step-state=done]{color:var(--ink)}
.ui-steps li[data-step-state=done] .ui-steps__mark{border-color:var(--status-success-ink);background:var(--status-success-ink)}
.ui-steps li[data-step-state=current]{color:var(--ink-strong)}
.ui-steps li[data-step-state=current] .ui-steps__mark{border-color:var(--accent);background:var(--accent-selected)}
.ui-steps li[data-step-state=stopped]{color:var(--status-blocked-ink)}
.ui-steps li[data-step-state=stopped] .ui-steps__mark{border-color:var(--status-blocked-ink);background:var(--status-blocked-ink)}

.ui-search{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line)}
.ui-search__field{display:grid;flex:1 1 280px;gap:var(--space-1);max-width:440px}
.ui-search__field span{color:var(--ink-muted);font-size:var(--text-micro);font-weight:var(--weight-emphasis);letter-spacing:.07em;text-transform:uppercase}
.ui-search input{width:100%;min-height:44px;padding:var(--space-2) var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface-panel);color:var(--ink);font:inherit}
.ui-search input:focus-visible{outline:3px solid var(--focus-ring-surface);outline-offset:2px}
.ui-search__trailing{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;min-height:44px;margin-left:auto;color:var(--ink-muted);font-size:var(--text-body)}

.ui-pagination{gap:var(--space-2);margin:0;padding:var(--space-3) var(--space-4);border-top:1px solid var(--line)}

.ui-notice{margin:0;padding:var(--space-2) var(--space-4);border-bottom:1px solid var(--line);font-size:var(--text-body)}
.ui-notice[data-status-role=attention]{background:var(--status-attention-ground);color:var(--status-attention-ink)}
.ui-notice[data-status-role=blocked]{background:var(--status-blocked-ground);color:var(--status-blocked-ink)}
.ui-notice[data-status-role=success]{background:var(--status-success-ground);color:var(--status-success-ink)}
.ui-notice[data-status-role=inProgress]{background:var(--status-inprogress-ground);color:var(--status-inprogress-ink)}

@media(max-width:800px){
.ui-section__header{align-items:flex-start;flex-direction:column;gap:var(--space-2)}
.ui-section__actions{justify-content:flex-start}
.ui-section__actions .primary-action,.ui-section__actions .secondary-action,.ui-menu>summary,.ui-menu__list a{min-height:44px}
.ui-record-heading__status{justify-content:flex-start}
.ui-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.ui-metrics{grid-auto-flow:row;grid-template-columns:repeat(2,minmax(0,1fr))}
.ui-metrics>div{border-top:1px solid var(--line)}
.ui-metrics>div:nth-child(-n+2){border-top:0}
.ui-metrics>div:nth-child(odd){border-left:0}
.ui-table tr[data-compact-card=true] td,.ui-table tr[data-compact-card=true] td.ui-cell--end{min-height:32px;text-align:left;white-space:normal}
.ui-table tr[data-compact-card=true] td>*{justify-self:start}
.ui-table tr[data-compact-card=true]{margin:var(--space-3) var(--space-3)}
.ui-table th:first-child,.ui-table td:first-child,.ui-table th:last-child,.ui-table td:last-child{padding-left:var(--space-2);padding-right:var(--space-2)}
.ui-table tbody tr:last-child td{border-bottom:0}
.ui-totals{justify-content:stretch}
.ui-totals>div{grid-template-columns:1fr auto}
.ui-menu__list{right:auto;left:0}
.ui-steps li+li::before{width:16px}
.ui-search__trailing{margin-left:0}
}
`;
