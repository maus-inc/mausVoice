use std::collections::HashMap;
use std::f32::consts::PI;
use std::sync::{Mutex, OnceLock};

/// Resample mono audio with a windowed-sinc low-pass filter. Downsampling
/// needs to remove content above the target Nyquist frequency; linear
/// interpolation alone aliases that content into the audible range.
///
/// The expensive `sin`/`cos` windowed-sinc coefficients are computed **once**
/// per `(source_rate, target_rate)` pair and cached in a polyphase table. Each
/// output sample then performs a plain convolution over the cached coefficients
/// for its fractional phase, so the trigonometric cost no longer scales with the
/// number of output samples (the previous implementation re-evaluated the kernel
/// for every tap of every sample — hundreds of millions of trig ops for a few
/// minutes of audio).
pub fn resample_to_rate(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return samples.to_vec();
    }

    let table = get_table(source_rate, target_rate);
    let ratio = target_rate as f64 / source_rate as f64;
    let output_len = ((samples.len() as f64) * ratio).ceil().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);

    for output_index in 0..output_len {
        // Source position of this output sample, in source-sample units.
        let center = (output_index as f64) * table.down as f64 / table.up as f64;
        let n0 = center.floor() as isize;
        // The fractional part of `center` selects the polyphase kernel; it is
        // exactly `(output_index * down) mod up` phases apart.
        let phase = ((output_index as u64 * table.down as u64) % table.up as u64) as usize;
        let coeffs = &table.phase_tables[phase];

        let mut weighted_sum = 0.0_f32;
        let mut any = false;
        for (k, &weight) in (-table.radius..=table.radius).zip(coeffs.iter()) {
            let source_index = n0 + k;
            if source_index < 0 || source_index >= samples.len() as isize {
                continue;
            }
            weighted_sum += samples[source_index as usize] * weight;
            any = true;
        }

        if any {
            output.push(weighted_sum);
        } else {
            let source_index = (center.floor() as usize).min(samples.len() - 1);
            output.push(samples[source_index]);
        }
    }

    output
}

fn gcd(a: u32, b: u32) -> u32 {
    let mut a = a;
    let mut b = b;
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

/// Precomputed windowed-sinc kernels, one per fractional phase of the
/// resampling ratio `(down/up)`. Each `phase_tables[phase]` holds
/// `2 * radius + 1` normalized coefficients.
#[derive(Clone)]
struct PolyphaseTable {
    up: u32,
    down: u32,
    radius: isize,
    phase_tables: Vec<Vec<f32>>,
}

/// Build the polyphase coefficient table for a rate pair. This is the only
/// place trigonometric functions run.
fn build_polyphase_table(source_rate: u32, target_rate: u32) -> PolyphaseTable {
    let g = gcd(source_rate, target_rate).max(1);
    let up = target_rate / g;
    let down = source_rate / g;
    let source_ratio = (source_rate as f64 / target_rate as f64).max(1.0);
    let cutoff = (0.5 / source_ratio * 0.95) as f32;
    let radius = (8.0 * source_ratio).ceil() as isize;

    let mut phase_tables = Vec::with_capacity(up as usize);
    for phase in 0..up {
        // Fractional center offset this phase represents, in [0, 1).
        let frac = phase as f32 / up as f32;
        let mut coeffs = Vec::with_capacity((2 * radius + 1) as usize);
        let mut weight_sum = 0.0_f32;
        for k in -radius..=radius {
            let distance = k as f32 - frac;
            let window_position = (distance.abs() / radius as f32).clamp(0.0, 1.0);
            let argument = 2.0 * cutoff * distance;
            let sinc = if argument.abs() < f32::EPSILON {
                1.0
            } else {
                (PI * argument).sin() / (PI * argument)
            };
            let window = 0.5 * (1.0 + (PI * window_position).cos());
            let weight = 2.0 * cutoff * sinc * window;
            weight_sum += weight;
            coeffs.push(weight);
        }
        // Normalize so the coefficients preserve DC gain (a constant input maps
        // to the same constant output).
        if weight_sum.abs() > f32::EPSILON {
            for coeff in coeffs.iter_mut() {
                *coeff /= weight_sum;
            }
        }
        phase_tables.push(coeffs);
    }

    PolyphaseTable {
        up,
        down,
        radius,
        phase_tables,
    }
}

static TABLE_CACHE: OnceLock<Mutex<HashMap<(u32, u32), PolyphaseTable>>> = OnceLock::new();

fn get_table(source_rate: u32, target_rate: u32) -> PolyphaseTable {
    let cache = TABLE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();
    if let Some(table) = guard.get(&(source_rate, target_rate)) {
        return table.clone();
    }
    let table = build_polyphase_table(source_rate, target_rate);
    guard.insert((source_rate, target_rate), table.clone());
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_resampling_preserves_samples() {
        let samples = [0.0, 0.25, -0.5, 1.0];
        assert_eq!(resample_to_rate(&samples, 16_000, 16_000), samples);
    }

    #[test]
    fn resampling_produces_target_length() {
        let samples = vec![0.25; 44_100];
        let output = resample_to_rate(&samples, 44_100, 16_000);
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| (*sample - 0.25).abs() < 0.01));
    }

    #[test]
    fn resampling_constant_signal_preserves_level() {
        // The normalized polyphase kernels must preserve a constant signal.
        for &(src, dst) in &[(48_000, 16_000), (44_100, 16_000), (16_000, 48_000)] {
            let samples = vec![0.5; src * 2];
            let output = resample_to_rate(&samples, src, dst);
            assert!(
                output.iter().all(|sample| (*sample - 0.5).abs() < 0.02),
                "constant signal drifted for {src}->{dst}: {:?}",
                &output[..4.min(output.len())]
            );
        }
    }

    #[test]
    fn resampling_handles_long_input_without_panic() {
        // Five minutes of 48 kHz audio must resample to the expected length and
        // stay well within the time budget (no per-sample trig).
        let samples = vec![0.0_f32; 5 * 60 * 48_000];
        let start = std::time::Instant::now();
        let output = resample_to_rate(&samples, 48_000, 16_000);
        let elapsed = start.elapsed();
        assert_eq!(output.len(), 5 * 60 * 16_000);
        assert!(
            elapsed.as_millis() < 2_000,
            "resampling 5min/48k took {elapsed:?}"
        );
    }
}
