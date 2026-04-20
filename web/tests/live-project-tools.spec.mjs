import { test, expect } from "@playwright/test";
import { gotoReady } from "./helpers.mjs";

test.describe("Codex Web — project tools", () => {
  test("opens GitHub, Deploy, and Ship it tools for a named project", async ({
    page,
  }) => {
    await gotoReady(page);

    const projectName = `Project Tools ${Date.now()}`;
    page.once("dialog", (dialog) => dialog.accept(projectName));
    await page.getByRole("button", { name: "New project" }).click();
    await page
      .locator(".project-main")
      .filter({ hasText: projectName })
      .click();

    await page.getByRole("button", { name: "Deploy" }).click();
    const modal = page.locator("#modal-root");
    await expect(modal.getByRole("heading", { name: "Project tools" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "GitHub" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Deploy" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Ship it" })).toBeVisible();

    await modal.locator("#render-hook-url").fill("https://example.com/render-sync");
    await modal.getByRole("button", { name: "Save hook" }).click();
    await expect(modal.locator("[data-project-panel='deploy']")).toContainText(
      "https://example.com/render-sync",
    );

    await modal.getByRole("button", { name: "GitHub" }).click();
    await expect(modal.locator("#project-git-repo")).toBeVisible();
    await expect(modal.locator("[data-project-panel='git']")).toContainText(
      "GITHUB_TOKEN",
    );

    await modal.getByRole("button", { name: "Ship it" }).click();
    await expect(modal.locator("#ship-tests-command")).toBeVisible();
    await expect(modal.locator("#ship-build-command")).toBeVisible();
  });
});
