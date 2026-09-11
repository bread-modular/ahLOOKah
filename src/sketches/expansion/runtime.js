// Expansion-only rendering helpers. Same transport architecture as the merged
// replacement runtime (one band scan on the capture owner; renderers consume
// final controls). Audio consumption copies the three reference
// implementations (Techno 3D, Circles, Ion Tempest) via the shared
// feature-controls transport: sustained band levels PLUS independent gated
// percussion/energy channels, direct mappings, no fabricated idle beats.
// The controller factory keeps its own identity so the existing provenance
// tests keep pinning exactly this wave's entries.
import { BAND_PARAMS, bounded } from '../band-reactive.js';
import { makeAudioFeatures } from '../audio-features.js';
import { AUDIO_SHADER_HEADER, makeAudioShader } from '../shader-utils.js';
import {
  ACCENTS_PARAM, FEATURE_SCHEMA, SILENT_FEATURES, accent, accentsGain,
  createFeatureController, measuredSupport, measuredSupportDb, response,
} from '../feature-controls.js';

export const TAU = Math.PI * 2;
export { accent, measuredSupport, measuredSupportDb, response };

// Distinct controller identity for this wave (provenance tests pin it); the
// implementation is the shared reference-derived transport.
export function createExpansionController() {
  return createFeatureController();
}

// Standalone sketches (docs preview, tests without ProgramRuntime) compute the
// same controls locally; the bound app path reads the capture owner's values.
export function makeExpansionReader(audio, params, runtime = {}) {
  if (runtime.audioControls) return () => runtime.audioControls.read()?.continuous || SILENT_FEATURES;
  const analyze = makeAudioFeatures(), controller = createFeatureController();
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
export const expansionParams = (detailLabel, { hue = true, accents = false } = {}) => [
  ...(detailLabel ? [{ key: 'detail', label: detailLabel, min: .5, max: 2, step: .05, default: 1 }] : []),
  { key: 'speed', label: 'Motion Speed', min: 0, max: 2, step: .05, default: .6 },
  ...(accents ? [{ ...ACCENTS_PARAM }] : []),
  ...(hue ? [{ key: 'hue', label: 'Palette Hue', min: 0, max: 1, step: .01, default: .53 }]: []),
  ...BAND_PARAMS,
];

export function expansionEntry({ id, name, group, description, factory, params, camera = false }) {
  return {
    id, name, group, factory, params, description,
    ...(camera ? { camera: true } : {}),
    audioReactive: true,
    audioTransport: 'pattern-controls',
    audioControlSchema: FEATURE_SCHEMA,
    createAudioController: createExpansionController,
  };
}

// Every canvas scene receives sustained levels (b/m/h), gated percussion
// (kick/snare/hat/beat, normalized 0..1) and aggregate energy on top of its
// autonomous structural motion — exactly the reference mapping style.
export const featureArgs = (c, params, time, p) => {
  const accents = accentsGain(params);
  return {
    t: time,
    b: response(c.bass), m: response(c.mid), h: response(c.high),
    kick: accent(c.kick) * accents, snare: accent(c.snare) * accents,
    hat: accent(c.hat) * accents, beat: accent(c.beat) * accents,
    energy: response(c.energy),
    aspect: p.width / Math.max(1, p.height),
    detail: bounded(params.detail, 1, .5, 2), hue: bounded(params.hue, .53, 0, 1),
  };
};

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
      draw(ctx, featureArgs(c, params, time, p));
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
// scenes plus the gated percussion uniforms (uKick/uSnare/uHat/uBeat at the
// references' 0..1.4 envelope scale, uEnergy capped at the Ion 1.6 range).
export function shaderFactory(source) {
  return (audio, _device, params = {}, runtime = {}) => (p) => {
    let time = 0;
    const read = makeExpansionReader(audio, params, runtime);
    const audioControls = runtime.audioControls || { read: () => ({ continuous: read(bounded(p.deltaTime / 1000, 1 / 60, 0, .1)) }) };
    makeAudioShader(audio, params, `${HEADER}\n${source}`, (P, _bands, _p, controls) => {
      const c = controls?.continuous || SILENT_FEATURES;
      const accents = accentsGain(P);
      time += bounded(p.deltaTime / 1000, 1 / 60, 0, .1) * bounded(P.speed, .6, 0, 2);
      return {
        uTime: time, uSub: response(c.bass), uMid: response(c.mid), uHigh: response(c.high),
        uKick: bounded(c.kick, 0, 0, 1.4) * accents, uSnare: bounded(c.snare, 0, 0, 1.4) * accents,
        uHat: bounded(c.hat, 0, 0, 1.4) * accents, uBeat: bounded(c.beat, 0, 0, 1.4) * accents,
        uEnergy: Math.min(1.6, bounded(c.energy, 0, 0, 3.2)),
        uSpeed: 1, uDetail: bounded(P.detail, 1, .5, 2), uHue: bounded(P.hue, .53, 0, 1),
      };
    }, { audioControls, renderScale: 1 })(p);
  };
}
