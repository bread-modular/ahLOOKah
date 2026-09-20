api.requireVersion(1);
api.create({
  id: 'custom-audio', name: 'Reactive rings (recommended)',
  params: ['bass', 'mid', 'high'].map(key => ({
    key, label: `${key} responsiveness`, min: 0, max: 2, step: 0.05, default: 1,
  })),
  // Omit audio: the host supplies the existing eight-channel feature controller.
  draw({ p, reactive, response, accent }) {
    const bass = response(reactive.bass);
    const mid = response(reactive.mid);
    const high = response(reactive.high);
    const kick = accent(reactive.kick);
    p.background(8); p.noFill();
    // Structure remains visible in silence; independent ranges have distinct roles.
    p.stroke(80 + mid * 175, 160, 255);
    p.strokeWeight(1 + high * 6);
    p.circle(p.width / 2, p.height / 2, Math.min(p.width, p.height) * (0.2 + bass * 0.5));
    // Selective transient accent, not a second gain or invented beat detector.
    p.stroke(255, 100, 180, kick * 255);
    p.circle(p.width / 2, p.height / 2, Math.min(p.width, p.height) * (0.24 + kick * 0.55));
  },
});
