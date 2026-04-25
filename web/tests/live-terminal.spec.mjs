import { test, expect } from "@playwright/test";
import { gotoReady } from "./helpers.mjs";

test.describe("Codex Web — embedded terminal", () => {
  test("runs a shell command inside the active workspace", async ({ page }) => {
    await gotoReady(page);

    await expect(page.locator("#workspace-terminal")).toContainText(/(running|connected)/);

    const marker = `hello-terminal-${Date.now()}`;
    await page.locator("#workspace-terminal-input").fill(`printf '${marker}\\n'`);
    await page.locator("#workspace-terminal-send").click();

    await expect(page.locator("#workspace-terminal-output")).toContainText(marker);
  });
});
