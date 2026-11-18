/**
 * One POSIX shell word for any text: single-quoted, with each embedded
 * quote closed, escaped and reopened, so nothing in it is expanded when the
 * printed command is pasted into a shell (end review X15).
 */
export function posixQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
