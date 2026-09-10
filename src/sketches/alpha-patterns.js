// Alphas: eight grayscale-on-black looks built for projection-mapping Alpha
// Blend. The mapper's black-key prepass turns pure black transparent, so every
// pattern keeps a true (0,0,0) background; whites punch through at full alpha
// and mid grays shade the edges. Brightness is therefore opacity once keyed.
// Single-pass shaders, no raymarch/feedback/per-pixel JS, band wiring matches
// the other lightweight collections (bass/mid/high, 0 mutes the band fully).
import { AUDIO_SHADER_HEADER } from './shader-utils.js';
import { BAND_PARAMS, bounded, makeBandShader, reactiveEntry } from './band-reactive.js';

const HEADER = `${AUDIO_SHADER_HEADER}
  uniform float uPhase;
  uniform float uBright;
  uniform float uDetail;
  uniform float uWarp;
  float lineGlow(float distance, float width) {
    return exp(-abs(distance) / max(width, 0.001));
  }
  vec2 screenPoint() {
    return (vTexCoord - 0.5) * vec2(uResolution.x / max(1.0, uResolution.y), 1.0) * 2.0;
  }
  // Grayscale only: value 0 must stay pure black so the black-key keeps the
  // background fully transparent; highs lift lit areas without fogging black.
  void finishAlpha(float value) {
    float v = clamp(value * (1.0 + uHigh * 0.5), 0.0, 1.0);
    gl_FragColor = vec4(vec3(clamp(v * uBright, 0.0, 1.0)), 1.0);
  }
`;

