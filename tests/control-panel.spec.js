import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

// All multi-window tests use pages from the SAME context, because
// BroadcastChannel + localStorage are shared per browser context (tab group).

test.describe('screen window', () => {
  test('boots with canvas and a hover-only control button', async ({ page }) => {
    await page.goto(SCREEN_URL);

    await expect(page.locator('body')).toHaveClass(/is-screen/);
    await expect(page.locator('canvas')).toBeVisible();

    const btn = page.locator('#open-control-btn');
    await expect(btn).toHaveCSS('opacity', '0');

    // Hovering the top-right zone reveals the button
    await page.hover('#screen-toolbar');
    await expect(btn).toHaveCSS('opacity', '1');
  });

  test('keyboard 1-0 in the control panel switches patterns on the screen', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Keys typed in the control panel drive the screen...
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.pattern === 2);
    await control.keyboard.press('0');
    await page.waitForFunction(() => window.__viz.pattern === 9);

    // ...and keys on the screen window are ignored
    await page.keyboard.press('1');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__viz.pattern)).toBe(9);
  });
});

test.describe('control panel window', () => {
  test('renders a 10-slot pad with 1-0 badges and a grouped library of all 58 patterns', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await expect(control.locator('body')).toHaveClass(/is-control/);

    // Fixed pad: exactly 10 slots carrying key badges 1..9,0
    const slots = control.locator('#pattern-pad .pattern-btn');
    await expect(slots).toHaveCount(10);
    await expect(slots.nth(0).locator('.pattern-key')).toHaveText('1');
    await expect(slots.nth(8).locator('.pattern-key')).toHaveText('9');
    await expect(slots.nth(9).locator('.pattern-key')).toHaveText('0');

    // Default pad = first 10 declaration patterns
    await expect(control.locator('#pattern-pad [data-index="0"]')).toHaveAttribute('data-id', 'circles');
    await expect(control.locator('#pattern-pad [data-index="9"]')).toHaveAttribute('data-id', 'chroma-mandala');

    // Library: all 58 patterns grouped under 7 headers (52 registered + 6
    // camera-input Video FX effects surfaced in the library)
    const items = control.locator('#pattern-library .pattern-btn');
    await expect(items).toHaveCount(58);
    const headers = control.locator('.library-group-header');
    await expect(headers).toHaveCount(7);
    await expect(headers.first()).toHaveText('Rhythmic');
    await expect(headers.last()).toHaveText('Basics');

    // The Video FX group lists all 6 camera effects, each marked with a
    // camera glyph; Glitch / Effects holds 5
    const vfx = control.locator('.library-group', { hasText: 'Video FX' });
    await expect(vfx.locator('.pattern-btn')).toHaveCount(6);
    await expect(vfx.locator('.camera-badge')).toHaveCount(6);
    const glitch = control.locator('.library-group', { hasText: 'Glitch / Effects' });
    await expect(glitch.locator('.pattern-btn')).toHaveCount(5);

    // Assigned patterns show a slot-number badge; unassigned ones don't
    await expect(control.locator('#pattern-library [data-id="circles"] .slot-badge')).toHaveText('1');
    await expect(control.locator('#pattern-library [data-id="plasma-waves"] .slot-badge')).toHaveCount(0);

    // The first column stays fixed while the library gets its own scroll area.
    await expect(control.locator('#pattern-pad')).toBeVisible();
    await expect(control.locator('#preview-pane')).toHaveCSS('overflow-y', 'hidden');
    await expect(control.locator('#pattern-library')).toHaveCSS('overflow-y', 'auto');
    await expect(control.locator('#preview-stage canvas')).toBeVisible();

    await expect(control.locator('#status-line .badge-control')).toHaveCount(0);
    await expect(control.locator('#status-line .viz-pill')).toHaveCount(1);
    await expect(control.locator('.viz-control-header')).toBeVisible();
    // Control mode now has a real p5 preview plus the band-split EQ canvas.
    await expect(control.locator('canvas')).toHaveCount(2);
    await expect(control.locator('#band-eq-canvas')).toBeVisible();
  });

  test('opens from the screen toolbar button', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    await page.hover('#screen-toolbar');

    const popupPromise = context.waitForEvent('page');
    await page.click('#open-control-btn');
    const control = await popupPromise;
    await control.waitForLoadState();

    expect(control.url()).toContain('role=control');
    await expect(control.locator('#config-panel')).toBeVisible();
  });

  test('header menu exposes Docs, Key Map, and Setup', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Hamburger button sits in the header and starts closed.
    const menuBtn = control.locator('#app-menu-btn');
    await expect(menuBtn).toBeVisible();
    const menuList = control.locator('#app-menu-list');
    await expect(menuList).toBeHidden();

    // Clicking the button opens the dropdown with all three items.
    await menuBtn.click();
    await expect(menuList).toBeVisible();
    await expect(control.locator('#app-menu-docs')).toHaveText('Docs');
    await expect(control.locator('#app-menu-keymap')).toHaveText('Key Map');
    await expect(control.locator('#app-menu-setup')).toHaveText('Setup');

    // Key Map opens the read-only shortcuts modal.
    await control.locator('#app-menu-keymap').click();
    await expect(control.locator('#key-map-modal')).toBeVisible();
    await expect(control.locator('#key-map-modal-title')).toHaveText('Key Map');
    await control.locator('#key-map-modal-close').click();
    await expect(control.locator('#key-map-modal')).toBeHidden();

    // Setup opens the device setup modal.
    await menuBtn.click();
    await control.locator('#app-menu-setup').click();
    await expect(control.locator('#device-setup-modal')).toBeVisible();
    await control.locator('#device-setup-modal-close').click();
    await expect(control.locator('#device-setup-modal')).toBeHidden();
  });
});

