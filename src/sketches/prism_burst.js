// Prism Burst — rotating god-ray shards from a blooming core.
// Rays fade out in three alpha steps (gradient feel), a counter-rotating
// inner ray set adds mechanical complexity, dust motes orbit in the beams,
// and the layered core bloom swells with every kick. Mainstage sunburst.
// The legacy raw-frame draw path remains intact; the opted-in path consumes
// final render controls produced by a DOM-free capture-side controller.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

const FULL_TURN = Math.PI * 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    energy: { min: 0, max: 2, neutral: 0.2 },
    sub: { min: 0, max: 2, neutral: 0.2 },
    high: { min: 0, max: 2, neutral: 0 },
    rotation: { min: 0, max: 7, neutral: 0 },
    hueOffset: { min: 0, max: 360, neutral: 0 },
    coreR: { min: 0, max: 300, neutral: 30 },
  },
  arrays: {
    // 200 normalized (0..1) spectrum samples, bin 2..201 of the legacy byte
    // spectrum, so the renderer's per-ray brightness lookup matches exactly.
    spectrum: { minLength: 200, maxLength: 200, min: 0, max: 1 },
  },
  events: {},
  neutral: {
    continuous: {
      energy: 0.2,
      sub: 0.2,
      high: 0,
      rotation: 0,
      hueOffset: 0,
      coreR: 30,
    },
  },
});

