import { expect, test } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

// These tests use deterministic spectra rather than a browser microphone. They
// exercise the same Hz mapping, stereo mix, adaptive gain and onset envelopes
// that receive the live AudioManager frames in production.
test.describe('musical audio feature extraction', () => {
  test('separates kick, mid and hat hits across sample rates and stereo channels', async ({ page }) => {
    await page.goto(SCREEN_URL);

    const result = await page.evaluate(async () => {
      const { makeAudioFeatures } = await import('/src/sketches/audio-features.js');

      const runHit = (range, { sampleRate = 48000, rightOnly = false } = {}) => {
        const fftSize = 2048;
        const bins = fftSize / 2;
        const makeFrame = (active = false) => {
          const left = new Float32Array(bins).fill(-92);
          const right = new Float32Array(bins).fill(-92);
          if (active) {
            const binHz = sampleRate / fftSize;
            const start = Math.ceil(range[0] / binHz);
            const end = Math.floor(range[1] / binHz);
            for (let i = start; i <= end; i++) {
              if (!rightOnly) left[i] = -20;
              right[i] = -20;
            }
          }
          return { left, right, sampleRate, fftSize, rms: 0.1 };
        };

        const analyse = makeAudioFeatures();
        for (let i = 0; i < 8; i++) analyse(makeFrame(false), {}, 1 / 60);
        const hit = analyse(makeFrame(true), {}, 1 / 60);
        let settled = hit;
        for (let i = 0; i < 45; i++) settled = analyse(makeFrame(true), {}, 1 / 60);
        return { hit, settled };
      };

      return {
        kick44: runHit([40, 145], { sampleRate: 44100 }),
        kick96: runHit([40, 145], { sampleRate: 96000 }),
        snare: runHit([350, 2200]),
        rightHat: runHit([6000, 12000], { rightOnly: true }),
      };
    });

    for (const key of ['kick44', 'kick96']) {
      expect(result[key].hit.kick).toBeGreaterThan(0.75);
      expect(result[key].hit.beat).toBeGreaterThan(0.9);
      expect(result[key].hit.sub).toBeGreaterThan(result[key].hit.mid + 0.3);
      expect(result[key].settled.kick).toBeLessThan(0.05);
    }
    expect(result.snare.hit.snare).toBeGreaterThan(0.75);
    expect(result.snare.hit.mid).toBeGreaterThan(result.snare.hit.sub + 0.3);
    expect(result.snare.settled.snare).toBeLessThan(0.05);
    expect(result.rightHat.hit.hat).toBeGreaterThan(0.75);
    expect(result.rightHat.hit.high).toBeGreaterThan(result.rightHat.hit.mid + 0.3);
    expect(result.rightHat.settled.hat).toBeLessThan(0.05);
  });

  test('gates silent inputs and keeps sustained levels separate from transient punch', async ({ page }) => {
    await page.goto(SCREEN_URL);

    const result = await page.evaluate(async () => {
      const { makeAudioFeatures } = await import('/src/sketches/audio-features.js');
      const sampleRate = 48000;
      const fftSize = 2048;
      const bins = fftSize / 2;
      const frame = (active, rms = 0.1) => {
        const left = new Float32Array(bins).fill(-92);
        const right = new Float32Array(bins).fill(-92);
        if (active) {
          const start = Math.ceil(40 / (sampleRate / fftSize));
          const end = Math.floor(145 / (sampleRate / fftSize));
          for (let i = start; i <= end; i++) left[i] = right[i] = -20;
        }
        return { left, right, sampleRate, fftSize, rms };
      };

      const run = (params, rms = 0.1) => {
        const analyse = makeAudioFeatures();
        for (let i = 0; i < 8; i++) analyse(frame(false, rms), params, 1 / 60);
        return analyse(frame(true, rms), params, 1 / 60);
      };

      return {
        silent: run({}, 0),
        bassDisabled: run({ bass: 0 }),
        punchDisabled: run({ punch: 0 }),
      };
    });

    expect(result.silent.inputLevel).toBe(0);
    expect(result.silent.sub).toBe(0);
    expect(result.silent.kick).toBe(0);
    expect(result.bassDisabled.sub).toBe(0);
    expect(result.bassDisabled.kick).toBe(0);
    expect(result.bassDisabled.beat).toBe(0);
    expect(result.punchDisabled.sub).toBeGreaterThan(0.3);
    expect(result.punchDisabled.kick).toBe(0);
    expect(result.punchDisabled.beat).toBe(0);
  });

  test('delivers live kick, snare and hat envelopes to a running GPU effect', async ({ context, page }) => {
    // The migrated transport computes musical features capture-side and carries
    // them to the running GPU effect as controller-mapped uniforms inside compact
    // pattern-audio-controls packets (no raw analysis frames cross the wire).
    // Capture those packets on the control to observe the live envelopes.
    await context.addInitScript(() => {
      const originalPostMessage = BroadcastChannel.prototype.postMessage;
      window.__capturedControls = [];
      BroadcastChannel.prototype.postMessage = function postMessageWithCapture(message) {
        if (message?.type === 'pattern-audio-controls' && Array.isArray(message.slots)) {
          window.__capturedControls.push(message);
          if (window.__capturedControls.length > 400) window.__capturedControls.shift();
        }
        return originalPostMessage.call(this, message);
      };
    });

    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);
    await control.locator('.pattern-btn[data-id="event-horizon"]').click();
    await page.waitForFunction(() => window.__viz.patternId === 'event-horizon');

    await control.evaluate(() => {
      const sampleRate = 48000;
      const fftSize = 2048;
      const bins = fftSize / 2;
      const makeFrame = (range = null) => {
        const left = new Float32Array(bins).fill(-92);
        const right = new Float32Array(bins).fill(-92);
        if (range) {
          const binHz = sampleRate / fftSize;
          const start = Math.ceil(range[0] / binHz);
          const end = Math.floor(range[1] / binHz);
          // Strong band stimulus (-12 dB) keeps the envelope peak well above the
          // assertion threshold even when parallel load stretches tick timing.
          for (let i = start; i <= end; i++) left[i] = right[i] = -12;
        }
        return { left, right, sampleRate, fftSize, rms: 0.1 };
      };

      window.__audioTestFrames = {
        makeFrame,
        current: makeFrame(),
      };
      window.__viz.captureAudio.isStarted = true;
      window.__viz.captureAudio.getAnalysisFrame = () => window.__audioTestFrames.current;
    });

    // Prime previous-spectrum and adaptive-threshold state.
    await page.waitForTimeout(180);

    const injectFrame = (range) => control.evaluate((r) => {
      window.__audioTestFrames.current = window.__audioTestFrames.makeFrame(r);
    }, range);

    // Wait until a recent packet carries the requested envelope above threshold.
    const waitForEnvelope = (uniform) => control.waitForFunction((name) => {
      const captured = window.__capturedControls || [];
      for (let i = captured.length - 1; i >= 0; i--) {
        const slot = captured[i].slots.find((entry) => entry.continuous && Number(entry.continuous[name]) > 0.15);
        if (slot) return true;
      }
      return false;
    }, uniform, { timeout: 10_000 });

    await injectFrame([40, 145]);
    await waitForEnvelope('uKick');
    await expect.poll(() => page.evaluate(() => window.__viz.audioFeatures.live)).toBe(true);

    await injectFrame(null);
    await page.waitForTimeout(240);
    await injectFrame([350, 2200]);
    await waitForEnvelope('uSnare');

    await injectFrame(null);
    await page.waitForTimeout(200);
    await injectFrame([6000, 12000]);
    await waitForEnvelope('uHat');

    // The running output effect is fed by the same compact controls: the audio
    // facade is marked active by accepted packets and the event-horizon slot
    // stays fresh and rendered on the screen (screen-side header bands are
    // deliberately neutral on the controls path, so the envelopes are asserted
    // at the transport level above).
    await expect.poll(() => page.evaluate(() => window.__viz.audio.isStarted)).toBe(true);
    await page.waitForFunction(() => {
      const slots = Object.values(window.__viz.patternAudio?.store?.slots || {});
      return slots.some((slot) => slot.patternId === 'event-horizon' && slot.fresh && slot.renderMarker > 0);
    });
  });
});
