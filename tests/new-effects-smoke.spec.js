import { BUILTIN_PATTERNS } from '../src/patterns/builtins.js';
import { test, expect } from '@playwright/test';
import { SMOKE_PATTERNS } from './smoke-patterns.js';

// Full-catalog render coverage: one named test per built-in pattern, generated
// from the real catalog. New patterns receive render coverage automatically —
// there is no hand-maintained id list to extend.
//
// The bounded @smoke representatives (SMOKE_PATTERNS) stay a separate,
// deliberate contract: one inexpensive pattern per established category.
const SMOKE_IDS = new Set(Object.values(SMOKE_PATTERNS));

test.describe('built-in patterns render without errors', { tag: '@patterns' }, () => {
  for (const { id } of BUILTIN_PATTERNS) {
    test(`renders ${id} without errors`, { tag: SMOKE_IDS.has(id) ? '@smoke' : [] }, async ({ context, page }, testInfo) => {
      // Two GPU-heavy windows must be up before selecting anything: the screen has
      // to finish its singleton handshake and prepare a live runtime, and the
      // control has to hear the screen's `hello`. Every wait below is a real
      // readiness signal bounded by a budget that is wide enough for a saturated
      // machine yet still fails a genuinely stuck window.
      test.setTimeout(TEST_TIMEOUT);
      const errors = [];
      const consoleErrors = [];
      const screenFailures = [];
      page.on('pageerror', (err) => errors.push(err.message));
      collectConsoleErrors(page, consoleErrors);
      trackResourceFailures(page, screenFailures);
      let control;
      let controlFailures = [];
      try {
        await bootWindow(page, '/?role=screen', screenFailures, waitForScreenReady); // screen window
        control = await context.newPage();
        collectConsoleErrors(control, consoleErrors);
        controlFailures = trackResourceFailures(control);
        await bootWindow(control, '/?role=control', controlFailures, waitForControlReady);
        const button = control.locator(`#pattern-library .pattern-btn[data-id="${id}"]`);
        await expect(button).toBeVisible({ timeout: PATTERN_TIMEOUT });
        // Dispatch the DOM click instead of a pointer click: Playwright's pointer
        // click additionally waits for post-action navigation signals, which a
        // starved renderer can delay for tens of seconds *after* the click has
        // already reached the app (the selection is delivered either way). The
        // library's own React handler and selection path are exercised unchanged;
        // pointer interaction is covered by the control-panel/library specs.
        await button.dispatchEvent('click', undefined, { timeout: CLICK_TIMEOUT });
        // The chosen pattern is live only when the screen names it *and* that
        // runtime is prepared — "any canvas exists" would not prove anything.
        await waitForChosenPatternLive(page, id);
        // Let it render a few frames
        await waitForFrames(page, 2);
        await page.waitForTimeout(500);
        // Main canvas is visible. Some sketches (e.g. Noise Static) also create a
        // hidden createGraphics buffer canvas (display:none), so scope to :visible.
        await expect(page.locator('canvas:visible').first()).toBeVisible();
        expect(errors, `screen page errors while rendering ${id}`).toEqual([]);
      } catch (error) {
        const details = await smokeDiagnostics({ screen: page, control, id, errors, consoleErrors, resourceFailures: screenFailures.concat(controlFailures) });
        if (error instanceof Error) {
          error.message = `${error.message}\n\nsmoke diagnostics for "${id}" (${testInfo.titlePath.join(' › ')})\n${details}`;
          throw error;
        }
        throw new Error(`${String(error)}\n\nsmoke diagnostics for "${id}"\n${details}`);
      } finally {
        await control?.close();
      }
    });
  }
});

// Budgets for GPU-heavy cross-tab startup: bounded, but wide enough that a
// healthy boot under parallel load is never mistaken for a failure.
const TEST_TIMEOUT = 90_000;
const BOOT_TIMEOUT = 45_000;
const PATTERN_TIMEOUT = 60_000;
const CLICK_TIMEOUT = 20_000;

// The screen's own readiness contract (the same signal the node editor specs
// poll): the stage is mounted and its live program has really rendered/prepared.
async function waitForScreenReady(screen) {
  await expect.poll(() => screen.evaluate(() => window.__viz?.programs?.live?.ready === true), {
    message: 'the screen window should prepare its live program before a pattern is selected',
    timeout: BOOT_TIMEOUT,
  }).toBe(true);
}

