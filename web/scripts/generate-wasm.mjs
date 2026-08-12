import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const result = spawnSync(
  "wasm-pack",
  ["build", "../crates/packing-wasm", "--target", "web", "--out-dir", "../../web/src/wasm"],
  { stdio: "inherit" },
);

// The generated bindings are checked in directly rather than published as an npm package, so
// remove wasm-pack's output-directory metadata after generation.
rmSync("src/wasm/.gitignore", { force: true });
rmSync("src/wasm/package.json", { force: true });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
