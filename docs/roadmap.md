# Roadmap

Work is ordered by evidence needed for the intended private interactive application. None of these stages promises a stable public API, package, migration system, or extension framework.

## Current engine milestone

The engine now has reusable prepared rotations and bounds, a measured greedy baseline, learned-layout and post-compaction contact closure, explicit contact candidates, staged broad/exact collision work, bounded beam states, conservative deduplication and pruning, remove/repack and guided overlap-minimizing repair, target feasibility, adjacent sensitivity warm starts, transition-focused stronger search, and optional finite conflict-graph refinement. Native and Wasm adapters call the same core, and every accepted layout is independently validated. [Performance notes](performance.md) record where the current modes spend time.

## Worker integration

- A deterministic two-to-four-worker pool now separates direct and clearance-continuation lanes,
  runs bounded alternate seeds, tolerates individual lane failure, reports real browser phase time,
  and terminates every worker on cancellation.
- Make progress events cover preparation and every long graph-building phase consistently.
- Check cooperative cancellation inside all candidate generation and graph edge loops, in addition to worker termination.
- Report incremental best layouts without repeatedly cloning more geometry than the UI needs.
- Settle stable-enough internal frontend input/output fields from actual studio use, without compatibility machinery.

## Repeated-work caching

- Clearance continuation now clones one canonical prepared problem, repairs each adjacent stage
  first, and invokes a small targeted beam before a reduced full fallback.
- Add bounded layout caching keyed by problem, mode, options, and seed.
- Cache sensitivity points and repaired layouts across interrupted studies.
- Reuse safe contact frontiers or pair-conflict calculations only after profiles show a net memory win.
- Define browser memory ceilings and eviction behavior for prepared geometry and candidate graphs.

## Transition reliability

- Exercise warm starts on changes that invalidate only part of a layout and record repair effectiveness.
- Refine transitions with feasibility targets before launching full optimization.
- Preserve and explain unresolved or non-monotonic points when bounded searches disagree.
- Add diagnostics identifying the active upper bound, exhausted search budget, and high-quality failed contacts when a count cannot be improved.

## Geometry and performance robustness

- Use the measured hypotheses and cross-shape acceptance matrix in the
  [solver optimization audit](solver-optimization-audit.md); do not tune against one showcase.

- Set representative latency, state-count, exact-check, and memory budgets for fast, balanced, and thorough modes.
- Reduce thorough-mode candidate regeneration, currently its clearest measured bottleneck.
- Strengthen predicates or adopt a more robust offset/Minkowski facility only for reproduced failures.
- Reconsider cached no-fit polygons only if difficult repeated shapes justify their complexity and clearance conventions can be proven.
- Keep deterministic native/Wasm fixtures and independent validation at the acceptance boundary.

## Application-facing results

- Export transformed generic geometry and diagnostics suitable for visualization.
- Explain bounded, timed-out, finite-candidate optimal, and unrestricted proven results distinctly.
- Add generic operational constraints only when the application supplies a real case; keep application terminology outside the engine.

Server execution, databases, authentication, public APIs, versioning, plugins, package publishing, cloud infrastructure, browser shared-memory threading, machine learning, genetic algorithms, and unrestricted continuous-optimum proofs remain non-goals.
