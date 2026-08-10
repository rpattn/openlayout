use js_sys::Function;
use packing_core::{
    PackingProblem, PreparedProblem, SensitivityObserver, SensitivityProgress, SensitivityStudy,
    SolveObserver, SolveOptions, SolveProgress, prepare_problem, resolve_problem_geometry,
    run_sensitivity as core_run_sensitivity, run_sensitivity_with_observer, solve_prepared,
    solve_prepared_feasibility, solve_with_observer, solve_with_observer_clearance_continuation,
    solve_with_observer_direct, validate_problem as core_validate_problem,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct PackingEngine {
    cached_problem_json: Option<String>,
    cached_problem: Option<PackingProblem>,
    prepared: Option<PreparedProblem>,
}

#[wasm_bindgen]
impl PackingEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            cached_problem_json: None,
            cached_problem: None,
            prepared: None,
        }
    }

    pub fn validate(&mut self, input_json: &str) -> Result<String, JsError> {
        self.prepare(input_json)?;
        Ok("{\"valid\":true}".to_string())
    }

    pub fn solve(&mut self, input_json: &str, options_json: &str) -> Result<String, JsError> {
        let options = parse_options(options_json)?;
        let prepared = self.prepare(input_json)?;
        encode(&solve_prepared(prepared, &options).map_err(core_error)?)
    }

    pub fn solve_with_progress(
        &mut self,
        input_json: &str,
        options_json: &str,
        callback: Function,
    ) -> Result<String, JsError> {
        let options = parse_options(options_json)?;
        let prepared = self.prepare(input_json)?;
        let mut observer = JavaScriptObserver {
            callback,
            callback_error: None,
        };
        let result = solve_with_observer(prepared, &options, &mut observer).map_err(core_error)?;
        if let Some(error) = observer.callback_error {
            return Err(JsError::new(&error));
        }
        encode(&result)
    }

    pub fn solve_direct_with_progress(
        &mut self,
        input_json: &str,
        options_json: &str,
        callback: Function,
    ) -> Result<String, JsError> {
        let options = parse_options(options_json)?;
        let prepared = self.prepare(input_json)?;
        let mut observer = JavaScriptObserver {
            callback,
            callback_error: None,
        };
        let result =
            solve_with_observer_direct(prepared, &options, &mut observer).map_err(core_error)?;
        if let Some(error) = observer.callback_error {
            return Err(JsError::new(&error));
        }
        encode(&result)
    }

    pub fn solve_clearance_continuation_with_progress(
        &mut self,
        input_json: &str,
        options_json: &str,
        callback: Function,
    ) -> Result<String, JsError> {
        let options = parse_options(options_json)?;
        let prepared = self.prepare(input_json)?;
        let mut observer = JavaScriptObserver {
            callback,
            callback_error: None,
        };
        let result = solve_with_observer_clearance_continuation(prepared, &options, &mut observer)
            .map_err(core_error)?;
        if let Some(error) = observer.callback_error {
            return Err(JsError::new(&error));
        }
        encode(&result)
    }

    pub fn feasible(
        &mut self,
        input_json: &str,
        options_json: &str,
        target_count: usize,
    ) -> Result<String, JsError> {
        let options = parse_options(options_json)?;
        let prepared = self.prepare(input_json)?;
        encode(&solve_prepared_feasibility(prepared, &options, target_count).map_err(core_error)?)
    }

    pub fn sensitivity(&mut self, input_json: &str, study_json: &str) -> Result<String, JsError> {
        self.prepare(input_json)?;
        let study: SensitivityStudy = parse(study_json, "sensitivity study")?;
        encode(
            &core_run_sensitivity(
                self.cached_problem
                    .as_ref()
                    .expect("prepared problem has a source problem"),
                &study,
            )
            .map_err(core_error)?,
        )
    }

    pub fn sensitivity_with_progress(
        &mut self,
        input_json: &str,
        study_json: &str,
        callback: Function,
    ) -> Result<String, JsError> {
        self.prepare(input_json)?;
        let study: SensitivityStudy = parse(study_json, "sensitivity study")?;
        let mut observer = JavaScriptSensitivityObserver {
            callback,
            callback_error: None,
        };
        let result = run_sensitivity_with_observer(
            self.cached_problem
                .as_ref()
                .expect("prepared problem has a source problem"),
            &study,
            &mut observer,
        )
        .map_err(core_error)?;
        if let Some(error) = observer.callback_error {
            return Err(JsError::new(&error));
        }
        encode(&result)
    }
}