const LOOKS = [
  {
    id: 'alpha-rings', name: 'Alpha Rings', detail: 'Ring Density',
    description: 'Concentric white rings on black: bass widens the bands, mids ripple their rhythm, highs sharpen the glow.',
    body: `
      vec2 p = screenPoint();
      float r = length(p);
      float rings = sin(r * uDetail * 3.0 - uPhase * 2.0 + uMid * 2.5);
      float band = lineGlow(rings, (0.10 + uSub * 0.22) * (0.5 + uWarp));
      float shade = 0.55 + 0.45 * sin(r * 4.0 + uPhase);
      finishAlpha(band * shade * (1.0 - smoothstep(0.6, 1.6, r) * 0.6));
    `,
  },
  {
    id: 'alpha-bars', name: 'Alpha Bars', detail: 'Bar Count',
    description: 'Soft vertical bars on black: bass widens the bars, mids slide them sideways, highs raise the contrast.',
    body: `
      vec2 p = vTexCoord;
      float x = p.x + uMid * 0.06 * sin(p.y * 4.0 + uPhase);
      float bars = sin(x * uDetail * 6.2831 + uPhase);
      float v = lineGlow(bars, (0.22 + uSub * 0.30) * (0.5 + uWarp));
      v = pow(v, 1.0 + uHigh * 1.5);
      finishAlpha(v * (0.45 + 0.55 * p.y));
    `,
  },
  {
    id: 'alpha-grid', name: 'Alpha Grid', detail: 'Grid Density',
    description: 'White mesh on black: bass thickens the lines, mids wobble the weave, highs light the intersections.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.4;
      p += vec2(sin(p.y + uPhase), cos(p.x - uPhase)) * uMid * 0.15;
      vec2 g = abs(fract(p) - 0.5);
      float lines = lineGlow(min(g.x, g.y), (0.030 + uSub * 0.050) * (0.5 + uWarp));
      float nodes = lineGlow(length(g), 0.06) * (0.25 + uHigh * 0.75);
      finishAlpha(clamp(lines * 0.7 + nodes * 0.5, 0.0, 1.0));
    `,
  },
  {
    id: 'alpha-spot', name: 'Alpha Spot', detail: 'Falloff Scale',
    description: 'A soft spotlight pool on black: bass grows the pool, mids swirl the falloff rings, highs add a hot core.',
    body: `
      vec2 p = screenPoint();
      // Positive falloff across the full 0..3.2 band range: never invert
      // the exponent or collapse the radius into a full-screen white flash.
      float r = length(p) * 1.6 / ((1.0 + uSub * 0.45) * (0.5 + uWarp * 0.8));
      float fall = exp(-r * r * 2.2 / (1.0 + uSub * 0.35));
      float rings = 0.85 + 0.15 * sin(r * 14.0 * (0.5 + uDetail * 0.08) - uPhase * 3.0 + uMid * 4.0);
      float core = exp(-r * r * 14.0) * (0.35 + uHigh * 0.65);
      finishAlpha(clamp(fall * rings * 0.8 + core, 0.0, 1.0));
    `,
  },
  {
    id: 'alpha-sweep', name: 'Alpha Sweep', detail: 'Beam Count',
    description: 'Rotating light wedge on black: bass widens the beam, mids swing it around, highs streak the edges.',
    body: `
      vec2 p = screenPoint();
      float a = atan(p.y, p.x) + uPhase + uMid * 0.6;
      float spokes = sin(a * max(1.0, floor(uDetail * 0.5)));
      float beam = lineGlow(spokes, (0.06 + uSub * 0.20) * (0.5 + uWarp) * (1.0 + uHigh));
      float fade = 1.0 - smoothstep(0.0, 1.4, length(p));
      finishAlpha(beam * fade * (0.6 + 0.4 * sin(a * 2.0 - uPhase)));
    `,
  },
  {
    id: 'alpha-diamonds', name: 'Alpha Diamonds', detail: 'Diamond Density',
    description: 'A diamond lattice on black: bass scales the diamonds, mids slide alternate rows, highs sharpen the facets.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.5;
      p.x += uMid * 0.4 * sin(p.y * 0.5 + uPhase);
      vec2 q = abs(fract(p) - 0.5);
      float d = q.x + q.y;
      float v = lineGlow(d - 0.42 * (1.0 + uSub * 0.3), 0.05 * (0.5 + uWarp));
      finishAlpha(pow(v, 1.0 + uHigh));
    `,
  },
  {
    id: 'alpha-fog', name: 'Alpha Fog', detail: 'Fog Scale',
    description: 'Drifting gray fog on black: bass thickens the cover, mids stir the flow, highs reveal bright filaments.',
    body: `
      vec2 p = screenPoint();
      vec2 q = p * (0.8 + uDetail * 0.08) * (0.6 + uWarp * 0.8) + vec2(uPhase * 0.20, -uPhase * 0.12);
      float fog = fbm4(q + uMid * 0.6);
      float v = smoothstep(0.35, 0.90, fog) * (0.45 + uSub * 0.40);
      v += pow(fog, 8.0) * uHigh * 0.9;
      finishAlpha(clamp(v, 0.0, 1.0));
    `,
  },
  {
    id: 'alpha-waves', name: 'Alpha Waves', detail: 'Band Count',
    description: 'Soft horizontal wave bands on black: bass lifts the swell, mids bend the waves, highs trace the crests.',
    body: `
      vec2 p = screenPoint();
      float w = sin(p.x * 3.0 + uPhase + uMid * 1.5) * (0.15 + uSub * 0.25);
      float bands = sin((p.y + w) * uDetail * 2.0 - uPhase * 1.5);
      float v = lineGlow(bands, 0.18 * (0.5 + uWarp));
      float crest = pow(0.5 + 0.5 * bands, 16.0) * uHigh;
      finishAlpha(clamp(v * 0.7 + crest, 0.0, 1.0));
    `,
  },
];

function alphaFactory(body) {
  const fragment = `${HEADER}\nvoid main() {\n${body}\n}`;
  return (audio, _videoDeviceId, params = {}, runtimeContext = {}) => {
    let phase = 0;
    return makeBandShader(audio, params, fragment, (P, C, p) => {
      phase = (phase + bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1) * bounded(P.speed, 0.7, 0, 3)) % 10000;
      return {
        uSub: C.bass, uMid: C.mid, uHigh: C.high,
        uPhase: phase, uBright: bounded(P.bright, 1, 0.2, 1.6),
        uDetail: bounded(P.detail, 8, 2, 20), uWarp: bounded(P.warp, 0.5, 0, 2),
      };
    }, runtimeContext);
  };
}

export const ALPHA_PATTERNS = LOOKS.map(({ id, name, description, detail, body }) => reactiveEntry({
  id, name, description, group: 'Alphas', factory: alphaFactory(body),
  params: [
    { key: 'detail', label: detail, min: 2, max: 20, step: 1, default: 8 },
    { key: 'warp', label: 'Spread / Softness', min: 0, max: 2, step: 0.05, default: 0.5 },
    { key: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.05, default: 0.7 },
    { key: 'bright', label: 'Overall Brightness', min: 0.2, max: 1.6, step: 0.05, default: 1 },
    ...BAND_PARAMS,
  ],
}));
