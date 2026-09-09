import { expect, test } from "@playwright/test";

test("local user can create, edit, and delete an HTTP monitor", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue as local developer" }).click();
  await expect(page.getByRole("heading", { name: "Service monitors" })).toBeVisible();

  await page.getByLabel("Monitor name").fill("Checkout API");
  await page.getByLabel("Endpoint URL").fill("https://example.com/health");
  await page.getByRole("button", { name: "Create monitor" }).click();
  await expect(page.getByText("Checkout API")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Monitor name").fill("Checkout API v2");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Checkout API v2")).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Checkout API v2")).not.toBeVisible();
});
