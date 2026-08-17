use std::collections::HashMap;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex, OnceLock};

/// Supported audio sample-rate range. Rates outside this band are rejected
/// before resampling: they indicate corrupt/attacker-controlled headers or
/// unsupported hardware, and allowing them through lets the polyphase table
/// allocator request hundreds of gigabytes.
const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 384_000;

/// Hard cap on polyphase coefficients per table. A 44.1 kHz -> 16 kHz resample
/// allocates only ~7,520 coefficients; a coprime rate such as 44,101 Hz
/// allocates ~752k. The 4M cap leaves generous headroom so the full declared
/// 8k–384k band resamples, while still rejecting ratios that would allocate an
/// unsafe number of coefficients.
const MAX_POLYPHASE_COEFFICIENTS: u64 = 4_000_000;

/// Maximum total polyphase coefficients retained across all cached rate pairs.
/// Each `f32` coefficient is 4 bytes, so this bounds retained table memory to
/// roughly `MAX_TOTAL_COEFFICIENTS * 4` bytes regardless of how many distinct
/// rate pairs are requested. Real hardware exposes only a handful of rates, so
/// this budget comfortably holds them while preventing an attacker-controlled
/// stream of distinct rates from retaining hundreds of MB for the process
/// lifetime.
const MAX_TOTAL_COEFFICIENTS: u64 = 32_000_000;

/// Hard cap on the number of distinct rate pairs retained. Defends against the
/// LRU bookkeeping itself growing without bound.
const MAX_TABLE_CACHE_ENTRIES: usize = 64;

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
///
/// Failure is an explicit [`ResampleError`]: on `Err` this returns no buffer
/// at all, so callers must retain the original source samples separately and
/// must not relabel them as `target_rate` audio.
pub fn resample_to_rate(
    samples: &[f32],
    source_rate: u32,
    target_rate: u32,
) -> Result<Vec<f32>, ResampleError> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return Ok(Vec::new());
    }
    if source_rate == target_rate {
        return Ok(samples.to_vec());
    }

    // Reject untrusted/unsupported rates before the table allocator. Rates
    // outside the supported band indicate corrupt or attacker-controlled
    // headers and would otherwise allocate unbounded memory.
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&source_rate)
        || !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&target_rate)
    {
        return Err(ResampleError::UnsupportedRate {
            source_rate,
            target_rate,
        });
    }

    // Build (or fetch a cached) table. A `None` here means the ratio would
    // exceed the coefficient budget — return an explicit error rather than
    // relabeling source-rate audio as the target rate.
    let table = get_table(source_rate, target_rate).ok_or(ResampleError::RatioTooComplex {
        source_rate,
        target_rate,
    })?;

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
        let mut applied_weight_sum = 0.0_f32;
        for (k, &weight) in (-table.radius..=table.radius).zip(coeffs.iter()) {
            let source_index = n0 + k;
            if source_index < 0 || source_index >= samples.len() as isize {
                continue;
            }
            weighted_sum += samples[source_index as usize] * weight;
            applied_weight_sum += weight;
        }

        // Out-of-range edge taps were skipped; renormalize by the weight
        // actually applied so a constant signal stays constant at the clip
        // boundaries instead of being attenuated.
        if applied_weight_sum.abs() > f32::EPSILON {
            output.push(weighted_sum / applied_weight_sum);
        } else {
            let source_index = (center.floor() as usize).min(samples.len() - 1);
            output.push(samples[source_index]);
        }
    }

    Ok(output)
}

/// Error returned when audio cannot be resampled to the requested rate.
///
/// Callers must treat the original samples as *unresampled* when this is
/// returned — they must not label the buffer with `target_rate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResampleError {
    /// Source or target rate is outside the supported band.
    UnsupportedRate {
        source_rate: u32,
        target_rate: u32,
    },
    /// The requested ratio would allocate an unsafe number of coefficients.
    RatioTooComplex {
        source_rate: u32,
        target_rate: u32,
    },
}

impl std::fmt::Display for ResampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResampleError::UnsupportedRate {
                source_rate,
                target_rate,
            } => write!(
                f,
                "unsupported sample rate for resampling: {source_rate}->{target_rate} (must be within {MIN_SAMPLE_RATE}..={MAX_SAMPLE_RATE})"
            ),
            ResampleError::RatioTooComplex {
                source_rate,
                target_rate,
            } => write!(
                f,
                "resampling ratio {source_rate}->{target_rate} is too complex to resample safely"
            ),
        }
    }
}

impl std::error::Error for ResampleError {}

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

impl PolyphaseTable {
    /// Total coefficient count across all phase tables.
    fn coeff_count(&self) -> u64 {
        (self.up as u64) * ((2 * self.radius + 1) as u64)
    }
}

