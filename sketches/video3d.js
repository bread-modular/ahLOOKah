export default (audio, videoDeviceId) => (p) => {
  let capture;
  let isCaptureReady = false;
  let rotation = 0;
  let boxes = [];

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

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

    // Random background boxes
    for (let i = 0; i < 15; i++) {
      boxes.push({
        x: p.random(-800, 800),
        y: p.random(-800, 800),
        z: p.random(-2000, -500),
        size: p.random(100, 300),
        rotDir: p.random([-1, 1])
      });
    }
  };

  function analyzeBands(freqs) {
    if (!freqs) return { sub: 0, mid: 0, high: 0 };
    let sub = 0, mid = 0, high = 0;
    for (let i = 0; i < 3; i++) sub += freqs[i];
    for (let i = 20; i < 100; i++) mid += freqs[i];
    for (let i = 150; i < 500; i++) high += freqs[i];
    return {
      sub: (sub / 3) / 255,
      mid: (mid / 80) / 255,
      high: (high / 350) / 255
    };
  }

  p.draw = () => {
    p.background(0);

    if (!isCaptureReady || !capture.loadedmetadata) return;

    const freqs = audio.getFrequencies();
    const b = analyzeBands(freqs ? freqs.left : null);
    const noiseLevel = freqs ? analyzeBands(freqs.right).mid : 0;

    rotation += 0.01 + b.sub * 0.05 + noiseLevel * 0.1;

    // Use video as a texture
    p.texture(capture);

    // 1. MAIN TRANSFORMING CORE
    p.push();
    p.rotateX(rotation * 0.5);
    p.rotateY(rotation);

    const coreScale = 1.0 + b.sub * 0.5;
    if (b.mid > 0.5) {
      p.box(300 * coreScale);
    } else {
      p.sphere(200 * coreScale, 24, 24);
    }
    p.pop();

    // 2. BACKGROUND TEXTURED BOXES
    boxes.forEach(box => {
      p.push();
      p.translate(box.x, box.y, box.z);
      p.rotateX(rotation * box.rotDir);
      p.rotateZ(rotation * 0.3);

      const s = box.size * (1 + b.high * 0.5);
      p.box(s);
      p.pop();
    });

    // 3. GLITCH PLANES
    if (b.high > 0.4 || noiseLevel > 0.4) {
      p.push();
      const planeDist = p.map(b.sub, 0, 1, -500, 500);
      p.translate(0, 0, planeDist);
      p.noFill();
      p.stroke(255);
      p.strokeWeight(2);
      if (p.random() > 0.5) {
        p.texture(capture);
        p.noStroke();
      }
      p.plane(p.width, p.height);
      p.pop();
    }

    // 4. OVERLAY SCANLINES
    if (noiseLevel > 0.3) {
      p.push();
      p.noFill();
      p.stroke(255, 100);
      for (let i = 0; i < 5; i++) {
        let ry = p.random(-p.height / 2, p.height / 2);
        p.line(-p.width / 2, ry, 500, p.width / 2, ry, 500);
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
