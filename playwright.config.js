import { defineConfig, devices } from '@playwright/test';

// Override for isolated worktrees; never reuse an unrelated app on the default port.
const port = Number(process.env.PLAYWRIGHT_PORT || 5173);
const baseURL = `http://localhost:${port}`;
const mappingSpecs = /(?:mapping-performance|projection-mapping|screen-mapping)\.spec\.js$/;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Ordinary tests run in parallel; timing-sensitive mapping tests run in a
  // separate single-worker phase after them to avoid rendering contention.
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    // Fake media streams: give camera-input (Video FX) sketches a synthetic
    // webcam in CI so the capture pipeline actually runs. Harmless for the
    // rest of the suite (the flags only matter when getUserMedia is called).
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
    // The device-setup modal now gates a fresh profile until the operator
    // confirms their mic/camera. The existing suite assumes an immediately
    // interactive panel, so pre-seed the "setup complete" flag. Dedicated
    // modal tests override this with an empty storage state.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            { name: 'viz2_device_setup_done', value: '1' },
          ],
        },
      ],
    },
  },
  projects: [
    { name: 'chromium', testIgnore: mappingSpecs, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium-mapping',
      testMatch: mappingSpecs,
      dependencies: ['chromium'],
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
