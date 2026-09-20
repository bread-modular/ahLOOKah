api.requireVersion(1);
api.create({
  id: 'custom-mesh', name: 'Lit WebGL geometry', renderer: 'webgl',
  draw({ p }) {
    p.background(5, 8, 20); p.noStroke();
    p.ambientLight(70); p.pointLight(255, 220, 180, 100, -100, 200);
    p.push(); p.rotateY(p.millis() / 1500); p.rotateX(0.3);
    p.fill(60, 150, 230); p.box(90); p.pop();
    p.push(); p.translate(120, 0, 0); p.fill(230, 90, 160); p.sphere(40, 16, 12); p.pop();
    p.push(); p.translate(-120, 0, 0); p.fill(100, 230, 120); p.cone(35, 80, 16); p.pop();
  },
});
