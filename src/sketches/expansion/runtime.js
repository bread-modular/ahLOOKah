// Expansion-only rendering helpers. Same transport architecture as the merged
// replacement runtime (one band scan on the capture owner; renderers consume
// final controls; canonical features supplemented by integrated cleaned band
// power so real weak signals — especially fresh treble after a loud passage —
// still move the picture). Fully self-contained: nothing imports from
// ../replacements/, and the controller factory keeps its own identity so the
// existing provenance tests keep pinning exactly the 18 replacements.
import { BAND_PARAMS, BAND_SCHEMA, SILENT_BANDS, bounded } from '../band-reactive.js';
import { getBandSplit, makeAudioFeatures } from '../audio-features.js';
import { AUDIO_SHADER_HEADER, makeAudioShader } from '../shader-utils.js';

export const TAU = Math.PI * 2;

// Final geometry amplitude is LINEAR in the slider (0..1). No second
// compressor after gain — that made the upper half of the sliders ineffective.
export const response = (x) => bounded(x, 0, 0, 3.2) / 3.2;

const smooth = (lo, hi, x) => { const v = bounded((x - lo) / (hi - lo), 0, 0, 1); return v * v * (3 - 2 * v); };

// Finite slope, no noise pedestal, plus a linear shoulder for loud-track
// headroom. Modest real levels (0.2) already read as strong geometry drive.
const lift = (value) => {
  const x = bounded(value, 0, 0, 1.6);
  return 1.6 * (.72 * x / (x + .025) + .28 * x / 1.6) / (.72 * 1.6 / 1.625 + .28);
};

export function expansionBands(features = {}, params = {}) {
  return Object.fromEntries(['bass', 'mid', 'high'].map((key, i) => [key,
    lift(features?.[['sub', 'mid', 'high'][i]]) * bounded(params[key], 1, 0, 2)]));
}

// Canonical power/bin normalization + slow AGC can produce EXACT zero after a
// loud-to-quiet transition, especially for sparse treble. Multiplying that zero
// cannot help. Supplement it with cleaned, integrated band power (not bin
// mean). Capture-side only, cached once per SharedAudioAnalysisView so LIVE /
// CUE / merge instances share one scan. Never read an analyser in a renderer.
const supportCache = new WeakMap();
export function measuredSupport(shared, frame = shared?.frame) {
  if (!frame?.left?.length && !frame?.right?.length) return SILENT_BANDS;
  if (shared && supportCache.has(shared)) return supportCache.get(shared);
  const channels = [frame.left, frame.right].filter((a) => a?.length);
  const count = Math.max(...channels.map((a) => a.length));
  const sampleRate = bounded(frame.sampleRate, 48000, 8000, 384000);
  const fftSize = bounded(frame.fftSize, count * 2, count * 2, 32768);
  const split = getBandSplit(), sums = [0, 0, 0];
  const power = (db) => 10 ** (bounded(db, -120, -120, 0) / 10);
  for (let i = 1; i < count; i++) {
    const hz = i * sampleRate / fftSize;
    if (hz < 30 || hz > 16000) continue;
    const band = hz < split.low ? 0 : hz < split.high ? 1 : 2;
    for (const channel of channels) sums[band] += power(channel[i]) / channels.length;
  }
  // Respect noise-floor's cleaned RMS override; do not undo its hard gate.
  let rms = frame.rms;
  if (!Number.isFinite(rms)) {
    let sum = 0, samples = 0;
    for (const wave of [frame.waveformLeft, frame.waveformRight]) if (wave?.length) {
      for (const value of wave) { sum += bounded(value, 0, -1, 1) ** 2; samples++; }
    }
    rms = Math.sqrt(samples ? sum / samples : sums.reduce((a, b2) => a + b2, 0));
  }
  const gate = smooth(-72, -48, 20 * Math.log10(Math.max(1e-12, rms)));
  const result = Object.fromEntries(['bass', 'mid', 'high'].map((key, i) => [key,
    smooth(-82, -30, 10 * Math.log10(Math.max(1e-12, sums[i]))) * gate]));
  if (shared) supportCache.set(shared, result);
  return result;
}

// Every expansion pattern ships final band controls from the capture owner:
// the stronger of the canonical feature envelope and the integrated support,
// smoothed per band, with each slider applied AFTER shaping (linear; zero is
// exactly silent; bands never mix).
export function createExpansionController() {
  const envelope = { ...SILENT_BANDS };
  return {
    update({ shared, frame = shared?.frame, params = {}, deltaSeconds = 1 / 30 }) {
      const canonical = expansionBands(shared?.getFeatures?.());
      const support = measuredSupport(shared, frame);
      const dt = bounded(deltaSeconds, 1 / 30, 1 / 240, .1);
      const continuous = {};
      for (const [i, key] of ['bass', 'mid', 'high'].entries()) {
        const target = lift(support[key]);
        const seconds = target > envelope[key] ? [.012, .018, .008][i] : [.11, .14, .065][i];
        envelope[key] += (target - envelope[key]) * (1 - Math.exp(-dt / seconds));
        if (envelope[key] < 1e-6) envelope[key] = 0;
        continuous[key] = Math.max(canonical[key], envelope[key]) * bounded(params[key], 1, 0, 2);
      }
      return { continuous, arrays: {}, events: [] };
    },
    dispose() { Object.assign(envelope, SILENT_BANDS); },
  };
}

