import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

// Known keystone trapezoid in normalized coords (TL, TR, BR, BL).
const TRAPEZOID = [
  { x: 0.1, y: 0.0 },
  { x: 0.9, y: 0.0 },
  { x: 0.95, y: 1.0 },
  { x: 0.05, y: 1.0 },
];

// Asymmetric quad: sx AND sy are both non-zero, so BOTH perspective terms
// (g, h) of the homography are exercised, not just one.
const ASYM = [
  { x: 0.12, y: 0.05 },
  { x: 0.88, y: 0.02 },
  { x: 0.97, y: 0.94 },
  { x: 0.03, y: 1.0 },
];

async function seedMapping(page, quad, { enabled = true } = {}) {
  // localStorage is inaccessible on about:blank — make sure we're on the app
  // origin before touching it.
  if (!page.url().startsWith('http')) await page.goto(CONTROL_URL);
  await page.evaluate(({ q, en }) => {
    if (q) localStorage.setItem('viz2_screen_mapping', JSON.stringify({ v: 1, quad: q }));
    else localStorage.removeItem('viz2_screen_mapping');
    if (en) localStorage.setItem('viz2_screen_mapping_enabled', '1');
    else localStorage.removeItem('viz2_screen_mapping_enabled');
  }, { q: quad, en: enabled });
}

