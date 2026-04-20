import http from "node:http";
import { test, expect } from "@playwright/test";
import { gotoReady } from "./helpers.mjs";

test.describe("Codex Web — live preview", () => {
  test("renders a proxied local preview inside the workspace panel", async ({ page }) => {
    const previewPort = 4312;
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${previewPort}`);
      if (requestUrl.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!doctype html>
          <html>
            <head><title>Preview ready</title></head>
            <body>
              <main>
                <h1>Preview Ready</h1>
                <img src="/asset.svg" alt="preview asset" />
              </main>
            </body>
          </html>
        `);
        return;
      }
      if (requestUrl.pathname === "/asset.svg") {
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        res.end(`
          <svg xmlns="http://www.w3.org/2000/svg" width="160" height="80">
            <rect width="160" height="80" rx="12" fill="#f8c15c" />
            <text x="80" y="46" text-anchor="middle" font-family="Arial" font-size="18">asset ok</text>
          </svg>
        `);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    });
    await new Promise((resolve) => server.listen(previewPort, "127.0.0.1", resolve));

    try {
      await gotoReady(page);

      await page.locator("#workspace-preview-port").fill(String(previewPort));
      await page.locator("#workspace-preview-path").fill("/");
      await page.locator("#workspace-preview-load").click();

      const frame = page.frameLocator("#workspace-live-preview-frame");
      await expect(frame.getByRole("heading", { name: "Preview Ready" })).toBeVisible();
      await expect(frame.getByAltText("preview asset")).toBeVisible();
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
