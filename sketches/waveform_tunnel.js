// Waveform Tunnel — fly through a 3D tunnel whose rings are carved from the
// live waveform. Every ring has its own hue and twists with the music;
// sub-bass scales the tunnel and high frequencies add shimmering noise rings.
export default (audio, videoDeviceId, params) => (p) => {
  const SEGMENTS = 36;
  const DEPTH = 900;
  let hueOffset = 0;
  let twist = 0;

  function bands(freqs) {
    if (!freqs) return { sub: 0, mid: 0, high: 0, energy: 0 };
    let sub = 0, mid = 0, high = 0;
    for (let i = 0; i < 4; i++) sub += freqs[i];
    for (let i = 40; i < 150; i++) mid += freqs[i];
    for (let i = 150; i < 500; i++) high += freqs[i];
    sub = sub / (4 * 255);
    mid = mid / (110 * 255);
    high = high / (350 * 255);
    return { sub, mid, high, energy: (sub + mid + high) / 3 };
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.angleMode(p.RADIANS);
  };

  p.draw = () => {
    p.background(0);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const RINGS = P.rings ?? 46;
    const twistSpeed = P.twist ?? 1;
    const tunnelScale = P.scale ?? 1;
    const subPush = P.sub ?? 1;

    const wf = audio && audio.isStarted ? audio.getWaveforms() : null;
    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);

    hueOffset = (hueOffset + 0.4 + b.energy * 2) % 360;
    twist += (0.004 + b.mid * 0.02) * twistSpeed;

    // Sub-bass pushes the tunnel wider and the camera forward
    const scale = tunnelScale * (1 + b.sub * 0.9 * subPush);
    p.translate(0, 0, 120);

    for (let i = 0; i < RINGS; i++) {
      const z = p.map(i, 0, RINGS - 1, -DEPTH, 120);

      // Ring radius follows the waveform sample
      let r;
      if (wf) {
        const idx = Math.floor(p.map(i, 0, RINGS, 0, wf.left.length * 0.8));
        const sample = (wf.left[idx] - 128) / 128;
        r = (300 + sample * 260) * scale;
      } else {
        r = (300 + 120 * p.sin(p.frameCount * 0.03 + i * 0.4)) * scale;
      }

      const hue = (hueOffset + i * 14) % 360;
      const alpha = p.map(i, 0, RINGS, 30, 220);
      const rot = twist + i * 0.12;

      p.push();
      p.translate(0, 0, z);
      p.rotateZ(rot * 0.3);
      p.noFill();
      p.strokeWeight(p.map(i, 0, RINGS, 0.5, 3.5));
      p.stroke(hue, 85, 100, alpha);

      p.beginShape();
      for (let s = 0; s <= SEGMENTS; s++) {
        const a = (s / SEGMENTS) * p.TWO_PI + rot;
        const wobble = 1 + 0.12 * p.sin(a * 3 + p.frameCount * 0.06);
        p.vertex(p.cos(a) * r * wobble, p.sin(a) * r * wobble);
      }
      p.endShape(p.CLOSE);
      p.pop();
    }

    // High-frequency shimmer: random bright arcs near the camera
    if (b.high > 0.35) {
      p.push();
      p.noFill();
      p.strokeWeight(1.5);
      for (let i = 0; i < 4; i++) {
        p.stroke((hueOffset + p.random(120)) % 360, 90, 100, 120);
        p.rotateZ(p.random(p.TWO_PI));
        const rr = p.random(140, 420) * scale;
        p.arc(0, 0, rr, rr, p.random(p.TWO_PI), p.random(p.TWO_PI));
      }
      p.pop();
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight, p.WEBGL);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
