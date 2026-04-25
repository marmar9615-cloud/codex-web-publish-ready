import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import {
  activeWorkspaceRoot,
  gotoReady,
  openWorkspaceTab,
} from "./helpers.mjs";

test.describe("Codex Web — mobile preview", () => {
  test("detects an Expo-style workspace and renders a mobile QR preview", async ({
    page,
  }) => {
    await gotoReady(page);

    const projectName = `Mobile ${Date.now()}`;
    page.once("dialog", (dialog) => dialog.accept(projectName));
    await page.getByRole("button", { name: "New project" }).click();

    const projectSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await page.locator(".project-main").filter({ hasText: projectName }).click();
    await expect(page.locator("#workspace-root-path")).toContainText(`/projects/${projectSlug}`);

    const projectDir = await activeWorkspaceRoot(page);
    writeFileSync(
      join(projectDir, "app.json"),
      `${JSON.stringify(
        {
          expo: {
            name: projectName,
            slug: projectSlug,
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(projectDir, "package.json"),
      `${JSON.stringify(
        {
          name: projectSlug,
          private: true,
          scripts: {
            start: "node fake-expo.js",
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(projectDir, "fake-expo.js"),
      [
        "console.log('Starting Expo dev server...');",
        "setTimeout(() => {",
        "  console.log('Metro waiting on exp://127.0.0.1:8081');",
        "  console.log('Tunnel ready at https://u.expo.dev/fake-mobile');",
        "}, 50);",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    await openWorkspaceTab(page, "Mobile");
    await page.locator("#workspace-mobile-refresh").click();
    await expect(page.locator("#workspace-mobile")).toContainText("app.json");
    await expect(page.locator("#workspace-mobile")).toContainText(
      "npm run start -- --tunnel",
    );

    await page.locator("#workspace-mobile-start").click();
    await expect(page.locator("#workspace-mobile")).toContainText(
      "exp://127.0.0.1:8081",
      {
        timeout: 20_000,
      },
    );
    await expect(page.locator("#workspace-mobile")).toContainText(
      "https://u.expo.dev/fake-mobile",
    );
    await expect(page.locator("#workspace-mobile-qr")).toBeVisible();
    await expect(page.locator(".workspace-mobile-output")).toContainText(
      "Metro waiting on",
    );

    await page.locator("#workspace-mobile-stop").click();
    await expect(page.locator("#workspace-mobile")).toContainText("stopped", {
      timeout: 20_000,
    });
  });
});
