// Pulse Rings — neon concentric rings that erupt on every bass kick.
// Rings expand with the audio envelope, each with its own hue; a glowing
// core pulses with sub-bass. Trails fade via translucent black fills.
// The opted-in path consumes a sub scalar, a hue offset and one-shot kick
// events from a DOM-free capture-side controller; the legacy raw-frame path
// is preserved for all other callers.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    sub: { min: 0, max: 1, neutral: 0 },
    hueOffset: { min: 0, max: 360, neutral: 0 },
  },
  arrays: {},
  events: {
    'kick': { fields: {} },
  },
  neutral: {
    continuous: { sub: 0, hueOffset: 0 },
  },
});

export function subBand(freqs) {
  if (!freqs?.length) return 0;
  let sub = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  return sub / (4 * 255);
}

// The controller owns sub extraction, kick detection (rising edge with a
// cooldown) and hue drift. Ring geometry stays fully visual on the renderer.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let eventCounter = 0;
  let hueOffset = 0;
  let lastKick = -10;
  let prevSub = 0;
  let elapsed = 0;
  const event = (type) => ({ id: `${type}-${++eventCounter}`, type });

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      elapsed += dt;
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const sub = subBand(freqs.left);

      // Rising edge on the sub-bass with a cooldown = kick detection. The
      // legacy 90 ms millis-based cooldown becomes a seconds-based window.
      const threshold = params?.kick ?? 0.35;
      const events = [];
      if (sub > threshold && sub > prevSub && elapsed - lastKick > 0.09) {
        lastKick = elapsed;
        events.push(event('kick'));
      }
      prevSub = sub;

      hueOffset = (hueOffset + (0.4 + sub * 2) * dt * 60) % 360;

      return {
        continuous: {
          sub: clamp(sub, 0, 1),
          hueOffset,
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const rings = [];
  let hueOffset = 0;
  let lastKick = 0;
  let prevSub = 0;
  const audioControls = runtimeContext?.audioControls || null;

  function kickDetected(sub, now) {
    // Rising edge on the sub-bass with a cooldown = kick detection
    // (threshold read live so the Kick Threshold slider applies immediately)
    const threshold = params?.kick ?? 0.35;
    if (sub > threshold && sub > prevSub && now - lastKick > 90) {
      lastKick = now;
      return true;
    }
    return false;
  }

  function spawnRing(ringSpeed) {
    rings.push({
      r: 10,
      speed: (6 + p.random(0, 6)) * ringSpeed,
      hue: (hueOffset + p.random(-30, 30) + 360) % 360,
      life: 1,
    });
    const MAX_RINGS = params?.rings ?? 40;
    if (rings.length > MAX_RINGS) rings.shift();
  }

  function drawScene(sub) {
    const P = params || {};
    const subPulse = P.sub ?? 1;

    // Core pulse
    const coreR = p.map(sub * subPulse, 0, 1, 60, 260) + 40 * p.sin(p.frameCount * 0.15);
    p.noStroke();
    p.fill(hueOffset, 90, 100, 90);
    p.circle(p.width / 2, p.height / 2, coreR * 2);
    p.fill((hueOffset + 40) % 360, 90, 100, 140);
    p.circle(p.width / 2, p.height / 2, coreR * 0.6);

    // Expanding rings
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.r += ring.speed * (0.6 + sub * 2 * subPulse);
      ring.life -= 0.008;

      if (ring.life <= 0) {
        rings.splice(i, 1);
        continue;
      }

      p.noFill();
      p.strokeWeight(2 + ring.life * 6);
      p.stroke(ring.hue, 85, 100, ring.life * 220);
      p.circle(p.width / 2, p.height / 2, ring.r * 2);

      // Secondary echo ring
      p.strokeWeight(1);
      p.stroke(ring.hue, 70, 100, ring.life * 90);
      p.circle(p.width / 2, p.height / 2, ring.r * 1.3 * 2);
    }
  }

  function drawMigrated() {
    // Trail fade (BLEND mode so black actually dims the additive glow)
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 26);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.hueOffset;

    const events = audioControls.consumeEvents();
    const ringSpeed = params?.speed ?? 1;
    for (const item of events) {
      if (item.type === 'kick') spawnRing(ringSpeed);
    }

    drawScene(C.sub);

    // Idle shimmer when there is no live control stream yet.
    if (!controls.isFresh) {
      rings.push({
        r: 10,
        speed: 2.5,
        hue: (hueOffset + p.random(-40, 40) + 360) % 360,
        life: 0.6,
      });
      const MAX_RINGS = params?.rings ?? 40;
      if (rings.length > MAX_RINGS) rings.shift();
    }
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    // Trail fade (BLEND mode so black actually dims the additive glow)
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 26);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const ringSpeed = P.speed ?? 1;
    const MAX_RINGS = P.rings ?? 40;

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const sub = subBand(freqs ? freqs.left : null);
    const now = p.millis();

    if (kickDetected(sub, now)) {
      spawnRing(ringSpeed);
    }
    prevSub = sub;

    hueOffset = (hueOffset + 0.4 + sub * 2) % 360;
    drawScene(sub);

    // Idle shimmer when there is no signal yet
    if (!audio || !audio.isStarted) {
      rings.push({
        r: 10,
        speed: 2.5,
        hue: (hueOffset + p.random(-40, 40) + 360) % 360,
        life: 0.6,
      });
      if (rings.length > MAX_RINGS) rings.shift();
    }
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
