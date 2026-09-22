import { test, expect } from '@playwright/test';

// Focused contract for the Simple Circle building block: one centred circle,
// two sliders (Radius, Hue), an opaque black field, no audio reactivity, and a
// re-centred circle after a resize. Geometry is checked on real canvas pixels,
// so a broken draw/resize path fails here even though the pattern is trivial.

const toRgb = ([h, s, v]) => {
  const hue = ((h % 1) + 1) % 1;
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const channel = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ][i % 6];
  return channel.map((x) => Math.round(x * 255));
};

test('Simple Circle draws one centred circle driven by Radius + Hue, opaque and non-reactive', { tag: '@patterns' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const { SKETCHES, defaultParamValues } = await import('/src/sketch-registry.js');
    const { disposeVizInstance } = await import('/src/program-runtime.js');
    const { AUDIO_CONTROL_SCHEMA, createAudioController } = await import('/src/sketches/simple-circle.pattern.js');

    const entry = SKETCHES.find((s) => s.id === 'simple-circle');

    const mount = async (params) => {
      let instance;
      await new Promise((resolve) => {
        instance = new VizCore((p) => {
          entry.factory(null, null, params, {
            audioControls: { read: () => ({ continuous: {} }) },
          })(p);
          const setup = p.setup;
          const redraw = p.redraw.bind(p);
          let first = true;
          p.setup = () => { setup(); p.noLoop(); };
          p.redraw = async (...args) => {
            await redraw(...args);
            if (first) { first = false; resolve(); }
          };
        });
      });
      instance.pixelDensity(1);
      return instance;
    };

    const sample = async (instance, w, h, points) => {
      instance.resizeCanvas(w, h, true);
      await instance.redraw();
      const ctx = instance.drawingContext;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const frame = ctx.getImageData(0, 0, instance.canvas.width, instance.canvas.height).data;
      const at = (x, y) => {
        const offset = (y * instance.canvas.width + x) * 4;
        return [frame[offset], frame[offset + 1], frame[offset + 2], frame[offset + 3]];
      };
      let opaque = 0; let transparent = 0; let lit = 0; let black = 0;
      for (let i = 0; i < frame.length; i += 4) {
        if (frame[i + 3] === 255) opaque++; else transparent++;
        if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 0) black++; else lit++;
      }
      const readings = {};
      for (const [name, x, y] of points) readings[name] = at(x, y);
      ctx.restore();
      return { readings, opaque, transparent, lit, black, backing: [instance.canvas.width, instance.canvas.height] };
    };

    const rows = [];
    for (const spec of [
      { key: 'small', params: { radius: 0.1, hue: 0.6 }, size: [240, 140], points: [['centre', 120, 70], ['outside', 140, 70], ['corner', 4, 4]] },
      { key: 'full', params: { radius: 1, hue: 0.6 }, size: [240, 140], points: [['centre', 120, 70], ['topEdge', 120, 3], ['corner', 4, 4]] },
      { key: 'red', params: { radius: 0.4, hue: 0 }, size: [200, 120], points: [['centre', 100, 60], ['corner', 3, 3]] },
    ]) {
      const instance = await mount({ ...defaultParamValues('simple-circle'), ...spec.params });
      try {
        rows.push({ key: spec.key, ...(await sample(instance, spec.size[0], spec.size[1], spec.points)) });
      } finally { disposeVizInstance(instance); }
    }

    // Portrait resize must re-centre the circle (not just keep the old draw).
    const instance = await mount({ ...defaultParamValues('simple-circle'), radius: 0.5, hue: 0.6 });
    let resized;
    try {
      resized = await sample(instance, 140, 240, [['centre', 70, 120], ['corner', 3, 3]]);
    } finally { disposeVizInstance(instance); }

    // Controller contract: bounded continuous values that match the schema.
    const controller = createAudioController();
    const inside = controller.update({ params: { radius: 0.25, hue: 0.75 } });
    const clamped = controller.update({ params: { radius: 40, hue: -3 } });
    const missing = controller.update({ params: {} });

    return {
      descriptor: {
        id: entry?.id,
        name: entry?.name,
        group: entry?.group,
        audioReactive: entry?.audioReactive,
        keys: entry?.params.map((p) => p.key),
        labels: entry?.params.map((p) => p.label),
        paramDefaults: entry?.params.map((p) => p.default),
        valid: entry?.params.every((p) => ['key', 'label', 'min', 'max', 'step', 'default'].every((f) => p[f] !== undefined) && p.min < p.max && p.step > 0),
        defaultsInRange: entry?.params.every((p) => p.default >= p.min && p.default <= p.max),
        schema: Object.keys(AUDIO_CONTROL_SCHEMA.continuous),
        neutral: { ...AUDIO_CONTROL_SCHEMA.neutral.continuous },
        defaults: defaultParamValues('simple-circle'),
      },
      rows,
      resized,
      controller: { inside: inside.continuous, clamped: clamped.continuous, missing: missing.continuous, arrays: Object.keys(inside.arrays), events: inside.events.length },
    };
  });

  // --- Registry / slider contract -----------------------------------------
  expect(result.descriptor).toMatchObject({
    id: 'simple-circle',
    name: 'Simple Circle',
    group: 'Simple',
    audioReactive: false,
    keys: ['radius', 'hue'],
    labels: ['Radius', 'Hue'],
    paramDefaults: [0.3, 0.6],
    valid: true,
    defaultsInRange: true,
    schema: ['uRadius', 'uHue'],
    neutral: { uRadius: 0.3, uHue: 0.6 },
    defaults: { radius: 0.3, hue: 0.6 },
  });

  // --- Audio control values stay inside the declared schema bounds --------
  expect(result.controller.inside).toEqual({ uRadius: 0.25, uHue: 0.75 });
  expect(result.controller.clamped).toEqual({ uRadius: 1, uHue: 0 });
  expect(result.controller.missing).toEqual({ uRadius: 0.3, uHue: 0.6 });
  expect(result.controller.arrays).toEqual([]);
  expect(result.controller.events).toBe(0);

  const hue06 = toRgb([0.6, 0.85, 0.95]);
  const hue0 = toRgb([0, 0.85, 0.95]);
  const near = (actual, expected, tolerance = 2) =>
    expect(actual.slice(0, 3).map((v, i) => Math.abs(v - expected[i]) <= tolerance), `expected ${actual} ≈ ${expected}`).toEqual([true, true, true]);

  for (const row of result.rows) {
    // The field is fully opaque: the pattern never leaves stale/transparent pixels.
    expect(row.transparent, row.key).toBe(0);
    expect(row.opaque, row.key).toBe(row.backing[0] * row.backing[1]);
    expect(row.readings.corner.slice(0, 3), `${row.key} corner`).toEqual([0, 0, 0]);
  }

  const [small, full, red] = result.rows;
  expect(small.backing).toEqual([240, 140]);
  near(small.readings.centre, hue06);
  // radius 0.1 at 240×140 -> 7px radius: 20px from the centre is still black.
  expect(small.readings.outside.slice(0, 3)).toEqual([0, 0, 0]);
  expect(small.black).toBeGreaterThan(small.lit);

  expect(full.backing).toEqual([240, 140]);
  near(full.readings.centre, hue06);
  // radius 1 fills the shorter edge (140px diameter), so the top edge is lit.
  near(full.readings.topEdge, hue06);

  near(red.readings.centre, hue0);
  expect(red.readings.centre[0]).toBeGreaterThan(red.readings.centre[1]);
  expect(red.readings.centre[0]).toBeGreaterThan(red.readings.centre[2]);

  // Portrait resize re-centres the circle.
  expect(result.resized.backing).toEqual([140, 240]);
  near(result.resized.readings.centre, hue06);
  expect(result.resized.readings.corner.slice(0, 3)).toEqual([0, 0, 0]);
  expect(result.resized.transparent).toBe(0);
});
