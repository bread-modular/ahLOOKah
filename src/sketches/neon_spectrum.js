// Neon Spectrum — neon-styled clone of Bars.
// Same audio transport, params and controller as Bars (waveform → intensity +
// downsampled left/right waves), but rendered with a rainbow neon glow so it
// fills the full width like Bars instead of the old low-end-only spectrum.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    intensity: { min: 0, max: 1, neutral: 0 },
  },
  arrays: {
    leftWave: { minLength: 64, maxLength: 512, min: 0, max: 255 },
    rightWave: { minLength: 64, maxLength: 512, min: 0, max: 255 },
  },
  events: {},
  neutral: {
    continuous: { intensity: 0 },
  },
});

// Legacy getAmplitudes() semantics: RMS of the byte time-domain waveform.
function amplitudeRms(channel) {
  if (!channel?.length) return 0;
  let sum = 0;
  for (let i = 0; i < channel.length; i++) {
    const value = (channel[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / channel.length);
}

function downsampleBytes(source, maxLen) {
  if (!source?.length) return new Uint8Array(0);
  if (source.length <= maxLen) return new Uint8Array(source);
  const output = new Uint8Array(maxLen);
  for (let i = 0; i < maxLen; i++) {
    output[i] = source[Math.min(source.length - 1, Math.floor((i / maxLen) * source.length))];
  }
  return output;
}

export function createAudioController() {
  let intensity = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const waveforms = shared?.getByteWaveforms?.() || { left: null, right: null };
      const currentAmp = (amplitudeRms(waveforms.left) + amplitudeRms(waveforms.right)) * 0.5;
      intensity += (currentAmp - intensity) * (1 - Math.pow(0.9, 60 * dt));

      const leftWave = downsampleBytes(waveforms.left, 512);
      const rightWave = downsampleBytes(waveforms.right, 512);
      return {
        continuous: { intensity: clamp(intensity, 0, 1) },
        arrays: { leftWave, rightWave },
        events: [],
      };
    },
    dispose() {},
  };
}

