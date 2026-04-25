import { expect } from "@playwright/test";

export const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5100";
export const AUTH_ENABLED = process.env.PLAYWRIGHT_AUTH === "1";
export const AUTH_API_KEY = process.env.PLAYWRIGHT_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
export const AUTH_WORKFLOWS_ENABLED = AUTH_ENABLED && Boolean(AUTH_API_KEY);

export async function gotoReady(page) {
  await page.goto(BASE_URL);
  await expect(page.locator("#backend-pill")).toContainText("backend: real", { timeout: 15_000 });
  await expect(page.locator("#model-pill")).not.toContainText("model: …", { timeout: 15_000 });
}

export async function sendPrompt(page, text) {
  await page.locator("#input").fill(text);
  await page.locator("#input").press("Enter");
}

export async function loginWithApiKey(page) {
  if (!AUTH_API_KEY) throw new Error("PLAYWRIGHT_API_KEY or OPENAI_API_KEY is required");
  await page.locator("#account-btn").click();
  await expect(page.locator(".modal h2")).toContainText("Sign in to Codex");
  await page.locator("#apikey").fill(AUTH_API_KEY);
  await page.locator("#save").click();
  await expect(page.locator("#account-pill")).toContainText("account: API key", { timeout: 20_000 });
}

export async function waitForTurnComplete(page, timeout = 120_000) {
  await expect(page.locator("#transcript")).toContainText("Turn complete", { timeout });
}

export async function activeWorkspaceRoot(page) {
  return (await page.locator("#workspace-root-path").innerText()).trim();
}

export async function openWorkspaceTab(page, name) {
  await page
    .locator(".workspace-tab")
    .filter({ hasText: new RegExp(`^${name}$`, "i") })
    .click();
}

export function sameOriginHeaders() {
  return {
    Origin: BASE_URL,
    "Sec-Fetch-Site": "same-origin",
  };
}
