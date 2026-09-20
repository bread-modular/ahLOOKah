import { expect, test } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

async function installSyntheticCapture(control, { level = 0.5 } = {}) {
  await control.evaluate((targetLevel) => {
    const fftSize = 2048;
    const bins = fftSize / 2;
    // A flat mid-level spectrum keeps the shared feature extractor + smoothed
    // loudness controllers above silence while the waveform sets the envelope.
    const frame = {
      left: new Float32Array(bins).fill(-30),
      right: new Float32Array(bins).fill(-30),
      waveformLeft: new Float32Array(fftSize).fill(targetLevel),
      waveformRight: new Float32Array(fftSize).fill(-targetLevel),
      sampleRate: 48_000,
      fftSize,
      time: 1,
    };
    window.__viz.captureAudio.isStarted = true;
    window.__viz.captureAudio.getAnalysisFrame = () => frame;
    window.__syntheticFrame = frame;
  }, level);
}

test.describe('offline preview mirrors output', { tag: '@core' }, () => {
  test('sliders affect the control-only preview without an output screen', async ({ page }) => {
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.audioOwner);
    await expect(page.locator('#status-line .badge-offline')).toBeVisible();
    await expect(page.locator('#preview-stage canvas[data-preview-sketch="circles"]')).toBeVisible();

    // Plain pattern slider: accepted locally while the output is offline.
    await page.locator('#pattern-library [data-id="bars"]').click();
    await expect(page.locator('#preview-stage canvas[data-preview-sketch="bars"]')).toBeVisible();
    const before = await page.evaluate(() => window.__viz.params.gain);
    expect(before).toBe(1);
    await page.locator('#params-list input[data-key="gain"]').evaluate((el) => {
      el.value = '2.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => window.__viz.params.gain)).toBe(2.5);

    // Post-FX is reflected on the preview host compositing filter.
    await page.locator('#post-fx input[data-key="brightness"]').evaluate((el) => {
      el.value = '40';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => document.querySelector('#preview-stage')?.style?.filter || '')).toContain('brightness(1.4)');
  });

  test('control-only preview reacts to capture audio', async ({ page }) => {
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.audioOwner);
    await installSyntheticCapture(page, { level: 0.15 });
    await page.locator('#pattern-library [data-id="bars"]').click();
    const canvas = page.locator('#preview-stage canvas[data-preview-sketch="bars"]');
    await expect(canvas).toBeVisible();
    await page.waitForFunction(() => {
      const slots = window.__viz.patternAudio?.store?.slots || {};
      return Object.values(slots).some((slot) => slot.patternId === 'bars' && slot.fresh);
    }, undefined, { timeout: 10_000 });

    // Renderer-consumed proof: sample what the preview canvas actually paints.
    // Quiet input draws short gray bars; loud input drives tall bars plus the
    // red intensity overlay. Read the bar column, not the divider/flash edge.
    const readPreviewHeat = () => page.locator('#preview-stage canvas[data-preview-sketch="bars"]').evaluate((el) => {
      const ctx = el.getContext('2d');
      const w = Math.max(1, el.width);
      const h = Math.max(1, el.height);
      const sampleX = Math.floor(w * 0.25);
      const rows = 24;
      let lit = 0;
      let red = 0;
      for (let i = 0; i < rows; i++) {
        const y = Math.floor((i + 0.5) * (h / rows));
        const [r, g, b] = ctx.getImageData(sampleX, y, 1, 1).data;
        if (r > 30 || g > 30 || b > 30) lit += 1;
        if (r > 120 && r > g + 40 && r > b + 40) red += 1;
      }
      return { lit, red };
    });
    const readIntensity = () => window.__viz.patternAudioIntensity
      ? window.__viz.patternAudioIntensity('bars', 'intensity')
      : null;
    const readSequence = () => {
      const slots = window.__viz.patternAudio?.store?.slots || {};
      const slot = Object.values(slots).find((entry) => entry.patternId === 'bars');
      return slot?.sequence ?? -1;
    };
    // Let the smoothed envelope settle near the quiet input before asserting.
    await page.waitForTimeout(900);
    const calm = await page.evaluate(readIntensity);
    expect(calm).not.toBeNull();
    // Quiet input must stay well below the loud ceiling asserted next; if it
    // has not settled, the threshold check below would pass vacuously.
    expect(calm).toBeLessThan(0.45);
    const calmHeat = await readPreviewHeat();

    await page.evaluate(() => {
      window.__syntheticFrame.waveformLeft.fill(0.9);
      window.__syntheticFrame.waveformRight.fill(-0.9);
    });
    // Loud input drives the smoothed envelope above anything the quiet input
    // could reach, and the rendered preview follows: taller bars + red. Poll
    // the meaningful pixel conditions (not a vacuous shape match) so render
    // timing cannot slip through.
    await expect.poll(() => page.evaluate(readIntensity), { timeout: 10_000 }).toBeGreaterThan(0.6);
    await expect.poll(async () => {
      const heat = await readPreviewHeat();
      return heat.lit > calmHeat.lit && heat.red > calmHeat.red ? heat : null;
    }, { timeout: 10_000 }).not.toBeNull();
    const loudHeat = await readPreviewHeat();
    expect(loudHeat.lit).toBeGreaterThan(calmHeat.lit);
    expect(loudHeat.red).toBeGreaterThan(calmHeat.red);
    const seqBefore = await page.evaluate(readSequence);
    await expect.poll(() => page.evaluate(readSequence), { timeout: 10_000 }).toBeGreaterThan(seqBefore);

    await page.evaluate(() => {
      window.__syntheticFrame.waveformLeft.fill(0.0);
      window.__syntheticFrame.waveformRight.fill(0.0);
    });
    await expect.poll(() => page.evaluate(readIntensity), { timeout: 10_000 }).toBeLessThan(0.3);
    await expect.poll(readPreviewHeat, { timeout: 10_000 }).toMatchObject({ red: 0 });
  });

  test('offline EQ change retunes the preview audio path', async ({ page }) => {
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.audioOwner);
    await expect(page.locator('#status-line .badge-offline')).toBeVisible();
    await installSyntheticCapture(page, { level: 0.5 });
    await page.locator('#pattern-library [data-id="bars"]').click();
    await expect(page.locator('#preview-stage canvas[data-preview-sketch="bars"]')).toBeVisible();

    // Drag the bass|mid separator right: the offline control owns __bands, so
    // the stored split + the live extractor split must both move.
    await page.locator('#band-eq-canvas').scrollIntoViewIfNeeded();
    const box = await page.locator('#band-eq-canvas').boundingBox();
    expect(box).not.toBeNull();
    const hzFrac = (hz) => Math.log(hz / 30) / Math.log(16000 / 30);
    const x = box.x + hzFrac(180) * box.width;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__viz.bands?.low), { timeout: 10_000 }).toBeGreaterThan(250);
    const split = await page.evaluate(async () => {
      const { getBandSplit } = await import('/src/sketches/audio-features.js');
      return getBandSplit();
    });
    expect(split.low).toBeGreaterThan(250);
  });

  test('canonical bank adoption merges in place without stranding refs', async ({ context, page }) => {
    // Isolated repository checks (no shared localStorage writes): the
    // reconnect path merges the screen's canonical bank into the SAME live
    // objects the preview factories hold.
    await page.goto(CONTROL_URL);
    const result = await page.evaluate(async () => {
      const { createParamRepository } = await import('/src/params/ParamRepository.js');
      const report = {};
      // Update: same object adopts the new value.
      {
        const repo = createParamRepository();
        repo.initialize();
        const live = repo.getParams('bars');
        const before = live.barWidth;
        const changed = repo.adoptCanonicalBank({ bars: { ...live, barWidth: 12 } });
        report.update = { before, after: live.barWidth, changed, sameRef: repo.getParams('bars') === live };
      }
      // Removal: resets to defaults in place (no stale keys in either map).
      {
        const repo = createParamRepository();
        repo.initialize();
        const live = repo.getParams('bars');
        live.gain = 2.5;
        const changed = repo.adoptCanonicalBank({});
        report.removal = { changed, gain: live.gain, rawGain: repo.getRawBank().bars?.gain };
      }
      // Addition of a previously absent id (never getParams() first) lands in
      // both maps; dev:true proxy path included.
      {
        const repo = createParamRepository({ dev: true });
        repo.initialize();
        const hadBefore = repo.getRawBank().bars !== undefined;
        const changed = repo.adoptCanonicalBank({ bars: { gain: 2, barWidth: 8, flash: 1, bass: 1, mid: 1, high: 1 } });
        const live = repo.getParams('bars');
        report.addition = { hadBefore, changed, gain: live.gain, rawGain: repo.getRawBank().bars?.gain };
      }
      return report;
    });
    expect(result.update.changed).toBe(true);
    expect(result.update.after).toBe(12);
    expect(result.update.after).not.toBe(result.update.before);
    expect(result.update.sameRef).toBe(true);
    expect(result.removal.changed).toBe(true);
    expect(result.removal.gain).toBe(1);
    expect(result.removal.rawGain).toBe(1);
    expect(result.addition.hadBefore).toBe(false);
    expect(result.addition.changed).toBe(true);
    expect(result.addition.gain).toBe(2);
    expect(result.addition.rawGain).toBe(2);
  });

  test('unchanged-selection state echo updates the running preview canvas', async ({ context, page }) => {
    test.setTimeout(60_000);
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);
    await expect(control.locator('#status-line .badge-online')).toBeVisible();
    await installSyntheticCapture(control, { level: 0.5 });
    await control.locator('#pattern-library [data-id="bars"]').click();
    await page.waitForFunction(() => window.__viz.patternId === 'bars');
    const canvas = control.locator('#preview-stage canvas[data-preview-sketch="bars"]');
    await expect(canvas).toBeVisible();
    const canvasHandle = await canvas.elementHandle();
    expect(canvasHandle).not.toBeNull();

    // End-to-end on the RUNNING control window: mutate gain ONLY on the
    // screen, then ask the screen for its full state (hello probe). The
    // screen answers with state.liveParams for the UNCHANGED ['bars']
    // selection — no live-params message first — so the control must adopt it
    // through applyCanonicalLiveParamBank (the reconnect path). Verified
    // sensitive: with object replacement instead of the in-place merge this
    // fails (stale preview refs keep the old bars object).
    const readBarHeight = () => control.locator('#preview-stage canvas[data-preview-sketch="bars"]').evaluate((el) => {
        const ctx = el.getContext('2d');
        const w = Math.max(1, el.width);
        const h = Math.max(1, el.height);
        const sampleX = Math.floor(w * 0.25);
        let top = -1;
        let bottom = -1;
        for (let y = 0; y < h; y++) {
          const [r, g, b] = ctx.getImageData(sampleX, y, 1, 1).data;
          if (r > 30 || g > 30 || b > 30) {
            if (top < 0) top = y;
            bottom = y;
          }
        }
        return bottom >= top && top >= 0 ? bottom - top : 0;
      });
      const heightBefore = await readBarHeight();
      expect(heightBefore).toBeGreaterThan(0);
      const gainBefore = await control.evaluate(() => window.__viz.params.gain);
      await page.evaluate(() => { window.__viz.params.gain = 2.5; });
      await control.evaluate(() => {
        const channel = new BroadcastChannel('viz2_channel');
        channel.postMessage({ type: 'hello', role: 'screen', windowId: 'probe', tabId: 'probe', bootTime: 0 });
        channel.close();
      });
      await expect.poll(() => control.evaluate(() => window.__viz.params.gain), { timeout: 10_000 }).toBe(2.5);
      expect(await control.evaluate(() => window.__viz.params.gain)).not.toBe(gainBefore);
      const sameCanvas = await control.locator('#preview-stage canvas[data-preview-sketch="bars"]').elementHandle();
      expect(await sameCanvas.evaluate((el, expected) => el === expected, canvasHandle)).toBe(true);
      await expect.poll(readBarHeight, { timeout: 10_000 }).toBeGreaterThan(heightBefore);
      const heightEcho = await readBarHeight();
      await control.locator('#params-list input[data-key="gain"]').evaluate((el) => {
        el.value = '1';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect.poll(() => page.evaluate(() => window.__viz.params.gain), { timeout: 10_000 }).toBe(1);
      await expect.poll(readBarHeight, { timeout: 10_000 }).not.toBe(heightEcho);
  });

  test('camera placeholder stays while audio patterns preview offline', async ({ page }) => {
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.audioOwner);
    await expect(page.locator('#status-line .badge-offline')).toBeVisible();
    await page.locator('#pattern-library [data-id="video-kaleido"]').click();
    await expect(page.locator('#preview-stage .preview-empty')).toContainText('live video remains on the output screen');
  });

  test('offline blend keys composite the preview; reconnect keeps it in sync', async ({ context, page }) => {
    test.setTimeout(90_000);
    // One screen only (singleton): keep it open the whole time so the merge
    // selection is shared, and toggle offline by closing/reopening it.
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);
    await expect(control.locator('#status-line .badge-online')).toBeVisible();

    // Enter merge with the same held-key gesture the merge suite uses.
    await control.keyboard.down('1');
    await control.keyboard.down('2');
    await expect.poll(() => control.evaluate(() => window.__viz.liveSelection?.merge)).toBe(true);
    await page.waitForFunction(() => window.__viz.merge !== null);
    await expect(control.locator('#preview-stage canvas.preview-canvas')).toHaveCount(2);
    const overlayOpacity = () => control.evaluate(() => {
      const canvases = [...document.querySelectorAll('#preview-stage canvas.preview-canvas')];
      return canvases.length === 2 ? Number(canvases[1].style.opacity || '1') : null;
    });
    await expect.poll(overlayOpacity).not.toBeNull();

    // Sanity: while online the blend slider echoes through screen authority.
    await control.locator('#params-list input[data-key="mix"]').evaluate((el) => {
      el.value = '0.7';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => window.__viz.blend?.mix), { timeout: 10_000 }).toBe(0.7);
    await expect.poll(overlayOpacity, { timeout: 10_000 }).toBeCloseTo(0.7, 1);

    // Close the output: the offline-owned blend keys must keep compositing
    // the preview (this is the reported bug: params froze without a screen).
    await page.close({ runBeforeUnload: true });
    await expect(control.locator('#status-line .badge-offline')).toBeVisible();
    await control.keyboard.press('+');
    await expect.poll(() => control.evaluate(() => window.__viz.blend?.mix)).toBeCloseTo(0.75, 2);
    await expect.poll(overlayOpacity).toBeCloseTo(0.75, 1);

    // Reconnect: re-assert the merge explicitly (a fresh screen boots from
    // its own default selection), then the running preview must follow the
    // echoed canonical bank. Release and re-hold the pair so the merge intent
    // is re-broadcast (heldKeys dedupes repeats while held).
    const screen2 = await context.newPage();
    await screen2.goto(SCREEN_URL);
    await expect(control.locator('#status-line .badge-online')).toBeVisible();
    await control.keyboard.up('2');
    await control.keyboard.up('1');
    await control.keyboard.down('1');
    await control.keyboard.down('2');
    await expect.poll(() => screen2.evaluate(() => window.__viz.merge !== null), { timeout: 15_000 }).toBe(true);
    await control.locator('#params-list .blend-mode-toggle').waitFor();
    await control.locator('#params-list input[data-key="mix"]').evaluate((el) => {
      el.value = '0.8';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => screen2.evaluate(() => window.__viz.blend?.mix), { timeout: 10_000 }).toBe(0.8);
    await expect.poll(overlayOpacity, { timeout: 10_000 }).toBeCloseTo(0.8, 1);
    await control.keyboard.up('2');
    await control.keyboard.up('1');
  });
});
