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
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);
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
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);

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
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator('[data-export="layout-svg"]')).toBeEnabled();
  const layoutDownload = page.waitForEvent("download");
  await page.locator('[data-export="layout-svg"]').click();
  expect((await layoutDownload).suggestedFilename()).toMatch(/-layout\.svg$/);
  await page.getByRole("button", { name: "Close export options" }).click();
  await expect(page.getByRole("button", { name: "Edit layout" })).toBeEnabled();
  await page.getByRole("button", { name: "Edit layout" }).click();
  await expect(page.locator("#workspace-summary")).toContainText("manual layout");
  await page.getByRole("button", { name: "Sensitivity" }).click();
  await page.getByRole("button", { name: "Workspace" }).click();
  await expect(page.locator("#cad-canvas")).toBeVisible();
});

test("makes sensitivity variables, exports, and shortcuts discoverable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await expect(page.locator("#shortcuts-dialog")).toBeVisible();
  await expect(page.locator("#shortcut-list")).toContainText("Toggle dimensions");
  await page.keyboard.press("Escape");
  await page.keyboard.press("d");
  await expect(page.getByRole("button", { name: "Dimensions" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("2");
  await expect(page.locator("#sensitivity-page")).toBeVisible();

  await page.locator("#study-parameter-search").fill("radius");
  await expect(page.locator("#study-parameter-matches button")).toHaveCount(2);
  await page.locator("#study-parameter-matches button").first().click();
  await expect(page.locator("#study-parameter-summary")).toContainText("radius");
  const plainPreview = await canvasData(page, '[data-study-preview="0"]');
  await page.locator("#study-dimensions").check();
  await page.locator("#study-clearance").check();
  expect(await canvasData(page, '[data-study-preview="0"]')).not.toBe(plainPreview);
  await page.getByRole("button", { name: "Set a useful range" }).click();
  await expect(page.locator('[data-study-field="start"]')).not.toHaveValue("3");
  await page.getByRole("button", { name: "Edit varied geometry" }).click();
  await expect(page.locator("#packing-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dimensions" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Constraints" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-dialog")).toBeVisible();
  await expect(page.locator("#export-options")).toContainText("Shape library SVG");
  const shapeDownload = page.waitForEvent("download");
  await page.locator('[data-export="shapes-svg"]').click();
  expect((await shapeDownload).suggestedFilename()).toMatch(/-shapes\.svg$/);
  await expect(page.locator('[data-export="layout-svg"]')).toBeDisabled();
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

test("uses unified silhouettes and permits empty invalid constructions", async ({ page }) => {
  await page.goto("/");
  const itemSilhouette = page.locator('[data-unified-geometry="item:0"]');
  await expect(itemSilhouette).toHaveCount(1);
  expect(((await itemSilhouette.getAttribute("d"))?.match(/M/g) ?? []).length).toBe(1);
  await expect(page.locator('[data-cad-kind="item"]')).toHaveCount(3);

  await page.getByRole("button", { name: "Constraints" }).click();
  await expect(page.locator(".cad-library .cad-clearance.item")).not.toHaveCount(0);

  await page.locator('[data-cad-select="exclusion:0"]').click();
  await page.getByRole("button", { name: "Add circle" }).click();
  await expect(page.locator("#item-part-select option")).toHaveCount(2);
  await expect(page.locator("[data-snap-target]")).not.toHaveValue("");
  await expect(page.locator('[data-unified-geometry="exclusion:0"]')).toHaveCount(1);

  await page.locator('[data-object-field="clearance"]').focus();
  await page.keyboard.press("Backspace");
  await expect(page.locator("#item-part-select option")).toHaveCount(2);
  await page.locator("#cad-canvas").focus();
  await page.keyboard.press("Delete");
  await expect(page.locator("#item-part-select option")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(page.locator("#selection-inspector")).toContainText("Empty construction");
  await expect(page.locator('[data-cad-kind="exclusion"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Delete exclusion" }).click();
  await expect(page.locator('[data-cad-select^="exclusion:"]')).toHaveCount(0);
  await page.locator('[data-cad-select="item:0"]').click();
  await page.getByRole("button", { name: "Delete item" }).click();
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(0);
  await page.locator('[data-cad-select="container:0"]').click();
  await page.getByRole("button", { name: "Delete region" }).click();
  await expect(page.locator('[data-cad-select^="container:"]')).toHaveCount(0);
  await expect(page.locator("#cad-canvas")).toBeVisible();
});

test("snaps by visible anchors, reassigns construction ownership, and colours parts", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-cad-select="item:0"]').click();
  await page.locator("#item-part-select").selectOption("1");
  await expect(page.locator(".cad-snap-anchor")).toHaveCount(0);
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);
  const moveHandle = page.locator(".cad-part-move-handle");
  const moveBox = await moveHandle.boundingBox();
  if (!moveBox) throw new Error("Part move handle is unavailable");
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down();
  await expect(page.locator(".cad-snap-anchor.own")).not.toHaveCount(0);
  const newTarget = page.locator('[data-snap-target-id="body"][data-snap-target-anchor="bottom_left"]');
  const newTargetBox = await newTarget.boundingBox();
  if (!newTargetBox) throw new Error("Snap target is unavailable during part drag");
  await page.mouse.move(newTargetBox.x + newTargetBox.width / 2, newTargetBox.y + newTargetBox.height / 2);
  await page.mouse.up();
  await expect(page.locator('[data-snap-anchor="ownAnchor"]')).toHaveValue("center");
  await expect(page.locator('[data-snap-anchor="targetAnchor"]')).toHaveValue("bottom_left");
  await expect(page.locator('[data-snap-offset="x"]')).toHaveValue("0");
  await expect(page.locator(".cad-snap-anchor")).toHaveCount(0);
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);

  await page.locator('[data-cad-select="container:0"]').click();
  await page.getByRole("button", { name: "Add rectangle" }).click();
  await expect(page.locator(".cad-snap-anchor")).toHaveCount(0);
  const regionMove = page.locator(".cad-part-move-handle");
  const regionMoveBox = await regionMove.boundingBox();
  if (!regionMoveBox) throw new Error("Container part move handle is unavailable");
  await page.mouse.move(regionMoveBox.x + regionMoveBox.width / 2, regionMoveBox.y + regionMoveBox.height / 2);
  await page.mouse.down();
  const regionTarget = page.locator('[data-snap-target-id="container-boundary"][data-snap-target-anchor="top_left"]');
  const regionTargetBox = await regionTarget.boundingBox();
  if (!regionTargetBox) throw new Error("Container snap target is unavailable during drag");
  await page.mouse.move(regionTargetBox.x + regionTargetBox.width / 2, regionTargetBox.y + regionTargetBox.height / 2);
  await page.mouse.up();
  await expect(page.locator('[data-snap-anchor="ownAnchor"]')).toHaveValue("center");
  await expect(page.locator('[data-snap-anchor="targetAnchor"]')).toHaveValue("top_left");
  await expect(page.locator(".cad-snap-anchor")).toHaveCount(0);

  await page.locator("[data-part-owner]").selectOption("item:0");
  await expect(page.locator("#selection-inspector")).toContainText("PACKABLE SHAPE");
  await expect(page.locator("#item-part-select option")).toHaveCount(4);
  const colour = page.locator("[data-primitive-color]");
  await colour.fill("#ff00aa");
  await expect(page.locator("#toolbar-part-color")).toHaveValue("#ff00aa");
  await expect(page.locator('.cad-library .cad-part-color[style*="#ff00aa"]')).toHaveCount(1);
  await page.locator("#toolbar-part-color").fill("#00cc44");
  await expect(page.locator("[data-primitive-color]")).toHaveValue("#00cc44");
  await expect(page.locator('.cad-library .cad-part-color[style*="#00cc44"]')).toHaveCount(1);
});

test("multi-selects, applies bulk actions, and duplicates item definitions", async ({ page }) => {
  await page.goto("/");
  await openSolverSettings(page);
  const baselineOnly = page.locator('[data-field="baseline_only"]');
  await baselineOnly.check();
  await expect(baselineOnly).toBeChecked();

  await page.locator('[data-add-object="item"]').click();
  await page.locator('[data-cad-select="item:0"]').click({ modifiers: ["Control"] });
  await expect(page.locator("#selection-inspector")).toContainText("2 objects selected");
  await page.locator("#toolbar-part-color").fill("#3366ff");
  await expect(page.locator('.cad-library .cad-part-color[style*="#3366ff"]')).toHaveCount(4);

  await page.locator("#cad-canvas").focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(4);
  await expect(page.locator("#selection-inspector")).toContainText("2 objects selected");
  await page.getByRole("button", { name: "Delete selection" }).click();
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(2);

  const samples = page.locator('[data-unified-geometry^="item:"]');
  const first = await samples.nth(0).boundingBox(), second = await samples.nth(1).boundingBox();
  if (!first || !second) throw new Error("Item samples are unavailable for marquee selection");
  const left = Math.min(first.x, second.x) - 8, top = Math.min(first.y, second.y) - 8;
  const right = Math.max(first.x + first.width, second.x + second.width) + 8;
  const bottom = Math.max(first.y + first.height, second.y + second.height) + 8;
  await page.keyboard.down("Control");
  await page.mouse.move(left, top); await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 4 });
  await expect(page.locator(".cad-marquee")).toHaveCount(1);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator("#selection-inspector")).toContainText("2 objects selected");
  await expect(page.locator(".cad-item-sample.selected")).toHaveCount(2);

  const emptyPoint = await page.locator("#cad-canvas").evaluate((svg) => {
    const bounds = svg.getBoundingClientRect();
    for (let y = bounds.top + 12; y < bounds.bottom - 12; y += 24) {
      for (let x = bounds.left + 12; x < bounds.right - 12; x += 24) {
        if ((document.elementFromPoint(x, y) as Element | null)?.matches("[data-cad-background]")) return { x, y };
      }
    }
    return null;
  });
  if (!emptyPoint) throw new Error("CAD workspace has no empty point for clearing selection");
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await expect(page.locator("#selection-inspector")).toContainText("Nothing selected");
  await expect(page.locator(".cad-item-sample.selected")).toHaveCount(0);
});

