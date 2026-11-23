/**
 * A browser map provider's frame document, served on the dedicated display
 * origin. Each provider adapter registers its own under the document name
 * its connector descriptor declares; generic code names no provider.
 */
export interface MapFrameDocument {
  document(app: URL): string;
  csp(app: URL): string;
}

// A sandbox with an opaque origin drops HTTP referrers. A dedicated host
// gives the map provider the restricted display origin and isolates the ERP
// document.
export function mapDisplayOrigins(
  app: string | undefined,
  maps: string | undefined,
) {
  if (!app && !maps) return;
  if (!app || !maps)
    throw new Error('Configure both the application and map display origins.');
  const a = new URL(app),
    m = new URL(maps);
  if (
    (a.protocol !== 'https:' &&
      !(
        a.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(a.hostname)
      )) ||
    m.protocol !== 'https:' ||
    a.hostname === m.hostname ||
    [a, m].some((url) => url.href !== url.origin + '/')
  ) {
    throw new Error(
      'Configure separate application and HTTPS map display origins.',
    );
  }
  return { app: a, maps: m };
}
