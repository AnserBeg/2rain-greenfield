import { expect, type Locator } from '@playwright/test';

/** Follow the stages the compiled task offers; its result is checked by the caller. */
export async function completeTask(
  dialog: Locator,
  label: string,
): Promise<void> {
  await expect(dialog).toBeVisible();
  const apply = dialog.locator(
    'footer button[name="taskStage"][value="apply"]',
  );
  if (await apply.count()) {
    await expect(apply).toHaveText(label);
    await apply.click();
    return;
  }
  const review = dialog.getByRole('button', {
    name: `Review ${label}`,
    exact: true,
  });
  if (await review.isVisible()) await review.click();
  await dialog.locator('button[name="taskStage"][value="confirm"]').click();
}
