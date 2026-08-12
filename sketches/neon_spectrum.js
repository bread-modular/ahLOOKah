// Neon Spectrum — colorful frequency bars with additive glow.
// Each bar gets its own hue from a slowly cycling rainbow; bass/mid/high
// energy push brightness, bar height and hue speed. Ideal for techno sets.
// The opted-in path consumes a hue offset, an energy scalar and a bounded
// downsampled spectrum array from a DOM-free capture-side controller; the
// legacy raw-frame path is preserved for all other callers.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    energy: { min: 0, max: 2.5, neutral: 0 },
  },
  arrays: {
    spectrum: { minLength: 64, maxLength: 512, min: 0, max: 255 },
  },
  events: {},
  neutral: {
    continuous: { hueOffset: 0, energy: 0 },
  },
});

// Legacy band extraction (left channel) with live boosts read from params.
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

// Evenly sampled byte spectrum so the renderer keeps mapping bar indices to
// the same frequency coverage (legacy used ~70% of the 1024 bins).
function downsampleBytes(source, maxLen) {
  if (!source?.length) return new Uint8Array(0);
  if (source.length <= maxLen) return new Uint8Array(source);
  const output = new Uint8Array(maxLen);
  for (let i = 0; i < maxLen; i++) {
    output[i] = source[Math.min(source.length - 1, Math.floor((i / maxLen) * source.length))];
  }
  return output;
}

// The controller owns spectrum acquisition, band boosts, the hue drift and
// the bounded spectrum array. The renderer only maps bars into the data.
export function createAudioController() {
  let hueOffset = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = analyzeNeonBands(freqs.left, params);
      hueOffset = (hueOffset + (0.35 + b.energy * 2.5) * dt * 60) % 360;
      const spectrum = downsampleBytes(freqs.left, 512);
      return {
        continuous: {
          hueOffset,
          energy: clamp(b.energy, 0, 2.5),
        },
        arrays: { spectrum },
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let hueOffset = 0;
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  function drawBars(energy, spectrum) {
    // Bar count is structural but re-read each frame so it applies on the fly
    const BARS = params?.bars ?? 72;

    const w = p.width / BARS;
    for (let i = 0; i < BARS; i++) {
      let v;
      if (spectrum?.length) {
        // Legacy coverage: map bars over ~70% of the captured spectrum bins.
        const idx = Math.floor(p.map(i, 0, BARS, 0, spectrum.length * 0.6836));
        v = spectrum[Math.min(spectrum.length - 1, idx)] / 255;
      } else {
        // Idle animation so the stage is never black
        v = 0.06 + 0.1 * p.sin(p.frameCount * 0.05 + i * 0.45);
      }

      const h = p.map(p.pow(v, 1.3), 0, 1, 0, p.height * 0.85);
      const hue = (hueOffset + i * 6.5) % 360;
      const sat = 70 + v * 30;
      const bri = 55 + v * 45;

      p.noStroke();
      p.fill(hue, sat, bri, 210);
      p.rect(i * w, p.height / 2 - h, w - 2, h);
      p.fill(hue, sat, bri * 0.6, 150);
      p.rect(i * w, p.height / 2, w - 2, h);

      // Bright caps for extra punch
      p.fill(hue, sat, 100, 230);
      p.rect(i * w, p.height / 2 - h - 3, w - 2, 4);
      p.rect(i * w, p.height / 2 + h - 3, w - 2, 4);
    }

    // Full-screen strobing tint on loud peaks
    if (energy > 0.45) {
      p.noStroke();
      p.fill((hueOffset + 180) % 360, 60, 90, 14);
      p.rect(0, 0, p.width, p.height);
    }
  }

  function drawMigrated() {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.hueOffset;
    drawBars(C.energy, controls.arrays?.spectrum);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = analyzeNeonBands(freqs ? freqs.left : null, params);

    hueOffset = (hueOffset + 0.35 + b.energy * 2.5) % 360;
    drawBars(b.energy, freqs ? freqs.left : null);
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
