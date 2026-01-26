export default (audio) => (p) => {
  let circles = [];

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    for (let i = 0; i < 50; i++) {
      circles.push({
        x: p.random(p.width),
        y: p.random(p.height),
        size: p.random(10, 50),
        speed: p.random(0.5, 2)
      });
    }
  };

  p.draw = () => {
    p.background(0);

    if (!audio || !audio.isStarted) return;

    const amps = audio.getAmplitudes();
    const mixAmp = (amps.left + amps.right) / 2;

    p.noFill();
    p.stroke(255, 150);

    circles.forEach(c => {
      // React to amplitude
      const currentSize = c.size + mixAmp * 500;
      const opacity = p.map(mixAmp, 0, 0.2, 50, 255);

      p.stroke(255, opacity);
      p.circle(c.x, c.y, currentSize);

      c.y -= c.speed;
      if (c.y < -currentSize) c.y = p.height + currentSize;
    });
  };

  p.mousePressed = () => {
    audio.resume();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};
