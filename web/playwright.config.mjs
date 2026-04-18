// Minimal Playwright config for the e2e suite at tests/e2e.spec.mjs.
// Set BASE_URL to point at a running gateway (defaults to http://localhost:5000).
export default {
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5000",
    headless: true,
  },
  reporter: [["list"]],
};