// The controller owns all audio interpretation on the capture owner: it
// reproduces the legacy makeBands envelope (attack 0.6 / release 0.14 per
// nominal 60 Hz frame, converted to elapsed time) over the shared byte
// spectrum, mirrors the renderer's idle fallbacks when no audio frame exists,
// advances rotation/hue phase, computes the core radius, and downsamples the
// per-ray brightness spectrum to a bounded normalized array.
export function createAudioController({ rng = Math.random } = {}) {
  let s = 0, m = 0, h = 0, e = 0;
  let rotation = 0;
  let hueOffset = 0;
  let elapsed = 0;
  return {
    update({ frame, shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(finite(deltaSeconds, 1 / 30), 1 / 240, 0.1);
      elapsed += dt;
      const bb = Math.max(0, finite(params.bass, 1));
      const mb = Math.max(0, finite(params.mid, 1));
      const hb = Math.max(0, finite(params.high, 1));
      const spin = Math.max(0, finite(params.spin, 1));
      const corePulse = Math.max(0, finite(params.core, 1));

      const freqs = frame ? (shared?.getByteFrequencies?.() || {}).left : null;
      let energy, sub, high;
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
        sub = s; high = h; energy = e;
      } else {
        // Legacy getBands keeps decaying its envelope toward zero while no
        // frequency data exists; mirror that so audio returns smoothly.
        const decay = 1 - Math.pow(1 - 0.14, dt * 60);
        s -= s * decay; m -= m * decay; h -= h * decay; e -= e * decay;
        const idle = 0.5 + 0.5 * Math.sin(elapsed * 60 * 0.02);
        energy = 0.2 + idle * 0.2;
        sub = 0.2 + idle * 0.2;
        high = idle * 0.3;
      }

      rotation = (rotation + (0.002 + energy * 0.02) * spin * dt * 60) % FULL_TURN;
      hueOffset = (hueOffset + (0.3 + energy * 2) * dt * 60) % 360;
      const coreR = clamp((14 + sub * 60) * corePulse, 0, 300);

      const spectrum = new Float32Array(200);
      if (freqs?.length) {
        for (let i = 0; i < 200; i++) spectrum[i] = clamp((freqs[i + 2] ?? 0) / 255, 0, 1);
      } else {
        // Legacy idle per-ray brightness (renderer had no bins when audio was
        // off); reproduced here so the idle look survives the migration.
        for (let i = 0; i < 200; i++) spectrum[i] = clamp(0.3 + 0.3 * Math.sin(elapsed * 60 * 0.03 + i), 0, 1);
      }

      return {
        continuous: {
          energy: clamp(energy, 0, 2),
          sub: clamp(sub, 0, 2),
          high: clamp(high, 0, 2),
          rotation: clamp(rotation, 0, 7),
          hueOffset,
          coreR,
        },
        arrays: { spectrum },
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let rotation = 0;
  let hueOffset = 0;
  const getBands = makeBands();
  const audioControls = runtimeContext?.audioControls || null;
  let dust = [];

  function buildDust() {
    dust = [];
    for (let i = 0; i < 60; i++) {
      dust.push({
        a: p.random(p.TWO_PI),
        r: p.random(0.2, 1),
        s: p.random(0.0005, 0.003),
        size: p.random(0.5, 2),
      });
    }
  }

  // Pure drawing shared by the migrated and legacy paths. All audio-derived
  // values arrive pre-computed; only visual state and params are used here.
  function drawScene({ rayCount, lengthMul, energy, sub, high, rotationValue, hueOffsetValue, coreR, spectrum, t }) {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.min(p.width, p.height) * 0.52 * lengthMul;

    // Outer rays — 3 fading segments each (gradient falloff)
    for (let i = 0; i < rayCount; i++) {
      const a = rotationValue + (i / rayCount) * p.TWO_PI;
      const bi = Math.floor((i / rayCount) * 200);
      const v = spectrum ? spectrum[bi] : 0.3 + 0.3 * p.sin(t * 0.03 + i);
      const len = coreR + v * maxR * (0.4 + energy);
      const hue = (hueOffsetValue + (i / rayCount) * 120) % 360;
      const w = (p.TWO_PI / rayCount) * 0.5;
      for (let s = 0; s < 3; s++) {
        const t0 = s / 3, t1 = (s + 1) / 3;
        const r0 = coreR + (len - coreR) * t0;
        const r1 = coreR + (len - coreR) * t1;
        const alpha = (1 - t0) * (1 - t0) * (60 + v * 160);
        const wa = w * (1 - t0 * 0.5);
        p.noStroke();
        p.fill(hue, 80, 95, alpha);
        p.triangle(
          cx + p.cos(a - wa) * r0, cy + p.sin(a - wa) * r0,
          cx + p.cos(a + wa) * r0, cy + p.sin(a + wa) * r0,
          cx + p.cos(a) * r1, cy + p.sin(a) * r1
        );
      }
      // Needle highlight on highs
      if (high > 0.2) {
        p.stroke(hue, 30, 100, high * 140);
        p.strokeWeight(0.8);
        p.line(cx + p.cos(a) * coreR, cy + p.sin(a) * coreR, cx + p.cos(a) * len, cy + p.sin(a) * len);
      }
    }

    // Counter-rotating inner rays
    const inner = Math.floor(rayCount / 3);
    for (let i = 0; i < inner; i++) {
      const a = -rotationValue * 1.6 + (i / inner) * p.TWO_PI;
      const len = coreR * (1.6 + 0.5 * p.sin(t * 0.05 + i));
      p.stroke((hueOffsetValue + 180) % 360, 70, 100, 90 + sub * 100);
      p.strokeWeight(1.2);
      p.line(cx + p.cos(a) * coreR * 0.5, cy + p.sin(a) * coreR * 0.5, cx + p.cos(a) * len, cy + p.sin(a) * len);
    }

    // Layered core bloom
    glowCircle(p, cx, cy, coreR * 0.5, hueOffsetValue, 80, 100, 0.6 + sub * 0.6);

    // Orbiting dust motes caught in the beams
    p.noStroke();
    for (const d of dust) {
      d.a += d.s * (1 + energy * 3);
      const rr = d.r * maxR * (0.5 + 0.5 * p.sin(t * 0.01 + d.r * 9));
      const tw = 0.4 + 0.6 * p.sin(t * 0.07 + d.r * 40);
      p.fill((hueOffsetValue + 200) % 360, 30, 100, (40 + high * 120) * tw);
      p.circle(cx + p.cos(d.a) * rr, cy + p.sin(d.a) * rr, d.size * (1 + high));
    }

    vignette(p, 0.55);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const rayCount = Math.floor(P.rays ?? 48);
    const spin = P.spin ?? 1;
    const lengthMul = P.length ?? 1;
    const corePulse = P.core ?? 1;

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.02);
    const energy = freqs ? b.energy : 0.2 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const high = freqs ? b.high : idle * 0.3;

    rotation += (0.002 + energy * 0.02) * spin;
    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;

    const coreR = (14 + sub * 60) * corePulse;

    const bin = freqs ? freqs.left : null;
    const spectrum = bin
      ? (() => {
        const arr = new Float32Array(200);
        for (let i = 0; i < 200; i++) arr[i] = (bin[i + 2] ?? 0) / 255;
        return arr;
      })()
      : null;

    drawScene({ rayCount, lengthMul, energy, sub, high, rotationValue: rotation, hueOffsetValue: hueOffset, coreR, spectrum, t });
  }

  // Opted-in path: every audio-derived value arrives from the capture owner.
  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const P = params || {};
    const rayCount = Math.floor(P.rays ?? 48);
    const lengthMul = P.length ?? 1;
    drawScene({
      rayCount,
      lengthMul,
      energy: C.energy,
      sub: C.sub,
      high: C.high,
      rotationValue: C.rotation,
      hueOffsetValue: C.hueOffset,
      coreR: C.coreR,
      spectrum: controls.arrays?.spectrum || null,
      t: p.frameCount,
    });
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    buildDust();
  };

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
