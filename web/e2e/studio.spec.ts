import { expect, test } from "@playwright/test";

test("keeps projects and diagnostics behind focused dialogs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("OpenLayout", { exact: true })).toBeVisible();
  await expect(page.locator("#project-dialog")).not.toBeVisible();
  await expect(page.locator("#diagnostics-dialog")).not.toBeVisible();

  await page.getByRole("button", { name: "Edit projects" }).click();
  await expect(page.locator("#project-dialog")).toBeVisible();
  await expect(page.getByLabel("Local project").locator("option")).toHaveCount(1);
  await page.getByLabel("Project name").fill("Capsule study");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Edit projects" })).toContainText("Capsule study");
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByLabel("Local project").locator("option")).toHaveCount(2);
  await page.getByLabel("Local project").selectOption({ label: "Capsule study" });
  await page.getByRole("button", { name: "Close projects" }).click();

  const clearance = page.getByLabel("Item ↔ item");
  await clearance.fill("0.8"); await clearance.blur();
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.35");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByLabel("Item ↔ item")).toHaveValue("0.8");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("openlayout.workspace.v1"))).toContain("Capsule study");
});

test("uses one interactive CAD workspace for definition, editing, pan, zoom, and panel focus", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#cad-canvas")).toBeVisible();
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(1);
  await expect(page.locator('[data-cad-kind="exclusion"]')).toHaveCount(1);
  await expect(page.locator('[data-cad-kind="item"]')).toHaveCount(3);
  await expect(page.locator("#geometry-editor")).toHaveCount(0);
  await expect(page.locator(".cad-library-card")).toHaveCount(0);

  const itemShape = page.locator('[data-cad-kind="item"]').first();
  await itemShape.click();
  await expect(page.locator("#selection-inspector")).toContainText("PACKABLE SHAPE");
  await expect(page.locator('[data-primitive-field="width"]')).toBeVisible();
  await expect(page.locator(".cad-rotate-handle")).toHaveCount(1);
  await expect(page.locator(".cad-geometry-handle")).toHaveCount(8);
  await expect(page.locator(".cad-edit-dimensions text")).toHaveText(["4", "2.4"]);
  await expect(page.locator(".cad-selection-handles rect")).toHaveCount(0);

  const originalItemPath = await itemShape.getAttribute("d");
  const itemBox = await itemShape.boundingBox();
  if (!itemBox) throw new Error("Item definition has no bounding box");
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(itemBox.x + itemBox.width / 2 + 35, itemBox.y + itemBox.height / 2 + 18);
  await page.mouse.up();
  await expect.poll(() => page.locator('[data-cad-kind="item"]').first().getAttribute("d")).not.toBe(originalItemPath);
  await expect(page.locator('[data-primitive-field="x"]')).not.toHaveValue("0");

  const initialView = await page.locator("#cad-canvas").getAttribute("viewBox");
  await page.locator("#cad-canvas").hover({ position: { x: 700, y: 400 } });
  await page.mouse.wheel(0, -500);
  await expect.poll(() => page.locator("#cad-canvas").getAttribute("viewBox")).not.toBe(initialView);
  await page.getByRole("button", { name: "Fit workspace" }).click();
  const fittedView = await page.locator("#cad-canvas").getAttribute("viewBox");
  const canvasBox = await page.locator("#cad-canvas").boundingBox();
  if (!canvasBox) throw new Error("CAD canvas has no bounding box");
  await page.mouse.move(canvasBox.x + 45, canvasBox.y + 115);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 125, canvasBox.y + 155);
  await page.mouse.up();
  await expect.poll(() => page.locator("#cad-canvas").getAttribute("viewBox")).not.toBe(fittedView);
  await page.getByRole("button", { name: "Fit workspace" }).click();

  await page.getByRole("button", { name: "Hide problem panel" }).click();
  await expect(page.locator("#cad-shell")).toHaveClass(/panel-hidden/);
  await page.getByRole("button", { name: "Show problem panel" }).click();
  await expect(page.locator("#cad-shell")).not.toHaveClass(/panel-hidden/);

  await page.getByRole("button", { name: "Dimensions" }).click();
  await expect(page.locator(".cad-dimensions")).toHaveCount(1);
  await page.getByRole("button", { name: "Constraints" }).click();
  await expect(page.locator(".cad-clearance")).not.toHaveCount(0);
});

