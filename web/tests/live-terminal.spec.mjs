import { test, expect } from "@playwright/test";

test.describe("Codex Web — embedded terminal", () => {
  test("runs a shell command inside the active workspace", async ({ page }) => {
    const baseUrl = process.env.BASE_URL ?? "http://localhost:5000";
    await page.goto(baseUrl);
    await expect(page.locator("#backend-pill")).toContainText("backend: real", {
      timeout: 15_000,
    });

    await expect(page.locator("#workspace-terminal")).toContainText(/(running|connected)/);

    const marker = `hello-terminal-${Date.now()}`;
    await page.locator("#workspace-terminal-input").fill(`printf '${marker}\\n'`);
    await page.locator("#workspace-terminal-send").click();

    await expect(page.locator("#workspace-terminal-output")).toContainText(marker);
  });
});
