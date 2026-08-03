export default (audio, videoDeviceId, params) => (p) => {
  let capture;
  let isCaptureReady = false;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);

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
    if (!audio || !audio.isStarted) {
      // Show minimal prompt
      p.fill(255);
      p.textAlign(p.CENTER);
      p.text("CLICK TO START AUDIO", p.width / 2, p.height / 2);
      return;
    }

    const freqs = audio.getFrequencies();
    const b = analyzeBands(freqs ? freqs.left : null);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const density = P.density ?? 1;
    const dotSize = P.size ?? 1;
    const grain = P.grain ?? 1;
    const react = P.react ?? 1;

    // Grid spacing based on audio - more dense on high mids
    const step = Math.max(2, Math.floor(p.map(b.mid, 0, 1, 15, 6) / density));

    capture.loadPixels();

    p.noStroke();

    // Scale capture to fill screen (Cover)
    const scale = Math.max(p.width / capture.width, p.height / capture.height);
    const w = capture.width * scale;
    const h = capture.height * scale;
    const offsetX = (p.width - w) / 2;
    const offsetY = (p.height - h) / 2;

    for (let y = 0; y < capture.height; y += step) {
      for (let x = 0; x < capture.width; x += step) {
        const i = (y * capture.width + x) * 4;
        const r = capture.pixels[i];
        const g = capture.pixels[i + 1];
        const b_val = capture.pixels[i + 2];
        const brightness = (r + g + b_val) / 3;

        if (brightness > 20) {
          const screenX = offsetX + x * scale;
          const screenY = offsetY + y * scale;

          // Dot size reacts to brightness and audio sub-bass
          const baseSize = p.map(brightness, 0, 255, 1, step * 1.5) * dotSize;
          const finalSize = baseSize * (1 + b.sub * 1.5 * react);

          // Gritty monochrome
          p.fill(255, p.map(brightness, 0, 255, 100, 255));

          if (b.high * react > 0.4 && p.random(1) > 0.9) {
            // Glitchy squares on hats
            p.rect(screenX, screenY, finalSize * 2, 2);
          } else {
            p.ellipse(screenX, screenY, finalSize, finalSize);
          }
        }
      }
    }

    // Noise/Grain Overlay
    if (b.mid > 0.3) {
      for (let i = 0; i < 10 * grain; i++) {
        p.stroke(255, 50);
        p.line(0, p.random(p.height), p.width, p.random(p.height));
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
