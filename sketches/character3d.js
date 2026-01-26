export default (audio) => (p) => {
  let rotation = 0;
  let groove = 0;
  let bgLines = [];
  const numBgLines = 50;

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

    // Initialize background digital rain/lines
    for (let i = 0; i < numBgLines; i++) {
      bgLines.push({
        x: p.random(-800, 800),
        y: p.random(-600, 600),
        z: p.random(-2000, 500),
        speed: p.random(5, 15)
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

    // Camera Context
    p.push();
    p.translate(0, -50, 0);
    p.rotateY(rotation);

    // Minimal Techno Lighting
    p.ambientLight(20);
    p.pointLight(255, 255, 255, 200, -200, 200);
    p.pointLight(100, 100, 100, -200, 200, 200);

    // 1. BACKGROUND DYNAMIC ELEMENTS
    p.push();
    p.stroke(255, 60); // Dimmer, thinner background
    p.strokeWeight(0.5 + b.high);
    bgLines.forEach(line => {
      // Move towards camera, speed boosts with sub-bass and noise
      line.z += line.speed + b.sub * 100 + noiseLevel * 40;
      if (line.z > 500) line.z = -2000;

      p.push();
      p.translate(line.x, line.y, line.z);
      // Length reacts to high end
      const l = 40 + b.high * 400;
      p.line(0, 0, 0, 0, 0, l);
      p.pop();
    });
    p.pop();

    // Glitch artifacts from Channel 2
    if (noiseLevel > 0.35) {
      p.push();
      p.stroke(255, 150);
      p.strokeWeight(1);
      for (let i = 0; i < 4; i++) {
        p.rotateZ(p.random(p.TWO_PI));
        p.line(-1000, p.random(-500, 500), 1000, p.random(-500, 500));
      }
      p.pop();
    }

    // 2. CHARACTER HIERARCHY
    p.push();
    p.scale(1.6); // Make the person bigger
    p.noFill();
    p.stroke(255);
    p.strokeWeight((1.2 + b.sub * 2.0) / 1.6); // Twice the previous width + sub-bass pulse

    // Core (Pelvis) - Bounces on sub-bass
    const bounce = b.sub * 30;
    p.translate(0, bounce, 0);

    // PELVIS BOX
    p.box(50, 20, 30);

    // TORSO & UPPER BODY
    p.push();
    p.translate(0, -10, 0);
    p.rotateX(p.sin(groove) * 0.15);
    p.rotateZ(p.cos(groove * 0.5) * 0.05);

    p.push();
    p.translate(0, -TORSO_H, 0);
    drawBox(TORSO_W, TORSO_H, TORSO_D);

    // NECK
    p.translate(0, -NECK_H, 0);
    p.box(10, NECK_H, 10);

    // HEAD
    p.translate(0, -HEAD_SIZE, 0);
    p.rotateX(p.sin(groove * 2) * 0.2 + b.sub * 0.2);
    p.sphere(HEAD_SIZE, 8, 8);
    p.pop();

    // ARMS
    const upperArmRotation = p.PI / 8 + p.sin(groove * 0.8) * 0.2;
    const forearmRotation = p.PI / 3 + b.mid * p.PI / 2;

    // Left Arm
    p.push();
    p.translate(-TORSO_W / 2 - 2, -TORSO_H + 10, 0); // Shoulder joint
    p.rotateZ(upperArmRotation + b.mid * 0.5);
    p.rotateX(p.sin(groove * 0.5) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2); // Upper arm

    p.translate(0, ARM_L, 0); // Move to elbow
    p.rotateX(-forearmRotation); // Bend elbow forward
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3); // Forearm

    p.translate(0, ARM_L, 0); // Move to hand
    p.box(12, 12, 12); // Hand
    p.pop();

    // Right Arm
    p.push();
    p.translate(TORSO_W / 2 + 2, -TORSO_H + 10, 0); // Shoulder joint
    p.rotateZ(-upperArmRotation - b.mid * 0.5);
    p.rotateX(p.sin(groove * 0.5 + p.PI) * 0.2);
    drawBox(LIMB_W - 2, ARM_L, LIMB_W - 2); // Upper arm

    p.translate(0, ARM_L, 0); // Move to elbow
    p.rotateX(-forearmRotation); // Bend elbow forward
    drawBox(LIMB_W - 3, ARM_L, LIMB_W - 3); // Forearm

    p.translate(0, ARM_L, 0); // Move to hand
    p.box(12, 12, 12); // Hand
    p.pop();

    p.pop(); // End Upper Body

    // LEGS
    // Left Leg
    p.push();
    p.translate(-15, 10, 0);
    const lStep = p.sin(groove) * 0.4;
    p.rotateX(lStep + b.sub * 0.2);
    drawBox(LIMB_W, THIGH_L, LIMB_W);

    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -lStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);

    p.translate(0, SHIN_L, 0);
    p.box(15, FOOT_H, 25);
    p.pop();

    // Right Leg
    p.push();
    p.translate(15, 10, 0);
    const rStep = p.sin(groove + p.PI) * 0.4;
    p.rotateX(rStep + b.sub * 0.2);
    drawBox(LIMB_W, THIGH_L, LIMB_W);

    p.translate(0, THIGH_L, 0);
    p.rotateX(p.min(0, -rStep * 2));
    drawBox(LIMB_W, SHIN_L, LIMB_W);

    p.translate(0, SHIN_L, 0);
    p.box(15, FOOT_H, 25);
    p.pop();

    p.pop(); // End Hierarchy
    p.pop(); // End Camera Context
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
