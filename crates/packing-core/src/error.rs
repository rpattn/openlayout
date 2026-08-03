use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackingErrorKind {
    InvalidGeometry,
    InvalidConfiguration,
    UnsupportedInput,
    ImpossibleClearance,
    Serialization,
    Solver,
    Validation,
    Cancellation,
}

#[derive(Debug, Error, Clone, Serialize, Deserialize)]
#[error("{kind:?}: {message}")]
pub struct PackingError {
    pub kind: PackingErrorKind,
    pub message: String,
}

impl PackingError {
    pub(crate) fn new(kind: PackingErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn geometry(message: impl Into<String>) -> Self {
        Self::new(PackingErrorKind::InvalidGeometry, message)
    }

    pub(crate) fn config(message: impl Into<String>) -> Self {
        Self::new(PackingErrorKind::InvalidConfiguration, message)
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::new(PackingErrorKind::Validation, message)
    }
}
