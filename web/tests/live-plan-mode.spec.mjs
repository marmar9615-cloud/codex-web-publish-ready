import { test, expect } from "@playwright/test";
import { gotoReady, sendPrompt } from "./helpers.mjs";

test.describe("Codex Web — plan mode", () => {
  test("sends the active turn with collaboration mode set to plan", async ({
    page,
  }) => {
    const sentFrames = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", (event) => {
        sentFrames.push(String(event.payload ?? ""));
      });
    });

    await gotoReady(page);

    await page.locator("#plan-mode-toggle").click();
    await expect(page.locator("#plan-mode-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#composer-plan-banner")).toBeVisible();
    await expect(page.locator("#composer-plan-banner")).toContainText(
      "Plan mode",
    );

    await sendPrompt(page, "Sketch the rollout before making changes.");

    await expect
      .poll(() => {
        for (const payload of sentFrames) {
          try {
            const message = JSON.parse(payload);
            if (message.method !== "turn/start") continue;
            return message.params?.collaborationMode?.mode ?? null;
          } catch {}
        }
        return null;
      })
      .toBe("plan");

    await expect(page.locator(".cell.user")).toContainText(
      "Sketch the rollout before making changes.",
      {
        timeout: 30_000,
      },
    );
    await expect(page.locator(".auth-required-card")).toContainText(
      "OpenAI authentication required",
      {
        timeout: 30_000,
      },
    );
  });
});