impl Default for PackingEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PackingEngine {
    fn prepare(&mut self, input_json: &str) -> Result<&PreparedProblem, JsError> {
        if self.cached_problem_json.as_deref() != Some(input_json) {
            let problem: PackingProblem = parse(input_json, "problem")?;
            let prepared = prepare_problem(&problem).map_err(core_error)?;
            self.cached_problem_json = Some(input_json.to_string());
            self.cached_problem = Some(problem);
            self.prepared = Some(prepared);
        }
        Ok(self
            .prepared
            .as_ref()
            .expect("a matching prepared problem was cached"))
    }
}

struct JavaScriptObserver {
    callback: Function,
    callback_error: Option<String>,
}

impl SolveObserver for JavaScriptObserver {
    fn on_progress(&mut self, progress: &SolveProgress) {
        if self.callback_error.is_some() {
            return;
        }
        let json = match serde_json::to_string(progress) {
            Ok(json) => json,
            Err(error) => {
                self.callback_error = Some(format!("failed to serialise progress: {error}"));
                return;
            }
        };
        if let Err(error) = self
            .callback
            .call1(&JsValue::NULL, &JsValue::from_str(&json))
        {
            self.callback_error = Some(format!("progress callback failed: {error:?}"));
        }
    }
}

struct JavaScriptSensitivityObserver {
    callback: Function,
    callback_error: Option<String>,
}

impl SensitivityObserver for JavaScriptSensitivityObserver {
    fn on_progress(&mut self, progress: &SensitivityProgress) {
        if self.callback_error.is_some() {
            return;
        }
        let json = match serde_json::to_string(progress) {
            Ok(json) => json,
            Err(error) => {
                self.callback_error =
                    Some(format!("failed to serialise sensitivity progress: {error}"));
                return;
            }
        };
        if let Err(error) = self
            .callback
            .call1(&JsValue::NULL, &JsValue::from_str(&json))
        {
            self.callback_error = Some(format!("sensitivity progress callback failed: {error:?}"));
        }
    }
}

#[wasm_bindgen]
pub fn validate_problem(input_json: &str) -> Result<String, JsError> {
    let problem: PackingProblem = parse(input_json, "problem")?;
    core_validate_problem(&problem).map_err(core_error)?;
    Ok("{\"valid\":true}".to_string())
}

#[wasm_bindgen]
pub fn solve_problem(input_json: &str, options_json: &str) -> Result<String, JsError> {
    PackingEngine::new().solve(input_json, options_json)
}

#[wasm_bindgen]
pub fn run_sensitivity(input_json: &str, study_json: &str) -> Result<String, JsError> {
    PackingEngine::new().sensitivity(input_json, study_json)
}

#[wasm_bindgen]
pub fn resolved_geometry(input_json: &str) -> Result<String, JsError> {
    let problem: PackingProblem = parse(input_json, "problem")?;
    encode(&resolve_problem_geometry(&problem))
}

fn parse_options(input: &str) -> Result<SolveOptions, JsError> {
    if input.trim().is_empty() {
        Ok(SolveOptions::default())
    } else {
        parse(input, "solve options")
    }
}

fn parse<T: DeserializeOwned>(input: &str, label: &str) -> Result<T, JsError> {
    serde_json::from_str(input)
        .map_err(|error| JsError::new(&format!("invalid {label} JSON: {error}")))
}

fn encode<T: Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value)
        .map_err(|error| JsError::new(&format!("failed to serialise result: {error}")))
}

fn core_error(error: packing_core::PackingError) -> JsError {
    JsError::new(&error.to_string())
}
