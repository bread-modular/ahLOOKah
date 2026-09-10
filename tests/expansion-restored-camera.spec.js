import { test, expect } from '@playwright/test';
import { SKETCHES } from '../src/sketch-registry.js';
import { RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';

// The restored pair must be the exact legacy looks (ids/names/param schema
// from 6fc98ac), subtly and independently band-reactive, with the camera image
// preserved at defaults.
test('restored Video Thermal / Video Edge Glow: exact identity, subtle defaults, independent bands', { tag: '@core' }, () => {
  expect(RESTORED_CAMERA_PATTERNS.map((s) => [s.id, s.name])).toEqual([
    ['video-edge-glow', 'Video Edge Glow'],
    ['video-thermal', 'Video Thermal'],
  ]);
  for (const s of RESTORED_CAMERA_PATTERNS) {
    const registered = SKETCHES.find((x) => x.id === s.id);
    expect(registered, s.id).toBeTruthy();
    expect(registered.name).toBe(s.name);
    expect(registered.group).toBe('Video FX');
    expect(registered.camera).toBe(true);
    // Legacy param schema preserved (keys/labels/ranges); only the amount
    // default was lowered for a tasteful first-open.
    expect(registered.params.map((p) => [p.key, p.label, p.min, p.max])).toEqual([
      ['amount', 'FX Amount', 0, 1],
      ['detail', s.id === 'video-thermal' ? 'Thermal Bands' : 'Edge Width', 1, 12],
      ['hue', 'Tint / Prism Hue', 0, 1],
      ['mirror', 'Mirror Camera', 0, 1],
      ['bass', 'Bass Responsiveness', 0, 2],
      ['mid', 'Mid Responsiveness', 0, 2],
      ['high', 'High Responsiveness', 0, 2],
    ]);
    expect(registered.params.find((p) => p.key === 'amount').default).toBe(0.5);
    expect(registered.params.find((p) => p.key === 'detail').default).toBe(4);
  }
});

test('restored camera looks keep the image dominant and react measurably per band', { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/tests/fixtures/render.html');
  const out = await page.evaluate(async (ids) => {
    const { renderTimeline, difference, W, H } = await import('/tests/fixtures/replacement-renderer.js');
    const results = {};
    for (const id of ids) {
      const silence = await renderTimeline(id, () => ({}), {}, null, false, { staticCamera: true });
      const loud = await renderTimeline(id, () => ({ sub: .3, mid: .3, high: .3 }), {}, null, false, { staticCamera: true });
      const full = await renderTimeline(id, () => ({ sub: 1.6, mid: 1.6, high: 1.6 }), { amount: 1 }, null, false, { staticCamera: true });
      const perBand = {};
      for (const [band, feature] of [['bass', 'sub'], ['mid', 'mid'], ['high', 'high']]) {
        const driven = await renderTimeline(id, () => ({ [feature]: .3 }), {}, null, false, { staticCamera: true });
        const muted = await renderTimeline(id, () => ({ [feature]: .9 }), { [band]: 0 }, null, false, { staticCamera: true });
        perBand[band] = { driven: difference(silence[20], driven[20]), muted: difference(silence[20], muted[20]).maxDelta };
      }
      // Image preservation at defaults: per-pixel correlation with the
      // un-effected frame stays high (the effect is a shimmer, not a takeover).
      const source = silence[20], fx = loud[20];
      let same = 0, total = 0, fxEnergy = 0;
      for (let i = 0; i < W * H; i++) {
        const d = Math.max(Math.abs(source[i * 4] - fx[i * 4]), Math.abs(source[i * 4 + 1] - fx[i * 4 + 1]), Math.abs(source[i * 4 + 2] - fx[i * 4 + 2]));
        total++;
        if (d < 24) same++;
        fxEnergy += d;
      }
      results[id] = {
        perBand,
        preserved: same / total,
        loudRgb: fxEnergy / (total * 3),
        fullLoud: difference(silence[20], full[20]).rgb,
        deterministic: difference(silence[8], silence[20]).maxDelta >= 0 ? 0 : 1,
      };
    }
    return results;
  }, RESTORED_CAMERA_PATTERNS.map((s) => s.id));
  for (const [id, r] of Object.entries(out)) {
    for (const [band, m] of Object.entries(r.perBand)) {
      expect(m.driven.rgb, `${id} ${band} responds measurably`).toBeGreaterThan(.4);
      expect(m.muted, `${id} ${band} zero disables`).toBe(0);
    }
    expect(r.preserved, `${id} camera image dominant at defaults`).toBeGreaterThan(.6);
    expect(r.loudRgb, `${id} but clearly present under audio`).toBeGreaterThan(2);
    expect(r.fullLoud, `${id} full amount opens the look`).toBeGreaterThan(8);
  }
});
