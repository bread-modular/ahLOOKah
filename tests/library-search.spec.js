import fs from 'node:fs';
import { test, expect } from '@playwright/test';

// E2E: pattern-library search and favourites.
//
// Both are control-panel UI state stored in localStorage
// (`viz2_library_favourites`, alongside `viz2_library_collapsed`), so every test
// starts from the empty profile Playwright gives each context. The library keeps
// rendering all 70 patterns when nothing is favourited — only the Favourites
// mirror adds rows — which keeps the existing "10 groups / 70 items" assertions
// in control-panel.spec.js valid.

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';
const FAVOURITES_KEY = 'viz2_library_favourites';

async function openControl(context) {
  const control = await context.newPage();
  await control.goto(CONTROL_URL);
  await expect(control.locator('#config-panel')).toBeVisible();
  await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(70);
  return control;
}

function search(control) {
  return control.locator('#library-search');
}

test.describe('pattern library search', () => {
  test('filters by name, reports the match count, and clearing restores every group', async ({ context }) => {
    const control = await openControl(context);
    await expect(control.locator('.library-group')).toHaveCount(10);

    await search(control).fill('ripple lattice');
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(1);
    await expect(control.locator('#pattern-library [data-id="ripple-lattice"]')).toBeVisible();
    await expect(control.locator('.library-search-status')).toHaveText('1 of 70 patterns');
    // Groups without a match are not rendered at all while searching.
    await expect(control.locator('.library-group')).toHaveCount(1);
    await expect(control.locator('#library-section-Simple')).toHaveCount(0);

    // Terms are ANDed, so a second term narrows instead of widening.
    await search(control).fill('ripple lattice nonsense');
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(0);

    // The id is searchable in both spellings.
    await search(control).fill('ripple-lattice');
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(1);
    await expect(control.locator('#pattern-library [data-id="ripple-lattice"]')).toBeVisible();

    // Groups stay open while a query is active, so the header toggle is inert:
    // it must not persist a collapse the operator cannot see.
    const rhythmicToggle = control.locator('.library-group-toggle', { hasText: 'Rhythmic' });
    await expect(rhythmicToggle).toBeDisabled();
    await rhythmicToggle.evaluate((el) => el.click()); // disabled form controls are click-disabled
    await expect(control.locator('#library-section-Rhythmic')).toBeVisible();
    expect(await control.evaluate(() => localStorage.getItem('viz2_library_collapsed'))).toBeNull();

    await control.locator('#library-search-clear').click();
    await expect(search(control)).toHaveValue('');
    await expect(control.locator('.library-group')).toHaveCount(10);
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(70);
    await expect(control.locator('.library-search-status')).toHaveCount(0);
    await expect(control.locator('.library-empty')).toHaveCount(0);
  });

  test('the "/" shortcut stands down for dialogs, other fields, and "?"', async ({ context }) => {
    const control = await openControl(context);

    // An open dialog owns the keyboard: `/` must not reach the library behind it.
    await control.locator('#app-menu-btn').click();
    await control.locator('#app-menu-keymap').click();
    await expect(control.locator('#key-map-modal')).toBeVisible();
    await control.keyboard.press('/');
    await expect(search(control)).not.toBeFocused();
    await expect(search(control)).toHaveValue('');
    await control.locator('#key-map-modal-close').click();
    await expect(control.locator('#key-map-modal')).toHaveCount(0);

    // Closed dialog: the shortcut works again, and Escape leaves the field.
    await control.keyboard.press('/');
    await expect(search(control)).toBeFocused();
    await control.keyboard.press('Escape');
    await expect(search(control)).not.toBeFocused();

    // Typing "?" is a character, never the shortcut (real keyboards report
    // key === '?' for Shift+/; Playwright's `Shift+/` form synthesizes key '/'
    // with shift, which is the layout-needing-shift case the guard allows).
    await control.keyboard.press('?');
    await expect(search(control)).not.toBeFocused();
    await expect(search(control)).toHaveValue('');
  });

  test('the "/" shortcut focuses the search field and typing stays in the field', async ({ context }) => {
    const control = await openControl(context);
    const before = await control.evaluate(() => window.__viz.patternId);

    await control.keyboard.press('/');
    await expect(search(control)).toBeFocused();

    // Digits are pad shortcuts only outside text fields: typing "3" must filter
    // (here: no match) instead of switching the live pattern.
    await control.keyboard.type('3');
    await expect(search(control)).toHaveValue('3');
    expect(await control.evaluate(() => window.__viz.patternId)).toBe(before);

    // Escape clears the query (and does not blur on the first press).
    await control.keyboard.press('Escape');
    await expect(search(control)).toHaveValue('');
    await expect(search(control)).toBeFocused();

    // A second Escape leaves the field.
    await control.keyboard.press('Escape');
    await expect(search(control)).not.toBeFocused();
  });

  test('matches type keywords and reveals collapsed groups without rewriting them', async ({ context }) => {
    const control = await openControl(context);
    const cameraBadges = await control.locator('#pattern-library .camera-badge').count();
    expect(cameraBadges).toBeGreaterThan(0);

    // Collapse the group that holds the matches: searching must reveal them
    // without touching the saved collapse state.
    await control.locator('.library-group-toggle', { hasText: 'Video FX' }).click();
    await expect(control.locator('#library-section-Video-FX')).toBeHidden();
    expect(await control.evaluate(() => localStorage.getItem('viz2_library_collapsed'))).toBe('["Video FX"]');

    // "camera" is a type keyword for every camera-input pattern, so it finds
    // exactly the patterns that carry the camera badge.
    await search(control).fill('camera');
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(cameraBadges);
    await expect(control.locator('#pattern-library [data-id="video-thermal"]')).toBeVisible();
    await expect(control.locator('.library-group-toggle', { hasText: 'Video FX' })).toHaveAttribute('aria-expanded', 'true');

    // Group names are searchable too.
    await search(control).fill('cinematic');
    await expect(control.locator('.library-group-toggle', { hasText: 'Cinematic / Shaders' })).toBeVisible();
    await expect(control.locator('#pattern-library [data-id="liquid-chrome"]')).toBeVisible();

    await control.locator('#library-search-clear').click();
    await expect(control.locator('#library-section-Video-FX')).toBeHidden();
    await expect(control.locator('.library-group-toggle', { hasText: 'Video FX' })).toHaveAttribute('aria-expanded', 'false');
    expect(await control.evaluate(() => localStorage.getItem('viz2_library_collapsed'))).toBe('["Video FX"]');
  });

  test('an unmatched query shows an empty state with a clear action', async ({ context }) => {
    const control = await openControl(context);

    await search(control).fill('zzzz');
    await expect(control.locator('.library-empty')).toBeVisible();
    await expect(control.locator('.library-group')).toHaveCount(0);
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(0);
    await expect(control.locator('.library-search-status')).toHaveCount(0);

    await control.locator('.library-empty-clear').click();
    await expect(search(control)).toHaveValue('');
    await expect(control.locator('.library-group')).toHaveCount(10);
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(70);
  });

  test('Enter and Escape inside the search field never take or drop a staged cue', async ({ context, page }) => {
    test.setTimeout(45_000);
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.patternId === 'circles');
    await control.waitForFunction(() => window.__viz.screenOnline === true);

    // Stage a CUE from the Favourites mirror (the star must not break Shift-click).
    await control.getByRole('button', { name: 'Add Bars to favourites' }).click();
    const mirrorBars = control.locator('#library-section-Favourites [data-id="bars"]');
    await expect(mirrorBars).toBeVisible();
    await mirrorBars.click({ modifiers: ['Shift'] });
    await expect(control.locator('#cue-preview-controls')).toBeVisible();

    await search(control).click();
    await search(control).fill('bars');
    await control.keyboard.press('Enter');

    // Still staged: the keystroke belonged to the field, not to GO LIVE.
    await expect(control.locator('#cue-preview-controls')).toBeVisible();
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');

    // Escape inside the field clears the query instead of cancelling the cue.
    await control.keyboard.press('Escape');
    await expect(search(control)).toHaveValue('');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();

    // With focus outside a text field, Escape cancels the cue as before.
    await control.locator('#library-pane h3').click();
    await control.keyboard.press('Escape');
    await expect(control.locator('#cue-preview-controls')).toBeHidden();
  });

  test('Enter on a utility button activates it instead of taking a staged cue live', async ({ context, page }) => {
    test.setTimeout(45_000);
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.patternId === 'circles');
    await control.waitForFunction(() => window.__viz.screenOnline === true);

    await control.locator('#pattern-library [data-id="bars"]').click({ modifiers: ['Shift'] });
    await expect(control.locator('#cue-preview-controls')).toBeVisible();

    // A focused favourite star: Enter toggles the star, never GO LIVE.
    const star = control.getByRole('button', { name: 'Add Bars to favourites' });
    await star.focus();
    await control.keyboard.press('Enter');
    await expect(control.locator('#library-section-Favourites [aria-label="Remove Bars from favourites"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');

    // Both Clear-search buttons: Enter clears/refocuses, never GO LIVE.
    await search(control).fill('bars');
    await control.locator('#library-search-clear').focus();
    await control.keyboard.press('Enter');
    await expect(search(control)).toHaveValue('');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();

    await search(control).fill('zzzz');
    await control.locator('.library-empty-clear').focus();
    await control.keyboard.press('Enter');
    await expect(search(control)).toHaveValue('');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');

    // The global gesture is untouched: focus off those controls, Enter takes.
    await control.locator('#library-pane h3').click();
    await control.keyboard.press('Enter');
    await page.waitForFunction(() => window.__viz.patternId === 'bars', null, { timeout: 20_000 });
    await expect(control.locator('#cue-preview-controls')).toBeHidden();
  });
});

