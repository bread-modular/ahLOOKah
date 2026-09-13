// Regenerate the app screenshots used by the static docs pages (public/docs/shots).
//
// Boots an isolated Vite dev server, drives the real control/output windows with
// Playwright, and writes whole-window figures at 2× device pixels (retina) so the
// docs can show them full-width without upscaling.
//
//   node scripts/docs-screenshots.mjs
//   DOCS_SHOTS_PORT=5301 node scripts/docs-screenshots.mjs
//
// Every figure is a complete app window — never a cropped element — so the reader
// always sees where the control lives. Panes are scrolled into position first.
//
// Scenarios:
//   media-empty / media-library / media-video   — Media group, image + video patterns
//   screen-mapping                              — Global Settings ▸ Screen Mapping
//   projection-panel / projection-editor        — Projection Mapping panel + editor
//   projection-corners                          — editor with corner positions open
//   projection-replace                          — dragging a pattern onto a mapping
//   projection-alpha-blend                      — Alpha Blend on + the Alphas group
//   projection-output                           — output window with five warped surfaces
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/docs/shots');
const PORT = Number(process.env.DOCS_SHOTS_PORT || 5299);
const BASE = `http://localhost:${PORT}`;

// 1280×800 window captured at 2× → 2560×1600 files. The docs render figures at
// 100% of the article column (~760px), so this keeps them crisp on retina and
// still sharp when a reader zooms into a corner handle.
const VIEWPORT = { width: 1280, height: 800 };
const DPR = 2;
const JPEG = { type: 'jpeg', quality: 80 };

const asBase64 = (relative) => readFileSync(resolve(ROOT, relative)).toString('base64');

// Five surfaces on one pattern — the docs use this to show that a pattern holds
// up to eight mappings, not two. Each source is a real library sketch (no
// Solid Color fills), and every quad is keystoned so it reads as "warped to fit
// a venue" rather than "a grid of rectangles".
const PROJECTION_META = {
  id: 'projection-docs',
  name: 'Main stage',
  surfaces: [
    { id: 'sleft', name: 'Left wall', patternId: 'neon-metropolis' },
    { id: 'scentre', name: 'Centre wall', patternId: 'chroma-mandala' },
    { id: 'sright', name: 'Right wall', patternId: 'plasma-waves' },
    { id: 'sfloor', name: 'Stage floor', patternId: 'laser-grid' },
    { id: 'sbanner', name: 'Header banner', patternId: 'color-bars' },
  ],
};

const quad = (tl, tr, br, bl) => [tl, tr, br, bl].map(([x, y]) => ({ x, y }));
const geometry = (id, points) => Object.fromEntries(
  points.flatMap((point, i) => ['x', 'y'].map((axis) => [`${id}:${i}${axis}`, point[axis]])),
);
const PROJECTION_VALUES = {
  ...geometry('sleft', quad([0.03, 0.20], [0.30, 0.17], [0.31, 0.68], [0.01, 0.64])),
  ...geometry('scentre', quad([0.34, 0.15], [0.63, 0.15], [0.65, 0.64], [0.32, 0.64])),
  ...geometry('sright', quad([0.67, 0.17], [0.96, 0.20], [0.99, 0.64], [0.68, 0.68])),
  ...geometry('sfloor', quad([0.18, 0.74], [0.82, 0.74], [0.94, 0.96], [0.06, 0.96])),
  ...geometry('sbanner', quad([0.10, 0.03], [0.90, 0.03], [0.88, 0.12], [0.12, 0.12])),
};

// A believable projector keystone. The top corners stay clear of the panel's
// "OUTPUT / resolution" meta line so the corner labels are not obscured.
const SCREEN_MAPPING_QUAD = [
  { x: 0.12, y: 0.16 }, { x: 0.92, y: 0.11 }, { x: 0.99, y: 0.94 }, { x: 0.03, y: 0.98 },
];

function waitForServer(url, timeoutMs = 45_000) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status < 500) return resolvePromise();
      } catch { /* not up yet */ }
      if (Date.now() - started > timeoutMs) return reject(new Error(`Dev server did not start at ${url}`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

function startServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  return child;
}

// Seed localStorage before app modules run. Everything the app would normally
// have written across a session is pre-set so each scenario opens "mid-session".
async function seed(context, storage) {
  await context.addInitScript((entries) => {
    if (!location.protocol.startsWith('http')) return;
    for (const [key, value] of Object.entries(entries)) {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    }
  }, storage);
}

// Stub the File System Access picker with real file bytes. The app keeps the
// handle in its in-session cache, so the freshly picked pattern renders.
async function seedMediaPicker(context, files) {
  await context.addInitScript((picked) => {
    if (!location.protocol.startsWith('http')) return;
    let index = 0;
    window.showOpenFilePicker = async () => {
      const entry = picked[Math.min(index, picked.length - 1)];
      index += 1;
      const bin = atob(entry.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], entry.name, { type: entry.type });
      return [{
        kind: 'file',
        name: entry.name,
        async getFile() { return file; },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
      }];
    };
  }, files);
}

