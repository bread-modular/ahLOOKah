import { expect } from '@playwright/test';

export async function folderDetails(page, category) {
  await page.getByRole('button', { name: `${category}: Linked`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${category} folder details` });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function folderAction(page, category, action) {
  const dialog = await folderDetails(page, category);
  await dialog.getByRole('button', { name: action, exact: true }).click();
  if (action !== 'Unlink folder') await dialog.getByRole('button', { name: 'Close folder details' }).click();
}
