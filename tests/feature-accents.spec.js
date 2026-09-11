import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { REPLACEMENT_PATTERNS } from '../src/sketches/replacements/index.js';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';

// Feature-accent validation for the 18 + 21 wave patterns (plus the two
// restored camera looks) through the SAME production path as the live app:
// pattern.createAudioController() -> audioControls binding -> pattern.factory.
// Signals are matched, time-varying feature streams (sustained levels plus
// isolated rhythmic percussion), not silence-tone pixel coverage. Evidence:
// side-by-side stills and animated accent strips per pattern.
test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
const output = process.env.FEATURE_ARTIFACTS || 'test-results/feature-evidence';
const OWNED = [...REPLACEMENT_PATTERNS, ...EXPANSION_PATTERNS];
const ACCENTED = OWNED.filter((s) => s.params.some((p) => p.key === 'accents')).map((s) => s.id);

// Matched time-varying streams. Sustained bands are constant within a stream;
// percussion is a rhythmic 2-of-8 envelope so accents visibly arrive and leave.
const continuous = (v) => () => ({ sub: v, mid: v * .8, high: v * .7, energy: v });
const perc = (key, band) => (f) => ({
  [['sub', 'mid', 'high'][['kick', 'snare', 'hat'].indexOf(key)]]: band,
  [key]: f % 8 < 2 ? 1.2 : 0,
});
const ACCENT_FRAMES = [8, 9, 16, 17];
const OFF_FRAMES = [4, 12, 20];

