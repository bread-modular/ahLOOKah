// Pulse Rings — neon concentric rings that erupt on every bass kick.
// Rings expand with the audio envelope, each with its own hue; a glowing
// core pulses with sub-bass. Trails fade via translucent black fills.
export default (audio) => (p) => {
  const MAX_RINGS = 40;
  const rings = [];
  let hueOffset = 0;
  let lastKick = 0;
  let prevSub = 0;

  function subBand(freqs) {
    if (!freqs) return 0;
    let sub = 0;
    for (let i = 0; i < 4; i++) sub += freqs[i];
    return sub / (4 * 255);
  }

  function kickDetected(sub, now) {
    // Rising edge on the sub-bass with a cooldown = kick detection
    if (sub > 0.35 && sub > prevSub && now - lastKick > 90) {
      lastKick = now;
      return true;
    }
    return false;
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.angleMode(p.RADIANS);
  };

  p.draw = () => {
    // Trail fade (BLEND mode so black actually dims the additive glow)
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 26);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const sub = subBand(freqs ? freqs.left : null);
    const now = p.millis();

    if (kickDetected(sub, now)) {
      rings.push({
        r: 10,
        speed: 6 + p.random(0, 6),
        hue: (hueOffset + p.random(-30, 30) + 360) % 360,
        life: 1,
      });
      if (rings.length > MAX_RINGS) rings.shift();
    }
    prevSub = sub;

    hueOffset = (hueOffset + 0.4 + sub * 2) % 360;

    // Core pulse
    const coreR = p.map(sub, 0, 1, 60, 260) + 40 * p.sin(p.frameCount * 0.15);
    p.noStroke();
    p.fill(hueOffset, 90, 100, 90);
    p.circle(p.width / 2, p.height / 2, coreR * 2);
    p.fill((hueOffset + 40) % 360, 90, 100, 140);
    p.circle(p.width / 2, p.height / 2, coreR * 0.6);

    // Expanding rings
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.r += ring.speed * (0.6 + sub * 2);
      ring.life -= 0.008;

      if (ring.life <= 0) {
        rings.splice(i, 1);
        continue;
      }

      p.noFill();
      p.strokeWeight(2 + ring.life * 6);
      p.stroke(ring.hue, 85, 100, ring.life * 220);
      p.circle(p.width / 2, p.height / 2, ring.r * 2);

      // Secondary echo ring
      p.strokeWeight(1);
      p.stroke(ring.hue, 70, 100, ring.life * 90);
      p.circle(p.width / 2, p.height / 2, ring.r * 1.3 * 2);
    }

    // Idle shimmer when there is no signal yet
    if (!audio || !audio.isStarted) {
      rings.push({
        r: 10,
        speed: 2.5,
        hue: (hueOffset + p.random(-40, 40) + 360) % 360,
        life: 0.6,
      });
      if (rings.length > MAX_RINGS) rings.shift();
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
