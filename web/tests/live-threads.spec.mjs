import { test, expect } from "@playwright/test";
import { gotoReady, sendPrompt } from "./helpers.mjs";

test.describe("Codex Web — live thread flows", () => {
  test("rehydrates a resumed thread and supports rename plus archive filters", async ({ page }) => {
    await gotoReady(page);

    await sendPrompt(page, "resume me from playwright");
    await expect(page.locator(".auth-required-card")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".thread-item")).toHaveCount(1, { timeout: 30_000 });

    await page.reload();
    await gotoReady(page);

    await page.locator(".thread-main").first().click();
    await expect(page.locator(".cell.user")).toContainText("resume me from playwright", { timeout: 20_000 });

    page.once("dialog", (dialog) => dialog.accept("Renamed by playwright"));
    await page.locator(".thread-menu-toggle").first().click();
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(page.locator("#thread-title")).toContainText("Renamed by playwright", { timeout: 15_000 });

    await page.locator(".thread-menu-toggle").first().click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.locator("#threads")).toContainText("No saved threads yet.", { timeout: 15_000 });

    await page.locator("#thread-filter-archived").click();
    await expect(page.locator(".thread-item")).toContainText("Renamed by playwright", { timeout: 15_000 });

    await page.locator(".thread-menu-toggle").first().click();
    await page.getByRole("button", { name: "Unarchive", exact: true }).click();
    await page.locator("#thread-filter-active").click();
    await expect(page.locator(".thread-item")).toContainText("Renamed by playwright", { timeout: 15_000 });
  });
});
