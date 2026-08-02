export default (audio, videoDeviceId, params) => (p) => {
  let circles = [];
  let hats = [];

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    for (let i = 0; i < 20; i++) {
      circles.push(createCircle());
    }
  };

  function createCircle() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      baseSize: p.random(20, 80),
      speedX: p.random(-0.5, 0.5),
      speedY: p.random(-0.5, -2),
      brightness: p.random(150, 255),
    };
  }

  function createHat() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      size: p.random(3, 12),
      speedX: p.random(-1, 1),
      speedY: p.random(-10, -4),
      life: 255
    };
  }

  function analyzeBands(freqs) {
    if (!freqs) return { sub: 0, low: 0, mid: 0, high: 0 };
    let sub = 0, low = 0, mid = 0, high = 0;
    for (let i = 0; i < 3; i++) sub += freqs[i];
    for (let i = 3; i < 15; i++) low += freqs[i];
    for (let i = 15; i < 100; i++) mid += freqs[i];
    for (let i = 100; i < 500; i++) high += freqs[i];

    return {
      sub: (sub / 3) / 255,
      low: (low / 12) / 255,
      mid: (mid / 85) / 255,
      high: (high / 400) / 255
    };
  }

  p.draw = () => {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const bass = P.bass ?? 1;
    const mid = P.mid ?? 1;
    const high = P.high ?? 1;
    const glitch = P.glitch ?? 1;

    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const bands1 = analyzeBands(freqs.left);  // Ch 1
    const bands2 = analyzeBands(freqs.right); // Ch 2

    const noiseIntensity = (bands2.mid + bands2.high) * 0.5;
    const glitchAmount = p.map(noiseIntensity, 0, 0.5, 0, 60) * glitch;

    p.push();
    // Global glitch translation
    if (glitchAmount > 5) {
      p.translate(p.random(-glitchAmount, glitchAmount), p.random(-glitchAmount, glitchAmount));

      // Random inverted flashes
      if (p.random() < noiseIntensity * 0.15) {
        p.filter(p.INVERT);
      }

      // Random background brightness sparks
      if (p.random() < noiseIntensity * 0.2) {
        p.background(p.random(50, 100));
      }
    }

    // Spawn tiny circles (hats)
    if (bands1.high * high > 0.15) {
      const spawnCount = Math.floor(p.map(bands1.high * high, 0.15, 0.6, 1, 8));
      for (let i = 0; i < spawnCount; i++) {
        hats.push(createHat());
      }
    }

    // Draw Main Circles
    circles.forEach(c => {
      const pump = 1 + bands1.sub * 2.5 * bass;
      const currentSize = c.baseSize * pump;

      const midBrightness = p.map(bands1.mid * mid, 0, 0.5, 0, 180);
      if (midBrightness > 20) {
        p.fill(255, midBrightness);
      } else {
        p.noFill();
      }

      p.strokeWeight(p.map(bands1.sub * bass, 0, 0.5, 1, 12));

      // Jitter circles based on Ch 2 noise
      const jx = p.random(-glitchAmount / 2, glitchAmount / 2);
      const jy = p.random(-glitchAmount / 2, glitchAmount / 2);

      p.stroke(255, p.map(c.brightness, 150, 255, 180, 255));
      p.circle(c.x + jx, c.y + jy, currentSize);

      c.x += c.speedX * (1 + bands1.sub * 12 * bass);
      c.y += c.speedY * (1 + bands1.sub * 12 * bass);

      if (c.y < -currentSize) c.y = p.height + currentSize;
      if (c.x < -currentSize) c.x = p.width + currentSize;
      if (c.x > p.width + currentSize) c.x = -currentSize;
      if (c.y > p.height + currentSize) c.y = -currentSize;
    });

    // Draw Small Circles (Hats)
    p.noStroke();
    for (let i = hats.length - 1; i >= 0; i--) {
      const h = hats[i];
      p.fill(255, h.life);

      const hjx = p.random(-glitchAmount, glitchAmount);
      const hjy = p.random(-glitchAmount, glitchAmount);

      p.circle(h.x + hjx, h.y + hjy, h.size);

      h.x += h.speedX;
      h.y += h.speedY;
      h.life -= 8;

      if (h.life <= 0 || h.y < -20) {
        hats.splice(i, 1);
      }
    }
    p.pop();

    // Noise sweep scanlines and slices
    if (noiseIntensity > 0.15) {
      // Scanlines
      p.stroke(255, p.map(noiseIntensity, 0.15, 0.5, 20, 100));
      p.strokeWeight(1);
      for (let i = 0; i < 5; i++) {
        let ly = p.random(p.height);
        p.line(0, ly, p.width, ly);
      }

      // Random screen slices (copying areas)
      if (noiseIntensity > 0.3 && p.frameCount % 2 === 0) {
        let sy = p.random(p.height);
        let sh = p.random(10, 50);
        let sx = p.random(-glitchAmount * 2, glitchAmount * 2);
        p.copy(0, sy, p.width, sh, sx, sy, p.width, sh);
      }
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
