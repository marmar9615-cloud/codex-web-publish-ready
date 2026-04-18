import { test, expect } from "@playwright/test";
import {
  AUTH_WORKFLOWS_ENABLED,
  gotoReady,
  loginWithApiKey,
  sendPrompt,
  waitForTurnComplete,
} from "./helpers.mjs";

test.describe("Codex Web — live authenticated workflows", () => {
  test.skip(!AUTH_WORKFLOWS_ENABLED, "set PLAYWRIGHT_AUTH=1 and PLAYWRIGHT_API_KEY or OPENAI_API_KEY");

  test("runs a real command approval and a real file-change approval", async ({ page }) => {
    test.setTimeout(240_000);

    await gotoReady(page);
    await loginWithApiKey(page);

    await sendPrompt(page, "Use the shell tool to run `pwd`, then tell me the exact working directory.");

    const commandApproval = page.locator(".approval-card").filter({ hasText: "Run command?" }).last();
    await expect(commandApproval).toBeVisible({ timeout: 90_000 });
    await commandApproval.getByRole("button", { name: "Approve once" }).click();
    await expect(page.locator(".tool-card .tc-cmd").last()).toContainText("pwd", { timeout: 90_000 });
    await expect(page.locator(".tool-card pre").last()).toContainText(/\.workdirs|\/Users\//, { timeout: 90_000 });
    await waitForTurnComplete(page);

    const fileName = `playwright-release-smoke-${Date.now()}.txt`;
    await sendPrompt(
      page,
      `Use apply_patch to create a file named ${fileName} in the current workspace root containing exactly ok on one line, then say done.`,
    );

    const fileApproval = page.locator(".approval-card").filter({ hasText: "Apply patch?" }).last();
    await expect(fileApproval).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("#transcript")).toContainText(fileName, { timeout: 90_000 });
    await fileApproval.getByRole("button", { name: "Approve once" }).click();
    await waitForTurnComplete(page);

    const results = await page.evaluate(async (query) => {
      const response = await fetch("/api/file-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      return response.json();
    }, fileName);
    expect(results.results ?? []).toContain(fileName);
  });

  test("keeps auth across reload, supports thread actions, and signs out cleanly", async ({ page }) => {
    test.setTimeout(240_000);

    await gotoReady(page);
    await loginWithApiKey(page);

    await sendPrompt(page, "authenticated thread smoke");
    await expect(page.locator(".thread-item")).toHaveCount(1, { timeout: 60_000 });

    await page.reload();
    await gotoReady(page);
    await expect(page.locator("#account-pill")).toContainText("account: API key", { timeout: 20_000 });

    await page.locator(".thread-main").first().click();
    await expect(page.locator(".cell.user")).toContainText("authenticated thread smoke", { timeout: 20_000 });

    await page.locator(".thread-menu-toggle").first().click();
    await page.getByRole("button", { name: "Fork" }).click();
    await expect(page.locator(".thread-item")).toHaveCount(2, { timeout: 30_000 });

    await sendPrompt(page, "rollback me from the fork");
    await expect(page.locator(".cell.user")).toContainText("rollback me from the fork", { timeout: 60_000 });
    await sendPrompt(page, "/rollback 1");
    await expect(page.locator("#transcript")).toContainText("Rolled back 1 turn.", { timeout: 30_000 });

    await page.locator(".thread-menu-toggle").first().click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.locator("#threads")).toContainText("No saved threads yet.", { timeout: 20_000 });
    await page.locator("#thread-filter-archived").click();
    await expect(page.locator(".thread-item")).toHaveCount(1, { timeout: 20_000 });

    await page.locator("#account-btn").click();
    await expect(page.locator("#account-pill")).toBeHidden({ timeout: 20_000 });
    await expect(page.locator("#account-status")).toContainText("not signed in", { timeout: 20_000 });

    await sendPrompt(page, "logout smoke");
    await expect(page.locator(".auth-required-card")).toContainText("OpenAI authentication required", { timeout: 30_000 });
  });
});
