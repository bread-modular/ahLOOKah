// Waveform Tunnel — fly through a 3D tunnel whose rings are carved from the
// live waveform. Opted-in renderers consume bounded radii/phase controls from
// the capture owner; the legacy raw audio path is kept for all other callers.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    twist: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    tunnelScale: { min: 0.25, max: 6, neutral: 1 },
    shimmerAmount: { min: 0, max: 2, neutral: 0 },
  },
  arrays: {
    ringRadii: { minLength: 20, maxLength: 80, min: 0, max: 5_000 },
  },
  events: {},
  neutral: {
    continuous: { hueOffset: 0, twist: 0, tunnelScale: 1, shimmerAmount: 0 },
  },
});

export function analyzeTunnelBands(freqs) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  let sub = 0; let mid = 0; let high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  sub /= 4 * 255;
  mid /= 110 * 255;
  high /= 350 * 255;
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

export function createAudioController() {
  let hueOffset = 0;
  let twist = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const frequencies = shared?.getByteFrequencies?.() || { left: null };
      const waveforms = shared?.getByteWaveforms?.() || { left: null };
      const b = analyzeTunnelBands(frequencies.left);
      const rings = clamp(Math.round(Number(params.rings) || 46), 20, 80);
      const twistSpeed = Math.max(0, Number(params.twist ?? 1));
      const baseScale = Math.max(0.25, Number(params.scale ?? 1));
      const subPush = Math.max(0, Number(params.sub ?? 1));
      const tunnelScale = clamp(baseScale * (1 + b.sub * 0.9 * subPush), 0.25, 6);
      hueOffset = (hueOffset + (0.4 + b.energy * 2) * dt * 60) % 360;
      twist += (0.004 + b.mid * 0.02) * twistSpeed * dt * 60;
      if (Math.abs(twist) > 900_000) twist %= 100_000;

      const waveform = waveforms.left || new Uint8Array(0);
      const ringRadii = new Float32Array(rings);
      for (let i = 0; i < rings; i++) {
        const index = waveform.length
          ? Math.min(waveform.length - 1, Math.floor((i / Math.max(1, rings)) * waveform.length * 0.8))
          : 0;
        const sample = waveform.length ? ((waveform[index] - 128) / 128) : 0;
        ringRadii[i] = clamp((300 + sample * 260) * tunnelScale, 0, 5_000);
      }

      return {
        continuous: {
          hueOffset,
          twist,
          tunnelScale,
          shimmerAmount: clamp(b.high, 0, 2),
        },
        arrays: { ringRadii },
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const SEGMENTS = 36;
  const DEPTH = 900;
  const audioControls = runtimeContext?.audioControls || null;
  let legacyHueOffset = 0;
  let legacyTwist = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.angleMode(p.RADIANS);
  };

  function drawTunnel(radii, hueOffset, twist, tunnelScale, shimmerAmount) {
    const rings = radii.length;
    p.translate(0, 0, 120);
    for (let i = 0; i < rings; i++) {
      const z = p.map(i, 0, Math.max(1, rings - 1), -DEPTH, 120);
      const radius = radii[i];
      const hue = (hueOffset + i * 14) % 360;
      const alpha = p.map(i, 0, rings, 30, 220);
      const rotation = twist + i * 0.12;
      p.push();
      p.translate(0, 0, z);
      p.rotateZ(rotation * 0.3);
      p.noFill();
      p.strokeWeight(p.map(i, 0, rings, 0.5, 3.5));
      p.stroke(hue, 85, 100, alpha);
      p.beginShape();
      for (let segment = 0; segment <= SEGMENTS; segment++) {
        const angle = (segment / SEGMENTS) * p.TWO_PI + rotation;
        // This is visual-only geometry wobble, deliberately retained screen-side.
        const wobble = 1 + 0.12 * p.sin(angle * 3 + p.frameCount * 0.06);
        p.vertex(p.cos(angle) * radius * wobble, p.sin(angle) * radius * wobble);
      }
      p.endShape(p.CLOSE);
      p.pop();
    }

    if (shimmerAmount > 0.35) {
      p.push();
      p.noFill();
      p.strokeWeight(1.5);
      for (let i = 0; i < 4; i++) {
        p.stroke((hueOffset + p.random(120)) % 360, 90, 100, 120);
        p.rotateZ(p.random(p.TWO_PI));
        const radius = p.random(140, 420) * tunnelScale;
        p.arc(0, 0, radius, radius, p.random(p.TWO_PI), p.random(p.TWO_PI));
      }
      p.pop();
    }
  }

  function drawMigrated() {
    p.background(0);
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    let radii = controls.arrays?.ringRadii;
    if (!radii?.length) {
      const count = clamp(Math.round(Number(params?.rings) || 46), 20, 80);
      radii = new Float32Array(count);
      radii.fill(300 * C.tunnelScale);
    }
    drawTunnel(radii, C.hueOffset, C.twist, C.tunnelScale, C.shimmerAmount);
  }

  function drawLegacy() {
    p.background(0);
    const P = params || {};
    const rings = P.rings ?? 46;
    const twistSpeed = P.twist ?? 1;
    const tunnelScale = P.scale ?? 1;
    const subPush = P.sub ?? 1;
    const waveform = audio && audio.isStarted ? audio.getWaveforms() : null;
    const frequencies = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = analyzeTunnelBands(frequencies ? frequencies.left : null);
    legacyHueOffset = (legacyHueOffset + 0.4 + b.energy * 2) % 360;
    legacyTwist += (0.004 + b.mid * 0.02) * twistSpeed;
    const scale = tunnelScale * (1 + b.sub * 0.9 * subPush);
    const radii = new Float32Array(rings);
    for (let i = 0; i < rings; i++) {
      if (waveform) {
        const index = Math.floor(p.map(i, 0, rings, 0, waveform.left.length * 0.8));
        const sample = (waveform.left[index] - 128) / 128;
        radii[i] = (300 + sample * 260) * scale;
      } else {
        radii[i] = (300 + 120 * p.sin(p.frameCount * 0.03 + i * 0.4)) * scale;
      }
    }
    drawTunnel(radii, legacyHueOffset, legacyTwist, scale, b.high);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
  p.mousePressed = () => { if (audio) audio.resume(); };
};
