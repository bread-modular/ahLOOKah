// Ten single-pass looks. Analytic shapes / short fixed loops only: no raymarch,
// feedback buffers, per-pixel JS, or resolution-dependent object counts.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';
import { BAND_PARAMS, bounded, reactiveEntry } from './band-reactive.js';

const HEADER = `${AUDIO_SHADER_HEADER}
  uniform float uPhase;
  uniform float uHue;
  uniform float uDetail;
  uniform float uWarp;
  vec3 palette(float shift) {
    return hsv2rgb(vec3(fract(uHue + shift + uHigh * 0.075), 0.8, 1.0));
  }
  float lineGlow(float distance, float width) {
    return exp(-abs(distance) / max(width, 0.001));
  }
  vec2 screenPoint() {
    return (vTexCoord - 0.5) * vec2(uResolution.x / max(1.0, uResolution.y), 1.0) * 2.0;
  }
  void finishColor(vec3 color) {
    gl_FragColor = vec4(filmicTone(color * (1.2 + uHigh * 0.6)), 1.0);
  }
`;

const LOOKS = [
  {
    id: 'beat-weave', name: 'Beat Weave', group: 'Rhythmic', detail: 'Weave Density',
    description: 'Interlaced ribbons: bass opens the weave, mids bend it, highs change its light.',
    body: `
      vec2 p = screenPoint();
      float a = sin(p.x * uDetail + sin(p.y * 3.0 + uPhase) * (uWarp + uMid));
      float b = sin(p.y * uDetail - uPhase * 2.0 + sin(p.x * 2.0) * uMid);
      float width = 0.04 + uSub * 0.1;
      vec3 col = palette(p.y * 0.1) * lineGlow(a, width);
      col += palette(0.45 + p.x * 0.1) * lineGlow(b, width);
      finishColor(col);
    `,
  },
  {
    id: 'ripple-lattice', name: 'Ripple Lattice', group: 'Rhythmic', detail: 'Lattice Density',
    description: 'Synchronized tiled ripples: bass expands rings, mids offset their rhythm, highs tint them.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.45;
      vec2 cell = floor(p);
      vec2 q = fract(p) - 0.5;
      float wave = sin(length(q) * (18.0 + uWarp * 6.0) - uPhase * 4.0
        - uSub * 3.0 + sin(cell.x + cell.y) * uMid * 3.0);
      float ring = lineGlow(wave, 0.15 + uSub * 0.12);
      finishColor(palette((cell.x + cell.y) * 0.035) * ring);
    `,
  },
  {
    id: 'polygon-tunnel', name: 'Polygon Tunnel', group: '3D', detail: 'Tunnel Sides',
    description: 'An endless polygon tunnel: bass pumps depth, mids twist it, highs illuminate the ribs.',
    body: `
      vec2 p = rotate2d(uPhase * 0.12 + uMid * 0.2) * screenPoint();
      float radius = max(length(p), 0.015);
      float angle = atan(p.y, p.x);
      float sector = VIZ_TAU / max(3.0, floor(uDetail));
      float polygon = radius * cos(mod(angle + sector * 0.5, sector) - sector * 0.5);
      float depth = -log(max(polygon, 0.01)) * (3.0 + uWarp);
      float ring = abs(fract(depth - uPhase * 1.2 - uSub * 0.5) - 0.5);
      float ribs = abs(sin(angle * max(3.0, floor(uDetail)) * 0.5));
      vec3 col = palette(depth * 0.07) * lineGlow(ring, 0.025 + uSub * 0.015);
      col += palette(0.4) * lineGlow(ribs, 0.025) * 0.5;
      finishColor(col * smoothstep(0.015, 0.12, radius));
    `,
  },
  {
    id: 'orbital-cages', name: 'Orbital Cages', group: '3D', detail: 'Orbit Count',
    description: 'Tilted orbital wire rings: bass expands the cage, mids change its tilt, highs color the edges.',
    body: `
      vec2 p = screenPoint() / (0.85 + uSub * 0.12);
      vec3 col = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        vec2 q = rotate2d(fi * 0.36 + uPhase * 0.3) * p;
        float tilt = 0.3 + abs(sin(fi * 0.6 + uPhase * 0.2 + uMid * 0.4)) * 0.7;
        float ring = length(q * vec2(1.0, 1.0 / tilt)) - (0.38 + fi * 0.045);
        col += palette(fi * 0.06) * lineGlow(ring, 0.003 + uWarp * 0.005);
      }
      finishColor(col);
    `,
  },
  {
    id: 'silk-flow', name: 'Silk Flow', group: 'Cinematic / Shaders', detail: 'Silk Folds',
    description: 'Iridescent flowing silk: bass lifts folds, mids curl the fabric, highs reveal highlights.',
    body: `
      vec2 p = screenPoint();
      float fold = p.y + sin(p.x * 2.2 + uPhase * 0.7) * (0.3 + uSub * 0.25);
      fold += sin(p.x * 3.7 - uPhase * 0.5 + uMid) * uWarp * 0.2;
      float wave = sin(fold * uDetail + sin(p.x + uPhase) * uMid * 2.0);
      float sheen = pow(0.5 + 0.5 * wave, 6.0);
      vec3 col = palette(fold * 0.18) * (0.08 + sheen * 1.3);
      col += palette(0.45) * pow(1.0 - abs(wave), 18.0) * 0.5;
      finishColor(col);
    `,
  },
  {
    id: 'prism-caustics', name: 'Prism Caustics', group: 'Cinematic / Shaders', detail: 'Caustic Scale',
    description: 'Liquid refracted light: bass swells cells, mids distort ripples, highs split their colors.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.45 / (1.0 + uSub * 0.2);
      vec2 q = p + vec2(sin(p.y + uPhase), cos(p.x - uPhase * 0.8)) * (uWarp + uMid * 0.6);
      float caustic = abs(sin(q.x + sin(q.y)) * cos(q.y + cos(q.x)));
      vec3 col = palette(q.x * 0.04) * pow(1.0 - caustic, 12.0);
      col += palette(0.4 + q.y * 0.03) * pow(caustic, 8.0) * 0.7;
      finishColor(col);
    `,
  },
  {
    id: 'laser-fan', name: 'Laser Fan', group: 'Neon / Lasers', detail: 'Beam Count',
    description: 'Sweeping laser fans: bass opens the beams, mids sweep them, highs heat their cores.',
    body: `
      vec2 p = screenPoint();
      vec2 origin = vec2(sin(uPhase * 0.5) * 0.45, -0.8);
      vec2 q = p - origin;
      float a = atan(q.x, q.y) + sin(uPhase) * 0.2 + uMid * 0.2;
      float beams = sin(a * uDetail * (1.0 + uSub * 0.15));
      float glow = lineGlow(beams, 0.025 + uWarp * 0.025);
      float fade = 1.0 / (1.0 + length(q) * 0.7);
      finishColor(palette(a * 0.15) * glow * fade * 2.0);
    `,
  },
  {
    id: 'neon-hex', name: 'Neon Hex', group: 'Neon / Lasers', detail: 'Hex Density',
    description: 'Pulsing neon honeycomb: bass opens cell cores, mids send waves, highs energize outlines.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.5;
      vec2 grid = vec2(1.7320508, 3.0);
      vec2 a = mod(p, grid) - grid * 0.5;
      vec2 b = mod(p - grid * 0.5, grid) - grid * 0.5;
      vec2 q = dot(a, a) < dot(b, b) ? a : b;
      float hex = max(abs(q.x), abs(q.x) * 0.5 + abs(q.y) * 0.8660254);
      float rim = lineGlow(hex - 0.8, 0.025 + uSub * 0.035);
      float wave = 0.55 + 0.45 * sin(length(p) * uWarp - uPhase * 3.0 + uMid * 3.0);
      finishColor(palette(length(p) * 0.025) * rim * (0.35 + wave));
    `,
  },
  {
    id: 'data-rain', name: 'Data Rain', group: 'Glitch / Effects', detail: 'Data Columns',
    description: 'Falling digital glyphs: bass lengthens streams, mids scramble glyphs, highs brighten heads.',
    body: `
      vec2 p = vTexCoord * vec2(uDetail * 2.0, uDetail * 1.5);
      vec2 cell = floor(p);
      vec2 q = fract(p);
      float rate = 0.5 + hash11(cell.x) * (1.0 + uWarp);
      float head = fract(cell.y / (uDetail * 1.5) + uPhase * rate * 0.2 + hash11(cell.x));
      float tail = pow(head, max(1.0, 6.0 - uSub * 2.0));
      float glyph = step(0.4, hash21(cell + floor(uPhase * 4.0 + uMid * 7.0)));
      float mask = step(0.2, q.x) * (1.0 - step(0.8, q.x)) * step(0.15, q.y) * (1.0 - step(0.85, q.y));
      finishColor(palette(cell.x * 0.006) * tail * (0.15 + glyph) * mask * 2.0);
    `,
  },
  {
    id: 'signal-tear', name: 'Signal Tear', group: 'Glitch / Effects', detail: 'Signal Bands',
    description: 'Broken neon signal: bass tears strips, mids bend interference, highs split color channels.',
    body: `
      vec2 p = screenPoint();
      float strip = floor(p.y * uDetail);
      float jitter = (hash11(strip + floor(uPhase * 8.0)) - 0.5) * (0.03 + uSub * 0.45) * uWarp;
      p.x += jitter;
      float wave = sin(p.x * 6.0 + sin(p.y * 4.0 + uPhase) * (1.0 + uMid));
      float split = 0.03 + uHigh * 0.15;
      vec3 col = vec3(lineGlow(wave - split, 0.09), lineGlow(wave, 0.09), lineGlow(wave + split, 0.09));
      col *= palette(strip * 0.025) + 0.3;
      finishColor(col * (0.65 + 0.35 * sin(p.y * uDetail * 5.0)));
    `,
  },
];

function factoryFor(body) {
  const fragment = `${HEADER}\nvoid main() {\n${body}\n}`;
  return (audio, _videoDeviceId, params = {}, runtimeContext = {}) => {
    let phase = 0;
    return makeAudioShader(audio, params, fragment, (P, bands, p, controls) => {
      const C = controls?.continuous || { bass: bands.sub, mid: bands.mid, high: bands.high };
      phase = (phase + bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1) * bounded(P.speed, 0.7, 0, 3)) % 10000;
      return {
        uSub: C.bass, uMid: C.mid, uHigh: C.high,
        uPhase: phase, uHue: bounded(P.hue, 0.55, 0, 1),
        uDetail: bounded(P.detail, 8, 3, 20), uWarp: bounded(P.warp, 0.7, 0, 2),
      };
    }, { audioControls: runtimeContext.audioControls, renderScale: 1 });
  };
}

export const LIGHTWEIGHT_PATTERNS = LOOKS.map(({ id, name, group, description, detail, body }) => reactiveEntry({
  id, name, group, description, factory: factoryFor(body),
  params: [
    { key: 'detail', label: detail, min: 3, max: id === 'orbital-cages' ? 12 : 20, step: 1, default: 8 },
    { key: 'warp', label: 'Shape / Spread', min: 0, max: 2, step: 0.05, default: 0.7 },
    { key: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.05, default: 0.7 },
    { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.55 },
    ...BAND_PARAMS,
  ],
}));