test.describe('pattern pad + library interactions', () => {
  test('clicking a pad slot plays that pattern and highlights the slot', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.locator('#pattern-pad [data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);
    await expect(control.locator('#pattern-pad [data-index="2"]')).toHaveClass(/active/);
    await expect(control.locator('#pattern-pad [data-index="0"]')).not.toHaveClass(/active/);
  });

  test('clicking an unassigned library pattern plays it by id', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // plasma-waves is NOT on the default pad (16th in declaration order)
    await control.locator('#pattern-library [data-id="plasma-waves"]').click();
    await page.waitForFunction(() => window.__viz.patternId === 'plasma-waves');
    await expect(control.locator('#pattern-library [data-id="plasma-waves"]')).toHaveClass(/active/);
    // No pad slot highlights for a library-only pattern
    await expect(control.locator('#pattern-pad .pattern-btn.active')).toHaveCount(0);
  });

  test('dragging a library pattern onto a pad slot assigns it and persists', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // echo-ripples sits near the top of the first group and is unassigned by default
    const source = control.locator('#pattern-library [data-id="echo-ripples"]');
    const target = control.locator('#pattern-pad [data-index="0"]');
    // Wait for pad+library to finish rAF-coalesced init so drag listeners exist
    await expect(control.locator('#pattern-pad .pattern-btn')).toHaveCount(10);
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(58);
    await expect(target).toHaveAttribute('data-id', 'circles');
    await expect(source).toBeVisible();
    await source.scrollIntoViewIfNeeded();
    // Also ensure the target is in view (pad is fixed but be explicit)
    await target.scrollIntoViewIfNeeded();

    // Retry dragTo — HTML5 DND via Playwright is racy under load; retry up to 3 times
    let assigned = false;
    for (let attempt = 0; attempt < 3 && !assigned; attempt++) {
      await source.dragTo(target);
      try {
        await expect(target).toHaveAttribute('data-id', 'echo-ripples', { timeout: 5_000 });
        assigned = true;
      } catch {
        if (attempt < 2) await control.waitForTimeout(250);
      }
    }
    // Final hard assertion (auto-retrying locator) survives load jitter — do not weaken
    await expect(target).toHaveAttribute('data-id', 'echo-ripples', { timeout: 15_000 });
    // Assignment persisted to the new slot-order key (poll with retries under load)
    await expect.poll(async () => {
      return await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_slot_order') || '[]'));
    }, { timeout: 15_000 }).toEqual(expect.arrayContaining(['echo-ripples']));
    await control.waitForFunction(() => {
      const order = JSON.parse(localStorage.getItem('viz2_slot_order') || '[]');
      return order.length === 10 && order[0] === 'echo-ripples';
    });
    await expect(control.locator('#pattern-pad [data-index="0"]')).toHaveAttribute('data-id', 'echo-ripples');
    await expect(control.locator('#pattern-pad [data-index="0"] .pattern-name')).toContainText('Echo Ripples');
  });

  test('dragging a slot onto another slot swaps them', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Default pad: slot 0 = circles, slot 5 = neon-spectrum
    await control.locator('#pattern-pad [data-index="0"]').dragTo(control.locator('#pattern-pad [data-index="5"]'));

    await control.waitForFunction(() => {
      const order = JSON.parse(localStorage.getItem('viz2_slot_order') || '[]');
      return order[0] === 'neon-spectrum' && order[5] === 'circles';
    });
    await expect(control.locator('#pattern-pad [data-index="0"]')).toHaveAttribute('data-id', 'neon-spectrum');
    await expect(control.locator('#pattern-pad [data-index="5"]')).toHaveAttribute('data-id', 'circles');
  });

  test('slot order survives a reload', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.locator('#pattern-pad [data-index="0"]').dragTo(control.locator('#pattern-pad [data-index="1"]'));
    await control.waitForFunction(
      () => JSON.parse(localStorage.getItem('viz2_slot_order') || '[]')[0] === 'circles-ch1'
    );

    await control.reload();
    await expect(control.locator('#pattern-pad [data-index="0"]')).toHaveAttribute('data-id', 'circles-ch1');
    await expect(control.locator('#pattern-pad [data-index="1"]')).toHaveAttribute('data-id', 'circles');
  });

  test('second control window is blocked (singleton)', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await expect(control.locator('#config-panel')).toBeVisible();
    await control.waitForFunction(() => window.__viz && !window.__viz.singletonBlocked);

    const control2 = await context.newPage();
    await control2.goto(CONTROL_URL);
    // Second control with same role must show blocking error and not render panel/canvas
    await expect(control2.locator('#singleton-error')).toBeVisible({ timeout: 7000 });
    await expect(control2.locator('#singleton-error')).toContainText('Control Panel Already Open');
    await expect(control2.locator('#singleton-error')).toContainText('direct URL');
    await expect(control2.locator('#config-panel')).toHaveCount(0);
    await expect(control2.locator('#preview-stage canvas')).toHaveCount(0);

    // Direct reload still blocked while first is alive
    await control2.reload();
    await expect(control2.locator('#singleton-error')).toBeVisible();

    // Closing the first control frees the lease; second can reload and become the singleton
    await control.close();
    await control2.reload();
    await expect(control2.locator('#config-panel')).toBeVisible();
    await expect(control2.locator('#singleton-error')).toHaveCount(0);
  });

  test('legacy viz2_effect_order migrates into the first 10 pad slots', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Simulate a pre-pad build: legacy full order, no slot order yet
    await control.evaluate(() => {
      localStorage.removeItem('viz2_slot_order');
      localStorage.setItem(
        'viz2_effect_order',
        JSON.stringify([
          'bars', 'circles', 'laser-grid', 'solid-color', 'techno3d',
          'aurora-veil', 'event-horizon', 'prism-burst', 'glitch-matrix', 'checkerboard',
          'neon-metropolis', 'film-grain',
        ])
      );
    });
    await control.reload();

    // First 10 valid legacy ids seed the pad
    await expect(control.locator('#pattern-pad [data-index="0"]')).toHaveAttribute('data-id', 'bars');
    await expect(control.locator('#pattern-pad [data-index="1"]')).toHaveAttribute('data-id', 'circles');
    await expect(control.locator('#pattern-pad [data-index="9"]')).toHaveAttribute('data-id', 'checkerboard');
  });
});

