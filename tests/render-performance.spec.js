import { test, expect } from '@playwright/test';
import { RenderPerformance, validPerformanceSample } from '../src/render-performance.js';

test('render budget aggregates children and composition without double counting or stale generations', () => {
  const meter = new RenderPerformance();
  meter.setProgram(1, ['projection-one', 'ordinary']);
  meter.tick(0);
  let sample;
  for (let i = 1; i <= 60; i++) {
    meter.record('projection-one', 'left', 2);
    meter.record('projection-one', 'right', 3);
    meter.record('projection-one', null, 1);
    meter.record('ordinary', null, 2);
    meter.record(null, null, 1);
    sample = meter.tick(i * 1000 / 60) || sample;
  }
  expect(sample.fps).toBe(60);
  expect(sample.cpuMs).toBe(9);
  expect(sample.cpuPercent).toBe(54);
  expect(sample.patterns['projection-one'].cpuMs).toBe(6);
  expect(sample.patterns['projection-one'].surfaces.left.cpuMs).toBe(2);
  expect(validPerformanceSample(sample)).toBe(true);
  expect(validPerformanceSample({ ...sample, fps: NaN })).toBe(false);
  expect(validPerformanceSample({ ...sample, patterns: {} })).toBe(false);
  expect(validPerformanceSample(null)).toBe(false);
  meter.setProgram(2, ['next']);
  meter.tick(2000);
  meter.record('next', null, 10);
  const slow = meter.tick(3000);
  expect(Object.keys(slow.patterns)).toEqual(['next']);
  expect(slow.slowPercent).toBe(100);
  expect(meter.tick(4000, true)).toBeNull();
  expect(meter.tick(9000)).toBeNull(); // Hidden time isn't reported as GPU slowdown.
});

test('output telemetry appears on live patterns and mappings, not CUE; stale/offline samples clear', async ({ context, page }, testInfo) => {
  test.setTimeout(60000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addInitScript(() => {
    localStorage.setItem('viz2_device_setup_done', '1');
    localStorage.setItem('viz2_slot_order', JSON.stringify(['projection-budget', 'solid-color']));
    localStorage.setItem('viz2_projection_patterns', JSON.stringify([{ id: 'projection-budget', name: 'Budget walls', surfaces: [
      { id: 'sleft', name: 'Left wall', patternId: 'solid-color' },
      { id: 'sright', name: 'Right wall', patternId: 'solid-color' },
    ] }]));
  });
  await page.setViewportSize({ width: 320, height: 180 });
  await page.goto('/?role=screen');
  const control = await context.newPage();
  control.on('pageerror', (error) => errors.push(error.message));
  await control.setViewportSize({ width: 1280, height: 800 });
  await control.goto('/?role=control');
  await expect(control.locator('.projection-panel .performance-budget')).toContainText('LIVE performance budget', { timeout: 20000 });
  await expect(control.locator('.library-btn[data-id="projection-budget"] .performance-badge')).toBeVisible();
  await expect(control.locator('.slot-btn[data-id="projection-budget"] .performance-badge')).toBeVisible();
  await expect(control.locator('.projection-surface .performance-badge')).toHaveCount(2);
  await expect(control.locator('.output-performance')).toContainText('fps');
  await expect(control.locator('.projection-panel .performance-budget')).toContainText('GPU/decoder load not included');
  expect(await page.evaluate(() => window.__viz.renderPerformance.patterns['projection-budget'].cpuMs)).toBeGreaterThanOrEqual(0);
  await control.screenshot({ path: testInfo.outputPath('pattern-budgets.png') });
  await control.locator('.library-btn[data-id="solid-color"]').click({ modifiers: ['Shift'] });
  await expect(control.locator('#params-list .performance-budget')).toContainText('Measured when LIVE');
  await control.keyboard.press('Escape');
  await expect(control.locator('.projection-panel .performance-budget')).toContainText('LIVE performance budget');
  await page.close();
  await expect(control.locator('.performance-badge')).toHaveCount(0);
  await expect(control.locator('.output-performance')).toHaveText('Performance pending');
  await control.evaluate(() => {
    const bus = new BroadcastChannel('viz2_channel');
    bus.postMessage({ type: 'screen-closed' });
    bus.close();
  });
  await expect(control.locator('.output-performance')).toHaveCount(0);
  expect(errors).toEqual([]);
});
