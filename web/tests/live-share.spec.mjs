import { test, expect } from "@playwright/test";
import { BASE_URL } from "./helpers.mjs";

test.describe("Codex Web — shared thread replay", () => {
  test("serves a signed read-only thread replay page", async ({ page, request }) => {
    const threadId = `shared-thread-${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const sampleThread = {
      id: threadId,
      name: "Shared launch thread",
      updatedAt: now,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Ship this change and send me the link." }],
            },
            {
              id: "reason-1",
              type: "reasoning",
              text: "Checking the rollout state and preparing a share link.",
              reasoningEffort: "medium",
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "The local verification is green and the share URL is ready.",
            },
            {
              id: "command-1",
              type: "commandExecution",
              status: "completed",
              command: "git push personal HEAD:main",
              cwd: "/workspace/codex-web",
              aggregatedOutput: "Everything up-to-date\n",
              exitCode: 0,
            },
          ],
        },
      ],
    };

    const createResponse = await request.post(
      `${BASE_URL}/api/threads/${encodeURIComponent(threadId)}/share`,
      {
        data: {
          mode: "readonly",
          ttl: 60 * 60,
          thread: sampleThread,
        },
      },
    );
    expect(createResponse.ok()).toBeTruthy();
    const createData = await createResponse.json();
    const shareUrl = String(createData.shareUrl ?? `${BASE_URL}${createData.sharePath ?? ""}`);

    await page.goto(shareUrl);
    await expect(page.locator("#share-title")).toContainText("Shared launch thread");
    await expect(page.locator("#share-meta")).toContainText("readonly view");
    await expect(page.locator("#transcript")).toContainText(
      "Ship this change and send me the link.",
    );
    await expect(page.locator("#transcript")).toContainText(
      "The local verification is green and the share URL is ready.",
    );
    await expect(page.locator("#transcript")).toContainText(
      "git push personal HEAD:main",
    );
  });
});
