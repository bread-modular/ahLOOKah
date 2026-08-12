// Techno 3D — rotating wireframe core with digital rain lines and glitch
// artifacts. The legacy raw-frame path stays intact; opted-in renderers
// consume final controls produced by a DOM-free capture-side controller.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mapRange = (value, start1, stop1, start2, stop2) => {
  const amount = (value - start1) / Math.max(1e-9, stop1 - start1);
  return start2 + (stop2 - start2) * amount;
};

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    rotation: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    kickScale: { min: 0, max: 8, neutral: 1 },
    coreAlpha: { min: 0, max: 255, neutral: 200 },
    coreStroke: { min: 0, max: 16, neutral: 1 },
    coreMode: { min: 0, max: 1, neutral: 0 },
    gridAlpha: { min: 0, max: 255, neutral: 50 },
    gridSize: { min: 0, max: 5_000, neutral: 800 },
    lineSpeed: { min: 0, max: 1_000, neutral: 10 },
    lineLength: { min: 0, max: 2_000, neutral: 50 },
    lineStroke: { min: 0, max: 16, neutral: 1 },
  },
  arrays: {},
  events: {
    'glitch-burst': { fields: {} },
  },
  neutral: {
    continuous: {
      rotation: 0,
      kickScale: 1,
      coreAlpha: 200,
      coreStroke: 1,
      coreMode: 0,
      gridAlpha: 50,
      gridSize: 800,
      lineSpeed: 10,
      lineLength: 50,
      lineStroke: 1,
    },
  },
});

export function analyzeBands(freqs) {
  if (!freqs) return { sub: 0, low: 0, mid: 0, high: 0 };
  let sub = 0, low = 0, mid = 0, high = 0;
  for (let i = 0; i < 3; i++) sub += freqs[i];
  for (let i = 3; i < 40; i++) low += freqs[i];
  for (let i = 40; i < 150; i++) mid += freqs[i];
  for (let i = 150; i < 500; i++) high += freqs[i];

  return {
    sub: (sub / 3) / 255,
    low: (low / 37) / 255,
    mid: (mid / 110) / 255,
    high: (high / 350) / 255
  };
}

