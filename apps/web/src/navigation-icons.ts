import type { NavigationIcon } from '../../../packages/canonical-model/src/index.js';

/**
 * Real icons instead of a destination's first letter (LOOP-1), chosen by what
 * the destination is -- a group, a launcher of the day's work, a List, or a
 * page -- never by which module or entity it is: inline SVG, no dependency.
 */
export const svgIcon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths}</svg>`;
export const NAVIGATION_ICONS = Object.freeze({
  group: svgIcon('<path d="M3 7h7l2 2h9v10H3z"/>'),
  launcher: svgIcon(
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  ),
  list: svgIcon(
    '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  ),
  page: svgIcon('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>'),
  queue: svgIcon(
    '<path d="M4 13l2.5-7h11L20 13"/><path d="M4 13v6h16v-6h-5l-1 2h-4l-1-2z"/>',
  ),
  search: svgIcon('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
});
/**
 * The language's closed icon set (LOOK-1), drawn as inline SVG: a module,
 * destination or queue that declares one shows it; one that declares none
 * falls back to what it is (a launcher, a List, a page).
 */
export const DECLARED_ICONS: Readonly<Record<NavigationIcon, string>> =
  Object.freeze({
    home: svgIcon('<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>'),
    inbox: NAVIGATION_ICONS.queue,
    truck: svgIcon(
      '<path d="M3 6h11v10H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    ),
    invoice: svgIcon(
      '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    ),
    cart: svgIcon(
      '<path d="M3 4h2l2 11h11l2-8H6.5"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
    ),
    receipt: svgIcon(
      '<path d="M5 3h14v18H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    ),
    tag: svgIcon(
      '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
    ),
    box: svgIcon(
      '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    ),
    boxes: svgIcon('<path d="M3 12h8v8H3zM13 12h8v8h-8zM8 4h8v8H8z"/>'),
    transfer: svgIcon('<path d="M4 8h14l-3-3M20 16H6l3 3"/>'),
    users: svgIcon(
      '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 010 5.5M18 14.5c2 .8 3 2.8 3 5.5"/>',
    ),
    building: svgIcon(
      '<path d="M4 21V4h11v17M15 9h5v12M2 21h20"/><path d="M8 8h3M8 12h3M8 16h3"/>',
    ),
    location: svgIcon(
      '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    ),
    settings: svgIcon(
      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    ),
    chart: svgIcon(
      '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
    ),
    clipboard: svgIcon(
      '<path d="M8 4h8v3H8z"/><path d="M16 5h3v16H5V5h3"/><path d="M9 12l2 2 4-4"/>',
    ),
    lock: svgIcon(
      '<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    ),
    calculator: svgIcon(
      '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
    ),
    wrench: svgIcon(
      '<path d="M15 4a5 5 0 00-4.6 6.9L4 17.3V20h2.7l6.4-6.4A5 5 0 0020 9l-3 1-2-2 1-3z"/>',
    ),
    alert: svgIcon('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
  });
/** A declared icon's drawing; null when none is declared. */
export function declaredIcon(name: string | undefined): string | null {
  return name !== undefined && Object.hasOwn(DECLARED_ICONS, name)
    ? DECLARED_ICONS[name as NavigationIcon]
    : null;
}
