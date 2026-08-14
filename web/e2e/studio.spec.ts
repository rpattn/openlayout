import { expect, test, type Page } from "@playwright/test";

async function clickMoreTool(page: Page, name: string): Promise<void> {
  const drafting: Record<string, string> = {
    "Drafting aids": "Drafting settings", "Add trace image": "Trace image", "Add scene text": "Text",
    "Add vertical drafting line": "Vertical guide", "Add horizontal drafting line": "Horizontal guide",
    "Draw two-point drafting line": "Two-point line", "Draw drafting polyline": "Polyline", "Drafting shape mode": "Rectangle",
  };
  if (drafting[name]) {
    await page.locator("#add-drafting").hover();
    await page.locator("#add-drafting-menu").getByRole("menuitemradio", { name: new RegExp(drafting[name]) }).click();
    await page.mouse.move(700, 500);
    return;
  }
  if (name === "Create dimension") {
    await page.locator("#toggle-dimensions").hover();
    await page.locator("#toggle-dimensions-menu").getByRole("menuitem", { name: /Dimension between two points/ }).click();
    await page.mouse.move(700, 500);
    return;
  }
  const promoted: Record<string, string> = { "Toggle manual collision guard": "#respect-manual-constraints" };
  if (promoted[name]) { await page.locator(promoted[name]).click(); return; }
  const direct = page.getByRole("button", { name, exact: true });
  if (await direct.count() === 1 && await direct.isVisible()) { await direct.click(); return; }
  const more = page.locator(".toolbar-more");
  if (!(await more.evaluate((node) => (node as HTMLDetailsElement).open))) await more.locator(":scope > summary").click();
  await more.getByRole("button", { name, exact: true }).click();
}

async function openInspectorDetails(page: Page, key: string): Promise<void> {
  const details = page.locator(`#selection-inspector details[data-inspector-detail="${key}"]`);
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
}

test("keeps projects and diagnostics behind focused dialogs", async ({ page }) => {
  await page.goto("/");
  const brandBox = await page.locator(".brand-lockup").boundingBox(), projectBox = await page.locator(".project-quick").boundingBox();
  if (!brandBox || !projectBox) throw new Error("Project header bounds unavailable");
  expect(Math.abs((brandBox.y + brandBox.height / 2) - (projectBox.y + projectBox.height / 2))).toBeLessThan(3);
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

  await clickMoreTool(page, "Toggle theme");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("openlayout.workspace.v1"))).toContain("Capsule study");
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openlayout.workspace", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction("snapshots", "readonly").objectStore("snapshots").get("workspace.v1");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    database.close(); return String(value);
  })).toContain("Capsule study");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit projects" })).toContainText("Capsule study");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
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
  await expect(page.locator("#selection-inspector")).toContainText("Selected item");
  await expect(page.locator("#packing-sidebar > #selection-inspector")).toHaveCount(1);
  await expect(page.locator("[data-primitive-kind]")).toBeVisible();
  await expect(page.locator('[data-object-field="quantity"]')).toBeVisible();
  await expect(page.locator('[data-primitive-field="width"]')).not.toBeVisible();
  await openInspectorDetails(page, "geometry-precision");
  await expect(page.locator('[data-primitive-field="width"]')).toBeVisible();
  await expect(page.locator(".cad-rotate-handle")).toHaveCount(1);
  await expect(page.locator(".cad-geometry-handle")).toHaveCount(8);
  await expect(page.locator(".cad-edit-dimensions")).toHaveCount(0);
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
  await expect(page.locator(".cad-dimensions")).not.toHaveCount(0);
  await expect(page.locator('[data-dimension-owner^="exclusion:"]')).toHaveCount(1);
  await expect(page.locator('[data-dimension-owner^="item:"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Spacing", exact: true }).click();
  await expect(page.locator(".cad-clearance")).not.toHaveCount(0);
});

test("provides engineering dimensions, persistent view settings, and vertical navigation", async ({ page }) => {
  await page.goto("/");
  const navigation = page.locator(".cad-nav-toolbar");
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button")).toHaveCount(5);
  await expect(navigation.getByRole("button", { name: "Select tool" })).toBeVisible();
  expect(await navigation.evaluate((node) => getComputedStyle(node).flexDirection)).toBe("column");
  const navBox = await navigation.boundingBox(), viewport = page.viewportSize();
  if (!navBox || !viewport) throw new Error("Navigation toolbar bounds unavailable");
  expect(viewport.width - (navBox.x + navBox.width)).toBeLessThan(24);
  await expect(page.locator(".cad-toolbar .toolbar-group")).toHaveCount(6);
  await expect(page.locator('.cad-toolbar .toolbar-group[aria-label="Draw"]')).toBeVisible();
  await expect(page.locator(".toolbar-more")).toBeVisible();
  await expect(page.locator("#toggle-grid-snap")).toBeVisible();
  await expect(page.locator("#respect-manual-constraints")).toBeVisible();
  await expect(page.locator("#add-drafting")).toBeVisible();
  await expect(page.locator("#theme-toggle")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dimensions" })).toBeVisible();
  await page.locator("#toggle-dimensions").hover();
  await expect(page.getByRole("menuitem", { name: /Dimension between two points/ })).toBeVisible();
  await page.mouse.move(700, 500);

  await page.getByRole("button", { name: "View settings" }).click();
  const panel = page.getByLabel("View settings panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Dimensions").check();
  await panel.getByLabel("Text size px").fill("16"); await panel.getByLabel("Text size px").blur();
  await panel.getByLabel("Edge thickness px").fill("2.5"); await panel.getByLabel("Edge thickness px").blur();
  await panel.getByLabel("Decimals").fill("1"); await panel.getByLabel("Decimals").blur();
  await panel.getByLabel("Grid spacing").fill("1"); await panel.getByLabel("Grid spacing").blur();
  await panel.getByRole("checkbox", { name: "Grid", exact: true }).uncheck();

  await expect(page.locator('[data-dimension-owner="material"] [data-dimension-axis]')).toHaveCount(2);
  await expect(page.locator('[data-dimension-owner="item:item-a"] [data-dimension-axis]')).toHaveCount(2);
  await expect(page.locator('[data-dimension-owner="exclusion:exclusion-a"] text')).toContainText("Ø4.2 mm");
  const materialLabel = await page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] text').boundingBox();
  const itemLabel = await page.locator('[data-dimension-owner="item:item-a"] [data-dimension-axis="width"] text').boundingBox();
  if (!materialLabel || !itemLabel) throw new Error("Generated dimension labels unavailable");
  expect(Math.abs(materialLabel.y - itemLabel.y)).toBeGreaterThan(5);
  await expect(page.locator(".cad-grid line")).toHaveCount(0);
  await expect(page.locator("#cad-canvas")).toHaveCSS("--cad-edge-width", "2.5px");

  await page.reload();
  await page.getByRole("button", { name: "View settings" }).click();
  await expect(page.getByLabel("View settings panel").getByLabel("Text size px")).toHaveValue("16");
  await expect(page.getByLabel("View settings panel").getByLabel("Grid spacing")).toHaveValue("1");
  await expect(page.getByLabel("View settings panel").getByRole("checkbox", { name: "Grid", exact: true })).not.toBeChecked();
});

