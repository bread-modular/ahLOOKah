export default (audio) => (p) => {
  let rotation = 0;
  let groove = 0;
  let bgLines = [];
  let stars = [];
  const numBgLines = 150;
  const numStars = 100;

  // Anatomy constants
  const TORSO_W = 60, TORSO_H = 80, TORSO_D = 30;
  const HEAD_SIZE = 25;
  const NECK_H = 15;
  const LIMB_W = 10;
  const THIGH_L = 65;
  const SHIN_L = 60;
  const FOOT_H = 10;
  const ARM_L = 50;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

    // Initialize background digital rain
    for (let i = 0; i < numBgLines; i++) {
      bgLines.push({
        x: p.random(-1000, 1000),
        y: p.random(-800, 800),
        z: p.random(-3000, 500),
        speed: p.random(2, 12)
      });
    }

    // Initialize floating "dust" particles
    for (let i = 0; i < numStars; i++) {
      stars.push({
        x: p.random(-800, 800),
        y: p.random(-800, 800),
        z: p.random(-1500, 0),
        size: p.random(1, 3)
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

  function drawBox(w, h, d) {
    p.push();
    p.translate(0, h / 2, 0);
    p.box(w, h, d);
    p.pop();
  }

  p.draw = () => {
    p.background(0);
    if (!audio || !audio.isStarted) return;

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const b = analyzeBands(freqs.left);  // Ch 1
    const b2 = analyzeBands(freqs.right); // Ch 2
    const noiseLevel = (b2.mid + b2.high) * 0.5;

    // Animation Timings
    groove += 0.1 + b.mid * 0.2;
    rotation += 0.005 + noiseLevel * 0.1;

    // Camera Context - Centered on screen with tilt
    p.push();
    p.translate(0, 0, -200);
    p.rotateX(-0.15); // Maintain look-down tilt
    p.rotateY(p.sin(p.frameCount * 0.015) * 0.4 + noiseLevel * 0.2);

    // Lighting
    p.ambientLight(20);
    p.pointLight(255, 255, 255, 0, -300, 300);

    // 1. DYNAMIC BACKGROUND
    p.push();
    p.stroke(255, 60 + b.high * 100);
    p.strokeWeight(0.5 + b.high * 2);
    bgLines.forEach((line, i) => {
      const activeNum = p.map(b.mid + b.sub, 0, 1, numBgLines * 0.3, numBgLines);
      if (i < activeNum) {
        line.z += line.speed + b.sub * 150 + noiseLevel * 80;
        if (line.z > 500) line.z = -3000;
        p.push();
        p.translate(line.x, line.y, line.z);
        const l = 40 + b.high * 600;
        p.line(0, 0, 0, 0, 0, l);
        p.pop();
      }
    });
    p.pop();

    p.push();
    p.noStroke();
    p.fill(255, 120);
    stars.forEach(s => {
      s.z += 1 + b.sub * 10;
      if (s.z > 500) s.z = -1500;
      p.push();
      p.translate(s.x, s.y, s.z);
      p.sphere(s.size, 4, 4);
      p.pop();
    });
    p.pop();

    // 2. CHARACTER HIERARCHY
    p.push();
    p.scale(2.2);
    p.noFill();
    p.stroke(255);
    p.strokeWeight((1.2 + b.sub * 2.0) / 2.2);

    const bounce = b.sub * 30;
    p.translate(0, bounce, 0);
    p.box(50, 20, 30); // Pelvis

    p.push();
    p.translate(0, -10, 0);
    p.rotateX(p.sin(groove) * 0.15);
    p.rotateZ(p.cos(groove * 0.5) * 0.05);

    p.push();
    p.translate(0, -TORSO_H, 0);
    drawBox(TORSO_W, TORSO_H, TORSO_D);

    // Neck & Pyramid Head
    p.push();
    p.translate(0, -NECK_H / 2, 0);
    p.box(10, NECK_H, 10);

    p.translate(0, -NECK_H / 2 - HEAD_SIZE, 0);
    p.rotateX(p.sin(groove * 2) * 0.2 + b.sub * 0.2);

    p.push();
    p.rotateX(p.PI); // Tip up
    p.cone(HEAD_SIZE * 1.4, HEAD_SIZE * 2.2, 4);
    p.pop();

    // Eye Slit
    p.push();
    p.translate(0, 0, HEAD_SIZE * 0.5);
    if (b.mid > 0.45 || b.high > 0.45) {
      p.fill(255);
    }
    p.box(HEAD_SIZE * 1.0, 5, 8);
    p.pop();

    p.pop();
    p.pop();

    // Arms
    const upperArmRotation = p.PI / 8 + p.sin(groove * 0.8) * 0.2;
    const forearmRotation = p.PI / 3 + b.mid * p.PI / 2;

    p.push();
    p.translate(-TORSO_W / 2 - 2, -TORSO_H + 10, 0);
    p.rotateZ(upperArmRotation + b.mid * 0.5);
    p.rotateX(p.sin(groove * 0.5) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2);
    p.translate(0, ARM_L, 0);
    p.rotateX(-forearmRotation);
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3);
    p.translate(0, ARM_L, 0);
    p.box(12, 12, 12);
    p.pop();

    p.push();
    p.translate(TORSO_W / 2 + 2, -TORSO_H + 10, 0);
    p.rotateZ(-upperArmRotation - b.mid * 0.5);
    p.rotateX(p.sin(groove * 0.5 + p.PI) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2);
    p.translate(0, ARM_L, 0);
    p.rotateX(-forearmRotation);
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3);
    p.translate(0, ARM_L, 0);
    p.box(12, 12, 12);
    p.pop();

    p.pop(); // torso chain

    // Legs
    p.push();
    p.translate(-15, 10, 0);
    const lStep = p.sin(groove) * 0.4;
    p.rotateX(lStep + b.sub * 0.2);
    drawBox(LIMB_W, THIGH_L, LIMB_W);
    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -lStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);
    p.translate(0, SHIN_L, 5); // Shift feet slightly forward (Z+)
    p.box(15, FOOT_H, 30);
    p.pop();

    p.push();
    p.translate(15, 10, 0);
    const rStep = p.sin(groove + p.PI) * 0.4;
    p.rotateX(rStep + b.sub * 0.2);
    drawBox(LIMB_W, THIGH_L, LIMB_W);
    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -rStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);
    p.translate(0, SHIN_L, 5); // Shift feet slightly forward (Z+)
    p.box(15, FOOT_H, 30);
    p.pop();

    p.pop(); // hierarchy
    p.pop(); // context
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
