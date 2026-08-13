import { test, expect } from '@playwright/test';

const CONTROL_URL = '/?role=control';

// The default suite pre-seeds a "setup complete" flag; these tests override it
// with an empty storage state so the first-run modal actually appears.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('device setup modal', () => {
  test('shows on a fresh profile, completes with OK, and stays hidden on reload', async ({ page }) => {
    await page.goto(CONTROL_URL);

    const modal = page.locator('#device-setup-modal');
    await expect(modal).toBeVisible();

    // The fake-UI flag grants permission up front, so the selects are already
    // populated. Pick the first available audio and camera inputs.
    const audio = page.locator('#device-setup-modal-audio');
    await audio.selectOption({ index: 1 });
    const chosenAudio = await audio.inputValue();
    const video = page.locator('#device-setup-modal-video');
    await video.selectOption({ index: 1 });
    const chosenVideo = await video.inputValue();

    await page.locator('#device-setup-modal-ok').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('body')).toHaveClass(/is-control/);

    // Device selection now lives in the setup modal (opened from the header
    // menu), so reopening it reflects the chosen inputs.
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu-setup').click();
    await expect(page.locator('#device-setup-modal-audio')).toHaveValue(chosenAudio);
    await expect(page.locator('#device-setup-modal-video')).toHaveValue(chosenVideo);
    await page.locator('#device-setup-modal-close').click();

    // The completed flag persists: reloading does not re-show the modal.
    await page.reload();
    await expect(page.locator('#device-setup-modal')).toBeHidden();
  });

  test('initialize prompts for permission, then populates the selects', async ({ page }) => {
    // Simulate a profile where media permission has NOT been granted yet:
    // enumerateDevices returns devices with empty labels until getUserMedia
    // succeeds, after which labels become available.
    await page.addInitScript(() => {
      let granted = false;
      const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async (constraints) => {
          granted = true;
          return realGetUserMedia(constraints);
        },
      });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
        configurable: true,
        value: async () => [
          { kind: 'audioinput', deviceId: 'a1', label: granted ? 'Fake Mic' : '' },
          { kind: 'videoinput', deviceId: 'v1', label: granted ? 'Fake Cam' : '' },
        ],
      });
    });

    await page.goto(CONTROL_URL);

    const modal = page.locator('#device-setup-modal');
    await expect(modal).toBeVisible();

    // Without permission the Initialize prompt is shown and the selects are disabled.
    await expect(page.locator('#device-setup-modal-init')).toBeVisible();
    await expect(page.locator('#device-setup-modal-audio')).toBeDisabled();

    // Initialize grants permission, re-enumerates, and reveals the inputs.
    await page.locator('#device-setup-modal-init').click();
    await expect(page.locator('#device-setup-modal-audio option')).toHaveCount(2);
    await expect(page.locator('#device-setup-modal-audio')).toBeEnabled();
    await expect(page.locator('#device-setup-modal-notice')).toBeHidden();
  });

  test('dismissing with X leaves setup incomplete and re-shows on reload', async ({ page }) => {
    await page.goto(CONTROL_URL);

    const modal = page.locator('#device-setup-modal');
    await expect(modal).toBeVisible();

    await page.locator('#device-setup-modal-close').click();
    await expect(modal).toBeHidden();

    // Not completed → the modal comes back after a reload.
    await page.reload();
    await expect(page.locator('#device-setup-modal')).toBeVisible();
  });

  test('a profile with both devices already saved is treated as complete', async ({ page }) => {
    // Pre-seed both device ids (as if a previous run had selected them) without
    // the completion flag; the modal must backfill the flag and stay hidden.
    await page.addInitScript(() => {
      localStorage.setItem('viz2_audio_device_id', 'previously-saved-audio');
      localStorage.setItem('viz2_video_device_id', 'previously-saved-video');
    });
    await page.goto(CONTROL_URL);

    // The backfill happens asynchronously after the singleton/init handshake.
    await page.waitForFunction(() => localStorage.getItem('viz2_device_setup_done') === '1');
    await expect(page.locator('#device-setup-modal')).toBeHidden();
  });
});
