import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

async function openScreenAndControl(context, screen) {
  await screen.goto(SCREEN_URL);
  const control = await context.newPage();
  await control.goto(CONTROL_URL);
  await expect(control.locator('#status-line .badge-online')).toBeVisible();
  await control.waitForFunction(() => window.__viz.audioOwner);
  return control;
}

async function selectAudioInput(control) {
  // Device selection lives in the setup modal (header menu → Setup).
  await control.locator('#app-menu-btn').click();
  await control.locator('#app-menu-setup').click();
  const audio = control.locator('#device-setup-modal-audio');
  await audio.waitFor({ state: 'visible' });
  // Fake media flags grant permission up front, so the select is populated.
  const selectedId = await audio.locator('option').nth(1).getAttribute('value');
  await audio.selectOption(selectedId);
  await control.locator('#device-setup-modal-ok').click();
  return selectedId;
}

test.describe('audio input lifecycle', () => {
  test('the control starts the selected input, feeds its EQ, and sends frames to the screen', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);

    await expect(control.locator('#band-eq-idle')).toHaveText('Select an audio input in Setup.');
    const selectedId = await selectAudioInput(control);
    expect(selectedId).toBeTruthy();

    await control.waitForFunction((deviceId) => (
      window.__viz.audioOwner
      && window.__viz.audioDeviceId === deviceId
      && window.__viz.audioStatus.status === 'running'
      && window.__viz.captureAudio.isStarted
    ), selectedId);
    await control.waitForFunction(() => (window.__viz.eq?.drawn ?? 0) > 1);
    await page.waitForFunction(() => window.__viz.audio.isStarted);
    expect(await page.evaluate(() => window.__viz.captureAudio.isStarted)).toBe(false);
    await expect(control.locator('#band-eq-idle')).toBeHidden();
  });

  test('second control is singleton-blocked and becomes active when the first closes', async ({ context, page }) => {
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz && !window.__viz.singletonBlocked && window.__viz.audioOwner);

    const second = await context.newPage();
    await second.goto(CONTROL_URL);
    await expect(second.locator('#singleton-error')).toBeVisible({ timeout: 7000 });
    await expect(second.locator('#config-panel')).toHaveCount(0);

    await page.close();
    await second.reload();
    await expect(second.locator('#config-panel')).toBeVisible({ timeout: 7000 });
    await second.waitForFunction(() => window.__viz && window.__viz.audioOwner);
  });

  test('a control-panel click resumes suspended Web Audio and restores the EQ feed', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);

    await control.evaluate(() => {
      const sampleRate = 48_000;
      const fftSize = 2_048;
      const bins = fftSize / 2;
      const analyser = () => ({
        frequencyBinCount: bins,
        getFloatFrequencyData: (target) => target.fill(-58),
        getFloatTimeDomainData: (target) => target.fill(0.04),
        getByteFrequencyData: (target) => target.fill(120),
        getByteTimeDomainData: (target) => target.fill(133),
      });
      const context = {
        state: 'suspended',
        sampleRate,
        currentTime: 0,
        onstatechange: null,
      };
      const audio = window.__viz.captureAudio;
      audio.audioContext = context;
      audio.analyserL = analyser();
      audio.analyserR = analyser();
      audio.requestedDeviceId = 'test-input';
      audio.activeDeviceId = 'test-input';
      audio.isStarted = true;
      audio.allocateBuffers();
      window.__resumeCalls = [];
      audio.resume = (force = false) => {
        window.__resumeCalls.push(force);
        if (force) {
          context.state = 'running';
          audio.reportContextStatus();
        }
        return Promise.resolve();
      };
      audio.reportStatus('suspended');
    });

    await expect(control.locator('#band-eq-idle')).toHaveText('Click this control panel to enable audio.');
    await control.locator('#preview-stage').click({ position: { x: 20, y: 20 } });

    await control.waitForFunction(() => (
      window.__viz.captureAudio.getState() === 'running'
      && window.__resumeCalls.includes(true)
    ));
    await control.waitForFunction(() => (window.__viz.eq?.drawn ?? 0) > 1);
    await expect(control.locator('#band-eq-idle')).toBeHidden();
  });

  test('a denied microphone reports the real blocker instead of waiting forever', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);

    const started = await control.evaluate(async () => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          throw new DOMException('Permission denied for test', 'NotAllowedError');
        },
      });
      return window.__viz.captureAudio.startStream('blocked-input');
    });

    expect(started).toBe(false);
    await expect(control.locator('#band-eq-idle')).toHaveText(
      'Microphone access denied. Re-initialize Setup.',
    );
    expect(await control.evaluate(() => window.__viz.audioStatus.error?.name)).toBe('NotAllowedError');
  });

  test('a stale selected device falls back to the default audio input', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);

    const started = await control.evaluate(async () => {
      const mediaDevices = navigator.mediaDevices;
      const realGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      window.__getUserMediaConstraints = [];
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async (constraints) => {
          window.__getUserMediaConstraints.push(constraints);
          if (constraints?.audio?.deviceId?.exact) {
            throw new DOMException('Selected device is gone', 'OverconstrainedError');
          }
          return realGetUserMedia(constraints);
        },
      });
      return window.__viz.captureAudio.startStream('stale-device-id');
    });

    expect(started).toBe(true);
    await control.waitForFunction(() => window.__viz.audioStatus.status === 'running');
    const result = await control.evaluate(() => ({
      status: window.__viz.audioStatus,
      calls: window.__getUserMediaConstraints,
    }));
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].audio.deviceId.exact).toBe('stale-device-id');
    expect(result.calls[1].audio.deviceId).toBeUndefined();
    expect(result.status.fallback).toBe(true);
    await control.waitForFunction(() => (window.__viz.eq?.drawn ?? 0) > 1);
    await expect(control.locator('#band-eq-idle')).toBeHidden();
  });
});
