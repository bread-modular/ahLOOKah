export default (audio, videoDeviceId, params) => (p) => {
  let rotation = 0;
  let groove = 0;
  let bgLines = [];
  let stars = [];
  const numBgLines = 150;
  const numStars = 100;

  // Webcam
  let capture;
  let isCaptureReady = false;
  let videoTexture;

  // Anatomy constants
  const TORSO_W = 60, TORSO_H = 80, TORSO_D = 30;
  const HEAD_SIZE = 25;
  const NECK_H = 15;
  const LIMB_W = 10;
  const THIGH_L = 65;
  const SHIN_L = 60;
  const FOOT_H = 10;
  const ARM_L = 50;

  // Screen dimensions
  const SCREEN_W = 700;
  const SCREEN_H = 525;

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

    // Create graphics buffer for grayscale processing
    videoTexture = p.createGraphics(640, 480);

    // Initialize webcam capture
    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    };

    capture = p.createCapture(constraints, () => {
      isCaptureReady = true;
    });
    capture.hide();
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

  function drawScreen(b, react, scan) {
    p.push();
    // Position TV on the left side
    p.translate(-350, -50, -100);

    // Screen bezel/frame
    p.push();
    p.noFill();
    p.stroke(80 + b.high * 100);
    p.strokeWeight(6 + b.sub * 4);
    p.box(SCREEN_W + 40, SCREEN_H + 40, 20);
    p.pop();

    if (!isCaptureReady || !capture.loadedmetadata) {
      // Draw placeholder screen
      p.fill(30);
      p.noStroke();
      p.box(SCREEN_W, SCREEN_H, 10);
      p.pop();
      return;
    }

    // Process video to grayscale
    videoTexture.push();
    videoTexture.image(capture, 0, 0, 640, 480);
    videoTexture.filter(p.GRAY);
    videoTexture.pop();

    // Draw the video texture on a plane
    p.push();
    p.translate(0, 0, 11); // Slightly in front of bezel
    p.noStroke();
    p.texture(videoTexture);
    p.plane(SCREEN_W, SCREEN_H);
    p.pop();

    // Scanline overlay effect
    if (b.mid * react > 0.2) {
      p.push();
      p.translate(0, 0, 12);
      p.stroke(0, 60);
      p.strokeWeight(1);
      const scanStep = Math.max(1, 4 / scan);
      for (let y = -SCREEN_H / 2; y < SCREEN_H / 2; y += scanStep) {
        p.line(-SCREEN_W / 2, y, SCREEN_W / 2, y);
      }
      p.pop();
    }

    p.pop();
  }

  function drawCharacter(b, noiseLevel) {
    // 2. CHARACTER HIERARCHY - positioned on the right
    p.push();
    p.translate(250, 0, 0); // Move character to the right side
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

    p.pop(); // head
    p.pop(); // torso box

    // Arms (inside torso rotation context)
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

    p.pop(); // torso rotation context

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
    p.pop(); // character root
  }

  p.draw = () => {
    p.background(0);
    if (!audio || !audio.isStarted) {
      // Show prompt
      p.push();
      p.fill(255);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(16);
      p.text("CLICK TO START AUDIO", 0, 0);
      p.pop();
      return;
    }

    const freqs = audio.getFrequencies();
    if (!freqs) return;

    const b = analyzeBands(freqs.left);  // Ch 1
    const b2 = analyzeBands(freqs.right); // Ch 2
    const noiseLevel = (b2.mid + b2.high) * 0.5;

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const grooveSpeed = P.groove ?? 1;
    const scan = P.scan ?? 1;
    const react = P.react ?? 1;

    // Animation Timings
    groove += (0.1 + b.mid * 0.2) * grooveSpeed;
    rotation += (0.005 + noiseLevel * 0.1) * react;

    // Camera Context
    p.push();
    p.translate(0, 0, -400);
    p.rotateX(-0.1);
    p.rotateY(p.sin(p.frameCount * 0.01) * 0.15 + noiseLevel * 0.1);

    // Lighting
    p.ambientLight(30);
    p.pointLight(255, 255, 255, 0, -300, 300);
    p.pointLight(150, 150, 200, -400, 0, 200);

    // 1. DYNAMIC BACKGROUND
    p.push();
    p.stroke(255, 40 + b.high * 80);
    p.strokeWeight(0.5 + b.high * 1.5);
    bgLines.forEach((line, i) => {
      const activeNum = p.map(b.mid + b.sub, 0, 1, numBgLines * 0.3, numBgLines);
      if (i < activeNum) {
        line.z += line.speed + b.sub * 100 + noiseLevel * 50;
        if (line.z > 500) line.z = -3000;
        p.push();
        p.translate(line.x, line.y, line.z);
        const l = 30 + b.high * 400;
        p.line(0, 0, 0, 0, 0, l);
        p.pop();
      }
    });
    p.pop();

    p.push();
    p.noStroke();
    p.fill(255, 100);
    stars.forEach(s => {
      s.z += 1 + b.sub * 8;
      if (s.z > 500) s.z = -1500;
      p.push();
      p.translate(s.x, s.y, s.z);
      p.sphere(s.size, 4, 4);
      p.pop();
    });
    p.pop();

    // Draw TV screen on left
    drawScreen(b, react, scan);

    // Draw character on right
    drawCharacter(b, noiseLevel);

    p.pop(); // context
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
