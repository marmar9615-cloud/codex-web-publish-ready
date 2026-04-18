import { test, expect } from "@playwright/test";
import { AUTH_ENABLED, BASE_URL, gotoReady } from "./helpers.mjs";

test.describe("Codex Web — live auth UI", () => {
  test("starts ChatGPT auth using the correct flow for this host", async ({ page }) => {
    test.skip(!AUTH_ENABLED, "set PLAYWRIGHT_AUTH=1 to run auth UI smoke");

    await gotoReady(page);
    await page.locator("#account-btn").click();
    await page.locator("#chatgpt").click();

    const oauthStatus = page.locator("#oauth-status");
    const isLocalHost = ["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname);
    if (isLocalHost) {
      await expect(oauthStatus).toContainText("finish sign-in in the new tab", { timeout: 20_000 });
      await expect(oauthStatus.locator("a")).toHaveAttribute("href", /https?:\/\//);
      await expect(oauthStatus.locator("code")).toHaveCount(0);
      return;
    }

    await expect(oauthStatus).toContainText(/Open https:\/\/auth\.openai\.com\/codex\/device/, { timeout: 20_000 });
    await expect(oauthStatus.locator("code")).not.toHaveText("");
  });
});
