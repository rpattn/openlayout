import { expect, test } from "@playwright/test";

test("persists local projects, switches safely, and supports undo, redo, and theme", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("OpenLayout", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Local project").locator("option")).toHaveCount(1);

  const clearance = page.getByLabel("Item ↔ item");
  await clearance.fill("0.8"); await clearance.blur();
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.35");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.8");

  await page.getByLabel("Project name").fill("Capsule study"); await page.getByLabel("Project name").blur();
  await page.getByRole("button", { name: "Save project" }).click();
  expect(await page.evaluate(() => localStorage.getItem("openlayout.workspace.v1"))).toContain("Capsule study");
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByLabel("Local project").locator("option")).toHaveCount(2);
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.35");
  await page.getByLabel("Local project").selectOption({ label: "Capsule study" });
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.8");

  const darkCanvas = await canvasData(page, "#layout-canvas");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => canvasData(page, "#layout-canvas")).not.toBe(darkCanvas);
  const activeProjectId = await page.getByLabel("Local project").inputValue();
  await page.reload();
  await expect(page.getByLabel("Local project")).toHaveValue(activeProjectId);
  await expect(page.getByLabel("Project name")).toHaveValue("Capsule study");
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.8");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("keeps packing geometry read-only while solving with overlays", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#container-preview")).toBeVisible();
  await expect(page.locator("[data-item-preview]")).toHaveCount(1);
  await expect(page.locator("#packing-page [data-model-field]")).toHaveCount(0);

  await setPackingNumber(page, "max_iterations", "2000");
  await setPackingNumber(page, "grid_step", "1");
  await setPackingNumber(page, "restarts", "1");
  await page.getByLabel("Quality").selectOption("fast");
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.locator("#layout-title")).toContainText("packed items", { timeout: 20_000 });
  await expect(page.locator("#metrics")).toContainText("Passed");
  await expect(page.locator("#diagnostics")).toContainText("Independent final validation passed");

  const plain = await canvasData(page, "#layout-canvas");
  await page.locator("#packing-dimensions").check();
  expect(await canvasData(page, "#layout-canvas")).not.toBe(plain);
  const dimensions = await canvasData(page, "#layout-canvas");
  await page.locator("#packing-clearance").check();
  expect(await canvasData(page, "#layout-canvas")).not.toBe(dimensions);
});

test("unifies item, container, cut-out, and exclusion editing in the modeller", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Modeller", exact: true }).click();
  await expect(page.locator("#model-canvas")).toBeVisible();
  await expect(page.locator(".layer")).toHaveCount(3);
  await expect(page.locator(".model-dimensions text")).toHaveCount(2);
  await expect(page.locator(".model-clearance")).toHaveCount(3);
  await page.locator("#add-fixed-model").click();
  await expect(page.locator(".fixed-model-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete fixed placement" }).click();
  await expect(page.locator(".fixed-model-row")).toHaveCount(0);

  await page.locator("#model-toggle-dimensions").uncheck();
  await expect(page.locator(".model-dimensions")).toHaveCount(0);
  await page.locator("#model-toggle-dimensions").check();
  await page.locator("#model-toggle-clearance").uncheck();
  await expect(page.locator(".model-clearance")).toHaveCount(0);
  await page.locator("#model-toggle-clearance").check();

  await page.locator('[data-add-target="cutout"]').click();
  await expect(page.locator("#model-target-select")).toHaveValue("container:1");
  await expect(page.locator(".target-settings").first()).toContainText("CONTAINER REGION");
  await page.locator('[data-add-shape="bezier"]').click();
  await expect(page.locator(".bezier-knot")).toHaveCount(4);
  await page.locator('[data-add-target="exclusion"]').click();
  await expect(page.locator("#model-target-select")).toHaveValue("exclusion:1");
  await page.locator('[data-add-target="item"]').click();
  await expect(page.locator("#model-target-select")).toHaveValue("item:1");
  await expect(page.locator(".target-settings").first()).toContainText("ITEM DEFINITION");
  await page.locator("#delete-model-target").click();
  await expect(page.locator("#model-target-select option")).toHaveCount(5);

  await page.locator("#model-target-select").selectOption("item:0");
  await page.locator(".layer").filter({ hasText: "body" }).click();
  const width = page.locator('[data-model-field="width"]');
  await width.fill("7"); await width.blur();
  await expect(width).toHaveValue("7");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('[data-model-field="width"]')).toHaveValue("4");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.locator('[data-model-field="width"]')).toHaveValue("7");

  const rightCircle = page.locator('#model-canvas [data-part-id="end-right"]');
  expect((await shapeCenter(rightCircle)).x).toBeCloseTo(3.5, 1);
  await page.locator('[data-add-shape="bezier"]').click();
  await expect(page.locator(".bezier-control")).toHaveCount(8);
});

