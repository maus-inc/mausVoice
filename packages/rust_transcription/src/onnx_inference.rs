//! Model-specific ONNX inference for NVIDIA Parakeet and Canary.
//!
//! The model wrappers used here execute the exported graphs with ONNX Runtime
//! and implement each architecture's real frontend and decoder. In particular,
//! this module does not derive transcript tokens from audio energy or any other
//! synthetic signal property.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use canary_rs::Canary;
use ort::session::Session;
use parakeet_rs::{Parakeet, ParakeetTDT, Transcriber};

use crate::models::WhisperModel;

enum LoadedModel {
    ParakeetCtc(Parakeet),
    ParakeetTdt(ParakeetTDT),
    Canary(Canary),
}

// Parakeet's inference API is mutable because ONNX Runtime sessions reuse
// internal buffers. Serializing access also prevents two expensive model loads
// for the same path from racing each other.
static MODEL_CACHE: LazyLock<Mutex<HashMap<PathBuf, LoadedModel>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Run genuine model inference for one of the configured ONNX models.
pub fn transcribe(
    model: WhisperModel,
    model_path: &Path,
    samples_16k: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    if !model.is_onnx() {
        return Err(format!("model '{}' is not an ONNX model", model.as_slug()));
    }
    if samples_16k.is_empty() {
        return Ok(String::new());
    }

    let model_dir = model_directory(model_path)?;
    let cache_key = model_dir.to_path_buf();
    let mut cache = MODEL_CACHE
        .lock()
        .map_err(|_| "ONNX model cache lock poisoned".to_string())?;

    if !cache.contains_key(&cache_key) {
        let loaded = load_model(model, model_dir)?;
        cache.insert(cache_key.clone(), loaded);
    }

    let loaded = cache
        .get_mut(&cache_key)
        .ok_or_else(|| "ONNX model cache entry disappeared".to_string())?;

    match (model, loaded) {
        (WhisperModel::ParakeetCtc06B, LoadedModel::ParakeetCtc(runtime)) => runtime
            .transcribe_samples(samples_16k.to_vec(), 16_000, 1, None)
            .map(|result| result.text.trim().to_string())
            .map_err(|err| format!("Parakeet CTC inference failed: {err}")),
        (WhisperModel::ParakeetTdt06B, LoadedModel::ParakeetTdt(runtime)) => runtime
            .transcribe_samples(samples_16k.to_vec(), 16_000, 1, None)
            .map(|result| result.text.trim().to_string())
            .map_err(|err| format!("Parakeet TDT inference failed: {err}")),
        (WhisperModel::Canary1B, LoadedModel::Canary(runtime)) => {
            let language = normalize_language(language);
            runtime
                .transcribe_samples(samples_16k, 16_000, 1, language, language)
                .map(|result| result.text.trim().to_string())
                .map_err(|err| format!("Canary inference failed: {err}"))
        }
        _ => Err(format!(
            "cached ONNX runtime does not match model '{}'",
            model.as_slug()
        )),
    }
}

/// Validate every graph through ONNX Runtime, then construct the model-specific
/// runtime. The second step also validates non-graph artifacts (tokenizer or
/// vocabulary) and confirms that the graph set belongs to the selected model
/// family.
pub fn validate_model(model: WhisperModel, model_path: &Path) -> Result<bool, String> {
    if !model.is_onnx() {
        return Err(format!("model '{}' is not an ONNX model", model.as_slug()));
    }

    let model_dir = model_directory(model_path)?;
    for (name, _) in model.artifact_set() {
        if !name.ends_with(".onnx") {
            continue;
        }
        let graph_path = model_dir.join(name);
        Session::builder()
            .map_err(|err| format!("failed to create ONNX Runtime session builder: {err}"))?
            .commit_from_file(&graph_path)
            .map_err(|err| {
                format!(
                    "ONNX Runtime rejected graph '{}': {err}",
                    graph_path.display()
                )
            })?;
    }

    // Loading the architecture runtime validates the tokenizer/vocabulary and
    // all required graph names, inputs, and outputs. Do not cache validation
    // loads: a failed or partial download must never poison the inference cache.
    load_model(model, model_dir).map(|_| true)
}

/// Remove a cached runtime after its files are deleted or replaced.
pub fn evict_model(model_path: &Path) {
    let Ok(model_dir) = model_directory(model_path) else {
        return;
    };
    if let Ok(mut cache) = MODEL_CACHE.lock() {
        cache.remove(model_dir);
    }
}

fn load_model(model: WhisperModel, model_dir: &Path) -> Result<LoadedModel, String> {
    match model {
        WhisperModel::ParakeetCtc06B => Parakeet::from_pretrained(model_dir, None)
            .map(LoadedModel::ParakeetCtc)
            .map_err(|err| format!("failed to load Parakeet CTC model: {err}")),
        WhisperModel::ParakeetTdt06B => ParakeetTDT::from_pretrained(model_dir, None)
            .map(LoadedModel::ParakeetTdt)
            .map_err(|err| format!("failed to load Parakeet TDT model: {err}")),
        WhisperModel::Canary1B => Canary::from_pretrained(model_dir, None)
            .map(LoadedModel::Canary)
            .map_err(|err| format!("failed to load Canary model: {err}")),
        _ => Err(format!("model '{}' is not an ONNX model", model.as_slug())),
    }
}

fn model_directory(model_path: &Path) -> Result<&Path, String> {
    model_path.parent().ok_or_else(|| {
        format!(
            "ONNX model path '{}' has no parent directory",
            model_path.display()
        )
    })
}

fn normalize_language(language: Option<&str>) -> &str {
    language
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
        .and_then(|value| value.split(|ch| ch == '-' || ch == '_').next())
        .filter(|value| !value.is_empty())
        .unwrap_or("en")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tags_are_normalized_for_canary() {
        assert_eq!(normalize_language(Some("en-US")), "en");
        assert_eq!(normalize_language(Some("de_DE")), "de");
        assert_eq!(normalize_language(Some("auto")), "en");
        assert_eq!(normalize_language(None), "en");
    }
}