test.describe('effect parameters', () => {
  test('sliders render for the selected effect and drive the screen live', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Bars (slot 2) exposes 3 params: gain, barWidth, flash
    await control.locator('#pattern-pad [data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);

    await expect(control.locator('#params-list .param-row')).toHaveCount(3);
    await expect(control.locator('#params-list label').first()).toContainText('Gain');

    // Drag the gain slider to max — the screen's live params update
    await control.locator('#params-list input[data-key="gain"]').evaluate((el) => {
      el.value = '3';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__viz.params.gain === 3);

    // Switching effects swaps the slider set (Pulse Rings has 4 params)
    await control.locator('#pattern-pad [data-index="6"]').click();
    await expect(control.locator('#params-list .param-row')).toHaveCount(4);
    await expect(control.locator('#params-list input[data-key="rings"]')).toBeVisible();

    // Param values persist per-effect (Bars gain is still 3 after switching back)
    await control.locator('#pattern-pad [data-index="2"]').click();
    await expect(control.locator('#params-list input[data-key="gain"]')).toHaveValue('3');
  });

  test('an effect without params shows an empty hint', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // All registered effects currently have params; pick slot 2 anyway and
    // assert the list exists. (Guards against regressions in the renderer.)
    await control.locator('#pattern-pad [data-index="2"]').click();
    await expect(control.locator('#params-list')).toBeVisible();
  });
});

