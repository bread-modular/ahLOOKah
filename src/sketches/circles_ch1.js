// Circles CH1 — the classic drifting circle field driven by the LEFT channel
// only, with hat-particle spawns on high energy. The opted-in path consumes
// final scalar controls and one-shot spawn events from a DOM-free capture-side
// controller; the legacy raw-frame path is preserved for all other callers.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mapRange = (value, start1, stop1, start2, stop2) => {
  const amount = (value - start1) / Math.max(1e-9, stop1 - start1);
  return start2 + (stop2 - start2) * amount;
};

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    pump: { min: 1, max: 10, neutral: 1 },
    midBrightness: { min: 0, max: 255, neutral: 0 },
    strokeWeight: { min: 0, max: 64, neutral: 1 },
    movementMultiplier: { min: 0, max: 64, neutral: 1 },
  },
  arrays: {},
  events: {
    'hat-spawn': { fields: { count: { min: 1, max: 16, integer: true, required: true } } },
  },
  neutral: {
    continuous: {
      pump: 1,
      midBrightness: 0,
      strokeWeight: 1,
      movementMultiplier: 1,
    },
  },
});

export function analyzeBands(freqs) {
  if (!freqs?.length) return { sub: 0, low: 0, mid: 0, high: 0 };
  let sub = 0; let low = 0; let mid = 0; let high = 0;
  for (let i = 0; i < 3; i++) sub += freqs[i] || 0;
  for (let i = 3; i < 15; i++) low += freqs[i] || 0;
  for (let i = 15; i < 100; i++) mid += freqs[i] || 0;
  for (let i = 100; i < 500; i++) high += freqs[i] || 0;
  return {
    sub: (sub / 3) / 255,
    low: (low / 12) / 255,
    mid: (mid / 85) / 255,
    high: (high / 400) / 255,
  };
}

// The controller owns all audio interpretation (left-channel bands and the
// time-based hat spawn rate). The renderer receives final scalar controls and
// stable one-shot spawn events only.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let eventCounter = 0;
  let hatCredit = 0;
  const event = (type, values = {}) => ({ id: `${type}-${++eventCounter}`, type, ...values });

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      // Ch 1 Only — the whole sketch reacts to the left channel.
      const bands1 = analyzeBands(freqs.left);
      const bass = Math.max(0, Number(params.bass ?? 1));
      const mid = Math.max(0, Number(params.mid ?? 1));
      const high = Math.max(0, Number(params.high ?? 1));
      const scaledHigh = bands1.high * high;
      const events = [];

      // The old renderer emitted a floor-mapped spawn count each 60 Hz frame.
      // Integrating its equivalent rate makes controller cadence irrelevant.
      if (scaledHigh > 0.15) {
        const perFrame = clamp(Math.floor(mapRange(scaledHigh, 0.15, 0.6, 1, 8)), 1, 8);
        hatCredit += perFrame * 60 * dt;
        let count = Math.floor(hatCredit);
        hatCredit -= count;
        if (random() < hatCredit) {
          count += 1;
          hatCredit = 0;
        }
        count = Math.min(16, count);
        if (count > 0) events.push(event('hat-spawn', { count }));
      } else {
        hatCredit = Math.min(hatCredit, 1);
      }

      return {
        continuous: {
          pump: clamp(1 + bands1.sub * 2.5 * bass, 1, 10),
          midBrightness: clamp(mapRange(bands1.mid * mid, 0, 0.5, 0, 180), 0, 255),
          strokeWeight: clamp(mapRange(bands1.sub * bass, 0, 0.5, 1, 12), 0, 64),
          movementMultiplier: clamp(1 + bands1.sub * 12 * bass, 0, 64),
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let circles = [];
  let hats = [];
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    for (let i = 0; i < 20; i++) {
      circles.push(createCircle());
    }
  };

  function createCircle() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      baseSize: p.random(20, 80),
      speedX: p.random(-0.5, 0.5),
      speedY: p.random(-0.5, -2),
      brightness: p.random(150, 255),
    };
  }

  function createHat() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      size: p.random(3, 12),
      speedX: p.random(-1, 1),
      speedY: p.random(-10, -4),
      life: 255
    };
  }

  function drawCircles({ pump, midBrightness, strokeWeight, movementMultiplier }) {
    circles.forEach((circle) => {
      const currentSize = circle.baseSize * pump;
      if (midBrightness > 20) p.fill(255, midBrightness);
      else p.noFill();
      p.strokeWeight(strokeWeight);
      p.stroke(255, p.map(circle.brightness, 150, 255, 180, 255));
      p.circle(circle.x, circle.y, currentSize);

      circle.x += circle.speedX * movementMultiplier;
      circle.y += circle.speedY * movementMultiplier;

      if (circle.y < -currentSize) circle.y = p.height + currentSize;
      if (circle.x < -currentSize) circle.x = p.width + currentSize;
      if (circle.x > p.width + currentSize) circle.x = -currentSize;
      if (circle.y > p.height + currentSize) circle.y = -currentSize;
    });
  }

  // frameScale keeps the hat simulation frame-rate independent in the migrated
  // path; legacy callers omit it and get the original per-frame behavior.
  function drawHats(frameScale = 1) {
    p.noStroke();
    for (let i = hats.length - 1; i >= 0; i--) {
      const hat = hats[i];
      p.fill(255, hat.life);
      p.circle(hat.x, hat.y, hat.size);

      hat.x += hat.speedX * frameScale;
      hat.y += hat.speedY * frameScale;
      hat.life -= 8 * frameScale;

      if (hat.life <= 0 || hat.y < -20) {
        hats.splice(i, 1);
      }
    }
  }

  function drawMigrated() {
    p.background(0);
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const events = audioControls.consumeEvents();
    for (const item of events) {
      if (item.type === 'hat-spawn') {
        for (let i = 0; i < item.count; i++) hats.push(createHat());
      }
    }
    drawCircles(C);
    const frameScale = clamp((p.deltaTime || 16.667) / 16.667, 0.25, 4);
    drawHats(frameScale);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const bass = P.bass ?? 1;
    const mid = P.mid ?? 1;
    const high = P.high ?? 1;

    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const bands1 = analyzeBands(freqs.left);  // Ch 1 Only

    // Spawn tiny circles (hats)
    if (bands1.high * high > 0.15) {
      const spawnCount = Math.floor(p.map(bands1.high * high, 0.15, 0.6, 1, 8));
      for (let i = 0; i < spawnCount; i++) {
        hats.push(createHat());
      }
    }

    drawCircles({
      pump: 1 + bands1.sub * 2.5 * bass,
      midBrightness: p.map(bands1.mid * mid, 0, 0.5, 0, 180),
      strokeWeight: p.map(bands1.sub * bass, 0, 0.5, 1, 12),
      movementMultiplier: 1 + bands1.sub * 12 * bass,
    });
    drawHats();
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
