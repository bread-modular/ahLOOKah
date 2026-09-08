// Main-thread render budget, not GPU utilization. No readbacks, gl.finish(), or
// GPU-query polling in production. Output RAF cadence exposes stalls which CPU
// submission timing alone cannot explain; control preview is never sampled.
export const FRAME_BUDGET_MS = 1000 / 60;
const round = (value) => Math.round(value * 100) / 100;

export class RenderPerformance {
  constructor() { this.reset(); }

  reset(generation = null, ids = []) {
    this.generation = generation;
    this.ids = [...ids];
    this.started = null;
    this.previous = null;
    this.clearWindow();
  }

  clearWindow() {
    this.frames = 0;
    this.slowFrames = 0;
    this.totalMs = 0;
    this.patterns = new Map(this.ids.map((id) => [id, { ms: 0, surfaces: new Map() }]));
  }

  setProgram(generation, ids) {
    if (this.generation !== generation) this.reset(generation, ids);
  }

  record(patternId, surfaceId, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.totalMs += ms;
    const pattern = this.patterns.get(patternId);
    if (!pattern) return; // Shared final-output compositing counts only once.
    pattern.ms += ms;
    if (surfaceId) pattern.surfaces.set(surfaceId, (pattern.surfaces.get(surfaceId) || 0) + ms);
  }

  tick(now, hidden = false) {
    if (hidden || this.generation == null) {
      this.reset(this.generation, this.ids);
      return null;
    }
    if (this.started == null) {
      this.started = this.previous = now;
      this.clearWindow();
      return null;
    }
    this.frames += 1;
    if (now - this.previous > FRAME_BUDGET_MS * 1.5) this.slowFrames += 1;
    this.previous = now;
    const elapsed = now - this.started;
    if (elapsed < 1000) return null;
    const cost = (ms) => ({ cpuMs: round(ms / this.frames), cpuPercent: round(ms / this.frames / FRAME_BUDGET_MS * 100) });
    const sample = {
      generation: this.generation,
      ids: [...this.ids],
      fps: round(this.frames * 1000 / elapsed),
      frameMs: round(elapsed / this.frames),
      slowPercent: round(this.slowFrames / this.frames * 100),
      ...cost(this.totalMs),
      patterns: Object.fromEntries([...this.patterns].map(([id, pattern]) => [id, {
        ...cost(pattern.ms),
        surfaces: Object.fromEntries([...pattern.surfaces].map(([id, ms]) => [id, cost(ms)])),
      }])),
    };
    this.started = now;
    this.clearWindow();
    return sample;
  }
}

// Telemetry is a small, untrusted cross-window message. Never let it mutate
// program authority or trigger the full selection/parameter sync path.
export function validPerformanceSample(sample) {
  const number = (value) => Number.isFinite(value) && value >= 0 && value <= 1e7;
  const cost = (value) => value && number(value.cpuMs) && number(value.cpuPercent);
  return Boolean(sample && number(sample.generation) && Array.isArray(sample.ids)
    && sample.ids.length > 0 && sample.ids.length <= 2
    && sample.ids.every((id) => typeof id === 'string' && id.length <= 64)
    && number(sample.fps) && number(sample.frameMs) && number(sample.slowPercent) && cost(sample)
    && sample.patterns && Object.keys(sample.patterns).length <= 2
    && sample.ids.every((id) => {
      const pattern = sample.patterns[id];
      return cost(pattern) && pattern.surfaces && Object.keys(pattern.surfaces).length <= 8
        && Object.entries(pattern.surfaces).every(([id, value]) => id.length <= 64 && cost(value));
    }));
}
