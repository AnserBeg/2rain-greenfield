/**
 * The single token-definition block for every web surface: the Ledger look
 * (owner ruling 2026-11-17, `docs/design/ledger-spec.md` §1, §3 and §4).
 *
 * The spec's names are the tokens: grounds (`--paper`, `--side`, `--sheet`,
 * `--sunk`, `--hover`), inks (`--ink`, `--ink-2`, `--muted`, `--faint`), rules
 * (`--rule`, `--rule-2`), one deep teal accent and three status families, each
 * with a soft ground. Accent means "you can act / in motion"; success means
 * "done"; they never share a meaning, so the in-progress status rides the
 * accent family and the other three stay outside its hue.
 *
 * This file is the only place in `apps/web/src` where a colour literal may
 * appear: every other site reads a `var(--…)`, and
 * `test/unit/web-surface-hex-literal-ratchet.test.ts` observes that from
 * source. The `token-definition-block` sentinels below are read by the ratchet
 * and by the architecture suite's contrast check. Keep every literal between
 * them.
 *
 * Dark is designed, never inverted (ADR-0035 §10): it redefines the spec's
 * tokens under `prefers-color-scheme: dark` guarded by
 * `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`.
 * Density: `:root` holds compact; `:root[data-density="comfortable"]`
 * overrides only the density tokens. Nothing sets either attribute yet.
 *
 * The status role names (`--status-*-ink` / `--status-*-ground`) resolve to
 * the spec's tokens, so dark mode moves them by moving the spec tokens.
 *
 * Prose names tokens, never literals — a hex in this comment would sit outside
 * the block below and fail the ratchet.
 */
export const DESIGN_TOKENS = `
/* token-definition-block:start */
:root{
color-scheme:light dark;

--paper:#F5F5F2;--side:#EDEDE9;--sheet:#FFFFFF;--sunk:#F3F3EF;--hover:#E8E8E3;
--ink:#17191C;--ink-2:#40454B;--muted:#6B7077;--faint:#A1A5AA;
--rule:#E3E3DE;--rule-2:#CDCDC7;
--accent:#0E6670;--accent-hover:#0A525A;--on-accent:#FFFFFF;
--accent-soft:#E1EEF0;--accent-text:#0C5E67;
--success:#2E7A2F;--success-soft:#E4F2E1;
--attention:#8A5300;--attention-soft:#F9EED5;
--blocked:#A3261B;--blocked-soft:#FAE8E5;
--scrim:rgba(23,25,28,.38);
--shadow-dlg:0 20px 50px rgba(23,25,28,.22),0 2px 8px rgba(23,25,28,.08);
--shadow-bar:0 -6px 18px rgba(23,25,28,.06);

--status-success-ink:var(--success);--status-success-ground:var(--success-soft);
--status-attention-ink:var(--attention);--status-attention-ground:var(--attention-soft);
--status-blocked-ink:var(--blocked);--status-blocked-ground:var(--blocked-soft);
--status-inprogress-ink:var(--accent-text);--status-inprogress-ground:var(--accent-soft);
--skeleton-base:var(--sunk);--skeleton-sheen:var(--sheet);
--focus-ring-surface:var(--accent);--focus-ring-rail:var(--accent);

--f-ui:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--f-doc:"IBM Plex Serif",Georgia,"Times New Roman",serif;
--f-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

--row-y:8px;--ctl-h:30px;--nav-h:30px;--gap:18px;--pad-x:14px;--sheet-y:26px;--sheet-x:30px;
--side-w:212px;--rail-w:300px;--page-max:1240px;--gutter:28px;

--motion-duration:120ms;--motion-easing:ease;
--shimmer-duration:2000ms;
}
:root[data-density="comfortable"]{
--row-y:12px;--ctl-h:36px;--nav-h:34px;--gap:26px;--pad-x:18px;--sheet-y:34px;--sheet-x:40px;
}

@media (prefers-color-scheme:dark){
:root:not([data-theme="light"]){
--paper:#131416;--side:#17181B;--sheet:#1B1D20;--sunk:#202226;--hover:#272A2E;
--ink:#E8E8E4;--ink-2:#C3C5C8;--muted:#92969C;--faint:#666A70;
--rule:#2B2E32;--rule-2:#3B3F44;
--accent:#4FB0BB;--accent-hover:#68C0CA;--on-accent:#071A1D;
--accent-soft:#12303A;--accent-text:#80CCD5;
--success:#86CF84;--success-soft:#1A3119;
--attention:#E2B25E;--attention-soft:#33280F;
--blocked:#F1907F;--blocked-soft:#3A1D19;
--scrim:rgba(0,0,0,.6);
--shadow-dlg:0 20px 50px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);
--shadow-bar:0 -6px 18px rgba(0,0,0,.35);
}
}
:root[data-theme="dark"]{
color-scheme:dark;
--paper:#131416;--side:#17181B;--sheet:#1B1D20;--sunk:#202226;--hover:#272A2E;
--ink:#E8E8E4;--ink-2:#C3C5C8;--muted:#92969C;--faint:#666A70;
--rule:#2B2E32;--rule-2:#3B3F44;
--accent:#4FB0BB;--accent-hover:#68C0CA;--on-accent:#071A1D;
--accent-soft:#12303A;--accent-text:#80CCD5;
--success:#86CF84;--success-soft:#1A3119;
--attention:#E2B25E;--attention-soft:#33280F;
--blocked:#F1907F;--blocked-soft:#3A1D19;
--scrim:rgba(0,0,0,.6);
--shadow-dlg:0 20px 50px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);
--shadow-bar:0 -6px 18px rgba(0,0,0,.35);
}
:root[data-theme="light"]{color-scheme:light}
/* token-definition-block:end */
`;

/**
 * The sentinel pair the ratchet uses to locate the token-definition block, kept
 * here so the gate reads the same two strings this file emits rather than a
 * hand-copied pair that can drift.
 */
export const TOKEN_DEFINITION_BLOCK = Object.freeze({
  end: '/* token-definition-block:end */',
  sourceFile: 'apps/web/src/design-tokens.ts',
  start: '/* token-definition-block:start */',
} as const);
