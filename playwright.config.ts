import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run start --workspace=packages/server',
      url: 'http://localhost:2567',
      timeout: 30000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run preview --workspace=packages/client',
      url: 'http://localhost:4173',
      timeout: 30000,
      reuseExistingServer: true,
    },
  ],
});
