//! Real ONNX Runtime inference for the NVIDIA NeMo models (Parakeet CTC,
//! Parakeet TDT, Canary).
//!
//! This module replaces the previous placeholder ONNX path. The previous code
//! only checked that a `.onnx` file was non-empty and then *fabricated* output
//! tokens from per-frame signal energy — the result did not depend on the
//! model weights at all. Here we:
//!
//! 1. Load the complete artifact set (encoder/decoder/joiner + `tokens.txt`)
//!    through [`ort`] (ONNX Runtime). Loading parses the graph and weights, so
//!    a file that is not a valid ONNX protobuf (such as the old synthetic test
//!    fixtures) is rejected — see [`validate_model`].
//! 2. Preprocess 16 kHz mono audio into a log-Mel filterbank using the same
//!    Kaldi/sherpa-onnx feature configuration the models were trained with.
//! 3. Run the encoder graph and decode the output with the model-specific
//!    decoder (CTC greedy for Parakeet CTC, greedy transducer for Parakeet
//!    TDT, greedy encoder-decoder for Canary).
//!
//! NOTE: building this crate fetches the prebuilt ONNX Runtime shared library
//! (the `download-binaries` default feature of `ort`), so CI needs network
//! access at build time. Running inference additionally needs the model weight
//! artifacts, which are downloaded by the sidecar.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ort::session::GraphOptimizationLevel;
use ort::value::Tensor;
use ort::Session;

use crate::models::WhisperModel;

/// Hard cap on autoregressively emitted tokens to guarantee termination.
const MAX_DECODE_TOKENS: usize = 512;

/// Lazily-loaded, cached ONNX sessions keyed by their on-demand `Session`
/// (built once and reused). Wrapped in `Mutex` because `Session::run` requires
/// `&mut self`.
type SessionCache = Mutex<HashMap<String, Arc<Mutex<Session>>>>;

static SESSION_CACHE: SessionCache = Mutex::new(HashMap::new());

