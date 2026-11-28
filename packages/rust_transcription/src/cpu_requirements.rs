//! Startup guard for the x86-64 instruction set the shipped sidecar needs.
//!
//! The release builds pin ggml to an AVX baseline, set by
//! `packages/rust_transcription/cmake/*-ci-toolchain.cmake`, because this
//! static ggml build has no runtime dispatch between instruction-set variants.
//! On a CPU without AVX the first quantized kernel faults with an illegal
//! instruction, the process disappears mid-request, and the desktop only sees
//! a dropped loopback connection. Checking before the socket is bound turns
//! that into one explicit stderr line that names the requirement.

/// Lowest x86-64 extension the shipped sidecar is compiled against.
pub(crate) const REQUIRED_X86_FEATURE: &str = "AVX";

/// Escape hatch for a local build that targets the machine it runs on.
///
/// A developer build leaves ggml on its native defaults, so ggml emits code
/// for that host and a CPU without AVX can still run it. The startup check
/// cannot tell the two builds apart, so it offers a way out that the operator
/// has to ask for by name.
pub(crate) const ALLOW_UNSUPPORTED_CPU_ENV: &str = "RUST_TRANSCRIPTION_ALLOW_UNSUPPORTED_CPU";

/// Maps the detected CPU capability onto the startup error, if any.
///
/// Kept separate from the detection call so both branches stay unit-testable
/// without a machine that lacks AVX.
pub(crate) fn requirement_error(has_required_feature: bool) -> Option<String> {
    if has_required_feature {
        return None;
    }

    Some(format!(
        "this CPU does not support {REQUIRED_X86_FEATURE}, which the local transcription engine requires. \
The engine is built for an AVX baseline, the instruction set Intel shipped from Sandy Bridge and AMD from \
Bulldozer in 2011, and a few entry-level parts from those lines shipped with AVX disabled. \
Set {ALLOW_UNSUPPORTED_CPU_ENV}=1 to start anyway, which only makes sense for a build compiled on this machine."
    ))
}

/// Reads the escape hatch the way an operator would write it.
pub(crate) fn override_requested(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1" | "true" | "yes"))
}

/// Fails startup when the CPU cannot execute the shipped engine.
#[cfg(target_arch = "x86_64")]
pub(crate) fn check() -> Result<(), String> {
    let Some(message) = requirement_error(std::arch::is_x86_feature_detected!("avx")) else {
        return Ok(());
    };
    let override_value = std::env::var(ALLOW_UNSUPPORTED_CPU_ENV).ok();

    if override_requested(override_value.as_deref()) {
        eprintln!("warning: {message}");
        return Ok(());
    }

    Err(message)
}

/// Every other supported architecture, Apple Silicon and ARM64 Windows, has
/// one baseline the build already targets.
#[cfg(not(target_arch = "x86_64"))]
pub(crate) fn check() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{override_requested, requirement_error, ALLOW_UNSUPPORTED_CPU_ENV};

    #[test]
    fn supported_cpu_reports_no_error() {
        assert!(requirement_error(true).is_none());
    }

    #[test]
    fn unsupported_cpu_reports_an_actionable_error() {
        let message = requirement_error(false).expect("missing AVX must fail startup");

        assert!(message.contains("AVX"));
        assert!(message.contains("CPU"));
        // The operator reading the log needs the baseline, not just the
        // failure name: it is what separates a bad machine from a bad build.
        assert!(message.contains("AVX baseline"));
        assert!(message.contains(ALLOW_UNSUPPORTED_CPU_ENV));
    }

    #[test]
    fn override_accepts_the_forms_an_operator_writes() {
        assert!(override_requested(Some("1")));
        assert!(override_requested(Some(" true ")));
        assert!(override_requested(Some("yes")));
    }

    #[test]
    fn override_rejects_everything_else() {
        assert!(!override_requested(None));
        assert!(!override_requested(Some("")));
        assert!(!override_requested(Some("0")));
        assert!(!override_requested(Some("no")));
        assert!(!override_requested(Some("trueish")));
    }
}
