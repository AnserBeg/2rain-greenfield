/** Date fields and midnight-UTC business values use UTC calendar components. */
export function readCivilDate(
  kind: string | undefined,
  value: string,
): Date | null {
  if (kind === 'dateFieldType') {
    if (
      !/^\d{4}-\d{2}-\d{2}(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:00)?)?$/u.test(
        value,
      )
    )
      return null;
    const day = value.slice(0, 10);
    const date = new Date(day + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === day
      ? date
      : null;
  }
  if (kind === 'dateTimeFieldType') {
    const date = new Date(value);
    if (date.getTime() % 86_400_000 === 0) return date;
  }
  return null;
}