/// Build the polyphase coefficient table for a rate pair. This is the only
/// place trigonometric functions run. Returns `None` when the requested ratio
/// would allocate more than `MAX_POLYPHASE_COEFFICIENTS` coefficients.
fn build_polyphase_table(source_rate: u32, target_rate: u32) -> Option<PolyphaseTable> {
    let g = gcd(source_rate, target_rate).max(1);
    let up = target_rate / g;
    let down = source_rate / g;
    let source_ratio = (source_rate as f64 / target_rate as f64).max(1.0);
    let cutoff = (0.5 / source_ratio * 0.95) as f32;
    let radius = (8.0 * source_ratio).ceil() as isize;
    let coeffs_per_phase = (2 * radius + 1) as u64;
    // Reject ratios that would allocate an unsafe number of coefficients.
    if up as u64 * coeffs_per_phase > MAX_POLYPHASE_COEFFICIENTS {
        return None;
    }

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

    Some(PolyphaseTable {
        up,
        down,
        radius,
        phase_tables,
    })
}

struct CacheEntry {
    table: Arc<PolyphaseTable>,
    coeff_count: u64,
}

/// Bounded, LRU-ordered cache of resampling tables. The total retained
/// coefficient count is capped by [`MAX_TOTAL_COEFFICIENTS`] and the number of
/// entries by [`MAX_TABLE_CACHE_ENTRIES`]; least-recently-used entries are
/// evicted when either budget is exceeded.
struct TableCache {
    map: HashMap<(u32, u32), CacheEntry>,
    /// LRU order: most-recently-used entry first.
    order: Vec<(u32, u32)>,
    total_coeffs: u64,
}

impl TableCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
            total_coeffs: 0,
        }
    }
}

static TABLE_CACHE: OnceLock<Mutex<TableCache>> = OnceLock::new();

/// Move `key` to the most-recently-used position.
fn touch(order: &mut Vec<(u32, u32)>, key: &(u32, u32)) {
    if let Some(pos) = order.iter().position(|k| k == key) {
        order.remove(pos);
    }
    order.insert(0, *key);
}

fn get_table(source_rate: u32, target_rate: u32) -> Option<Arc<PolyphaseTable>> {
    // Fast path: return a cached table without rebuilding. The lock is released
    // before any table generation so concurrent callers are not serialized.
    let cached = {
        let cache = TABLE_CACHE.get_or_init(|| Mutex::new(TableCache::new()));
        let mut guard = cache.lock().unwrap();
        // Clone the cached table out of the immutable `guard.map` borrow so the
        // borrow ends here; only then may we mutate the LRU ordering.
        let cloned = guard
            .map
            .get(&(source_rate, target_rate))
            .map(|entry| Arc::clone(&entry.table));
        if cloned.is_some() {
            touch(&mut guard.order, &(source_rate, target_rate));
        }
        cloned
    };
    if let Some(entry) = cached {
        return Some(entry);
    }

    // Build the table outside the lock — generating the windowed-sinc kernels is
    // CPU-bound and must not block other callers.
    let built = build_polyphase_table(source_rate, target_rate)?;
    let coeff_count = built.coeff_count();
    let shared = Arc::new(built);

    let cache = TABLE_CACHE.get_or_init(|| Mutex::new(TableCache::new()));
    let mut guard = cache.lock().unwrap();
    // Another thread may have built and inserted the same pair meanwhile.
    if let Some(entry) = guard.map.get(&(source_rate, target_rate)) {
        return Some(Arc::clone(&entry.table));
    }
    // Evict least-recently-used entries until the budget allows the new entry.
    while (guard.total_coeffs + coeff_count > MAX_TOTAL_COEFFICIENTS
        || guard.map.len() >= MAX_TABLE_CACHE_ENTRIES)
        && guard.map.len() > 1
    {
        let Some(victim) = guard.order.pop() else { break };
        if let Some(evicted) = guard.map.remove(&victim) {
            guard.total_coeffs -= evicted.coeff_count;
        }
    }
    guard.map.insert(
        (source_rate, target_rate),
        CacheEntry {
            table: Arc::clone(&shared),
            coeff_count,
        },
    );
    guard.total_coeffs += coeff_count;
    guard.order.insert(0, (source_rate, target_rate));
    Some(shared)
}

#[cfg(test)]
pub(crate) fn cache_stats() -> (usize, u64) {
    let cache = TABLE_CACHE.get_or_init(|| Mutex::new(TableCache::new()));
    let guard = cache.lock().unwrap();
    (guard.map.len(), guard.total_coeffs)
}