// The controller owns all audio interpretation, the time-based rotation state
// and the glitch trigger. The 60 factor calibrates the old per-frame increments
// to elapsed seconds so controller cadence can vary without changing visual speed.
export function createAudioController({ rng = Math.random } = {}) {
  let rotation = 0;
  let eventCounter = 0;

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null, right: null };
      const b1 = analyzeBands(freqs.left && freqs.left.length ? freqs.left : null);
      const b2 = analyzeBands(freqs.right && freqs.right.length ? freqs.right : null);
      const spin = Math.max(0, Number(params.spin ?? 1));
      const bass = Math.max(0, Number(params.bass ?? 1));
      const mid = Math.max(0, Number(params.mid ?? 1));
      const high = Math.max(0, Number(params.high ?? 1));
      const noiseEnv = (b2.mid + b2.high) * 0.5;
      const events = [];

      rotation += (0.005 + noiseEnv * 0.2) * spin * dt * 60;
      if (Math.abs(rotation) > 900_000) rotation %= 100_000;

      // The old renderer drew three random glitch lines every frame while the
      // Ch-2 noise envelope was hot. Emitting one bounded one-shot per tick
      // keeps the effect without replaying stale events across render frames.
      if (noiseEnv > 0.25) {
        events.push({ id: `glitch-burst-${++eventCounter}`, type: 'glitch-burst' });
      }

      return {
        continuous: {
          rotation,
          kickScale: 1 + b1.sub * 1.5 * bass,
          coreAlpha: clamp(200 + b1.sub * 55, 0, 255),
          coreStroke: 1 + b1.sub * 5,
          coreMode: b1.mid * mid > 0.5 ? 1 : 0,
          gridAlpha: clamp(50 + b1.mid * 200 * mid, 0, 255),
          gridSize: 800 * (1 + b1.sub * 0.2),
          lineSpeed: 10 + b1.sub * 100 * bass + noiseEnv * 50,
          lineLength: 50 + b1.high * 500 * high,
          lineStroke: mapRange(b1.high * high, 0, 0.5, 1, 3),
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let rotation = 0;
  let lines = [];
  const numLines = 40;
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    for (let i = 0; i < numLines; i++) {
      lines.push({
        z: p.map(i, 0, numLines, -2000, 500),
        x: p.random(-500, 500),
        y: p.random(-500, 500)
      });
    }
  };

  // Opted-in renderer: consumes final controls only; no local audio analysis.
  function drawMigrated() {
    p.background(0);
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const events = audioControls.consumeEvents();
    let glitchBursts = 0;
    for (const item of events) {
      if (item.type === 'glitch-burst') glitchBursts += 1;
    }

    p.rotateX(C.rotation * 0.5);
    p.rotateY(C.rotation);

    // 1. Central Core Geometry (Kick/Bass)
    p.push();
    p.noFill();
    p.stroke(255, C.coreAlpha);
    p.strokeWeight(C.coreStroke);
    if (C.coreMode > 0.5) {
      p.box(200 * C.kickScale);
    } else {
      p.sphere(150 * C.kickScale, 12, 12);
    }
    p.pop();

    // 2. Wireframe Grid "Slices" (Mid frequencies)
    p.push();
    p.noFill();
    p.stroke(255, C.gridAlpha);
    p.strokeWeight(1);

    const gridRes = 8;

    for (let i = 0; i < 3; i++) {
      p.push();
      p.rotateZ(p.frameCount * 0.01 * (i + 1));
      p.plane(C.gridSize, C.gridSize, gridRes, gridRes);
      p.pop();
    }
    p.pop();

    // 3. Digital "Rain" / Perspective lines (High frequencies)
    p.push();
    p.stroke(255, 150);
    p.strokeWeight(C.lineStroke);

    lines.forEach(line => {
      line.z += C.lineSpeed;
      if (line.z > 500) line.z = -2000;

      p.push();
      p.translate(line.x, line.y, line.z);
      p.line(0, 0, 0, 0, 0, C.lineLength);
      p.pop();
    });
    p.pop();

    // 4. Glitch artifacts from Channel 2
    for (let g = 0; g < glitchBursts; g++) {
      p.push();
      p.stroke(255);
      p.strokeWeight(1);
      for (let i = 0; i < 3; i++) {
        p.rotateZ(p.random(p.TWO_PI));
        p.line(-1000, p.random(-500, 500), 1000, p.random(-500, 500));
      }
      p.pop();
    }
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const spin = P.spin ?? 1;
    const bass = P.bass ?? 1;
    const mid = P.mid ?? 1;
    const high = P.high ?? 1;

    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const b1 = analyzeBands(freqs.left);  // Ch 1
    const b2 = analyzeBands(freqs.right); // Ch 2

    // Ch 2 Noise drives rotation speed and jitter
    const noiseEnv = (b2.mid + b2.high) * 0.5;
    rotation += (0.005 + noiseEnv * 0.2) * spin;

    p.rotateX(rotation * 0.5);
    p.rotateY(rotation);

    // Sub-bass Kick pulse
    const kickScale = 1 + b1.sub * 1.5 * bass;

    // 1. Central Core Geometry (Kick/Bass)
    p.push();
    p.noFill();
    p.stroke(255, 200 + b1.sub * 55);
    p.strokeWeight(1 + b1.sub * 5);

    // Core shape changes as synth energy (Mid) increases
    if (b1.mid * mid > 0.5) {
      p.box(200 * kickScale);
    } else {
      p.sphere(150 * kickScale, 12, 12);
    }
    p.pop();

    // 2. Wireframe Grid "Slices" (Mid frequencies)
    p.push();
    p.noFill();
    p.stroke(255, 50 + b1.mid * 200 * mid);
    p.strokeWeight(1);

    const gridRes = 8;
    const gridSize = 800 * (1 + b1.sub * 0.2);

    for (let i = 0; i < 3; i++) {
      p.push();
      p.rotateZ(p.frameCount * 0.01 * (i + 1));
      p.plane(gridSize, gridSize, gridRes, gridRes);
      p.pop();
    }
    p.pop();

    // 3. Digital "Rain" / Perspective lines (High frequencies)
    p.push();
    p.stroke(255, 150);
    p.strokeWeight(p.map(b1.high * high, 0, 0.5, 1, 3));

    lines.forEach(line => {
      // Move towards camera
      line.z += 10 + b1.sub * 100 * bass + noiseEnv * 50;
      if (line.z > 500) line.z = -2000;

      p.push();
      p.translate(line.x, line.y, line.z);
      // High end energy makes lines longer
      const l = 50 + b1.high * 500 * high;
      p.line(0, 0, 0, 0, 0, l);
      p.pop();
    });
    p.pop();

    // 4. Glitch artifacts from Channel 2
    if (noiseEnv > 0.25) {
      p.push();
      p.stroke(255);
      p.strokeWeight(1);
      for (let i = 0; i < 3; i++) {
        p.rotateZ(p.random(p.TWO_PI));
        p.line(-1000, p.random(-500, 500), 1000, p.random(-500, 500));
      }
      p.pop();
    }
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
