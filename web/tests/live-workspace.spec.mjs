import { test, expect } from "@playwright/test";
import { gotoReady } from "./helpers.mjs";

test.describe("Codex Web — workspace shell", () => {
  test("creates and activates a named project and previews a workspace file", async ({ page }) => {
    await gotoReady(page);

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.locator("#workspace-panel")).toBeVisible();
    await expect(page.locator("#workspace-root-path")).toContainText("/workdirs/");

    const projectName = `Workspace ${Date.now()}`;
    page.once("dialog", (dialog) => dialog.accept(projectName));
    await page.getByRole("button", { name: "New project" }).click();

    const projectSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const projectButton = page
      .locator(".project-main")
      .filter({ hasText: projectName });
    await expect(projectButton).toBeVisible();

    await projectButton.click();
    await expect(page.locator("#workspace-root-path")).toContainText(`/projects/${projectSlug}`);
    await expect(page.locator("#workspace-root-chip")).toContainText(projectName);

    await page.getByRole("treeitem", { name: /codex-project\.json/ }).click();
    await expect(page.locator("#workspace-viewer")).toContainText(projectSlug);

    await page.locator("#settings-btn").click();
    await page.getByRole("button", { name: "Secrets" }).click();
    await page.locator("#secret-key").fill("HELLO_TOKEN");
    await page.locator("#secret-value").fill("wave-11-ready");
    await page.getByRole("button", { name: "Save secret" }).click();
    await expect(page.locator("#secrets-list")).toContainText("HELLO_TOKEN");
  });
});