test("uses remembered hover-menu shapes for material, cut-out, item, and exclusion", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#add-material")).toHaveAttribute("data-value", "rectangle");
  await expect(page.locator("#add-cutout")).toHaveAttribute("data-value", "rectangle");
  await expect(page.locator("#add-item")).toHaveAttribute("data-value", "rectangle");
  await expect(page.locator("#add-exclusion")).toHaveAttribute("data-value", "rectangle");

  await page.locator("#add-material").hover();
  await page.locator("#add-material-menu").getByRole("menuitemradio", { name: /Circle/ }).click();
  await expect(page.locator('[data-cad-select^="container:"]')).toHaveCount(2);
  await expect(page.locator("#add-material")).toHaveAttribute("data-value", "circle");
  await expect(page.locator("[data-primitive-kind]")).toHaveValue("circle");
  await openInspectorDetails(page, "geometry-precision");
  await expect(page.locator('[data-primitive-field="radius"]')).toBeVisible();
  await page.locator("#add-material").click();
  await expect(page.locator('[data-cad-select^="container:"]')).toHaveCount(3);

  await page.locator("#add-cutout").hover();
  await page.locator("#add-cutout-menu").getByRole("menuitemradio", { name: /Bézier/ }).click();
  await expect(page.locator('[data-cad-select^="container:"]')).toHaveCount(4);
  await expect(page.locator("#add-cutout")).toHaveAttribute("data-value", "bezier");

  await page.locator("#add-item").hover();
  await page.locator("#add-item-menu").getByRole("menuitemradio", { name: /Triangle/ }).click();
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(2);
  await expect(page.locator("#add-item")).toHaveAttribute("data-value", "triangle");

  await page.locator("#add-exclusion").hover();
  await page.locator("#add-exclusion-menu").getByRole("menuitemradio", { name: /Polygon/ }).click();
  await expect(page.locator('[data-cad-select^="exclusion:"]')).toHaveCount(2);
  await expect(page.locator("#add-exclusion")).toHaveAttribute("data-value", "polygon");
  await expect(page.locator("#add-exclusion [data-split-icon]")).toHaveText("⊘");
  await expect(page.locator(".palette-check, .split-toggle")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#add-material")).toHaveAttribute("data-value", "circle");
  await expect(page.locator("#add-cutout")).toHaveAttribute("data-value", "bezier");
  await expect(page.locator("#add-item")).toHaveAttribute("data-value", "triangle");
  await expect(page.locator("#add-exclusion")).toHaveAttribute("data-value", "polygon");
});

test("creates, moves, overrides, persists, and exports first-class dimensions", async ({ page }) => {
  await page.goto("/");
  const item = page.locator('[data-cad-kind="item"][data-cad-part="0"]');
  await expect(item).toBeVisible();
  const box = await item.boundingBox(); if (!box) throw new Error("Item bounds unavailable");
  await clickMoreTool(page, "Create dimension");
  await page.mouse.click(box.x, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width, box.y + box.height / 2);

  const dimension = page.locator('[data-dimension-owner^="custom:"]');
  await expect(dimension).toHaveCount(1);
  await expect(page.locator(".cad-edit-dimensions")).toHaveCount(0);
  await expect(page.locator('[data-dimension-owner="clearance:boundary"] text')).toContainText("clear");
  await expect(page.locator('[data-dimension-owner="clearance:item-to-item"] text')).toContainText("0.35 mm clear");

  await dimension.locator(".cad-dimension-line").click({ force: true });
  const override = page.getByLabel("Text override"); await override.fill("ASSEMBLY GAP"); await override.blur();
  await expect(dimension.locator("text")).toHaveText("ASSEMBLY GAP");
  const line = dimension.locator(".cad-dimension-line"), lineBox = await line.boundingBox(); if (!lineBox) throw new Error("Dimension line unavailable");
  await page.mouse.move(lineBox.x + lineBox.width / 2, lineBox.y + lineBox.height / 2);
  await page.mouse.down(); await page.mouse.move(lineBox.x + lineBox.width / 2, lineBox.y + lineBox.height / 2 - 35, { steps: 4 }); await page.mouse.up();
  await expect(page.getByLabel("Offset Y")).not.toHaveValue("0");
  const snappedOffset = Number(await page.getByLabel("Offset Y").inputValue());
  expect(snappedOffset / .5).toBeCloseTo(Math.round(snappedOffset / .5), 6);
  const movedLineBox = await dimension.locator(".cad-dimension-line").boundingBox(); if (!movedLineBox) throw new Error("Moved dimension line unavailable");
  await page.keyboard.down("Alt"); await page.mouse.move(movedLineBox.x + movedLineBox.width / 2, movedLineBox.y + movedLineBox.height / 2); await page.mouse.down();
  await page.mouse.move(movedLineBox.x + movedLineBox.width / 2 + 13, movedLineBox.y + movedLineBox.height / 2 - 9, { steps: 3 }); await page.mouse.up(); await page.keyboard.up("Alt");
  const bypassedOffset = Number(await page.getByLabel("Offset Y").inputValue());
  expect(Math.abs(bypassedOffset / .5 - Math.round(bypassedOffset / .5))).toBeGreaterThan(.001);

  await page.reload();
  await expect(page.locator('[data-dimension-owner^="custom:"] text')).toHaveText("ASSEMBLY GAP");
  const automatic = page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] .cad-dimension-line');
  const originalY = Number(await automatic.getAttribute("y1")), automaticBox = await page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] text').boundingBox(); if (!automaticBox) throw new Error("Automatic dimension unavailable");
  await page.mouse.move(automaticBox.x + automaticBox.width / 2, automaticBox.y + automaticBox.height / 2);
  await page.mouse.down(); await page.mouse.move(automaticBox.x + automaticBox.width / 2, automaticBox.y + automaticBox.height / 2 - 24, { steps: 3 }); await page.mouse.up();
  const movedY = Number(await automatic.getAttribute("y1")); expect(movedY).not.toBe(originalY);
  await expect(page.locator("#selection-inspector")).toContainText("GENERATED DIMENSION");
  await page.locator('[data-auto-dimension-field="override"]').fill("STOCK WIDTH"); await page.locator('[data-auto-dimension-field="override"]').blur();
  await expect(page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] text')).toHaveText("STOCK WIDTH");
  await page.reload();
  expect(Number(await page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] .cad-dimension-line').getAttribute("y1"))).toBeCloseTo(movedY, 3);
  await expect(page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] text')).toHaveText("STOCK WIDTH");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-export="scene-png"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-scene\.png$/);
  expect(Number(await page.locator('[data-dimension-owner="material"] [data-dimension-axis="width"] .cad-dimension-line').getAttribute("y1"))).toBeCloseTo(movedY, 3);
});

