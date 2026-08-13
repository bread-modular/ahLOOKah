// Chroma Mandala — a 12-fold kaleidoscope mandala in full color.
// Mid energy blooms the petals outward, high energy spins the mandala and
// triggers glitch flashes, sub-bass pulses a spectral ring of dots around it.
// The opted-in path consumes hue/rotation/band scalars plus a bounded dot
// value array from a DOM-free capture-side controller; the legacy raw-frame
// path is preserved for all other callers.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    rotation: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    sub: { min: 0, max: 1.6, neutral: 0 },
    mid: { min: 0, max: 1.6, neutral: 0 },
    high: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {
    dotValues: { minLength: 64, maxLength: 64, min: 0, max: 1 },
  },
  events: {},
  neutral: {
    continuous: {
      hueOffset: 0,
      rotation: 0,
      sub: 0,
      mid: 0,
      high: 0,
    },
  },
});

export function analyzeMandalaBands(freqs) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  sub = sub / (4 * 255);
  mid = mid / (110 * 255);
  high = high / (350 * 255);
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

// The controller owns band extraction, hue drift, spin and the 64 spectral
// dot values. Petal geometry stays fully visual on the renderer.
export function createAudioController() {
  let hueOffset = 0;
  let rotation = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = analyzeMandalaBands(freqs.left);
      const spinSpeed = Math.max(0, Number(params.spin ?? 1));

      hueOffset = (hueOffset + (0.35 + b.energy * 2) * dt * 60) % 360;
      rotation += (0.002 + b.high * 0.06) * spinSpeed * dt * 60;
      if (Math.abs(rotation) > 900_000) rotation %= 100_000;

      // Spectral ring of dots: legacy mapped 64 dots over ~600 of 1024 bins.
      const left = freqs.left || new Uint8Array(0);
      const dotValues = new Float32Array(64);
      for (let d = 0; d < 64; d++) {
        const idx = left.length
          ? Math.min(left.length - 1, Math.floor((d / 64) * 600))
          : 0;
        dotValues[d] = left.length ? left[idx] / 255 : 0;
      }

      return {
        continuous: {
          hueOffset,
          rotation,
          sub: clamp(b.sub, 0, 1.6),
          mid: clamp(b.mid, 0, 1.6),
          high: clamp(b.high, 0, 1.6),
        },
        arrays: { dotValues },
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let hueOffset = 0;
  let rotation = 0;
  const audioControls = runtimeContext?.audioControls || null;

  // Teardrop petal built from plain vertex() points (p5 v2 removed curveVertex).
  // t goes -1..1; radius = r1 at the edges, r2 at the outward tip.
  function drawPetal(cx, cy, baseAngle, r1, r2, spread) {
    p.beginShape();
    for (let t = -1; t <= 1.0001; t += 0.1) {
      const ang = baseAngle + t * spread;
      const rr = r1 + (r2 - r1) * Math.cos((t * Math.PI) / 2);
      p.vertex(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr);
    }
    p.endShape(p.CLOSE);
  }

  function drawMandala(sub, mid, high, dotValues) {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const PETALS = P.petals ?? 12;
    const midBloom = P.bloom ?? 1;
    const subRing = P.sub ?? 1;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.min(p.width, p.height) * 0.48;
    const R1 = maxR * (0.3 + mid * 0.7 * midBloom);
    const R2 = maxR * (0.5 + mid * 0.5 * midBloom);

    p.noStroke();
    for (let k = 0; k < PETALS; k++) {
      const baseAngle = (k / PETALS) * p.TWO_PI + rotation;
      const hue = (hueOffset + k * (360 / PETALS)) % 360;

      // Outer petal (teardrop from inner ring out to tip)
      p.fill(hue, 85, 100, 180);
      drawPetal(cx, cy, baseAngle, R1, R2, 0.25);

      // Inner petal, offset half-step, brighter
      p.fill((hue + 60) % 360, 90, 100, 190);
      drawPetal(cx, cy, baseAngle + p.PI / PETALS, R1 * 0.45, R1 * 0.95, 0.32);
    }

    // Center glow, breathing with sub-bass
    const coreR = maxR * (0.08 + sub * 0.18 * subRing);
    p.fill(hueOffset, 100, 100, 200);
    p.circle(cx, cy, coreR * 2);
    p.fill((hueOffset + 120) % 360, 100, 100, 120);
    p.circle(cx, cy, coreR * 0.5);

    // Spectral ring of dots around the mandala (frequency map)
    const DOTS = 64;
    const ringR = maxR * (0.55 + sub * 0.15 * subRing);
    if (dotValues?.length) {
      for (let d = 0; d < DOTS; d++) {
        const v = dotValues[d];
        const a = (d / DOTS) * p.TWO_PI - rotation * 0.5;
        const rr = ringR + v * maxR * 0.35;
        const hue = (hueOffset + d * 5.6) % 360;
        p.fill(hue, 90, 100, 140 + v * 100);
        p.circle(cx + p.cos(a) * rr, cy + p.sin(a) * rr, 3 + v * 8);
      }
    }

    // Glitch flashes on loud high frequencies
    if (high > 0.5) {
      p.stroke((hueOffset + p.random(200)) % 360, 90, 100, 160);
      p.strokeWeight(1.5);
      for (let i = 0; i < 5; i++) {
        const y = p.random(p.height);
        p.line(0, y, p.width, y + p.random(-40, 40));
      }
      p.noStroke();
    }
  }

  function drawMigrated() {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.hueOffset;
    rotation = C.rotation;
    drawMandala(C.sub, C.mid, C.high, controls.arrays?.dotValues);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = analyzeMandalaBands(freqs ? freqs.left : null);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const spinSpeed = P.spin ?? 1;

    hueOffset = (hueOffset + 0.35 + b.energy * 2) % 360;
    rotation += (0.002 + b.high * 0.06) * spinSpeed;

    let dotValues = null;
    if (freqs) {
      dotValues = new Float32Array(64);
      for (let d = 0; d < 64; d++) {
        const idx = Math.floor(p.map(d, 0, 64, 0, 600));
        dotValues[d] = freqs.left[idx] / 255;
      }
    }
    drawMandala(b.sub, b.mid, b.high, dotValues);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
