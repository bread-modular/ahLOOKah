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

    // The pad is fixed and separate from the scrollable library
    await expect(control.locator('#pattern-pad')).toBeVisible();
    await expect(control.locator('#pattern-library')).toHaveCSS('overflow-y', 'auto');

    await expect(control.locator('#status-line .badge-control')).toBeVisible();
    // No p5 stage canvas in control mode — only the band-split EQ canvas
    await expect(control.locator('canvas')).toHaveCount(1);
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

  test('devices & setup section collapses via its header and persists', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const section = control.locator('#device-setup');
    // Fresh profile (no saved device): the section starts open
    await expect(section).toHaveAttribute('open', '');
    await expect(control.locator('#audio-select')).toBeVisible();
    await expect(control.locator('#takeover-btn')).toBeVisible();

    // Clicking the header collapses the section and hides the setup controls
    await section.locator('summary').click();
    await expect(section).not.toHaveAttribute('open', '');
    await expect(control.locator('#audio-select')).not.toBeVisible();

    // The collapsed state survives a reload
    await control.reload();
    await expect(control.locator('#device-setup')).not.toHaveAttribute('open', '');

    // And the header reopens it
    await control.locator('#device-setup summary').click();
    await expect(control.locator('#device-setup')).toHaveAttribute('open', '');
    await expect(control.locator('#takeover-btn')).toBeVisible();
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
    await source.scrollIntoViewIfNeeded();
    await source.dragTo(control.locator('#pattern-pad [data-index="0"]'));

    // Assignment persisted to the new slot-order key
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

  test('pad changes sync to other control windows', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    const control2 = await context.newPage();
    await control2.goto(CONTROL_URL);

    await control.locator('#pattern-pad [data-index="0"]').dragTo(control.locator('#pattern-pad [data-index="1"]'));
    await control.waitForFunction(
      () => JSON.parse(localStorage.getItem('viz2_slot_order') || '[]')[0] === 'circles-ch1'
    );

    // The second control window re-renders its pad to match the assignment
    await expect(control2.locator('#pattern-pad [data-index="0"]')).toHaveAttribute('data-id', 'circles-ch1');
    await expect(control2.locator('#pattern-pad [data-index="1"]')).toHaveAttribute('data-id', 'circles');
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

  test('take over as screen demotes the old screen', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // original screen
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.click('#takeover-btn');

    // Control window becomes the new screen (scope to the p5 canvas — the
    // band-split EQ canvas from the panel days stays in the DOM)
    await expect(control.locator('body')).toHaveClass(/is-screen/);
    await expect(control.locator('canvas.p5Canvas')).toBeVisible();
    await control.waitForFunction(() => window.__viz.role === 'screen');

    // Old screen is demoted to a control panel
    await expect(page.locator('body')).toHaveClass(/is-control/);
    await expect(page.locator('#config-panel')).toBeVisible();
    await page.waitForFunction(() => window.__viz.role === 'control');
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

test.describe('effects pane divider resize', () => {
  const cols = (page) =>
    page.locator('.library-group-grid').first().evaluate((el) => {
      const t = getComputedStyle(el).gridTemplateColumns;
      return t.split(' ').filter(Boolean).length;
    });

  test('divider drag resizes the pane, adds library columns, and persists', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const pane = control.locator('#effects-pane');
    await expect(pane).toHaveCSS('width', '460px');
    expect(await cols(control)).toBe(2);

    // Drag the divider 200px to the right
    const resizer = control.locator('#effects-resizer');
    const box = await resizer.boundingBox();
    await control.mouse.move(box.x + box.width / 2, box.y + 100);
    await control.mouse.down();
    await control.mouse.move(box.x + box.width / 2 + 200, box.y + 100, { steps: 5 });
    await control.mouse.up();

    // Pane widened + more columns fit per row (each stays >= 200px wide)
    await expect(pane).toHaveCSS('width', '660px');
    expect(await cols(control)).toBe(3);

    // Persisted across reloads
    await control.waitForFunction(() => localStorage.getItem('viz2_effects_width') === '660');
    await control.reload();
    await expect(control.locator('#effects-pane')).toHaveCSS('width', '660px');
  });

  test('divider drag far left clamps at the 2-column pad floor — no overflow onto the divider/controls', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const pane = control.locator('#effects-pane');
    await expect(pane).toHaveCSS('width', '460px');

    // Drag the divider far to the left
    const resizer = control.locator('#effects-resizer');
    const box = await resizer.boundingBox();
    await control.mouse.move(box.x + box.width / 2, box.y + 100);
    await control.mouse.down();
    await control.mouse.move(box.x + box.width / 2 - 600, box.y + 100, { steps: 10 });
    await control.mouse.up();

    // Pane stops at the pad floor (2 x 200px buttons + 6px gap + 40px padding);
    // the divider stops with it instead of letting content slide over.
    await expect(pane).toHaveCSS('width', '446px');

    // Regression: no pad button may extend past the pane's right edge
    // (previously the grid's min-width:auto columns overflowed onto the
    // divider and the controls pane).
    const withinPane = await control.evaluate(() => {
      const paneEl = document.querySelector('#effects-pane');
      const paneRight = paneEl.getBoundingClientRect().right;
      return [...document.querySelectorAll('#pattern-pad .pattern-btn')].every(
        (b) => b.getBoundingClientRect().right <= paneRight + 0.5
      );
    });
    expect(withinPane).toBe(true);
  });
});

test.describe('default UI + opening screens', () => {
  test('the root URL boots as a control panel (default UI)', async ({ page }) => {
    await page.goto('/');

    // No role param -> the control panel is the default window
    await expect(page.locator('body')).toHaveClass(/is-control/);
    await expect(page.locator('#config-panel')).toBeVisible();
    await page.waitForFunction(() => window.__viz.role === 'control');

    // No fullstage p5 canvas in control mode — only the band-split EQ canvas
    await expect(page.locator('canvas.p5Canvas')).toHaveCount(0);

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
