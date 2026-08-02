// Cosmic Web — a plexus constellation that breathes with the music.
// Nodes have depth (parallax drift, size/alpha by z) and glow; kicks scatter
// the mesh and send light pulses traveling along the links; highs ignite
// shooting stars. Bass swells the nodes, mids stretch the link distance.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  const nodes = [];
  const pulses = [];
  let hueOffset = 0;
  let prevSub = 0;
  const getBands = makeBands();

  function ensureNodes(n) {
    while (nodes.length < n) {
      nodes.push({
        x: p.random(p.width),
        y: p.random(p.height),
        vx: p.random(-0.4, 0.4),
        vy: p.random(-0.4, 0.4),
        z: p.random(0.4, 1), // depth: nearer = bigger, brighter, faster
        hue: p.random(360),
      });
    }
    nodes.length = Math.min(nodes.length, n);
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const count = Math.floor(P.nodes ?? 90);
    const linkBase = P.link ?? 130;
    const scatter = P.scatter ?? 1;
    const drift = P.drift ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.02);
    const energy = freqs ? b.energy : 0.18 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.25 + energy * 1.5) % 360;
    ensureNodes(count);

    const kicked = sub > 0.4 && sub > prevSub + 0.03;
    prevSub = sub;

    const linkDist = linkBase * (1 + mid * 0.6);
    const cx = p.width / 2;
    const cy = p.height / 2;

    // Update nodes: parallax drift, kick scatter, soft damping, wrap
    for (const nd of nodes) {
      nd.x += nd.vx * drift * (0.4 + energy) * nd.z;
      nd.y += nd.vy * drift * (0.4 + energy) * nd.z;
      if (kicked) {
        const dx = nd.x - cx, dy = nd.y - cy;
        const d = Math.hypot(dx, dy) + 1;
        nd.vx += (dx / d) * sub * 2.4 * scatter;
        nd.vy += (dy / d) * sub * 2.4 * scatter;
      }
      nd.vx *= 0.985;
      nd.vy *= 0.985;
      if (nd.x < -20) nd.x = p.width + 20;
      if (nd.x > p.width + 20) nd.x = -20;
      if (nd.y < -20) nd.y = p.height + 20;
      if (nd.y > p.height + 20) nd.y = -20;
    }

    // Links (fade with distance) + spawn beat pulses
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const c = nodes[j];
        const dx = a.x - c.x, dy = a.y - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < linkDist * linkDist) {
          const d = Math.sqrt(d2);
          const alpha = (1 - d / linkDist) * (50 + energy * 150);
          const hue = (hueOffset + (a.hue + c.hue) / 2) % 360;
          p.stroke(hue, 75, 90, alpha);
          p.strokeWeight(0.8);
          p.line(a.x, a.y, c.x, c.y);
          if (kicked && p.random() < 0.06) {
            pulses.push({ x1: a.x, y1: a.y, x2: c.x, y2: c.y, t: 0, hue });
          }
        }
      }
    }

    // Light pulses traveling along links
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pl = pulses[i];
      pl.t += 0.06 + energy * 0.1;
      if (pl.t >= 1) {
        pulses.splice(i, 1);
        continue;
      }
      const x = pl.x1 + (pl.x2 - pl.x1) * pl.t;
      const y = pl.y1 + (pl.y2 - pl.y1) * pl.t;
      glowCircle(p, x, y, 2.5, pl.hue, 50, 100, 1 - pl.t);
    }

    // Nodes with glow + depth
    for (const nd of nodes) {
      const hue = (hueOffset + nd.hue) % 360;
      const r = (1.5 + sub * 5) * nd.z;
      glowCircle(p, nd.x, nd.y, r, hue, 75, 95, 0.35 + nd.z * 0.4 + energy * 0.3);
    }

    // Shooting stars on highs
    if (high > 0.35 && p.random() < high * 0.1 && nodes.length > 1) {
      const a = nodes[Math.floor(p.random(nodes.length))];
      const c = nodes[Math.floor(p.random(nodes.length))];
      const tt = p.random();
      p.noStroke();
      p.fill(0, 0, 100, 240);
      p.circle(a.x + (c.x - a.x) * tt, a.y + (c.y - a.y) * tt, 2 + high * 3);
    }

    vignette(p, 0.5);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