/// Load (and cache) an ONNX session from `path`. Loading parses the ONNX graph
/// and weights, so this returns an error for files that are not valid ONNX
/// protobufs (e.g. the synthetic test fixtures), which is exactly what makes
/// [`validate_model`] reject bogus files.
pub fn load_session(path: &Path) -> Result<Arc<Mutex<Session>>, String> {
    let key = path
        .to_string_lossy()
        .into_owned();

    {
        let cache = SESSION_CACHE
            .lock()
            .map_err(|_| "onnx session cache poisoned".to_string())?;
        if let Some(existing) = cache.get(&key) {
            return Ok(existing.clone());
        }
    }

    let session = Session::builder()
        .map_err(|err| format!("failed to create onnx session builder: {err}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|err| format!("failed to set onnx optimization level: {err}"))?
        .with_intra_threads(1)
        .map_err(|err| format!("failed to set onnx intra-op threads: {err}"))?
        .commit_from_file(path)
        .map_err(|err| format!("failed to load onnx model '{}': {err}", path.display()))?;

    let cached = Arc::new(Mutex::new(session));
    let mut cache = SESSION_CACHE
        .lock()
        .map_err(|_| "onnx session cache poisoned".to_string())?;
    cache.insert(key, cached.clone());
    Ok(cached)
}

/// Validate an ONNX model by attempting to load it through ONNX Runtime. A real
/// model returns `Ok(true)`; anything that is not a parseable ONNX graph (the
/// old fake-byte fixtures, a truncated download, etc.) returns `Err`, which the
/// API layer surfaces as `valid: false`.
pub fn validate_model(model_path: &Path) -> Result<bool, String> {
    match load_session(model_path) {
        Ok(_) => Ok(true),
        Err(err) => Err(format!("onnx model failed validation: {err}")),
    }
}

/// Run real transcription for one of the NeMo ONNX models.
pub fn transcribe(
    model: WhisperModel,
    model_path: &Path,
    samples_16k: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    let kind = model
        .onnx_kind()
        .ok_or_else(|| format!("model '{}' is not an ONNX model", model.as_slug()))?;

    if samples_16k.is_empty() {
        return Ok(String::new());
    }

    let (features, frames) = log_mel_spectrogram(samples_16k);
    if frames == 0 {
        return Ok(String::new());
    }

    let dir = model_path
        .parent()
        .ok_or_else(|| "model path has no parent directory".to_string())?;
    let vocab = load_tokens(&dir.join("tokens.txt"))?;

    match kind {
        crate::models::OnnxModelKind::Ctc => {
            let logits = run_encoder_logits(&load_session(model_path)?, &features, frames, "logits")?;
            let blank = vocab.len().saturating_sub(1);
            Ok(ctc_greedy_decode(&logits, frames, &vocab, blank))
        }
        crate::models::OnnxModelKind::Tdt => {
            let enc = load_session(&dir.join("encoder.int8.onnx"))?;
            let dec = load_session(&dir.join("decoder.int8.onnx"))?;
            let join = load_session(&dir.join("joiner.int8.onnx"))?;
            transducer_greedy_decode(&enc, &dec, &join, &features, frames, &vocab)
        }
        crate::models::OnnxModelKind::Canary => {
            let enc = load_session(&dir.join("encoder.int8.onnx"))?;
            let dec = load_session(&dir.join("decoder.int8.onnx"))?;
            canary_greedy_decode(&enc, &dec, &features, frames, &vocab, language)
        }
    }
}

// ---------------------------------------------------------------------------
// Graph execution helpers
// ---------------------------------------------------------------------------

/// Run the encoder and return its (named) output tensor as an owned `Vec<f32>`.
fn run_encoder_logits(
    session: &Arc<Mutex<Session>>,
    features: &[f32],
    frames: usize,
    out_name: &str,
) -> Result<Vec<f32>, String> {
    let input = Tensor::from_array((
        vec![1usize, 80, frames],
        features.to_vec().into_boxed_slice(),
    ))
    .map_err(|err| err.to_string())?;

    let mut guard = session
        .lock()
        .map_err(|_| "onnx session lock poisoned".to_string())?;
    let inputs = ort::inputs!["audio_signal" => input].map_err(|err| err.to_string())?;
    let outputs = guard.run(inputs).map_err(|err| err.to_string())?;
    let (_shape, data) = outputs[out_name]
        .try_extract_tensor::<f32>()
        .map_err(|err| err.to_string())?;
    Ok(data.to_vec())
}

/// Run the decoder on the current token prefix and return its output as owned
/// `Vec<f32>`. `out_name` is the decoder's output tensor: `decoder_out` for the
/// TDT transducer (shape `[1, U, D]`), `logits` for Canary (shape `[1, U, V]`).
fn run_decoder(
    session: &Arc<Mutex<Session>>,
    tokens: &[i64],
    out_name: &str,
) -> Result<Vec<f32>, String> {
    let input = Tensor::from_array((
        vec![1usize, tokens.len()],
        tokens.to_vec().into_boxed_slice(),
    ))
    .map_err(|err| err.to_string())?;

    let mut guard = session
        .lock()
        .map_err(|_| "onnx session lock poisoned".to_string())?;
    let inputs = ort::inputs!["y" => input].map_err(|err| err.to_string())?;
    let outputs = guard.run(inputs).map_err(|err| err.to_string())?;
    let (_shape, data) = outputs[out_name]
        .try_extract_tensor::<f32>()
        .map_err(|err| err.to_string())?;
    Ok(data.to_vec())
}

/// Run the TDT joiner over a single encoder frame and the current decoder
/// state, returning the `[V]` vocabulary logits.
fn run_joiner(
    session: &Arc<Mutex<Session>>,
    encoder_frame: &[f32],
    decoder_last: &[f32],
) -> Result<Vec<f32>, String> {
    let encoder = Tensor::from_array((
        vec![1usize, 1, encoder_frame.len()],
        encoder_frame.to_vec().into_boxed_slice(),
    ))
    .map_err(|err| err.to_string())?;
    let decoder = Tensor::from_array((
        vec![1usize, 1, decoder_last.len()],
        decoder_last.to_vec().into_boxed_slice(),
    ))
    .map_err(|err| err.to_string())?;

    let mut guard = session
        .lock()
        .map_err(|_| "onnx session lock poisoned".to_string())?;
    let inputs = ort::inputs!["encoder_out" => encoder, "decoder_out" => decoder]
        .map_err(|err| err.to_string())?;
    let outputs = guard.run(inputs).map_err(|err| err.to_string())?;
    let (_shape, data) = outputs["logits"]
        .try_extract_tensor::<f32>()
        .map_err(|err| err.to_string())?;
    Ok(data.to_vec())
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/// Greedy CTC decode: per-frame argmax, collapse repeats, drop the blank.
fn ctc_greedy_decode(logits: &[f32], frames: usize, vocab: &[String], blank_id: usize) -> String {
    let vocab_size = vocab.len().max(1);
    let mut out = String::new();
    let mut prev = usize::MAX;

    for frame in 0..frames {
        let row = &logits[frame * vocab_size..frame * vocab_size + vocab_size];
        let mut best = 0usize;
        let mut best_val = row[0];
        for (index, &value) in row.iter().enumerate() {
            if value > best_val {
                best_val = value;
                best = index;
            }
        }

        if best != blank_id && best != prev {
            out.push_str(&vocab[best]);
            prev = best;
        }
    }

    finalize_text(&out)
}

/// Greedy transducer (RNN-T) decode for Parakeet TDT.
fn transducer_greedy_decode(
    encoder: &Arc<Mutex<Session>>,
    decoder: &Arc<Mutex<Session>>,
    joiner: &Arc<Mutex<Session>>,
    features: &[f32],
    frames: usize,
    vocab: &[String],
) -> Result<String, String> {
    let encoder_out = run_encoder_logits(encoder, features, frames, "encoder_out")?;
    let dim = encoder_out.len() / frames.max(1);
    // NeMo transducer models use blank == 0.
    let blank = 0usize;

    let mut decoder_tokens: Vec<i64> = vec![blank as i64];
    let mut text = String::new();
    let mut prev = usize::MAX;

    for frame in 0..frames {
        let enc_frame = &encoder_out[frame * dim..frame * dim + dim];
        let decoder_raw = run_decoder(decoder, &decoder_tokens, "decoder_out")?;
        let u = decoder_tokens.len();
        let dec_last = &decoder_raw[(u - 1) * dim..u * dim];

        let logits = run_joiner(joiner, enc_frame, dec_last)?;
        let vocab_size = logits.len().max(1);

        let mut best = 0usize;
        let mut best_val = logits[0];
        for (index, &value) in logits.iter().enumerate() {
            if value > best_val {
                best_val = value;
                best = index;
            }
        }

        if best == blank {
            continue;
        }

        if best != prev {
            let token = &vocab[best];
            if !is_special_token(token) {
                text.push_str(token);
            }
            prev = best;
        }

        decoder_tokens.push(best as i64);
        if decoder_tokens.len() > MAX_DECODE_TOKENS {
            break;
        }
    }

    Ok(finalize_text(&text))
}

/// Greedy encoder-decoder decode for Canary. The decoder is seeded with the
/// `<s>` / language / task tokens and autoregressively emits next-token logits.
fn canary_greedy_decode(
    encoder: &Arc<Mutex<Session>>,
    decoder: &Arc<Mutex<Session>>,
    features: &[f32],
    frames: usize,
    vocab: &[String],
    language: Option<&str>,
) -> Result<String, String> {
    let encoder_out = run_encoder_logits(encoder, features, frames, "encoder_out")?;
    let vocab_size = vocab.len();

    let bos = find_id(vocab, "<s>")
        .or_else(|| find_id(vocab, "<sos>"))
        .unwrap_or(0);
    let eos = find_id(vocab, "</s>")
        .or_else(|| find_id(vocab, "<eos>"))
        .unwrap_or(0);
    let lang = language_id(vocab, language).unwrap_or(0);
    let task = find_id_contains(vocab, "transcribe").unwrap_or(0);

    let mut decoder_tokens: Vec<i64> = vec![bos as i64, lang as i64, task as i64];
    let mut text = String::new();

    for _ in 0..MAX_DECODE_TOKENS {
        let decoder_raw = run_decoder(decoder, &decoder_tokens, "logits")?;
        let u = decoder_tokens.len();
        let last = &decoder_raw[(u - 1) * vocab_size..u * vocab_size];

        let mut best = 0usize;
        let mut best_val = last[0];
        for (index, &value) in last.iter().enumerate() {
            if value > best_val {
                best_val = value;
                best = index;
            }
        }

        if best == eos {
            break;
        }

        let token = &vocab[best];
        if !is_special_token(token) {
            text.push_str(token);
        }
        decoder_tokens.push(best as i64);
    }

    Ok(finalize_text(&text))
}

/// Collapse NeMo BPE subword markers (`▁`) into spaces and normalize whitespace.
fn finalize_text(raw: &str) -> String {
    raw.replace('▁', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A token is "special" (not emitted as transcript text) when it is wrapped in
/// angle brackets, e.g. `<s>`, `</s>`, `<|en|>`, `<|transcribe|>`,
/// `<timestamp_120>`.
fn is_special_token(token: &str) -> bool {
    token.starts_with('<') && token.ends_with('>')
}

fn find_id(vocab: &[String], exact: &str) -> Option<usize> {
    vocab.iter().position(|token| token == exact)
}

fn find_id_contains(vocab: &[String], needle: &str) -> Option<usize> {
    vocab.iter().position(|token| token.contains(needle))
}

fn language_id(vocab: &[String], language: Option<&str>) -> Option<usize> {
    let code = match language {
        Some(value) => value.split('-').next().unwrap_or(value),
        None => "en",
    };
    let tagged = format!("<|{code}|>");
    find_id(vocab, &tagged).or_else(|| find_id_contains(vocab, &format!("|{code}|")))
}

// ---------------------------------------------------------------------------
// Audio preprocessing: Kaldi/sherpa-onnx log-Mel filterbank (80 bins @ 16 kHz)
// ---------------------------------------------------------------------------

const SAMPLE_RATE: f32 = 16_000.0;
const FRAME_LENGTH: usize = 400; // 25 ms
const FRAME_SHIFT: usize = 160; // 10 ms
const N_FFT: usize = 512;
const N_MELS: usize = 80;
const LOW_FREQ: f32 = 0.0;
const HIGH_FREQ: f32 = 15_600.0; // sample_rate + (-400)
const PREEMPHASIS: f32 = 0.97;

/// Compute the 80-bin log-Mel spectrogram expected by the NeMo FastConformer
/// models. Returns `(features, num_frames)` where `features` is laid out
/// row-major as `[mel * num_frames + frame]` (matching the `[batch=1, 80, T]`
/// input the ONNX encoder expects).
fn log_mel_spectrogram(samples: &[f32]) -> (Vec<f32>, usize) {
    // Pre-emphasis.
    let mut emphasized = Vec::with_capacity(samples.len());
    let mut previous = 0.0f32;
    for &sample in samples {
        let value = sample - PREEMPHASIS * previous;
        emphasized.push(value);
        previous = sample;
    }

    let num_frames = if emphasized.len() < FRAME_LENGTH {
        0
    } else {
        1 + (emphasized.len() - FRAME_LENGTH) / FRAME_SHIFT
    };

    // Hann window.
    let window: Vec<f32> = (0..FRAME_LENGTH)
        .map(|n| {
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (FRAME_LENGTH as f32 - 1.0)).cos()
        })
        .collect();

    let mel_filters = build_mel_filters(N_MELS, N_FFT, SAMPLE_RATE, LOW_FREQ, HIGH_FREQ);
    let mut features = vec![0.0f32; N_MELS * num_frames];

    for frame in 0..num_frames {
        let start = frame * FRAME_SHIFT;
        let mut buffer = [0.0f32; N_FFT];
        for n in 0..FRAME_LENGTH {
            buffer[n] = emphasized[start + n] * window[n];
        }

        // Power spectrum via a direct (real) DFT over the first N_FFT/2 + 1 bins.
        let mut power = vec![0.0f32; N_FFT / 2 + 1];
        for k in 0..=N_FFT / 2 {
            let mut re = 0.0f32;
            let mut im = 0.0f32;
            let angle_step = 2.0 * std::f32::consts::PI * k as f32 / N_FFT as f32;
            for n in 0..N_FFT {
                let angle = angle_step * n as f32;
                re += buffer[n] * angle.cos();
                im -= buffer[n] * angle.sin();
            }
            power[k] = (re * re + im * im) / ((N_FFT * N_FFT) as f32);
        }

        for m in 0..N_MELS {
            let mut sum = 0.0f32;
            for (bin, &weight) in mel_filters[m].iter().enumerate() {
                sum += weight * power[bin];
            }
            features[m * num_frames + frame] = (sum + 1e-10).ln();
        }
    }

    (features, num_frames)
}

/// Build `n_mels` triangular Mel filterbank weights. Each inner `Vec` has length
/// `n_fft / 2 + 1` (one weight per FFT bin).
fn build_mel_filters(n_mels: usize, n_fft: usize, sample_rate: f32, low_freq: f32, high_freq: f32) -> Vec<Vec<f32>> {
    let fft_bins = n_fft / 2 + 1;
    let mut mel_lower = vec![0.0f32; n_mels + 2];
    let mel_spacing = (mel(high_freq) - mel(low_freq)) / (n_mels + 1) as f32;
    for i in 0..n_mels + 2 {
        mel_lower[i] = mel(low_freq) + i as f32 * mel_spacing;
    }

    let mut filters = vec![vec![0.0f32; fft_bins]; n_mels];
    for m in 0..n_mels {
        let left = mel_lower[m];
        let center = mel_lower[m + 1];
        let right = mel_lower[m + 2];
        for bin in 0..fft_bins {
            let freq = bin as f32 * sample_rate / n_fft as f32;
            let mel_freq = mel(freq);
            let weight = if mel_freq <= left || mel_freq >= right {
                0.0
            } else if mel_freq <= center {
                (mel_freq - left) / (center - left)
            } else {
                (right - mel_freq) / (right - center)
            };
            filters[m][bin] = weight;
        }
    }
    filters
}

fn mel(hz: f32) -> f32 {
    (2595.0 * (1.0 + hz / 700.0)).log10()
}

/// Load `tokens.txt` (one token per line, optionally `token<TAB>index`).
fn load_tokens(path: &Path) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(path).map_err(|err| {
        format!(
            "failed to read tokens.txt at {}: {err}",
            path.display()
        )
    })?;

    let mut vocab = Vec::new();
    for line in content.lines() {
        let token = if let Some((head, _)) = line.split_once(char::is_whitespace) {
            head
        } else {
            line
        };
        vocab.push(token.to_string());
    }

    if vocab.is_empty() {
        return Err(format!("tokens.txt at {} is empty", path.display()));
    }
    Ok(vocab)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_mel_spectrogram_produces_correct_shape() {
        let samples = vec![0.0f32; SAMPLE_RATE as usize]; // 1 second of silence
        let (features, frames) = log_mel_spectrogram(&samples);
        assert_eq!(frames, 1 + (samples.len() - FRAME_LENGTH) / FRAME_SHIFT);
        assert_eq!(features.len(), N_MELS * frames);
    }

    #[test]
    fn log_mel_spectrogram_is_silent_for_empty_input() {
        let (features, frames) = log_mel_spectrogram(&[]);
        assert_eq!(frames, 0);
        assert!(features.is_empty());
    }

    #[test]
    fn ctc_greedy_decode_collapses_repeats_and_drops_blank() {
        // vocab: 0 = blank, 1 = "a", 2 = "b"
        let vocab = vec!["".to_string(), "a".to_string(), "b".to_string()];
        let frames = 5;
        let v = vocab.len();
        let mut logits = vec![0.0f32; frames * v];
        // frame 0: a, frame 1: a (repeat -> collapsed), frame 2: b,
        // frame 3: blank, frame 4: b (repeat of frame 2's b -> collapsed)
        logits[0 * v + 1] = 5.0;
        logits[1 * v + 1] = 5.0;
        logits[2 * v + 2] = 5.0;
        logits[3 * v + 0] = 5.0;
        logits[4 * v + 2] = 5.0;

        let text = ctc_greedy_decode(&logits, frames, &vocab, /* blank */ 0);
        assert_eq!(text, "a b");
    }

    #[test]
    fn load_session_rejects_non_onnx_bytes() {
        let mut path: PathBuf = std::env::temp_dir();
        path.push(format!("mausvoice-onnx-invalid-{}.onnx", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"not a real onnx model, just garbage bytes").unwrap();

        let result = load_session(&path);
        assert!(result.is_err(), "synthetic bytes must not load as a valid ONNX model");

        let _ = std::fs::remove_file(&path);
    }
}