// A control that has processed the screen's `hello` owns a live bus, so the
// selection cannot be broadcast by a window that is still booting.
async function waitForControlReady(control) {
  await expect.poll(() => control.evaluate(() => window.__viz?.role === 'control' && window.__viz?.screenOnline === true), {
    message: 'the control window should be booted and aware of the online screen before selecting',
    timeout: BOOT_TIMEOUT,
  }).toBe(true);
}

async function waitForChosenPatternLive(screen, id) {
  await expect.poll(() => screen.evaluate((expected) => {
    const viz = window.__viz;
    return viz?.patternId === expected && viz?.programs?.live?.ready === true;
  }, id), {
    message: `the screen should switch its live program to ${id}`,
    timeout: PATTERN_TIMEOUT,
  }).toBe(true);
}

// Render a couple of animation frames instead of sleeping for a fixed duration:
// frame progress is the signal this smoke actually needs.
async function waitForFrames(page, frames) {
  await page.evaluate((count) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => (++seen >= count ? resolve(seen) : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), frames);
}

function collectConsoleErrors(page, sink) {
  page.on('console', (msg) => {
    // The dev-only CSP note is emitted by the browser on every page and says
    // nothing about the pattern; keep it out of the diagnostics.
    if (msg.type() === 'error' && !/frame-ancestors/.test(msg.text())) sink.push(msg.text().slice(0, 400));
  });
}

// Resource-level load failures for one window (recorded for the boot recovery
// below and reported in the diagnostics).
function trackResourceFailures(page, sink) {
  page.on('requestfailed', (request) => sink.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`));
  return sink;
}

// Four GPU-heavy workers hitting one dev server can drop a module request with a
// Chromium network error (net::ERR_NETWORK_CHANGED), after which the window never
// boots at all and `window.__viz` is never installed. Reload that window exactly
// once, and only when a resource really failed to load; the same readiness signal
// is then required again, so a genuine boot/render regression still fails the test.
async function bootWindow(page, url, failures, waitForReady) {
  await page.goto(url);
  try {
    await waitForReady(page);
  } catch (error) {
    if (!failures.length) throw error; // booted cleanly yet never became ready
    failures.length = 0;
    await page.goto(url);
    await waitForReady(page);
  }
}

async function pageDiagnostics(page, label) {
  if (!page) return { [label]: 'window was never opened' };
  try {
    return { [label]: await page.evaluate(() => {
      const viz = window.__viz;
      const canvases = [...document.querySelectorAll('canvas')];
      return {
        url: location.href,
        role: viz?.role ?? null,
        patternId: viz?.patternId ?? null,
        liveSelection: viz?.liveSelection ?? null,
        screenOnline: viz?.screenOnline ?? null,
        singletonBlocked: viz?.singletonBlocked ?? null,
        programs: viz?.programs ?? null,
        canvasCount: canvases.length,
        renderedCanvasCount: canvases.filter((c) => c.getClientRects().length > 0).length,
      };
    }) };
  } catch (error) {
    return { [label]: { unavailable: String(error?.message || error) } };
  }
}

// Failure diagnostics: which control was selected, what the screen reports as its
// live program, the rendered canvases, both windows' errors — plus the app's own
// reverted-selection report, so a real regression stays readable in the failure
// message instead of a bare timeout.
async function smokeDiagnostics({ screen, control, id, errors, consoleErrors, resourceFailures = [] }) {
  const [screenState, controlState] = await Promise.all([
    pageDiagnostics(screen, 'screen'),
    pageDiagnostics(control, 'control'),
  ]);
  const reverted = consoleErrors.some((line) => /Unable to prepare requested live program|did not produce a fresh frame/.test(line));
  return [
    `selected pattern: ${id}`,
    `screen: ${JSON.stringify(screenState.screen)}`,
    `control: ${JSON.stringify(controlState.control)}`,
    `app reverted the requested live selection: ${reverted}`,
    `resource failures: ${JSON.stringify(resourceFailures)}`,
    `page errors: ${JSON.stringify(errors)}`,
    `console errors: ${JSON.stringify(consoleErrors)}`,
  ].join('\n');
}