test("edits item, container, cut-out, and exclusion geometry without leaving the workspace", async ({ page }) => {
  await page.goto("/");
  const initialCircle = page.locator('[data-cad-kind="item"][data-cad-part="1"]'), initialCircleBox = await initialCircle.boundingBox();
  if (!initialCircleBox) throw new Error("Snapped circle has no bounding box");
  await initialCircle.click({ position: { x: initialCircleBox.width * .2, y: initialCircleBox.height / 2 } });
  await expect(page.locator("#item-part-select")).toHaveValue("1");
  await expect(page.locator('[data-primitive-field="radius"]')).toBeVisible();
  await page.locator("#item-part-select").selectOption("0");
  const width = page.locator('[data-primitive-field="width"]');
  const originalWidth = await width.inputValue();
  const widthHandle = page.locator('[data-geometry-handle="resize:right"]');
  const widthHandleBox = await widthHandle.boundingBox();
  if (!widthHandleBox) throw new Error("Direct width handle has no bounding box");
  await page.mouse.move(widthHandleBox.x + widthHandleBox.width / 2, widthHandleBox.y + widthHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(widthHandleBox.x + widthHandleBox.width / 2 + 30, widthHandleBox.y + widthHandleBox.height / 2);
  await page.mouse.up();
  await expect(page.locator('[data-primitive-field="width"]')).not.toHaveValue(originalWidth);
  await width.fill("7"); await width.blur();
  await expect(width).toHaveValue("7");

  const widthBeforeGlobalScale = Number(await width.inputValue());
  const scaleHandle = page.locator(".cad-global-scale-handle");
  const scaleBox = await scaleHandle.boundingBox();
  if (!scaleBox) throw new Error("Global scale handle has no bounding box");
  await page.mouse.move(scaleBox.x + scaleBox.width / 2, scaleBox.y + scaleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(scaleBox.x + scaleBox.width / 2 + 35, scaleBox.y + scaleBox.height / 2 + 25);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator('[data-primitive-field="width"]').inputValue())).not.toBe(widthBeforeGlobalScale);

  const circle = page.locator('[data-cad-kind="item"][data-cad-part="1"]'), circleBox = await circle.boundingBox();
  if (!circleBox) throw new Error("Scaled snapped circle has no bounding box");
  await circle.click({ position: { x: circleBox.width * .2, y: circleBox.height / 2 } });
  await expect(page.locator("[data-snap-target]")).toHaveValue("body");
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(1);
  const snapHandle = page.locator("[data-snap-offset-handle]");
  const snapBox = await snapHandle.boundingBox();
  if (!snapBox) throw new Error("Snap offset handle has no bounding box");
  const originalSnapX = await page.locator('[data-snap-offset="x"]').inputValue();
  await page.mouse.move(snapBox.x + snapBox.width / 2, snapBox.y + snapBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(snapBox.x + snapBox.width / 2 + 24, snapBox.y + snapBox.height / 2 - 12);
  await page.mouse.up();
  await expect(page.locator('[data-snap-offset="x"]')).not.toHaveValue(originalSnapX);
  await page.locator('[data-snap-offset="x"]').fill("1"); await page.locator('[data-snap-offset="x"]').blur();
  const rotateHandle = page.locator(".cad-rotate-handle");
  const rotateBox = await rotateHandle.boundingBox();
  const selectedPartBox = await page.locator('[data-cad-kind="item"][data-cad-part="1"]').boundingBox();
  if (!rotateBox || !selectedPartBox) throw new Error("Global rotation controls have no bounding box");
  await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(selectedPartBox.x + selectedPartBox.width + 45, selectedPartBox.y + selectedPartBox.height / 2);
  await page.mouse.up();
  await expect(page.locator("[data-snap-target]")).toHaveValue("body");
  await expect(page.locator('[data-snap-offset="x"]')).not.toHaveValue("1");

  await page.getByRole("button", { name: "Detach at current position" }).click();
  await expect(page.locator("[data-snap-target]")).toHaveValue("");
  await page.locator("[data-snap-target]").selectOption("body");
  await expect(page.locator("[data-snap-anchor]")).toHaveCount(2);
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(1);

  await page.locator('[data-add-part="bezier"]').click();
  await expect(page.locator("#item-part-select")).toHaveValue("3");
  await expect(page.locator("[data-bezier-knots]")).toBeVisible();
  await expect(page.locator(".cad-bezier-tangent")).toHaveCount(4);
  await expect(page.locator(".cad-geometry-handle.control")).toHaveCount(8);
  await page.locator('[data-add-object="cutout"]').click();
  await expect(page.locator("#selection-inspector")).toContainText("Subtract cut-out");
  await page.locator('[data-add-object="exclusion"]').click();
  await expect(page.locator("#selection-inspector")).toContainText("EXCLUSION");
  await page.locator('[data-add-object="item"]').click();
  await expect(page.locator("#selection-inspector")).toContainText("PACKABLE SHAPE");
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(2);
  await expect(page.locator('[data-cad-kind="exclusion"]')).toHaveCount(2);
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(2);

  const previews = page.locator("[data-entity-preview]");
  await expect(previews).toHaveCount(6);
  const itemPreview = await canvasData(page, '[data-entity-preview="item:0"]');
  const exclusionPreview = await canvasData(page, '[data-entity-preview="exclusion:0"]');
  expect(itemPreview).not.toBe(exclusionPreview);
});

test("keeps oriented snap anchors attached through rotation", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-cad-kind="item"][data-cad-part="0"]').click();
  await page.getByRole("button", { name: "Focus selection" }).click();
  const rotate = page.locator(".cad-rotate-handle"), body = page.locator('[data-cad-kind="item"][data-cad-part="0"]');
  const rotateBox = await rotate.boundingBox(), bodyBox = await body.boundingBox();
  if (!rotateBox || !bodyBox) throw new Error("Definition rotation controls have no bounding box");
  await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bodyBox.x + bodyBox.width + 70, bodyBox.y + bodyBox.height / 2);
  await page.mouse.up();

  const gaps = await page.evaluate(() => {
    const points = (part: string) => {
      const d = document.querySelector(`[data-cad-kind="item"][data-cad-part="${part}"]`)?.getAttribute("d") ?? "";
      const values = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      return Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
    };
    const rectangle = points("0"), left = points("1"), right = points("2");
    const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const center = (values: Array<{ x: number; y: number }>) => ({ x: values.reduce((sum, point) => sum + point.x, 0) / values.length, y: values.reduce((sum, point) => sum + point.y, 0) / values.length });
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    return [distance(midpoint(rectangle[0], rectangle[3]), center(left)), distance(midpoint(rectangle[1], rectangle[2]), center(right))];
  });
  expect(gaps[0]).toBeLessThan(.002);
  expect(gaps[1]).toBeLessThan(.002);
});

