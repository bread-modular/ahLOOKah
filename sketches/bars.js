export default (audio) => (p) => {
  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 255);
  };

  p.draw = () => {
    p.background(0);

    if (!audio || !audio.isStarted) return;

    const waveforms = audio.getWaveforms();
    if (!waveforms) return;

    const barWidth = 10;
    const spacing = 2;
    const totalBars = Math.floor(p.width / (barWidth + spacing));

    p.noStroke();

    for (let i = 0; i < totalBars; i++) {
      const sampleIdx = Math.floor(p.map(i, 0, totalBars, 0, waveforms.left.length));

      const valL = waveforms.left[sampleIdx];
      const hL = p.map(valL, 128, 255, 2, p.height / 2);
      const hueL = p.map(i, 0, totalBars, 150, 200);
      p.fill(hueL, 200, 255, 150);
      p.rect(i * (barWidth + spacing), p.height / 2 - hL, barWidth, hL);

      const valR = waveforms.right[sampleIdx];
      const hR = p.map(valR, 128, 255, 2, p.height / 2);
      const hueR = p.map(i, 0, totalBars, 200, 255);
      p.fill(hueR, 200, 255, 150);
      p.rect(i * (barWidth + spacing), p.height / 2, barWidth, hR);
    }
  };

  p.mousePressed = () => {
    audio.resume();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};