// Standalone sketches (docs preview, tests without ProgramRuntime) compute the
// same controls locally; the bound app path reads the capture owner's values.
export function makeExpansionReader(audio, params, runtime = {}) {
  if (runtime.audioControls) return () => runtime.audioControls.read()?.continuous || SILENT_BANDS;
  const analyze = makeAudioFeatures(), controller = createExpansionController();
  return (dt) => {
    const frame = audio?.isStarted ? audio.getAnalysisFrame?.() : null;
    return controller.update({ frame, shared: { frame, getFeatures: () => analyze(frame, {}, dt) }, params, deltaSeconds: dt }).continuous;
  };
}

export const color = (hue, light = 65, saturation = 85, alpha = 1) =>
  alpha >= 1 ? `hsl(${hue * 360} ${saturation}% ${light}%)` : `hsl(${hue * 360} ${saturation}% ${light}% / ${alpha})`;

// Exact grayscale for the Alphas group (r=g=b by construction, opaque).
export const gray = (value, alpha = 1) => {
  const v = Math.round(bounded(value, 0, 0, 1) * 255);
  return alpha >= 1 ? `rgb(${v} ${v} ${v})` : `rgb(${v} ${v} ${v} / ${alpha})`;
};

// Deterministic per-index hash (stable across frames, so silent renders are
// bit-for-bit reproducible).
export const hash = (i, seed = 0) => {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453123;
  return x - Math.floor(x);
};

export function path(ctx, points, fill, stroke, width = .012) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  if (fill) { ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

export function circle(ctx, x, y, r, fill, stroke, width = .012) {
  ctx.beginPath(); ctx.arc(x, y, Math.max(.001, r), 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

// Shared slider set: one pattern-specific "detail" control, autonomous motion
// speed, palette hue (skipped for Alphas/Video FX), then the three band gains.
export const expansionParams = (detailLabel, { hue = true } = {}) => [
  ...(detailLabel ? [{ key: 'detail', label: detailLabel, min: .5, max: 2, step: .05, default: 1 }] : []),
  { key: 'speed', label: 'Motion Speed', min: 0, max: 2, step: .05, default: .6 },
  ...(hue ? [{ key: 'hue', label: 'Palette Hue', min: 0, max: 1, step: .01, default: .53 }] : []),
  ...BAND_PARAMS,
];

export function expansionEntry({ id, name, group, description, factory, params, camera = false }) {
  return {
    id, name, group, factory, params, description,
    ...(camera ? { camera: true } : {}),
    audioReactive: true,
    audioTransport: 'pattern-controls',
    audioControlSchema: BAND_SCHEMA,
    createAudioController: createExpansionController,
  };
}

// Canvas scene in centered unit space (y ∈ [-1,1]); draw receives lifted,
// response-mapped bands b/m/h plus time and bounded params. Background is the
// shared deep stage blue unless a pattern needs pure black (Alphas).
export function canvasFactory(draw, { background = '#050811' } = {}) {
  return (audio, _device, params = {}, runtime = {}) => (p) => {
    let time = 0;
    const read = makeExpansionReader(audio, params, runtime);
    p.setup = () => { p.pixelDensity(1); p.createCanvas(p.windowWidth, p.windowHeight); };
    p.draw = () => {
      const dt = bounded(p.deltaTime / 1000, 1 / 60, 0, .1);
      time += dt * bounded(params.speed, .6, 0, 2);
      const c = read(dt), ctx = p.drawingContext;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = background; ctx.fillRect(0, 0, p.width, p.height);
      ctx.save(); ctx.translate(p.width / 2, p.height / 2); ctx.scale(p.height / 2, p.height / 2);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      draw(ctx, {
        t: time, b: response(c.bass), m: response(c.mid), h: response(c.high),
        aspect: p.width / Math.max(1, p.height),
        detail: bounded(params.detail, 1, .5, 2), hue: bounded(params.hue, .53, 0, 1),
      });
      ctx.restore();
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
  };
}

export const HEADER = `${AUDIO_SHADER_HEADER}
  uniform float uSpeed;
  uniform float uDetail;
  uniform float uHue;
  vec3 ink(float shift) { return hsv2rgb(vec3(fract(uHue + shift), .72, 1.0)); }
  float line(float distance, float width) { return 1.0 - smoothstep(width, width + .012, abs(distance)); }
`;

// Full-screen GPU looks read the same lifted band controls as the canvas
// scenes (uSub/uMid/uHigh are response-mapped by the factory; time accumulates
// locally so speed=0 freezes motion deterministically).
export function shaderFactory(source) {
  return (audio, _device, params = {}, runtime = {}) => (p) => {
    let time = 0;
    const read = makeExpansionReader(audio, params, runtime);
    const audioControls = runtime.audioControls || { read: () => ({ continuous: read(bounded(p.deltaTime / 1000, 1 / 60, 0, .1)) }) };
    makeAudioShader(audio, params, `${HEADER}\n${source}`, (P, _bands, _p, controls) => {
      const c = controls?.continuous || SILENT_BANDS;
      time += bounded(p.deltaTime / 1000, 1 / 60, 0, .1) * bounded(P.speed, .6, 0, 2);
      return {
        uTime: time, uSub: response(c.bass), uMid: response(c.mid), uHigh: response(c.high),
        uSpeed: 1, uDetail: bounded(P.detail, 1, .5, 2), uHue: bounded(P.hue, .53, 0, 1),
      };
    }, { audioControls, renderScale: 1 })(p);
  };
}