test("previews item and container sensitivity geometry and inspects completed results", async ({ page }) => {
  await page.goto("/");
  await setPackingNumber(page, "max_iterations", "1500");
  await setPackingNumber(page, "grid_step", "1");
  await setPackingNumber(page, "restarts", "1");
  await page.getByLabel("Quality").selectOption("fast");
  await page.getByRole("button", { name: "Sensitivity" }).click();
  await expect(page.locator(".shape-step")).toHaveCount(7);
  const itemStart = await canvasData(page, '[data-study-preview="0"]');
  const itemEnd = await canvasData(page, '[data-study-preview="6"]');
  expect(itemEnd).not.toBe(itemStart);

  await page.locator("#study-parameter").selectOption("container_part_width:stock");
  await setStudyNumber(page, "start", "24");
  await setStudyNumber(page, "end", "34");
  await setStudyNumber(page, "initial_step", "5");
  await expect(page.locator(".shape-step")).toHaveCount(3);
  expect(await canvasData(page, '[data-study-preview="2"]')).not.toBe(await canvasData(page, '[data-study-preview="0"]'));

  await page.locator("#study-parameter").selectOption("part_width:item-a:0");
  await setStudyNumber(page, "start", "4");
  await setStudyNumber(page, "end", "4.5");
  await setStudyNumber(page, "initial_step", "0.5");
  await setStudyNumber(page, "transition_tolerance", "0.5");
  await page.getByRole("button", { name: "Run sensitivity study" }).click();
  await expect(page.locator("#status")).toContainText("parameter values evaluated", { timeout: 25_000 });
  await expect(page.locator("#study-progress")).toContainText("points complete");
  await expect(page.locator("#sensitivity-layout-title")).toContainText("items at");
  await page.locator("#sensitivity-canvas").click({ position: { x: 120, y: 80 } });
  await expect(page.locator("#status")).toContainText("Viewing graph point");
});

test("stops an active worker and starts a clean replacement", async ({ page }) => {
  await page.goto("/");
  await setPackingNumber(page, "max_iterations", "5000000");
  await setPackingNumber(page, "grid_step", "0.1");
  await setPackingNumber(page, "restarts", "10");
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("#status")).toContainText("cancelled");
  await expect(page.getByRole("button", { name: "Run packing" })).toBeEnabled();
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
});

async function setPackingNumber(page: import("@playwright/test").Page, field: string, value: string): Promise<void> {
  const input = page.locator(`[data-pack-scope="option"][data-field="${field}"]`);
  await input.fill(value); await input.blur();
}

async function setStudyNumber(page: import("@playwright/test").Page, field: string, value: string): Promise<void> {
  const input = page.locator(`[data-study-field="${field}"]`);
  await input.fill(value); await input.blur();
}

async function canvasData(page: import("@playwright/test").Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
}

async function shapeCenter(locator: import("@playwright/test").Locator): Promise<{ x: number; y: number }> {
  return locator.evaluate((element: SVGGraphicsElement) => { const box = element.getBBox(); return { x: box.x + box.width / 2, y: -(box.y + box.height / 2) }; });
}
