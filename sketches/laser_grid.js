// Laser Grid — a full synthwave horizon scene.
// Striped sun, twinkling star field, mountain silhouettes, a foggy scrolling
// perspective grid and triple-layer glow laser beams. Sub pushes the grid
// toward the viewer and swells the sun, mids tilt the vanishing point, highs
// twinkle the stars and fire extra beams.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let hueOffset = 0;
  let scroll = 0;
  const getBands = makeBands();
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

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    buildScenery();
  };

  p.draw = () => {
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
    const sunHue = (hueOffset + 320) % 360;
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
    const gridHue = (hueOffset + 280) % 360;
    for (let i = 0; i < gridLines; i++) {
      const tt = (i / gridLines + scroll) % 1;
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
    const beams = Math.floor(beamCount + high * 6);
    for (let i = 0; i < beams; i++) {
      const ph = t * 0.008 * speed + (i * p.TWO_PI) / Math.max(1, beams);
      const bx = cx + p.sin(ph) * p.width * 0.45;
      const hue = (hueOffset + i * 40) % 360;
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
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    buildScenery();
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