test.describe('screen <-> control interaction', () => {
  test('pattern buttons drive the screen sketch and stay highlighted', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.locator('#pattern-pad [data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);
    await expect(control.locator('#pattern-pad [data-index="2"]')).toHaveClass(/active/);

    await control.locator('#pattern-pad [data-index="9"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 9);
    await expect(control.locator('#pattern-pad [data-index="9"]')).toHaveClass(/active/);
    await expect(control.locator('#pattern-pad [data-index="2"]')).not.toHaveClass(/active/);
  });

  test('shows OFFLINE badge when the screen window closes', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Wait until the control has synced with the live screen
    await expect(control.locator('#status-line .badge-online')).toBeVisible();

    await page.close({ runBeforeUnload: true });

    await expect(control.locator('#status-line .badge-offline')).toBeVisible();
  });
});

test.describe('param slider interactions (e2e)', () => {
  // Open the screen + a control panel, select Bars (slot 2)
  async function openBars(context, page) {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.locator('#pattern-pad [data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);
    return control;
  }

  // Read the persisted param store without touching the live object
  // (touching window.__viz.params.* would pollute the sketch read-log probe).
  // Params are keyed by sketch id (see sketch-registry SKETCHES entries).
  function storedGain(page, min) {
    return page.waitForFunction((m) => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return stored.bars && stored.bars.gain >= m;
    }, min);
  }

  test('dragging the slider thumb applies the value live on the screen', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="gain"]');
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();

    // gain range 0.2..3, default 1 → thumb sits at ~28.6% of the track
    const frac = (1 - 0.2) / (3 - 0.2);
    const startX = box.x + frac * box.width;
    const y = box.y + box.height / 2;

    await control.mouse.move(startX, y);
    await control.mouse.down();
    // Multi-step interpolated drag — this must keep driving the native range
    // thumb. (Regression: the params list used to re-render on the first
    // input event, destroying the slider mid-drag after a single step.)
    await control.mouse.move(box.x + box.width - 4, y, { steps: 5 });
    await control.mouse.up();

    // The drag reaches the high end and lands on the screen window
    await storedGain(page, 2.5);
    expect(parseFloat(await slider.inputValue())).toBeGreaterThan(2.5);
  });

  test('the slider element is not re-rendered mid-drag', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="gain"]');
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();

    // Tag the DOM node so we can detect the params list replacing it
    await slider.evaluate((el) => { el.__dragProbe = 'original'; });

    const frac = (1 - 0.2) / (3 - 0.2);
    const y = box.y + box.height / 2;
    await control.mouse.move(box.x + frac * box.width, y);
    await control.mouse.down();
    await control.mouse.move(box.x + box.width * 0.8, y, { steps: 5 });
    await control.mouse.up();

    // Same DOM node (a re-render would have replaced it with an untagged one)
    const probe = await control
      .locator('#params-list input[data-key="gain"]')
      .evaluate((el) => el.__dragProbe);
    expect(probe).toBe('original');
    expect(parseFloat(await slider.inputValue())).toBeGreaterThan(2);
  });

  test('clicking on the track jumps the value and applies it', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="barWidth"]');
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();

    // Click at 75% of the track (barWidth range 2..16 → lands ≈12-13)
    await control.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);

    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return stored.bars && stored.bars.barWidth >= 12;
    });
  });

  test('the running sketch re-reads params every frame (realtime, no reload)', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="gain"]');
    const box = await slider.boundingBox();

    const frac = (1 - 0.2) / (3 - 0.2);
    const startX = box.x + frac * box.width;
    const y = box.y + box.height / 2;

    // Drag partway WITHOUT releasing — the value must already be live
    await control.mouse.move(startX, y);
    await control.mouse.down();
    await control.mouse.move(box.x + box.width * 0.6, y, { steps: 1 });
    await storedGain(page, 1.5);

    // The sketch itself must read 'gain' off the live object every frame.
    // (DEV readLog: key -> last read timestamp. Before the per-frame fix the
    // log went stale after setup, so this assertion timed out.)
    await page.waitForFunction(() => {
      const log = window.__viz.readLog() || {};
      const t = log.gain;
      return typeof t === 'number' && performance.now() - t < 500;
    });

    await control.mouse.up();
  });
});