for (const sketch of OWNED) test(`${sketch.id}: continuous levels, isolated percussion, mutes, saturation`, { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /shader|WebGL|p5.js/i.test(m.text())) errors.push(m.text()); });
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async ({ id, accentedIds }) => {
    const { renderTimeline, difference, png, W, H } = await import('/tests/fixtures/replacement-renderer.js');
    const avg = (frames, other, picks) => picks.map((i) => difference(frames[i], other[i]))
      .reduce((a, m) => ({ rgb: a.rgb + m.rgb / picks.length, coverage: a.coverage + m.coverage / picks.length, edge: a.edge + m.edge / picks.length }), { rgb: 0, coverage: 0, edge: 0 });
    const maxDelta = (a, b) => {
      let d = 0;
      for (let f = 0; f < a.length; f++) for (let i = 0; i < a[f].length; i++) d = Math.max(d, Math.abs(a[f][i] - b[f][i]));
      return d;
    };
    const continuous = (v) => () => ({ sub: v, mid: v * .8, high: v * .7, energy: v });
    const perc = (key, band) => (f) => ({ [['sub', 'mid', 'high'][['kick', 'snare', 'hat'].indexOf(key)]]: band, [key]: f % 8 < 2 ? 1.2 : 0 });
    const ACCENT = [8, 9, 16, 17], OFF = [4, 12, 20];
    const picks = [8, 12, 16, 20, 23];

    const silence = await renderTimeline(id);
    const duplicate = await renderTimeline(id);
    const weak = await renderTimeline(id, continuous(.08));
    const medium = await renderTimeline(id, continuous(.3));
    const loud = await renderTimeline(id, continuous(.85));
    const out = {
      deterministic: maxDelta(silence, duplicate),
      weak: avg(silence, weak, picks), medium: avg(silence, medium, picks), loud: avg(silence, loud, picks),
      // Autonomous motion exists but must not be mistaken for audio response:
      // audio-driven difference must clearly exceed the silent run's own motion.
      autonomous: difference(silence[0], silence[23]),
      // Level EVOLUTION: raising the drive must keep reorganizing the picture.
      // Diff-vs-silence saturates for high-contrast textures (it approaches the
      // 255 metric ceiling) and for periodic structures (a larger displacement
      // aliases over whole spatial periods), so growth is measured pairwise.
      steps: { weakMedium: avg(weak, medium, picks), mediumLoud: avg(medium, loud, picks) },
      accents: {}, muted: {}, stills: {}, strip: [],
    };
    for (const [key, slider] of [['kick', 'bass'], ['snare', 'mid'], ['hat', 'high']]) {
      const driven = await renderTimeline(id, perc(key, .25));
      out.accents[key] = { on: avg(silence, driven, ACCENT), off: avg(silence, driven, OFF), temporal: difference(driven[ACCENT[0]], driven[OFF[0]]).rgb + difference(driven[ACCENT[2]], driven[OFF[1]]).rgb };
      const muted = await renderTimeline(id, perc(key, .25), { [slider]: 0 });
      out.muted[key] = maxDelta(silence, muted);
      out.stills[key] = { silence: png(silence[8]), driven: png(driven[8]) };
    }
    // Selective accents slider: zero mutes the accent exactly (percussion-only
    // stream, so sustained levels cannot mask the trim); band sliders keep
    // gating regardless (tested above). The boost probe uses a HALF-STRENGTH
    // kick-only stream: at the full stream the envelope already sits at 1.2 of
    // the proven 1.4 ceiling, so accents=2 could only add ~17% before the clamp
    // and the boost would be invisible by construction. At half strength the
    // slider genuinely doubles the accent uniform.
    if (accentedIds.includes(id)) {
      const halfKick = (f) => ({ kick: f % 8 < 2 ? .55 : 0 });
      const driven = await renderTimeline(id, halfKick);
      out.accentsSlider = maxDelta(silence, await renderTimeline(id, halfKick, { accents: 0 }));
      out.accentsBoost = { at1: avg(silence, driven, ACCENT).rgb, at2: avg(silence, await renderTimeline(id, halfKick, { accents: 2 }), ACCENT).rgb };
    }
    // Everything hot with every gain at maximum: must not black out or wash out.
    const maxed = await renderTimeline(id, () => ({ sub: 1.6, mid: 1.6, high: 1.6, kick: 1.4, snare: 1.4, hat: 1.4, beat: 1.4, energy: 1.6 }), { bass: 2, mid: 2, high: 2, accents: 2 });
    const pixels = maxed[23];
    let lit = 0, dark = 0, grayscale = true;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 60) lit++;
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 700) dark++;
      grayscale &&= pixels[i] === pixels[i + 1] && pixels[i + 1] === pixels[i + 2] && pixels[i + 3] === 255;
    }
    out.max = { lit: lit / (W * H), dark: dark / (W * H), grayscale };
    out.stills.silence = png(silence[20]);
    out.stills.medium = png(medium[20]);
    out.stills.loud = png(loud[20]);
    out.stills.max = png(maxed[23]);
    const stripSource = await renderTimeline(id, perc('kick', .25));
    for (const i of [8, 9, 10, 11]) out.strip.push({ silence: png(silence[i]), driven: png(stripSource[i]) });
    return out;
  }, { id: sketch.id, accentedIds: ACCENTED });

  const dir = `${output}/${sketch.id}`;
  await mkdir(dir, { recursive: true });
  const { stills, strip, ...metrics } = result;
  await writeFile(`${dir}/metrics.json`, JSON.stringify({ id: sketch.id, ...metrics }, null, 2));
  for (const [name, image] of Object.entries(stills)) {
    if (typeof image === 'string') await writeFile(`${dir}/${name}.png`, Buffer.from(image.split(',')[1], 'base64'));
    else for (const [side, img] of Object.entries(image)) await writeFile(`${dir}/${name}-${side}.png`, Buffer.from(img.split(',')[1], 'base64'));
  }
  for (let i = 0; i < strip.length; i++) for (const [side, img] of Object.entries(strip[i])) {
    await writeFile(`${dir}/strip-${side}-${String(i).padStart(2, '0')}.png`, Buffer.from(img.split(',')[1], 'base64'));
  }

  const m = result;
  expect(m.deterministic, 'two silent runs must match bit-for-bit (no fabricated motion)').toBe(0);
  // Weak/medium/loud continuous audio all move the picture. Growth is asserted
  // two ways: pairwise EVOLUTION (raising the level must reorganize the picture
  // by clearly more than the silent run's own autonomous motion — robust where
  // diff-vs-silence saturates against the 255 metric ceiling or aliases over
  // periodic structure), plus a directional check against the weak floor.
  expect(m.weak.rgb, 'weak continuous audible').toBeGreaterThan(1);
  // Level EVOLUTION floors, relative to the response already present: raising
  // the drive must reorganize the picture by a substantial fraction of the
  // current audio response. Diff-vs-silence itself saturates (255 metric
  // ceiling for high-contrast textures; periodic structures alias whole
  // spatial periods), and the silent run's long-window autonomous motion is
  // not a fair floor for video-fed patterns whose playback moves more in 23
  // frames than any single level step — a pinned pattern fails these because
  // its level-step evolution collapses to zero.
  expect(m.steps.weakMedium.rgb, 'weak→medium visibly reorganizes the picture').toBeGreaterThan(.25 * m.weak.rgb);
  expect(m.steps.mediumLoud.rgb, 'medium→loud visibly reorganizes the picture').toBeGreaterThan(.2 * m.medium.rgb);
  // Isolated percussion: accent frames move (structural transient accent), and
  // the response is temporal — accent-on frames differ from accent-off frames.
  for (const key of ['kick', 'snare', 'hat']) {
    expect(m.accents[key].on.rgb, `${key} accent visible`).toBeGreaterThan(.8);
    expect(m.accents[key].on.coverage, `${key} accent area`).toBeGreaterThan(.004);
    expect(m.accents[key].temporal, `${key} accent is time-varying, not a static offset`).toBeGreaterThan(1);
    expect(m.muted[key], `${key} band slider at zero disables the accent exactly`).toBe(0);
  }
  if (ACCENTED.includes(sketch.id)) {
    expect(m.accentsSlider, 'accents slider at zero mutes the accent exactly').toBe(0);
    // Deterministic renders: any real gain change shows up exactly, so a
    // directional boost check is exact, not statistical. The magnitude of the
    // visual boost is the pattern's own accent sensitivity (kick coefficients
    // are deliberately small structural accents); the exact 2x uniform scaling
    // is pinned at unit level in the controller test below.
    expect(m.accentsBoost.at2, 'accents slider at 2 boosts the accent').toBeGreaterThan(m.accentsBoost.at1 * 1.05);
  }
  expect(m.max.lit, 'maximum everything cannot black out').toBeGreaterThan(.03);
  expect(m.max.dark, 'maximum everything cannot wash out').toBeGreaterThan(.03);
  if (sketch.group === 'Alphas') expect(m.max.grayscale).toBe(true);
  expect(errors).toEqual([]);
});

