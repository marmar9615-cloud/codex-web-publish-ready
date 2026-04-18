import { expect } from "@playwright/test";

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
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
