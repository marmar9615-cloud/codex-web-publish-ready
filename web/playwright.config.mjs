// Minimal Playwright config for the live e2e suite.
// Set BASE_URL to point at an already running gateway; otherwise Playwright
// starts an isolated test server on port 5100.
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5100";
const shouldStartServer = !process.env.BASE_URL;

export default {
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    headless: true,
  },
  reporter: [["list"]],
  webServer: shouldStartServer
    ? {
        command:
          "PORT=5100 CODEX_WEB_SECRETS_KEY=playwright-test CODEX_WEB_WORKDIR_ROOT=.test-state/workdirs CODEX_WEB_PROJECTS_ROOT=.test-state/projects CODEX_WEB_SHARES_ROOT=.test-state/shares npm start",
        url: BASE_URL,
        timeout: 30_000,
        reuseExistingServer: false,
      }
    : undefined,
};
