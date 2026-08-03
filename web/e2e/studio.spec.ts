import { expect, test } from "@playwright/test";

test("composes parameterized primitives, validates, solves, and inspects sensitivity layouts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("OpenLayout", { exact: true })).toBeVisible();
  await expect(page.locator('[data-scope="part"]')).toHaveCount(15);
  await expect(page.locator(".item-preview")).toHaveCount(1);

  const width = page.locator('[data-scope="part"][data-field="width"]').first();
  await width.fill("5");
  await width.press("Tab");
  const exported = JSON.parse(await page.locator("#problem-json").inputValue());
  expect(exported.items[0].shape.parts[0].shape.width).toBe(5);

  await page.getByRole("button", { name: "triangle" }).first().click();
  await expect(page.locator(".part-title").filter({ hasText: "Triangle" })).toHaveCount(1);

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });

  await setNumber(page, "max_iterations", "15000");
  await setNumber(page, "grid_step", "1");
  await setNumber(page, "restarts", "1");
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.locator("#layout-title")).toContainText("packed items", { timeout: 15_000 });
  await expect(page.locator("#layout-id")).toContainText("layout-");
  await expect(page.locator("#metrics")).toContainText("Passed");
  await expect(page.locator("#diagnostics")).toContainText("Independent final validation passed");

  await page.locator("summary").filter({ hasText: "Sensitivity setup" }).click();
  await setNumber(page, "start", "4");
  await setNumber(page, "end", "5");
  await setNumber(page, "initial_step", "1");
  await setNumber(page, "transition_tolerance", "0.5");
  await page.getByRole("button", { name: "Run study" }).click();
  await expect(page.locator("#status")).toContainText("parameter values evaluated", { timeout: 20_000 });
  await expect(page.locator("#sensitivity-canvas")).toBeVisible();
});

test("models shapes on canvas and previews snapped geometry across sensitivity extremes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Shape modeller" }).click();
  await expect(page.locator("#model-canvas")).toBeVisible();
  await expect(page.locator(".layer")).toHaveCount(3);
  await expect(page.locator(".shape-step")).toHaveCount(7);

  const startRightCenter = await shapeCenter(page.locator(".shape-step").first().locator("path").nth(2));
  const endRightCenter = await shapeCenter(page.locator(".shape-step").last().locator("path").nth(2));
  expect(endRightCenter.x - startRightCenter.x).toBeGreaterThan(1.4);

  await page.locator(".layer").filter({ hasText: "body" }).click();
  const width = page.locator('[data-model-field="width"]');
  const resizeHandle = page.locator('[data-resize-anchor="top_right"]');
  const resizeStart = await screenCenter(resizeHandle);
  await page.mouse.move(resizeStart.x, resizeStart.y);
  await page.mouse.down();
  await page.mouse.move(resizeStart.x + 45, resizeStart.y - 20, { steps: 6 });
  await page.mouse.up();
  expect(Number(await width.inputValue())).toBeGreaterThan(4);

  await width.fill("7");
  await width.press("Tab");
  const rightCircle = page.locator('#model-canvas [data-part-id="end-right"]');
  const rightCenter = await shapeCenter(rightCircle);
  expect(rightCenter.x).toBeCloseTo(3.5, 1);

  await page.locator('[data-add-shape="circle"]').click();
  const added = page.locator("#model-canvas [data-part-id]").last();
  const start = await screenCenter(added);
  const target = await worldToScreen(page.locator("#model-canvas"), { x: 3.5, y: 0 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".snap-heading")).toContainText("Anchored");
  await expect(page.locator(".layer.selected")).toContainText("snapped");

  await page.getByRole("button", { name: "Back to packing" }).click();
  await expect(page.locator("#layout-canvas")).toBeVisible();
});

test("stops an active worker and starts a clean replacement", async ({ page }) => {
  await page.goto("/");
  await setNumber(page, "max_iterations", "5000000");
  await setNumber(page, "grid_step", "0.1");
  await setNumber(page, "restarts", "10");
  await page.getByRole("button", { name: "Run packing" }).click();
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.locator("#status")).toContainText("cancelled");
  await expect(page.getByRole("button", { name: "Run packing" })).toBeEnabled();

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
});

async function setNumber(page: import("@playwright/test").Page, field: string, value: string): Promise<void> {
  const input = page.locator(`input[type="number"][data-field="${field}"]`).last();
  await input.fill(value);
  await input.blur();
}

async function shapeCenter(locator: import("@playwright/test").Locator): Promise<{ x: number; y: number }> {
  return locator.evaluate((element: SVGGraphicsElement) => { const box = element.getBBox(); return { x: box.x + box.width / 2, y: -(box.y + box.height / 2) }; });
}

async function screenCenter(locator: import("@playwright/test").Locator): Promise<{ x: number; y: number }> {
  return locator.evaluate((element: SVGGraphicsElement) => { const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
}

async function worldToScreen(locator: import("@playwright/test").Locator, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return locator.evaluate((element: SVGSVGElement, value) => { const svgPoint = element.createSVGPoint(); svgPoint.x = value.x; svgPoint.y = -value.y; const screen = svgPoint.matrixTransform(element.getScreenCTM()!); return { x: screen.x, y: screen.y }; }, point);
}
