import { expect, type Locator, type Page } from '@playwright/test';

/** Read the server preparation in place, or use the ordinary page review. */
export async function reviewTask(
  dialog: Locator,
  reviewName: string,
  click: (target: Locator) => Promise<void> = async (target) => {
    await target.click();
  },
): Promise<void> {
  await expect(dialog).toBeVisible();
  if (
    (await dialog.page().locator('body[data-task-stages-enhanced]').count()) &&
    (await dialog.locator('form[data-task-live-review]').count())
  ) {
    await expect(
      dialog.locator('[data-task-inline-review] [data-task-prepared]'),
    ).toBeVisible();
  } else {
    await click(dialog.getByRole('button', { name: reviewName, exact: true }));
  }
}

/** A verified fragment already returned here; page-only tasks keep their Back link. */
export async function returnToRecord(page: Page): Promise<void> {
  const dialog = page.locator('[data-composition-task]');
  if (await dialog.count()) {
    await dialog
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
  } else {
    await expect(page.locator('[data-task-result]')).toBeVisible();
  }
}

/** Follow the stages the compiled task offers; its result is checked by the caller. */
export async function completeTask(
  dialog: Locator,
  label: string,
  click: (target: Locator) => Promise<void> = async (target) => {
    await target.click();
  },
): Promise<void> {
  await expect(dialog).toBeVisible();
  const apply = dialog.locator(
    'footer button[name="taskStage"][value="apply"]',
  );
  if (await apply.count()) {
    await expect(apply).toHaveText(label);
    await click(apply);
    return;
  }
  await reviewTask(dialog, `Review ${label}`, click);
  await click(dialog.locator('button[name="taskStage"][value="confirm"]'));
}
