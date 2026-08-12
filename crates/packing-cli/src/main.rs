use packing_core::{
    PackingProblem, SensitivityStudy, SolveOptions, prepare_problem, run_sensitivity,
    solve_prepared, solve_prepared_feasibility, validate_problem,
};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::process::ExitCode;
use std::time::Instant;

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&json!({ "error": error })).unwrap()
            );
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<Value, String> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, problem_path] if command == "validate" => {
            let problem = read_problem(problem_path)?;
            validate_problem(&problem).map_err(|error| error.to_string())?;
            Ok(json!({ "valid": true }))
        }
        [command, problem_path] if command == "solve" => solve_command(problem_path, None),
        [command, problem_path, options_path] if command == "solve" => solve_command(problem_path, Some(options_path)),
        [command, problem_path, options_path, repeats] if command == "benchmark" => benchmark_command(problem_path, options_path, repeats),
        [command, source_path, strip_length] if command == "convert-jagua-strip" => {
            convert_jagua_strip_command(source_path, strip_length)
        }
        [command, source_path, strip_length, output_path] if command == "convert-jagua-strip" => {
            let converted = convert_jagua_strip_command(source_path, strip_length)?;
            fs::write(
                output_path,
                serde_json::to_string_pretty(&converted).map_err(|error| error.to_string())?,
            )
            .map_err(|error| format!("failed to write '{output_path}': {error}"))?;
            Ok(json!({ "output": output_path, "valid": true }))
        }
        [command, problem_path, target] if command == "feasible" => feasibility_command(problem_path, target, None),
        [command, problem_path, target, options_path] if command == "feasible" => feasibility_command(problem_path, target, Some(options_path)),
        [command, problem_path, study_path] if command == "sensitivity" => {
            let problem = read_problem(problem_path)?;
            let study: SensitivityStudy = read_json(study_path)?;
            serde_json::to_value(run_sensitivity(&problem, &study).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
        }
        _ => Err("usage: packing-cli validate <problem.json> | solve <problem.json> [options.json] | benchmark <problem.json> <options.json> <repeats> | convert-jagua-strip <instance.json> <strip-length> [output.json] | feasible <problem.json> <count> [options.json] | sensitivity <problem.json> <study.json>".to_string()),
    }
}

