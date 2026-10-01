/** Fixture selection, used only by compositions explicitly in LOCAL_DEMO mode. */
export const LOCAL_DEMO_ACTORS = ['buyer', 'manager'] as const;
export type LocalDemoActor = (typeof LOCAL_DEMO_ACTORS)[number];
export function localDemoActor(
  cookie: string | readonly string[] | undefined,
): LocalDemoActor {
  return typeof cookie === 'string' &&
    cookie
      .split(';')
      .some((part) => part.trim() === 'northstar-demo-actor=manager')
    ? 'manager'
    : 'buyer';
}
