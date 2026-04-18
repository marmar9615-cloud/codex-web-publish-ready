import { test, expect } from "@playwright/test";
import { gotoReady, sendPrompt } from "./helpers.mjs";

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAuMBg6m6qXQAAAAASUVORK5CYII=",
  "base64",
);

test.describe("Codex Web — live attachments", () => {
  test("queues an image upload and carries it into the next live turn", async ({ page }) => {
    await gotoReady(page);

    await page.setInputFiles("#attach-input", {
      name: "playwright-shot.png",
      mimeType: "image/png",
      buffer: PNG_BUFFER,
    });
    await expect(page.locator("#pending-uploads .upload-chip")).toContainText("playwright-shot.png");

    await sendPrompt(page, "attachment smoke");

    await expect(page.locator(".cell.user")).toContainText("attachment smoke", { timeout: 30_000 });
    await expect(page.locator(".cell.user img")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".auth-required-card")).toHaveCount(1, { timeout: 30_000 });
  });
});
