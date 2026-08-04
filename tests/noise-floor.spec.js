import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
const BINS = FFT_SIZE / 2;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

// Noise hump 40-150 Hz @ -50 dB (the "signature" to remove). The loud 1 kHz
// tone @ -25 dB ("music") only appears AFTER the capture — it must survive.
const NOISE_BIN = Math.round(100 / BIN_HZ);
const TONE_BIN = Math.round(1000 / BIN_HZ);

// Replace the analysers with deterministic fakes so the REAL getAnalysisFrame
// path (capture feed + in-place subtraction) runs without a microphone. The
// tone is gated by window.__musicOn so the capture samples silence + hum only.
async function installFakeAnalysers(page) {
  await page.evaluate(({ sampleRate, fftSize }) => {
    const bins = fftSize / 2;
    const binHz = sampleRate / fftSize;
    window.__musicOn = false;
    const fill = (arr) => {
      arr.fill(-92);
      for (let i = Math.ceil(40 / binHz); i <= Math.floor(150 / binHz); i++) arr[i] = -50;
      if (window.__musicOn) arr[Math.round(1000 / binHz)] = -25;
    };
    const mkAnalyser = () => ({
      frequencyBinCount: bins,
      getFloatFrequencyData: (arr) => fill(arr),
      getFloatTimeDomainData: (arr) => arr.fill(0.0005),
    });
    const a = window.__viz.audio;
    a.audioContext = { state: 'running', sampleRate, currentTime: 0, resume: () => Promise.resolve() };
    a.analyserL = mkAnalyser();
    a.analyserR = mkAnalyser();
    a.isStarted = true;
    a.allocateBuffers();
  }, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
}

test.describe('noise floor capture & subtraction', () => {
  test('spectral subtraction removes the captured signature and spares loud bins', async ({ page }) => {
    await page.goto(SCREEN_URL);

    const res = await page.evaluate(async () => {
      const nf = await import('/noise-floor.js');
      nf.clearNoiseFloor();

      const binHz = 48000 / 2048;
      // Silence + hum only (what a real capture records)
      const mkNoiseFrame = () => {
        const bins = 1024;
        const left = new Float32Array(bins).fill(-92);
        const right = new Float32Array(bins).fill(-92);
        for (let i = Math.ceil(40 / binHz); i <= Math.floor(150 / binHz); i++) left[i] = right[i] = -50;
        return { left, right, sampleRate: 48000, fftSize: 2048 };
      };
      // Music playing: hum + loud tone
      const mkMusicFrame = () => {
        const f = mkNoiseFrame();
        f.left[Math.round(1000 / binHz)] = -25;
        f.right[Math.round(1000 / binHz)] = -25;
        return f;
      };

      nf.startNoiseCapture(0.4);
      nf.feedNoiseCapture(mkNoiseFrame());
      await new Promise((r) => setTimeout(r, 500));
      const st = nf.feedNoiseCapture(mkNoiseFrame());
      if (!st || !st.done) return { error: 'capture did not finalise', st };

      const frame = mkMusicFrame();
      nf.applyNoiseFloor(frame.left, frame.right, 48000, 2048);
      return {
        meta: nf.getNoiseFloorMeta(),
        noiseAfter: frame.left[Math.round(100 / binHz)],
        toneAfter: frame.left[Math.round(1000 / binHz)],
        stored: !!localStorage.getItem('viz2_noise_floor'),
      };
    });

    expect(res.error).toBeUndefined();
    expect(res.meta).toBeTruthy();
    expect(res.meta.frames).toBeGreaterThan(0);
    // Noise hump driven to the spectral floor…
    expect(res.noiseAfter).toBeLessThan(-75);
    // …while the loud tone is essentially untouched.
    expect(res.toneAfter).toBeGreaterThan(-26.5);
    expect(res.stored).toBe(true);
  });

  test('control panel captures via the screen, spectrum is cleaned everywhere, clear restores', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await installFakeAnalysers(page);

    // Before capture the raw signature rides the spectrum broadcast
    await control.waitForFunction(() => (window.__viz.eq?.drawn ?? 0) > 1);
    const before = await control.evaluate(({ noiseBin }) => {
      const spec = window.__viz.eq.lastSpectrum;
      let idx = 0;
      for (let i = 0; i < spec.freqs.length; i++) {
        if (Math.abs(spec.freqs[i] - 100) < Math.abs(spec.freqs[idx] - 100)) idx = i;
      }
      return spec.dbs[idx];
    }, { noiseBin: NOISE_BIN });
    expect(before).toBeGreaterThan(-60);

    // Start a capture from the panel (short window to keep the test quick)
    await control.locator('#noise-capture-btn').click();
    await expect(control.locator('#noise-status')).toContainText('Capturing');

    // Screen finalises after the requested duration and broadcasts ready
    await expect(control.locator('#noise-status')).toContainText('Noise floor active', { timeout: 15000 });
    expect(await page.evaluate(() => window.__viz.noise.profile)).toBeTruthy();

    // Now the music starts — the tone must survive the subtraction
    await page.evaluate(() => { window.__musicOn = true; });

    // The live analysis frame on the screen is now cleaned in place
    const cleaned = await page.evaluate(({ noiseBin, toneBin }) => {
      const f = window.__viz.audio.getAnalysisFrame();
      return { noise: f.left[noiseBin], tone: f.left[toneBin] };
    }, { noiseBin: NOISE_BIN, toneBin: TONE_BIN });
    expect(cleaned.noise).toBeLessThan(-75);
    expect(cleaned.tone).toBeGreaterThan(-26.5);

    // The broadcast spectrum the panel draws is cleaned too
    await control.waitForFunction(() => {
      const spec = window.__viz.eq.lastSpectrum;
      if (!spec) return false;
      let idx = 0;
      for (let i = 0; i < spec.freqs.length; i++) {
        if (Math.abs(spec.freqs[i] - 100) < Math.abs(spec.freqs[idx] - 100)) idx = i;
      }
      return spec.dbs[idx] < -70;
    });

    // Clearing wipes the profile everywhere and restores the raw signature
    await control.locator('#noise-clear-btn').click();
    await expect(control.locator('#noise-status')).toContainText('No noise profile');
    expect(await page.evaluate(() => window.__viz.noise.profile)).toBeNull();
    const restored = await page.evaluate(({ noiseBin }) => {
      const f = window.__viz.audio.getAnalysisFrame();
      return f.left[noiseBin];
    }, { noiseBin: NOISE_BIN });
    expect(restored).toBeGreaterThan(-55);
  });

  test('a captured profile survives a reload', async ({ page }) => {
    await page.goto(SCREEN_URL);

    // Capture quickly through the module (same path the screen uses)
    await page.evaluate(async () => {
      const nf = await import('/noise-floor.js');
      nf.clearNoiseFloor();
      nf.startNoiseCapture(0.3);
      const feed = () => {
        const bins = 1024;
        const left = new Float32Array(bins).fill(-60);
        const right = new Float32Array(bins).fill(-60);
        nf.feedNoiseCapture({ left, right, sampleRate: 48000, fftSize: 2048 });
      };
      feed();
      await new Promise((r) => setTimeout(r, 400));
      feed();
    });
    expect(await page.evaluate(() => window.__viz.noise.profile)).toBeTruthy();

    await page.reload();
    const meta = await page.evaluate(() => window.__viz.noise.profile);
    expect(meta).toBeTruthy();
    expect(meta.binCount).toBe(1024);
    expect(await page.evaluate(() => !!localStorage.getItem('viz2_noise_floor'))).toBe(true);
  });
});
