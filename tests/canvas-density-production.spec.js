import { test, expect } from '@playwright/test';

// The real application, not renderTimeline: control-panel canvas sizing, sketch
// setup, ResizeObserver, BroadcastChannel, ProgramRuntime and output compositing
// all run.
const preview = '#preview-stage canvas.preview-canvas';
const output = '.program-layer-live canvas.program-canvas';
const contamination = [255, 0, 255];
// Animation drift of the pattern's own field between two samples, used to widen
// the fixed pattern signature when checking a repainted sentinel.
const animationMargin = 16;
// Fixed pattern signature (see the quiet-frame assertions below).
const membraneBase = [3, 5, 8];
const membraneBright = [120, 204, 255];
const sizes = [
  { name: 'landscape', control: { width: 1600, height: 720 }, output: { width: 960, height: 540 } },
  { name: 'portrait', control: { width: 1100, height: 1000 }, output: { width: 540, height: 960 } },
  { name: 'resized', control: { width: 1440, height: 800 }, output: { width: 1100, height: 620 } },
];

async function select(control, screen, id) {
  // Boot readiness: the pattern library is rendered before the preview runtime
  // exists, so wait for the control's first preview (and the screen's live canvas
  // asserted by the caller) before driving the UI.
  await expect(control.locator('#preview-stage canvas[data-preview-sketch]')).toHaveCount(1);
  // The real UI path is a library click. The control's own selection is the
  // authoritative signal that the click was honoured; the screen's
  // data-program-ids is the transport result. This fixture deliberately issues ONE
  // click: a control that does not take the selection is an app-side defect and must
  // stay visible here rather than be retried away, while a slow control→screen
  // handshake only needs more time.
  await control.locator(`#pattern-library [data-id="${id}"]`).click();
  await expect.poll(() => control.evaluate(() => window.__viz?.liveSelection?.ids?.[0] ?? null),
    { timeout: 10000, message: `the control must take the ${id} library click` }).toBe(id);
  await expect(screen.locator('.program-layer-live')).toHaveAttribute('data-program-ids', id, { timeout: 25000 });
  await expect(control.locator(preview)).toHaveAttribute('data-preview-sketch', id);
}

// Reads the canvas backing store of whichever renderer owns the canvas. The
// retained pattern used here (membrane-modes) is a WebGL shader, and this app's
// internal renderer creates GL canvases with preserveDrawingBuffer ON
// (src/core/renderer-gl.js), so gl.readPixels still returns the presented frame
// — getImageData on such a canvas returns null, which is what made the previous
// helper unusable here. WebGL's origin is bottom-left, so rows are flipped back
// into CSS/top-left order before any sample is taken.
async function pixels(page, selector) {
  return page.locator(selector).evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const { width, height } = canvas;
    let rgba, scaleX, scaleY;
    if (gl) {
      const raw = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      rgba = new Uint8ClampedArray(raw.length);
      for (let y = 0; y < height; y++) {
        rgba.set(raw.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
      }
      // WebGL canvases carry no drawing transform. The shader runtime renders at
      // the documented single density (makeAudioShader: pixelDensity(1), sized by
      // renderScale), so its backing store is exactly the CSS box: density 1.
      scaleX = 1; scaleY = 1;
    } else {
      const ctx = canvas.getContext('2d');
      rgba = ctx.getImageData(0, 0, width, height).data;
      const transform = ctx.getTransform();
      scaleX = transform.a; scaleY = transform.d;
    }
    const at = (x, y) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
    let opaque = 0, foreground = 0;
    const quadrants = [0, 0, 0, 0];
    const min = [255, 255, 255, 255], max = [0, 0, 0, 0];
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 255) opaque++;
      for (let c = 0; c < 4; c++) {
        if (rgba[i + c] < min[c]) min[c] = rgba[i + c];
        if (rgba[i + c] > max[c]) max[c] = rgba[i + c];
      }
      if (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) > 40) {
        foreground++;
        const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
        quadrants[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]++;
      }
    }
    return { width, height, cssWidth: rect.width, cssHeight: rect.height,
      opaque: opaque / (width * height), foreground, quadrants,
      scaleX, scaleY, channelRange: { min, max },
      corners: [[.02, .02], [.98, .02], [.02, .98], [.98, .98]].map(([x, y]) => at(Math.floor(x * width), Math.floor(y * height))),
      bottomRight: at(width - 2, height - 2),
    };
  });
}