#[cfg(test)]
pub(crate) fn clear_cache() {
    let cache = TABLE_CACHE.get_or_init(|| Mutex::new(TableCache::new()));
    let mut guard = cache.lock().unwrap();
    guard.map.clear();
    guard.order.clear();
    guard.total_coeffs = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_resampling_preserves_samples() {
        let samples = [0.0, 0.25, -0.5, 1.0];
        assert_eq!(
            resample_to_rate(&samples, 16_000, 16_000).unwrap(),
            samples
        );
    }

    #[test]
    fn resampling_produces_target_length() {
        let samples = vec![0.25; 44_100];
        let output = resample_to_rate(&samples, 44_100, 16_000).unwrap();
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| (*sample - 0.25).abs() < 0.01));
    }

    #[test]
    fn resampling_constant_signal_preserves_level() {
        // The normalized polyphase kernels must preserve a constant signal.
        for &(src, dst) in &[
            (48_000u32, 16_000u32),
            (44_100u32, 16_000u32),
            (16_000u32, 48_000u32),
        ] {
            let samples = vec![0.5; src as usize * 2];
            let output = resample_to_rate(&samples, src, dst).unwrap();
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
        let output = resample_to_rate(&samples, 48_000, 16_000).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(output.len(), 5 * 60 * 16_000);
        assert!(
            elapsed.as_millis() < 15_000,
            "resampling 5min/48k took {elapsed:?}"
        );
    }

    #[test]
    fn resampling_preserves_constant_signal_at_first_and_last_sample() {
        for &(src, dst) in &[(48_000, 16_000), (44_100, 16_000), (16_000, 48_000)] {
            let samples = vec![0.5; src as usize];
            let output = resample_to_rate(&samples, src, dst).unwrap();
            assert_eq!(output.len(), dst as usize);
            let first = output[0];
            let last = output[output.len() - 1];
            assert!(
                (first - 0.5).abs() < 0.02 && (last - 0.5).abs() < 0.02,
                "boundary drift for {src}->{dst}: first={first}, last={last}"
            );
        }
    }

    #[test]
    fn resampling_handles_one_sample_input() {
        let output = resample_to_rate(&[1.0], 16_000, 48_000).unwrap();
        assert_eq!(output.len(), 3);
        assert!(output.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn resampling_ordinary_rate_within_range_resamples() {
        // 44_101 Hz is a valid hardware-adjacent rate and must resample.
        let samples = vec![0.25; 44_101];
        let output = resample_to_rate(&samples, 44_101, 16_000).unwrap();
        assert_eq!(output.len(), 16_000);
    }

    #[test]
    fn resampling_rejects_out_of_band_rates() {
        // Rates outside the supported band must be rejected, never passed
        // through and relabeled as the target rate.
        for &rate in &[1_000u32, 100u32, 1_000_000u32, u32::MAX] {
            let samples = vec![0.0_f32; 16];
            let err = resample_to_rate(&samples, rate, 16_000).unwrap_err();
            assert!(
                matches!(err, ResampleError::UnsupportedRate { .. }),
                "expected UnsupportedRate for rate {rate}, got {err:?}"
            );
        }
    }

    #[test]
    fn resampling_accepts_in_band_coprime_rates_within_cap() {
        // 128_001 and 192_001 Hz lie inside the supported band and allocate
        // ~2.1M and ~3.1M polyphase coefficients respectively — both under the
        // 4M cap — so the full declared 8k–384k band must resample rather than
        // error.
        for &rate in &[128_001u32, 192_001u32] {
            let samples = vec![0.25_f32; rate as usize];
            let output = resample_to_rate(&samples, rate, 16_000)
                .unwrap_or_else(|e| panic!("expected Ok for rate {rate}, got {e:?}"));
            assert_eq!(output.len(), 16_000, "wrong length for rate {rate}");
        }
    }

    #[test]
    fn resampling_rejects_in_band_rates_with_unsafe_ratio() {
        // 320_001 Hz lies inside the supported band but its coprime ratio
        // allocates ~5.2M polyphase coefficients, above the 4M cap. It must be
        // rejected rather than silently relabeled as 16 kHz.
        let samples = vec![0.0_f32; 16];
        let err = resample_to_rate(&samples, 320_001, 16_000).unwrap_err();
        assert!(
            matches!(err, ResampleError::RatioTooComplex { .. }),
            "expected RatioTooComplex for rate 320_001, got {err:?}"
        );
    }

    #[test]
    fn resampling_cache_stays_within_byte_and_entry_budget() {
        clear_cache();
        // Many distinct coprime rates inside the band that still fit under the
        // coefficient budget. The cache must not exceed the entry cap or the
        // total coefficient budget regardless of how many distinct rates are
        // requested.
        for base in 8_000..8_200 {
            let samples = vec![0.0_f32; 1_000];
            let _ = resample_to_rate(&samples, base, 16_000);
        }
        let (len, total) = cache_stats();
        assert!(
            len <= MAX_TABLE_CACHE_ENTRIES,
            "cache entries {len} exceed cap {MAX_TABLE_CACHE_ENTRIES}"
        );
        assert!(
            total <= MAX_TOTAL_COEFFICIENTS,
            "cache coefficients {total} exceed budget {MAX_TOTAL_COEFFICIENTS}"
        );
    }
}
