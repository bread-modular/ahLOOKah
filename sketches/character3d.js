// Character 3D — a dancing wireframe character with digital rain background.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls produced by a DOM-free capture-side controller.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    groove: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    camYaw: { min: 0, max: 1, neutral: 0 },
    bgAlpha: { min: 0, max: 255, neutral: 60 },
    bgWeight: { min: 0, max: 8, neutral: 0.5 },
    bgActive: { min: 0, max: 4, neutral: 0 },
    bgSpeed: { min: 0, max: 1_000, neutral: 0 },
    bgLength: { min: 0, max: 2_000, neutral: 40 },
    starSpeed: { min: 0, max: 50, neutral: 1 },
    charStroke: { min: 0, max: 8, neutral: 0.545 },
    bounce: { min: 0, max: 200, neutral: 0 },
    eyeGlow: { min: 0, max: 1, neutral: 0 },
    armBend: { min: 0, max: 4, neutral: 0 },
    armSway: { min: 0, max: 2, neutral: 0 },
    subNod: { min: 0, max: 1, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      groove: 0,
      camYaw: 0,
      bgAlpha: 60,
      bgWeight: 0.5,
      bgActive: 0,
      bgSpeed: 0,
      bgLength: 40,
      starSpeed: 1,
      charStroke: 0.545,
      bounce: 0,
      eyeGlow: 0,
      armBend: 0,
      armSway: 0,
      subNod: 0,
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

// The controller owns all audio interpretation and the time-based groove state.
// The 60 factor calibrates the old per-frame increments to elapsed seconds.
export function createAudioController({ rng = Math.random } = {}) {
  let groove = 0;

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null, right: null };
      const b = analyzeBands(freqs.left && freqs.left.length ? freqs.left : null);
      const b2 = analyzeBands(freqs.right && freqs.right.length ? freqs.right : null);
      const grooveSpeed = Math.max(0, Number(params.groove ?? 1));
      const bass = Math.max(0, Number(params.bass ?? 1));
      const mid = Math.max(0, Number(params.mid ?? 1));
      const high = Math.max(0, Number(params.high ?? 1));
      const noiseLevel = (b2.mid + b2.high) * 0.5;

      groove += (0.1 + b.mid * 0.2) * grooveSpeed * dt * 60;
      if (Math.abs(groove) > 900_000) groove %= 100_000;

      return {
        continuous: {
          groove,
          camYaw: noiseLevel * 0.2,
          bgAlpha: clamp(60 + b.high * 100 * high, 0, 255),
          bgWeight: 0.5 + b.high * 2 * high,
          bgActive: b.mid + b.sub,
          bgSpeed: b.sub * 150 * bass + noiseLevel * 80,
          bgLength: 40 + b.high * 600 * high,
          starSpeed: 1 + b.sub * 10,
          charStroke: (1.2 + b.sub * 2.0 * bass) / 2.2,
          bounce: b.sub * 30 * bass,
          eyeGlow: (b.mid * mid > 0.45 || b.high * high > 0.45) ? 1 : 0,
          armBend: b.mid * (Math.PI / 2) * mid,
          armSway: b.mid * 0.5 * mid,
          subNod: b.sub * 0.2,
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let rotation = 0;
  let groove = 0;
  let bgLines = [];
  let stars = [];
  const numBgLines = 150;
  const numStars = 100;
  const audioControls = runtimeContext?.audioControls || null;

  // Anatomy constants
  const TORSO_W = 60, TORSO_H = 80, TORSO_D = 30;
  const HEAD_SIZE = 25;
  const NECK_H = 15;
  const LIMB_W = 10;
  const THIGH_L = 65;
  const SHIN_L = 60;
  const FOOT_H = 10;
  const ARM_L = 50;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

    // Initialize background digital rain
    for (let i = 0; i < numBgLines; i++) {
      bgLines.push({
        x: p.random(-1000, 1000),
        y: p.random(-800, 800),
        z: p.random(-3000, 500),
        speed: p.random(2, 12)
      });
    }

    // Initialize floating "dust" particles
    for (let i = 0; i < numStars; i++) {
      stars.push({
        x: p.random(-800, 800),
        y: p.random(-800, 800),
        z: p.random(-1500, 0),
        size: p.random(1, 3)
      });
    }
  };

  function drawBox(w, h, d) {
    p.push();
    p.translate(0, h / 2, 0);
    p.box(w, h, d);
    p.pop();
  }

  // Opted-in renderer: consumes final controls only; no local audio analysis.
  function drawMigrated() {
    p.background(0);
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const grooveValue = C.groove;

    // Camera Context - Centered on screen with tilt
    p.push();
    p.translate(0, 0, -200);
    p.rotateX(-0.15); // Maintain look-down tilt
    p.rotateY(p.sin(p.frameCount * 0.015) * 0.4 + C.camYaw);

    // Lighting
    p.ambientLight(20);
    p.pointLight(255, 255, 255, 0, -300, 300);

    // 1. DYNAMIC BACKGROUND
    p.push();
    p.stroke(255, C.bgAlpha);
    p.strokeWeight(C.bgWeight);
    bgLines.forEach((line, i) => {
      const activeNum = p.map(C.bgActive, 0, 1, numBgLines * 0.3, numBgLines);
      if (i < activeNum) {
        line.z += line.speed + C.bgSpeed;
        if (line.z > 500) line.z = -3000;
        p.push();
        p.translate(line.x, line.y, line.z);
        p.line(0, 0, 0, 0, 0, C.bgLength);
        p.pop();
      }
    });
    p.pop();

    p.push();
    p.noStroke();
    p.fill(255, 120);
    stars.forEach(s => {
      s.z += C.starSpeed;
      if (s.z > 500) s.z = -1500;
      p.push();
      p.translate(s.x, s.y, s.z);
      p.sphere(s.size, 4, 4);
      p.pop();
    });
    p.pop();

    // 2. CHARACTER HIERARCHY
    p.push();
    p.scale(2.2);
    p.noFill();
    p.stroke(255);
    p.strokeWeight(C.charStroke);

    const bounce = C.bounce;
    p.translate(0, bounce, 0);
    p.box(50, 20, 30); // Pelvis

    p.push();
    p.translate(0, -10, 0);
    p.rotateX(p.sin(grooveValue) * 0.15);
    p.rotateZ(p.cos(grooveValue * 0.5) * 0.05);

    p.push();
    p.translate(0, -TORSO_H, 0);
    drawBox(TORSO_W, TORSO_H, TORSO_D);

    // Neck & Pyramid Head
    p.push();
    p.translate(0, -NECK_H / 2, 0);
    p.box(10, NECK_H, 10);

    p.translate(0, -NECK_H / 2 - HEAD_SIZE, 0);
    p.rotateX(p.sin(grooveValue * 2) * 0.2 + C.subNod);

    p.push();
    p.rotateX(p.PI); // Tip up
    p.cone(HEAD_SIZE * 1.4, HEAD_SIZE * 2.2, 4);
    p.pop();

    // Eye Slit
    p.push();
    p.translate(0, 0, HEAD_SIZE * 0.5);
    if (C.eyeGlow > 0.5) {
      p.fill(255);
    }
    p.box(HEAD_SIZE * 1.0, 5, 8);
    p.pop();

    p.pop();
    p.pop();

    // Arms
    const upperArmRotation = p.PI / 8 + p.sin(grooveValue * 0.8) * 0.2;
    const forearmRotation = p.PI / 3 + C.armBend;

    p.push();
    p.translate(-TORSO_W / 2 - 2, -TORSO_H + 10, 0);
    p.rotateZ(upperArmRotation + C.armSway);
    p.rotateX(p.sin(grooveValue * 0.5) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2);
    p.translate(0, ARM_L, 0);
    p.rotateX(-forearmRotation);
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3);
    p.translate(0, ARM_L, 0);
    p.box(12, 12, 12);
    p.pop();

    p.push();
    p.translate(TORSO_W / 2 + 2, -TORSO_H + 10, 0);
    p.rotateZ(-upperArmRotation - C.armSway);
    p.rotateX(p.sin(grooveValue * 0.5 + p.PI) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2);
    p.translate(0, ARM_L, 0);
    p.rotateX(-forearmRotation);
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3);
    p.translate(0, ARM_L, 0);
    p.box(12, 12, 12);
    p.pop();

    p.pop(); // torso chain

    // Legs
    p.push();
    p.translate(-15, 10, 0);
    const lStep = p.sin(grooveValue) * 0.4;
    p.rotateX(lStep + C.subNod);
    drawBox(LIMB_W, THIGH_L, LIMB_W);
    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -lStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);
    p.translate(0, SHIN_L, 5); // Shift feet slightly forward (Z+)
    p.box(15, FOOT_H, 30);
    p.pop();

    p.push();
    p.translate(15, 10, 0);
    const rStep = p.sin(grooveValue + p.PI) * 0.4;
    p.rotateX(rStep + C.subNod);
    drawBox(LIMB_W, THIGH_L, LIMB_W);
    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -rStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);
    p.translate(0, SHIN_L, 5); // Shift feet slightly forward (Z+)
    p.box(15, FOOT_H, 30);
    p.pop();

    p.pop(); // hierarchy
    p.pop(); // context
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const grooveSpeed = P.groove ?? 1;
    const bass = P.bass ?? 1;
    const mid = P.mid ?? 1;
    const high = P.high ?? 1;

    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const b = analyzeBands(freqs.left);  // Ch 1
    const b2 = analyzeBands(freqs.right); // Ch 2
    const noiseLevel = (b2.mid + b2.high) * 0.5;

    // Animation Timings
    groove += (0.1 + b.mid * 0.2) * grooveSpeed;
    rotation += 0.005 + noiseLevel * 0.1;

    // Camera Context - Centered on screen with tilt
    p.push();
    p.translate(0, 0, -200);
    p.rotateX(-0.15); // Maintain look-down tilt
    p.rotateY(p.sin(p.frameCount * 0.015) * 0.4 + noiseLevel * 0.2);

    // Lighting
    p.ambientLight(20);
    p.pointLight(255, 255, 255, 0, -300, 300);

    // 1. DYNAMIC BACKGROUND
    p.push();
    p.stroke(255, 60 + b.high * 100 * high);
    p.strokeWeight(0.5 + b.high * 2 * high);
    bgLines.forEach((line, i) => {
      const activeNum = p.map(b.mid + b.sub, 0, 1, numBgLines * 0.3, numBgLines);
      if (i < activeNum) {
        line.z += line.speed + b.sub * 150 * bass + noiseLevel * 80;
        if (line.z > 500) line.z = -3000;
        p.push();
        p.translate(line.x, line.y, line.z);
        const l = 40 + b.high * 600 * high;
        p.line(0, 0, 0, 0, 0, l);
        p.pop();
      }
    });
    p.pop();

    p.push();
    p.noStroke();
    p.fill(255, 120);
    stars.forEach(s => {
      s.z += 1 + b.sub * 10;
      if (s.z > 500) s.z = -1500;
      p.push();
      p.translate(s.x, s.y, s.z);
      p.sphere(s.size, 4, 4);
      p.pop();
    });
    p.pop();

    // 2. CHARACTER HIERARCHY
    p.push();
    p.scale(2.2);
    p.noFill();
    p.stroke(255);
    p.strokeWeight((1.2 + b.sub * 2.0 * bass) / 2.2);

    const bounce = b.sub * 30 * bass;
    p.translate(0, bounce, 0);
    p.box(50, 20, 30); // Pelvis

    p.push();
    p.translate(0, -10, 0);
    p.rotateX(p.sin(groove) * 0.15);
    p.rotateZ(p.cos(groove * 0.5) * 0.05);

    p.push();
    p.translate(0, -TORSO_H, 0);
    drawBox(TORSO_W, TORSO_H, TORSO_D);

    // Neck & Pyramid Head
    p.push();
    p.translate(0, -NECK_H / 2, 0);
    p.box(10, NECK_H, 10);

    p.translate(0, -NECK_H / 2 - HEAD_SIZE, 0);
    p.rotateX(p.sin(groove * 2) * 0.2 + b.sub * 0.2);

    p.push();
    p.rotateX(p.PI); // Tip up
    p.cone(HEAD_SIZE * 1.4, HEAD_SIZE * 2.2, 4);
    p.pop();

    // Eye Slit
    p.push();
    p.translate(0, 0, HEAD_SIZE * 0.5);
    if (b.mid * mid > 0.45 || b.high * high > 0.45) {
      p.fill(255);
    }
    p.box(HEAD_SIZE * 1.0, 5, 8);
    p.pop();

    p.pop();
    p.pop();

    // Arms
    const upperArmRotation = p.PI / 8 + p.sin(groove * 0.8) * 0.2;
    const forearmRotation = p.PI / 3 + b.mid * (p.PI / 2) * mid;

    p.push();
    p.translate(-TORSO_W / 2 - 2, -TORSO_H + 10, 0);
    p.rotateZ(upperArmRotation + b.mid * 0.5 * mid);
    p.rotateX(p.sin(groove * 0.5) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2);
    p.translate(0, ARM_L, 0);
    p.rotateX(-forearmRotation);
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3);
    p.translate(0, ARM_L, 0);
    p.box(12, 12, 12);
    p.pop();

    p.push();
    p.translate(TORSO_W / 2 + 2, -TORSO_H + 10, 0);
    p.rotateZ(-upperArmRotation - b.mid * 0.5 * mid);
    p.rotateX(p.sin(groove * 0.5 + p.PI) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2);
    p.translate(0, ARM_L, 0);
    p.rotateX(-forearmRotation);
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3);
    p.translate(0, ARM_L, 0);
    p.box(12, 12, 12);
    p.pop();

    p.pop(); // torso chain

    // Legs
    p.push();
    p.translate(-15, 10, 0);
    const lStep = p.sin(groove) * 0.4;
    p.rotateX(lStep + b.sub * 0.2);
    drawBox(LIMB_W, THIGH_L, LIMB_W);
    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -lStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);
    p.translate(0, SHIN_L, 5); // Shift feet slightly forward (Z+)
    p.box(15, FOOT_H, 30);
    p.pop();

    p.push();
    p.translate(15, 10, 0);
    const rStep = p.sin(groove + p.PI) * 0.4;
    p.rotateX(rStep + b.sub * 0.2);
    drawBox(LIMB_W, THIGH_L, LIMB_W);
    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -rStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);
    p.translate(0, SHIN_L, 5); // Shift feet slightly forward (Z+)
    p.box(15, FOOT_H, 30);
    p.pop();

    p.pop(); // hierarchy
    p.pop(); // context
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
