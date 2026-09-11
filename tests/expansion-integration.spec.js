import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';
const ALL = [...EXPANSION_PATTERNS, ...RESTORED_CAMERA_PATTERNS];
const output = process.env.EXPANSION_ARTIFACTS || 'test-results/expansion-evidence';
test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('actual Web Audio capture → analyser → noise floor → engine → packet/store → all 23 expansion renderers; real alpha compositing', { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async (ids) => {
    const { AudioManager } = await import('/src/audio-manager.js');
    const { PatternAudioControlEngine } = await import('/src/pattern-audio-engine.js');
    const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
    const { SKETCHES, defaultParamValues } = await import('/src/sketch-registry.js');
    const { renderTimeline, difference, png, W, H } = await import('/tests/fixtures/replacement-renderer.js');
    const patterns = ids.map((id) => SKETCHES.find((s) => s.id === id));
    const producer = new AudioContext(), destination = producer.createMediaStreamDestination();
    const gain = producer.createGain(); gain.gain.value = 0; gain.connect(destination);
    const oscillators = [70, 700, 7000].map((frequency) => {
      const o = producer.createOscillator(); o.frequency.value = frequency; o.connect(gain); o.start(); return o;
    });
    await producer.resume();
    const original = navigator.mediaDevices.getUserMedia;
    // Only acquisition is substituted: the AudioManager and Web Audio graph are real.
    navigator.mediaDevices.getUserMedia = async () => destination.stream.clone();
    const audio = new AudioManager();
    let now = 0, sequence = 0;
    const engine = new PatternAudioControlEngine({ ownerId: 'test-audio', getSketchById: (id) => patterns.find((s) => s.id === id), now: () => now });
    const store = new PatternAudioControlStore({ consumerSessionId: 'test-screen', interpolationDelayMs: 0, now: () => now });
    const slots = patterns.map((s) => ({ runtimeId: s.id, patternId: s.id, role: 'live', childIndex: 0, paramsRevision: 1, params: defaultParamValues(s.id), audioTransport: 'pattern-controls', audioControlSchema: s.audioControlSchema }));
    const plan = { type: 'pattern-audio-plan', version: 1, consumerSessionId: 'test-screen', planRevision: 1, sentAt: 0, complete: true, slots };
    engine.receivePlan(plan); store.setPlan(plan);
    const timelines = { silence: [], audio: [] }; let rms = 0, scans = 0, accepted = 0, sampleRate = 0;
    try {
      if (!await audio.startStream()) throw new Error('AudioManager acquisition failed');
      await audio.resume(true);
      navigator.mediaDevices.getUserMedia = original;
      for (const mode of ['silence', 'audio']) for (let i = 0; i < 24; i++) {
        gain.gain.value = mode === 'audio' ? .12 : 0;
        await new Promise((resolve) => setTimeout(resolve, 50)); now += 50;
        // Renew plan lease without replacing engine feature history.
        plan.sentAt = now; engine.receivePlan(plan);
        const frame = audio.getAnalysisFrame(); sampleRate = frame?.sampleRate; if (!frame) throw new Error('Missing real analysis frame');
        rms = Math.max(rms, Math.sqrt(frame.waveformLeft.reduce((s, v) => s + v * v, 0) / frame.waveformLeft.length));
        const update = engine.update({ frame, now, captureTime: now, sequence: ++sequence, deltaSeconds: .05 });
        scans += update.shared.diagnostics.featureBuilds;
        const received = store.acceptPacket(update.packets[0]); if (!received.accepted) throw new Error('Store rejected real audio packet'); accepted += received.slots;
        timelines[mode].push(structuredClone(store.createBinding(slots[0].runtimeId).read()));
      }
    } finally {
      navigator.mediaDevices.getUserMedia = original;
      await audio.releaseCurrentStream(); oscillators.forEach((o) => o.stop()); await producer.close(); engine.disposeControllers();
    }
    const rendered = [];
    for (const s of patterns) {
      const a = await renderTimeline(s.id, () => ({}), {}, timelines.silence);
      const b = await renderTimeline(s.id, () => ({}), {}, timelines.audio);
      const metrics = [8, 12, 16, 20, 23].map((i) => difference(a[i], b[i]));
      rendered.push({ id: s.id, rgb: metrics.reduce((v, m) => v + m.rgb, 0) / metrics.length, coverage: metrics.reduce((v, m) => v + m.coverage, 0) / metrics.length, edge: metrics.reduce((v, m) => v + m.edge, 0) / metrics.length });
    }
    // Exercise the real projection compositor with the new Alphas, not a
    // hand-coded luma blend (this application's established Alpha Blend is a
    // black key).
    const { ProjectionLayer } = await import('/src/projection/ProjectionLayer.js');
    const { surfaceQuadValues } = await import('/src/projection/projection-registry.js');
    const quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const alphas = [];
    for (const id of ['gobo-wheel', 'blinder-matrix']) {
      const host = document.createElement('div'); document.body.append(host);
      const values = { ...surfaceQuadValues('base', quad), ...surfaceQuadValues('matte', quad), alphaBlend: 1 };
      const layer = new ProjectionLayer({ host, pattern: { id: 'test-projection' }, getParams: () => values, getSize: () => [W, H] });
      const canvases = ['base', 'matte'].map((id2) => {
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        layer.sources.append(canvas); const node = { surface: { id: id2 } }; layer.children.push(node); return { canvas, node };
      });
      const [base, matte] = canvases; base.canvas.getContext('2d').fillStyle = '#164dcc'; base.canvas.getContext('2d').fillRect(0, 0, W, H); layer.capture(base.node, base.canvas);
      const masks = [await renderTimeline(id), await renderTimeline(id, () => ({ sub: .2, mid: .2, high: .2 }))];
      const images = [], counts = [];
      for (const mask of masks) {
        matte.canvas.getContext('2d').putImageData(new ImageData(mask[20], W, H), 0, 0); layer.capture(matte.node, matte.canvas); layer.render();
        if (!layer.renderer) throw new Error('Expected GPU alpha compositor');
        const gl = layer.renderer.gl, raw = new Uint8Array(W * H * 4), rgba = new Uint8ClampedArray(raw.length);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        for (let y = 0; y < H; y++) rgba.set(raw.subarray(y * W * 4, (y + 1) * W * 4), (H - y - 1) * W * 4);
        let blue = 0, white = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          if (Math.abs(rgba[i] - 22) < 2 && Math.abs(rgba[i + 1] - 77) < 2 && Math.abs(rgba[i + 2] - 204) < 2) blue++;
          if (rgba[i] > 250 && rgba[i + 1] > 250 && rgba[i + 2] > 250) white++;
        }
        counts.push({ blue: blue / (W * H), white: white / (W * H) }); images.push(png(rgba));
      }
      alphas.push({ id, counts, images }); layer.dispose(); host.remove();
    }
    return { sampleRate, fftSize: audio.fftSize, rms, scans, accepted, finalControls: timelines.audio.at(-1).continuous, silenceControls: timelines.silence.at(-1).continuous, rendered, alphas };
  }, ALL.map((s) => s.id));
  await mkdir(output, { recursive: true });
  for (const a of result.alphas) for (let i = 0; i < a.images.length; i++) await writeFile(`${output}/${a.id}-composite-${i}.png`, Buffer.from(a.images[i].split(',')[1], 'base64'));
  await writeFile(`${output}/integration.json`, JSON.stringify({ ...result, alphas: result.alphas.map(({ images, ...a }) => a) }, null, 2));
  expect(result.rms).toBeGreaterThan(.03);
  expect(result.scans).toBe(48);
  expect(result.accepted).toBe(48 * 23);
  expect(result.silenceControls).toEqual({ bass: 0, mid: 0, high: 0, kick: 0, snare: 0, hat: 0, beat: 0, energy: 0 });
  for (const key of ['bass', 'mid', 'high', 'energy']) expect(result.finalControls[key], key).toBeGreaterThan(.1);
  // Steady oscillator drone: percussion envelopes relax toward zero but stay valid.
  for (const key of ['kick', 'snare', 'hat', 'beat']) {
    expect(result.finalControls[key], key).toBeGreaterThanOrEqual(0);
    expect(result.finalControls[key], key).toBeLessThanOrEqual(1.4);
  }
  for (const row of result.rendered) {
    // The two restored legacy looks are deliberately subtle (documented in
    // expansion-restored-camera.spec.js); the 21 new patterns meet the full
    // structural floors.
    const restored = row.id === 'video-thermal' || row.id === 'video-edge-glow';
    expect(row.rgb, row.id).toBeGreaterThan(restored ? 1.5 : 6);
    expect(row.coverage, row.id).toBeGreaterThan(restored ? .02 : .1);
    expect(row.edge, row.id).toBeGreaterThan(restored ? .004 : .015);
  }
  for (const a of result.alphas) for (const counts of a.counts) {
    expect(counts.blue, `${a.id} reveals the lower blue layer`).toBeGreaterThan(.2);
    expect(counts.white, `${a.id} retains opaque white`).toBeGreaterThan(.02);
  }
});