test("builds and transforms a joined multi-region material from the toolbar", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-cad-select="container:0"]').click();
  await page.getByRole("button", { name: "Add circle" }).click();
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(2);
  await expect(page.locator("[data-snap-target]")).toHaveValue("container-boundary");
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(1);
  await expect(page.locator(".cad-edit-dimensions text")).toHaveCount(2);

  await page.getByRole("button", { name: "Unify selected material" }).click();
  await expect(page.locator("#status")).toContainText("unified for packing");
  const before = await page.locator('[data-cad-kind="container"]').evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  const rotate = page.locator(".cad-rotate-handle"), selected = page.locator('[data-cad-kind="container"][data-cad-index="1"]');
  const rotateBox = await rotate.boundingBox(), selectedBox = await selected.boundingBox();
  if (!rotateBox || !selectedBox) throw new Error("Joined material rotation controls have no bounding box");
  await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(selectedBox.x + selectedBox.width + 35, selectedBox.y + selectedBox.height / 2);
  await page.mouse.up();
  const after = await page.locator('[data-cad-kind="container"]').evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  expect(after[0]).not.toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  await expect(page.locator("[data-snap-target]")).toHaveValue("container-boundary");

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
  await page.getByRole("button", { name: "Delete selection" }).click();
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(1);
});

