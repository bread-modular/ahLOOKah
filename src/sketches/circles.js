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
    glitchAmount: { min: 0, max: 256, neutral: 0 },
    noiseIntensity: { min: 0, max: 2, neutral: 0 },
    scanlineAlpha: { min: 0, max: 255, neutral: 0 },
  },
  arrays: {},
  events: {
    'hat-spawn': { fields: { count: { min: 1, max: 16, integer: true, required: true } } },
    'invert-flash': { fields: {} },
    'background-spark': { fields: {} },
    'screen-slice': { fields: {} },
  },
  neutral: {
    continuous: {
      pump: 1,
      midBrightness: 0,
      strokeWeight: 1,
      movementMultiplier: 1,
      glitchAmount: 0,
      noiseIntensity: 0,
      scanlineAlpha: 0,
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

// The controller keeps all audio interpretation and time-based event rates on
// the capture owner. The renderer receives final scalar controls and stable
// one-shot event IDs only.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let eventCounter = 0;
  let hatCredit = 0;
  const event = (type, values = {}) => ({ id: `${type}-${++eventCounter}`, type, ...values });
  const chanceForRate = (ratePerSecond, dt) => random() < 1 - Math.exp(-Math.max(0, ratePerSecond) * dt);

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null, right: null };
      const bands1 = analyzeBands(freqs.left);
      const bands2 = analyzeBands(freqs.right);
      const bass = Math.max(0, Number(params.bass ?? 1));
      const mid = Math.max(0, Number(params.mid ?? 1));
      const high = Math.max(0, Number(params.high ?? 1));
      const glitch = Math.max(0, Number(params.glitch ?? 1));
      const noiseIntensity = clamp((bands2.mid + bands2.high) * 0.5, 0, 2);
      const glitchAmount = clamp(mapRange(noiseIntensity, 0, 0.5, 0, 60) * glitch, 0, 256);
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

      if (glitchAmount > 5) {
        if (chanceForRate(noiseIntensity * 0.15 * 60, dt)) events.push(event('invert-flash'));
        if (chanceForRate(noiseIntensity * 0.2 * 60, dt)) events.push(event('background-spark'));
      }
      if (noiseIntensity > 0.3 && chanceForRate(30, dt)) events.push(event('screen-slice'));

      return {
        continuous: {
          pump: clamp(1 + bands1.sub * 2.5 * bass, 1, 10),
          midBrightness: clamp(mapRange(bands1.mid * mid, 0, 0.5, 0, 180), 0, 255),
          strokeWeight: clamp(mapRange(bands1.sub * bass, 0, 0.5, 1, 12), 0, 64),
          movementMultiplier: clamp(1 + bands1.sub * 12 * bass, 0, 64),
          glitchAmount,
          noiseIntensity,
          scanlineAlpha: noiseIntensity > 0.15 ? clamp(mapRange(noiseIntensity, 0.15, 0.5, 20, 100), 0, 255) : 0,
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
    for (let i = 0; i < 20; i++) circles.push(createCircle());
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
      life: 255,
    };
  }

  function drawCircles({ pump, midBrightness, strokeWeight, movementMultiplier, glitchAmount }) {
    circles.forEach((circle) => {
      const currentSize = circle.baseSize * pump;
      if (midBrightness > 20) p.fill(255, midBrightness);
      else p.noFill();
      p.strokeWeight(strokeWeight);
      const jx = p.random(-glitchAmount / 2, glitchAmount / 2);
      const jy = p.random(-glitchAmount / 2, glitchAmount / 2);
      p.stroke(255, p.map(circle.brightness, 150, 255, 180, 255));
      p.circle(circle.x + jx, circle.y + jy, currentSize);

      circle.x += circle.speedX * movementMultiplier;
      circle.y += circle.speedY * movementMultiplier;
      if (circle.y < -currentSize) circle.y = p.height + currentSize;
      if (circle.x < -currentSize) circle.x = p.width + currentSize;
      if (circle.x > p.width + currentSize) circle.x = -currentSize;
      if (circle.y > p.height + currentSize) circle.y = -currentSize;
    });
  }

  function drawHats(glitchAmount, frameScale = 1) {
    p.noStroke();
    for (let i = hats.length - 1; i >= 0; i--) {
      const hat = hats[i];
      p.fill(255, hat.life);
      p.circle(
        hat.x + p.random(-glitchAmount, glitchAmount),
        hat.y + p.random(-glitchAmount, glitchAmount),
        hat.size,
      );
      hat.x += hat.speedX * frameScale;
      hat.y += hat.speedY * frameScale;
      hat.life -= 8 * frameScale;
      if (hat.life <= 0 || hat.y < -20) hats.splice(i, 1);
    }
  }

  function drawMigrated() {
    p.background(0);
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const events = audioControls.consumeEvents();
    let invert = false;
    let spark = false;
    let slices = 0;
    for (const item of events) {
      if (item.type === 'hat-spawn') {
        for (let i = 0; i < item.count; i++) hats.push(createHat());
      } else if (item.type === 'invert-flash') invert = true;
      else if (item.type === 'background-spark') spark = true;
      else if (item.type === 'screen-slice') slices += 1;
    }

    p.push();
    if (C.glitchAmount > 5) p.translate(p.random(-C.glitchAmount, C.glitchAmount), p.random(-C.glitchAmount, C.glitchAmount));
    if (invert) p.filter(p.INVERT);
    if (spark) p.background(p.random(50, 100));
    drawCircles(C);
    const frameScale = clamp((p.deltaTime || 16.667) / 16.667, 0.25, 4);
    drawHats(C.glitchAmount, frameScale);
    p.pop();

    if (C.scanlineAlpha > 0) {
      p.stroke(255, C.scanlineAlpha);
      p.strokeWeight(1);
      for (let i = 0; i < 5; i++) {
        const lineY = p.random(p.height);
        p.line(0, lineY, p.width, lineY);
      }
    }
    for (let i = 0; i < slices; i++) {
      const sy = p.random(p.height);
      const sh = p.random(10, 50);
      const sx = p.random(-C.glitchAmount * 2, C.glitchAmount * 2);
      p.copy(0, sy, p.width, sh, sx, sy, p.width, sh);
    }
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.background(0);
    const P = params || {};
    const bass = P.bass ?? 1;
    const mid = P.mid ?? 1;
    const high = P.high ?? 1;
    const glitch = P.glitch ?? 1;
    if (!audio || !audio.isStarted) return;
    const freqs = audio.getFrequencies();
    if (!freqs) return;
    const bands1 = analyzeBands(freqs.left);
    const bands2 = analyzeBands(freqs.right);
    const noiseIntensity = (bands2.mid + bands2.high) * 0.5;
    const glitchAmount = p.map(noiseIntensity, 0, 0.5, 0, 60) * glitch;

    p.push();
    if (glitchAmount > 5) {
      p.translate(p.random(-glitchAmount, glitchAmount), p.random(-glitchAmount, glitchAmount));
      if (p.random() < noiseIntensity * 0.15) p.filter(p.INVERT);
      if (p.random() < noiseIntensity * 0.2) p.background(p.random(50, 100));
    }
    if (bands1.high * high > 0.15) {
      const spawnCount = Math.floor(p.map(bands1.high * high, 0.15, 0.6, 1, 8));
      for (let i = 0; i < spawnCount; i++) hats.push(createHat());
    }
    drawCircles({
      pump: 1 + bands1.sub * 2.5 * bass,
      midBrightness: p.map(bands1.mid * mid, 0, 0.5, 0, 180),
      strokeWeight: p.map(bands1.sub * bass, 0, 0.5, 1, 12),
      movementMultiplier: 1 + bands1.sub * 12 * bass,
      glitchAmount,
    });
    drawHats(glitchAmount);
    p.pop();

    if (noiseIntensity > 0.15) {
      p.stroke(255, p.map(noiseIntensity, 0.15, 0.5, 20, 100));
      p.strokeWeight(1);
      for (let i = 0; i < 5; i++) {
        const lineY = p.random(p.height);
        p.line(0, lineY, p.width, lineY);
      }
      if (noiseIntensity > 0.3 && p.frameCount % 2 === 0) {
        const sy = p.random(p.height);
        const sh = p.random(10, 50);
        const sx = p.random(-glitchAmount * 2, glitchAmount * 2);
        p.copy(0, sy, p.width, sh, sx, sy, p.width, sh);
      }
    }
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
  p.mousePressed = () => { if (audio) audio.resume(); };
};