test("adds editable scene text and directly moves, resizes, rotates, and persists it", async ({ page }) => {
  await page.goto("/");
  const itemStyle = await page.locator(".cad-part-color.item").first().getAttribute("style");
  await clickMoreTool(page, "Add scene text");
  const text = page.locator(".cad-scene-text");
  await expect(text).toHaveText("Annotation");
  expect(Number(await page.locator('[data-text-field="x"]').inputValue()) / .5).toBeCloseTo(Math.round(Number(await page.locator('[data-text-field="x"]').inputValue()) / .5), 6);
  await page.locator('[data-text-field="text"]').fill("CUT LINE\nDO NOT CROSS"); await page.locator('[data-text-field="text"]').blur();
  await expect(text.locator("tspan")).toHaveText(["CUT LINE", "DO NOT CROSS"]);
  const toolbarColour = page.locator("#toolbar-part-color"); await expect(toolbarColour).toBeEnabled();
  await toolbarColour.evaluate((input: HTMLInputElement) => { input.value = "#ff00aa"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await expect(text).toHaveCSS("fill", "rgb(255, 0, 170)");
  await expect(page.locator('[data-text-field="color"]')).toHaveValue("#ff00aa");
  await expect(page.locator(".cad-part-color.item").first()).toHaveAttribute("style", itemStyle!);
  await page.locator('[data-text-field="fontFamily"]').selectOption("sans");
  await page.locator('[data-text-field="align"]').selectOption("center");
  await page.locator('[data-text-field="bold"]').check(); await page.locator('[data-text-field="italic"]').check(); await page.locator('[data-text-field="underline"]').check();
  await expect(text).toHaveAttribute("text-anchor", "middle"); await expect(text).toHaveCSS("font-weight", "700");
  await expect(text).toHaveCSS("font-style", "italic"); await expect(text).toHaveCSS("text-decoration-line", "underline");

  const x = page.locator('[data-text-field="x"]'), originalX = Number(await x.inputValue());
  const hitBox = await page.locator(".cad-text-hit").boundingBox(); if (!hitBox) throw new Error("Text hit area unavailable");
  await page.mouse.move(hitBox.x + hitBox.width / 2, hitBox.y + hitBox.height / 2); await page.mouse.down();
  await page.mouse.move(hitBox.x + hitBox.width / 2 + 42, hitBox.y + hitBox.height / 2 - 18, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await page.locator('[data-text-field="x"]').inputValue())).not.toBe(originalX);
  const snappedTextX = Number(await page.locator('[data-text-field="x"]').inputValue()); expect(snappedTextX / .5).toBeCloseTo(Math.round(snappedTextX / .5), 6);
  const movedTextBox = await page.locator(".cad-text-hit").boundingBox(); if (!movedTextBox) throw new Error("Moved text hit area unavailable");
  await page.keyboard.down("Alt"); await page.mouse.move(movedTextBox.x + movedTextBox.width / 2, movedTextBox.y + movedTextBox.height / 2); await page.mouse.down();
  await page.mouse.move(movedTextBox.x + movedTextBox.width / 2 + 11, movedTextBox.y + movedTextBox.height / 2 - 7, { steps: 3 }); await page.mouse.up(); await page.keyboard.up("Alt");
  const bypassedTextX = Number(await page.locator('[data-text-field="x"]').inputValue()); expect(Math.abs(bypassedTextX / .5 - Math.round(bypassedTextX / .5))).toBeGreaterThan(.001);

  const size = page.locator('[data-text-field="fontSize"]'), originalSize = Number(await size.inputValue());
  const resize = page.locator(".cad-global-scale-handle"), resizeBox = await resize.boundingBox(); if (!resizeBox) throw new Error("Text resize handle unavailable");
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2); await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 35, resizeBox.y + resizeBox.height / 2 + 25, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await page.locator('[data-text-field="fontSize"]').inputValue())).not.toBe(originalSize);

  const rotation = page.locator('[data-text-field="rotation"]');
  const rotateBox = await page.locator(".cad-rotate-handle").boundingBox(), currentTextBox = await page.locator(".cad-text-hit").boundingBox(); if (!rotateBox || !currentTextBox) throw new Error("Text rotation controls unavailable");
  await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2); await page.mouse.down();
  await page.mouse.move(currentTextBox.x + currentTextBox.width + 30, currentTextBox.y + currentTextBox.height / 2, { steps: 4 }); await page.mouse.up();
  await expect(rotation).not.toHaveValue("0");

  const savedText = await page.locator('[data-text-field="text"]').inputValue(), savedSize = await size.inputValue();
  await page.reload();
  await expect(page.locator(".cad-scene-text")).toContainText("CUT LINE");
  await page.locator(".cad-text-hit").click();
  await expect(page.locator('[data-text-field="text"]')).toHaveValue(savedText);
  await expect(page.locator('[data-text-field="fontSize"]')).toHaveValue(savedSize);
  await expect(page.locator('[data-text-field="color"]')).toHaveValue("#ff00aa");
  await expect(page.locator(".cad-scene-text")).toHaveCSS("fill", "rgb(255, 0, 170)");
  await expect(page.locator('[data-text-field="fontFamily"]')).toHaveValue("sans"); await expect(page.locator('[data-text-field="align"]')).toHaveValue("center");
  await expect(page.locator('[data-text-field="bold"]')).toBeChecked(); await expect(page.locator('[data-text-field="italic"]')).toBeChecked(); await expect(page.locator('[data-text-field="underline"]')).toBeChecked();
});

test("offers selection-aware drafting actions from the context menu", async ({ page }) => {
  await page.goto("/"); await clickMoreTool(page, "Add scene text");
  await page.locator('[data-text-field="rotation"]').fill("30"); await page.locator('[data-text-field="rotation"]').blur();
  await page.locator(".cad-text-hit").click({ button: "right" });
  const menu = page.locator("#cad-context-menu");
  await expect(menu).toBeVisible();
  for (const name of ["Focus selection", "Duplicate", "Lock", "Bring to front", "Send to back", "Reset rotation", "Delete"]) await expect(menu.getByRole("button", { name })).toBeVisible();
  await menu.getByRole("button", { name: "Duplicate" }).click(); await expect(page.locator(".cad-scene-text")).toHaveCount(2);
  await page.locator(".cad-text-hit").last().click({ button: "right" }); await menu.getByRole("button", { name: "Reset rotation" }).click();
  await expect(page.locator('[data-text-field="rotation"]')).toHaveValue("0");
  await page.locator(".cad-text-hit").last().click({ button: "right" }); await menu.getByRole("button", { name: "Send to back" }).click();
  await expect(page.locator(".cad-scene-text")).toHaveCount(2);
});

test("edits item, container, cut-out, and exclusion geometry without leaving the workspace", async ({ page }) => {
  await page.goto("/");
  const initialCircle = page.locator('[data-cad-kind="item"][data-cad-part="1"]');
  await expect(initialCircle).toBeVisible();
  const initialCircleBox = await initialCircle.boundingBox();
  if (!initialCircleBox) throw new Error("Snapped circle has no bounding box");
  await initialCircle.click({ position: { x: initialCircleBox.width * .2, y: initialCircleBox.height / 2 } });
  await expect(page.locator("#item-part-select")).toHaveValue("1");
  await openInspectorDetails(page, "geometry-precision");
  await expect(page.locator('[data-primitive-field="radius"]')).toBeVisible();
  await page.locator("#item-part-select").selectOption("0");
  await openInspectorDetails(page, "geometry-precision");
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
  await openInspectorDetails(page, "snap-offset");
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
  await openInspectorDetails(page, "geometry-precision");
  await expect(page.locator("[data-bezier-knots]")).toBeVisible();
  await expect(page.locator(".cad-bezier-tangent")).toHaveCount(4);
  await expect(page.locator(".cad-geometry-handle.control")).toHaveCount(8);
  await page.locator('[data-add-object="cutout"]').click();
  await expect(page.locator("#selection-inspector")).toContainText("Subtract cut-out");
  await page.locator('[data-add-object="exclusion"]').click();
  await expect(page.locator("#selection-inspector")).toContainText("Exclusion");
  await page.locator('[data-add-object="item"]').click();
  await expect(page.locator("#selection-inspector")).toContainText("Selected item");
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(2);
  await expect(page.locator('[data-cad-kind="exclusion"]')).toHaveCount(2);
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(2);

  const previews = page.locator("[data-entity-preview]");
  await expect(previews).toHaveCount(6);
  const itemPreview = await canvasData(page, '[data-entity-preview="item:0"]');
  const exclusionPreview = await canvasData(page, '[data-entity-preview="exclusion:0"]');
  expect(itemPreview).not.toBe(exclusionPreview);
});

