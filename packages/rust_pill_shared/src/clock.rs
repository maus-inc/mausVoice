use std::sync::OnceLock;
use std::time::Instant;

/// Seconds since a process-local monotonic origin, never a wall-clock timestamp.
pub fn monotonic_now() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_are_finite_and_non_decreasing() {
        let mut previous = monotonic_now();
        for _ in 0..100 {
            let current = monotonic_now();
            assert!(current.is_finite() && current >= previous);
            previous = current;
        }
    }
}
