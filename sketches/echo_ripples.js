// Echo Ripples — concentric water-like rings radiating from the center.
// A bass kick spawns a fresh ripple; sub thickens the rings, mid energy
// shifts the color, and loud highs sprinkle bright sparkles on the rings.
// The opted-in path consumes sub/high/energy scalars plus one-shot ripple and
// sparkle events from a DOM-free capture-side controller; the legacy raw-frame
// path is preserved for all other callers.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    sub: { min: 0, max: 1.6, neutral: 0 },
    high: { min: 0, max: 1.6, neutral: 0 },
    energy: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {},
  events: {
    'ripple': { fields: { energy: { min: 0, max: 1.6, required: true } } },
    'sparkle': { fields: { count: { min: 1, max: 16, integer: true, required: true } } },
  },
  neutral: {
    continuous: { sub: 0, high: 0, energy: 0 },
  },
});

export function analyzeRippleBands(freqs) {
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

// The controller owns band extraction, kick detection and the time-based
// sparkle spawn rate. Ripple geometry stays fully visual on the renderer.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let eventCounter = 0;
  let prevSub = 0;
  let sparkleCredit = 0;
  const event = (type, values = {}) => ({ id: `${type}-${++eventCounter}`, type, ...values });

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = analyzeRippleBands(freqs.left);
      const sparkle = Math.max(0, Number(params.sparkle ?? 1));
      const events = [];

      // Spawn a new ripple on a rising bass kick.
      if (b.sub > 0.3 && b.sub > prevSub) {
        events.push(event('ripple', { energy: b.sub }));
      }
      prevSub = b.sub;

      // Loud highs sprinkle sparkles. Legacy probability was per-frame; the
      // equivalent per-second rate keeps spawn density stable at any cadence.
      if (sparkle > 0.05 && b.high > 0.25) {
        sparkleCredit += b.high * 0.35 * sparkle * 60 * dt;
        let count = Math.floor(sparkleCredit);
        sparkleCredit -= count;
        count = Math.min(16, count);
        if (count > 0) events.push(event('sparkle', { count }));
      } else {
        sparkleCredit = 0;
      }

      return {
        continuous: {
          sub: clamp(b.sub, 0, 1.6),
          high: clamp(b.high, 0, 1.6),
          energy: clamp(b.energy, 0, 1.6),
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const ripples = [];
  let prevSub = 0;
  const audioControls = runtimeContext?.audioControls || null;

  function drawRipples(sub, high, hueOffset) {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const speed = P.speed ?? 1;
    const thickness = P.thick ?? 1;
    const sparkle = P.sparkle ?? 1;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.dist(0, 0, cx, cy);

    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += (1.4 + rp.energy * 3.5) * speed;

      // Each ripple draws itself as a trio of echoes
      const echoes = [
        [1.0, 1.0],
        [0.66, 0.55],
        [0.33, 0.28],
      ];
      for (const [mult, aMul] of echoes) {
        const rr = rp.r * mult;
        const t = rr / maxR;
        if (t > 1.02) continue;

        const alpha = 170 * (1 - t) * aMul;
        const ringWidth = p.map(t, 0, 1, 2, 30) * (1 + sub * 1.3) * thickness;
        p.stroke(rp.hue + mult * 45, 90, 100, alpha);
        p.strokeWeight(p.max(1, ringWidth));
        p.noFill();
        p.circle(cx, cy, rr * 2);

        // High-frequency sparkles sprinkled along the leading edge
        if (sparkle > 0.05 && high > 0.25 && p.random() < high * 0.35 * sparkle) {
          const ang = p.random(p.TWO_PI);
          const sx = cx + Math.cos(ang) * rr;
          const sy = cy + Math.sin(ang) * rr;
          p.noStroke();
          p.fill(rp.hue, 70, 100, alpha);
          p.circle(sx, sy, p.random(2, 7));
        }
      }

      if (rp.r > maxR * 1.02) ripples.splice(i, 1);
    }
  }

  function drawCenterGlow(sub, hueOffset) {
    const cx = p.width / 2;
    const cy = p.height / 2;
    // Center glow pulsing with the bass
    p.noStroke();
    p.fill(hueOffset, 80, 100, 40 + sub * 140);
    p.circle(cx, cy, 60 + sub * 260);
  }

  function drawMigrated() {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const P = params || {};
    const maxRipples = Math.floor(P.ripples ?? 20);

    const hueOffset = (p.frameCount * 0.5 + C.energy * 220) % 360;

    const events = audioControls.consumeEvents();
    for (const item of events) {
      if (item.type === 'ripple' && ripples.length < maxRipples) {
        ripples.push({ r: 0, hue: (hueOffset + p.random(90)) % 360, energy: item.energy });
      } else if (item.type === 'sparkle' && ripples.length > 0) {
        for (let n = 0; n < item.count; n++) {
          const rp = ripples[Math.floor(p.random(ripples.length))];
          const mult = [1.0, 0.66, 0.33][Math.floor(p.random(3))];
          const rr = rp.r * mult;
          const ang = p.random(p.TWO_PI);
          const sx = p.width / 2 + Math.cos(ang) * rr;
          const sy = p.height / 2 + Math.sin(ang) * rr;
          p.noStroke();
          p.fill(rp.hue, 70, 100, 120);
          p.circle(sx, sy, p.random(2, 7));
        }
      }
    }

    drawRipples(C.sub, C.high, hueOffset);
    drawCenterGlow(C.sub, hueOffset);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const maxRipples = Math.floor(P.ripples ?? 20);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = analyzeRippleBands(freqs ? freqs.left : null);
    const hueOffset = (p.frameCount * 0.5 + b.energy * 220) % 360;

    // Spawn a new ripple on a rising bass kick
    if (b.sub > 0.3 && b.sub > prevSub && ripples.length < maxRipples) {
      ripples.push({ r: 0, hue: (hueOffset + p.random(90)) % 360, energy: b.sub });
    }
    prevSub = b.sub;

    drawRipples(b.sub, b.high, hueOffset);
    drawCenterGlow(b.sub, hueOffset);
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