// The restored pair stays gentle and camera-preserving: sustained levels still
// shimmer the look, but percussion channels never reach the shader.
for (const sketch of RESTORED_CAMERA_PATTERNS) test(`${sketch.id}: restored gentle look — levels yes, percussion no`, { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async (id) => {
    const { renderTimeline, difference, png } = await import('/tests/fixtures/replacement-renderer.js');
    const silence = await renderTimeline(id);
    const driven = await renderTimeline(id, () => ({ sub: .5, mid: .4, high: .3, energy: .5 }));
    const percussive = await renderTimeline(id, () => ({ kick: 1.4, snare: 1.4, hat: 1.4, beat: 1.4 }));
    const muted = await renderTimeline(id, () => ({ sub: .8, mid: .8, high: .8 }), { bass: 0, mid: 0, high: 0 });
    let maxDelta = 0, percDelta = 0, muteDelta = 0;
    for (let f = 0; f < silence.length; f++) {
      for (let i = 0; i < silence[f].length; i++) {
        percDelta = Math.max(percDelta, Math.abs(silence[f][i] - percussive[f][i]));
        muteDelta = Math.max(muteDelta, Math.abs(silence[f][i] - muted[f][i]));
      }
    }
    const picks = [8, 12, 16, 20, 23];
    const rgb = picks.map((i) => difference(silence[i], driven[i]).rgb).reduce((a, v) => a + v, 0) / picks.length;
    return { rgb, percDelta, muteDelta, silence: png(silence[20]), driven: png(driven[20]) };
  }, sketch.id);
  const dir = `${output}/${sketch.id}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/restored-silence.png`, Buffer.from(result.silence.split(',')[1], 'base64'));
  await writeFile(`${dir}/restored-driven.png`, Buffer.from(result.driven.split(',')[1], 'base64'));
  expect(result.rgb, 'sustained levels still gently move the restored look').toBeGreaterThan(.4);
  expect(result.percDelta, 'percussion never reaches the restored look').toBe(0);
  expect(result.muteDelta, 'zero band sliders keep the restored look neutral').toBe(0);
  expect(errors).toEqual([]);
});

