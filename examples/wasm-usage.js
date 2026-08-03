import init, { solve_problem, run_sensitivity } from "../pkg/packing_wasm.js";

await init();

const problem = await fetch("./sensitivity-problem.json").then(response => response.text());
const study = await fetch("./sensitivity-study.json").then(response => response.text());

const result = JSON.parse(solve_problem(problem, JSON.stringify({
  seed: 7,
  deterministic: true,
  max_iterations: 30000,
  grid_step: 0.25,
  restarts: 2
})));
console.log(result.placements);

const sensitivity = JSON.parse(run_sensitivity(problem, study));
console.log(sensitivity.transitions);
