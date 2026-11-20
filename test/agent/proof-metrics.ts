type Group = 'first-party' | 'generated';

interface Attempt {
  task: number;
  attempt: number;
  pass: boolean;
  timing?: { cardSeconds: number | null; elapsedSeconds: number };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function distribution(values: number[]) {
  const center = median(values);
  return {
    median: center,
    mad: median(values.map((v) => Math.abs(v - center))),
  };
}

/** Compare equal-weight task medians. Use repeat variation within a task
 * to measure timing noise, so different journey lengths cannot inflate it. */
export function measureParity(
  declarations: readonly { id: number; group: Group }[],
  rows: readonly Attempt[],
) {
  const tasks = declarations.map(({ id, group }) => {
    const runs = rows.filter((r) => r.task === id);
    const cards = runs.flatMap((r) =>
      r.timing?.cardSeconds == null ? [] : [r.timing.cardSeconds],
    );
    const elapsed = runs.flatMap((r) =>
      r.timing ? [r.timing.elapsedSeconds] : [],
    );
    return {
      id,
      group,
      attempts: runs.length,
      passed: runs.filter((r) => r.pass).length,
      complete:
        runs.length >= 3 &&
        new Set(runs.map((r) => r.attempt)).size === runs.length &&
        cards.length === runs.length &&
        elapsed.length === runs.length &&
        [...cards, ...elapsed].every((s) => Number.isFinite(s) && s >= 0),
      card: distribution(cards),
      elapsed: distribution(elapsed),
    };
  });
  function cohort(group: Group) {
    const members = tasks.filter((t) => t.group === group);
    return {
      attempts: members.reduce((n, t) => n + t.attempts, 0),
      passed: members.reduce((n, t) => n + t.passed, 0),
      card: median(members.map((t) => t.card.median)),
      elapsed: median(members.map((t) => t.elapsed.median)),
    };
  }
  const first = cohort('first-party');
  const generated = cohort('generated');
  const spread = {
    card: median(tasks.map((t) => t.card.mad)),
    elapsed: median(tasks.map((t) => t.elapsed.mad)),
  };
  const complete =
    first.attempts > 0 &&
    generated.attempts === first.attempts &&
    tasks.every(
      (t) => t.complete && t.passed > 0 && t.attempts === tasks[0]!.attempts,
    );
  const pass =
    complete &&
    generated.passed >= first.passed &&
    generated.card <= first.card + spread.card &&
    generated.elapsed <= first.elapsed + spread.elapsed;
  return { pass, complete, first, generated, spread, tasks };
}
