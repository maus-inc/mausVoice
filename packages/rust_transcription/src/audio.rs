use std::f32::consts::PI;

/// Resample mono audio with a windowed-sinc low-pass filter. Downsampling
/// needs to remove content above the target Nyquist frequency; linear
/// interpolation alone aliases that content into the audible range.
pub fn resample_to_rate(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return samples.to_vec();
    }

    let ratio = target_rate as f64 / source_rate as f64;
    let output_len = ((samples.len() as f64) * ratio).ceil().max(1.0) as usize;
    let source_ratio = (source_rate as f64 / target_rate as f64).max(1.0);
    let cutoff = (0.5 / source_ratio * 0.95) as f32;
    let radius = (8.0 * source_ratio).ceil() as isize;
    let mut output = Vec::with_capacity(output_len);

    for output_index in 0..output_len {
        let center = output_index as f64 / ratio;
        let first = center.floor() as isize - radius + 1;
        let last = center.floor() as isize + radius;
        let mut weighted_sum = 0.0_f32;
        let mut weight_sum = 0.0_f32;

        for source_index in first..=last {
            if source_index < 0 || source_index >= samples.len() as isize {
                continue;
            }
            let distance = source_index as f64 - center;
            let window_position = (distance.abs() / radius as f64) as f32;
            if window_position > 1.0 {
                continue;
            }
            let argument = 2.0 * cutoff * distance as f32;
            let sinc = if argument.abs() < f32::EPSILON {
                1.0
            } else {
                (PI * argument).sin() / (PI * argument)
            };
            let window = 0.5 * (1.0 + (PI * window_position).cos());
            let weight = 2.0 * cutoff * sinc * window;
            weighted_sum += samples[source_index as usize] * weight;
            weight_sum += weight;
        }

        output.push(if weight_sum.abs() > f32::EPSILON {
            weighted_sum / weight_sum
        } else {
            let source_index = (center.floor() as usize).min(samples.len() - 1);
            samples[source_index]
        });
    }

    output
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
}
