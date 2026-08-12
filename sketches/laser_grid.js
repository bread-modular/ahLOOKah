// Laser Grid — a full synthwave horizon scene.
// Striped sun, twinkling star field, mountain silhouettes, a foggy scrolling
// perspective grid and triple-layer glow laser beams. Sub pushes the grid
// toward the viewer and swells the sun, mids tilt the vanishing point, highs
// twinkle the stars and fire extra beams.
// The legacy raw-frame draw path remains intact; the opted-in path consumes
// final render controls produced by a DOM-free capture-side controller.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    energy: { min: 0, max: 2, neutral: 0.15 },
    sub: { min: 0, max: 2, neutral: 0.2 },
    mid: { min: 0, max: 2, neutral: 0.15 },
    high: { min: 0, max: 2, neutral: 0 },
    hueOffset: { min: 0, max: 360, neutral: 0 },
    scroll: { min: 0, max: 1, neutral: 0 },
    beamCount: { min: 0, max: 28, neutral: 6 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      energy: 0.15,
      sub: 0.2,
      mid: 0.15,
      high: 0,
      hueOffset: 0,
      scroll: 0,
      beamCount: 6,
    },
  },
});

// The controller owns all audio interpretation on the capture owner: it
// reproduces the legacy makeBands envelope (attack 0.6 / release 0.14 per
// nominal 60 Hz frame, converted to elapsed time) over the shared byte
// spectrum, mirrors the renderer's idle fallbacks when no audio frame exists,
// and advances the hue/scroll phase and audio-driven beam count.
export function createAudioController({ rng = Math.random } = {}) {
  let s = 0, m = 0, h = 0, e = 0;
  let hueOffset = 0;
  let scroll = 0;
  let elapsed = 0;
  return {
    update({ frame, shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(finite(deltaSeconds, 1 / 30), 1 / 240, 0.1);
      elapsed += dt;
      const bb = Math.max(0, finite(params.bass, 1));
      const mb = Math.max(0, finite(params.mid, 1));
      const hb = Math.max(0, finite(params.high, 1));
      const speed = Math.max(0, finite(params.speed, 1));

      const freqs = frame ? (shared?.getByteFrequencies?.() || {}).left : null;
      let energy, sub, mid, high;
      if (freqs?.length) {
        let rawSub = 0, rawMid = 0, rawHigh = 0;
        for (let i = 0; i < 4; i++) rawSub += freqs[i] || 0;
        for (let i = 40; i < 150; i++) rawMid += freqs[i] || 0;
        for (let i = 150; i < 500; i++) rawHigh += freqs[i] || 0;
        const targetSub = clamp((rawSub / (4 * 255)) * bb, 0, 2);
        const targetMid = clamp((rawMid / (110 * 255)) * mb, 0, 2);
        const targetHigh = clamp((rawHigh / (350 * 255)) * hb, 0, 2);
        const targetEnergy = clamp((targetSub + targetMid + targetHigh) / 3, 0, 2);
        const alpha = (cur, target) => 1 - Math.pow(1 - (target > cur ? 0.6 : 0.14), dt * 60);
        s += (targetSub - s) * alpha(s, targetSub);
        m += (targetMid - m) * alpha(m, targetMid);
        h += (targetHigh - h) * alpha(h, targetHigh);
        e += (targetEnergy - e) * alpha(e, targetEnergy);
        sub = s; mid = m; high = h; energy = e;
      } else {
        // Legacy getBands keeps decaying its envelope toward zero while no
        // frequency data exists; mirror that so audio returns smoothly.
        const decay = 1 - Math.pow(1 - 0.14, dt * 60);
        s -= s * decay; m -= m * decay; h -= h * decay; e -= e * decay;
        const idle = 0.5 + 0.5 * Math.sin(elapsed * 60 * 0.02);
        const idle2 = 0.5 + 0.5 * Math.sin(elapsed * 60 * 0.013 + 2);
        energy = 0.15 + idle * 0.2;
        sub = 0.2 + idle * 0.25;
        mid = 0.15 + idle2 * 0.15;
        high = idle * 0.3;
      }

      hueOffset = (hueOffset + (0.25 + energy * 1.5) * dt * 60) % 360;
      scroll = (scroll + (0.004 + sub * 0.06) * speed * dt * 60) % 1;
      const beamCount = clamp(Math.floor(finite(params.beams, 6) + high * 6), 0, 28);

      return {
        continuous: {
          energy: clamp(energy, 0, 2),
          sub: clamp(sub, 0, 2),
          mid: clamp(mid, 0, 2),
          high: clamp(high, 0, 2),
          hueOffset,
          scroll,
          beamCount,
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let hueOffset = 0;
  let scroll = 0;
  const getBands = makeBands();
  const audioControls = runtimeContext?.audioControls || null;
  let stars = [];
  let mountains = [];

  function buildScenery() {
    stars = [];
    for (let i = 0; i < 140; i++) {
      stars.push({
        x: p.random(p.width),
        y: p.random(p.height * 0.55),
        s: p.random(0.5, 2),
        ph: p.random(100),
      });
    }
    // Two jagged mountain layers (parallax silhouettes)
    mountains = [0, 1].map((layer) => {
      const pts = [];
      const n = 24;
      const base = p.height * (0.52 + layer * 0.04);
      const amp = p.height * (0.1 - layer * 0.035);
      for (let i = 0; i <= n; i++) {
        pts.push({ x: (i / n) * p.width, y: base - p.noise(i * 0.4, layer * 10) * amp });
      }
      return pts;
    });
  }

  // Pure drawing shared by the migrated and legacy paths. All audio-derived
  // values arrive pre-computed; only visual state and params are used here.
  function drawScene(sub, mid, high, hueOffsetValue, scrollValue, beams, gridLines, speed, t) {
    const cx = p.width / 2;
    const horizon = p.height * 0.55;
    const vpx = cx + (mid - 0.4) * p.width * 0.12;

    // Sky gradient (deep purple → violet) + dark ground
    p.blendMode(p.BLEND);
    const ctx = p.drawingContext;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#07001a');
    sky.addColorStop(1, '#1e0640');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, p.width, horizon + 1);
    p.noStroke();
    p.fill(265, 60, 3, 255);
    p.rect(0, horizon, p.width, p.height - horizon);

    p.blendMode(p.ADD);

    // Stars twinkle with the highs
    for (const s of stars) {
      const tw = 0.4 + 0.6 * p.sin(t * 0.05 + s.ph);
      p.noStroke();
      p.fill(0, 0, 100, (50 + high * 160) * tw);
      p.circle(s.x, s.y, s.s * (1 + high * 0.8));
    }

    // Striped synthwave sun with glow
    const sunR = p.min(p.width, p.height) * (0.16 + sub * 0.05);
    const sunY = horizon - sunR * 0.5;
    const sunHue = (hueOffsetValue + 320) % 360;
    glowCircle(p, cx, sunY, sunR * 0.9, sunHue, 80, 100, 0.5 + sub * 0.6);
    p.noStroke();
    p.fill(sunHue, 85, 100, 235);
    p.circle(cx, sunY, sunR * 2);
    // Horizontal cuts reveal the ground color (classic outrun look)
    p.blendMode(p.BLEND);
    p.fill(265, 60, 3, 255);
    const cuts = 6;
    for (let i = 0; i < cuts; i++) {
      const yy = sunY + sunR * 0.12 + (i / cuts) * sunR * 0.95;
      p.rect(cx - sunR - 2, yy, sunR * 2 + 4, 2 + i * 1.3);
    }
    p.blendMode(p.ADD);

    // Mountain silhouettes over the sun's base
    p.blendMode(p.BLEND);
    for (let layer = 0; layer < mountains.length; layer++) {
      p.fill(270, 70, 2 + layer * 2, 255);
      p.beginShape();
      p.vertex(0, horizon + 2);
      for (const pt of mountains[layer]) p.vertex(pt.x, pt.y);
      p.vertex(p.width, horizon + 2);
      p.endShape(p.CLOSE);
    }
    p.blendMode(p.ADD);

    // Perspective grid — horizontals scroll toward the viewer, bass-pushed
    const gridHue = (hueOffsetValue + 280) % 360;
    for (let i = 0; i < gridLines; i++) {
      const tt = (i / gridLines + scrollValue) % 1;
      const y = horizon + tt * tt * (p.height - horizon);
      p.stroke(gridHue, 80, 90, 40 + tt * 160 + sub * 60);
      p.strokeWeight(1 + tt * 2.5);
      p.line(0, y, p.width, y);
    }
    // Verticals converge on the vanishing point
    const vLines = Math.floor(gridLines * 1.2);
    for (let i = -vLines; i <= vLines; i++) {
      const x = cx + (i / vLines) * p.width * 1.6;
      p.stroke(gridHue, 75, 85, 90 + sub * 80);
      p.strokeWeight(1);
      p.line(vpx, horizon, x, p.height);
    }

    // Horizon fog glow
    p.noStroke();
    p.fill(gridHue, 70, 90, 24 + sub * 60);
    p.rect(0, horizon - 4, p.width, 10 + sub * 20);

    // Sweeping laser beams — 3-layer glow each
    for (let i = 0; i < beams; i++) {
      const ph = t * 0.008 * speed + (i * p.TWO_PI) / Math.max(1, beams);
      const bx = cx + p.sin(ph) * p.width * 0.45;
      const hue = (hueOffsetValue + i * 40) % 360;
      const alpha = 120 + high * 120;
      const tx = vpx + (bx - vpx) * 0.2;
      p.stroke(hue, 85, 100, alpha * 0.22);
      p.strokeWeight(10);
      p.line(bx, -10, tx, horizon);
      p.stroke(hue, 70, 100, alpha * 0.55);
      p.strokeWeight(4);
      p.line(bx, -10, tx, horizon);
      p.stroke(hue, 30, 100, alpha);
      p.strokeWeight(1.5);
      p.line(bx, -10, tx, horizon);
    }

    vignette(p, 0.55);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const gridLines = P.grid ?? 18;
    const beamCount = P.beams ?? 6;
    const speed = P.speed ?? 1;

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.02);
    const idle2 = 0.5 + 0.5 * p.sin(t * 0.013 + 2);
    const energy = freqs ? b.energy : 0.15 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.25;
    const mid = freqs ? b.mid : 0.15 + idle2 * 0.15;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.25 + energy * 1.5) % 360;
    scroll = (scroll + (0.004 + sub * 0.06) * speed) % 1;

    const beams = Math.floor(beamCount + high * 6);
    drawScene(sub, mid, high, hueOffset, scroll, beams, gridLines, speed, t);
  }

  // Opted-in path: every audio-derived value arrives from the capture owner.
  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const P = params || {};
    const gridLines = P.grid ?? 18;
    const speed = P.speed ?? 1;
    drawScene(C.sub, C.mid, C.high, C.hueOffset, C.scroll, Math.round(C.beamCount), gridLines, speed, p.frameCount);
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    buildScenery();
  };

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    buildScenery();
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