// A deterministic p5 source, not a DOM overlay that bypasses final output.
// Still exercises ProgramRuntime's after-draw capture (including noLoop),
// native density, CSS fallback and the production mapping compositor.
async function installMappingPattern(context) {
  await context.addInitScript(() => {
    try { localStorage.setItem('viz2_slot_order', JSON.stringify(['color-bars'])); } catch {}
  });
  await context.route('**/src/sketches/color_bars.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.slice(0, source.indexOf('export default')) + `
      export default () => (p) => {
        p.setup = () => { p.createCanvas(p.windowWidth, p.windowHeight); p.noLoop(); };
        p.draw = () => {
          const ctx = p.drawingContext;
          const dpr = p.canvas.width / innerWidth;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, innerWidth, innerHeight);
          ctx.fillStyle = '#fff';
          const pattern = window.__mappingPattern || {};
          if (pattern.bars) {
            const size = pattern.horizontal ? innerHeight : innerWidth;
            for (let i = 0; i < pattern.bars; ++i) {
              if (pattern.horizontal) ctx.fillRect(0, i * size / pattern.bars, innerWidth, size / pattern.bars - 8);
              else ctx.fillRect(i * size / pattern.bars, 0, size / pattern.bars - 8, innerHeight);
            }
          } else {
            ctx.fillRect(0, 0, innerWidth, innerHeight);
            ctx.fillStyle = '#000'; ctx.fillRect(innerWidth / 2 - 30, innerHeight / 2 - 30, 60, 60);
          }
        };
        p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
        window.__redrawMappingPattern = () => p.redraw();
      };
    ` });
  });
}

// Post a raw mapping message over the app channel (simulates another sender).
async function broadcastQuad(page, quad) {
  await page.evaluate((q) => {
    const channel = new BroadcastChannel('viz2_channel');
    channel.postMessage({ type: 'screen-mapping', enabled: true, quad: q });
    channel.close();
  }, quad);
}

// Map the stage's computed matrix3d through DOMPoint (perspective divide
// included) so tests verify the serialized coefficients the browser keeps.
async function mappedCorners(page) {
  return page.evaluate(() => {
    const wrap = document.getElementById('screen-wrap');
    const matrix = new DOMMatrix(getComputedStyle(wrap).transform);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const map = (x, y) => {
      const pt = matrix.transformPoint(new DOMPoint(x, y, 0, 1));
      return { x: pt.x / pt.w, y: pt.y / pt.w };
    };
    return [
      map(0, 0), // TL of the content rect
      map(w, 0), // TR
      map(w, h), // BR
      map(0, h), // BL
    ];
  });
}

// Expected position of content point (u, v) under the quad — an independent
// unit-square->quad implementation used only by the tests.
function expectedMappedPoint(quad, u, v, width, height) {
  const [q0, q1, q2, q3] = quad;
  const dx1 = q1.x - q2.x;
  const dy1 = q1.y - q2.y;
  const dx2 = q3.x - q2.x;
  const dy2 = q3.y - q2.y;
  const sx = q0.x - q1.x + q2.x - q3.x;
  const sy = q0.y - q1.y + q2.y - q3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - sy * dx2) / den;
  const h = (dx1 * sy - dy1 * sx) / den;
  const a = q1.x - q0.x + g * q1.x;
  const b = q3.x - q0.x + h * q3.x;
  const c = q0.x;
  const d = q1.y - q0.y + g * q1.y;
  const e = q3.y - q0.y + h * q3.y;
  const f = q0.y;
  const w = g * u + h * v + 1;
  return {
    x: ((a * u + b * v + c) / w) * width,
    y: ((d * u + e * v + f) / w) * height,
  };
}

test.describe('screen mapping section', () => {
  test('renders at the bottom of the controls pane with the output resolution', async ({ context }) => {
    const screen = await context.newPage();
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');

    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const section = control.locator('#screen-mapping');
    await expect(section).toBeVisible();

    // Last section in the third column
    const order = await control.evaluate(() =>
      [...document.querySelectorAll('#controls-pane > details')].map((s) => s.id)
    );
    expect(order.at(-1)).toBe('screen-mapping');

    // The reported resolution is the OUTPUT window's inner size (both windows
    // share the context viewport, so it equals the control window's own size).
    const viewport = control.viewportSize();
    await expect(control.locator('#screen-mapping-resolution')).toHaveText(
      `${viewport.width} × ${viewport.height}`,
    );

    // Editor + enable checkbox + four corner handles + reset are present.
    // The feature is opt-in: off by default (full-frame output), editor inert.
    await expect(control.locator('#screen-mapping-editor')).toBeVisible();
    await expect(control.locator('#screen-mapping-enabled')).not.toBeChecked();
    await expect(control.locator('#screen-mapping-editor [data-corner]')).toHaveCount(4);
    await expect(control.locator('#screen-mapping-reset-btn')).toBeDisabled(); // off + identity quad
  });

  test('parseMappingQuad rejects degenerate geometry, accepts good quads', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    const result = await control.evaluate(async (trapezoid) => {
      const { parseMappingQuad } = await import('/src/screen-mapping.js');
      return {
        bowtie: parseMappingQuad([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }]).valid,
        duplicateCorner: parseMappingQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]).valid,
        threeCollinear: parseMappingQuad([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 1 }]).valid,
        sliver: parseMappingQuad([{ x: 0, y: 0 }, { x: 1, y: 0.001 }, { x: 1, y: 0.002 }, { x: 0, y: 0.001 }]).valid,
        outOfShape: parseMappingQuad([1, 2, 3]).valid,
        goodTrapezoid: parseMappingQuad(trapezoid).valid,
        resetToNull: parseMappingQuad(null).valid,
      };
    }, TRAPEZOID);
    expect(result).toEqual({
      bowtie: false,
      duplicateCorner: false,
      threeCollinear: false,
      sliver: false,
      outOfShape: false,
      goodTrapezoid: true,
      resetToNull: true,
    });
  });

  test('keeps the matrix normalized without losing tiny perspective coefficients in CSS', async ({ page }) => {
    await page.goto(CONTROL_URL);
    const results = await page.evaluate(async (quad) => {
      const { quadToMatrix3d } = await import('/src/screen-mapping.js');
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      try {
        // Include an almost-affine quad: fixed-decimal CSS numbers can silently
        // round its small perspective coefficients to zero at projector sizes.
        const quads = [quad, [
          { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.10001 },
          { x: 0.89999, y: 0.9 }, { x: 0.1, y: 0.89998 },
        ]];
        return quads.flatMap((q) => [1920, 3840, 7680].map((width) => {
          const transform = quadToMatrix3d(q, width, width * 9 / 16);
          const values = transform.slice(9, -1).split(',').map(Number);
          probe.style.transform = transform;
          // Typed OM reads the actual numeric values, not a rounded diagnostic
          // string fed through the CSS parser for a second time.
          const parsed = probe.computedStyleMap().get('transform').toMatrix();
          return {
            w: values[15],
            z: values[10],
            maxTranslation: Math.max(Math.abs(values[12]), Math.abs(values[13])),
            width,
            perspectiveError: Math.max(
              Math.abs(parsed.m14 - values[3]),
              Math.abs(parsed.m24 - values[7]),
            ),
          };
        }));
      } finally {
        probe.remove();
      }
    }, ASYM);
    for (const result of results) {
      expect(result.w).toBe(1);
      expect(result.z).toBe(1);
      expect(result.maxTranslation).toBeLessThanOrEqual(result.width);
      expect(result.perspectiveError).toBeLessThan(1e-15);
    }
  });

  test('a seeded trapezoid warps the output stage through the exact homography', async ({ context }) => {
    const seeder = await context.newPage();
    await seedMapping(seeder, TRAPEZOID);
    await seeder.close();
    const screen = await context.newPage();
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');

    const width = await screen.evaluate(() => window.innerWidth);
    const height = await screen.evaluate(() => window.innerHeight);

    // transform-origin: 0 0 + matrix3d must send each content corner exactly
    // to the seeded quad corner in output-window pixels (sub-pixel tolerance).
    const corners = await mappedCorners(screen);
    TRAPEZOID.forEach((expected, i) => {
      expect(Math.abs(corners[i].x - expected.x * width)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(corners[i].y - expected.y * height)).toBeLessThanOrEqual(0.25);
    });

    // Interior point: the trapezoid is symmetric about the vertical centre, so
    // the mapped frame centre must land on it (projective interpolation).
    const center = await screen.evaluate(() => {
      const matrix = new DOMMatrix(getComputedStyle(document.getElementById('screen-wrap')).transform);
      const pt = matrix.transformPoint(new DOMPoint(window.innerWidth / 2, window.innerHeight / 2, 0, 1));
      return { x: pt.x / pt.w, y: pt.y / pt.w };
    });
    expect(Math.abs(center.x - width / 2)).toBeLessThanOrEqual(0.25);
    const centerExpected = expectedMappedPoint(TRAPEZOID, 0.5, 0.5, width, height);
    expect(Math.abs(center.y - centerExpected.y)).toBeLessThanOrEqual(0.25);

    // The post-fx pipeline still owns the same wrapper's filter (mapping is
    // end-of-chain, applied after the filter).
    await expect(screen.locator('#screen-wrap')).toHaveCSS('filter', 'none');
  });

  test('painted output fills the quad and stays black outside at full 4K', async ({ context }) => {
    await installMappingPattern(context);
    const seeder = await context.newPage();
    await seedMapping(seeder, ASYM);
    await seeder.close();
    const screen = await context.newPage();
    await screen.setViewportSize({ width: 3840, height: 2160 });
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');

    // All four content corners must land on the quad corners, including
    // when the perspective coefficients are tiny at projector resolutions.
    const width = 3840;
    const height = 2160;
    const corners = await mappedCorners(screen);
    ASYM.forEach((expected, i) => {
      expect(Math.abs(corners[i].x - expected.x * width)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(corners[i].y - expected.y * height)).toBeLessThanOrEqual(0.25);
    });

    // The p5 fixture paints white with a black centre marker. Wait for the
    // antialiased output to be presented rather than testing a DOM-only probe.
    await expect(screen.locator('#screen-mapping-output')).toHaveClass('is-active');

    // Capture the ACTUAL composited pixels and sample them in-page.
    const shot = await screen.screenshot({ type: 'png' });
    const marker = expectedMappedPoint(ASYM, 0.5, 0.5, width, height);
    const inside = [
      expectedMappedPoint(ASYM, 0.3, 0.3, width, height),
      expectedMappedPoint(ASYM, 0.7, 0.65, width, height),
      expectedMappedPoint(ASYM, 0.5, 0.3, width, height),
    ];
    const outside = [
      { x: 0.02 * width, y: 0.5 * height }, // left of the quad's left edge
      { x: 0.5 * width, y: 0.004 * height }, // above the quad's top edge
      { x: 0.995 * width, y: 0.5 * height }, // right of the quad's right edge
    ];
    const samples = await screen.evaluate(async ({ b64, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return points.map(([x, y]) => {
        const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [d[0], d[1], d[2]];
      });
    }, { b64: shot.toString('base64'), points: [marker, ...inside, ...outside].map((p) => [p.x, p.y]) });

    const maxChannel = (rgb) => Math.max(...rgb);
    const minChannel = (rgb) => Math.min(...rgb);
    // The centre marker paints black at the warped centre…
    expect(maxChannel(samples[0])).toBeLessThan(80);
    // …content around it paints white inside the quad…
    for (let i = 1; i <= inside.length; i += 1) {
      expect(minChannel(samples[i])).toBeGreaterThan(180);
    }
    // …and the area outside the quad stays the black page background.
    for (let i = inside.length + 1; i < samples.length; i += 1) {
      expect(maxChannel(samples[i])).toBeLessThan(40);
    }
  });

  test('rendered hit-testing follows the warp at full 4K with an asymmetric quad', async ({ context }) => {
    await installMappingPattern(context);
    const seeder = await context.newPage();
    await seedMapping(seeder, ASYM);
    await seeder.close();
    const screen = await context.newPage();
    await screen.setViewportSize({ width: 3840, height: 2160 });
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');

    // The content point we probe: near the TL corner where keystone drift is
    // largest, and far enough from the mapped position to tell them apart.
    const u = 0.05;
    const v = 0.05;
    const expected = expectedMappedPoint(ASYM, u, v, 3840, 2160);
    const unmapped = { x: u * 3840, y: v * 2160 };

    // Serialized coefficients must land the point sub-pixel-precisely.
    const matrixOk = await screen.evaluate(({ exp, u, v }) => {
      const matrix = new DOMMatrix(getComputedStyle(document.getElementById('screen-wrap')).transform);
      const pt = matrix.transformPoint(new DOMPoint(u * window.innerWidth, v * window.innerHeight, 0, 1));
      return Math.abs(pt.x / pt.w - exp.x) < 0.25 && Math.abs(pt.y / pt.w - exp.y) < 0.25;
    }, { exp: expected, u, v });
    expect(matrixOk).toBe(true);

    // REAL rendered geometry: hit-testing runs through the live compositor
    // transform. A probe planted at the content point must be *found* where
    // the homography predicts and *not* found at the unwrapped position.
    const probe = await screen.evaluate(({ exp, unmap, u, v }) => {
      const layer = document.querySelector('[data-program-slot="live"]');
      const el = document.createElement('div');
      el.id = 'sm-probe';
      // pointer-events:auto — the program layer inherits `none`, which would
      // make elementFromPoint skip the probe entirely.
      el.style.cssText = 'position:absolute;width:40px;height:40px;background:#fff;z-index:99;pointer-events:auto;';
      el.style.left = `${u * window.innerWidth - 20}px`;
      el.style.top = `${v * window.innerHeight - 20}px`;
      layer.appendChild(el);
      const hits = (x, y) => {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
        const found = document.elementFromPoint(Math.round(x), Math.round(y));
        // Only a direct hit on the probe counts — ancestors (body, the stage
        // wrapper…) contain the probe but are not the warped surface itself.
        return Boolean(found && (found === el || el.contains(found)));
      };
      return {
        atExpected: hits(exp.x, exp.y),
        atUnmapped: hits(unmap.x, unmap.y),
        displacement: Math.hypot(exp.x - unmap.x, exp.y - unmap.y),
      };
    }, { exp: expected, unmap: unmapped, u, v });
    // Self-check: the warp must actually move this point meaningfully.
    expect(probe.displacement).toBeGreaterThan(60);
    expect(probe.atExpected).toBe(true);
    expect(probe.atUnmapped).toBe(false);
  });

  test('control drags update the screen output live and persist', async ({ context }) => {
    const screen = await context.newPage();
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Identity + feature off: no warp at all
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', 'none');

    // Turn the opt-in feature on for this panel
    const enable = control.locator('#screen-mapping-enabled');
    await enable.check();
    await expect(enable).toBeChecked();

    // Drag the TL handle (sits on the editor's top-left corner) toward the
    // middle of the editor. The section is the bottom of a scrollable column,
    // so bring it into view before driving the mouse.
    const editor = control.locator('#screen-mapping-editor');
    await editor.scrollIntoViewIfNeeded();
    const editorBox = await editor.boundingBox();
    await control.mouse.move(editorBox.x + 3, editorBox.y + 3);
    await control.mouse.down();
    await control.mouse.move(
      editorBox.x + editorBox.width * 0.25,
      editorBox.y + editorBox.height * 0.25,
      { steps: 8 },
    );
    await control.mouse.up();

    // The screen stage is now warped (perspective terms present)
    await expect(screen.locator('#screen-wrap')).not.toHaveCSS('transform', 'none');
    const transform = await screen.evaluate(() => getComputedStyle(document.getElementById('screen-wrap')).transform);
    expect(transform.startsWith('matrix3d')).toBe(true);

    // Persisted under the reserved keys (reverts on reload, applies on boot)
    const stored = await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_screen_mapping')));
    expect(stored.v).toBe(1);
    expect(stored.quad[0].x).toBeGreaterThan(0.2);
    expect(stored.quad[0].y).toBeGreaterThan(0.2);
    expect(await control.evaluate(() => localStorage.getItem('viz2_screen_mapping_enabled'))).toBe('1');

    // Panel reflects the drag (quad no longer identity)
    await expect(control.locator('#screen-mapping-reset-btn')).toBeEnabled();
  });

  test('toggling the checkbox applies and clears the warp live and persists', async ({ context }) => {
    const screen = await context.newPage();
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // A stored quad alone does nothing while the feature is off
    await seedMapping(control, TRAPEZOID, { enabled: false });
    await screen.reload();
    await screen.waitForSelector('#screen-wrap canvas');
    await control.reload();
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', 'none');

    const enable = control.locator('#screen-mapping-enabled');
    await expect(enable).not.toBeChecked();

    // Toggling on applies the stored quad to the output immediately
    await enable.check();
    await expect(screen.locator('#screen-wrap')).not.toHaveCSS('transform', 'none');
    const corners = await mappedCorners(screen);
    const width = await screen.evaluate(() => window.innerWidth);
    expect(Math.abs(corners[0].x - TRAPEZOID[0].x * width)).toBeLessThanOrEqual(1);

    // Persists across a reload (checkbox + warp both restored)
    await control.reload();
    await expect(control.locator('#screen-mapping-enabled')).toBeChecked();
    await expect(screen.locator('#screen-wrap')).not.toHaveCSS('transform', 'none');

    // Toggling off returns the output to the full frame (quad stays stored)
    await control.locator('#screen-mapping-enabled').uncheck();
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', 'none');
    const stillStored = await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_screen_mapping')));
    expect(stillStored.quad[0].x).toBe(TRAPEZOID[0].x);
    await expect(control.locator('#screen-mapping .screen-mapping-body')).toHaveClass(/is-disabled/);
  });

  test('mapping survives an output resize (normalized quad rescales)', async ({ context }) => {
    const seeder = await context.newPage();
    await seedMapping(seeder, TRAPEZOID);
    await seeder.close();
    const screen = await context.newPage();
    await screen.setViewportSize({ width: 1000, height: 700 });
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');

    await screen.setViewportSize({ width: 800, height: 640 });
    await screen.waitForFunction(() => {
      const wrap = document.getElementById('screen-wrap');
      const matrix = new DOMMatrix(getComputedStyle(wrap).transform);
      const pt = matrix.transformPoint(new DOMPoint(window.innerWidth, window.innerHeight, 0, 1));
      return Math.abs(pt.x / pt.w - 0.95 * window.innerWidth) < 1;
    });

    const corners = await mappedCorners(screen);
    expect(Math.abs(corners[2].x - 0.95 * 800)).toBeLessThanOrEqual(1);
    expect(Math.abs(corners[2].y - 1.0 * 640)).toBeLessThanOrEqual(1);
  });

  test('invalid quads never reach the output; reset restores the full frame', async ({ context }) => {
    const screen = await context.newPage();
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Seed a good trapezoid the way the panel stores it, then reload both
    // windows so each boots with it applied.
    await seedMapping(control, TRAPEZOID);
    await screen.reload();
    await screen.waitForSelector('#screen-wrap canvas');
    await control.reload();

    const warpedBefore = await screen.evaluate(() => getComputedStyle(document.getElementById('screen-wrap')).transform);
    expect(warpedBefore.startsWith('matrix3d')).toBe(true);

    // Crossed (bowtie), duplicate-corner and three-collinear quads broadcast
    // directly over the channel are all rejected: both windows retain the last
    // valid mapping. Each rejection is given a beat to land before checking.
    const degenerate = [
      [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }],
      [{ x: 0.0, y: 0.0 }, { x: 1.0, y: 0.0 }, { x: 1.0, y: 0.0 }, { x: 0.0, y: 1.0 }],
      [{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }, { x: 1.0, y: 1.0 }, { x: 0.0, y: 1.0 }],
    ];
    for (const quad of degenerate) {
      await broadcastQuad(control, quad);
      await control.waitForTimeout(150);
      const warpedNow = await screen.evaluate(() => getComputedStyle(document.getElementById('screen-wrap')).transform);
      expect(warpedNow).toBe(warpedBefore);
    }
    const stored = await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_screen_mapping')));
    expect(stored.quad[0]).toEqual(TRAPEZOID[0]);

    // Reset through the panel button → full frame everywhere (feature stays on)
    await control.locator('#screen-mapping-reset-btn').click();
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', 'none');
    await expect(control.locator('#screen-mapping-reset-btn')).toBeDisabled();
    const cleared = await control.evaluate(() => localStorage.getItem('viz2_screen_mapping'));
    expect(cleared).toBeNull();
    expect(await control.evaluate(() => localStorage.getItem('viz2_screen_mapping_enabled'))).toBe('1');
  });

  test('an enabled mapping stays end-of-chain through merge, post-fx and a CUE take', async ({ context }) => {
    // Five compositor readbacks alongside LIVE/CUE WebGL can exceed 30s on
    // software-only CI. Keep individual readiness assertions bounded below.
    test.setTimeout(60_000);
    await context.addInitScript(() => {
      try { localStorage.setItem('viz2_slot_order', JSON.stringify(['color-bars', 'gradient-wash'])); } catch {}
    });
    // Different solid colours make stale or leaked CUE frames detectable. The
    // second source is real p5 WebGL with an unpreserved drawing buffer.
    for (const [file, webgl, color] of [
      ['color_bars', false, '200, 20, 20'], ['gradient_wash', true, '20, 40, 200'],
    ]) {
      await context.route(`**/src/sketches/${file}.js`, async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        await route.fulfill({ response, body: source.slice(0, source.indexOf('export default')) + `
          export default (audio, video, params, runtimeContext = {}) => (p) => {
            p.setup = () => {
              p.createCanvas(p.windowWidth, p.windowHeight${webgl ? ', p.WEBGL' : ''});
              ${webgl ? 'p.setAttributes({ preserveDrawingBuffer: false });' : ''}
              p.frameRate(10); // Keep software GL free for screenshot readbacks.
            };
            p.draw = () => { runtimeContext.audioControls?.read(); p.background(${color}); };
            p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
          };
        ` });
      });
    }

    // Seed storage, then close the seeder: it counts as a control window and
    // the singleton coordinator would block the real panel below.
    const seeder = await context.newPage();
    await seedMapping(seeder, TRAPEZOID);
    await seeder.close();
    const screen = await context.newPage();
    await screen.setViewportSize({ width: 800, height: 450 });
    await screen.goto(SCREEN_URL);
    await screen.waitForSelector('#screen-wrap canvas');
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const transformBefore = await screen.evaluate(() => getComputedStyle(document.getElementById('screen-wrap')).transform);
    expect(transformBefore.startsWith('matrix3d')).toBe(true);

    const expectOutputColor = async (expected) => {
      await expect(screen.locator('#screen-mapping-output')).toHaveClass('is-active');
      await screen.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const shot = await screen.screenshot();
      const pixel = await screen.evaluate(async (b64) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
      }, shot.toString('base64'));
      expected.forEach((value, i) => expect(Math.abs(pixel[i] - value), JSON.stringify({ expected, pixel })).toBeLessThanOrEqual(3));
    };
    await expectOutputColor([200, 20, 20]);

    // Merge two patterns live (keys 1+2, exactly like merge-mode.spec.js)
    await control.keyboard.down('1');
    await control.keyboard.down('2');
    await control.keyboard.up('1');
    await control.keyboard.up('2');
    await expect(screen.locator('canvas.merge-canvas')).toHaveCount(2);
    await screen.waitForFunction(() => window.__viz.merge?.length === 2);
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', transformBefore);
    await expectOutputColor([110, 30, 110]);

    // The post-fx trim lands on the same wrapper; the warp is applied after it
    await control.waitForSelector('#post-fx-list input[data-key="brightness"]', { state: 'attached' });
    await control.evaluate(() => {
      const input = document.querySelector('#post-fx-list input[data-key="brightness"]');
      input.value = '25';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await screen.waitForFunction(() => document.getElementById('screen-wrap').style.filter.includes('brightness(1.25)'));
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', transformBefore);
    await expectOutputColor([138, 38, 138]);

    // CUE pattern 2 (Shift+2), wait for the session to be live in the panel,
    // then take it (Enter) — the warp survives the whole program swap.
    await control.keyboard.down('Shift');
    await control.keyboard.press('2');
    await control.keyboard.up('Shift');
    await expect(control.locator('#config-panel')).toHaveClass(/cue-active/, { timeout: 10_000 });
    await expectOutputColor([138, 38, 138]); // hidden blue CUE must not leak
    await control.keyboard.press('Enter');
    await expect(control.locator('#config-panel')).not.toHaveClass(/cue-active/, { timeout: 15_000 });
    await expect(screen.locator('canvas.merge-canvas')).toHaveCount(0);
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', transformBefore);
    await expectOutputColor([25, 50, 250]);
  });
});

// Check complete rasterized edges, not just corners or a few interior samples.
// The normal headless browser uses software compositing; explicitly exercise
// the GPU compositor too (SwiftShader makes that path available on Linux CI).
const gpuTest = test.extend({
  launchOptions: async ({ launchOptions }, use) => {
    await use({
      ...launchOptions,
      args: [
        ...(launchOptions.args || []),
        '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--enable-gpu-rasterization',
        '--ignore-gpu-blocklist',
      ],
    });
  },
});

for (const gpu of [false, true]) {
  const edgeTest = gpu ? gpuTest : test;
  edgeTest.describe(`screen mapping painted edges (${gpu ? 'GPU' : 'software'})`, () => {
    for (const { width, height, dpr } of [
      { width: 1920, height: 1080, dpr: 1 },
      { width: 3840, height: 2160, dpr: 1 },
      { width: 1920, height: 1080, dpr: 2 },
    ]) {
      edgeTest.describe(`${width}×${height} at DPR ${dpr}`, () => {
        edgeTest.use({ viewport: { width, height }, deviceScaleFactor: dpr });

        edgeTest('vertical and horizontal gaps have continuous straight edges', async ({ page, context, browser, browserName }, testInfo) => {
          await installMappingPattern(context);
          edgeTest.skip(browserName !== 'chromium' && gpu, 'GPU flags and diagnostics are Chromium-specific.');
          if (gpu) {
            const session = await browser.newBrowserCDPSession();
            const { gpu: info } = await session.send('SystemInfo.getInfo');
            await session.detach();
            expect(info.featureStatus.gpu_compositing).toBe('enabled');
          }

          // All sides are inset so toolbar pixels cannot masquerade as edges.
          const quad = [
            { x: 0.15, y: 0.13 }, { x: 0.91, y: 0.19 },
            { x: 0.88, y: 0.89 }, { x: 0.08, y: 0.8 },
          ];
          await seedMapping(page, quad);
          await page.goto(SCREEN_URL);
          await page.waitForSelector('#screen-wrap canvas');
          await expect(page.locator('#screen-mapping-output')).toHaveClass('is-active');

          for (const horizontal of [false, true]) {
            await page.evaluate(async (horizontal) => {
              window.__mappingPattern = { bars: 8, horizontal };
              // Also exercise end-of-chain post-processing. The renderer reads
              // the same live parameter bank as the CSS fallback.
              Object.assign(window.__viz.postfx, horizontal
                ? { brightness: 15, contrast: 10, saturation: -20 }
                : { brightness: 0, contrast: 0, saturation: 0 });
              await window.__redrawMappingPattern();
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }, horizontal);

            const boundaries = [];
            const size = horizontal ? height : width;
            for (let i = 0; i < 8; i += 1) {
              for (const position of [i / 8, (i + 1) / 8 - 8 / size]) {
                const points = horizontal ? [[0, position], [1, position]] : [[position, 0], [position, 1]];
                boundaries.push(points.map(([u, v]) => {
                  const point = expectedMappedPoint(quad, u, v, width, height);
                  return { x: point.x * dpr, y: point.y * dpr };
                }));
              }
            }

            const shot = await page.screenshot({ path: testInfo.outputPath(`${horizontal ? 'horizontal' : 'vertical'}-edges.png`) });
            const measured = await page.evaluate(async ({ b64, boundaries, horizontal }) => {
              const image = new Image();
              image.src = `data:image/png;base64,${b64}`;
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(image, 0, 0);
              const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              const scanAxis = horizontal ? 'x' : 'y';
              const edgeAxis = horizontal ? 'y' : 'x';
              const start = Math.ceil(Math.max(...boundaries.map(([a]) => a[scanAxis]))) + 4;
              const end = Math.floor(Math.min(...boundaries.map(([, b]) => b[scanAxis]))) - 4;
              const edgeLimit = horizontal ? canvas.height : canvas.width;
              let brokenScanlines = 0;
              let maxEdgeError = 0;
              for (let scan = start; scan <= end; scan += 1) {
                const edges = [];
                let previous = false;
                for (let edge = 0; edge < edgeLimit; edge += 1) {
                  const x = horizontal ? scan : edge;
                  const y = horizontal ? edge : scan;
                  const white = pixels[(y * canvas.width + x) * 4] > 128;
                  if (white !== previous) edges.push(edge);
                  previous = white;
                }
                if (edges.length !== boundaries.length) {
                  brokenScanlines += 1;
                  continue;
                }
                edges.forEach((edge, i) => {
                  const [a, b] = boundaries[i];
                  const t = (scan + 0.5 - a[scanAxis]) / (b[scanAxis] - a[scanAxis]);
                  const expected = a[edgeAxis] + t * (b[edgeAxis] - a[edgeAxis]);
                  maxEdgeError = Math.max(maxEdgeError, Math.abs(edge - expected));
                });
              }
              return { brokenScanlines, maxEdgeError, scanlines: end - start + 1 };
            }, { b64: shot.toString('base64'), boundaries, horizontal });

            expect(measured.scanlines).toBeGreaterThan(500);
            expect(measured.brokenScanlines, 'all bars and intentional gaps remain continuous').toBe(0);
            // A physical raster naturally has sub-pixel steps; multi-pixel
            // kinks, seams and broken segments are not acceptable.
            expect(measured.maxEdgeError, 'every boundary follows its projective straight line').toBeLessThanOrEqual(1);
          }
        });
      });
    }
  });
}

test.describe('screen mapping antialiasing', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('integrates edge coverage instead of leaving minified stair-steps', async ({ page, context }, testInfo) => {
    await installMappingPattern(context);
    const quad = [
      { x: 0.38, y: 0.09 }, { x: 0.61, y: 0.11 },
      { x: 0.93, y: 0.93 }, { x: 0.07, y: 0.9 },
    ];
    await seedMapping(page, quad);
    await page.goto(SCREEN_URL);
    await expect(page.locator('#screen-mapping-output')).toHaveClass('is-active');
    await page.evaluate(async () => {
      window.__mappingPattern = { bars: 24 };
      await window.__redrawMappingPattern();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const boundaries = [];
    for (let i = 0; i < 24; i += 1) {
      for (const x of [i * 80, i * 80 + 72]) {
        boundaries.push([0, 1].map((v) => expectedMappedPoint(quad, x / 1920, v, 1920, 1080)));
      }
    }
    const measure = async (name) => {
      const shot = await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      return page.evaluate(async ({ b64, boundaries }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${b64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, 1920, 1080).data;
        let samples = 0, error = 0, gray = 0, expectedGray = 0;
        let blackGaps = 0, gaps = 0;
        for (let y = 145; y < 940; y += 1) {
          const positions = boundaries.map(([a, b]) => a.x + (y + 0.5 - a.y) * (b.x - a.x) / (b.y - a.y));
          boundaries.forEach(([a, b], i) => {
            const x = Math.floor(positions[i]);
            // Independent geometric pixel-area reference: integrate a straight
            // edge over 64 subrows, not the implementation's 4x4 texture taps.
            let expected = 0;
            for (let j = 0; j < 64; j += 1) {
              const crossing = a.x + (y + (j + 0.5) / 64 - a.y) * (b.x - a.x) / (b.y - a.y);
              const leftCoverage = Math.min(1, Math.max(0, crossing - x));
              expected += (i % 2 ? leftCoverage : 1 - leftCoverage) / 64;
            }
            const value = pixels[(y * 1920 + x) * 4] / 255;
            error += Math.abs(expected - value);
            samples += 1;
            if (expected > 0.1 && expected < 0.9) {
              expectedGray += 1;
              if (value > 0.07 && value < 0.93) gray += 1;
            }
            if (i % 2 && i + 1 < positions.length) {
              const middle = Math.floor((positions[i] + positions[i + 1]) / 2);
              gaps += 1;
              if (pixels[(y * 1920 + middle) * 4] < 20) blackGaps += 1;
            }
          });
        }
        return { meanEdgeError: error / samples, smoothCoverage: gray / expectedGray, blackGaps: blackGaps / gaps };
      }, { b64: shot.toString('base64'), boundaries });
    };
    const antialiased = await measure('antialiased');
    // A/B against the exact previous CSS-only path using the same frozen frame.
    await page.evaluate(() => {
      document.getElementById('screen-mapping-output').classList.remove('is-active');
      document.getElementById('screen-wrap').classList.remove('is-antialiased');
    });
    const css = await measure('css-only');
    expect(antialiased.smoothCoverage, 'fractional edge pixels must actually be antialiased').toBeGreaterThan(0.98);
    expect(antialiased.meanEdgeError).toBeLessThan(0.04);
    expect(antialiased.meanEdgeError).toBeLessThan(css.meanEdgeError / 3);
    expect(antialiased.blackGaps, 'do not blur away the black gap centres').toBeGreaterThan(0.98);
  });

  test('off/on recreates AA for a noLoop source and context loss leaves a usable fallback', async ({ page, context }) => {
    await installMappingPattern(context);
    await seedMapping(page, ASYM);
    await page.goto(SCREEN_URL);
    const output = page.locator('#screen-mapping-output');
    await expect(output).toHaveClass('is-active');
    const toggle = async (enabled) => {
      await page.evaluate((enabled) => {
        const channel = new BroadcastChannel('viz2_channel');
        channel.postMessage({ type: 'screen-mapping', enabled, quad: window.__viz.screenMapping.quad });
        channel.close();
      }, enabled);
    };
    for (let i = 0; i < 3; i += 1) {
      await toggle(false);
      await expect(output.locator('canvas')).toHaveCount(0);
      await expect(page.locator('#screen-wrap')).toHaveCSS('transform', 'none');
      await toggle(true);
      await expect(output).toHaveClass('is-active');
      await expect(output.locator('canvas')).toHaveCount(1);
    }
    await output.locator('canvas').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await expect(output.locator('canvas')).toHaveCount(0);
    await expect(page.locator('#screen-wrap')).toHaveCSS('opacity', '1');
    expect(await page.evaluate(() => window.__viz.screenMapping.antialiasingError)).toMatch(/context lost/i);
    await expect(page.locator('#screen-wrap')).not.toHaveCSS('transform', 'none');
    await toggle(false);
    await toggle(true);
    await expect(output).toHaveClass('is-active');
  });
});
