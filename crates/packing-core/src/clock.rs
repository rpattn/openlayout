/// Monotonic instrumentation clock used by core algorithms.
///
/// Browser workers own wall-clock policy and cancellation, so Wasm builds deliberately report
/// zero elapsed core time while retaining the same call sites as native builds.
#[derive(Clone, Copy)]
pub(crate) struct Clock {
    #[cfg(not(target_arch = "wasm32"))]
    started: std::time::Instant,
}

impl Clock {
    pub(crate) fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            started: std::time::Instant::now(),
        }
    }

    pub(crate) fn elapsed_ms(self) -> u64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.started.elapsed().as_millis() as u64
        }
        #[cfg(target_arch = "wasm32")]
        {
            0
        }
    }
}
