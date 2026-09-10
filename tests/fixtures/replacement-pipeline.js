// Focused replacement audit. Imports production capture/feature/transport code;
// the oscillator fixture replaces the physical cable, NOT FFT or normalization.
import { AudioManager } from '/src/audio-manager.js';
import { clearNoiseFloor } from '/src/noise-floor.js';
import { makeAudioFeatures } from '/src/sketches/audio-features.js';
import { PatternAudioControlEngine } from '/src/pattern-audio-engine.js';
import { PatternAudioControlStore } from '/src/pattern-audio-controls.js';
import { GRAPHIC_PATTERNS } from '/src/sketches/replacements/graphic.js';
import { FIELD_PATTERNS } from '/src/sketches/replacements/fields.js';
import { SPATIAL_PATTERNS } from '/src/sketches/replacements/spatial.js';
import { VIDEO_PATTERNS } from '/src/sketches/replacements/video.js';
export const OWNED = [...GRAPHIC_PATTERNS, ...FIELD_PATTERNS, ...SPATIAL_PATTERNS, ...VIDEO_PATTERNS];
export const defaults = s => Object.fromEntries(s.params.map(p => [p.key, p.default]));
export const DT = 1 / 30;
const dbAmplitude = db => 10 ** (db / 20);

export async function captureAnalyzer(band = 'bass', db = -60) {
  clearNoiseFloor();
  const manager = new AudioManager();
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const gain = context.createGain(), sink = context.createGain(); sink.gain.value = 0;
  manager.audioContext = context;
  manager.analyserL = context.createAnalyser(); manager.analyserR = context.createAnalyser();
  manager.configureAnalyser(manager.analyserL); manager.configureAnalyser(manager.analyserR);
  manager.allocateBuffers(); manager.isStarted = true;
  gain.connect(manager.analyserL); gain.connect(manager.analyserR);
  manager.analyserL.connect(sink); sink.connect(context.destination);
  // Three harmonics in one selected band. Equal power is controlled at the
  // waveform, while actual AnalyserNode windowing/leakage remains measurable.
  const frequencies = { bass: [70.3125, 93.75, 140.625], mid: [562.5, 1031.25, 1757.8125], high: [6000, 8015.625, 10992.1875] }[band];
  const oscillators = frequencies.map(frequency => {
    const osc = context.createOscillator(); osc.frequency.value = frequency; osc.connect(gain); osc.start(); return osc;
  });
  await context.resume();
  const frames = [], measurements = [], analyze = makeAudioFeatures();
  try {
    for (let i = 0; i < 84; i++) {
      // Prime AGC with a preceding loud passage, then weak pulses: gain cannot
      // magically jump +30 dB at the drop, as it did in the previous tests.
      const level = i < 18 ? -22 : i < 30 ? -100 : db + (i % 12 < 4 ? 0 : -14);
      gain.gain.setValueAtTime(dbAmplitude(level) * Math.sqrt(2 / 3), context.currentTime);
      await new Promise(resolve => setTimeout(resolve, 1000 / 30));
      const f = manager.getAnalysisFrame();
      let sum = 0; for (const v of f.waveformLeft) sum += v * v;
      const rms = Math.sqrt(sum / f.waveformLeft.length);
      const frame = { left: Array.from(f.left, v => Number.isFinite(v) ? v : -120), right: Array.from(f.right, v => Number.isFinite(v) ? v : -120), rms,
        sampleRate: f.sampleRate, fftSize: f.fftSize, channels: 1, time: f.time };
      frames.push(frame);
      measurements.push({ index: i, inputDb: 20 * Math.log10(Math.max(rms, 1e-12)), ...analyze({ ...frame, left: f.left.slice(), right: f.right.slice() }, {}, DT) });
    }
    return { band, requestedDb: db, smoothing: manager.analyserL.smoothingTimeConstant, frames, measurements };
  } finally {
    oscillators.forEach(o => { o.stop(); o.disconnect(); }); gain.disconnect(); sink.disconnect();
    await manager.releaseCurrentStream();
  }
}

export function throughPipeline(id, frames, patch = {}, { interpolationDelayMs, sketch = OWNED.find(s => s.id === id) } = {}) {
  let now = 0;
  const engine = new PatternAudioControlEngine({ ownerId: 'audit-capture', getSketchById: key => key === id ? sketch : null, now: () => now });
  const store = new PatternAudioControlStore({ consumerSessionId: 'audit-screen', interpolationDelayMs, now: () => now });
  const plan = { type: 'pattern-audio-plan', version: 1, consumerSessionId: 'audit-screen', planRevision: 1, sentAt: 0, complete: true,
    slots: [{ runtimeId: 'audit', patternId: id, role: 'live', childIndex: 0, paramsRevision: 1, params: { ...defaults(sketch), ...patch }, audioTransport: sketch.audioTransport, audioControlSchema: sketch.audioControlSchema }] };
  if (!engine.receivePlan(plan).accepted) throw new Error('Plan rejected');
  store.setPlan(plan);
  const timeline = [], features = [];
  try {
    frames.forEach((raw, i) => {
      now = i * DT * 1000;
      const frame = raw && { ...raw, left: Float32Array.from(raw.left, v => Number.isFinite(v) ? v : -120), right: Float32Array.from(raw.right, v => Number.isFinite(v) ? v : -120) };
      const result = engine.update({ frame, now, captureTime: now, sequence: i + 1, deltaSeconds: DT });
      if (!store.acceptPacket(result.packets[0]).accepted) throw new Error('Packet rejected');
      timeline.push(store.createBinding('audit').read());
      features.push(result.shared.getFeatures());
      if (result.shared.diagnostics.featureBuilds !== 1) throw new Error('Repeated FFT feature scan');
    });
    return { timeline, features, interpolationDelayMs: store.interpolationDelayMs, engine: engine.getDiagnostics(), store: store.getDiagnostics() };
  } finally { engine.disposeControllers(); }
}
