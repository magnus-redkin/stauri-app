/**
 * Playwright config for the end-to-end test in tests/e2e.
 *
 * The webServer is the real `pnpm tauri dev`, not a mocked frontend, so the spec
 * exercises Tauri and status-backend together; the first Rust compile can take
 * up to two minutes, hence the 120 s start timeout.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Tauri needs one test at a time, so windows do not interfere
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
  },

  // Start the real Tauri development environment
  webServer: {
    command: 'pnpm tauri dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true, // connect to an already running `pnpm tauri dev` instead of starting one
    timeout: 120000, // 2 minutes for the first Rust compile; later starts take 2-3 seconds
    stdout: 'pipe',
    stderr: 'pipe',
  },

  projects: [
    {
      name: 'tauri-chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
