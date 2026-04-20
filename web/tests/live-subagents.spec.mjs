import { test, expect } from "@playwright/test";
import { gotoReady } from "./helpers.mjs";

test.describe("Codex Web — sub-agent tray", () => {
  test("renders linked child tasks for the active parent thread", async ({
    page,
  }) => {
    await gotoReady(page);

    await page.evaluate(() => {
      window.state.activeThreadId = "thread-parent";
      window.state.threads = [
        {
          id: "thread-parent",
          name: "Parent thread",
          preview: "Coordinate the rollout",
          lastActive: Date.now(),
          status: "active",
          archived: false,
          source: "mcp",
          turns: [],
        },
        {
          id: "thread-child-1",
          name: "Atlas",
          preview: "Explore the codebase",
          lastActive: Date.now() + 1000,
          status: "active",
          archived: false,
          agentNickname: "Atlas",
          agentRole: "explorer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "thread-parent",
                depth: 1,
                agent_path: "/root/task_1/atlas",
                agent_nickname: "Atlas",
                agent_role: "explorer",
              },
            },
          },
          turns: [
            {
              id: "turn-child-1",
              status: "completed",
              items: [
                {
                  id: "user-1",
                  type: "userMessage",
                  content: [{ type: "text", text: "Inspect the project layout." }],
                },
                {
                  id: "assistant-1",
                  type: "agentMessage",
                  text: "I found the main routing entry points and the settings modal code.",
                },
                {
                  id: "command-1",
                  type: "commandExecution",
                  command: "rg -n \"settings\" web/public",
                },
              ],
            },
          ],
        },
      ];
      window.state.itemOrder = ["collab-1"];
      window.state.itemsById = new Map([
        [
          "collab-1",
          {
            item: {
              id: "collab-1",
              type: "collabAgentToolCall",
              tool: "spawn_agent",
              agentsStates: {
                "thread-child-1": "running",
              },
            },
          },
        ],
      ]);
      window.dispatchEvent(new CustomEvent("codex:refreshSubagents"));
    });

    await expect(page.locator("#subagent-toggle-btn")).toBeVisible();
    await expect(page.locator("#subagent-toggle-btn")).toContainText("Tasks");
    await expect(page.locator("#subagent-pane")).toBeVisible();
    await expect(page.locator("#subagent-pane")).toContainText("Atlas");
    await expect(page.locator("#subagent-pane")).toContainText("running");
    await expect(page.locator("#subagent-pane")).toContainText(
      "Inspect the project layout.",
    );
    await expect(page.locator("#subagent-pane")).toContainText(
      "main routing entry points",
    );
    await expect(page.locator("#subagent-pane")).toContainText(
      "rg -n \"settings\" web/public",
    );
  });
});