test("keeps the drafting camera stable and gives bezier bounds predictable resize semantics", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-cad-select="item:0"]').click();
  await page.getByRole("button", { name: "Focus selection" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const canvas = page.locator("#cad-canvas");
  const camera = await canvas.getAttribute("viewBox");

  await page.locator('[data-add-part="bezier"]').click();
  await expect(canvas).toHaveAttribute("viewBox", camera!);
  await expect(page.locator('.cad-geometry-handle.bounds')).toHaveCount(8);

  const left = page.locator('[data-geometry-handle="bounds:left"]');
  const right = page.locator('[data-geometry-handle="bounds:right"]');
  const leftBefore = Number(await left.getAttribute("cx"));
  const rightBefore = Number(await right.getAttribute("cx"));
  const rightBox = await right.boundingBox();
  if (!rightBox) throw new Error("Bezier right bound handle unavailable");
  expect(await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as SVGElement | null)?.dataset.geometryHandle, { x: rightBox.x + rightBox.width / 2, y: rightBox.y + rightBox.height / 2 })).toBe("bounds:right");
  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2);
  await page.mouse.down(); await page.mouse.move(rightBox.x + rightBox.width / 2 + 80, rightBox.y + rightBox.height / 2, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await right.getAttribute("cx"))).not.toBeCloseTo(rightBefore, 4);
  const rightAfter = Number(await right.getAttribute("cx")), leftAfter = Number(await left.getAttribute("cx"));
  expect(Math.abs(leftAfter - leftBefore)).toBeLessThan(Math.abs(rightAfter - rightBefore) * .25);

  const rightBeforeSymmetric = Number(await right.getAttribute("cx"));
  const resizedLeftBox = await left.boundingBox();
  if (!resizedLeftBox) throw new Error("Resized Bezier left bound handle unavailable");
  await page.keyboard.down("Shift");
  await page.mouse.move(resizedLeftBox.x + resizedLeftBox.width / 2, resizedLeftBox.y + resizedLeftBox.height / 2);
  await page.mouse.down(); await page.mouse.move(resizedLeftBox.x + resizedLeftBox.width / 2 - 70, resizedLeftBox.y + resizedLeftBox.height / 2, { steps: 4 }); await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(Number(await right.getAttribute("cx"))).not.toBeCloseTo(rightBeforeSymmetric, 4);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(canvas).toHaveAttribute("viewBox", camera!);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(canvas).toHaveAttribute("viewBox", camera!);
});

test("shows a grid-snapped cursor before the first point-to-point dimension click", async ({ page }) => {
  await page.goto("/");
  await clickMoreTool(page, "Create dimension");
  const canvas = page.locator("#cad-canvas"), box = await canvas.boundingBox();
  if (!box) throw new Error("CAD canvas unavailable");
  await page.mouse.move(box.x + box.width * .617, box.y + box.height * .413);
  const cursor = page.locator(".cad-dimension-cursor");
  await expect(cursor).toBeVisible();
  const x = Number(await cursor.locator("circle").getAttribute("cx"));
  const y = -Number(await cursor.locator("circle").getAttribute("cy"));
  expect(x / .5).toBeCloseTo(Math.round(x / .5), 6);
  expect(y / .5).toBeCloseTo(Math.round(y / .5), 6);
});

test("copies constituent shapes into their construction and removes empty owners", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-cad-kind="item"][data-cad-index="0"][data-cad-part="1"]').click();
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator('[data-cad-kind="item"][data-cad-index="0"]')).toHaveCount(4);
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(1);
  await expect(page.locator("#status")).toContainText("constituent shape");

  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("openlayout.workspace");
      request.onsuccess = () => resolve(); request.onerror = () => resolve(); request.onblocked = () => resolve();
    });
  }); await page.reload();
  await page.locator('[data-cad-kind="item"][data-cad-index="0"][data-cad-part="0"]').click();
  await page.locator('[data-cad-kind="item"][data-cad-index="0"][data-cad-part="1"]').click({ modifiers: ["ControlOrMeta"], force: true });
  await page.locator('[data-cad-kind="item"][data-cad-index="0"][data-cad-part="2"]').click({ modifiers: ["ControlOrMeta"], force: true });
  await page.keyboard.press("ControlOrMeta+c"); await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(2);
  await expect(page.locator("#status")).toContainText("new item");

  await page.locator('[data-add-object="item"]').click();
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-cad-select^="item:"]')).toHaveCount(2);
  await expect(page.locator("#selection-inspector")).toContainText("Nothing selected");
});

test("provides persistent drafting guides, trace images, default roles, and bezier mirroring", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#packing-sidebar")).not.toContainText("Drafting aids");
  await clickMoreTool(page, "Drafting aids");
  await expect(page.getByLabel("Drafting aids panel")).toBeVisible();
  await page.getByRole("button", { name: "+ Vertical" }).click();
  await page.locator("#cad-canvas").hover({ position: { x: 610, y: 390 } });
  await expect(page.locator(".cad-guide-placement-preview")).toBeVisible();
  await page.locator("#cad-canvas").click({ position: { x: 610, y: 390 } });
  await expect(page.locator('[data-cad-kind="guide"]')).toHaveCount(1);
  await clickMoreTool(page, "Drafting aids");
  await page.locator('[data-guide-field="x"]').fill("1.24"); await page.locator('[data-guide-field="x"]').blur();
  await expect(page.locator('[data-guide-field="x"]')).toHaveValue("1");

  const imageChooser = page.waitForEvent("filechooser");
  await clickMoreTool(page, "Add trace image");
  await (await imageChooser).setFiles({
    name: "trace.svg", mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>'),
  });
  await expect(page.locator(".cad-trace-image")).toHaveCount(1);
  await expect(page.locator('[data-trace-field="opacity"]')).toHaveValue("0.35");

  await page.locator("[data-cad-background]").click({ position: { x: 20, y: 200 } });
  await page.locator("#add-exclusion").hover();
  await page.locator("#add-exclusion-menu").getByRole("menuitemradio", { name: /Circle/ }).click();
  await expect(page.locator('[data-cad-select^="exclusion:"]')).toHaveCount(2);
  await expect(page.locator('[data-cad-kind="exclusion"][data-cad-index="1"]')).toHaveCount(1);

  await page.locator('[data-cad-kind="item"][data-cad-part="0"]').click();
  await page.locator('[data-add-part="bezier"]').click();
  await openInspectorDetails(page, "geometry-precision");
  const knots = page.locator("[data-bezier-knots]");
  const before = JSON.parse(await knots.inputValue());
  await page.getByRole("button", { name: "Mirror left ↔ right" }).click();
  const after = JSON.parse(await knots.inputValue());
  expect(after[0].point.x).toBeCloseTo(-before.at(-1).point.x);
  expect(after[1].point.x).toBe(-before.at(-2).point.x);

  await page.getByRole("button", { name: "Dimensions" }).click();
  await expect(page.locator('[data-dimension-owner^="exclusion:"] [data-dimension-axis="width"] text')).toHaveCount(2);
  expect((await page.locator('[data-dimension-owner^="exclusion:"] [data-dimension-axis="width"] text').allTextContents()).every((text) => text.startsWith("Ø"))).toBe(true);
  await expect(page.locator('[data-dimension-owner^="exclusion:"] [data-dimension-axis="height"]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".cad-trace-image")).toHaveCount(1);
  await expect(page.locator('[data-cad-kind="guide"]')).toHaveCount(1);
  await expect(page.locator("#toolbar-default-owner")).toHaveCount(0);
});

test("smart-snaps a circle radius to a related rectangle dimension", async ({ page }) => {
  await page.goto("/");
  await clickMoreTool(page, "Drafting aids");
  const grid = page.locator('[data-drafting-field="gridStep"]');
  await grid.fill("0.3"); await grid.blur();
  await page.keyboard.press("Escape");
  await page.locator('[data-cad-kind="item"][data-cad-part="1"]').click();
  await openInspectorDetails(page, "geometry-precision");
  const radius = page.locator('[data-primitive-field="radius"]');
  await expect(radius).toHaveValue("1.1");
  const handle = page.locator('[data-geometry-handle^="radius:"]').first();
  const handleBox = await handle.boundingBox(), canvasBox = await page.locator("#cad-canvas").boundingBox();
  const viewBox = (await page.locator("#cad-canvas").getAttribute("viewBox"))!.split(" ").map(Number);
  if (!handleBox || !canvasBox) throw new Error("Circle radius grip is unavailable");
  const deltaPixels = 0.9 / viewBox[2] * canvasBox.width;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down(); await page.mouse.move(handleBox.x + handleBox.width / 2 + deltaPixels, handleBox.y + handleBox.height / 2); await page.mouse.up();
  await expect(radius).toHaveValue("2");
});

test("snaps polygon vertices to the unit grid while dragging", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-cad-kind="container"][data-cad-index="0"]')).toHaveClass(/selected/);
  const handle = page.locator('[data-geometry-handle="vertex:0"]');
  const handleBox = await handle.boundingBox(), canvasBox = await page.locator("#cad-canvas").boundingBox();
  const viewBox = (await page.locator("#cad-canvas").getAttribute("viewBox"))!.split(" ").map(Number);
  if (!handleBox || !canvasBox) throw new Error("Polygon vertex grip is unavailable");
  const dx = .37 / viewBox[2] * canvasBox.width, dy = .34 / viewBox[3] * canvasBox.height;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down(); await page.mouse.move(handleBox.x + handleBox.width / 2 + dx, handleBox.y + handleBox.height / 2 - dy); await page.mouse.up();
  const first = (await page.locator("[data-primitive-points]").inputValue()).split("\n")[0].split(",").map(Number);
  expect(Math.abs(first[0] * 2 - Math.round(first[0] * 2))).toBeLessThan(.001);
  expect(Math.abs(first[1] * 2 - Math.round(first[1] * 2))).toBeLessThan(.001);
});

