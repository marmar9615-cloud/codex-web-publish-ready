import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { activeWorkspaceRoot, gotoReady } from "./helpers.mjs";

test.describe("Codex Web — database browser", () => {
  test("opens a sqlite database in the workspace and browses its tables", async ({
    page,
  }) => {
    await gotoReady(page);

    const projectName = `Database ${Date.now()}`;
    page.once("dialog", (dialog) => dialog.accept(projectName));
    await page.getByRole("button", { name: "New project" }).click();

    const projectButton = page.locator(".project-main").filter({ hasText: projectName });
    await expect(projectButton).toBeVisible();
    await projectButton.click();

    const projectSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await expect(page.locator("#workspace-root-path")).toContainText(`/projects/${projectSlug}`);
    const projectDir = await activeWorkspaceRoot(page);
    execFileSync("sqlite3", [
      join(projectDir, "launch.sqlite"),
      "create table users (id integer primary key, name text, role text); insert into users (name, role) values ('Mara', 'owner'), ('Claude', 'builder'); create table deploys (id integer primary key, status text); insert into deploys (status) values ('ready');",
    ]);

    await page.locator("#workspace-refresh-btn").click();
    const dbFile = page.getByRole("treeitem", { name: /launch\.sqlite/ });
    await expect(dbFile).toBeVisible({ timeout: 15_000 });
    await dbFile.click();

    await expect(page.locator("#workspace-viewer")).toContainText("Tables");
    await expect(page.locator("#workspace-viewer")).toContainText("users");
    await expect(page.locator("#workspace-viewer")).toContainText("ready");

    await page.locator("[data-db-table='users']").click();
    await expect(page.locator("#workspace-viewer")).toContainText("Mara");
    await expect(page.locator("#workspace-viewer")).toContainText("builder");

    await page.locator("[data-db-table='deploys']").click();
    await expect(page.locator("#workspace-viewer")).toContainText("ready");
  });
});
