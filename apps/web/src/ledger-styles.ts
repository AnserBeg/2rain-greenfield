/**
 * The Ledger stylesheet (LOOK-1; owner ruling 2026-11-17;
 * `docs/design/ledger-spec.md`). Every rule reads the tokens in
 * `design-tokens.ts`; no colour literal appears here (the hex ratchet observes
 * that). Pale paper, hairline-ruled sheets, one deep teal accent for the one
 * thing you can do next, status colours as their own family.
 *
 * Kept from the previous sheet, deliberately: every functional rule a gate or a
 * behaviour leans on -- the compact projection at 800px and below, the native
 * dialog's modal and page fallbacks, the reference popup's enhanced states,
 * the bulk bar's `:has()` toggles, print, reduced motion and the 44px touch
 * floor on phone-width targets.
 */
export const LEDGER_STYLES = `
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{font-size:16px;-webkit-text-size-adjust:100%}
body{margin:0;min-width:320px;background:var(--paper);color:var(--ink);font:400 13px/1.45 var(--f-ui);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
h1,h2,h3,p,dl,dd{margin:0}
h1,h2,h3,strong,th{font-weight:600}
summary,label{font-weight:500}
table{font:inherit;color:inherit;border-collapse:collapse}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--accent-text);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
a:not(.skip-link):not(.sidebar a):focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:not(.navigation-group > summary):focus-visible,[tabindex]:not(a):focus-visible{outline:2px solid var(--focus-ring-surface);outline-offset:2px}
.sidebar a:focus-visible,.navigation-group > summary:focus-visible{outline:2px solid var(--focus-ring-rail);outline-offset:2px}
.list-page-link:focus-visible{outline:2px solid var(--focus-ring-surface);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
code,.surface-id,.diagnostic-release,.mono{font-family:var(--f-mono);font-size:.92em;letter-spacing:-.01em}
th,td,dd,output,.cell-numeric,code{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.eyebrow{margin:0 0 4px;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.lede{max-width:70ch;color:var(--muted);font-size:13px;line-height:1.55}
.skip-link{position:fixed;left:16px;top:-80px;z-index:80;padding:6px 12px;border-radius:4px;background:var(--accent);color:var(--on-accent);font-weight:500;text-decoration:none}
.skip-link:focus{top:12px}

/* ---------- shell ---------- */
.app-shell{min-height:100vh;display:grid;grid-template-columns:var(--side-w) minmax(0,1fr);background:linear-gradient(90deg,var(--side) calc(var(--side-w) - 1px),var(--rule) calc(var(--side-w) - 1px),var(--rule) var(--side-w),transparent var(--side-w))}
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:12px 10px;background:var(--side);border-right:1px solid var(--rule);color:var(--ink-2)}
.brand{display:flex;align-items:center;gap:9px;padding:6px 6px 10px;border-bottom:1px solid var(--rule)}
.brand__mark{display:grid;place-items:center;flex:none;width:26px;height:26px;border-radius:5px;background:var(--ink);color:var(--paper);font:600 12px/1 var(--f-ui);letter-spacing:-.02em}
.brand>span:last-child{display:grid;min-width:0;line-height:1.25}
.brand strong{font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand small{font-size:11px;color:var(--muted)}
.sidebar nav ul{display:grid;gap:1px;margin:0;padding:0;list-style:none}
.work-queues{padding-bottom:6px;border-bottom:1px solid var(--rule)}
.sidebar a,.navigation-group>summary{display:flex;align-items:center;gap:9px;min-height:var(--nav-h);padding:4px 8px;border:1px solid transparent;border-radius:4px;color:var(--ink-2);font-size:13px;font-weight:400;line-height:1.25;text-decoration:none;cursor:pointer;list-style:none}
.sidebar a:hover{background:var(--hover);text-decoration:none}
.sidebar a[aria-current=page]{background:var(--sheet);border-color:var(--rule);color:var(--ink);font-weight:500}
.nav-icon{display:grid;place-items:center;flex:none;width:16px;height:16px;color:var(--muted)}
.nav-icon svg{width:16px;height:16px;stroke-width:1.6}
.sidebar a[aria-current=page] .nav-icon{color:var(--accent)}
.queue-count{margin-left:auto;display:grid;place-items:center;min-width:22px;height:18px;padding:0 6px;border:1px solid var(--rule-2);border-radius:9px;background:var(--sheet);color:var(--ink);font-size:11px;font-weight:600}
.nav-arrow{display:none}
/* Area groups: on a wide screen every group lists its destinations; the
   group's summary reads as its heading and the group never hides them. */
.navigation-group::details-content{content-visibility:visible;display:block}
.navigation-group>summary::-webkit-details-marker{display:none}
.navigation-tree>li>.navigation-group>summary{min-height:0;margin-top:10px;padding:2px 8px 4px;color:var(--muted);font-size:11px;font-weight:500;cursor:default}
.navigation-tree>li>.navigation-group>summary .nav-icon,.navigation-tree>li>.navigation-group>summary .nav-text small{display:none}
.navigation-children .navigation-group>summary{min-height:0;margin-top:6px;padding:2px 8px 2px 8px;color:var(--faint);font-size:11px;font-weight:500;cursor:default}
.navigation-children .navigation-group>summary .nav-icon,.navigation-children .navigation-group>summary .nav-text small{display:none}
.nav-text{display:grid;min-width:0}
.navigation-children{display:grid;gap:1px;margin:0!important;padding:0!important}
.side-foot{margin-top:auto;display:grid;gap:8px;padding:10px 6px 0;border-top:1px solid var(--rule)}
.side-foot[data-shell-region]{grid-template-columns:auto minmax(0,1fr);align-items:center;gap:6px 9px}
.side-foot__who{display:grid;line-height:1.25;font-size:12px;color:var(--ink)}
.side-foot__who strong{font-weight:500}
.side-foot__who small{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.workspace{min-width:0;display:flex;flex-direction:column}
.topbar{position:relative;display:flex;align-items:center;gap:12px;min-height:48px;padding:6px var(--gutter);border-bottom:1px solid var(--rule);background:var(--paper);color:var(--muted);font-size:12px}
.topbar__context{display:none;color:var(--ink);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shell-menu{display:none}
.shell-menu>summary{display:grid;place-items:center;width:32px;height:32px;border-radius:4px;color:var(--ink-2);cursor:pointer;list-style:none}
.shell-menu>summary::-webkit-details-marker{display:none}
.shell-menu>summary:hover{background:var(--hover)}
.shell-menu svg{width:18px;height:18px}
.shell-search{flex:0 1 340px;min-width:0}
.shell-search label{display:flex;align-items:center;gap:8px;height:var(--ctl-h);padding:0 8px 0 10px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--muted);font-weight:400}
.shell-search input{flex:1;min-width:0;height:100%;border:0;background:transparent;color:var(--ink);font-size:13px}
.principal{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--muted)}
.principal__avatar{display:grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent-soft);color:var(--accent-text);font-size:11px;font-weight:600}
.shell-diagnostics summary{display:flex;align-items:center;min-height:30px;padding:0 6px;border-radius:4px;color:var(--muted);font-size:11px;cursor:pointer;list-style:none}
.shell-diagnostics summary::-webkit-details-marker{display:none}
.shell-diagnostics summary:hover{background:var(--hover)}
.shell-diagnostics dl{position:absolute;z-index:20;top:100%;right:var(--gutter);width:min(36rem,calc(100vw - 32px));max-height:70dvh;overflow:auto;margin:0;padding:14px;border:1px solid var(--rule);border-radius:6px;background:var(--sheet);box-shadow:var(--shadow-dlg)}
.shell-diagnostics dt{color:var(--muted);font-size:11px;font-weight:500}
.shell-diagnostics dd{margin:0 0 8px;font-family:var(--f-mono);font-size:11px;color:var(--ink);overflow-wrap:anywhere}
.demo-identity{display:flex;justify-content:flex-end;padding:4px var(--gutter);border-bottom:1px solid var(--rule);background:var(--side);color:var(--muted);font-size:11px}
.side-foot .demo-identity{grid-column:1/-1;display:block;padding:0;border:0;background:transparent}
.demo-identity form{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0}
.demo-identity label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;font-weight:400}
.demo-identity select,.demo-identity button{min-height:24px;height:24px;padding:0 6px;font-size:11px}
.demo-identity span{padding:1px 6px;border:1px solid var(--rule-2);border-radius:999px;color:var(--ink-2)}
.workspace-context-bar{display:flex;flex:1;min-width:0;align-items:center;gap:8px}
.workspace-context-bar__label{flex:none;color:var(--muted);font-size:11px;font-weight:500}
.workspace-context-bar__options{display:flex;min-width:0;gap:4px;overflow-x:auto}
.workspace-context-bar__options .secondary-action{flex:none;min-height:26px;height:26px;padding:0 10px;font-size:12px}
.workspace-context-bar__options .secondary-action[aria-current=true]{border-color:var(--rule-2);background:var(--sheet);color:var(--ink)}
main{width:100%;max-width:var(--page-max);padding:var(--gap) var(--gutter) 56px}

/* ---------- page heading ---------- */
.surface-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.surface-heading h1,.standalone h1,.diagnostic--page h1{margin:0;color:var(--ink);font-size:20px;font-weight:600;line-height:1.2;letter-spacing:-.01em;text-wrap:balance}
.surface-id{margin-top:6px;color:var(--muted)}
.surface-status{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.surface-heading--slot,.record-breadcrumb,.command-bar{grid-column:1/-1}
.surface-heading__actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.record-breadcrumb{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:var(--muted);font-size:12px;font-weight:400}
.record-breadcrumb a{color:var(--muted)}

/* ---------- status badges: one shape per kind, so they read apart without colour ---------- */
.surface-status span,.status-pill{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border:1px solid var(--rule-2);border-radius:999px;background:transparent;color:var(--muted);font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
.surface-status span::before,.status-pill::before{content:"";flex:none;width:7px;height:7px;border:1.5px solid currentColor;border-radius:50%}
.surface-status [data-status-role],.status-pill[data-status-role]{border-color:transparent}
.surface-status [data-status-role=inProgress],.status-pill[data-status-role=inProgress]{background:var(--status-inprogress-ground);color:var(--status-inprogress-ink)}
.surface-status [data-status-role=inProgress]::before,.status-pill[data-status-role=inProgress]::before{background:linear-gradient(90deg,currentColor 50%,transparent 50%)}
.surface-status [data-status-role=success],.status-pill[data-status-role=success]{background:var(--status-success-ground);color:var(--status-success-ink)}
.surface-status [data-status-role=success]::before,.status-pill[data-status-role=success]::before{width:4px;height:8px;border:solid currentColor;border-width:0 1.7px 1.7px 0;border-radius:0;transform:translate(1px,-1px) rotate(45deg);margin-right:1px}
.surface-status [data-status-role=attention],.status-pill[data-status-role=attention]{background:var(--status-attention-ground);color:var(--status-attention-ink)}
.surface-status [data-status-role=attention]::before,.status-pill[data-status-role=attention]::before{border:0;background:currentColor}
.surface-status [data-status-role=blocked],.status-pill[data-status-role=blocked]{background:var(--status-blocked-ground);color:var(--status-blocked-ink)}
.surface-status [data-status-role=blocked]::before,.status-pill[data-status-role=blocked]::before{border:0;border-radius:1.5px;background:currentColor}

/* ---------- buttons: one primary per screen; everything else secondary or ghost ---------- */
button,.button,.primary-action,.secondary-action,.list-page-link{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:var(--ctl-h);padding:0 12px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font-size:13px;font-weight:500;line-height:1.2;white-space:nowrap;text-decoration:none;cursor:pointer}
button:hover,.button:hover,.secondary-action:hover{background:var(--sunk);text-decoration:none}
.primary-action,.task-primary-action button,.launcher-action button,
.composition-progression-next button,.composition-progression-next a.button,
button[name=taskStage][value=prepare]:not(.sr-only),button[name=taskStage][value=confirm],
button[name=draftCreate][value=submit],button[name=draftAction][value=confirm],button[name=draftAction][value=save],button[name=draftAction][value=place]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.primary-action:hover,.task-primary-action button:hover,.launcher-action button:hover,
.composition-progression-next button:hover,.composition-progression-next a.button:hover,
button[name=taskStage][value=prepare]:not(.sr-only):hover,button[name=taskStage][value=confirm]:hover,
button[name=draftCreate][value=submit]:hover,button[name=draftAction][value=confirm]:hover,button[name=draftAction][value=save]:hover,button[name=draftAction][value=place]:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.link-action{min-height:30px;padding:0 4px;border:0;background:transparent;color:var(--accent-text);font-weight:500}
.link-action:hover{background:transparent;text-decoration:underline}
button:disabled{opacity:.55;cursor:not-allowed}

/* ---------- panels ---------- */
.surface-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--gap)}
.surface-slot{display:contents}
.panel,.diagnostic{grid-column:1/-1;min-width:0;border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.panel{padding:calc(var(--row-y) + 6px) var(--pad-x) calc(var(--row-y) + 8px)}
.panel h2,.diagnostic h2{max-width:60ch;margin:0 0 8px;font-size:13px;font-weight:600}
.panel--hero{position:relative}
.panel__accent{position:absolute;right:var(--pad-x);top:var(--pad-x);display:grid;place-items:center;width:26px;height:26px;border-radius:4px;background:var(--accent-soft);color:var(--accent-text)}
.panel__heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.panel__heading h2{margin:0}
.fact-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 22px;margin:14px 0 0}
.fact-grid dt,.key-fact-grid dt,.record-fields dt{color:var(--muted);font-size:11px;font-weight:500}
.fact-grid dd,.key-fact-grid dd,.record-fields dd{margin:3px 0 0;font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.checklist{display:grid;margin:12px 0 0;padding:0;list-style:none}
.checklist li{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;padding:var(--row-y) 0;border-top:1px solid var(--rule)}
.checklist li>span{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--accent-soft);color:var(--accent-text);font-size:11px;font-weight:600}
.checklist strong{font-size:13px;font-weight:500}
.checklist p{margin-top:2px;color:var(--muted);font-size:12px}
.diagnostic{display:flex;gap:12px;align-items:flex-start;padding:14px var(--pad-x);border-color:var(--blocked-soft);background:var(--blocked-soft);color:var(--blocked)}
.diagnostic__mark{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:3px;background:var(--blocked);color:var(--blocked-soft);font-size:12px;font-weight:600}
.diagnostic h2,.diagnostic p{color:var(--blocked)}
.diagnostic p{margin:0 0 6px;line-height:1.5}
.diagnostic code,.standalone code{display:inline-block;padding:1px 6px;border-radius:3px;background:var(--sunk);color:var(--ink)}
/* A diagnostic's code is the support handle its own detail asks for. */
.diagnostic [data-message-code][hidden],.standalone [data-message-code][hidden]{display:inline-block!important}
.standalone{min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--paper)}
.standalone__card{width:min(640px,100%);padding:var(--sheet-y) var(--sheet-x);border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.standalone__card>p{color:var(--muted);line-height:1.55}
.diagnostic-release{margin-top:16px;color:var(--muted)}
.operation-feedback{grid-column:1/-1;padding:10px var(--pad-x);border:1px solid transparent;border-radius:4px;background:var(--success-soft);color:var(--success)}
.operation-feedback strong{margin-right:4px}
.data-panel,.data-empty{grid-column:1/-1}

/* ---------- tables ---------- */
.data-table-wrap{margin-top:12px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.data-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}
.data-table-wrap th{height:auto;padding:calc(var(--row-y) - 1px) 12px;border-bottom:1px solid var(--rule);background:var(--sunk);color:var(--muted);font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;white-space:nowrap;vertical-align:middle}
.data-table-wrap td{height:auto;padding:var(--row-y) 12px;border-bottom:1px solid var(--rule);vertical-align:middle}
.data-table-wrap tbody tr:last-child td{border-bottom:0}
.data-table-wrap tbody tr:hover td{background:var(--sunk)}
.data-table-wrap td:has(.cell-numeric),.data-table-wrap [data-cell-kind=number]{text-align:right}
.record-link{color:var(--accent-text);font-weight:500}
.data-table-wrap td[data-column-priority="0"] .record-link{white-space:nowrap}
.data-panel>.data-table-wrap,.composition-collection>.data-table-wrap{margin:12px calc(-1 * var(--pad-x)) calc(-1 * (var(--row-y) + 8px));border-top:1px solid var(--rule)}

/* ---------- lists ---------- */
.list-views{grid-column:1/-1}
.list-views ul{display:inline-flex;flex-wrap:wrap;margin:0;padding:0;list-style:none;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);overflow:hidden}
.list-views li+li{border-left:1px solid var(--rule-2)}
.list-view{display:inline-flex;align-items:center;gap:6px;min-height:var(--ctl-h);padding:0 11px;color:var(--ink-2);font-size:12px;font-weight:500;text-decoration:none}
.list-view:hover{background:var(--sunk);text-decoration:none}
.list-view[aria-current=page]{background:var(--sunk);color:var(--ink);font-weight:600}
.list-view__count{padding:0;border-radius:0;background:transparent;color:var(--muted);font-size:12px;font-weight:400}
.list-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:12px}
.list-controls .form-field{margin:0}
.list-controls__search{flex:1 1 16rem}
.list-controls__actions{display:flex;gap:8px;align-items:center}
.list-controls .form-field>label{display:grid;gap:4px;color:var(--muted);font-size:11px;font-weight:500}
.list-summary{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:flex-end;color:var(--muted);font-size:12px}
.list-sort{display:inline-flex;gap:4px;align-items:center;color:inherit;text-decoration:none}
.list-pagination{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px}
.list-pagination a,.list-pagination button{min-height:44px}
.list-page-status{color:var(--muted);font-size:12px}
.list-page-jump{display:inline-flex;gap:8px;align-items:center}
.list-pagination .list-page-jump input{width:5rem}
.list-export--refused{color:var(--muted);font-size:12px}
.selection-cell{width:44px}
.record-selector{display:grid;place-items:center;min-width:30px;min-height:30px;cursor:pointer}
.record-selector__input{width:15px;height:15px;accent-color:var(--accent)}
.bulk-bar{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px var(--pad-x);border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.bulk-bar p{margin-top:2px;color:var(--muted);font-size:12px}
.bulk-ready{display:none}
body:has(.record-selector__input:checked) .bulk-empty{display:none}
body:has(.record-selector__input:checked) .bulk-ready{display:inline-flex}

/* ---------- forms ---------- */
.form-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px;margin:12px 0}
.form-fields span,.form-field__label{color:var(--ink-2);font-size:12px;font-weight:500}
.form-field{display:grid;align-content:start;gap:5px}
.form-fields label{display:grid;gap:5px}
.form-field--wide{grid-column:1/-1}
.form-fields input,.form-fields select,.list-controls input,.list-controls select,.list-page-jump input,.composition-inputs input,.composition-inputs select,.reference-search input{width:100%;min-height:var(--ctl-h);padding:0 9px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font:inherit;font-size:13px}
.draft-header textarea,.editor-create__fields textarea,.composition-inputs textarea{width:100%;padding:7px 9px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font:inherit;font-size:13px;resize:vertical}
/* Every text control reads the sheet and ink, whatever form it sits in. */
input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not(.shell-search input),select,textarea{border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink)}
input::placeholder,textarea::placeholder{color:var(--faint)}
.form-fields input[type="checkbox"]{width:16px;height:16px;min-height:16px;padding:0;justify-self:start;margin:6px 0;accent-color:var(--accent)}
.form-fields .form-empty-intent{padding-top:4px}
.form-unavailable-value{display:block;padding:7px 9px;border:1px solid var(--rule);border-radius:4px;background:var(--sunk);color:var(--muted);font-size:12px}
.form-unavailable-value code{color:var(--ink);overflow-wrap:anywhere}
.field-error{display:block;margin-top:4px;color:var(--blocked);font-size:12px;font-weight:500;letter-spacing:normal;text-transform:none}
[aria-invalid="true"]{border-color:var(--blocked)!important}
[data-document-editor] fieldset{min-width:0;margin:var(--gap) 0;padding:var(--sheet-y) var(--sheet-x);border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
[data-document-editor] legend{margin-bottom:12px;padding:0;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.draft-header .form-field__label,.draft-lines th{font-size:12px;font-weight:500;letter-spacing:normal;text-transform:none;color:var(--ink-2)}
.draft-header>.form-field:not(.form-field--reference){gap:5px}
table.draft-lines.form-fields{display:table;width:100%;margin:0;border-collapse:collapse;border-top:1px solid var(--ink);table-layout:fixed}
.draft-lines th{padding:8px 8px 6px;text-align:left;color:var(--muted);font-size:11px;font-weight:500;border-bottom:1px solid var(--rule)}
.draft-lines__heading--reference{width:46%}.draft-lines__heading--value{width:17%}.draft-lines__heading--derived{width:10%}.draft-lines__heading--remove{width:6.5rem}
.draft-line__cell{padding:8px;vertical-align:top;border:0;border-bottom:1px solid var(--rule);border-radius:0;background:transparent}
.draft-line__cell:last-child{text-align:right}
.draft-line__cell input,.draft-line__cell select{width:100%;min-width:0}
.draft-line--removed td{padding:8px;color:var(--muted)}
.derived-value{display:inline-flex;align-items:center;min-height:var(--ctl-h);font-weight:600;color:var(--ink)}
.derived-empty{font-weight:400;color:var(--faint)}
.draft-lines .derived-empty,.draft-lines .derived-value,.reference-control span,.reference-selected span{font-size:inherit;letter-spacing:normal;text-transform:none}
.draft-note{margin:0 0 12px;padding:9px 12px;border:1px solid transparent;border-radius:4px;background:var(--attention-soft);color:var(--attention)}
.draft-note p{margin:0}
.draft-note--done{background:var(--success-soft);color:var(--success)}
.draft-note--problem{background:var(--blocked-soft);color:var(--blocked)}
.editor-create__fields input:disabled,.editor-create__fields textarea:disabled,.draft-header input:disabled,.draft-header select:disabled,.draft-header textarea:disabled,.draft-lines input:disabled{background:var(--sunk);color:var(--muted);cursor:not-allowed}
.draft-create-resume{grid-column:1/-1;margin:0 0 12px}
.draft-paused{margin:0 0 12px;padding:9px 12px;border-radius:4px;background:var(--sunk);color:var(--ink-2)}
.editor-create{width:calc(100% - 32px);max-width:42rem;margin:16px auto;padding:0;border:1px solid var(--rule);border-radius:6px;background:var(--sheet);color:var(--ink);box-shadow:var(--shadow-dlg)}
.editor-create>*{margin-left:20px;margin-right:20px}
.editor-create::backdrop{background:var(--scrim)}
.editor-create__header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0;padding:14px 20px;border-bottom:1px solid var(--rule)}
.editor-create__header h2{margin:0;font-size:15px}
.editor-create__explanation{color:var(--muted)}
.editor-create[open]:not(:modal){position:static;inset:auto;grid-column:1/-1;width:100%;max-width:none;margin:0 0 var(--gap);box-shadow:none}
.editor-create__footer{display:flex;justify-content:flex-end;gap:8px;margin:16px 0 0;padding:12px 20px;border-top:1px solid var(--rule);background:var(--sunk)}
.editor-create__duplicates{margin:12px 0;padding:10px 12px;border-radius:4px;background:var(--attention-soft);color:var(--ink)}
.editor-create__duplicates p{margin:0 0 6px}.editor-create__duplicates ul{margin:0 0 6px;padding-left:18px}
.reference-control{display:grid;gap:6px}
.reference-search{position:relative;display:flex;flex-wrap:wrap;gap:6px}
.reference-search input{flex:1 1 12rem;min-width:0}
.reference-lookup{display:grid;flex-basis:100%;gap:6px}
.reference-status:empty{display:none}
.reference-status p{margin:0}
.reference-selected-detail{color:var(--muted)}
body[data-reference-enhanced] [data-reference-submit]{display:none}
body[data-reference-enhanced] .reference-lookup{display:none}
body[data-reference-enhanced] [data-reference-open] .reference-lookup{display:grid;position:absolute;z-index:6;top:calc(100% + 2px);left:0;right:0;gap:0;padding:4px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);box-shadow:var(--shadow-dlg)}
body[data-reference-enhanced] [data-reference-open] .reference-results{max-height:18rem;padding:0;border:0}
body[data-reference-enhanced] [data-reference-field][aria-busy="true"] .reference-search input{cursor:progress}
.reference-results{display:grid;gap:1px;max-height:16rem;margin:0;padding:4px;overflow:auto;list-style:none;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet)}
.reference-option{display:grid;justify-content:stretch;justify-items:start;gap:1px;width:100%;min-height:36px;height:auto;padding:6px 8px;text-align:left;border:0;border-radius:3px;background:transparent;color:var(--ink);font-weight:500;white-space:normal}
.reference-option:hover{background:var(--sunk)}
.reference-option small,.reference-selected small{color:var(--muted);font-weight:400}
.reference-option[aria-selected="true"],.reference-create[aria-selected="true"],.reference-more[aria-selected="true"]{background:var(--accent-soft);box-shadow:inset 2px 0 0 var(--accent)}
.reference-empty{padding:8px;color:var(--muted)}
.reference-limit{margin:0}
.reference-create{display:block;width:100%;min-height:36px;padding:6px 8px;border:0;border-top:1px solid var(--rule);border-radius:0;background:transparent;color:var(--accent-text);font-weight:500;text-align:left}
.reference-create:hover{background:var(--sunk)}
.reference-more{width:100%;justify-content:flex-start}
.reference-selected{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:var(--ctl-h);padding:3px 8px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet)}
.reference-selected__text{display:grid}
.lifecycle-action{margin-top:12px}
.record-section-group summary{display:flex;align-items:center;min-height:var(--ctl-h);padding:6px 0;border-bottom:1px solid var(--rule);color:var(--ink-2);font-weight:500;cursor:pointer}

/* ---------- record (generic) ---------- */
.command-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-height:0;padding:0;border:0;background:transparent}
.command-bar .action-overflow{margin-left:auto}
.command-bar [data-save-boundary]{flex-basis:100%;margin:0;color:var(--muted);font-size:12px}
/* The editor's save bar (LOOK-1): sticky under the form, one primary action. */
.panel:has(>.command-bar [data-save-boundary]){position:sticky;bottom:0;z-index:5;padding:10px var(--pad-x);box-shadow:var(--shadow-bar)}
.command-bar:has([data-save-boundary]){flex-wrap:wrap;justify-content:flex-end}
.panel:has([data-document-editor]) fieldset{margin:0;padding:0;border:0;background:transparent}
.draft-header.form-fields{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 18px;margin:0}
.draft-lines-panel .panel__heading{align-items:center;margin-bottom:10px}
.draft-lines-panel .panel__heading h2{color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.action-overflow{position:relative;width:max-content}
.action-overflow summary{display:inline-flex;align-items:center;min-height:var(--ctl-h);padding:0 12px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font-size:13px;font-weight:500;cursor:pointer;list-style:none}
.action-overflow summary::-webkit-details-marker{display:none}
.action-overflow summary:hover{background:var(--sunk)}
.action-overflow[open]{padding:6px;border:1px solid var(--rule);border-radius:4px;background:var(--sheet);box-shadow:var(--shadow-dlg)}
.action-overflow .lifecycle-action{margin:6px 0 0}
.record-fields,.key-fact-grid{display:grid;gap:14px 22px;margin:12px 0 0}
.record-fields{grid-template-columns:repeat(4,minmax(0,1fr))}
.key-fact-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
.key-facts-panel{grid-column:1/-1}

/* ---------- home and launchers ---------- */
.task-decision-slot,.task-scan-input-slot,.task-primary-action-slot,.task-primary-action,.launcher-tiles{grid-column:1/-1}
.task-decision output{display:block;margin:8px 0;font-size:20px;font-weight:600}
.task-primary-action{display:flex;justify-content:flex-end}
.launcher-tiles ul{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin:0;padding:0;list-style:none;background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.launcher-tiles li{display:flex}
.launcher-tile{position:relative;display:grid;align-content:start;gap:4px;width:100%;min-height:88px;height:100%;padding:calc(var(--row-y) + 5px) 16px calc(var(--row-y) + 6px);border:0;border-radius:0;background:var(--sheet);color:var(--ink);text-decoration:none}
.launcher-tile:hover{background:var(--sunk);text-decoration:none}
.launcher-tile__label{display:flex;align-items:center;gap:7px;color:var(--ink-2);font-size:12px;font-weight:500}
.launcher-tile__count{font-size:28px;line-height:1.1;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
/* The view a tile opens is the tile's own label in other words: read, not shown. */
.launcher-tile__view{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.launcher-tile__description{color:var(--muted);font-size:12px}
.launcher-scan__field{display:grid;gap:6px;color:var(--ink-2);font-size:12px;font-weight:500}
.launcher-scan__field input{min-height:44px;padding:0 12px;font-family:var(--f-mono);font-size:14px}
.launcher-scan__message{margin-top:10px}
.launcher-action button{min-height:44px}

/* ---------- composition (documents) ---------- */
.composition-header{display:contents}
.composition-title{grid-column:1/-1;order:-2}
.record-breadcrumb{order:-3}
.composition-alert,.composition-progression,.surface-grid>.operation-feedback{order:-1}
.composition-heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.composition-heading h1{margin:0;font-family:var(--f-doc);font-size:28px;font-weight:500;line-height:1.1;letter-spacing:-.01em;overflow-wrap:anywhere}
.composition-business-status{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border:1px solid var(--rule-2);border-radius:999px;color:var(--muted);font-size:11px;font-weight:500;white-space:nowrap}
.composition-business-status::before{content:"";width:7px;height:7px;border:1.5px solid currentColor;border-radius:50%}
.composition-subtitle{margin:3px 0 0;color:var(--muted);font-size:13px}
.composition-facts{padding:calc(var(--row-y) + 8px) var(--pad-x) calc(var(--row-y) + 10px)}
.composition-header-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 22px;margin:0}
.composition-header-facts dt,.composition-cell-label{color:var(--muted);font-size:11px;font-weight:500}
.composition-header-facts dd{margin:3px 0 0;color:var(--ink);font-size:13px;overflow-wrap:anywhere}
.composition-totals{display:grid;gap:5px;width:min(100%,300px);margin:12px 0 0 auto;font-size:13px}
.composition-totals div{display:flex;justify-content:space-between;gap:16px}
.composition-totals dt{color:var(--ink-2)}
.composition-totals dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.composition-totals div:last-child{margin-top:4px;padding:8px 0 3px;border-top:1px solid var(--ink);border-bottom:3px double var(--ink);font-weight:600;font-size:14px}
.line-progress{display:inline-flex;align-items:center;gap:10px;white-space:nowrap;color:var(--muted)}
.line-progress b{color:var(--ink);font-weight:600}
.line-progress progress{-webkit-appearance:none;appearance:none;width:44px;height:3px;border:0;border-radius:2px;background:var(--rule);overflow:hidden}
.line-progress progress::-webkit-progress-bar{background:var(--rule);border-radius:2px}
.line-progress progress::-webkit-progress-value{background:var(--accent);border-radius:2px}
.line-progress progress::-moz-progress-bar{background:var(--accent)}
.line-progress[data-progress=complete] progress::-webkit-progress-value{background:var(--success)}
.line-progress[data-progress=complete] progress::-moz-progress-bar{background:var(--success)}
.composition-collection td[data-cell-role=progress]{text-align:right}
.composition-progression-phone{display:none}
.composition-progression-heading{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.composition-alert{grid-column:1/-1;display:flex;gap:12px;align-items:flex-start;padding:12px var(--pad-x);border:1px solid transparent;border-radius:4px;background:var(--attention-soft);color:var(--ink)}
.composition-alert h2{margin:0;font-size:13px;color:var(--attention)}
.composition-alert p{margin:3px 0}
.composition-alert ul{margin:6px 0 0;padding-left:18px}
.composition-alert li{overflow-wrap:anywhere}
.composition-alert-marker{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--attention);color:var(--attention-soft);font-size:12px;font-weight:600}
.composition-progression{grid-column:1/-1;padding:0}
.composition-progression h2{margin:0;font-size:13px}
.composition-progression .eyebrow{margin:0}
.composition-progression-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:4px;margin:0;padding:14px 16px 12px;list-style:none}
.composition-progression-steps>li{display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-content:start;min-width:0;padding:10px 0 0;border-top:2px solid var(--rule)}
.composition-progression-steps>li[data-step-state=complete]{border-top-color:var(--ink-2)}
.composition-progression-steps>li[data-step-state=current]{border-top-color:var(--accent)}
.composition-progression-steps>li[data-step-state=attention]{border-top-color:var(--attention)}
.composition-progression-steps>li[data-step-state=stopped],.composition-progression-steps>li[data-step-state=upcoming]{color:var(--muted)}
.composition-progression-marker{flex:none;display:inline-grid;place-items:center;width:18px;height:18px;border:1.5px solid var(--rule-2);border-radius:50%;color:transparent;font-size:10px;font-weight:600;line-height:1}
.composition-progression-steps>li[data-step-state=complete] .composition-progression-marker{border-color:var(--ink-2);background:var(--ink-2);color:var(--sheet)}
.composition-progression-steps>li[data-step-state=current] .composition-progression-marker{border:5px solid var(--accent);background:var(--sheet)}
.composition-progression-steps>li[data-step-state=attention] .composition-progression-marker{border-color:var(--attention);background:var(--attention);color:var(--attention-soft)}
.composition-progression-steps>li[data-step-state=stopped] .composition-progression-marker{border-color:var(--blocked);color:var(--blocked)}
.composition-progression-state{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.composition-progression-steps strong{display:block;font-size:12px;font-weight:600;overflow-wrap:anywhere}
.composition-progression-steps>li[data-step-state=current] strong{color:var(--accent-text)}
.composition-progression-documents{display:flex;flex-wrap:wrap;gap:0 8px;margin:2px 0 0;padding:0;list-style:none;font-family:var(--f-mono);font-size:11px}
.composition-progression-next{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin:0;padding:12px 16px 14px;border-top:1px solid var(--rule);background:transparent}
.composition-progression-next>div{flex:1 1 16rem;min-width:0}
.composition-progression-next .eyebrow{color:var(--accent-text);font-weight:600}
.composition-progression-next strong{font-size:14px;font-weight:500}
.composition-progression-next p{margin:3px 0 0;color:var(--muted);font-size:12px}
.composition-progression-next form{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.composition-context{grid-column:1/-1;padding:calc(var(--row-y) + 4px) var(--pad-x);border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.composition-context h2{margin:0;font-size:13px}
.composition-context p{margin:3px 0;color:var(--muted);font-size:12px}
.composition-context nav{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px}
.composition-context-links{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.composition-context-heading,.composition-collection-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.composition-context-overflow summary{display:flex;align-items:center;min-height:var(--ctl-h);color:var(--muted);cursor:pointer}
.composition-context-overflow[open]{padding:6px;border:1px solid var(--rule);border-radius:4px}
.composition-back{grid-column:1/-1;width:fit-content;display:inline-flex;align-items:center;min-height:var(--ctl-h);font-size:12px}
.composition-context a,.composition-print{display:inline-flex;align-items:center}
.composition-title{grid-column:1/-1}
/* The record's other commands sit at the header's right (spec: secondary
   actions beside the title, never the primary); opened, they drop down. */
.composition-record-actions{position:relative;grid-column:1/-1;order:-2;justify-self:end;align-self:end;margin-top:calc(-1 * var(--gap) - var(--ctl-h) - 2px);z-index:4}
.composition-record-actions>summary{display:inline-flex;align-items:center;min-height:var(--ctl-h);padding:0 12px;border:1px solid var(--rule-2);border-radius:4px;background:var(--sheet);color:var(--ink);font-size:13px;font-weight:500;cursor:pointer;list-style:none}
.composition-record-actions>summary::-webkit-details-marker{display:none}
.composition-record-actions>summary::after{content:"";width:6px;height:6px;margin:-3px 0 0 8px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.composition-record-actions[open]>.command-bar{position:absolute;right:0;top:calc(100% + 4px);display:grid;gap:6px;min-width:14rem;padding:8px;border:1px solid var(--rule);border-radius:6px;background:var(--sheet);box-shadow:var(--shadow-dlg)}
.composition-local-actions{display:flex;flex-wrap:wrap;gap:8px}
.composition-local-actions>div{flex:1 1 16rem}
.composition-local-actions p{margin:6px 0;color:var(--muted)}
.composition-actions{grid-column:1/-1;width:100%;min-width:0}
.composition-collection{grid-column:1/-1;padding:calc(var(--row-y) + 3px) var(--pad-x) calc(var(--row-y) + 8px);scroll-margin-top:12px}
.composition-collection h2{margin:0;font-size:13px}
.composition-collection>.data-table-wrap{margin-top:calc(var(--row-y) + 2px)}
.composition-collection table{width:100%;table-layout:auto}
.composition-collection th,.composition-collection td{white-space:nowrap;overflow-wrap:normal}
.composition-collection td[data-cell-role=primary]{min-width:12rem}
.composition-collection td[data-cell-role=primary] strong{font-weight:500}
.composition-cell-secondary{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;color:var(--muted);font-size:11px;font-weight:400}
.composition-cell-secondary>span{display:block}
.composition-quantity,.composition-collection td[data-cell-role=quantity]{text-align:right;font-variant-numeric:tabular-nums}
.composition-description{color:var(--muted);margin:6px 0}
.composition-collection td[data-cell-role=actions]{text-align:right}
.composition-collection td[data-cell-role=actions] a,.composition-collection summary{display:inline-flex;align-items:center;min-height:26px}
.composition-collection td[data-cell-role=actions] a+a,.composition-collection td[data-cell-role=actions] form+a,.composition-collection td[data-cell-role=actions] a+form{margin-left:10px}
.composition-collection td[data-cell-role=actions] form{display:inline-flex}
.composition-collection td[data-cell-role=actions] button,.composition-collection td[data-cell-role=actions] a.button{min-height:calc(var(--ctl-h) - 6px);padding:0 9px;font-size:12px}
.composition-collection tr[data-selected=true] td{background:var(--accent-soft)}
.composition-collection[data-resolution=empty],.composition-collection[data-resolution=failed],.data-panel[data-composition-dataset][data-resolution=empty]{display:grid;grid-template-columns:minmax(10rem,auto) minmax(0,1fr);align-items:baseline;gap:4px 16px}
.composition-collection[data-resolution=empty] [data-message],.data-panel[data-composition-dataset][data-resolution=empty] [data-message]{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;color:var(--muted);font-size:12px}
.composition-collection[data-resolution=empty] [data-message] [data-message-sentence],.data-panel[data-composition-dataset][data-resolution=empty] [data-message] [data-message-sentence]{margin:0;color:var(--ink-2);font-size:12px;font-weight:500}
.composition-collection[data-resolution=empty] [data-message] p,.data-panel[data-composition-dataset][data-resolution=empty] [data-message] p{margin:0}
.data-panel [data-message],.panel>[data-message]{color:var(--muted)}
.data-panel [data-message] [data-message-sentence]{font-size:13px;font-weight:600;color:var(--ink)}
.data-panel [data-message] p{margin:3px 0 0;font-size:12px}
.composition-collection details>summary{color:var(--muted);font-size:12px;cursor:pointer}
.composition-section-links summary{display:flex;align-items:center;min-height:var(--ctl-h);cursor:pointer}

/* ---------- task dialog: the dialog with its impact line ---------- */
.composition-task-resume{grid-column:1/-1;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px var(--pad-x);border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.composition-task-resume>div{flex:1}
.composition-task-resume span{display:block;color:var(--muted)}
.composition-task-dialog{grid-column:1/-1;position:static;width:100%;max-width:44rem;margin:0 auto;padding:0;color:var(--ink);border:1px solid var(--rule);border-radius:6px;background:var(--sheet)}
.composition-task-dialog:modal{position:fixed;margin:auto;max-height:calc(100dvh - 32px);width:calc(100vw - 32px);overflow-y:auto;overscroll-behavior:contain;box-shadow:var(--shadow-dlg);border-color:var(--rule);scroll-padding-bottom:7rem}
.composition-task-dialog::backdrop{background:var(--scrim)}
.composition-task-dialog:has(.composition-task-rows,.composition-task-rows-review){max-width:60rem}
.composition-task-header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--rule);background:var(--sheet)}
.composition-task-header p{margin:0 0 2px;color:var(--muted);font-size:12px}
.composition-task-header h2{margin:0;font-size:16px;font-weight:600}
.composition-task-header button{flex:none;width:30px;padding:0;border-color:transparent;background:transparent;color:var(--ink-2);font-size:18px}
.composition-task-header button:hover{background:var(--hover)}
.composition-task-body{padding:16px 20px 0}
.composition-task-context{margin-bottom:14px;padding:10px 12px;border-radius:4px;background:var(--sunk)}
.composition-task-context h3{margin:0 0 6px;color:var(--muted);font-size:11px;font-weight:500}
.composition-task-context .record-fields{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0}
.composition-task-context .record-fields div{min-width:5rem}
.composition-task-context .record-fields dt{font-size:11px}
.composition-task-context .record-fields dd{font-size:12px}
.composition-task-context section+section{margin-top:10px;padding-top:10px;border-top:1px solid var(--rule)}
.composition-task-consequence{margin:12px 0;padding:10px 12px;border-radius:4px;background:var(--accent-soft);color:var(--ink-2);font-size:12px}
.composition-task-result{margin-bottom:14px;padding:10px 12px;border-radius:4px;background:var(--success-soft);color:var(--success)}
.composition-task-result h3{margin:0 0 6px;font-size:13px}
.composition-task-result dd,.composition-task-result dt{color:var(--success)}
.composition-task-summary,.composition-task-confirmation{margin-bottom:14px;padding:10px 12px;border:1px solid var(--rule);border-radius:4px;background:var(--sunk)}
.composition-task-summary>strong{margin-right:6px}
.composition-task-summary p,.composition-task-confirmation p{margin:6px 0 0}
.composition-task-confirmation h3{margin:0;font-size:16px}
.composition-task-support{margin-top:10px}
.composition-task-support>summary{display:flex;align-items:center;min-height:var(--ctl-h);color:var(--muted);cursor:pointer}
.composition-task-support .record-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
.composition-task-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.composition-task-layout .record-fields{margin:6px 0}
.composition-task-layout pre{white-space:pre-wrap;overflow-wrap:anywhere}
.composition-inputs{display:grid;gap:12px;max-width:none}
.composition-inputs label,.composition-inputs .field{display:grid;gap:5px;color:var(--ink-2);font-size:12px;font-weight:500}
.composition-inputs .composition-input{display:grid;gap:4px}
.composition-inputs input,.composition-inputs select,.composition-inputs textarea{scroll-margin-bottom:7rem}
.composition-inputs .derived-value{min-height:auto}
.composition-reviewed-inputs{display:flex;gap:18px;flex-wrap:wrap;margin:12px 0}
.composition-reviewed-inputs dt{color:var(--muted);font-size:11px}
.composition-reviewed-inputs dd{margin:2px 0;font-weight:600}
.composition-task-footer{position:sticky;bottom:0;z-index:1;display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:14px -20px 0;padding:12px 20px;border-top:1px solid var(--rule);border-radius:0 0 6px 6px;background:var(--sunk);flex-wrap:wrap}
.composition-task-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
.composition-task-rows{min-width:0;margin:0;padding:0;border:0}
.composition-task-rows legend{padding:0;margin-bottom:6px;font-weight:600}
.composition-task-rows>button{margin-top:8px}
.composition-task-rows table,.composition-task-rows-review{width:100%;font-size:12px;border-top:1px solid var(--ink)}
.composition-task-rows th,.composition-task-rows-review th{padding:8px 8px 6px;border-bottom:1px solid var(--rule);color:var(--muted);font-size:11px;font-weight:500;text-align:left}
.composition-task-rows td,.composition-task-rows-review td{padding:6px 8px;border-bottom:1px solid var(--rule)}
.composition-task-rows td input{min-width:6rem}
.composition-task-rows-review caption{padding:6px 0;text-align:left;font-weight:600}

/* ---------- print ---------- */
@media print{body *{visibility:hidden}.packing-document,.packing-document *{visibility:visible}.packing-document{position:absolute;inset:0;width:100%;border:0;box-shadow:none}.print-guidance{display:none}}
.print-page main{max-width:900px;margin:0 auto;padding:24px var(--gutter)}
.print-document{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;padding:var(--sheet-y) var(--sheet-x);border:1px solid var(--rule);border-radius:4px;background:var(--sheet);color:var(--ink)}
.print-header h1{margin:4px 0;font-family:var(--f-doc);font-size:28px;font-weight:500}
.print-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:12px;margin:12px 0 0}
.print-facts dt{color:var(--muted);font-size:11px}
.print-facts dd{margin:0;font-weight:500}
.print-section h2{margin:0 0 6px;font-size:13px}
.print-section table{width:100%;border-collapse:collapse;font-size:12px;border-top:1px solid var(--ink)}
.print-section th,.print-section td{padding:7px 8px;border-bottom:1px solid var(--rule);text-align:left}
.print-section th{color:var(--muted);font-size:11px;font-weight:500}
.print-count,.print-footer{color:var(--muted);font-size:11px}
.print-note{white-space:pre-wrap}
.print-table{overflow-x:auto}
@media print{.print-table{overflow:visible}}
.print-block h2{margin:0 0 4px;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.print-totals{display:grid;gap:4px;justify-self:end;min-width:16rem;margin:0}
.print-totals div{display:flex;justify-content:space-between;gap:16px}
.print-totals dt{color:var(--muted)}
.print-totals dd{margin:0}
.print-totals div:last-child{margin-top:4px;padding:6px 0 3px;border-top:1px solid var(--ink);border-bottom:3px double var(--ink);font-weight:600}
@media print{.print-page main{padding:0}.print-page .print-document,.print-page .print-document *{visibility:visible}.print-page .print-document{border:0;padding:0}}

/* ---------- motion ---------- */
.skeleton{position:relative;overflow:hidden;border-radius:4px;background:var(--skeleton-base)}
.skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,var(--skeleton-sheen) 50%,transparent 100%);transform:translateX(-100%);animation:skeleton-sweep var(--shimmer-duration) linear infinite}
@keyframes skeleton-sweep{to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.skeleton::after{animation:none;display:none}*{transition:none!important}}
@media (prefers-reduced-motion:no-preference){.sidebar a,.navigation-group>summary,button,.button,.primary-action,.secondary-action,.list-page-link,.list-view,.launcher-tile,.data-table-wrap td{transition:background-color var(--motion-duration) var(--motion-easing),border-color var(--motion-duration) var(--motion-easing),color var(--motion-duration) var(--motion-easing)}}

/* ---------- 1000px and below ---------- */
@media(max-width:1000px){
.draft-header.form-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
.record-fields,.key-fact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.launcher-tiles ul{grid-template-columns:repeat(2,minmax(0,1fr))}
}

/* ---------- 900px and below: the sidebar becomes a menu ---------- */
/* The menu button is the sidebar's first child, so keyboard order runs from
   it into the opened drawer; closed, the drawer is invisible and skipped.
   Native <details>, no script (ADR-0036). */
@media(max-width:900px){
.app-shell{display:block;background:none}
.sidebar{position:fixed;z-index:60;top:48px;bottom:0;left:0;width:min(300px,86vw);height:auto;padding:12px 10px calc(12px + env(safe-area-inset-bottom,0px)) max(10px,env(safe-area-inset-left,0px));box-shadow:var(--shadow-dlg);visibility:hidden}
.shell-menu{display:block;position:fixed;z-index:61;top:8px;left:max(10px,env(safe-area-inset-left,0px));visibility:visible}
body:has(.shell-menu[open]) .sidebar{visibility:visible}
body:has(.shell-menu[open])::after{content:"";position:fixed;inset:48px 0 0;z-index:55;background:var(--scrim)}
.topbar{position:sticky;top:0;z-index:58;min-height:48px;height:auto;gap:10px;flex-wrap:wrap;padding:6px max(16px,env(safe-area-inset-right,0px)) 6px 56px}
.topbar__context{display:block;flex:1}
.shell-search{display:none}
.principal{margin-left:0}
.workspace-context-bar{order:3;flex-basis:100%}
main{padding:14px max(16px,env(safe-area-inset-left,0px)) 40px}
/* In the drawer each group is a disclosure again, with thumb-sized rows. */
.navigation-group:not([open])::details-content{content-visibility:hidden}
.navigation-tree>li>.navigation-group>summary,.navigation-children .navigation-group>summary{min-height:44px;margin-top:0;padding:4px 8px;color:var(--ink-2);font-size:13px;font-weight:500;cursor:pointer}
.navigation-group>summary .nav-arrow{display:block}
.sidebar a,.navigation-children a{min-height:44px}
}

/* ---------- 800px and below: the compact projection ---------- */
@media(max-width:800px){
.draft-header.form-fields{grid-template-columns:minmax(0,1fr)}
.composition-collection[data-resolution=empty],.composition-collection[data-resolution=failed],.data-panel[data-composition-dataset][data-resolution=empty]{display:block}
.sidebar a,.navigation-children a{min-height:44px}
.surface-heading{align-items:flex-start;flex-direction:column;gap:10px}
.surface-status{justify-content:flex-start}
.fact-grid,.form-fields{grid-template-columns:minmax(0,1fr)}
.record-fields,.key-fact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.composition-heading h1{font-size:24px}
.principal strong{max-width:144px;overflow:hidden;text-overflow:ellipsis}
button,.button,.primary-action,.secondary-action,.list-page-link,.action-overflow summary,.list-view{min-height:44px}
.form-fields input,.form-fields select,.list-controls input,.list-controls select,.composition-inputs input,.composition-inputs select,.reference-search input,.reference-option,.reference-create{min-height:44px}
.command-bar,.task-primary-action{position:sticky;z-index:3;bottom:12px}
.task-primary-action{padding:8px;border:1px solid var(--rule);border-radius:4px;background:var(--sheet);box-shadow:var(--shadow-bar)}
.task-primary-action button{width:100%}
.composition-actions .command-bar{flex-wrap:wrap;position:static}
.composition-inputs{max-width:40rem}
[data-composition-task] button,[data-composition-task] input,[data-composition-task] select,[data-composition-dataset] a{min-height:44px}
[data-composition-dataset] td{overflow-wrap:anywhere}
[data-composition-dataset] a{display:inline-flex;align-items:center}
.list-views ul{display:flex;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin}
.list-view{white-space:nowrap}
.list-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.list-controls__search{grid-column:1/-1}
.list-controls__actions{align-self:end}
.list-summary{justify-content:flex-start}
.launcher-tile{padding:12px}
.launcher-tile__count{font-size:24px}
.launcher-action button{width:100%}
.data-table-wrap{overflow:visible}
.data-panel>.data-table-wrap,.composition-collection>.data-table-wrap{margin:10px 0 0;border-top:0}
.data-table-wrap table,.data-table-wrap tbody{display:block}
.data-table-wrap thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.data-table-wrap tr[data-compact-card=true]{display:grid;gap:2px;margin:0 0 8px;padding:8px 10px;border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.data-table-wrap tr[data-compact-card=true] td{display:grid;grid-template-columns:minmax(104px,38%) minmax(0,1fr);gap:10px;align-items:center;height:auto;min-height:32px;padding:3px 0;border:0;background:transparent;text-align:left}
.data-table-wrap tr[data-compact-card=true] td::before{content:attr(data-column-label);color:var(--muted);font-size:11px;font-weight:500;letter-spacing:0;text-transform:none}
.data-table-wrap tr[data-compact-card=true] td:has(.cell-numeric),.data-table-wrap tr[data-compact-card=true] td[data-cell-kind=number]{text-align:right}
.data-table-wrap tr[data-compact-card=true] td:has(.cell-numeric)::before,.data-table-wrap tr[data-compact-card=true] td[data-cell-kind=number]::before{text-align:left}
.data-table-wrap tr[data-compact-card=true] .selection-cell{width:auto}
.bulk-bar{align-items:flex-start;flex-direction:column}
.bulk-bar .secondary-action{width:100%}
table.draft-lines.form-fields,.draft-lines tbody,.draft-lines tr,.draft-lines td{display:block;width:auto}
table.draft-lines.form-fields{border-top:0}
.draft-lines thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.draft-line{margin-bottom:10px;padding:8px 10px;border:1px solid var(--rule);border-radius:4px;background:var(--sheet)}
.draft-line__cell,.draft-line__cell:last-child{padding:4px 0;border:0;text-align:left}
.draft-line__cell::before{content:attr(data-label);display:block;margin-bottom:3px;color:var(--muted);font-size:11px;font-weight:500}
.draft-line__cell--remove::before{content:none}
.editor-create__fields{grid-template-columns:minmax(0,1fr)}
[data-document-editor] fieldset{padding:18px 16px 20px}
.composition-task-layout{grid-template-columns:minmax(0,1fr)}
.composition-task-layout .record-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
.composition-heading{gap:8px}
.composition-header-facts{font-size:12px}
.composition-context nav{gap:8px}
.composition-record-actions{justify-self:start;margin-top:0}
.composition-record-actions[open]>.command-bar{left:0;right:auto}
.composition-progression-steps{grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:3px;padding-bottom:6px}
.composition-progression-steps>li{grid-template-columns:1fr}
.composition-progression-steps>li>div{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.composition-progression-phone{display:block;margin:0;padding:0 16px 10px;color:var(--muted);font-size:12px}
.composition-progression-phone:has(+.composition-progression-next){display:none}
.composition-header-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.composition-progression-next .composition-local-actions,.composition-progression-next form,.composition-progression-next a.button,.composition-progression-next button{width:100%}
.data-table-wrap tr[data-presented-row=true]{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.data-table-wrap tr[data-presented-row=true] td{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=primary]{grid-column:1/-1}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=primary]::before{display:none}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=detail],.data-table-wrap tr[data-presented-row=true] td[data-cell-role=actions]{grid-column:1/-1}
.data-table-wrap tr[data-presented-row=true] td[data-cell-role=detail]::before,.data-table-wrap tr[data-presented-row=true] td[data-cell-role=actions]::before{display:none}
.composition-collection .data-table-wrap:not([data-compact=scrollTable]) td{white-space:normal;overflow-wrap:anywhere}
.composition-collection .data-table-wrap:not([data-compact=scrollTable]) td[data-cell-role=actions]{display:flex;flex-direction:row;justify-content:space-between;align-items:center;flex-wrap:wrap}
.composition-collection .data-table-wrap:not([data-compact=scrollTable]) td[data-cell-role=actions] form{flex:1}
.composition-local-actions{display:flex;align-items:center}
.composition-local-actions button{width:100%;min-height:44px}
.composition-task-dialog:modal{inset:auto 0 0 0;margin:0;max-height:calc(100dvh - 56px);width:100vw;max-width:none;border-radius:10px 10px 0 0;border-left:0;border-right:0;border-bottom:0}
.composition-task-header,.composition-task-body{padding-left:16px;padding-right:16px}
.composition-task-footer{margin-left:-16px;margin-right:-16px;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));border-radius:0}
.composition-task-footer button{flex:1;min-height:44px}
.composition-task-dialog:not(:modal) .composition-task-footer{bottom:80px}
.data-table-wrap[data-compact=scrollTable]{overflow-x:auto}
.data-table-wrap[data-compact=scrollTable] table{display:table;width:100%}
.data-table-wrap[data-compact=scrollTable] tbody{display:table-row-group}
.data-table-wrap[data-compact=scrollTable] thead{display:table-header-group;position:static;width:auto;height:auto;overflow:visible;clip:auto}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true]{display:table-row;margin:0;padding:0;border:0;background:transparent}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true] td{display:table-cell;height:auto;padding:var(--row-y) 12px;border-bottom:1px solid var(--rule);text-align:left}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true] td[data-cell-role=quantity]{text-align:right}
.data-table-wrap[data-compact=scrollTable] tr[data-compact-card=true] td::before{display:none}
}
`;
