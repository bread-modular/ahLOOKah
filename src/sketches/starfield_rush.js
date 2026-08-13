// Starfield Rush — a warp-speed starfield tunnel.
// This is intentionally Canvas 2D rather than a giant fragment-uniform array:
// 600 stars require more fragment uniform vectors than many Chrome WebGL
// implementations allow. Audio values still arrive through pattern-controls;
// positions remain local visual state and never need to be uploaded as uniforms.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    speed: { min: 0, max: 200, neutral: 2 },
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uHigh: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { hueOffset: 0, speed: 2, uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0 },
  },
});

// Same raw band extraction as the original (warp/hue/sparkle controls only).
export function bands(freqs) {
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

// The controller owns band extraction, hue drift and warp speed. Star positions
// stay renderer-local visual state, so no oversized shader-uniform payload is
// needed to draw the full slider range.
export function createAudioController({ rng = Math.random } = {}) {
  let hueOffset = 0;

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = bands(freqs.left);
      const warp = Math.max(0, Number(params.warp ?? 1));
      const hueDrift = Math.max(0, Number(params.hue ?? 1));

      hueOffset = (hueOffset + (0.2 + b.energy * 2) * hueDrift * dt * 60) % 360;
      return {
        continuous: {
          hueOffset,
          speed: (2 + b.sub * 18) * warp,
          uSub: clamp(b.sub, 0, 1.6),
          uMid: clamp(b.mid, 0, 1.6),
          uHigh: clamp(b.high, 0, 1.6),
          uEnergy: clamp(b.energy, 0, 1.6),
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const audioControls = runtimeContext?.audioControls || null;
  let stars = [];
  let hueOffset = 0;

  function makeStar() {
    return {
      x: p.random(-p.width, p.width),
      y: p.random(-p.height, p.height),
      z: p.random(0, p.width),
      size: p.random(1, 3.5),
    };
  }

  function ensureStars(count) {
    while (stars.length < count) stars.push(makeStar());
    if (stars.length > count) stars.length = count;
  }

  function drawScene(C) {
    const P = params || {};
    const count = Math.floor(P.count ?? 240);
    const sparkle = P.sparkle ?? 1;
    ensureStars(count);

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const cx = p.width / 2;
    const cy = p.height / 2;
    for (const star of stars) {
      star.z -= C.speed;
      if (star.z <= 0) {
        Object.assign(star, makeStar());
        star.z = p.width;
      }

      const scale = p.map(star.z, 0, p.width, 1, 0.02);
      const sx = cx + (star.x - cx) * scale;
      const sy = cy + (star.y - cy) * scale;
      const brightness = p.map(star.z, p.width, 0, 40, 255) + C.uHigh * 120 * sparkle;
      const hue = (C.hueOffset + star.z * 0.2) % 360;

      if (C.speed > 6) {
        const prevScale = p.map(star.z + C.speed, 0, p.width, 1, 0.02);
        const px = cx + (star.x - cx) * prevScale;
        const py = cy + (star.y - cy) * prevScale;
        p.stroke(hue, 90, 100, p.min(255, brightness));
        p.strokeWeight(p.max(0.5, star.size * scale * 2.2));
        p.line(px, py, sx, sy);
      } else {
        p.noStroke();
        p.fill(hue, 90, 100, p.min(255, brightness));
        p.circle(sx, sy, p.max(0.6, star.size * scale * 2));
      }
    }

    if (C.uHigh > 0.45 && sparkle > 0.05) {
      p.noStroke();
      p.fill(C.hueOffset, 80, 100, (C.uHigh - 0.45) * 180);
      p.circle(cx, cy, 420 * (C.uHigh - 0.45) * sparkle);
    }
  }

  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.hueOffset;
    drawScene(C);
  }

  // Preserved raw-frame behavior for standalone callers.
  function drawLegacy() {
    const P = params || {};
    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);
    const warp = P.warp ?? 1;
    const hueDrift = P.hue ?? 1;
    hueOffset = (hueOffset + (0.2 + b.energy * 2) * hueDrift) % 360;

    drawScene({
      hueOffset,
      speed: (2 + b.sub * 18) * warp,
      uSub: b.sub,
      uMid: b.mid,
      uHigh: b.high,
      uEnergy: b.energy,
    });
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    ensureStars(Math.floor(params?.count ?? 240));
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
