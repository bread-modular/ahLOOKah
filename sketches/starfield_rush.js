// Starfield Rush — a warp-speed starfield tunnel.
// Sub-bass boosts warp speed, mid energy drifts the hue, and loud highs
// spark bright flashes around the vanishing point.
export default (audio, videoDeviceId, params) => (p) => {
  let stars = [];
  let hueOffset = 0;

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

  function makeStar() {
    return {
      x: p.random(-p.width, p.width),
      y: p.random(-p.height, p.height),
      z: p.random(0, p.width),
      size: p.random(1, 3.5),
    };
  }

  // Grow/shrink the pool lazily so the Star Count slider works live
  function ensureStars(n) {
    while (stars.length < n) stars.push(makeStar());
    if (stars.length > n) stars.length = n;
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    ensureStars(params?.count ?? 240);
  };

  p.draw = () => {
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const count = Math.floor(P.count ?? 240);
    const warp = P.warp ?? 1;
    const hueDrift = P.hue ?? 1;
    const sparkle = P.sparkle ?? 1;
    ensureStars(count);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);
    hueOffset = (hueOffset + (0.2 + b.energy * 2) * hueDrift) % 360;

    const speed = (2 + b.sub * 18) * warp;
    const cx = p.width / 2;
    const cy = p.height / 2;

    for (const s of stars) {
      s.z -= speed;
      if (s.z <= 0) {
        Object.assign(s, makeStar());
        s.z = p.width;
      }

      const scale = p.map(s.z, 0, p.width, 1, 0.02);
      const sx = cx + (s.x - cx) * scale;
      const sy = cy + (s.y - cy) * scale;
      const brightness = p.map(s.z, p.width, 0, 40, 255) + b.high * 120 * sparkle;
      const hue = (hueOffset + s.z * 0.2) % 360;

      // Long streak lines sell the warp speed on loud bass
      const streaking = speed > 6;
      if (streaking) {
        const prevScale = p.map(s.z + speed, 0, p.width, 1, 0.02);
        const px = cx + (s.x - cx) * prevScale;
        const py = cy + (s.y - cy) * prevScale;
        p.stroke(hue, 90, 100, p.min(255, brightness));
        p.strokeWeight(p.max(0.5, s.size * scale * 2.2));
        p.line(px, py, sx, sy);
      } else {
        p.noStroke();
        p.fill(hue, 90, 100, p.min(255, brightness));
        p.circle(sx, sy, p.max(0.6, s.size * scale * 2));
      }
    }

    // Center flash + random sparkles on loud highs
    if (b.high > 0.45 && sparkle > 0.05) {
      p.noStroke();
      p.fill(hueOffset, 80, 100, (b.high - 0.45) * 180);
      p.circle(cx, cy, 420 * (b.high - 0.45) * sparkle);
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
