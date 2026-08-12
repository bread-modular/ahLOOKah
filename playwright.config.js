import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // The heavy WebGL smoke/preview specs (raymarch shaders under software GL) and
  // the per-RAF pattern-controls engine work crash/time out under 3-way parallel
  // contention on this 6-core/6GB host. Cap at 2 workers for a reliable suite.
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
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
          origin: 'http://localhost:5173',
          localStorage: [
            { name: 'viz2_device_setup_done', value: '1' },
          ],
        },
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
