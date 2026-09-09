import { expect, test } from "@playwright/test";

test("real Go probes reach the regional dashboard through the web proxy", async ({ page }) => {
  test.skip(process.env.ARGUS_WEEK3_RUNTIME !== "true", "Requires isolated API, worker, three probes and test target");
  test.setTimeout(100_000);
  await page.context().addCookies([{ name: "argus_mock_user", value: "1", domain: "localhost", path: "/" }]);
  const bootstrap = await page.request.post("/api/backend/api/v1/auth/bootstrap");
  expect(bootstrap.ok()).toBe(true);
  const session = await bootstrap.json();
  const headers = { "x-argus-organization-id": session.organization.id };
  const created = await page.request.post("/api/backend/api/v1/monitors", { headers, data: {
    name: `Week3 browser ${Date.now()}`, intervalSeconds: 60,
    regions: ["ap-southeast-1", "ap-northeast-1", "eu-central-1"],
    config: { kind: "http", url: process.env.ARGUS_SMOKE_TARGET ?? "http://test-target:8080/check", method: "GET", timeoutMs: 5000, expectedStatus: 200, maxRedirects: 5, maxResponseBytes: 1048576 },
  } });
  expect(created.ok()).toBe(true);
  const monitor = await created.json();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  try {
    await page.clock.install();
    await page.goto(`/monitors/${monitor.id}`);
    const overview = page.locator("section", { has: page.getByRole("heading", { name: "Live regional overview" }) });
    await expect(overview.getByText("Passing", { exact: true })).toHaveCount(3, { timeout: 90_000 });
    await expect(overview.getByText("Alive", { exact: true })).toHaveCount(3);
    await expect(overview.getByText("Live updates connected")).toBeVisible();
    await page.screenshot({ path: "test-results/week3-regional-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(overview.getByRole("heading", { name: "Frankfurt", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/week3-regional-mobile.png", fullPage: true });
    const snapshotURL = `**/api/backend/api/v1/monitors/${monitor.id}/snapshot`;
    await page.route(snapshotURL, route => route.abort("failed"));
    await page.clock.fastForward(15_000);
    await expect(overview.getByRole("alert")).toContainText("Displayed data may be outdated");
    await expect(overview.getByText("Passing", { exact: true })).toHaveCount(3);
    await page.unroute(snapshotURL);
    await page.clock.fastForward(15_000);
    await expect(overview.getByRole("alert")).toHaveCount(0);
    await page.route(snapshotURL, route => route.fulfill({ status: 403, json: { code: "DENIED", message: "Access revoked", traceId: "browser-fixture" } }));
    await page.clock.fastForward(15_000);
    await expect(overview.getByText("Regional data unavailable.")).toBeVisible();
    await expect(overview.getByText("Passing", { exact: true })).toHaveCount(0);
    expect(browserErrors).toEqual([]);
  } finally {
    const removed = await page.request.delete(`/api/backend/api/v1/monitors/${monitor.id}`, { headers });
    expect(removed.ok()).toBe(true);
  }
});
