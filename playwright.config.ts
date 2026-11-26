import { defineConfig, devices } from "@playwright/test";
import { APP_URL, e2eEnv, FAKE_URL, STORAGE_ADMIN } from "./e2e/env";

// End-to-end suite (docs/testing.md "E2E"): the real app under `next dev` against the local
// Supabase, with every external service faked (e2e/fakes). `npm run e2e`.

const CI = Boolean(process.env.CI);
const env = e2eEnv();

export default defineConfig({
  testDir: "e2e/specs",
  outputDir: "test-results/e2e",
  fullyParallel: true,
  workers: CI ? 4 : "50%",
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI
    ? [["list"], ["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: APP_URL,
    // The shared admin, signed in once (e2e/global-setup.ts). Specs that need someone else sign in themselves.
    storageState: STORAGE_ADMIN,
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    trace: CI ? "retain-on-first-failure" : "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    // Animations settle at once (the app honours prefers-reduced-motion), so axe and clicks see
    // the final state rather than a fade halfway through.
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: {
      // A fake microphone (a tone) that needs no permission prompt: the live page records it.
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    },
    // Local runs may use the installed Chrome instead of downloading Chromium: E2E_CHANNEL=chrome.
    ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Phone width for the main flows (specs tagged @phone).
    { name: "phone", grep: /@phone/, use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: "npx tsx --conditions=react-server e2e/fakes/server.ts",
      url: `${FAKE_URL}/__e2e/health`,
      env,
      reuseExistingServer: !CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx next dev --port ${new URL(APP_URL).port} --hostname 127.0.0.1`,
      url: `${APP_URL}/api/health`,
      env,
      timeout: 240_000,
      reuseExistingServer: !CI,
      stdout: CI ? "pipe" : "ignore",
      stderr: "pipe",
    },
  ],
});
