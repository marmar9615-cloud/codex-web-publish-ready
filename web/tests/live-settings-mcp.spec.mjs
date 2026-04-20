import { test, expect } from "@playwright/test";
import { gotoReady, sendPrompt } from "./helpers.mjs";

test.describe("Codex Web — live settings and MCP", () => {
  test("opens live settings surfaces for MCP, hooks, memories, skills, plugins, and apps", async ({ page }) => {
    await gotoReady(page);

    await page.locator("#settings-btn").click();
    await expect(page.locator(".modal h2")).toContainText("Settings");
    await expect
      .poll(
        async () => await page.locator('.modal select[name="model"] option').count(),
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Memories" }).click();
    await expect(page.locator("#memory-list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset memory store" })).toBeVisible();
    await page.getByRole("button", { name: "Hooks" }).click();
    await expect(page.locator("#hooks-editor .hook-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Add hook" }).click();
    await expect(page.locator("#hooks-editor .hook-row")).toHaveCount(2);
    await page.locator("#cancel").click();

    await page.locator("#settings-btn").click();
    await page.getByRole("button", { name: "MCP" }).click();
    await page.locator("#open-mcp").click();
    await expect(page.locator(".modal h2")).toContainText("MCP servers");
    await page.locator("#close").click();

    await page.locator("#settings-btn").click();
    await page.getByRole("button", { name: "Skills" }).click();
    await page.locator("#open-skills").click();
    await expect(page.locator(".modal h2")).toContainText("Skills");
    await page.locator("#close").click();

    await page.locator("#settings-btn").click();
    await page.getByRole("button", { name: "Plugins" }).click();
    await page.locator("#open-plugins").click();
    await expect(page.locator(".modal h2")).toContainText("Plugins");
    await page.locator("#close").click();

    await page.locator("#settings-btn").click();
    await page.getByRole("button", { name: "Apps" }).click();
    await page.locator("#open-apps").click();
    await expect(page.locator(".modal h2")).toContainText("Apps");
    await page.locator("#close").click();
  });

  test("renders a friendly CLI-only banner for realtime voice", async ({ page }) => {
    await gotoReady(page);

    await sendPrompt(page, "/realtime");

    await expect(page.locator("#transcript")).toContainText("not available in the web build", { timeout: 10_000 });
  });
});
