import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const result = spawnSync(
  "wasm-pack",
  ["build", "../crates/packing-wasm", "--target", "web", "--out-dir", "../../web/src/wasm"],
  { stdio: "inherit" },
);

// wasm-pack writes a wildcard .gitignore into every output directory. The generated bindings are
// checked in for deployment, so remove only that tool-owned file after generation.
rmSync("src/wasm/.gitignore", { force: true });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
