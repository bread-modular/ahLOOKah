export default (audio) => (p) => {
  let rotation = 0;
  let lines = [];
  const numLines = 40;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    for (let i = 0; i < numLines; i++) {
      lines.push({
        z: p.map(i, 0, numLines, -2000, 500),
        x: p.random(-500, 500),
        y: p.random(-500, 500)
      });
    }
  };

  function analyzeBands(freqs) {
    if (!freqs) return { sub: 0, low: 0, mid: 0, high: 0 };
    let sub = 0, low = 0, mid = 0, high = 0;
    for (let i = 0; i < 3; i++) sub += freqs[i];
    for (let i = 3; i < 40; i++) low += freqs[i];
    for (let i = 40; i < 150; i++) mid += freqs[i];
    for (let i = 150; i < 500; i++) high += freqs[i];

    return {
      sub: (sub / 3) / 255,
      low: (low / 37) / 255,
      mid: (mid / 110) / 255,
      high: (high / 350) / 255
    };
  }

  p.draw = () => {
    p.background(0);

    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const b1 = analyzeBands(freqs.left);  // Ch 1
    const b2 = analyzeBands(freqs.right); // Ch 2

    // Ch 2 Noise drives rotation speed and jitter
    const noiseEnv = (b2.mid + b2.high) * 0.5;
    rotation += 0.005 + noiseEnv * 0.2;

    p.rotateX(rotation * 0.5);
    p.rotateY(rotation);

    // Sub-bass Kick pulse
    const kickScale = 1 + b1.sub * 1.5;

    // 1. Central Core Geometry (Kick/Bass)
    p.push();
    p.noFill();
    p.stroke(255, 200 + b1.sub * 55);
    p.strokeWeight(1 + b1.sub * 5);

    // Core shape changes as synth energy (Mid) increases
    if (b1.mid > 0.5) {
      p.box(200 * kickScale);
    } else {
      p.sphere(150 * kickScale, 12, 12);
    }
    p.pop();

    // 2. Wireframe Grid "Slices" (Mid frequencies)
    p.push();
    p.noFill();
    p.stroke(255, 50 + b1.mid * 200);
    p.strokeWeight(1);

    const gridRes = 8;
    const gridSize = 800 * (1 + b1.sub * 0.2);

    for (let i = 0; i < 3; i++) {
      p.push();
      p.rotateZ(p.frameCount * 0.01 * (i + 1));
      p.plane(gridSize, gridSize, gridRes, gridRes);
      p.pop();
    }
    p.pop();

    // 3. Digital "Rain" / Perspective lines (High frequencies)
    p.push();
    p.stroke(255, 150);
    p.strokeWeight(p.map(b1.high, 0, 0.5, 1, 3));

    lines.forEach(line => {
      // Move towards camera
      line.z += 10 + b1.sub * 100 + noiseEnv * 50;
      if (line.z > 500) line.z = -2000;

      p.push();
      p.translate(line.x, line.y, line.z);
      // High end energy makes lines longer
      const l = 50 + b1.high * 500;
      p.line(0, 0, 0, 0, 0, l);
      p.pop();
    });
    p.pop();

    // 4. Glitch artifacts from Channel 2
    if (noiseEnv > 0.25) {
      p.push();
      p.stroke(255);
      p.strokeWeight(1);
      for (let i = 0; i < 3; i++) {
        p.rotateZ(p.random(p.TWO_PI));
        p.line(-1000, p.random(-500, 500), 1000, p.random(-500, 500));
      }
      p.pop();
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
