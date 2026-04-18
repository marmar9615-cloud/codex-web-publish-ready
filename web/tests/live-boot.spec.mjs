import { test, expect } from "@playwright/test";
import { gotoReady, sendPrompt } from "./helpers.mjs";

test.describe("Codex Web — live backend boot", () => {
  test("boots on the real backend, loads live status, and shows one auth-required card when unauthenticated", async ({ page }) => {
    await gotoReady(page);

    await page.locator("#settings-btn").click();
    await expect(page.locator(".modal h2")).toContainText("Settings");
    await page.locator("#cancel").click();

    await sendPrompt(page, "hello from playwright");

    await expect(page.locator(".cell.user")).toContainText("hello from playwright", { timeout: 30_000 });
    await expect(page.locator(".auth-required-card")).toContainText("OpenAI authentication required", { timeout: 30_000 });
    await expect(page.locator(".auth-required-card")).toHaveCount(1);
  });
});
