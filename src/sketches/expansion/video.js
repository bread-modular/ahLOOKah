// Expansion camera constructions: simulated datamoshing (stale macroblocks
// with drifted motion vectors) and rolling-shutter skew/wobble. ProgramRuntime
// owns the capture lease; these never request another device. Offscreen
// buffers are released on remove.
import { TAU, expansionEntry, expansionParams, hash, makeExpansionReader, response } from './runtime.js';
import { bounded } from '../band-reactive.js';

const W = 320, H = 180;
function buffer() { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }

function cameraFactory(kind) {
  return (audio, device, params = {}, runtime = {}) => (p) => {
    let capture, ready = false, time = 0, frame = 0;
    let source, ref, primed = false;
    const read = makeExpansionReader(audio, params, runtime);
    p.setup = () => {
      p.pixelDensity(1); p.createCanvas(p.windowWidth, p.windowHeight);
      source = buffer();
      if (kind === 'mosh') ref = buffer();
      const constraints = { video: { ...(device ? { deviceId: { exact: device } } : {}), width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };
      const onReady = () => { ready = true; runtime.reportMediaReady?.(); };
      capture = runtime.createCapture ? runtime.createCapture(p, constraints, onReady) : p.createCapture(constraints, onReady);
      capture.hide();
    };
    p.draw = () => {
      const dt = bounded(p.deltaTime / 1000, 1 / 60, 0, .1), c = read(dt);
      const b = response(c.bass), m = response(c.mid), h = response(c.high), detail = bounded(params.detail, 1, .5, 2);
      time += dt * bounded(params.speed, .6, 0, 2);
      const ctx = p.drawingContext, video = capture?.elt;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, p.width, p.height);
      if (!ready || !video || video.readyState < 2 || !video.videoWidth) return;
      // Cover-crop once at a fixed low resolution, mirrored like a stage camera.
      const sc = source.getContext('2d'), scale = Math.max(W / video.videoWidth, H / video.videoHeight);
      sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalCompositeOperation = 'source-over';
      sc.setTransform(-1, 0, 0, 1, W, 0);
      sc.drawImage(video, (W - video.videoWidth * scale) / 2, (H - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
      frame++;

      if (kind === 'mosh') {
        // Simulated I-frame removal: blocks that "miss the keyframe" keep the
        // stale reference pixels and drift on a warped motion-vector field.
        if (!primed || frame % 48 === 0) { ref.getContext('2d').drawImage(source, 0, 0); primed = true; }
        const cols = Math.max(6, Math.min(26, Math.round(8 * detail + b * 12))); // bass: macroblock scale
        const rowsN = Math.max(4, Math.min(15, Math.round(cols * 9 / 16)));
        const cw = p.width / cols, ch = p.height / rowsN;
        const slot = Math.floor(frame / 5);
        for (let y = 0; y < rowsN; y++) for (let x = 0; x < cols; x++) {
          const id = x * 73 + y * 131;
          const stale = hash(id, slot) < .12 + b * .55;                  // bass: hold strength
          const sx = x * W / cols, sy = y * H / rowsN;
          if (stale) {
            const dx = m * cw * 2.4 * Math.sin(y * .7 + time * 2 + hash(id, 2) * TAU); // mid: vector drift
            const dy = m * ch * 1.8 * Math.cos(x * .9 - time * 1.4 + hash(id, 3) * TAU);
            ctx.drawImage(ref, sx, sy, W / cols, H / rowsN, x * cw + dx, y * ch + dy, cw + .5, ch + .5);
            if (h > .01) {                                                // high: block-edge speckle
              ctx.strokeStyle = `rgba(255 255 255 / ${h * .8})`;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(x * cw + dx + .5, y * ch + dy + .5, cw - 1, ch - 1);
              for (let sp = 0; sp < 3; sp++) if (hash(id + sp, slot + 11) < h * .7) {
                ctx.fillStyle = `rgba(255 255 255 / ${h * .9})`;
                ctx.fillRect(x * cw + dx + hash(id + sp, 5) * (cw - 3), y * ch + dy + hash(id + sp, 6) * (ch - 3), 3, 3);
              }
            }
          } else {
            ctx.drawImage(source, sx, sy, W / cols, H / rowsN, x * cw, y * ch, cw + .5, ch + .5);
            if (h > .01) {                                                // high: fresh-block hairline grid
              ctx.strokeStyle = `rgba(255 255 255 / ${h * .3})`;
              ctx.lineWidth = 1;
              ctx.strokeRect(x * cw + .5, y * ch + .5, cw - 1, ch - 1);
            }
          }
        }
      } else {
        // Rolling shutter: each scan band is exposed at a slightly different
        // time, so motion skews. Bass sets skew amplitude, mids retune the
        // wobble waveform, highs tear individual bands.
        const bands = Math.max(24, Math.min(80, Math.round(36 * detail)));
        const bh = p.height / bands, sh = H / bands;
        for (let j = 0; j < bands; j++) {
          const y0 = j * bh;
          let offset = b * p.width * .13 * Math.sin(j * .11 + time * 3)   // bass: skew amplitude
            + m * p.width * .1 * Math.sin(j * (.04 + m * .12) - time * 2); // mid: wobble geometry
          const torn = h > .01 && hash(j, Math.floor(time * 18)) < h * .7; // high: band tears
          if (torn) offset += (hash(j, Math.floor(time * 18) + 5) - .5) * p.width * .3 * h;
          for (const wrap of [-1, 0, 1]) ctx.drawImage(source, 0, j * sh, W, sh + .5, offset + wrap * p.width, y0, p.width, bh + .5);
          if (torn) {
            ctx.fillStyle = `rgba(255 255 255 / ${h * .75})`;
            ctx.fillRect(0, y0, p.width, 2);
          }
        }
      }
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
    const remove = p.remove.bind(p);
    p.remove = (...args) => {
      for (const c of [source, ref]) if (c) { c.width = 0; c.height = 0; }
      source = null; ref = null;
      return remove(...args);
    };
  };
}

export const VIDEO_PATTERNS = [
  expansionEntry({ id: 'video-datamosh', name: 'Video Datamosh', group: 'Video FX', camera: true, factory: cameraFactory('mosh'), params: expansionParams('Block Density', { hue: false }), description: 'Simulated I-frame removal: bass swells macroblocks and holds stale reference pixels, mids warp the motion-vector drift field, highs speckle block edges with sparkle flicker.' }),
  expansionEntry({ id: 'video-rolling-shutter', name: 'Video Rolling Shutter', group: 'Video FX', camera: true, factory: cameraFactory('shutter'), params: expansionParams('Scan Bands', { hue: false }), description: 'Rolling-shutter jello: bass sets skew amplitude across scan bands, mids retune the wobble waveform geometry, highs tear individual bands with bright seam accents.' }),
];
