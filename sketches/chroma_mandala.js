// Chroma Mandala — a 12-fold kaleidoscope mandala in full color.
// Mid energy blooms the petals outward, high energy spins the mandala and
// triggers glitch flashes, sub-bass pulses a spectral ring of dots around it.
export default (audio, videoDeviceId, params) => (p) => {
  let hueOffset = 0;
  let rotation = 0;

  function bands(freqs) {
    if (!freqs) return { sub: 0, mid: 0, high: 0, energy: 0 };
    let sub = 0, mid = 0, high = 0;
    for (let i = 0; i < 4; i++) sub += freqs[i];
    for (let i = 40; i < 150; i++) mid += freqs[i];
    for (let i = 150; i < 500; i++) high += freqs[i];
    sub = sub / (4 * 255);
    mid = mid / (110 * 255);
    high = high / (350 * 255);
    return { sub, mid, high, energy: (sub + mid + high) / 3 };
  }

  // Teardrop petal built from plain vertex() points (p5 v2 removed curveVertex).
  // t goes -1..1; radius = r1 at the edges, r2 at the outward tip.
  function drawPetal(cx, cy, baseAngle, r1, r2, spread) {
    p.beginShape();
    for (let t = -1; t <= 1.0001; t += 0.1) {
      const ang = baseAngle + t * spread;
      const rr = r1 + (r2 - r1) * Math.cos((t * Math.PI) / 2);
      p.vertex(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr);
    }
    p.endShape(p.CLOSE);
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.angleMode(p.RADIANS);
  };

  p.draw = () => {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const PETALS = P.petals ?? 12;
    const spinSpeed = P.spin ?? 1;
    const midBloom = P.bloom ?? 1;
    const subRing = P.sub ?? 1;

    hueOffset = (hueOffset + 0.35 + b.energy * 2) % 360;
    rotation += (0.002 + b.high * 0.06) * spinSpeed;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.min(p.width, p.height) * 0.48;
    const R1 = maxR * (0.3 + b.mid * 0.7 * midBloom);
    const R2 = maxR * (0.5 + b.mid * 0.5 * midBloom);

    p.noStroke();
    for (let k = 0; k < PETALS; k++) {
      const baseAngle = (k / PETALS) * p.TWO_PI + rotation;
      const hue = (hueOffset + k * (360 / PETALS)) % 360;

      // Outer petal (teardrop from inner ring out to tip)
      p.fill(hue, 85, 100, 180);
      drawPetal(cx, cy, baseAngle, R1, R2, 0.25);

      // Inner petal, offset half-step, brighter
      p.fill((hue + 60) % 360, 90, 100, 190);
      drawPetal(cx, cy, baseAngle + p.PI / PETALS, R1 * 0.45, R1 * 0.95, 0.32);
    }

    // Center glow, breathing with sub-bass
    const coreR = maxR * (0.08 + b.sub * 0.18 * subRing);
    p.fill(hueOffset, 100, 100, 200);
    p.circle(cx, cy, coreR * 2);
    p.fill((hueOffset + 120) % 360, 100, 100, 120);
    p.circle(cx, cy, coreR * 0.5);

    // Spectral ring of dots around the mandala (frequency map)
    const DOTS = 64;
    const ringR = maxR * (0.55 + b.sub * 0.15 * subRing);
    if (freqs) {
      for (let d = 0; d < DOTS; d++) {
        const idx = Math.floor(p.map(d, 0, DOTS, 0, 600));
        const v = freqs.left[idx] / 255;
        const a = (d / DOTS) * p.TWO_PI - rotation * 0.5;
        const rr = ringR + v * maxR * 0.35;
        const hue = (hueOffset + d * 5.6) % 360;
        p.fill(hue, 90, 100, 140 + v * 100);
        p.circle(cx + p.cos(a) * rr, cy + p.sin(a) * rr, 3 + v * 8);
      }
    }

    // Glitch flashes on loud high frequencies
    if (b.high > 0.5) {
      p.stroke((hueOffset + p.random(200)) % 360, 90, 100, 160);
      p.strokeWeight(1.5);
      for (let i = 0; i < 5; i++) {
        const y = p.random(p.height);
        p.line(0, y, p.width, y + p.random(-40, 40));
      }
      p.noStroke();
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
