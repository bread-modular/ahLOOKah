// Echo Ripples — concentric water-like rings radiating from the center.
// A bass kick spawns a fresh ripple; sub thickens the rings, mid energy
// shifts the color, and loud highs sprinkle bright sparkles on the rings.
export default (audio, videoDeviceId, params) => (p) => {
  const ripples = [];
  let prevSub = 0;

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

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.angleMode(p.RADIANS);
  };

  p.draw = () => {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const speed = P.speed ?? 1;
    const maxRipples = Math.floor(P.ripples ?? 20);
    const thickness = P.thick ?? 1;
    const sparkle = P.sparkle ?? 1;

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);
    const hueOffset = (p.frameCount * 0.5 + b.energy * 220) % 360;

    // Spawn a new ripple on a rising bass kick
    if (b.sub > 0.3 && b.sub > prevSub && ripples.length < maxRipples) {
      ripples.push({ r: 0, hue: (hueOffset + p.random(90)) % 360, energy: b.sub });
    }
    prevSub = b.sub;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.dist(0, 0, cx, cy);

    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += (1.4 + rp.energy * 3.5) * speed;

      // Each ripple draws itself as a trio of echoes
      const echoes = [
        [1.0, 1.0],
        [0.66, 0.55],
        [0.33, 0.28],
      ];
      for (const [mult, aMul] of echoes) {
        const rr = rp.r * mult;
        const t = rr / maxR;
        if (t > 1.02) continue;

        const alpha = 170 * (1 - t) * aMul;
        const width = p.map(t, 0, 1, 2, 30) * (1 + b.sub * 1.3) * thickness;
        p.stroke(rp.hue + mult * 45, 90, 100, alpha);
        p.strokeWeight(p.max(1, width));
        p.noFill();
        p.circle(cx, cy, rr * 2);

        // High-frequency sparkles sprinkled along the leading edge
        if (sparkle > 0.05 && b.high > 0.25 && p.random() < b.high * 0.35 * sparkle) {
          const ang = p.random(p.TWO_PI);
          const sx = cx + Math.cos(ang) * rr;
          const sy = cy + Math.sin(ang) * rr;
          p.noStroke();
          p.fill(rp.hue, 70, 100, alpha);
          p.circle(sx, sy, p.random(2, 7));
        }
      }

      if (rp.r > maxR * 1.02) ripples.splice(i, 1);
    }

    // Center glow pulsing with the bass
    p.noStroke();
    p.fill(hueOffset, 80, 100, 40 + b.sub * 140);
    p.circle(cx, cy, 60 + b.sub * 260);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
