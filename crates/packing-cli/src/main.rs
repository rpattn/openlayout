use packing_core::{
    PackingProblem, SensitivityStudy, SolveOptions, prepare_problem, run_sensitivity,
    solve_prepared, solve_prepared_feasibility, validate_problem,
};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::process::ExitCode;

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
        [command, problem_path, target] if command == "feasible" => feasibility_command(problem_path, target, None),
        [command, problem_path, target, options_path] if command == "feasible" => feasibility_command(problem_path, target, Some(options_path)),
        [command, problem_path, study_path] if command == "sensitivity" => {
            let problem = read_problem(problem_path)?;
            let study: SensitivityStudy = read_json(study_path)?;
            serde_json::to_value(run_sensitivity(&problem, &study).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
        }
        _ => Err("usage: packing-cli validate <problem.json> | solve <problem.json> [options.json] | feasible <problem.json> <count> [options.json] | sensitivity <problem.json> <study.json>".to_string()),
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

fn read_problem(path: &str) -> Result<PackingProblem, String> {
    read_json(path)
}
fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("failed to read '{path}': {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("invalid JSON in '{path}': {error}"))
}
