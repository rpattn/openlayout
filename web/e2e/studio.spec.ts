import { expect, test } from "@playwright/test";

test("builds Boolean container regions and exposes adaptive rotation controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "− Add cut-out" }).click();
  const exported = JSON.parse(await page.locator("#problem-json").inputValue());
  expect(exported.schema_version).toBe(2);
  expect(exported.container.parts).toHaveLength(2);
  expect(exported.container.parts[1].operation).toBe("subtract");
  expect(exported.items[0].rotation_policy).toEqual({ kind: "continuous", min_deg: 0, max_deg: 360, coupling: "independent" });
  await page.getByRole("button", { name: "Edit visually" }).nth(1).click();
  await expect(page.locator(".geometry-context")).toContainText("Container · cutout-1");
  await page.getByRole("button", { name: "Back to packing" }).click();
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
});

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
  const plainLayout = await page.locator("#layout-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.locator("#toggle-dimensions").check();
  const dimensionLayout = await page.locator("#layout-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  expect(dimensionLayout).not.toBe(plainLayout);
  await page.locator("#toggle-clearance").check();
  const clearanceLayout = await page.locator("#layout-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  expect(clearanceLayout).not.toBe(dimensionLayout);

  await page.locator("summary").filter({ hasText: "Sensitivity setup" }).click();
  await setNumber(page, "start", "4");
  await setNumber(page, "end", "5");
  await setNumber(page, "initial_step", "1");
  await setNumber(page, "transition_tolerance", "0.5");
  await page.getByRole("button", { name: "Run study" }).click();
  await expect(page.locator("#status")).toContainText("parameter values evaluated", { timeout: 20_000 });
  await expect(page.locator("#sensitivity-canvas")).toBeVisible();
  await expect(page.locator("#study-progress")).toContainText("points complete");
  await expect(page.locator("#study-progress progress")).toHaveAttribute("value", "100");
  await page.locator("#sensitivity-canvas").click({ position: { x: 120, y: 70 } });
  await expect(page.locator("#status")).toContainText("Viewing graph point");
  const before = page.locator(".transition button").filter({ hasText: "Before" }).first();
  if (await before.count()) {
    await before.click();
    await expect(page.locator("#status")).toContainText("Viewing before point");
    await page.locator(".transition button").filter({ hasText: "After" }).first().click();
    await expect(page.locator("#status")).toContainText("Viewing after point");
  }
});

test("models shapes on canvas and previews snapped geometry across sensitivity extremes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Shape modeller" }).click();
  await expect(page.locator("#model-canvas")).toBeVisible();
  await expect(page.locator(".layer")).toHaveCount(3);
  await expect(page.locator(".shape-step")).toHaveCount(7);
  await expect(page.locator(".model-dimensions text")).toHaveCount(2);
  await expect(page.locator(".model-clearance")).toHaveCount(3);
  expect(await page.locator(".model-dimensions text").first().evaluate((element) => getComputedStyle(element).stroke)).toBe("none");

  await page.locator(".layer").filter({ hasText: "end-left" }).click();
  const snappedChild = page.locator('#model-canvas [data-part-id="end-left"]');
  const snappedStart = await screenCenter(snappedChild);
  await page.mouse.move(snappedStart.x, snappedStart.y); await page.mouse.down(); await page.mouse.move(snappedStart.x + 38, snappedStart.y - 18, { steps: 6 }); await page.mouse.up();
  await expect(page.locator(".layer.selected")).toContainText("snapped");

  await page.locator("#model-target-select").selectOption("container:0");
  await expect(page.locator(".layer")).toHaveCount(1);
  await expect(page.locator(".geometry-context")).toContainText("Container · stock");
  await expect(page.locator(".model-clearance")).toHaveCount(1);
  await page.locator('[data-add-shape="bezier"]').click();
  await expect(page.locator(".bezier-knot")).toHaveCount(4);
  await page.locator("#model-target-select").selectOption("exclusion:0");
  await expect(page.locator(".geometry-context")).toContainText("Exclusion");
  const exclusionShape = page.locator("#model-canvas [data-part-id]").first();
  const exclusionStart = await screenCenter(exclusionShape);
  await page.mouse.move(exclusionStart.x, exclusionStart.y); await page.mouse.down(); await page.mouse.move(exclusionStart.x + 12, exclusionStart.y - 5); await page.mouse.up();
  await page.locator("#model-target-select").selectOption("item:0");
  await expect(page.locator(".layer")).toHaveCount(3);

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
  const bodyRotation = page.locator('[data-model-field="rotation"]');
  await bodyRotation.fill("30"); await bodyRotation.press("Tab");
  const rotatedRightCenter = await shapeCenter(rightCircle);
  expect(rotatedRightCenter.x).toBeCloseTo(3.5 * Math.cos(Math.PI / 6), 1);
  expect(rotatedRightCenter.y).toBeCloseTo(3.5 * Math.sin(Math.PI / 6), 1);
  await bodyRotation.fill("0"); await bodyRotation.press("Tab");

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

  await page.locator('[data-add-shape="bezier"]').click();
  await expect(page.locator(".bezier-knot")).toHaveCount(4);
  await expect(page.locator(".bezier-control")).toHaveCount(8);
  const tangent = await screenCenter(page.locator(".bezier-control").first());
  await page.mouse.move(tangent.x, tangent.y); await page.mouse.down(); await page.mouse.move(tangent.x + 12, tangent.y - 8); await page.mouse.up();
  const rotate = await screenCenter(page.locator(".rotate-handle"));
  await page.mouse.move(rotate.x, rotate.y); await page.mouse.down(); await page.mouse.move(rotate.x + 55, rotate.y + 30, { steps: 6 }); await page.mouse.up();
  expect(Math.abs(Number(await page.locator('[data-model-field="rotation"]').inputValue()))).toBeGreaterThan(5);

  await page.getByRole("button", { name: "Back to packing" }).click();
  await expect(page.locator("#layout-canvas")).toBeVisible();
  expect(JSON.parse(await page.locator("#problem-json").inputValue()).container.parts[0].shape.kind).toBe("bezier");
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
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