test.describe('three-column control layout', () => {
  test('keeps the preview and 1–0 pad fixed while library and controls scroll without horizontal overflow', async ({ context }) => {
    const control = await context.newPage();
    await control.setViewportSize({ width: 1260, height: 760 });
    await control.goto(CONTROL_URL);

    await expect(control.locator('#preview-pane')).toBeVisible();
    await expect(control.locator('#library-pane')).toBeVisible();
    await expect(control.locator('#controls-pane')).toBeVisible();
    await expect(control.locator('#preview-stage canvas')).toBeVisible();

    const desktop = await control.evaluate(() => {
      const panel = document.querySelector('#config-panel');
      const preview = document.querySelector('#preview-pane');
      const library = document.querySelector('#library-pane');
      const controls = document.querySelector('#controls-pane');
      const stage = document.querySelector('#preview-stage');
      const canvas = stage.querySelector('canvas');
      const panelColumns = getComputedStyle(panel).gridTemplateColumns.split(' ').filter(Boolean);
      const stageRect = stage.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      return {
        columns: panelColumns.length,
        previewOverflow: getComputedStyle(preview).overflowY,
        libraryOverflow: getComputedStyle(document.querySelector('#pattern-library')).overflowY,
        controlsOverflow: getComputedStyle(controls).overflowY,
        ordered: preview.getBoundingClientRect().right <= library.getBoundingClientRect().left + 0.5
          && library.getBoundingClientRect().right <= controls.getBoundingClientRect().left + 0.5,
        canvasInsidePreview: canvasRect.left >= stageRect.left - 0.5
          && canvasRect.right <= stageRect.right + 0.5
          && canvasRect.top >= stageRect.top - 0.5
          && canvasRect.bottom <= stageRect.bottom + 0.5,
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth
          && document.body.scrollWidth <= document.body.clientWidth
          && panel.scrollWidth <= panel.clientWidth,
      };
    });

    expect(desktop.columns).toBe(3);
    expect(desktop.previewOverflow).toBe('hidden');
    expect(desktop.libraryOverflow).toBe('auto');
    expect(desktop.controlsOverflow).toBe('auto');
    expect(desktop.ordered).toBe(true);
    expect(desktop.canvasInsidePreview).toBe(true);
    expect(desktop.noHorizontalOverflow).toBe(true);

    // The same guarantee holds when all three columns have to compress.
    await control.setViewportSize({ width: 700, height: 600 });
    await control.waitForTimeout(100);
    const narrowHasNoHorizontalOverflow = await control.evaluate(() => {
      const panel = document.querySelector('#config-panel');
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth
        && document.body.scrollWidth <= document.body.clientWidth
        && panel.scrollWidth <= panel.clientWidth;
    });
    expect(narrowHasNoHorizontalOverflow).toBe(true);
  });

  test('the embedded renderer follows selected 2D and WebGL patterns', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await expect(control.locator('#preview-stage canvas[data-preview-sketch="circles"]')).toBeVisible();

    // Techno 3D is a genuine WEBGL sketch. The control preview must render the
    // same factory into the clipped panel stage rather than a static thumbnail.
    await control.locator('#pattern-pad [data-index="3"]').click();
    const preview = control.locator('#preview-stage canvas[data-preview-sketch="techno3d"]');
    await expect(preview).toBeVisible();
    expect(await preview.evaluate((canvas) => Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')))).toBe(true);

    // Library-only patterns also replace the live preview.
    await control.locator('#pattern-library [data-id="plasma-waves"]').click();
    await expect(control.locator('#preview-stage canvas[data-preview-sketch="plasma-waves"]')).toBeVisible();
  });
});

test.describe('default UI + opening screens', () => {
  test('the root URL boots as a control panel (default UI)', async ({ page }) => {
    await page.goto('/');

    // No role param -> the control panel is the default window
    await expect(page.locator('body')).toHaveClass(/is-control/);
    await expect(page.locator('#config-panel')).toBeVisible();
    await page.waitForFunction(() => window.__viz.role === 'control');

    // Control mode owns one clipped p5 preview canvas, not a full-screen stage.
    await expect(page.locator('#preview-stage canvas.p5Canvas')).toHaveCount(1);

    // With no screen open yet the status reads SCREEN OFFLINE and the
    // Open Screen action sits beside it
    await expect(page.locator('#status-line .badge-offline')).toBeVisible();
    await expect(page.locator('#status-line #open-screen-btn')).toBeVisible();
  });

  test('Open Screen button beside the SCREEN status opens a new screen window', async ({ context, page }) => {
    await page.goto('/'); // control panel (default UI)

    const popupPromise = context.waitForEvent('page');
    await page.click('#open-screen-btn');
    const screen = await popupPromise;
    await screen.waitForLoadState();

    expect(screen.url()).toContain('role=screen');
    await expect(screen.locator('body')).toHaveClass(/is-screen/);
    await expect(screen.locator('canvas.p5Canvas')).toBeVisible();
    await screen.waitForFunction(() => window.__viz.role === 'screen');

    // The panel flips its SCREEN badge to ONLINE once the new screen announces
    await expect(page.locator('#status-line .badge-online')).toBeVisible();
  });
});
