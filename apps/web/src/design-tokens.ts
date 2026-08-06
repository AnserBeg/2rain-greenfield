/**
 * The single token-definition block for every web surface.
 *
 * ADR-0035 decides the brand ramp (hue 199°), the chosen neutrals, the status
 * roles with `inProgress` shifted to indigo, the typographic scale, the 4 px
 * density grid, the motion contract and the designed dark mode. This file is
 * the only place in `apps/web/src` where a colour literal may appear: every
 * other site reads a `var(--…)`, and
 * `test/unit/web-surface-hex-literal-ratchet.test.ts` observes that from source.
 *
 * Two layers, deliberately:
 *   - **primitives** (`--b*`, `--n*`, `--s-*`) are the palette. Nothing outside
 *     this file names them.
 *   - **roles** (`--surface-*`, `--ink-*`, `--accent-*`, `--status-*`, …) are
 *     what the stylesheet consumes. Dark mode redefines roles only, never
 *     primitives, which is what makes it *designed* rather than inverted
 *     (ADR-0035 §10).
 *
 * The `token-definition-block` sentinels below are read by the ratchet. Keep
 * every literal between them.
 *
 * One role is defined and deliberately unconsumed. `--accent-tone` holds
 * ADR-0035 §2's `--b500` "hover on 600" step. A filled primary action carries
 * `--ink-on-accent` (white on light ground), and white on `#2196CF` measures
 * **3.32:1** — below the 4.5:1 floor plan §8.4 claims — while a 4.85 → 3.32
 * jump also breaks §9's "hover shifts the ground 2–3 %, never jumps". So the
 * filled hover moves *darker*, to `--accent-ground-hover`, and the ramp step
 * stays named here rather than silently dropped. Recorded in the U2 report.
 */
export const DESIGN_TOKENS = `
/* token-definition-block:start */
:root{
color-scheme:light dark;

--b50:#F1F9FE;--b100:#DCF0FB;--b200:#BAE3F8;--b300:#89CFF0;--b400:#4FB4E3;
--b500:#2196CF;--b600:#1478AE;--b700:#0F5F8C;--b900:#0B3A55;

--n0:#FFFFFF;--n50:#F6F8FA;--n100:#EDF1F5;--n200:#DFE5EC;--n300:#C6D0DA;
--n400:#94A3B2;--n500:#6B7A89;--n600:#4E5C6A;--n700:#37444F;--n800:#232E37;
--n900:#141C23;

--s-success-ink:#0A5C43;--s-success-ground:#E3F5EE;
--s-attention-ink:#8A5200;--s-attention-ground:#FEF3E2;
--s-blocked-ink:#912018;--s-blocked-ground:#FEE9E7;
--s-inprogress-ink:#3730A3;--s-inprogress-ground:#EEF0FE;

--surface-page:var(--n50);--surface-panel:var(--n0);--surface-sunken:var(--n100);
--surface-rail:var(--b900);--surface-rail-raised:var(--b700);
--ink:var(--n800);--ink-strong:var(--n900);--ink-muted:var(--n600);
--ink-on-accent:var(--n0);--ink-on-rail:var(--n0);--ink-on-rail-muted:var(--b200);
--line:var(--n200);--line-strong:var(--n300);--line-on-rail:var(--b700);
--brand:var(--b300);--focus-ring:var(--b300);--ink-on-brand:var(--b900);
--accent:var(--b600);--accent-ink:var(--b700);--accent-soft:var(--b50);
--accent-selected:var(--b100);--accent-edge:var(--b200);--accent-tone:var(--b500);
--accent-ground:var(--b600);--accent-ground-hover:var(--b700);
--accent-ground-pressed:var(--b900);
--status-success-ink:var(--s-success-ink);--status-success-ground:var(--s-success-ground);
--status-attention-ink:var(--s-attention-ink);--status-attention-ground:var(--s-attention-ground);
--status-blocked-ink:var(--s-blocked-ink);--status-blocked-ground:var(--s-blocked-ground);
--status-inprogress-ink:var(--s-inprogress-ink);--status-inprogress-ground:var(--s-inprogress-ground);
--skeleton-base:var(--n100);--skeleton-sheen:var(--n0);

--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--text-micro:10.5px;--text-code:11.5px;--text-body:12.5px;--text-base:13.5px;
--text-section:16px;--text-title:20px;
--weight-body:540;--weight-emphasis:650;

--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;
--space-6:24px;--space-8:32px;--space-10:40px;--space-12:48px;
--row-height:34px;--row-header-height:28px;--page-padding:18px;
--radius-control:6px;--radius-container:8px;

--motion-duration:140ms;--motion-easing:ease;
--shimmer-duration:2000ms;
--elevation-overlay:0 12px 32px rgba(11,58,85,.24);
}

@media (prefers-color-scheme:dark){
:root{
--surface-page:var(--n900);--surface-panel:var(--n800);--surface-sunken:var(--n700);
--surface-rail:var(--b900);--surface-rail-raised:var(--b700);
--ink:var(--n100);--ink-strong:var(--n0);--ink-muted:var(--n400);
--ink-on-accent:var(--n900);--ink-on-rail:var(--n0);--ink-on-rail-muted:var(--b200);
--line:var(--n700);--line-strong:var(--n600);--line-on-rail:var(--b700);
--brand:var(--b300);--focus-ring:var(--b300);--ink-on-brand:var(--b900);
--accent:var(--b400);--accent-ink:var(--b300);--accent-soft:#16303F;
--accent-selected:#123A4E;--accent-edge:var(--b700);--accent-tone:var(--b500);
--accent-ground:var(--b400);--accent-ground-hover:var(--b300);
--accent-ground-pressed:var(--b200);
--status-success-ink:#6FD9B4;--status-success-ground:#0B2E24;
--status-attention-ink:#F0BE68;--status-attention-ground:#33240A;
--status-blocked-ink:#F49B93;--status-blocked-ground:#3A1512;
--status-inprogress-ink:#A5A0F5;--status-inprogress-ground:#1F1B4D;
--skeleton-base:var(--n700);--skeleton-sheen:var(--n600);
--elevation-overlay:0 12px 32px rgba(0,0,0,.55);
}
}
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
