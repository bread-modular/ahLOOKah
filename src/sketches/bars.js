// Bars — symmetric left/right waveform bars with peak-flash highlights.
// The opted-in path consumes a smoothed intensity scalar plus two bounded
// downsampled waveform arrays produced by a DOM-free capture-side controller;
// the legacy raw-frame path is preserved for all other callers.

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

// Keep the waveform bounded for the transport: evenly sampled bytes so the
// renderer can keep mapping bar indices across the whole captured window.
function downsampleBytes(source, maxLen) {
  if (!source?.length) return new Uint8Array(0);
  if (source.length <= maxLen) return new Uint8Array(source);
  const output = new Uint8Array(maxLen);
  for (let i = 0; i < maxLen; i++) {
    output[i] = source[Math.min(source.length - 1, Math.floor((i / maxLen) * source.length))];
  }
  return output;
}

// The controller owns waveform acquisition, the amplitude envelope and the
// bounded byte arrays. The renderer only maps bars into the provided data.
export function createAudioController() {
  let intensity = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const waveforms = shared?.getByteWaveforms?.() || { left: null, right: null };
      // Legacy per-frame lerp(0.1) becomes a time-based follow at 60 FPS
      // equivalence so controller cadence does not change the envelope.
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

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let intensity = 0;
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.RGB, 255);
  };

  function drawBars(currentIntensity, leftWave, rightWave, gain, barWidth, flash) {
    const spacing = 2;
    const totalBars = Math.floor(p.width / (barWidth + spacing));

    p.noStroke();

    for (let i = 0; i < totalBars; i++) {
      if (leftWave?.length) {
        const sampleIdx = Math.floor(p.map(i, 0, totalBars, 0, leftWave.length));

        // Left Channel (Top half)
        const valL = leftWave[sampleIdx];
        const hL = p.map(valL, 128, 255, 2, p.height / 2) * gain;

        // Calculate highlight - flash red on high intensity peaks
        if (valL > 220 || currentIntensity > 0.4 / flash) {
          p.fill(255, 0, 0, 200); // Intensity Red
        } else {
          const gray = p.map(i, 0, totalBars, 100, 200);
          p.fill(gray, 180);
        }
        p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, hL);

        // Right Channel (Bottom half)
        const valR = rightWave && rightWave.length ? rightWave[sampleIdx] : valL;
        const hR = p.map(valR, 128, 255, 2, p.height / 2) * gain;

        if (valR > 220 || currentIntensity > 0.4 / flash) {
          p.fill(255, 0, 0, 200);
        } else {
          const gray = p.map(i, 0, totalBars, 100, 200);
          p.fill(gray, 180);
        }
        p.rect(i * (barWidth + spacing), p.height / 2, barWidth, hR);
      }
    }

    // Minimal divider
    p.stroke(40);
    p.line(0, p.height / 2, p.width, p.height / 2);

    // Flash overlay for extreme intensity
    if (currentIntensity > 0.5 / flash) {
      p.noStroke();
      p.fill(255, 0, 0, 20); // Very subtle red flash
      p.rect(0, 0, p.width, p.height);
    }
  }

  function drawMigrated() {
    p.background(0);
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

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const gain = P.gain ?? 1;
    const barWidth = P.barWidth ?? 4;
    const flash = P.flash ?? 1;

    if (!audio || !audio.isStarted) return;

    const waveforms = audio.getWaveforms();
    const amps = audio.getAmplitudes();
    if (!waveforms) return;

    // Track overall intensity (mix of both channels)
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
