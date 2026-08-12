// Neon Ribbons — flowing silk ribbons of light with real depth.
// GPU port: the CPU keeps the exact ribbon state — phase, speed, hue and the
// full trail point lists (including the live waveform wobble) — and uploads
// the trails every frame as a small RGBA data texture (16-bit fixed-point
// coordinates). The fragment shader finds each ribbon's nearest trail segment
// per-pixel (coarse-to-fine search + segment distance) and paints the same
// two-pass tapered strokes, bloom heads and vignette as the Canvas version.
// The legacy raw-frame path remains intact; the opted-in path receives the
// audio-derived header uniforms (uSub/uMid/uHigh/uEnergy) and the downsampled
// waveform wobble from a DOM-free capture-side controller while the renderer
// keeps all trail simulation and texture uploads.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';
import { makeBands } from './viz-utils.js';

const MAX_RIBBONS = 16;
const TRAIL_W = 256;

const frag = `${AUDIO_SHADER_HEADER}
  uniform sampler2D uTrailTex;
  uniform float uRibbonInfo[${MAX_RIBBONS * 4}];   // x: hue, y: trail length
  uniform float uRibbonBounds[${MAX_RIBBONS * 4}]; // minX, minY, maxX, maxY (px)
  uniform float uRibbonCount;
  uniform float uWidth;

  // CPU canvas semantics: pixel space, origin top-left, y down.
  vec2 toPx(vec2 uv) {
    return vec2((uv.x * 0.5 + 0.5) * uResolution.x, (1.0 - (uv.y * 0.5 + 0.5)) * uResolution.y);
  }

  float dotGlow(float d, float r) {
    return exp(-(d * d) / max(r * r, 0.001));
  }

  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
    return length(p - (a + ab * t));
  }

  // Shortest-path hue lerp (same as viz-utils lerpHue).
  float lerpHue(float a, float b, float t) {
    float d = mod(b - a + 540.0, 360.0) - 180.0;
    return mod(a + d * t + 360.0, 360.0);
  }

  // Decode a 16-bit fixed-point coordinate pair (RG / BA channels).
  vec2 decodePos(vec4 t) {
    float x16 = t.r * 65280.0 + t.g * 255.0;
    float y16 = t.b * 65280.0 + t.a * 255.0;
    return vec2(x16 / 65535.0 * uResolution.x, y16 / 65535.0 * uResolution.y);
  }

  vec2 trailPos(float j, float r) {
    vec2 uv = vec2((j + 0.5) / ${TRAIL_W}.0, (r + 0.5) / ${MAX_RIBBONS}.0);
    return decodePos(texture2D(uTrailTex, uv));
  }

  void main() {
    vec2 px = toPx(vTexCoord);
    vec3 color = vec3(0.0);

    for (int r = 0; r < ${MAX_RIBBONS}; r++) {
      if (float(r) >= uRibbonCount) break;
      float hue = uRibbonInfo[r * 4 + 0];
      float len = uRibbonInfo[r * 4 + 1];

      // Cheap bounding-box cull: ribbons are localized arcs, so most fragments
      // skip the per-ribbon search entirely.
      float bx0 = uRibbonBounds[r * 4 + 0] - 40.0;
      float by0 = uRibbonBounds[r * 4 + 1] - 40.0;
      float bx1 = uRibbonBounds[r * 4 + 2] + 40.0;
      float by1 = uRibbonBounds[r * 4 + 3] + 40.0;
      bool inside = px.x >= bx0 && px.x <= bx1 && px.y >= by0 && px.y <= by1;
      if (inside && len >= 2.0) {
        // Coarse-to-fine search for the nearest trail point.
        float bestJ = 0.0;
        float bestD = 1e9;
        for (int k = 0; k < 12; k++) {
          float j = floor((float(k) * (len - 1.0)) / 11.0);
          vec2 pj = trailPos(j, float(r));
          float d = length(px - pj);
          if (d < bestD) { bestD = d; bestJ = j; }
        }
        for (int k = 0; k < 7; k++) {
          float j = clamp(bestJ + float(k) - 3.0, 0.0, len - 1.0);
          vec2 pj = trailPos(j, float(r));
          float d = length(px - pj);
          if (d < bestD) { bestD = d; bestJ = j; }
        }

        // Distance to the two polyline segments straddling the best point;
        // the segment's trail parameter tt drives the width/alpha/hue taper.
        float tt = 0.0;
        float sd = 1e9;
        if (bestJ >= 1.0) {
          float d = segDist(px, trailPos(bestJ - 1.0, float(r)), trailPos(bestJ, float(r)));
          if (d < sd) { sd = d; tt = bestJ / len; }
        }
        if (bestJ <= len - 2.0) {
          float d = segDist(px, trailPos(bestJ, float(r)), trailPos(bestJ + 1.0, float(r)));
          if (d < sd) { sd = d; tt = (bestJ + 1.0) / len; }
        }
        tt = clamp(tt, 0.0, 1.0);

        // Two-pass glow stroke (wide soft + narrow hot), same alphas/weights
        // as the CPU per-segment strokes.
        float a = tt * tt * 200.0;
        float segHue = lerpHue(hue + 60.0, hue, tt) / 360.0;
        float w1 = (1.0 + tt * 5.0) * uWidth * (1.0 + uEnergy) * 2.2;
        float w2 = (1.0 + tt * 5.0) * uWidth * (1.0 + uEnergy) * 0.8;
        color += hsv2rgb(vec3(segHue, 0.85, 0.95)) * (a * 0.35 / 255.0)
          * exp(-(sd * sd) / max(w1 * w1 * 0.25, 0.001));
        color += hsv2rgb(vec3(segHue, 0.6, 1.0)) * (a / 255.0)
          * exp(-(sd * sd) / max(w2 * w2 * 0.25, 0.001));
      }

      // Glowing bloom head.
      vec2 head = trailPos(len - 1.0, float(r));
      float hr = (3.0 + uHigh * 8.0) * uWidth;
      float ha = 0.5 + uHigh * 0.5;
      float hd = length(px - head);
      float hh = hue / 360.0;
      color += hsv2rgb(vec3(hh, 0.6, 1.0)) * (16.0 * ha / 255.0) * dotGlow(hd, hr * 3.0);
      color += hsv2rgb(vec3(hh, 0.6, 1.0)) * (32.0 * ha / 255.0) * dotGlow(hd, hr * 1.6);
      color += hsv2rgb(vec3(hh, 0.3, 1.0)) * (90.0 * ha / 255.0) * dotGlow(hd, hr * 0.8);
      color += hsv2rgb(vec3(hh, 0.12, 1.0)) * (200.0 * ha / 255.0) * dotGlow(hd, hr * 0.4);
    }

    // Vignette (CPU: vignette(p, 0.45)).
    vec2 center = uResolution * 0.5;
    float v0 = min(center.x, center.y) * 0.5;
    float v1 = max(center.x, center.y) * 1.35;
    color *= 1.0 - 0.45 * smoothstep(v0, v1, length(px - center));

    // CPU accumulates under a 20/255 fade rect (steady state ≈ 12.75x).
    color = filmicTone(color * 12.75);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// The fragment shader and the CPU trail simulation read uSub/uMid/uHigh/uEnergy
// and the downsampled waveform (wobble). In the migrated path makeAudioShader
// hard-zeros the header uniforms, so the controller supplies all of them plus
// the bounded waveform array the renderer uses for head wobble.
export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uSub: { min: 0, max: 2, neutral: 0.2 },
    uMid: { min: 0, max: 2, neutral: 0.2 },
    uHigh: { min: 0, max: 2, neutral: 0 },
    uEnergy: { min: 0, max: 2, neutral: 0.18 },
  },
  arrays: {
    waveform: { minLength: 64, maxLength: 64, min: 0, max: 1 },
  },
  events: {},
  neutral: {
    continuous: { uSub: 0.2, uMid: 0.2, uHigh: 0, uEnergy: 0.18 },
  },
});

// The controller owns all audio interpretation on the capture owner. It
// reproduces the legacy makeBands envelope (attack 0.6 / release 0.14 per
// nominal 60 Hz frame, converted to elapsed time) over the shared byte
// spectrum, mirrors the renderer's idle fallbacks when no audio frame exists,
// and downsamples the left waveform to a bounded 64-sample normalized array.
export function createAudioController({ rng = Math.random } = {}) {
  let s = 0, m = 0, h = 0, e = 0;
  let elapsed = 0;
  return {
    update({ frame, shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(finite(deltaSeconds, 1 / 30), 1 / 240, 0.1);
      elapsed += dt;
      const bb = Math.max(0, finite(params.bass, 1));
      const mb = Math.max(0, finite(params.mid, 1));
      const hb = Math.max(0, finite(params.high, 1));

      const freqs = frame ? (shared?.getByteFrequencies?.() || {}).left : null;
      let sub, mid, high, energy;
      if (freqs?.length) {
        let rawSub = 0, rawMid = 0, rawHigh = 0;
        for (let i = 0; i < 4; i++) rawSub += freqs[i] || 0;
        for (let i = 40; i < 150; i++) rawMid += freqs[i] || 0;
        for (let i = 150; i < 500; i++) rawHigh += freqs[i] || 0;
        const targetSub = clamp((rawSub / (4 * 255)) * bb, 0, 2);
        const targetMid = clamp((rawMid / (110 * 255)) * mb, 0, 2);
        const targetHigh = clamp((rawHigh / (350 * 255)) * hb, 0, 2);
        const targetEnergy = clamp((targetSub + targetMid + targetHigh) / 3, 0, 2);
        const alpha = (cur, target) => 1 - Math.pow(1 - (target > cur ? 0.6 : 0.14), dt * 60);
        s += (targetSub - s) * alpha(s, targetSub);
        m += (targetMid - m) * alpha(m, targetMid);
        h += (targetHigh - h) * alpha(h, targetHigh);
        e += (targetEnergy - e) * alpha(e, targetEnergy);
        sub = s; mid = m; high = h; energy = e;
      } else {
        // Legacy getBands keeps decaying its envelope toward zero while no
        // frequency data exists; mirror that so audio returns smoothly.
        const decay = 1 - Math.pow(1 - 0.14, dt * 60);
        s -= s * decay; m -= m * decay; h -= h * decay; e -= e * decay;
        const idle = 0.5 + 0.5 * Math.sin(elapsed * 60 * 0.02);
        energy = 0.18 + idle * 0.2;
        mid = 0.2;
        high = idle * 0.3;
        sub = 0.2 + idle * 0.2;
      }

      const waveform = new Float32Array(64);
      const waves = frame ? (shared?.getByteWaveforms?.() || {}).left : null;
      if (waves?.length) {
        for (let i = 0; i < 64; i++) {
          const idx = Math.min(waves.length - 1, Math.floor((i / 64) * waves.length));
          waveform[i] = clamp((waves[idx] ?? 128) / 255, 0, 1);
        }
      }

      return {
        continuous: {
          uSub: clamp(sub, 0, 2),
          uMid: clamp(mid, 0, 2),
          uHigh: clamp(high, 0, 2),
          uEnergy: clamp(energy, 0, 2),
        },
        arrays: { waveform },
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => {
  const audioControls = runtimeContext?.audioControls || null;
  let ribbons = [];
  let hueOffset = 0;
  let frameCount = 0;
  let trailImg = null;
  const getBands = makeBands();

  function ensureRibbons(n) {
    while (ribbons.length < n) {
      ribbons.push({
        phase: Math.random() * 1000,
        speed: 0.5 + Math.random() * 1.0,
        hue: Math.random() * 360,
        trail: [],
      });
    }
    ribbons.length = Math.min(ribbons.length, n);
  }

  const mapUniforms = (P, bands_, p, controls) => {
    const count = Math.floor(P.ribbons ?? 6);
    const flow = P.flow ?? 1;
    const ribbonWidth = P.width ?? 1;
    const trailLen = Math.floor(P.trail ?? 60);
    ensureRibbons(count);

    const migrated = Boolean(controls);
    let energy, mid, high, sub, wave;
    if (migrated) {
      const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
      energy = C.uEnergy;
      mid = C.uMid;
      high = C.uHigh;
      sub = C.uSub;
      wave = controls.arrays?.waveform || null;
    } else {
      const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
      const waves = audio && audio.isStarted ? audio.getWaveforms() : null;
      const b = getBands(freqs ? freqs.left : null, P);
      const t = frameCount++;
      const idle = 0.5 + 0.5 * Math.sin(t * 0.02);
      energy = freqs ? b.energy : 0.18 + idle * 0.2;
      mid = freqs ? b.mid : 0.2;
      high = freqs ? b.high : idle * 0.3;
      sub = freqs ? b.sub : 0.2 + idle * 0.2;
      wave = waves ? waves.left : null;
    }

    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;

    if (!trailImg) {
      trailImg = p.createImage(TRAIL_W, MAX_RIBBONS);
      trailImg.loadPixels();
    }
    const pix = trailImg.pixels;
    const info = new Float32Array(MAX_RIBBONS * 4);
    const bounds = new Float32Array(MAX_RIBBONS * 4);

    for (let r = 0; r < count; r++) {
      const rb = ribbons[r];
      rb.phase += 0.004 * rb.speed * (1 + energy * 2) * flow;
      const wvRaw = wave ? wave[Math.floor((r / count) * wave.length)] : 0;
      const wv = migrated ? wvRaw : wvRaw / 255;
      // Multi-octave sine flow field — organic, never repeating.
      const fx = rb.phase * 0.7;
      const hx = p.width * (0.5
        + 0.32 * Math.sin(fx + rb.phase)
        + 0.12 * Math.sin(fx * 2.3 + 1.7)
        + 0.06 * Math.sin(fx * 4.1 + 4.2));
      const hy = p.height * (0.5
        + 0.3 * Math.sin(fx * 1.3 + rb.phase * 2)
        + 0.14 * Math.sin(fx * 2.9 + 0.6)
        + wv * 0.2 * (1 + mid * 2));
      rb.trail.push({ x: hx, y: hy });
      if (rb.trail.length > trailLen) rb.trail.shift();

      const hue = (hueOffset + rb.hue) % 360;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let j = 0; j < rb.trail.length; j++) {
        const pt = rb.trail[j];
        const nx = Math.max(0, Math.min(1, pt.x / p.width));
        const ny = Math.max(0, Math.min(1, pt.y / p.height));
        const x16 = Math.round(nx * 65535);
        const y16 = Math.round(ny * 65535);
        const idx = (j + r * TRAIL_W) * 4;
        pix[idx] = (x16 >> 8) & 255;
        pix[idx + 1] = x16 & 255;
        pix[idx + 2] = (y16 >> 8) & 255;
        pix[idx + 3] = y16 & 255;
        minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
      }
      info[r * 4 + 0] = hue;
      info[r * 4 + 1] = rb.trail.length;
      bounds[r * 4 + 0] = minX;
      bounds[r * 4 + 1] = minY;
      bounds[r * 4 + 2] = maxX;
      bounds[r * 4 + 3] = maxY;
    }
    if (count < MAX_RIBBONS) pix.fill(0, count * TRAIL_W * 4);
    trailImg.updatePixels();

    return {
      uTrailTex: trailImg,
      uRibbonInfo: info,
      uRibbonBounds: bounds,
      uRibbonCount: count,
      uWidth: ribbonWidth,
      uSub: sub,
      uMid: mid,
      uHigh: high,
      uEnergy: energy,
    };
  };

  return makeAudioShader(audio, params, frag, mapUniforms, audioControls ? { audioControls } : {});
};