test("shows grid snapping live while moving a shape", async ({ page }) => {
  await page.goto("/");
  const handle = page.locator(".cad-part-move-handle"), handleBox = await handle.boundingBox();
  const canvas = page.locator("#cad-canvas"), canvasBox = await canvas.boundingBox();
  const viewBox = (await canvas.getAttribute("viewBox"))!.split(" ").map(Number);
  if (!handleBox || !canvasBox) throw new Error("Shape move grip is unavailable");
  const dx = .37 / viewBox[2] * canvasBox.width, dy = .34 / viewBox[3] * canvasBox.height;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + dx, handleBox.y + handleBox.height / 2 - dy);
  const liveX = Number(await handle.getAttribute("cx")), liveY = -Number(await handle.getAttribute("cy"));
  expect(liveX / .5).toBeCloseTo(Math.round(liveX / .5), 6);
  expect(liveY / .5).toBeCloseTo(Math.round(liveY / .5), 6);
  await page.mouse.up();
});

test("uses two-point drafting line anchors for dimensions and shape edits", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator("#cad-canvas"), box = await canvas.boundingBox();
  if (!box) throw new Error("CAD canvas unavailable");

  await clickMoreTool(page, "Draw two-point drafting line");
  await page.mouse.click(box.x + box.width * .84, box.y + box.height * .3);
  await page.mouse.click(box.x + box.width * .96, box.y + box.height * .44);
  const line = page.locator(".cad-drafting-shape").first();
  await expect(line).toHaveCount(1);
  const anchors = await line.evaluate((path: SVGPathElement) => {
    const start = path.getPointAtLength(0), midpoint = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM();
    if (!matrix) throw new Error("Drafting line has no screen transform");
    const screen = (point: DOMPoint) => {
      const transformed = point.matrixTransform(matrix);
      return { x: transformed.x, y: transformed.y };
    };
    return {
      start: { x: start.x, y: -start.y, screen: screen(start) },
      midpoint: { x: midpoint.x, y: -midpoint.y, screen: screen(midpoint) },
    };
  });

  await clickMoreTool(page, "Drafting aids");
  await page.locator('[data-drafting-field="snapToGrid"]').uncheck();
  await page.getByRole("button", { name: "Close drafting aids" }).click();

  await clickMoreTool(page, "Create dimension");
  await page.mouse.click(anchors.start.screen.x + 7, anchors.start.screen.y + 4);
  await page.mouse.click(anchors.midpoint.screen.x - 6, anchors.midpoint.screen.y + 5);
  const extensions = page.locator('[data-dimension-owner^="custom:"] .cad-dimension-extension');
  await expect(extensions).toHaveCount(2);
  expect(Number(await extensions.nth(0).getAttribute("x1"))).toBeCloseTo(anchors.start.x, 5);
  expect(-Number(await extensions.nth(0).getAttribute("y1"))).toBeCloseTo(anchors.start.y, 5);
  expect(Number(await extensions.nth(1).getAttribute("x1"))).toBeCloseTo(anchors.midpoint.x, 5);
  expect(-Number(await extensions.nth(1).getAttribute("y1"))).toBeCloseTo(anchors.midpoint.y, 5);

  await page.locator('[data-cad-select="container:0"]').click();
  const vertex = page.locator('[data-geometry-handle="vertex:0"]'), vertexBox = await vertex.boundingBox();
  if (!vertexBox) throw new Error("Polygon vertex grip is unavailable");
  await page.mouse.move(vertexBox.x + vertexBox.width / 2, vertexBox.y + vertexBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchors.start.screen.x + 6, anchors.start.screen.y - 5, { steps: 4 });
  await page.mouse.up();
  expect(Number(await vertex.getAttribute("cx"))).toBeCloseTo(anchors.start.x, 5);
  expect(-Number(await vertex.getAttribute("cy"))).toBeCloseTo(anchors.start.y, 5);

  await page.locator('[data-cad-select="item:0"]').click();
  await page.locator("#item-part-select").selectOption("1");
  const circleCenter = page.locator(".cad-part-move-handle"), circleCenterBox = await circleCenter.boundingBox();
  if (!circleCenterBox) throw new Error("Circle centre grip is unavailable");
  await page.mouse.move(circleCenterBox.x + circleCenterBox.width / 2, circleCenterBox.y + circleCenterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchors.start.screen.x + 5, anchors.start.screen.y + 5, { steps: 4 });
  await page.mouse.up();
  expect(Number(await circleCenter.getAttribute("cx"))).toBeCloseTo(anchors.start.x, 5);
  expect(-Number(await circleCenter.getAttribute("cy"))).toBeCloseTo(anchors.start.y, 5);

  await page.locator("#item-part-select").selectOption("0");
  const rectangleCorner = page.locator('[data-geometry-handle="resize:bottom_right"]'), rectangleCornerBox = await rectangleCorner.boundingBox();
  const rectangleCenter = page.locator(".cad-part-move-handle"), rectangleCenterBox = await rectangleCenter.boundingBox();
  if (!rectangleCornerBox || !rectangleCenterBox) throw new Error("Rectangle move anchors are unavailable");
  const liveMidpointScreen = await line.evaluate((path: SVGPathElement) => {
    const midpoint = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM();
    if (!matrix) throw new Error("Drafting line has no screen transform");
    const transformed = midpoint.matrixTransform(matrix);
    return { x: transformed.x, y: transformed.y };
  });
  const cornerScreen = { x: rectangleCornerBox.x + rectangleCornerBox.width / 2, y: rectangleCornerBox.y + rectangleCornerBox.height / 2 };
  const centerScreen = { x: rectangleCenterBox.x + rectangleCenterBox.width / 2, y: rectangleCenterBox.y + rectangleCenterBox.height / 2 };
  await page.mouse.move(centerScreen.x, centerScreen.y);
  await page.mouse.down();
  await page.mouse.move(centerScreen.x + liveMidpointScreen.x - cornerScreen.x - 5, centerScreen.y + liveMidpointScreen.y - cornerScreen.y + 5, { steps: 4 });
  await page.mouse.up();
  expect(Number(await rectangleCorner.getAttribute("cx"))).toBeCloseTo(anchors.midpoint.x, 5);
  expect(-Number(await rectangleCorner.getAttribute("cy"))).toBeCloseTo(anchors.midpoint.y, 5);
});