test("runs packing and lets a user move and rotate returned items", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await configureFastSolve(page);
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.locator("#workspace-summary")).toContainText("packed items", { timeout: 30_000 });
  await expect(page.locator('[data-cad-kind="placement"]')).not.toHaveCount(0);

  const firstPlacement = page.locator('[data-cad-kind="placement"][data-cad-index="0"]').first();
  const originalPath = await firstPlacement.getAttribute("d");
  await firstPlacement.click();
  await expect(page.locator("#selection-inspector")).toContainText("PACKED ITEM 1");
  const x = page.locator('[data-placement-field="x"]');
  await x.fill(String(Number(await x.inputValue()) + 1)); await x.blur();
  await expect.poll(() => page.locator('[data-cad-kind="placement"][data-cad-index="0"]').first().getAttribute("d")).not.toBe(originalPath);
  await expect(page.locator("#workspace-summary")).toContainText("manual layout");
  await expect(page.locator(".cad-selection-handles circle")).toHaveCount(1);
  const rotation = page.locator('[data-placement-field="rotation_deg"]');
  const originalRotation = await rotation.inputValue();
  const handleBox = await page.locator(".cad-selection-handles circle").boundingBox();
  const placementBox = await page.locator('[data-cad-kind="placement"][data-cad-index="0"]').first().boundingBox();
  if (!handleBox || !placementBox) throw new Error("Placement rotation controls have no bounding box");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(placementBox.x + placementBox.width + 25, placementBox.y + placementBox.height / 2);
  await page.mouse.up();
  await expect(page.locator('[data-placement-field="rotation_deg"]')).not.toHaveValue(originalRotation);

  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.locator("#diagnostics-dialog")).toBeVisible();
  await expect(page.locator("#diagnostics")).toContainText("manually edited");
  await expect(page.locator("#diagnostics")).toContainText("independently valid");
});

test("keeps sensitivity as the only separate analysis view", async ({ page }) => {
  await page.goto("/");
  await configureFastSolve(page);
  await page.getByRole("button", { name: "Sensitivity" }).click();
  await expect(page.locator("#sensitivity-page")).toBeVisible();
  await expect(page.locator(".shape-step")).toHaveCount(7);
  const itemStart = await canvasData(page, '[data-study-preview="0"]');
  const itemEnd = await canvasData(page, '[data-study-preview="6"]');
  expect(itemEnd).not.toBe(itemStart);

  await page.locator("#study-parameter").selectOption("part_width:item-a:0");
  await setStudyNumber(page, "start", "4");
  await setStudyNumber(page, "end", "4.5");
  await setStudyNumber(page, "initial_step", "0.5");
  await setStudyNumber(page, "transition_tolerance", "0.5");
  await page.getByRole("button", { name: "Run sensitivity study" }).click();
  await expect(page.locator("#study-progress")).toContainText("points complete", { timeout: 30_000 });
  await expect(page.locator("#sensitivity-layout-title")).toContainText("items at");
  await page.getByRole("button", { name: "Workspace" }).click();
  await expect(page.locator("#cad-canvas")).toBeVisible();
});

test("stops an active worker and starts a clean replacement", async ({ page }) => {
  await page.goto("/");
  await openSolverSettings(page);
  await setPackingNumber(page, "max_iterations", "5000000");
  await setPackingNumber(page, "grid_step", "0.1");
  await setPackingNumber(page, "restarts", "10");
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("#status")).toContainText("cancelled");
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
});

async function configureFastSolve(page: import("@playwright/test").Page): Promise<void> {
  await openSolverSettings(page);
  await setPackingNumber(page, "max_iterations", "2000");
  await setPackingNumber(page, "grid_step", "1");
  await setPackingNumber(page, "restarts", "1");
  await page.getByLabel("Quality").selectOption("fast");
}

async function openSolverSettings(page: import("@playwright/test").Page): Promise<void> {
  const details = page.locator("details").filter({ hasText: "Solver" });
  if (!(await details.getAttribute("open"))) await details.locator("summary").click();
}

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
