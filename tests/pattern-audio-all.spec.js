import { expect, test } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';
const RETIRED_FULL_FRAME_TYPE = ['analysis', 'frame'].join('-');
const RAW_DIAGNOSTIC_FIELDS = ['rawFramesSent', 'rawFramesSkipped', 'rawBytes'];

async function installSyntheticCapture(control) {
  await control.evaluate(() => {
    const frame = {
      left: new Float32Array(1024).fill(-48),
      right: new Float32Array(1024).fill(-47),
      waveformLeft: new Float32Array(2048).fill(0.1),
      waveformRight: new Float32Array(2048).fill(-0.1),
      sampleRate: 48_000,
      fftSize: 2_048,
      time: 1,
    };
    window.__viz.captureAudio.isStarted = true;
    window.__viz.captureAudio.getAnalysisFrame = () => frame;
  });
}

async function waitForFreshSlot(page, patternId) {
  await page.waitForFunction((id) => {
    const slots = window.__viz.patternAudio?.store?.slots || {};
    return Object.values(slots).some((slot) => slot.patternId === id && slot.fresh);
  }, patternId, { timeout: 10_000 });
}

test.describe('all-pattern controls-only audio transport', () => {
  test('runs every embedded preview through controls and never posts a retired full-frame message', async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      const originalPostMessage = BroadcastChannel.prototype.postMessage;
      window.__patternAudioBroadcastTypes = [];
      BroadcastChannel.prototype.postMessage = function postMessageWithProbe(message) {
        if (typeof message?.type === 'string' && !window.__patternAudioBroadcastTypes.includes(message.type)) {
          window.__patternAudioBroadcastTypes.push(message.type);
        }
        return originalPostMessage.call(this, message);
      };
    });

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 640, height: 420 });
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.audioOwner);
    await installSyntheticCapture(page);

    const patternIds = await page.locator('#pattern-library .pattern-btn').evaluateAll((buttons) => buttons.map((button) => button.dataset.id));
    expect(patternIds).toHaveLength(58);
    expect(new Set(patternIds).size).toBe(58);

    for (const patternId of patternIds) {
      await page.locator(`#pattern-library [data-id="${patternId}"]`).click();
      await expect(page.locator(`#preview-stage canvas[data-preview-sketch="${patternId}"]`)).toBeVisible({ timeout: 10_000 });
      await waitForFreshSlot(page, patternId);
    }

    // Give the capture loop several more ticks after the final selection.
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => ({
      engine: window.__viz.patternAudio?.engine,
      messageTypes: window.__patternAudioBroadcastTypes || [],
    }));

    expect(result.engine.controllerErrors).toBe(0);
    expect(result.engine.controlPackets).toBeGreaterThan(0);
    for (const field of RAW_DIAGNOSTIC_FIELDS) expect(result.engine).not.toHaveProperty(field);
    expect(result.messageTypes).not.toContain(RETIRED_FULL_FRAME_TYPE);
    expect(pageErrors).toEqual([]);
  });

  test('representative LIVE patterns stay fresh without screen audio-facade reads', async ({ context, page }) => {
    test.setTimeout(90_000);
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);
    await installSyntheticCapture(control);

    await page.evaluate(() => {
      const provider = window.__viz.audio;
      window.__allPatternFacadeCalls = {};
      for (const name of ['getAnalysisFrame', 'getFrequencies', 'getWaveforms', 'getAmplitudes']) {
        provider[name] = () => {
          window.__allPatternFacadeCalls[name] = (window.__allPatternFacadeCalls[name] || 0) + 1;
          return null;
        };
      }
    });

    const patternIds = ['bars', 'event-horizon', 'video-kaleido', 'glitch-crt', 'neon-ribbons'];
    const freshness = [];
    for (const patternId of patternIds) {
      await control.locator(`#pattern-library [data-id="${patternId}"]`).click();
      await page.waitForFunction((id) => window.__viz.patternId === id, patternId, { timeout: 10_000 });
      await expect(page.locator('[data-program-role="live"] canvas').first()).toBeVisible({ timeout: 10_000 });
      await waitForFreshSlot(page, patternId);
      freshness.push(await page.evaluate((id) => {
        const slots = window.__viz.patternAudio?.store?.slots || {};
        return Object.values(slots).some((slot) => slot.patternId === id && slot.fresh);
      }, patternId));
    }

    const result = await Promise.all([
      page.evaluate(() => window.__allPatternFacadeCalls),
      control.evaluate(() => window.__viz.patternAudio?.engine),
    ]);
    expect(freshness).toEqual(patternIds.map(() => true));
    expect(Object.values(result[0])).toEqual([]);
    expect(result[1].controllerErrors).toBe(0);
    for (const field of RAW_DIAGNOSTIC_FIELDS) expect(result[1]).not.toHaveProperty(field);
  });
});
