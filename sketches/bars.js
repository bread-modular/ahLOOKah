export default (audio, videoDeviceId, params) => (p) => {
  let intensity = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.RGB, 255);
  };

  p.draw = () => {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const gain = P.gain ?? 1;
    const barWidth = P.barWidth ?? 4;
    const flash = P.flash ?? 1;

    if (!audio || !audio.isStarted) return;

    const waveforms = audio.getWaveforms();
    const amps = audio.getAmplitudes();
    if (!waveforms) return;

    // Track overall intensity (mix of both channels)
    const currentAmp = (amps.left + amps.right) * 0.5;
    intensity = p.lerp(intensity, currentAmp, 0.1);

    const spacing = 2;
    const totalBars = Math.floor(p.width / (barWidth + spacing));

    p.noStroke();

    for (let i = 0; i < totalBars; i++) {
      const sampleIdx = Math.floor(p.map(i, 0, totalBars, 0, waveforms.left.length));

      // Left Channel (Top half)
      const valL = waveforms.left[sampleIdx];
      const hL = p.map(valL, 128, 255, 2, p.height / 2) * gain;

      // Calculate highlight - flash red on high intensity peaks
      if (valL > 220 || intensity > 0.4 / flash) {
        p.fill(255, 0, 0, 200); // Intensity Red
      } else {
        const gray = p.map(i, 0, totalBars, 100, 200);
        p.fill(gray, 180);
      }
      p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, hL);

      // Right Channel (Bottom half)
      const valR = waveforms.right[sampleIdx];
      const hR = p.map(valR, 128, 255, 2, p.height / 2) * gain;

      if (valR > 220 || intensity > 0.4 / flash) {
        p.fill(255, 0, 0, 200);
      } else {
        const gray = p.map(i, 0, totalBars, 100, 200);
        p.fill(gray, 180);
      }
      p.rect(i * (barWidth + spacing), p.height / 2, barWidth, hR);
    }

    // Minimal divider
    p.stroke(40);
    p.line(0, p.height / 2, p.width, p.height / 2);

    // Flash overlay for extreme intensity
    if (intensity > 0.5 / flash) {
      p.noStroke();
      p.fill(255, 0, 0, 20); // Very subtle red flash
      p.rect(0, 0, p.width, p.height);
    }
  };

  p.mousePressed = () => {
    audio.resume();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};
