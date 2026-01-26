export default (audio) => (p) => {
  let circles = [];
  let hats = []; // Very small circles for Channel 1 high-end

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    // Initial main circles
    for (let i = 0; i < 20; i++) {
      circles.push(createCircle());
    }
  };

  function createCircle() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      baseSize: p.random(40, 150),
      speedX: p.random(-0.5, 0.5),
      speedY: p.random(-0.5, -2),
      brightness: p.random(150, 255),
    };
  }

  function createHat() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      size: p.random(3, 12), // 3x increase
      speedX: p.random(-1, 1),
      speedY: p.random(-10, -4),
      life: 255
    };
  }

  // Analyzes frequency data to get Techno-relevant bands
  function analyzeBands(freqs) {
    if (!freqs) return { sub: 0, low: 0, mid: 0, high: 0 };

    let sub = 0, low = 0, mid = 0, high = 0;
    // Targeting < 60Hz: approximately first 3 bins
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

    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    const amps = audio.getAmplitudes();
    if (!freqs) return;

    const bands1 = analyzeBands(freqs.left);  // Ch 1
    const bands2 = analyzeBands(freqs.right); // Ch 2

    // Ch 2 Glitch Effect (Noise sweep)
    const noiseIntensity = (bands2.mid + bands2.high) * 0.5;
    const glitchAmount = p.map(noiseIntensity, 0, 0.4, 0, 40);

    p.push();
    if (glitchAmount > 2) {
      p.translate(p.random(-glitchAmount, glitchAmount), p.random(-glitchAmount, glitchAmount));
      if (p.random() < noiseIntensity * 0.1) {
        p.filter(p.INVERT);
      }
    }

    // High end Ch 1: Spawn tiny circles (hats)
    if (bands1.high > 0.2) {
      const spawnCount = Math.floor(p.map(bands1.high, 0.2, 0.6, 1, 6));
      for (let i = 0; i < spawnCount; i++) {
        hats.push(createHat());
      }
    }

    // Draw Main Circles
    circles.forEach(c => {
      // Use SUB (<60Hz) for pumping
      const pump = 1 + bands1.sub * 2.5;
      const currentSize = c.baseSize * pump;

      const midBrightness = p.map(bands1.mid, 0, 0.5, 0, 180);
      if (midBrightness > 20) {
        p.fill(255, midBrightness);
      } else {
        p.noFill();
      }

      p.strokeWeight(p.map(bands1.sub, 0, 0.5, 1, 12));
      p.stroke(255, p.map(c.brightness, 150, 255, 180, 255));
      p.circle(c.x, c.y, currentSize);

      c.x += c.speedX * (1 + bands1.sub * 12);
      c.y += c.speedY * (1 + bands1.sub * 12);

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
      p.circle(h.x, h.y, h.size);

      h.x += h.speedX;
      h.y += h.speedY;
      h.life -= 8; // Faster fade for sharp hats

      if (h.life <= 0 || h.y < -20) {
        hats.splice(i, 1);
      }
    }
    p.pop();

    if (noiseIntensity > 0.2) {
      p.stroke(255, 50);
      p.strokeWeight(1);
      for (let i = 0; i < 3; i++) {
        let ly = p.random(p.height);
        p.line(0, ly, p.width, ly);
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
