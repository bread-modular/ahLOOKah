api.requireVersion(1);
api.create({
  id: 'custom-drawing', name: 'Drawing / type / pixels',
  params: [{ key: 'speed', label: 'Speed', min: 0, max: 3, step: 0.1, default: 1 }],
  setup({ p, state, onCleanup }) {
    state.buffer = p.createGraphics(160, 100); // Canvas2D offscreen buffer
    const g = state.buffer;
    g.background(20, 40, 70); g.fill(100, 230, 255); g.noStroke();
    g.triangle(10, 90, 80, 10, 150, 90);
    state.image = p.createImage(16, 16);
    state.image.loadPixels();
    for (let i = 0; i < state.image.pixels.length; i += 4) {
      state.image.pixels.set([255, 150, 50, 255], i);
    }
    state.image.updatePixels();
    onCleanup(() => g.remove());
  },
  draw({ p, state, params }) {
    p.background(10); p.image(state.buffer, 10, 10, 160, 100);
    p.image(state.image, 180, 10, 50, 50);
    p.push(); p.translate(p.width / 2, p.height / 2);
    p.rotate(p.millis() * 0.001 * params.speed);
    p.colorMode(p.HSB, 360, 100, 100, 1);
    p.fill((p.frameCount % 360), 80, 100); p.stroke(0, 0, 100); p.strokeWeight(2);
    p.rect(-40, -40, 80, 80); p.circle(70, 0, 20); p.pop();
    p.fill(255); p.noStroke(); p.textSize(18); p.text('VizCore • not full p5', 10, p.height - 20);
  },
});
