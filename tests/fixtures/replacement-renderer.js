// Browser-only deterministic test harness. No production hooks, FFT mocks in the
// output, frozen motion, wall-clock phase comparisons, or screenshot timing races.
import p5 from '/node_modules/p5/lib/p5.esm.js';
import { SKETCHES, defaultParamValues } from '/src/sketch-registry.js';
import { disposeP5Instance } from '/src/program-runtime.js';
export const W = 320, H = 180, FRAMES = 24, DT = 1 / 20;
const all = value => ({ sub: value, mid: value, high: value });
const samples = [8, 12, 16, 20, 23];

function paintCamera(canvas, frame) {
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#e2b440'); grad.addColorStop(.5, '#1c4c77'); grad.addColorStop(1, '#a32f54');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = ['#faf4dc', '#11d2b4', '#303356'][i % 3];
    ctx.fillRect((i * 59 + frame * 7) % 380 - 30, 12 + i * 23, 46, 32);
  }
  ctx.fillStyle = '#f86840'; ctx.beginPath(); ctx.arc(170 + Math.sin(frame * .18) * 80, 94, 27, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 18px monospace'; ctx.fillText('LIVE / 123', 8, 170);
}
export async function renderTimeline(id, featuresAt = () => ({}), patch = {}, controlsTimeline = null, checkResize = false) {
  // Pin Canvas2D to CPU from its first draw: Chromium's adaptive readback
  // promotion otherwise changes camera resampling partway through an audit.
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, options) {
    return getContext.call(this, type, type === '2d' ? { ...options, willReadFrequently: true } : options);
  };
  const sketch = SKETCHES.find(s => s.id === id), params = { ...defaultParamValues(id), ...patch };
  const camera = document.createElement('canvas'); camera.width = W; camera.height = H;
  Object.assign(camera, { videoWidth: W, videoHeight: H, readyState: 4 });
  const controller = sketch.createAudioController(); let features = {}, armed = false, reads = 0, frameIndex = 0;
  const runtime = {
    audioControls: { read() { reads++; if (controlsTimeline) return controlsTimeline[frameIndex]; return controller.update({ frame: {}, shared: { getFeatures: () => features }, params, deltaSeconds: DT }); } },
    createCapture(_p, _constraints, ready) { ready(); return { elt: camera, hide() {} }; },
  };
  const poison = { isStarted: true, getAnalysisFrame() { throw new Error('Render-side FFT scan'); } };
  const p = await new Promise(resolve => new p5(p => {
    sketch.factory(poison, null, params, runtime)(p);
    const setup = p.setup, draw = p.draw;
    p.setup = () => { setup(); p.noLoop(); resolve(p); };
    p.draw = () => { if (armed) { p.deltaTime = DT * 1000; draw(); } };
  }));
  const frames = [];
  try {
    for (let frame = 0; frame < FRAMES; frame++) {
      frameIndex = frame; paintCamera(camera, frame); features = featuresAt(frame); armed = true;
      await p.redraw(); armed = false;
      const gl = p._renderer.GL; let rgba;
      if (gl) {
        const raw = new Uint8Array(W * H * 4); rgba = new Uint8ClampedArray(raw.length);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('GL render/readback error');
        for (let y = 0; y < H; y++) rgba.set(raw.subarray(y * W * 4, (y + 1) * W * 4), (H - y - 1) * W * 4);
      } else rgba = new Uint8ClampedArray(p.drawingContext.getImageData(0, 0, W, H).data);
      frames.push(rgba);
    }
    if (reads !== FRAMES) throw new Error(`Expected exactly ${FRAMES} binding reads; got ${reads}`);
    if (checkResize) {
      p.windowWidth = 480; p.windowHeight = 270; p.windowResized();
      armed = true; await p.redraw(); armed = false;
      const gl = p._renderer.GL;
      if (gl && gl.getError() !== gl.NO_ERROR) throw new Error('GL resize error');
      frames.resized = [p.canvas.width, p.canvas.height];
    }
    return frames;
  } finally { controller.dispose(); disposeP5Instance(p); HTMLCanvasElement.prototype.getContext = getContext; }
}
export function png(rgba) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  return c.toDataURL();
}
function edges(rgba) {
  const luma = new Float32Array(W * H), mask = new Uint8Array(W * H); let max = 1;
  for (let j = 0; j < luma.length; j++) { luma[j] = (rgba[j * 4] + rgba[j * 4 + 1] + rgba[j * 4 + 2]) / 3; max = Math.max(max, luma[j]); }
  // Per-frame normalization rejects a mere exposure gain as a geometry change.
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    mask[i] = (Math.abs(luma[i + 1] - luma[i - 1]) + Math.abs(luma[i + W] - luma[i - W])) / max > .16 ? 1 : 0;
  }
  return mask;
}
export function difference(a, b) {
  let rgb = 0, changed = 0, edgeMoved = 0, union = 0, maxDelta = 0;
  const ea = edges(a), eb = edges(b);
  for (let i = 0; i < W * H; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) { const v = Math.abs(a[i * 4 + c] - b[i * 4 + c]); rgb += v; d = Math.max(d, v); }
    if (d > 16) changed++;
    maxDelta = Math.max(maxDelta, d);
    if (ea[i] !== eb[i]) edgeMoved++;
    if (ea[i] || eb[i]) union++;
  }
  return { rgb: rgb / (W * H * 3), coverage: changed / (W * H), edge: edgeMoved / (W * H), edgeRelocation: edgeMoved / Math.max(1, union), maxDelta };
}
function compare(a, b) {
  const values = samples.map(i => difference(a[i], b[i]));
  const metrics = Object.fromEntries(Object.keys(values[0]).map(k => [k, values.reduce((sum, v) => sum + v[k], 0) / values.length]));
  // Neutrality is checked across EVERY byte of EVERY frame, not only samples.
  let maxDelta = 0;
  outer: for (let f = 0; f < a.length; f++) for (let i = 0; i < a[f].length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs(a[f][i] - b[f][i]));
    if (maxDelta === 255) break outer;
  }
  return { ...metrics, maxDelta };
}
function diffPNG(a, b) {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) { for (let c = 0; c < 3; c++) out[i + c] = Math.abs(a[i + c] - b[i + c]) * 3; out[i + 3] = 255; }
  return png(out);
}
export async function audit(id) {
  const silence = await renderTimeline(id), duplicate = await renderTimeline(id);
  const modest = await renderTimeline(id, () => all(.2));
  const strong = await renderTimeline(id, () => all(.85));
  const pulse = await renderTimeline(id, f => all(f % 8 < 3 ? .85 : 0));
  const max = await renderTimeline(id, () => all(1.6), { bass: 2, mid: 2, high: 2 });
  const zero = await renderTimeline(id, () => all(.85), { bass: 0, mid: 0, high: 0 });
  const metrics = { duplicate: compare(silence, duplicate), modest: compare(silence, modest), strong: compare(silence, strong), pulse: compare(silence, pulse), zero: compare(silence, zero), autonomous: difference(silence[0], silence[23]), bands: {}, muted: {}, independent: {} };
  for (const [band, feature] of [['bass', 'sub'], ['mid', 'mid'], ['high', 'high']]) {
    metrics.bands[band] = compare(silence, await renderTimeline(id, () => ({ [feature]: .2 })));
    metrics.muted[band] = compare(silence, await renderTimeline(id, () => ({ [feature]: .85 }), { [band]: 0 }));
    const without = await renderTimeline(id, () => ({ ...all(.2), [feature]: 0 }));
    const sliderOff = await renderTimeline(id, () => all(.2), { [band]: 0 });
    metrics.independent[band] = compare(without, sliderOff);
  }
  const pixels = max[23]; let lit = 0, dark = 0, grayscale = true;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 60) lit++;
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 700) dark++;
    grayscale &&= pixels[i] === pixels[i + 1] && pixels[i] === pixels[i + 2] && pixels[i + 3] === 255;
  }
  metrics.max = { lit: lit / (W * H), dark: dark / (W * H), grayscale };
  return { id, metrics, stills: { silence: png(silence[20]), modest: png(modest[20]), strong: png(strong[20]), diff: diffPNG(silence[20], modest[20]) },
    animation: pulse.map((frame, i) => ({ silence: png(silence[i]), pulse: png(frame), diff: diffPNG(silence[i], frame) })) };
}
