/**
 * Pure answer rules for the pre-registered tasks: no database, no world, so
 * the shared-lease unit suite can import them.
 */

/** Every number written in the answer, commas and currency signs ignored. */
export function numbersIn(answer: string): number[] {
  return [...answer.replaceAll(',', '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(
    (match) => Number(match[0]),
  );
}

/**
 * Task 3's answer rule v2 (registered 2026-11-17): both unpaid invoices named,
 * the total balance stated, and the paid invoice either absent or named in a
 * clause that says it is paid and does not call it unpaid or outstanding. A
 * clause is a line or a sentence (a period between digits does not end one).
 */
export function task3AnswerFailures(
  answer: string,
  context: { paid: string; unpaid: readonly string[]; balance: number },
): string[] {
  const failures: string[] = [];
  for (const number of context.unpaid)
    if (!answer.includes(number)) failures.push(`the answer omits ${number}`);
  for (const clause of answer.split(/\n|;|(?<!\d)\.|\.(?!\d)/u))
    if (
      clause.includes(context.paid) &&
      (!/\b(?:paid|settled)\b/iu.test(clause) ||
        /\b(?:unpaid|not paid)\b/iu.test(clause))
    )
      failures.push(`the answer lists the paid ${context.paid} as unpaid`);
  if (!numbersIn(answer).some((n) => Math.abs(n - context.balance) < 0.005))
    failures.push(`the answer does not state ${String(context.balance)}`);
  return failures;
}