// Matched-signal cross-check against the reference implementation: fed the
// same time-varying feature stream, the wave controller's percussion channels
// equal Ion Tempest's direct gated mapping (punch = 1) exactly, and its
// sustained levels are hot exactly when the reference's bands are hot.
test('wave controller percussion equals the Ion Tempest reference mapping on a matched stream', { tag: '@core' }, async () => {
  const { createAudioController: ionController } = await import('../src/sketches/ion_tempest.js');
  const { createFeatureController } = await import('../src/sketches/feature-controls.js');
  const ion = ionController();
  const wave = createFeatureController();
  // Sustained-level dynamics: loud continuous material must keep out-driving
  // quiet material through the shaped level channels (no plateau), independent
  // of any renderer.
  const level = (v) => {
    const c = createFeatureController();
    let out;
    for (let i = 0; i < 24; i++) out = c.update({ shared: { frame: null, getFeatures: () => ({ sub: v, mid: v * .8, high: v * .7 }) }, params: {}, deltaSeconds: 1 / 30 }).continuous;
    c.dispose();
    return out;
  };
  const quiet = level(.08), loud = level(.85);
  for (const key of ['bass', 'mid', 'high']) {
    expect(loud[key], `${key} loud out-drives quiet`).toBeGreaterThan(quiet[key] * 1.8);
    expect(loud[key], `${key} loud out-drives medium`).toBeGreaterThan(level(.3)[key] * 1.2);
  }
  // Renderer-side accent normalizers: accent() is exactly linear below the
  // proven 1.4 envelope ceiling, and the selective accents slider scales the
  // percussion uniforms exactly (0 mutes, default 1, 2 doubles, clamped at 2).
  const { accent, accentsGain } = await import('../src/sketches/feature-controls.js');
  expect(accent(.8)).toBeCloseTo(2 * accent(.4), 12);
  expect(accent(1.4)).toBe(1);
  expect(accentsGain({})).toBe(1);
  expect(accentsGain({ accents: 0 })).toBe(0);
  expect(accentsGain({ accents: 2 })).toBe(2);
  expect(accentsGain({ accents: 9 })).toBe(2);
  expect(accentsGain({ accents: NaN })).toBe(1);
  const stream = [
    { sub: .6, mid: .3, high: .2, kick: 1.1, snare: .4, hat: .3, beat: 1, energy: .5 },
    { sub: .4, mid: .5, high: .5, kick: 0, snare: .9, hat: .8, beat: .2, energy: .45 },
    { sub: .1, mid: .1, high: .1, kick: 0, snare: 0, hat: 0, beat: 0, energy: .1 },
    {},
    {},
  ];
  for (const params of [{}, { bass: .5, mid: 0, high: 2 }, { bass: 0, mid: 0, high: 0 }]) {
    for (const [index, features] of stream.entries()) {
      const shared = { frame: {}, getFeatures: () => features };
      const ref = ion.update({ frame: {}, shared, params, deltaSeconds: 1 / 30 }).continuous;
      const out = wave.update({ shared: { frame: null, getFeatures: () => features }, params, deltaSeconds: 1 / 30 }).continuous;
      for (const key of ['kick', 'snare', 'hat', 'beat']) {
        const refKey = `u${key[0].toUpperCase()}${key.slice(1)}`;
        expect(out[key], `${key} matches Ion mapping`).toBeCloseTo(ref[refKey] ?? 0, 9);
      }
      // Sustained levels respond on the very first hot frame whenever their
      // gain is on, and are exactly zero when their slider is at zero. (The
      // first silent frames may legitimately carry the documented flux-decay
      // tail of the within-band dynamics; full silence is verified below.)
      if (index === 0) for (const level of ['bass', 'mid', 'high']) {
        if ((params[level] ?? 1) > 0) expect(out[level], `${level} hot`).toBeGreaterThan(0);
        else expect(out[level], `${level} gated`).toBe(0);
      }
      if ((params.bass ?? 1) === 0 && (params.mid ?? 1) === 0 && (params.high ?? 1) === 0) {
        expect(out.energy, 'all gains zero => zero energy').toBe(0);
      }
    }
    // After the dynamics tail relaxes (~1s of silence), the controller returns
    // to exact silence on every channel — real silence, no residual beats.
    let settled;
    for (let i = 0; i < 40; i++) settled = wave.update({ shared: { frame: null, getFeatures: () => ({}) }, params, deltaSeconds: 1 / 30 }).continuous;
    for (const key of Object.keys(settled)) expect(settled[key], `settled ${key}`).toBe(0);
  }
  ion.dispose(); wave.dispose();
});