test("creates and directly transforms guides, drafting paths, construction shapes, and multiple images", async ({ page }) => {
  await page.goto("/");
  await clickMoreTool(page, "Add vertical drafting line");
  await expect(page.locator("#cad-canvas")).toHaveClass(/placing-guide/);
  const initialCanvasBox = await page.locator("#cad-canvas").boundingBox();
  if (!initialCanvasBox) throw new Error("CAD canvas is unavailable");
  await page.mouse.move(initialCanvasBox.x + 520, initialCanvasBox.y + 240);
  await expect(page.locator(".cad-guide-placement-preview")).toBeVisible();
  await page.mouse.click(initialCanvasBox.x + 520, initialCanvasBox.y + 240);
  const guide = page.locator('[data-cad-kind="guide"]').first();
  await expect(guide).toHaveCount(1);
  await expect(page.locator("#selection-inspector")).toContainText("DRAFTING GUIDE");
  const guideBefore = await guide.getAttribute("x1");
  const guideBox = await guide.boundingBox();
  if (!guideBox) throw new Error("Drafting guide has no bounds");
  const guideGrabY = initialCanvasBox.y + initialCanvasBox.height / 2;
  await page.mouse.move(guideBox.x + guideBox.width / 2, guideGrabY); await page.mouse.down();
  await page.mouse.move(guideBox.x + guideBox.width / 2 + 30, guideGrabY + 30); await page.mouse.up();
  await expect.poll(() => guide.getAttribute("x1")).not.toBe(guideBefore);
  const rotate = page.locator(".cad-rotate-handle");
  await expect(rotate).toBeVisible();
  const rotateBox = await rotate.boundingBox();
  if (!rotateBox) throw new Error("Guide rotation handle is unavailable");
  const rotatedBefore = await guide.getAttribute("y1");
  await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2); await page.mouse.down();
  await page.mouse.move(rotateBox.x + 45, rotateBox.y + 20); await page.mouse.up();
  await expect.poll(() => guide.getAttribute("y1")).not.toBe(rotatedBefore);

  const canvas = page.locator("#cad-canvas"), canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("CAD canvas is unavailable");
  await clickMoreTool(page, "Draw two-point drafting line");
  await expect(canvas).toHaveClass(/placing-draft/);
  await page.mouse.move(canvasBox.x + 240, canvasBox.y + 250);
  await expect(page.locator(".cad-draft-cursor")).toBeVisible();
  await page.mouse.click(canvasBox.x + 240, canvasBox.y + 250); await page.mouse.move(canvasBox.x + 330, canvasBox.y + 300);
  await expect(page.locator(".cad-draft-preview")).toBeVisible();
  await page.mouse.click(canvasBox.x + 330, canvasBox.y + 300);
  await expect(page.locator(".cad-drafting-shape")).toHaveCount(1);
  await expect(page.locator(".cad-drafting-hit")).toHaveCount(1);
  await expect(page.locator(".cad-drafting-point-handle")).toHaveCount(2);
  const draftingLine = page.locator(".cad-drafting-shape").first(), lineBefore = await draftingLine.getAttribute("d");
  const forgivingTarget = await page.locator(".cad-drafting-hit").evaluate((path: SVGPathElement) => {
    const length = path.getTotalLength(), middle = path.getPointAtLength(length / 2), ahead = path.getPointAtLength(Math.min(length, length / 2 + .01));
    const matrix = path.getScreenCTM(); if (!matrix) throw new Error("Drafting line has no screen transform");
    const screen = new DOMPoint(middle.x, middle.y).matrixTransform(matrix), next = new DOMPoint(ahead.x, ahead.y).matrixTransform(matrix);
    const dx = next.x - screen.x, dy = next.y - screen.y, magnitude = Math.hypot(dx, dy) || 1;
    return { x: screen.x - dy / magnitude * 5, y: screen.y + dx / magnitude * 5 };
  });
  await page.locator("[data-cad-background]").click({ position: { x: 20, y: 120 } });
  await expect(page.locator(".cad-drafting-point-handle")).toHaveCount(0);
  await page.mouse.click(forgivingTarget.x, forgivingTarget.y);
  await expect(page.locator(".cad-drafting-point-handle")).toHaveCount(2);
  const pointHandle = page.locator(".cad-drafting-point-handle").first(), pointBox = await pointHandle.boundingBox();
  if (!pointBox) throw new Error("Drafting point handle is unavailable");
  await page.mouse.move(pointBox.x + pointBox.width / 2, pointBox.y + pointBox.height / 2); await page.mouse.down();
  await page.mouse.move(pointBox.x + pointBox.width / 2 + 17, pointBox.y + pointBox.height / 2 + 11); await page.mouse.up();
  await expect.poll(() => draftingLine.getAttribute("d")).not.toBe(lineBefore);
  const movedCoordinates = (await draftingLine.getAttribute("d"))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(Math.abs(movedCoordinates[0] * 2 - Math.round(movedCoordinates[0] * 2))).toBeLessThan(.001);
  expect(Math.abs(movedCoordinates[1] * 2 - Math.round(movedCoordinates[1] * 2))).toBeLessThan(.001);
  await clickMoreTool(page, "Draw drafting polyline");
  await page.mouse.click(canvasBox.x + 380, canvasBox.y + 260); await page.mouse.click(canvasBox.x + 430, canvasBox.y + 320); await page.mouse.click(canvasBox.x + 490, canvasBox.y + 270);
  await page.keyboard.press("Enter");
  await expect(page.locator(".cad-drafting-shape")).toHaveCount(2);

  await clickMoreTool(page, "Drafting shape mode");
  await expect(page.locator(".cad-drafting-shape")).toHaveCount(3);
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(1);

  for (const color of ["red", "blue"]) {
    const chooser = page.waitForEvent("filechooser"); await clickMoreTool(page, "Add trace image");
    await (await chooser).setFiles({ name: `${color}.svg`, mimeType: "image/svg+xml", buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="${color}"/></svg>`) });
  }
  await expect(page.locator(".cad-trace-image")).toHaveCount(2);
  const traceHit = page.locator('[data-cad-kind="trace"]').last(), traceBox = await traceHit.boundingBox();
  if (!traceBox) throw new Error("Trace image has no selection border");
  const traceCenter = { x: traceBox.x + traceBox.width / 2, y: traceBox.y + traceBox.height / 2 };
  await page.mouse.click(traceCenter.x, traceCenter.y);
  await expect(page.locator("#selection-inspector")).toContainText("TRACE IMAGE");
  const transformBefore = await traceHit.getAttribute("transform");
  await page.mouse.move(traceCenter.x, traceCenter.y); await page.mouse.down(); await page.mouse.move(traceCenter.x + 30, traceCenter.y + 20); await page.mouse.up();
  await expect.poll(() => traceHit.getAttribute("transform")).not.toBe(transformBefore);
  const widthBefore = Number(await page.locator(".cad-trace-image").last().getAttribute("width"));
  const scale = page.locator(".cad-global-scale-handle"), scaleBox = await scale.boundingBox();
  if (!scaleBox) throw new Error("Trace image resize handle is unavailable");
  await page.mouse.move(scaleBox.x + scaleBox.width / 2, scaleBox.y + scaleBox.height / 2); await page.mouse.down(); await page.mouse.move(scaleBox.x + 35, scaleBox.y + 25); await page.mouse.up();
  await expect.poll(async () => Number(await page.locator(".cad-trace-image").last().getAttribute("width"))).not.toBe(widthBefore);
});

test("locks every CAD entity type and exposes locked entities only in the sidebar", async ({ page }) => {
  await page.goto("/");
  const lock = async (): Promise<void> => clickMoreTool(page, "Lock selection");

  await lock();
  await expect(page.locator(".locked-entity-group")).toBeVisible();
  await expect(page.locator('.locked-entity-group [data-cad-select="container:0"]')).toContainText("stock");
  await expect(page.locator('[data-cad-kind="container"][data-cad-index="0"]')).toHaveCount(0);
  await expect(page.locator("#lock-selection")).toHaveAttribute("aria-label", "Unlock selection");
  await page.locator("[data-toggle-lock]").click();
  await expect(page.locator(".locked-entity-group")).toHaveCount(0);
  await expect(page.locator('[data-cad-kind="container"][data-cad-index="0"]')).toHaveCount(1);

  await page.locator('[data-cad-select="exclusion:0"]').click(); await lock();
  await page.locator('[data-cad-select="item:0"]').click(); await lock();
  await expect(page.locator('[data-cad-kind="exclusion"][data-cad-index="0"]')).toHaveCount(0);
  await expect(page.locator('[data-cad-kind="item"][data-cad-index="0"]')).toHaveCount(0);

  const canvasBox = await page.locator("#cad-canvas").boundingBox();
  if (!canvasBox) throw new Error("CAD canvas is unavailable");
  await clickMoreTool(page, "Draw two-point drafting line");
  await page.mouse.click(canvasBox.x + 700, canvasBox.y + 250); await page.mouse.click(canvasBox.x + 790, canvasBox.y + 310);
  await lock();
  await expect(page.locator(".cad-drafting-shape.locked")).toHaveCount(1);
  await expect(page.locator('[data-cad-kind="drafting"]')).toHaveCount(0);

  await clickMoreTool(page, "Add vertical drafting line");
  await page.mouse.click(canvasBox.x + 820, canvasBox.y + 260); await lock();
  await expect(page.locator('[data-cad-kind="guide"]')).toHaveCount(0);

  const chooser = page.waitForEvent("filechooser"); await clickMoreTool(page, "Add trace image");
  await (await chooser).setFiles({ name: "locked.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="purple"/></svg>') });
  await lock();
  await expect(page.locator(".cad-trace-image")).toHaveCount(1);
  await expect(page.locator('[data-cad-kind="trace"]')).toHaveCount(0);
  await expect(page.locator(".locked-entity-group .locked-row")).toHaveCount(5);
  await page.locator('[data-toggle-trace-visibility="0"]').click();
  await expect(page.locator(".cad-trace-image")).toHaveCount(0);
  await expect(page.locator(".locked-entity-group .locked-row")).toHaveCount(5);

  await page.reload();
  await expect(page.locator(".locked-entity-group .locked-row")).toHaveCount(5);
  await expect(page.locator(".cad-trace-image")).toHaveCount(0);
  await page.locator('[data-toggle-trace-visibility="0"]').click();
  await expect(page.locator(".cad-trace-image")).toHaveCount(1);
  await expect(page.locator('[data-cad-kind="trace"], [data-cad-kind="drafting"], [data-cad-kind="guide"], [data-cad-kind="item"][data-cad-index="0"], [data-cad-kind="exclusion"][data-cad-index="0"]')).toHaveCount(0);
});

test("unlocks a locked trace image directly from the locked entity row", async ({ page }) => {
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser"); await clickMoreTool(page, "Add trace image");
  await (await chooser).setFiles({ name: "trace.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="purple"/></svg>') });
  await clickMoreTool(page, "Lock selection");
  await expect(page.locator('[data-cad-kind="trace"]')).toHaveCount(0);
  await page.locator(".locked-row .locked-action").click();
  await expect(page.locator('[data-cad-kind="trace"]')).toHaveCount(1);
  await expect(page.locator(".locked-entity-group")).toHaveCount(0);
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
  await page.locator("#add-material").hover();
  await page.locator("#add-material-menu").getByRole("menuitemradio", { name: /Circle/ }).click();
  await page.mouse.move(700, 500);
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(2);
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);
  await expect(page.locator(".cad-edit-dimensions")).toHaveCount(0);

  await clickMoreTool(page, "Unify selected material");
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

  await page.keyboard.press("v");
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
  await page.getByRole("button", { name: "Delete selection" }).click();
  await expect(page.locator('[data-cad-kind="container"]')).toHaveCount(1);
});

test("runs packing and lets a user move and rotate returned items", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator(".toolbar-more > summary").click();
  const snapToggle = page.locator("#toggle-grid-snap");
  await expect(snapToggle).toHaveAttribute("aria-pressed", "true");
  await expect(snapToggle).toContainText("⌗");
  await snapToggle.click();
  await expect(snapToggle).toHaveAttribute("aria-pressed", "false");
  await clickMoreTool(page, "Drafting aids");
  await expect(page.getByLabel("Snap to grid")).not.toBeChecked();
  await page.locator(".toolbar-more > summary").click();
  await snapToggle.click();
  await expect(snapToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Snap to grid")).toBeChecked();
  await configureFastSolve(page);
  await page.keyboard.press("v");
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.locator("#workspace-summary")).toContainText("packed items", { timeout: 30_000 });
  await expect(page.locator("#cad-shell")).toHaveAttribute("data-mode", "results");
  await expect(page.locator(".results-summary")).toContainText(/\d+ of \d+ packed/);
  await expect(page.locator(".result-metrics")).toContainText("Material used");
  await expect(page.getByRole("button", { name: "Return to edit" })).toBeVisible();
  await expect(page.locator(".cad-library .cad-item-sample")).toHaveCount(0);
  await expect(page.locator('[data-cad-kind="placement"]')).not.toHaveCount(0);

  const firstPlacement = page.locator('[data-cad-kind="placement"][data-cad-index="0"]').first();
  const originalPath = await firstPlacement.getAttribute("d");
  await firstPlacement.click();
  await expect(page.locator("#selection-inspector")).toContainText("Packed item 1");
  await openInspectorDetails(page, "placement-precision");
  const x = page.locator('[data-placement-field="x"]');
  await clickMoreTool(page, "Toggle manual collision guard");
  const canvasBox = await page.locator("#cad-canvas").boundingBox();
  const viewBox = (await page.locator("#cad-canvas").getAttribute("viewBox"))!.split(" ").map(Number);
  let dragBox = await firstPlacement.boundingBox();
  if (!canvasBox || !dragBox) throw new Error("Placement drag bounds are unavailable");
  const fractionalDrag = .17 / viewBox[2] * canvasBox.width;
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down(); await page.mouse.move(dragBox.x + dragBox.width / 2 + fractionalDrag, dragBox.y + dragBox.height / 2); await page.mouse.up();
  const snappedX = Number(await x.inputValue());
  expect(snappedX / .5).toBeCloseTo(Math.round(snappedX / .5), 6);

  dragBox = await firstPlacement.boundingBox();
  if (!dragBox) throw new Error("Moved placement has no drag bounds");
  await page.keyboard.down("Alt");
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down(); await page.mouse.move(dragBox.x + dragBox.width / 2 + fractionalDrag, dragBox.y + dragBox.height / 2); await page.mouse.up();
  await page.keyboard.up("Alt");
  const unsnappedX = Number(await x.inputValue());
  expect(Math.abs(unsnappedX / .5 - Math.round(unsnappedX / .5))).toBeGreaterThan(.05);

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

  await clickMoreTool(page, "Diagnostics");
  await expect(page.locator("#diagnostics-dialog")).toBeVisible();
  await expect(page.locator("#diagnostics")).toContainText("manually edited");
  await expect(page.locator("#diagnostics")).toContainText("independently valid");
  await expect(page.locator("#diagnostics")).toContainText("Worker startup");
  await expect(page.locator("#diagnostics")).toContainText("Progress transport");
  await expect(page.locator("#diagnostics")).toContainText("Wasm memory");
});

test("undoes and redoes solved placement moves as atomic result edits", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await configureFastSolve(page);
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.getByRole("button", { name: "Repack" })).toBeEnabled({ timeout: 30_000 });
  const placement = page.locator('[data-cad-kind="placement"][data-cad-index="0"]');
  await placement.click();
  await clickMoreTool(page, "Toggle manual collision guard");
  const original = await placement.getAttribute("d");
  const box = await placement.boundingBox();
  if (!box) throw new Error("Packed item has no drag bounds");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 8); await page.mouse.up();
  const moved = await placement.getAttribute("d");
  expect(moved).not.toBe(original);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => placement.getAttribute("d")).toBe(original);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect.poll(() => placement.getAttribute("d")).toBe(moved);
  await expect(page.locator("#workspace-summary")).toContainText("manual layout");
});

test("keeps sensitivity as the only separate analysis view", async ({ page }) => {
  await page.goto("/");
  await configureFastSolve(page);
  await clickMoreTool(page, "Sensitivity");
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
  await clickMoreTool(page, "Sensitivity");
  await page.getByRole("button", { name: "Workspace" }).click();
  await expect(page.locator("#cad-canvas")).toBeVisible();
});

test("makes sensitivity variables, exports, and shortcuts discoverable", async ({ page }) => {
  await page.goto("/");
  for (const [selector, shortcut] of [
    ["#sidebar-toggle", "(P)"], ["#delete-selection", "(Delete)"], ["#toggle-dimensions", "(D)"], ["#toggle-clearance", "(G)"],
    ["#undo", "(Ctrl/⌘+Z)"], ["#redo", "(Ctrl/⌘+Shift+Z)"], ["#open-sensitivity", "(2)"], ["#open-export", "(E)"],
    ["#open-shortcuts", "(?)"], ["#fit-view", "(F)"], ["#focus-selection", "(Shift+F)"], ["#zoom-in", "(+)"], ["#zoom-out", "(−)"],
    ["#validate", "(V)"], ["#solve", "(R)"],
  ] as const) await expect(page.locator(selector)).toHaveAttribute("title", new RegExp(`${shortcut.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await clickMoreTool(page, "Keyboard shortcuts");
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
  await expect(page.getByRole("button", { name: "Spacing", exact: true })).toHaveAttribute("aria-pressed", "true");

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
  await page.keyboard.press("v");
  await expect(page.locator("#status")).toContainText("valid", { timeout: 10_000 });
});

test("uses unified silhouettes and removes owners when their last shape is deleted", async ({ page }) => {
  await page.goto("/");
  const itemSilhouette = page.locator('[data-unified-geometry="item:0"]');
  await expect(itemSilhouette).toHaveCount(1);
  expect(((await itemSilhouette.getAttribute("d"))?.match(/M/g) ?? []).length).toBe(1);
  await expect(page.locator('[data-cad-kind="item"]')).toHaveCount(3);

  await page.getByRole("button", { name: "Spacing", exact: true }).click();
  await expect(page.locator(".cad-library .cad-clearance.item")).not.toHaveCount(0);

  await page.locator('[data-cad-select="exclusion:0"]').click();
  await page.locator('[data-add-part="circle"]').click();
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
  await expect(page.locator("#selection-inspector")).toContainText("Nothing selected");
  await expect(page.locator('[data-cad-kind="exclusion"]')).toHaveCount(0);
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
  await openInspectorDetails(page, "snap-offset");
  await expect(page.locator('[data-snap-offset="x"]')).toHaveValue("0");
  await expect(page.locator(".cad-snap-anchor")).toHaveCount(0);
  await expect(page.locator(".cad-snap-constraint")).toHaveCount(0);

  await page.locator('[data-cad-select="container:0"]').click();
  await page.locator("#add-material").hover();
  await page.locator("#add-material-menu").getByRole("menuitemradio", { name: /Rectangle/ }).click();
  await page.mouse.move(700, 500);
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
  await expect(page.locator("#selection-inspector")).toContainText("Selected item");
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
  await openInspectorDetails(page, "geometry-precision");
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
  await page.getByRole("button", { name: "Spacing", exact: true }).click();
  const clearanceStroke = await page.locator(".cad-clearance").first().evaluate((node) => getComputedStyle(node).stroke);
  await expect(page.locator(".cad-clearance").first()).toHaveAttribute("d", /Q/);
  await expect(page.locator(".cad-clearance").first()).toHaveCSS("stroke-linejoin", "round");
  await page.locator(".toolbar-more > summary").click();
  const fixedAccent = await page.locator("#respect-manual-constraints").evaluate((node) => getComputedStyle(node).color);
  expect(clearanceStroke).not.toBe(fixedAccent);
});

test("retains solved layouts for stale edits and copies solved placements", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run packing" }).click();
  await expect(page.getByRole("button", { name: "Repack" })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator(".cad-placement").first()).toBeVisible();
  const before = await page.locator(".cad-placement").count();
  await page.locator(".cad-placement").first().click();
  await page.keyboard.press("Control+c"); await page.keyboard.press("Control+v");
  await expect(page.locator(".cad-placement")).toHaveCount(before + 1);
  await page.getByRole("button", { name: "Return to edit" }).click();
  await page.locator('[data-cad-select="item:0"]').click();
  await page.locator('[data-object-field="quantity"]').fill("81"); await page.locator('[data-object-field="quantity"]').blur();
  await expect(page.locator(".cad-placement")).toHaveCount(before + 1);
  await expect(page.locator("#workspace-summary")).toContainText("stale");
});

test("creates an empty project and previews fixed placements", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Locked items", { exact: false }).last().click();
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
  await page.getByText("Locked items", { exact: false }).last().click();
  await page.getByRole("button", { name: "+ Add fixed placement" }).click();
  await expect(page.locator(".cad-placement.fixed")).toHaveCount(1);
  await expect(page.locator(".cad-fixed-badge")).toHaveCount(1);
});

async function configureFastSolve(page: import("@playwright/test").Page): Promise<void> {
  await openSolverSettings(page);
  await setPackingNumber(page, "max_iterations", "2000");
  await setPackingNumber(page, "grid_step", "1");
  await setPackingNumber(page, "restarts", "1");
  await page.getByLabel("Packing strategy").selectOption("fast");
}

async function openSolverSettings(page: import("@playwright/test").Page): Promise<void> {
  const details = page.locator("details.settings-section").filter({ hasText: "Packing settings" });
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
  const advanced = details.locator(".advanced-settings");
  if (!(await advanced.evaluate((node) => (node as HTMLDetailsElement).open))) await advanced.locator(":scope > summary").click();
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