// A genuine, decodable WebM so the video scenario shows a real frame and the
// Playback Speed control (there is no ffmpeg and no video asset in the repo).
async function recordLoopVideo(browser) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.setContent('<body style="margin:0;background:#0b0b12"></body>');
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((done) => { recorder.onstop = done; });
    recorder.start();
    const started = performance.now();
    await new Promise((done) => {
      const frame = () => {
        const t = (performance.now() - started) / 1000;
        ctx.fillStyle = '#0b0b12';
        ctx.fillRect(0, 0, 640, 360);
        for (let i = 0; i < 5; i += 1) {
          ctx.beginPath();
          ctx.arc(320, 180, 34 + i * 30 + Math.sin(t * 2 + i * 0.6) * 7, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,255,255,${(0.8 - i * 0.12).toFixed(3)})`;
          ctx.lineWidth = 4;
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(110,190,255,0.9)';
        ctx.fillRect(((t * 140) % 720) - 40, 0, 26, 360);
        if (t < 3) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
    recorder.stop();
    await stopped;
    const buffer = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });
  await page.close();
  return { name: 'Crowd Loop.webm', type: 'video/webm', b64 };
}

// A 16:9 still for the image scenario, so the preview shows a full-frame picture
// rather than an upscaled repo asset (there is no photo library in the repo).
async function renderStill(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent('<body style="margin:0;background:#06060c"></body>');
  const b64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#06060c';
    ctx.fillRect(0, 0, 1280, 720);
    for (const [x, y, r, color] of [
      [300, 250, 300, 'rgba(74,140,255,0.55)'],
      [980, 300, 340, 'rgba(255,86,170,0.45)'],
      [650, 640, 380, 'rgba(56,224,206,0.32)'],
    ]) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1280, 720);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 26; i += 1) {
      const y = 720 * (i / 26) ** 1.8;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1280, y);
      ctx.stroke();
    }
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 220; i += 1) {
      ctx.globalAlpha = 0.15 + random() * 0.8;
      ctx.beginPath();
      ctx.arc(random() * 1280, random() * 470, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  await page.close();
  return { name: 'Deep Space Plate.jpg', type: 'image/jpeg', b64 };
}

const BASE_STORAGE = { viz2_device_setup_done: '1' };

async function openControl(context) {
  const control = await context.newPage();
  await control.goto(`${BASE}/?role=control`);
  await control.locator('#config-panel').waitFor();
  await control.waitForTimeout(600);
  return control;
}

async function newControlContext(browser, storage) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR });
  await seed(context, { ...BASE_STORAGE, ...storage });
  return context;
}

// Whole-window figure — never an element crop.
async function windowShot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT, name), ...JPEG });
  console.log(`  wrote ${name}`);
}

async function main() {
  const server = startServer();
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    await waitForServer(BASE);
    const video = await recordLoopVideo(browser);
    const still = await renderStill(browser);
    const mediaFiles = [
      still,
      { name: 'Tidal Glass Loop.png', type: 'image/png', b64: asBase64('docs/replacement-strength-assets/tidal-glass.png') },
      video,
    ];

    // ---- media-empty: nothing loaded yet ----------------------------------
    {
      const context = await newControlContext(browser, {});
      const control = await openControl(context);
      await control.locator('#library-section-Media').locator('..').scrollIntoViewIfNeeded();
      await windowShot(control, 'media-empty.jpg');
      await context.close();
    }

    // ---- media-library / media-video --------------------------------------
    {
      const context = await newControlContext(browser, {});
      await seedMediaPicker(context, mediaFiles);
      const control = await openControl(context);

      const addBtn = control.locator('.media-add-btn');
      for (let i = 0; i < mediaFiles.length; i += 1) {
        await addBtn.scrollIntoViewIfNeeded();
        await addBtn.click();
        await control.waitForTimeout(500);
      }

      const mediaButtons = control.locator('.pattern-btn[data-id^="media-"]');

      // Image pattern: Scaling / Zoom / Pan in the parameters pane.
      await mediaButtons.nth(0).click();
      await control.waitForTimeout(1400);
      await mediaButtons.last().scrollIntoViewIfNeeded();
      await windowShot(control, 'media-library.jpg');

      // Video pattern: the extra Playback Speed control.
      await mediaButtons.nth(2).click();
      await control.waitForTimeout(1800);
      await mediaButtons.nth(2).scrollIntoViewIfNeeded();
      await windowShot(control, 'media-video.jpg');

      await context.close();
    }

    // ---- screen-mapping ----------------------------------------------------
    {
      const context = await newControlContext(browser, {
        viz2_screen_mapping_enabled: '1',
        viz2_screen_mapping_edge_blur: '6',
        viz2_screen_mapping: JSON.stringify({ v: 1, quad: SCREEN_MAPPING_QUAD }),
      });
      const control = await openControl(context);
      await control.locator('#screen-mapping').scrollIntoViewIfNeeded();
      await windowShot(control, 'screen-mapping.jpg');
      await context.close();
    }

    // ---- projection-panel / editor / corners / alpha blend -----------------
    {
      const context = await newControlContext(browser, {
        viz2_projection_patterns: JSON.stringify([PROJECTION_META]),
        viz2_params: JSON.stringify({ [PROJECTION_META.id]: PROJECTION_VALUES }),
        viz2_slot_order: JSON.stringify([PROJECTION_META.id, 'checkerboard']),
      });
      const control = await openControl(context);
      await control.waitForTimeout(1500);

      await control.locator('.projection-panel').scrollIntoViewIfNeeded();
      await windowShot(control, 'projection-panel.jpg');

      await control.getByRole('button', { name: 'Edit Left wall', exact: true }).click();
      const dialog = control.getByRole('dialog');
      await dialog.waitFor();
      await control.waitForTimeout(700);
      await windowShot(control, 'projection-editor.jpg');

      // Key concept: the exact corner coordinates live under the canvas.
      await dialog.getByText('Corner positions (%)').click();
      await control.waitForTimeout(400);
      await dialog.locator('.projection-geometry').scrollIntoViewIfNeeded();
      await windowShot(control, 'projection-corners.jpg');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await control.waitForTimeout(400);

      // Key concept: swap a mapping's source without opening the editor by
      // dragging a library pattern onto a collapsed mapping row. The drop
      // highlight is driven by the app's own dragstart/dragover handlers.
      await control.locator('.pattern-btn[data-id="wormhole-transit"]').scrollIntoViewIfNeeded();
      await control.locator('.projection-surface[data-surface-id="sfloor"]').scrollIntoViewIfNeeded();
      const dropped = await control.evaluate(() => {
        const source = document.querySelector('.pattern-btn[data-id="wormhole-transit"]');
        const target = document.querySelector('.projection-surface[data-surface-id="sfloor"]');
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        return { dragging: source.classList.contains('dragging'), highlighted: target.classList.contains('drop-target') };
      });
      if (!dropped.dragging || !dropped.highlighted) {
        throw new Error(`drag affordance missing: ${JSON.stringify(dropped)}`);
      }
      await control.waitForTimeout(250);
      await windowShot(control, 'projection-replace.jpg');
      await control.evaluate(() => {
        const source = document.querySelector('.pattern-btn[data-id="wormhole-transit"]');
        const target = document.querySelector('.projection-surface[data-surface-id="sfloor"]');
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer }));
      });

      // Alpha Blend on, with the Alphas mattes it is designed for on screen.
      await control.locator('.projection-alpha-toggle input').check();
      await control.locator('.projection-alpha-toggle').scrollIntoViewIfNeeded();
      await control.waitForTimeout(300);
      await control.locator('#library-section-Alphas').locator('..').scrollIntoViewIfNeeded();
      await windowShot(control, 'projection-alpha-blend.jpg');
      await context.close();
    }

    // ---- projection-output: five warped surfaces on the output window -----
    {
      const context = await newControlContext(browser, {
        viz2_projection_patterns: JSON.stringify([PROJECTION_META]),
        viz2_params: JSON.stringify({ [PROJECTION_META.id]: PROJECTION_VALUES }),
        viz2_slot_order: JSON.stringify([PROJECTION_META.id, 'checkerboard']),
      });
      const screen = await context.newPage();
      await screen.goto(`${BASE}/?role=screen`);
      await screen.waitForFunction(() => window.__viz?.runtimeCounts?.live > 0);
      // Five shader sources need a moment to draw a settled frame under software GL.
      await screen.waitForTimeout(4000);
      await windowShot(screen, 'projection-output.jpg');
      await context.close();
    }
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