// Keep for backwards compat — not used by the new waveform transport but
// some callers may import it. Simple passthrough based on RMS.
export function analyzeNeonBands(freqs, params) {
  if (!freqs?.length) return { low: 0, mid: 0, high: 0, energy: 0 };
  const bb = params?.bass ?? 1;
  const mb = params?.mid ?? 1;
  const hb = params?.high ?? 1;
  let low = 0, mid = 0, high = 0;
  for (let i = 0; i < 40; i++) low += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  low = low / (40 * 255) * bb;
  mid = mid / (110 * 255) * mb;
  high = high / (350 * 255) * hb;
  return { low, mid, high, energy: (low + mid + high) / 3 };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let intensity = 0;
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 100);
  };

  function drawBars(currentIntensity, leftWave, rightWave, gain, barWidth, flash) {
    const spacing = 2;
    const totalBars = Math.floor(p.width / (barWidth + spacing));
    if (totalBars <= 0) return;

    const ctx = p.drawingContext;

    for (let i = 0; i < totalBars; i++) {
      if (!leftWave?.length) continue;
      const sampleIdx = Math.floor(p.map(i, 0, totalBars, 0, leftWave.length));

      // Hue sweeps magenta -> red -> orange -> yellow -> green -> cyan -> blue,
      // matching the screenshot's rainbow. Fixed across the width so the full
      // analyzer feels evenly distributed.
      const hue = (300 + (i / Math.max(1, totalBars - 1)) * 300) % 360;
      const isHotL = (leftWave[sampleIdx] > 220) || (currentIntensity > 0.4 / flash);

      // Left Channel (Top half)
      const valL = leftWave[sampleIdx];
      const hL = p.map(valL, 128, 255, 2, p.height / 2) * gain;

      if (isHotL) {
        // hot peak — white core + colored outer glow
        p.noStroke();
        ctx.save();
        ctx.shadowBlur = 20;
        ctx.shadowColor = `hsl(${Math.round(hue)}, 100%, 60%)`;
        p.fill(0, 0, 100, 96);
        p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, hL, 1);
        ctx.restore();
        // extra outer glow pass (low alpha, larger blur)
        ctx.save();
        ctx.shadowBlur = 28;
        ctx.shadowColor = `hsl(${Math.round(hue)}, 100%, 58%)`;
        p.fill(hue, 96, 100, 42);
        p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, hL, 1);
        ctx.restore();
      } else {
        p.noStroke();
        ctx.save();
        ctx.shadowBlur = 14;
        ctx.shadowColor = `hsl(${Math.round(hue)}, 100%, 56%)`;
        p.fill(hue, 92, 100, 88);
        p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, hL, 1);
        ctx.restore();
        // subtle inner core for depth
        p.fill(hue, 88, 100, 58);
        p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, Math.min(hL, 3), 1);
      }

      // Right Channel (Bottom half) — same hue, symmetrical
      const valR = rightWave && rightWave.length ? rightWave[sampleIdx] : valL;
      const hR = p.map(valR, 128, 255, 2, p.height / 2) * gain;
      const isHotR = (valR > 220) || (currentIntensity > 0.4 / flash);

      if (isHotR) {
        p.noStroke();
        ctx.save();
        ctx.shadowBlur = 20;
        ctx.shadowColor = `hsl(${Math.round(hue)}, 100%, 60%)`;
        p.fill(0, 0, 100, 96);
        p.rect(i * (barWidth + spacing), p.height / 2, barWidth, hR, 1);
        ctx.restore();
        ctx.save();
        ctx.shadowBlur = 28;
        ctx.shadowColor = `hsl(${Math.round(hue)}, 100%, 58%)`;
        p.fill(hue, 96, 100, 42);
        p.rect(i * (barWidth + spacing), p.height / 2, barWidth, hR, 1);
        ctx.restore();
      } else {
        p.noStroke();
        ctx.save();
        ctx.shadowBlur = 14;
        ctx.shadowColor = `hsl(${Math.round(hue)}, 100%, 56%)`;
        p.fill(hue, 92, 100, 88);
        p.rect(i * (barWidth + spacing), p.height / 2, barWidth, hR, 1);
        ctx.restore();
        p.fill(hue, 88, 100, 58);
        p.rect(i * (barWidth + spacing), p.height / 2, barWidth, Math.min(hR, 3), 1);
      }
    }

    // Center divider — faint neon line
    p.noStroke();
    const ctx2 = p.drawingContext;
    ctx2.save();
    ctx2.shadowBlur = 10;
    ctx2.shadowColor = 'hsl(280, 90%, 65%)';
    p.fill(0, 0, 38, 52);
    p.rect(0, p.height / 2 - 0.6, p.width, 1.2);
    ctx2.restore();
    p.fill(0, 0, 100, 14);
    p.rect(0, p.height / 2 - 0.6, p.width, 1.2);

    // Flash overlay for extreme intensity — white/pink wash
    if (currentIntensity > 0.5 / flash) {
      p.noStroke();
      p.fill(320, 72, 100, 11);
      p.rect(0, 0, p.width, p.height);
      // second additive layer for bloom
      p.fill(0, 0, 100, 5);
      p.rect(0, 0, p.width, p.height);
    }
  }

  function drawMigrated() {
    p.background(0, 0, 0);
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const P = params || {};
    drawBars(
      C.intensity,
      controls.arrays?.leftWave,
      controls.arrays?.rightWave,
      P.gain ?? 1,
      P.barWidth ?? 4,
      P.flash ?? 1,
    );
  }

  function drawLegacy() {
    p.background(0, 0, 0);

    const P = params || {};
    const gain = P.gain ?? 1;
    const barWidth = P.barWidth ?? 4;
    const flash = P.flash ?? 1;

    if (!audio || !audio.isStarted) return;

    const waveforms = audio.getWaveforms();
    const amps = audio.getAmplitudes();
    if (!waveforms) return;

    const currentAmp = (amps.left + amps.right) * 0.5;
    intensity = p.lerp(intensity, currentAmp, 0.1);

    drawBars(intensity, waveforms.left, waveforms.right, gain, barWidth, flash);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};