fn feasibility_command(
    problem_path: &str,
    target: &str,
    options_path: Option<&String>,
) -> Result<Value, String> {
    let problem = read_problem(problem_path)?;
    let target = target
        .parse::<usize>()
        .map_err(|_| format!("invalid target count '{target}'"))?;
    let options = options_path
        .map(|path| read_json(path))
        .transpose()?
        .unwrap_or_default();
    let prepared = prepare_problem(&problem).map_err(|error| error.to_string())?;
    serde_json::to_value(
        solve_prepared_feasibility(&prepared, &options, target)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn solve_command(problem_path: &str, options_path: Option<&String>) -> Result<Value, String> {
    let problem = read_problem(problem_path)?;
    let options = options_path
        .map(|path| read_json(path))
        .transpose()?
        .unwrap_or_else(SolveOptions::default);
    let prepared = prepare_problem(&problem).map_err(|error| error.to_string())?;
    serde_json::to_value(solve_prepared(&prepared, &options).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn benchmark_command(
    problem_path: &str,
    options_path: &str,
    repeats: &str,
) -> Result<Value, String> {
    let repeats = repeats
        .parse::<usize>()
        .map_err(|_| format!("invalid repeat count '{repeats}'"))?;
    if !(1..=100).contains(&repeats) {
        return Err("benchmark repeats must be between 1 and 100".to_string());
    }
    let problem = read_problem(problem_path)?;
    let options: SolveOptions = read_json(options_path)?;
    let prepared_started = Instant::now();
    let prepared = prepare_problem(&problem).map_err(|error| error.to_string())?;
    let preparation_wall_ms = prepared_started.elapsed().as_secs_f64() * 1_000.0;
    let mut runs = Vec::with_capacity(repeats);
    let mut wall_times = Vec::with_capacity(repeats);
    let mut layout_ids = Vec::with_capacity(repeats);
    let mut operation_signatures = Vec::with_capacity(repeats);
    for run in 0..repeats {
        let started = Instant::now();
        let result = solve_prepared(&prepared, &options).map_err(|error| error.to_string())?;
        let wall_ms = started.elapsed().as_secs_f64() * 1_000.0;
        wall_times.push(wall_ms);
        layout_ids.push(result.layout_id.clone());
        operation_signatures.push((
            result.statistics.generated_candidates,
            result.statistics.exact_geometry_checks,
            result.statistics.explored_search_states,
            result.statistics.iterations,
        ));
        runs.push(json!({
            "run": run + 1,
            "wall_ms": wall_ms,
            "solver_elapsed_ms": result.statistics.elapsed_ms,
            "layout_id": result.layout_id,
            "packed_item_count": result.packed_item_count,
            "status": result.status,
            "valid": result.validation.valid,
            "generated_candidates": result.statistics.generated_candidates,
            "exact_geometry_checks": result.statistics.exact_geometry_checks,
            "explored_search_states": result.statistics.explored_search_states,
            "iterations": result.statistics.iterations,
            "candidate_generation_ms": result.statistics.candidate_generation_ms,
            "candidate_scoring_ms": result.statistics.candidate_scoring_ms,
            "containment_check_ms": result.statistics.containment_check_ms,
            "collision_check_ms": result.statistics.collision_check_ms,
            "overlap_repair_evaluated_moves": result.statistics.overlap_repair_evaluated_moves,
            "overlap_repair_component_reinsert_attempts": result.statistics.overlap_repair_component_reinsert_attempts,
            "overlap_repair_component_reinsert_successes": result.statistics.overlap_repair_component_reinsert_successes,
        }));
    }
    wall_times.sort_by(f64::total_cmp);
    let deterministic_reproducible = !options.deterministic
        || (layout_ids.windows(2).all(|pair| pair[0] == pair[1])
            && operation_signatures
                .windows(2)
                .all(|pair| pair[0] == pair[1]));
    if !deterministic_reproducible {
        return Err(
            "deterministic benchmark produced different layouts or operation counts".into(),
        );
    }
    Ok(json!({
        "problem": problem_path,
        "options": options_path,
        "repeats": repeats,
        "preparation_wall_ms": preparation_wall_ms,
        "wall_ms": {
            "min": wall_times[0],
            "median": median(&wall_times),
            "max": wall_times[wall_times.len() - 1],
        },
        "deterministic_reproducible": deterministic_reproducible,
        "runs": runs,
    }))
}

fn median(sorted: &[f64]) -> f64 {
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

fn convert_jagua_strip_command(source_path: &str, strip_length: &str) -> Result<Value, String> {
    let source: Value = read_json(source_path)?;
    let strip_length = strip_length
        .parse::<f64>()
        .map_err(|_| format!("invalid strip length '{strip_length}'"))?;
    let converted = convert_jagua_strip(&source, strip_length)?;
    let problem: PackingProblem = serde_json::from_value(converted.clone())
        .map_err(|error| format!("converted problem is invalid: {error}"))?;
    validate_problem(&problem).map_err(|error| format!("converted problem is invalid: {error}"))?;
    Ok(converted)
}

fn convert_jagua_strip(source: &Value, strip_length: f64) -> Result<Value, String> {
    if !strip_length.is_finite() || strip_length <= 0.0 {
        return Err("strip length must be finite and positive".into());
    }
    let name = source
        .get("name")
        .and_then(Value::as_str)
        .ok_or("jagua instance requires a string name")?;
    let strip_height = source
        .get("strip_height")
        .and_then(Value::as_f64)
        .filter(|height| height.is_finite() && *height > 0.0)
        .ok_or("jagua instance requires a positive strip_height")?;
    let source_items = source
        .get("items")
        .and_then(Value::as_array)
        .ok_or("jagua instance requires an items array")?;
    let mut items = Vec::with_capacity(source_items.len());
    for source_item in source_items {
        let id = source_item
            .get("id")
            .and_then(|id| {
                id.as_str()
                    .map(str::to_owned)
                    .or_else(|| Some(id.to_string()))
            })
            .ok_or("jagua item requires an id")?;
        let demand = source_item
            .get("demand")
            .and_then(Value::as_u64)
            .filter(|demand| *demand > 0 && *demand <= u32::MAX as u64)
            .ok_or_else(|| format!("jagua item {id} requires a positive u32 demand"))?;
        let shape = source_item
            .get("shape")
            .ok_or_else(|| format!("jagua item {id} requires a shape"))?;
        if shape.get("type").and_then(Value::as_str) != Some("simple_polygon") {
            return Err(format!("jagua item {id} is not a simple_polygon"));
        }
        let coordinates = shape
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("jagua item {id} requires polygon data"))?;
        let vertices = coordinates
            .iter()
            .map(|coordinate| {
                let pair = coordinate
                    .as_array()
                    .filter(|pair| pair.len() == 2)
                    .ok_or_else(|| format!("jagua item {id} has a malformed coordinate"))?;
                let x = pair[0]
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("jagua item {id} has a non-finite x coordinate"))?;
                let y = pair[1]
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("jagua item {id} has a non-finite y coordinate"))?;
                Ok(json!({ "x": x, "y": y }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let rotation_policy = match source_item
            .get("allowed_orientations")
            .and_then(Value::as_array)
        {
            Some(orientations) => json!({
                "kind": "discrete",
                "angles_deg": orientations,
                "coupling": "independent",
            }),
            None => json!({
                "kind": "continuous",
                "min_deg": 0.0,
                "max_deg": 360.0,
                "coupling": "independent",
            }),
        };
        items.push(json!({
            "id": format!("{name}-item-{id}"),
            "shape": { "kind": "polygon", "vertices": vertices },
            "quantity": demand,
            "rotation_policy": rotation_policy,
        }));
    }
    Ok(json!({
        "schema_version": 2,
        "container": { "parts": [{
            "id": "stock",
            "operation": "add",
            "shape": { "kind": "rectangle", "width": strip_length, "height": strip_height },
            "translation": { "x": strip_length / 2.0, "y": strip_height / 2.0 },
            "rotation_deg": 0.0,
            "snap": null,
        }]},
        "exclusions": [],
        "items": items,
        "fixed_placements": [],
        "clearance": {
            "item_to_item": 0.0,
            "item_to_boundary": 0.0,
            "item_to_exclusion": 0.0,
        },
    }))
}

fn read_problem(path: &str) -> Result<PackingProblem, String> {
    read_json(path)
}
fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("failed to read '{path}': {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("invalid JSON in '{path}': {error}"))
}

#[cfg(test)]
mod tests {
    use super::{convert_jagua_strip, median};
    use serde_json::json;

    #[test]
    fn benchmark_median_handles_odd_and_even_repeats() {
        assert_eq!(median(&[1.0, 2.0, 3.0]), 2.0);
        assert_eq!(median(&[1.0, 2.0, 3.0, 8.0]), 2.5);
    }

    #[test]
    fn jagua_strip_conversion_preserves_demand_orientation_and_extent() {
        let converted = convert_jagua_strip(
            &json!({
                "name": "fixture",
                "strip_height": 5.0,
                "items": [{
                    "id": 7,
                    "demand": 3,
                    "allowed_orientations": [0.0, 90.0],
                    "shape": { "type": "simple_polygon", "data": [[0, 0], [2, 0], [0, 1]] }
                }]
            }),
            12.0,
        )
        .unwrap();

        assert_eq!(converted["container"]["parts"][0]["shape"]["width"], 12.0);
        assert_eq!(converted["container"]["parts"][0]["translation"]["x"], 6.0);
        assert_eq!(converted["items"][0]["quantity"], 3);
        assert_eq!(
            converted["items"][0]["rotation_policy"]["angles_deg"],
            json!([0.0, 90.0])
        );
    }
}
