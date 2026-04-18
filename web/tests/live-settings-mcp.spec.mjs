import { test, expect } from "@playwright/test";
import { gotoReady, sendPrompt } from "./helpers.mjs";

test.describe("Codex Web — live settings and MCP", () => {
  test("opens the tabbed settings surface and the live MCP manager", async ({ page }) => {
    await gotoReady(page);

    await page.locator("#settings-btn").click();
    await expect(page.locator(".modal h2")).toContainText("Settings");
    await page.getByRole("button", { name: "MCP" }).click();
    await page.locator("#open-mcp").click();
    await expect(page.locator(".modal h2")).toContainText("MCP servers");
    await page.locator("#close").click();
  });

  test("renders a friendly CLI-only banner for realtime voice", async ({ page }) => {
    await gotoReady(page);

    await sendPrompt(page, "/realtime");

    await expect(page.locator("#transcript")).toContainText("not available in the web build", { timeout: 10_000 });
  });
});
