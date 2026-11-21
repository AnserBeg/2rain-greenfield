import { BillingCalendar, hourMs, instant, iso } from '../billing/calendar.js';

/** The governed anchor query supplies the entered civil value and the capture.
 * For an inclusive date interval, endDate is its last entered date. */
export type ReminderAnchor = {
  zone: string;
  tzdbVersion: string;
} & (
  | { kind: 'instant'; instant: string; civil: string }
  | {
      kind: 'date';
      endDate: string;
      zoneSource:
        | { kind: 'perRecordIana' }
        | { kind: 'companyBusinessCalendar'; dayBoundary: string };
    }
);

/** A missing date inside the published horizon is explicitly non-working. */
export interface ReminderWorkingCalendar {
  calendarId: string;
  revisionId: string;
  from: string;
  through: string;
  workingDates: ReadonlySet<string>;
}

export type ReminderLead = {
  amount: number;
  unit: 'hours' | 'civilDays' | 'workingDays';
};

const dayMs = 24 * hourMs;

export function resolveReminderDeadline(
  anchor: ReminderAnchor,
  lead: ReminderLead,
  calendar?: ReminderWorkingCalendar,
) {
  if (
    !Number.isSafeInteger(lead.amount) ||
    lead.amount < 1 ||
    lead.amount > 720
  )
    throw new RangeError('Reminder lead must be between 1 and 720');
  if (!anchor.zone || !anchor.tzdbVersion)
    throw new Error('Reminder requires a captured zone and tzdb version');

  const local =
    anchor.kind === 'instant'
      ? anchor.civil
      : anchor.endDate +
        'T' +
        (anchor.zoneSource.kind === 'perRecordIana'
          ? '00:00:00.000'
          : anchor.zoneSource.dayBoundary);
  const wall = instant(local + 'Z');
  // Start the resolver at the saved instant for a timed value. A date-only
  // capture supplies wall coordinates, so its boundary must be resolved too.
  const resolver = new BillingCalendar(
    anchor.kind === 'instant' ? instant(anchor.instant) : wall - 2 * dayMs,
    anchor.zone,
  );
  const anchorMs =
    anchor.kind === 'instant'
      ? instant(anchor.instant)
      : resolver.resolve(wall);
  let due: number;
  let calendarPin;
  switch (lead.unit) {
    case 'hours':
      due = anchorMs - lead.amount * hourMs;
      break;
    case 'civilDays':
      due = resolver.resolve(wall - lead.amount * dayMs);
      break;
    case 'workingDays': {
      const anchorDate = local.slice(0, 10);
      if (
        !calendar ||
        anchorDate > calendar.through ||
        anchorDate < calendar.from
      )
        throw new Error('Working calendar does not cover reminder anchor');
      const priorDates = [...calendar.workingDates]
        .filter((date) => date >= calendar.from && date < anchorDate)
        .sort();
      const date = priorDates.at(-lead.amount);
      if (!date)
        throw new Error('Working calendar does not cover reminder lead');
      due = resolver.resolve(instant(date + local.slice(10) + 'Z'));
      calendarPin = {
        calendarId: calendar.calendarId,
        revisionId: calendar.revisionId,
      };
      break;
    }
  }
  return {
    anchorInstant: iso(anchorMs),
    deadline: iso(due),
    zone: anchor.zone,
    anchorTzdbVersion: anchor.tzdbVersion,
    tzdbVersion: process.versions.tz,
    boundaryRule: 'ADR-0083/A1' as const,
    ...(calendarPin && { workingCalendar: calendarPin }),
  };
}
