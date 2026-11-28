//! Startup guard for the x86-64 instruction set the shipped sidecar needs.
//!
//! The release builds pin ggml to an AVX baseline (see
//! `packages/rust_transcription/cmake/*-ci-toolchain.cmake`) because this
//! static ggml build has no runtime dispatch between instruction-set variants.
//! On a CPU without AVX, the first quantized kernel faults with an illegal
//! instruction, the process disappears mid-request, and the desktop only sees
//! a dropped loopback connection. Checking before the socket is bound turns
//! that into one explicit stderr line that names the requirement.

/// Lowest x86-64 extension the shipped sidecar is compiled against.
pub(crate) const REQUIRED_X86_FEATURE: &str = "AVX";

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
The engine is built with an AVX baseline (Intel Sandy Bridge or AMD Bulldozer, 2011 or later) \
and cannot run on this machine."
    ))
}

/// Fails startup when the CPU cannot execute the shipped engine.
#[cfg(target_arch = "x86_64")]
pub(crate) fn check() -> Result<(), String> {
    match requirement_error(std::arch::is_x86_feature_detected!("avx")) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// Every other supported architecture (Apple Silicon, ARM64 Windows) has one
/// baseline the build already targets.
#[cfg(not(target_arch = "x86_64"))]
pub(crate) fn check() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check, requirement_error, REQUIRED_X86_FEATURE};

    #[test]
    fn supported_cpu_reports_no_error() {
        assert!(requirement_error(true).is_none());
    }

    #[test]
    fn unsupported_cpu_reports_an_actionable_error() {
        let message = requirement_error(false).expect("missing AVX must fail startup");

        assert!(message.contains(REQUIRED_X86_FEATURE));
        assert!(message.contains("CPU"));
        // The operator reading the log needs the baseline, not just the
        // failure name: it is what separates a bad machine from a bad build.
        assert!(message.contains("AVX baseline"));
    }

    #[test]
    #[cfg(target_arch = "x86_64")]
    fn check_matches_the_detected_avx_capability() {
        let detected = std::arch::is_x86_feature_detected!("avx");

        assert_eq!(check().is_ok(), detected);
    }
}
