import { test, expect } from "@playwright/test";
import { gotoReady } from "./helpers.mjs";

test.describe("Codex Web — todo pane", () => {
  test("renders the latest plan in the sticky todo pane", async ({ page }) => {
    await gotoReady(page);

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("codex:planUpdated", {
          detail: {
            explanation: "Track rollout work",
            plan: [
              { step: "Ship the next wave", status: "inProgress" },
              { step: "Verify the deploy", status: "pending" },
            ],
          },
        }),
      );
    });

    await expect(page.locator("#todo-pane")).toBeVisible();
    await expect(page.locator("#todo-pane")).toContainText("Ship the next wave");
    await expect(page.locator("#todo-pane")).toContainText("in progress");
    await expect(page.locator("#todo-pane")).toContainText("Verify the deploy");
  });
});