test("multi-selects individual construction parts and edits them precisely", async ({ page }) => {
  await page.goto("/");
  const parts = page.locator('[data-cad-kind="item"][data-cad-index="0"]');
  await expect(parts).toHaveCount(3);
  const whole = await page.locator('[data-unified-geometry="item:0"]').boundingBox();
  if (!whole) throw new Error("Base construction is unavailable");
  await page.keyboard.down("Control"); await page.mouse.move(whole.x - 5, whole.y - 5); await page.mouse.down();
  await page.mouse.move(whole.x + whole.width + 5, whole.y + whole.height + 5, { steps: 4 }); await page.mouse.up(); await page.keyboard.up("Control");
  await expect(page.locator("#selection-inspector")).toContainText("3 parts selected");
  await page.locator('[data-cad-select="item:0"]').click();
  const x = await page.locator('[data-primitive-field="x"]').inputValue(), y = await page.locator('[data-primitive-field="y"]').inputValue();
  await page.locator("[data-primitive-kind]").selectOption("circle");
  await expect(page.locator('[data-primitive-field="x"]')).toHaveValue(x); await expect(page.locator('[data-primitive-field="y"]')).toHaveValue(y);
  await parts.nth(1).evaluate((node) => {
    const box = node.getBoundingClientRect(), init = { bubbles: true, pointerId: 41, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    node.dispatchEvent(new PointerEvent("pointerdown", init)); node.dispatchEvent(new PointerEvent("pointerup", init));
  });
  await parts.nth(2).evaluate((node) => {
    const box = node.getBoundingClientRect(), init = { bubbles: true, ctrlKey: true, pointerId: 42, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    node.dispatchEvent(new PointerEvent("pointerdown", init)); node.dispatchEvent(new PointerEvent("pointerup", init));
  });
  await expect(page.locator("#selection-inspector")).toContainText("2 parts selected");
  await expect(page.locator(".cad-group-selection")).toContainText("2 selected");
  await expect(page.locator(".cad-selection-handles")).toHaveCount(0);
  await expect(page.locator(".cad-group-rotate")).toHaveCount(1); await expect(page.locator(".cad-group-scale")).toHaveCount(1);
  const groupBefore = await page.locator(".cad-group-selection rect").boundingBox();
  if (!groupBefore) throw new Error("Group transform cage is unavailable");
  const selectedCircle = await parts.nth(1).boundingBox(); if (!selectedCircle) throw new Error("Selected circle is unavailable for group dragging");
  await page.mouse.move(selectedCircle.x + selectedCircle.width / 2, selectedCircle.y + selectedCircle.height / 2); await page.mouse.down();
  await page.mouse.move(selectedCircle.x + selectedCircle.width / 2 + 30, selectedCircle.y + selectedCircle.height / 2 + 12); await page.mouse.up();
  const groupMoved = await page.locator(".cad-group-selection rect").boundingBox();
  expect(groupMoved?.x).not.toBeCloseTo(groupBefore.x, 0);
  const scaleHandle = await page.locator(".cad-group-scale").boundingBox();
  if (!scaleHandle || !groupMoved) throw new Error("Group scale handle is unavailable");
  await page.mouse.move(scaleHandle.x + scaleHandle.width / 2, scaleHandle.y + scaleHandle.height / 2); await page.mouse.down();
  await page.mouse.move(scaleHandle.x + scaleHandle.width / 2 + 20, scaleHandle.y + scaleHandle.height / 2 + 12); await page.mouse.up();
  const groupScaled = await page.locator(".cad-group-selection rect").boundingBox();
  expect(groupScaled?.width).not.toBeCloseTo(groupMoved.width, 0);
  await page.locator("#toolbar-part-color").evaluate((input: HTMLInputElement) => { input.value = "#ff00aa"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await expect(page.locator('.cad-library .cad-part-color[style*="#ff00aa"]')).toHaveCount(2);
  await page.getByRole("button", { name: "Delete selection" }).click();
  await expect(page.locator('[data-cad-kind="item"][data-cad-index="0"]')).toHaveCount(1);
});

test("uses a restrained CAD palette in dark mode", async ({ page }) => {
  await page.goto("/");
  const containerFill = await page.locator(".cad-part-color.container").first().evaluate((node) => getComputedStyle(node).fill);
  expect(containerFill).not.toBe("rgb(231, 235, 239)");
  await page.getByRole("button", { name: "Constraints", exact: true }).click();
  const clearanceStroke = await page.locator(".cad-clearance").first().evaluate((node) => getComputedStyle(node).stroke);
  const fixedAccent = await page.locator("#respect-manual-constraints").evaluate((node) => getComputedStyle(node).color);
  expect(clearanceStroke).not.toBe(fixedAccent);
});

test("retains solved layouts for stale edits and copies solved placements", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.getByRole("button", { name: "Run packing" })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator(".cad-placement").first()).toBeVisible();
  const before = await page.locator(".cad-placement").count();
  await page.locator(".cad-placement").first().click();
  await page.keyboard.press("Control+c"); await page.keyboard.press("Control+v");
  await expect(page.locator(".cad-placement")).toHaveCount(before + 1);
  await page.locator('[data-cad-select="item:0"]').click();
  await page.locator('[data-object-field="quantity"]').fill("81"); await page.locator('[data-object-field="quantity"]').blur();
  await expect(page.locator(".cad-placement")).toHaveCount(before + 1);
  await expect(page.locator("#workspace-summary")).toContainText("stale");
});

test("creates an empty project and previews fixed placements", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Fixed placements", { exact: false }).click();
  await page.getByRole("button", { name: "+ Add fixed placement" }).click();
  await expect(page.locator(".cad-placement.fixed")).toHaveCount(1);
  const initialX = await page.locator('[data-fixed-field="x"]').inputValue();
  const fixed = await page.locator(".cad-placement.fixed").boundingBox();
  if (!fixed) throw new Error("Fixed placement preview is unavailable");
  await page.mouse.move(fixed.x + fixed.width / 2, fixed.y + fixed.height / 2); await page.mouse.down(); await page.mouse.move(fixed.x + fixed.width / 2 + 500, fixed.y + fixed.height / 2); await page.mouse.up();
  await expect(page.locator('[data-fixed-field="x"]')).not.toHaveValue(initialX);
  await expect(page.locator("#status")).toContainText("closest feasible");
  await page.getByRole("button", { name: "Edit projects" }).click();
  await page.getByRole("button", { name: "New empty" }).click();
  await expect(page.locator('[data-cad-select="container:0"]')).toHaveCount(0);
  await page.locator("#project-dialog").getByRole("button", { name: "Close projects" }).click();
  await page.getByRole("button", { name: "+ Item" }).click();
  await page.getByText("Fixed placements", { exact: false }).click();
  await page.getByRole("button", { name: "+ Add fixed placement" }).click();
  await expect(page.locator(".cad-placement.fixed")).toHaveCount(1);
  await expect(page.locator(".cad-fixed-badge")).toHaveCount(1);
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
