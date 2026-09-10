// Two different camera constructions: finite temporal slices and affine facets.
// ProgramRuntime still owns the capture lease; these never request another mic.
import { bounded, makeBandReader } from '../band-reactive.js';
import { entry, response } from './runtime.js';
const HISTORY = 16, W = 320, H = 180;
function buffer() { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
function cameraFactory(kind) {
  return (audio, device, params = {}, runtime = {}) => (p) => {
    let capture, ready = false, time = 0, cursor = 0, filled = 0;
    let source, history = [];
    const read = makeBandReader(audio, params, runtime);
    p.setup = () => {
      p.pixelDensity(1); p.createCanvas(p.windowWidth, p.windowHeight);
      source = buffer();
      if (kind === 'slit') history = Array.from({ length: HISTORY }, buffer);
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
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, p.width, p.height);
      if (!ready || !video || video.readyState < 2 || !video.videoWidth) return;
      // Cover-crop once, at a fixed low history resolution, mirrored like a stage camera.
      const sc = source.getContext('2d'), scale = Math.max(W / video.videoWidth, H / video.videoHeight);
      sc.setTransform(-1, 0, 0, 1, W, 0);
      sc.drawImage(video, (W - video.videoWidth * scale) / 2, (H - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
      if (kind === 'slit') {
        history[cursor].getContext('2d').drawImage(source, 0, 0);
        cursor = (cursor + 1) % HISTORY; filled = Math.min(HISTORY, filled + 1);
        const slices = Math.round(12 * detail + h * 38);
        for (let i = 0; i < slices; i++) {
          const age = Math.min(filled - 1, Math.floor(i / slices * (2 + b * 18) + h * 6 * (i % 2)));
          const frame = history[(cursor - 1 - age + HISTORY) % HISTORY];
          const y = i * p.height / slices, height = p.height / slices + 1;
          const shift = Math.sin(i * .65 + time) * m * p.width * .22;
          // Wrap two copies so displacement never uncovers an accidental black edge.
          for (const wrap of [-1, 0, 1]) ctx.drawImage(frame, 0, i * H / slices, W, H / slices,
            shift + wrap * p.width, y, p.width, height);
        }
      } else {
        const cols = Math.round(4 * detail), rows = 4, cw = p.width / cols, ch = p.height / rows;
        ctx.drawImage(source, 0, 0, p.width, p.height);
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) for (let side = 0; side < 2; side++) {
          ctx.save(); ctx.translate(x * cw, y * ch);
          ctx.beginPath(); ctx.moveTo(0, side ? ch : 0); ctx.lineTo(cw, side ? ch : 0); ctx.lineTo(side ? 0 : cw, side ? 0 : ch); ctx.closePath(); ctx.clip();
          const fold = (side ? -1 : 1), shear = fold * (.04 + m * .95);
          ctx.translate(cw / 2, ch / 2); ctx.transform(1 + b * 1.6, shear, fold * h * 1.1, 1, 0, 0);
          ctx.translate(-cw / 2 + Math.sin(time + y) * 2 + fold * b * cw * .5, -ch / 2 + fold * h * ch * .4);
          ctx.drawImage(source, x * W / cols, y * H / rows, W / cols, H / rows, -cw * .3, -ch * .3, cw * 1.6, ch * 1.6);
          ctx.restore();
        }
      }
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
    const remove = p.remove.bind(p);
    p.remove = (...args) => { history.forEach(c => { c.width = c.height = 0; }); history = []; if (source) source.width = source.height = 0; return remove(...args); };
  };
}
export const VIDEO_PATTERNS = [
  entry('video-slit-scan', 'Video Slit Scan', 'Video FX', 'Temporal camera ribbons: bass deepens frame history, mids shear ribbons, highs subdivide the time slices.', cameraFactory('slit'), 'Slice Count', { camera: true }),
  entry('video-facet-fold', 'Video Facet Fold', 'Video FX', 'Triangular camera origami: bass expands facet crops, mids hinge opposing facets, highs shear the other axis.', cameraFactory('fold'), 'Facet Count', { camera: true }),
];