test.describe('pattern library favourites', () => {
  test('starring a pattern pins it in a Favourites group on top and persists', async ({ context }) => {
    const control = await openControl(context);

    await control.getByRole('button', { name: 'Add Circles to favourites' }).click();

    const favouritesGroup = control.locator('.library-group').first();
    await expect(favouritesGroup.locator('.library-group-toggle')).toHaveText('Favourites');
    await expect(control.locator('#library-section-Favourites [data-id="circles"]')).toBeVisible();
    const favouritesStar = control.locator('#library-section-Favourites [aria-label="Remove Circles from favourites"]');
    await expect(favouritesStar).toHaveAttribute('aria-pressed', 'true');
    await expect(favouritesStar).toHaveText('★');
    // The pattern stays in its own group as well.
    await expect(control.locator('#library-section-Simple [data-id="circles"]')).toBeVisible();
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(71);
    expect(await control.evaluate((key) => localStorage.getItem(key), FAVOURITES_KEY)).toBe('["circles"]');

    await control.reload();
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(71);
    await expect(control.locator('.library-group').first().locator('.library-group-toggle')).toHaveText('Favourites');
    await expect(control.locator('#library-section-Favourites [data-id="circles"]')).toBeVisible();

    // Un-starring from the mirror removes the group again.
    await control.locator('#library-section-Favourites [aria-label="Remove Circles from favourites"]').click();
    await expect(control.locator('#library-section-Favourites')).toHaveCount(0);
    await expect(control.locator('#pattern-library .pattern-btn')).toHaveCount(70);
    expect(await control.evaluate((key) => localStorage.getItem(key), FAVOURITES_KEY)).toBe('[]');
  });

  test('the star neither selects nor cues the pattern, and no control is nested in a pattern button', async ({ context }) => {
    const control = await openControl(context);
    const before = await control.evaluate(() => window.__viz.patternId);

    await control.getByRole('button', { name: 'Add Bars to favourites' }).click();
    await expect(control.locator('#library-section-Favourites [data-id="bars"]')).toBeVisible();
    expect(await control.evaluate(() => window.__viz.patternId)).toBe(before);
    await expect(control.locator('#library-section-Simple [data-id="bars"]')).toHaveClass(/pattern-btn(?!.*active)/);
    await expect(control.locator('#library-section-Favourites [data-id="bars"]')).not.toHaveClass(/active/);

    // A button may not contain another control: the star is a sibling.
    expect(await control.evaluate(() => document.querySelectorAll('.pattern-btn button').length)).toBe(0);
  });

  test('a search never shows a favourite twice', async ({ context }) => {
    const control = await openControl(context);
    await control.getByRole('button', { name: 'Add Circles to favourites' }).click();
    await expect(control.locator('#library-section-Favourites [data-id="circles"]')).toBeVisible();

    await search(control).fill('circ');
    await expect(control.locator('#library-section-Favourites')).toHaveCount(0);
    await expect(control.locator('#pattern-library [data-id="circles"]')).toHaveCount(1);
    await expect(control.locator('#pattern-library [data-id="circles"]')).toBeVisible();

    await control.locator('#library-search-clear').click();
    await expect(control.locator('#library-section-Favourites [data-id="circles"]')).toBeVisible();
  });

  test('the Favourites mirror selects and drags like any other library item', async ({ context }) => {
    const control = await openControl(context);
    await control.getByRole('button', { name: 'Add Checkerboard to favourites' }).click();
    const mirror = control.locator('#library-section-Favourites [data-id="checkerboard"]');
    await expect(mirror).toBeVisible();

    // Clicking the mirror plays that pattern and highlights both copies.
    await mirror.click();
    await expect(mirror).toHaveClass(/active/);
    await expect(control.locator('#library-section-Simple [data-id="checkerboard"]')).toHaveClass(/active/);

    // Dragging the mirror onto a pad slot assigns it exactly like the original.
    const target = control.locator('#pattern-pad [data-index="9"]');
    await expect(target).toHaveAttribute('data-id', 'laser-grid');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await mirror.dragTo(target);
      try {
        await expect(target).toHaveAttribute('data-id', 'checkerboard', { timeout: 5_000 });
        break;
      } catch {
        if (attempt === 2) throw new Error('dragging from the Favourites mirror never assigned the pad slot');
        await control.waitForTimeout(250);
      }
    }
    await expect(control.locator('#library-section-Simple [data-id="checkerboard"] .slot-badge')).toHaveText('0');
    await expect(mirror.locator('.slot-badge')).toHaveText('0');
    await expect.poll(
      () => control.evaluate(() => JSON.parse(localStorage.getItem('viz2_slot_order') || '[]')),
      { timeout: 15_000 },
    ).toContain('checkerboard');
  });

  test('an unreadable favourites entry falls back to no favourites', async ({ context }) => {
    // Context-level: the control page is created inside openControl().
    await context.addInitScript((key) => localStorage.setItem(key, '{"circles":true}'), FAVOURITES_KEY);
    const control = await openControl(context);
    // Prove the corrupt value really is in place for this page/context.
    expect(await control.evaluate((key) => localStorage.getItem(key), FAVOURITES_KEY)).toBe('{"circles":true}');

    await expect(control.locator('#library-section-Favourites')).toHaveCount(0);
    await control.getByRole('button', { name: 'Add Bars to favourites' }).click();
    await expect(control.locator('#library-section-Favourites [data-id="bars"]')).toBeVisible();
    expect(await control.evaluate((key) => localStorage.getItem(key), FAVOURITES_KEY)).toBe('["bars"]');
  });

  test('an imported settings file restores favourites', async ({ context }) => {
    test.setTimeout(45_000);
    const control = await openControl(context);

    const settingsFile = test.info().outputPath('ahlookah-favourites-import.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      app: 'ahlookah',
      kind: 'ahlookah-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      storage: {
        viz2_device_setup_done: '1',
        [FAVOURITES_KEY]: '["bars","checkerboard"]',
      },
      media: [],
    }));

    await control.locator('#app-menu-btn').click();
    await control.locator('#settings-import-input').setInputFiles(settingsFile);
    await expect(control.locator('#notice-modal')).toBeVisible();
    await control.locator('#notice-modal-reload').click();

    await expect(control.locator('#library-section-Favourites')).toBeVisible({ timeout: 20_000 });
    await expect(control.locator('.library-group').first().locator('.library-group-toggle')).toHaveText('Favourites');
    // Stored order is kept: Bars first, then Checkerboard.
    await expect(control.locator('#library-section-Favourites .pattern-name')).toHaveText(['Bars', 'Checkerboard']);
    await expect(control.getByRole('button', { name: 'Remove Bars from favourites' })).toHaveCount(2);
  });

  test('favourites travel with an exported settings file', async ({ context }) => {
    const control = await openControl(context);
    await control.getByRole('button', { name: 'Add Circles to favourites' }).click();

    await control.locator('#app-menu-btn').click();
    const [download] = await Promise.all([
      control.waitForEvent('download'),
      control.locator('#app-menu-export-settings').click(),
    ]);
    const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    expect(payload.storage[FAVOURITES_KEY]).toBe('["circles"]');
  });
});
