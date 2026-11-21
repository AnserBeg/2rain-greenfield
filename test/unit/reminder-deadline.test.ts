import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveReminderDeadline,
  type ReminderAnchor,
  type ReminderWorkingCalendar,
} from '../../packages/domain/src/communication/reminder-deadline.js';

const capture = {
  zone: 'America/Edmonton',
  tzdbVersion: 'capture-test-version',
};
const timed = (
  instant: string,
  civil: string,
): Extract<ReminderAnchor, { kind: 'instant' }> => ({
  ...capture,
  kind: 'instant',
  instant,
  civil,
});
const lead = { amount: 1, unit: 'civilDays' } as const;

test('Edmonton civil subtraction uses the first instant after a gap and the earlier offset in a fold', () => {
  const gap = timed('2026-03-09T08:30:00.000Z', '2026-03-09T02:30:00.000');
  const fold = timed('2026-11-02T08:30:00.000Z', '2026-11-02T01:30:00.000');
  assert.equal(
    resolveReminderDeadline(gap, lead).deadline,
    '2026-03-08T09:00:00.000Z',
  );
  assert.equal(
    resolveReminderDeadline(fold, lead).deadline,
    '2026-11-01T07:30:00.000Z',
  );
});

test('24 elapsed hours and one civil date resolve independently from the saved anchor', () => {
  const anchor = timed('2026-03-08T15:00:00.000Z', '2026-03-08T09:00:00.000');
  assert.deepEqual(resolveReminderDeadline(anchor, lead), {
    anchorInstant: anchor.instant,
    deadline: '2026-03-07T16:00:00.000Z',
    boundaryRule: 'ADR-0083/A1',
    anchorTzdbVersion: capture.tzdbVersion,
    tzdbVersion: process.versions.tz,
    zone: capture.zone,
  });
  assert.equal(
    resolveReminderDeadline(anchor, { amount: 24, unit: 'hours' }).deadline,
    '2026-03-07T15:00:00.000Z',
  );
});

test('working leads use the entire published horizon including Saturday work and a Monday holiday', () => {
  const calendar: ReminderWorkingCalendar = {
    calendarId: 'dispatch',
    revisionId: 'dispatch-9',
    from: '2026-03-03',
    through: '2026-03-10',
    workingDates: new Set(['2026-03-07', '2026-03-10', '2026-03-04']),
  };
  const anchor: ReminderAnchor = {
    ...capture,
    kind: 'date',
    endDate: '2026-03-10',
    zoneSource: {
      kind: 'companyBusinessCalendar',
      dayBoundary: '06:00:00.000',
    },
  };
  const working = { amount: 1, unit: 'workingDays' } as const;
  const result = resolveReminderDeadline(anchor, working, calendar);
  assert.equal(result.deadline, '2026-03-07T13:00:00.000Z');
  assert.deepEqual(result.workingCalendar, {
    calendarId: 'dispatch',
    revisionId: 'dispatch-9',
  });
  assert.throws(
    () => resolveReminderDeadline(anchor, working),
    /calendar.*anchor/iu,
  );
  assert.throws(
    () =>
      resolveReminderDeadline(anchor, working, {
        ...calendar,
        through: '2026-03-09',
      }),
    /calendar.*anchor/iu,
  );
  assert.throws(
    () =>
      resolveReminderDeadline(anchor, working, {
        ...calendar,
        from: '2026-03-08',
      }),
    /calendar.*lead/iu,
  );
  assert.throws(
    () =>
      resolveReminderDeadline(anchor, working, {
        ...calendar,
        from: '2026-03-11',
      }),
    /calendar.*anchor/iu,
  );
  assert.equal(
    resolveReminderDeadline(anchor, { ...working, amount: 2 }, calendar)
      .deadline,
    '2026-03-04T13:00:00.000Z',
  );
  assert.equal(
    resolveReminderDeadline(
      { ...anchor, zoneSource: { kind: 'perRecordIana' } },
      lead,
    ).deadline,
    '2026-03-09T06:00:00.000Z',
  );
});

test('refuse a missing capture and invalid leads', () => {
  const anchor = timed('2026-03-09T08:30:00.000Z', '2026-03-09T02:30:00.000');
  assert.throws(
    () => resolveReminderDeadline({ ...anchor, zone: '' }, lead),
    /captured zone/u,
  );
  const { tzdbVersion: _version, ...legacyCapture } = anchor;
  assert.equal(
    resolveReminderDeadline(legacyCapture, lead).tzdbVersion,
    process.versions.tz,
  );
  for (const amount of [0, -1, 1.5, 721, NaN])
    assert.throws(
      () => resolveReminderDeadline(anchor, { ...lead, amount }),
      /between 1 and 720/u,
    );
});

test('the earlier London overlap applies to a date-only boundary two civil days ahead', () => {
  const anchor: ReminderAnchor = {
    kind: 'date',
    endDate: '2026-10-27',
    zone: 'Europe/London',
    zoneSource: {
      kind: 'companyBusinessCalendar',
      dayBoundary: '01:30:00.000',
    },
  };
  assert.equal(
    resolveReminderDeadline(anchor, { amount: 2, unit: 'civilDays' }).deadline,
    '2026-10-25T00:30:00.000Z',
  );
});
