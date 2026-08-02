// Particle Storm — an additive particle system that explodes on every kick.
// A bass hit resets all particles outward with fresh hues; mid/high energy
// acts as wind and keeps the storm churning. Colors cycle through the rainbow.
export default (audio, videoDeviceId, params) => (p) => {
  const particles = [];
  let hueOffset = 0;
  let kick = 0; // 0..1 kick envelope
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

  // Grow the particle pool lazily so the Particle Count slider works live
  function ensureParticles(n) {
    while (particles.length < n) {
      particles.push({
        x: p.random(p.width),
        y: p.random(p.height),
        vx: p.random(-1, 1),
        vy: p.random(-1, 1),
        hue: p.random(360),
        size: p.random(2, 6),
        life: p.random(0.3, 1),
      });
    }
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    ensureParticles(params?.count ?? 320);
  };

  function burst(energy) {
    // Burst strength read live so the slider applies immediately
    const strength = params?.burst ?? 1;
    for (const pt of particles) {
      const angle = p.random(p.TWO_PI);
      const speed = p.random(2, 12) * (0.5 + energy * 2.5) * strength;
      pt.vx = p.cos(angle) * speed;
      pt.vy = p.sin(angle) * speed;
      pt.hue = p.random(360);
      pt.life = 1;
    }
  }

  p.draw = () => {
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 22);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const count = Math.floor(P.count ?? 320);
    const kickSensitivity = P.kick ?? 1;
    const windStrength = P.wind ?? 1;
    ensureParticles(count);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);
    hueOffset = (hueOffset + 0.5 + b.energy * 3) % 360;

    // Kick: rising edge of sub-bass triggers a full burst
    if (b.sub > 0.3 / kickSensitivity && b.sub > prevSub) {
      kick = 1;
      burst(b.sub);
    }
    prevSub = b.sub;
    kick = p.lerp(kick, 0, 0.08);

    const windX = (b.mid - 0.5) * 6 * windStrength;
    const windY = (b.high - 0.5) * 6 * windStrength;

    p.noStroke();
    for (let i = 0; i < count; i++) {
      const pt = particles[i];
      // Wind + mild attraction toward the center keeps the storm dense
      pt.vx += windX * 0.2 + (p.width / 2 - pt.x) * 0.002;
      pt.vy += windY * 0.2 + (p.height / 2 - pt.y) * 0.002;
      pt.vx *= 0.985;
      pt.vy *= 0.985;
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.life = p.max(0, pt.life - 0.004 - b.energy * 0.006);

      // Wrap around the edges
      if (pt.x < -20) pt.x = p.width + 20;
      if (pt.x > p.width + 20) pt.x = -20;
      if (pt.y < -20) pt.y = p.height + 20;
      if (pt.y > p.height + 20) pt.y = -20;

      const size = pt.size * (0.6 + kick * 2 + b.energy * 1.5);
      p.fill(pt.hue, 90, 100, pt.life * 220);
      p.circle(pt.x, pt.y, size);
    }

    // Central flash on kick
    if (kick > 0.05) {
      p.fill(hueOffset, 80, 100, kick * 60);
      p.circle(p.width / 2, p.height / 2, 300 * kick);
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