// Deliberately contaminate the bottom-right 8x8 to prove subsequent real draws
// repaint outside the old width×height rectangle (not just on resize). 2D
// renderers take a raw fillRect; a WebGL canvas has no 2D context, so the same
// window of its drawing buffer is cleared through a scissor box instead. The
// sentinel is read back inside the same task as the write, so no draw callback
// can interleave and the caller can prove the contamination really landed.
async function contaminate(page, selector) {
  return page.locator(selector).evaluate((canvas, colour) => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const previous = gl.getParameter(gl.COLOR_CLEAR_VALUE);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(canvas.width - 8, 0, 8, 8);
      gl.clearColor(colour[0] / 255, colour[1] / 255, colour[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(previous[0], previous[1], previous[2], previous[3]);
      const sentinel = new Uint8Array(4);
      gl.readPixels(canvas.width - 2, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sentinel);
      return [...sentinel];
    }
    const x = canvas.getContext('2d');
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = `rgb(${colour.join(',')})`;
    x.fillRect(canvas.width - 8, canvas.height - 8, 8, 8);
    x.restore();
    return [...x.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data];
  }, contamination);
}

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`real UI / device density ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor, viewport: sizes[0].control });
    test('Membrane Modes fills the backing store without a quarter-frame boundary or ghosts after resize', { tag: ['@core', '@patterns'] }, async ({ context, page }, testInfo) => {
      test.setTimeout(60_000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto('/?role=control');
      const screen = await context.newPage(); screen.on('pageerror', e => errors.push(e.message));
      await screen.setViewportSize(sizes[0].output); await screen.goto('/?role=screen');
      await expect(screen.locator(output)).toBeVisible();
      await expect(page.getByText('SCREEN ONLINE', { exact: true })).toBeVisible();
      await select(page, screen, 'membrane-modes');
      const reports = [];
      for (const size of sizes) {
        await page.setViewportSize(size.control); await screen.setViewportSize(size.output);
        for (const [role, target, selector] of [['control', page, preview], ['output', screen, output]]) {
          // Full alpha coverage detects the production failure even when the
          // CSS canvas is correctly sized and there are some non-black pixels.
          await expect.poll(async () => (await pixels(target, selector)).opaque).toBe(1);
          await expect.poll(async () => {
            const s = await pixels(target, selector);
            return Math.abs(s.width / s.scaleX - s.cssWidth) < 1 && Math.abs(s.height / s.scaleY - s.cssHeight) < 1;
          }).toBe(true);
          const quiet = await pixels(target, selector);
          expect(quiet.foreground).toBeGreaterThan(100);
          // Fixed, measured signature of the retained pattern itself (independent of
          // whatever is on the canvas): the membrane shader's base colour
          // vec3(.01,.02,.03) → 8-bit [3,5,8] is the darkest pixel of every frame,
          // and its brightest nodal sand (ink(.03) at the default hue) measures
          // [120,204,255]. Verified at both DPRs, all three viewports and both roles
          // (36/36 samples: min exactly 3,5,8,255; max R/B 120/255 with G 203-206).
          // A frame that is actually a ghost of the red base surface (#ff0000) or of
          // another layer cannot satisfy either end of this signature.
          expect(quiet.channelRange.min, 'darkest pixel must be the membrane base colour').toEqual([...membraneBase, 255]);
          expect(quiet.channelRange.max.slice(0, 3).every((v, i) => Math.abs(v - membraneBright[i]) <= 8),
            `brightest nodal sand was ${quiet.channelRange.max.join(',')}`).toBe(true);
          // A quarter-frame boundary leaves one quadrant blank even when the rest
          // of the store looks healthy; this full-field shader paints all four.
          for (const [index, count] of quiet.quadrants.entries()) {
            expect(count, `quadrant ${index} of the backing store must be painted`).toBeGreaterThan(100);
          }
          // The fixture previously pinned the flat quiet colour [5,8,17,255] of
          // the retired Pendulum Wave background (9f707fe/709db00); 32e1bfd moved
          // this test onto membrane-modes, whose animated nodal field legitimately
          // reaches the corners with its own colours ([3,5,8] at landscape, bright
          // tracks at portrait). Every corner must still hold the pattern's own
          // opaque output — never a cleared, stale or foreign rectangle.
          for (const corner of quiet.corners) {
            expect(corner[3], 'corner pixels must be painted, not cleared').toBe(255);
            expect(corner.slice(0, 3).join(','), 'corner must show the pattern, not contamination').not.toBe(contamination.join(','));
          }
          reports.push({ size: size.name, role, ...quiet });
          await target.screenshot({ path: testInfo.outputPath(`membrane-${role}-${size.name}-dpr${deviceScaleFactor}.png`) });
          // Deliberately contaminate the last pixel to prove subsequent real draws
          // repaint outside the old width×height rectangle (not just on resize).
          const sentinel = await contaminate(target, selector);
          expect(sentinel, `${role}: the contamination sentinel must be written`).toEqual([...contamination, 255]);
          await expect.poll(async () => {
            const s = await pixels(target, selector);
            // The pattern's own draw loop must overwrite the sentinel, restore full
            // opacity and repaint the whole store. The repainted pixel must sit in
            // the fixed membrane envelope (plus the measured animation margin) and
            // in the pre-contamination frame range, so a leftover ghost of the red
            // base surface or of another layer cannot satisfy this while the
            // animated field can.
            const inSignature = s.bottomRight.every((v, i) => i === 3 ? v === 255
              : v >= membraneBase[i] - animationMargin && v <= membraneBright[i] + animationMargin);
            const inFrame = s.bottomRight.every((v, i) => i === 3 ? v === 255
              : v >= quiet.channelRange.min[i] - animationMargin && v <= quiet.channelRange.max[i] + animationMargin);
            return s.opaque === 1 && inSignature && inFrame
              && s.bottomRight.slice(0, 3).join(',') !== contamination.join(',');
          }).toBe(true);
        }
      }
      await testInfo.attach('dimensions-and-coverage', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
      expect(errors).toEqual([]);
      await screen.close();
    });
  });
}
