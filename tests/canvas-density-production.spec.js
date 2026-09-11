import { test, expect } from '@playwright/test';

// The real application, not renderTimeline: control-panel canvas sizing, p5 setup,
// ResizeObserver, BroadcastChannel, ProgramRuntime and output compositing all run.
const preview = '#preview-stage canvas.preview-canvas';
const output = '.program-layer-live canvas.program-canvas';
const sizes = [
  { name: 'landscape', control: { width: 1600, height: 720 }, output: { width: 960, height: 540 } },
  { name: 'portrait', control: { width: 1100, height: 1000 }, output: { width: 540, height: 960 } },
  { name: 'resized', control: { width: 1440, height: 800 }, output: { width: 1100, height: 620 } },
];

async function select(control, screen, id) {
  await control.locator(`#pattern-library [data-id="${id}"]`).click();
  await expect(screen.locator('.program-layer-live')).toHaveAttribute('data-program-ids', id);
  await expect(control.locator(preview)).toHaveAttribute('data-preview-sketch', id);
}

async function pixels(page, selector) {
  return page.locator(selector).evaluate(canvas => {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const rgba = ctx.getImageData(0, 0, width, height).data;
    let opaque = 0, foreground = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 255) opaque++;
      if (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) > 40) foreground++;
    }
    const rect = canvas.getBoundingClientRect(), transform = ctx.getTransform();
    return { width, height, cssWidth: rect.width, cssHeight: rect.height,
      opaque: opaque / (width * height), foreground,
      scaleX: transform.a, scaleY: transform.d,
      corners: [[.02,.02],[.98,.02],[.02,.98],[.98,.98]].map(([x,y]) =>
        [...ctx.getImageData(Math.floor(x * width), Math.floor(y * height), 1, 1).data]),
    };
  });
}

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`real UI / device density ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor, viewport: sizes[0].control });
    test('Pendulum Wave fills the backing store without a quarter-frame boundary or ghosts after resize', { tag: ['@core', '@patterns'] }, async ({ context, page }, testInfo) => {
      test.setTimeout(60_000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto('/?role=control');
      const screen = await context.newPage(); screen.on('pageerror', e => errors.push(e.message));
      await screen.setViewportSize(sizes[0].output); await screen.goto('/?role=screen');
      await expect(screen.locator(output)).toBeVisible();
      await expect(page.getByText('SCREEN ONLINE', { exact: true })).toBeVisible();
      await select(page, screen, 'pendulum-wave');
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
          const stats = await pixels(target, selector);
          expect(stats.foreground).toBeGreaterThan(100);
          expect(stats.corners).toEqual(Array.from({ length: 4 }, () => [5, 8, 17, 255]));
          reports.push({ size: size.name, role, ...stats });
          await target.screenshot({ path: testInfo.outputPath(`pendulum-${role}-${size.name}-dpr${deviceScaleFactor}.png`) });
        }
        // Deliberately contaminate the last pixel to prove subsequent real draws
        // repaint outside the old width×height rectangle (not just on resize).
        await page.locator(preview).evaluate(c => { const x=c.getContext('2d'); x.save(); x.setTransform(1,0,0,1,0,0); x.fillStyle='#ff00ff'; x.fillRect(c.width-8,c.height-8,8,8); x.restore(); });
        await expect.poll(() => page.locator(preview).evaluate(c => [...c.getContext('2d').getImageData(c.width-2,c.height-2,1,1).data])).toEqual([5,8,17,255]);
      }
      await testInfo.attach('dimensions-and-coverage', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
      expect(errors).toEqual([]);
      await screen.close();
    });
  });
}
