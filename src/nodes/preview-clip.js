// Editor-only synthetic moving image. It is a canvas, never a capture stream or
// a camera substitute on the output screen. Rendering is deterministic for a
// given size/time, so graph frame pinning can hand it to an FX child directly.
const boundedSize = (width, height) => {
  const scale = Math.min(1, 640 / Math.max(1, width), 360 / Math.max(1, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
};

export function createPreviewClip(width, height) {
  const canvas = document.createElement('canvas');
  let disposed = false;
  let revision = 0;
  const resize = (w, h) => {
    if (disposed) return;
    const [nextW, nextH] = boundedSize(w, h);
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
  };
  resize(width, height);
  return {
    get canvas() { return disposed ? null : canvas; },
    get revision() { return revision; },
    resize,
    draw(seconds = 0) {
      if (disposed) return null;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const t = Number.isFinite(seconds) ? seconds : 0;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // Full-coverage, saturated color even at t=0: no black placeholder.
      const background = ctx.createLinearGradient(0, 0, w, h);
      background.addColorStop(0, '#09acc2');
      background.addColorStop(.53, '#a64fbd');
      background.addColorStop(1, '#f29335');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);

      // One diagonal bar advances, another recedes; an offset diamond and the
      // uneven marker notches expose both time and direction to a video FX.
      const sweep = ((t * .23) % 1 + 1) % 1;
      ctx.save();
      ctx.translate((sweep * 1.6 - .4) * w, 0);
      ctx.rotate(-.27);
      ctx.fillStyle = '#fff19b';
      ctx.fillRect(0, -h * .25, w * .16, h * 1.6);
      ctx.fillStyle = '#281e79';
      ctx.fillRect(w * .17, -h * .25, w * .045, h * 1.6);
      ctx.restore();

      const orbitX = w * (.66 + .12 * Math.sin(t * 1.7));
      const orbitY = h * (.36 + .17 * Math.cos(t * 1.2));
      ctx.fillStyle = '#ff477e';
      ctx.beginPath(); ctx.arc(orbitX, orbitY, Math.max(3, h * .16), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4cffd2';
      ctx.beginPath(); ctx.arc(orbitX + w * .032, orbitY - h * .043, Math.max(2, h * .045), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#131a60';
      ctx.beginPath();
      ctx.moveTo(w * .12, h * .68); ctx.lineTo(w * .33, h * .72); ctx.lineTo(w * .23, h * .91);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffeeaa';
      for (let i = 0; i < 4; i++) ctx.fillRect(w * (.07 + i * .035), h * .11, Math.max(2, w * .017), h * (.045 + i * .019));
      ctx.restore();
      revision++;
      return canvas;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.width = canvas.height = 1;
    },
  };
}
