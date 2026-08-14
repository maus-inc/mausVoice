//! Model-specific ONNX inference for NVIDIA Parakeet and Canary.
//!
//! The model wrappers used here execute the exported graphs with ONNX Runtime
//! and implement each architecture's real frontend and decoder. In particular,
//! this module does not derive transcript tokens from audio energy or any other
//! synthetic signal property.

use std::collections::HashMap;
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use canary_rs::Canary;
use parakeet_rs::{Parakeet, ParakeetTDT, Transcriber};

use crate::models::WhisperModel;

enum LoadedModel {
    ParakeetCtc(Parakeet),
    ParakeetTdt(ParakeetTDT),
    Canary(Canary),
}

// Parakeet's inference API is mutable because ONNX Runtime sessions reuse
// internal buffers. The global lock is only held long enough to fetch or
// insert a cached runtime; the per-model inner lock is what serializes
// inference for a single model, so concurrent requests for *different* models
// do not block each other on the global cache lock.
static MODEL_CACHE: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<Option<LoadedModel>>>>>> =
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

    ensure_onnx_runtime()?;
    let model_dir = model_directory(model_path)?;
    let cache_key = model_dir.to_path_buf();

    // Hold the global lock only long enough to fetch (or insert) the cached
    // runtime, then release it so inference for other models can proceed.
    let entry = {
        let mut cache = MODEL_CACHE
            .lock()
            .map_err(|_| "ONNX model cache lock poisoned".to_string())?;

        cache
            .entry(cache_key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };

    let mut guard = entry
        .lock()
        .map_err(|_| "ONNX model runtime lock poisoned".to_string())?;
    if guard.is_none() {
        // Loading is guarded only by this model's lock. A different model can
        // load or transcribe concurrently without waiting on the cache map.
        *guard = Some(load_model(model, model_dir)?);
    }
    let loaded = guard
        .as_mut()
        .ok_or_else(|| "ONNX model runtime failed to initialize".to_string())?;

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

#[derive(Debug)]
pub enum OnnxModelValidationError {
    Runtime(String),
    Artifact(String),
}

impl fmt::Display for OnnxModelValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Runtime(message) => message,
            Self::Artifact(message) => message,
        };
        formatter.write_str(message)
    }
}

/// Validate the complete artifact set by constructing the model-specific
/// runtime. The upstream architecture loader opens every graph through ONNX
/// Runtime, validates tokenizer/vocabulary data, and enforces the exact model
/// family contract.
pub fn validate_model(model: WhisperModel, model_path: &Path) -> Result<bool, String> {
    validate_model_classified(model, model_path).map_err(|error| error.to_string())
}

/// The repair path must distinguish an unavailable runtime from artifacts that
/// were actually rejected. Runtime failures must never trigger deletion of a
/// correctly downloaded multi-gigabyte bundle.
pub fn validate_model_classified(
    model: WhisperModel,
    model_path: &Path,
) -> Result<bool, OnnxModelValidationError> {
    if !model.is_onnx() {
        return Err(OnnxModelValidationError::Artifact(format!(
            "model '{}' is not an ONNX model",
            model.as_slug()
        )));
    }

    ensure_onnx_runtime().map_err(OnnxModelValidationError::Runtime)?;
    let model_dir = model_directory(model_path).map_err(OnnxModelValidationError::Artifact)?;
    for (name, _) in model.artifact_set() {
        let artifact_path = model_dir.join(name);
        let metadata = std::fs::metadata(&artifact_path).map_err(|err| {
            OnnxModelValidationError::Artifact(format!(
                "required artifact '{}' is unavailable: {err}",
                artifact_path.display()
            ))
        })?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(OnnxModelValidationError::Artifact(format!(
                "required artifact '{}' is empty or not a file",
                artifact_path.display()
            )));
        }
    }

    // The architecture loader is the single source of runtime validation: it
    // opens every graph with its exact model-specific contract and validates
    // the tokenizer/vocabulary without constructing every session twice.
    // Validation loads are not cached, so a failed replacement cannot poison
    // later inference.
    load_model(model, model_dir)
        .map(|_| true)
        .map_err(OnnxModelValidationError::Artifact)
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

fn ensure_onnx_runtime() -> Result<(), String> {
    static RUNTIME: OnceLock<()> = OnceLock::new();
    static INIT_LOCK: Mutex<()> = Mutex::new(());

    if RUNTIME.get().is_some() {
        return Ok(());
    }

    let _initialization = INIT_LOCK
        .lock()
        .map_err(|_| "ONNX Runtime initialization lock poisoned".to_string())?;
    if RUNTIME.get().is_some() {
        return Ok(());
    }

    let candidates = runtime_library_candidates()?;
    let library_path = candidates
        .iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            let searched = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "ONNX Runtime dynamic library '{}' was not found; searched: {searched}",
                runtime_library_name()
            )
        })?;

    ort::init_from(library_path)
        .map_err(|err| {
            format!(
                "failed to load ONNX Runtime from '{}': {err}",
                library_path.display()
            )
        })?
        .commit();
    let _ = RUNTIME.set(());
    Ok(())
}

fn runtime_library_candidates() -> Result<Vec<PathBuf>, String> {
    let executable = env::current_exe()
        .map_err(|err| format!("failed to locate the transcription executable: {err}"))?;
    let executable_dir = executable.parent().ok_or_else(|| {
        format!(
            "transcription executable '{}' has no parent directory",
            executable.display()
        )
    })?;

    let mut candidates = Vec::new();
    for variable in ["MAUSVOICE_ORT_DYLIB_PATH", "ORT_DYLIB_PATH"] {
        if let Some(path) = env::var_os(variable).filter(|value| !value.is_empty()) {
            candidates.push(PathBuf::from(path));
        }
    }
    candidates.extend(runtime_library_candidates_from(
        executable_dir,
        runtime_library_name(),
    ));
    if let Some(path) = option_env!("MAUSVOICE_BUILD_ORT_DYLIB") {
        candidates.push(PathBuf::from(path));
    }
    candidates.dedup();
    Ok(candidates)
}

fn runtime_library_candidates_from(executable_dir: &Path, library_name: &str) -> Vec<PathBuf> {
    [
        executable_dir.join(library_name),
        executable_dir.join("onnxruntime").join(library_name),
        executable_dir
            .join("binaries")
            .join("onnxruntime")
            .join(library_name),
        executable_dir
            .join("resources")
            .join("binaries")
            .join("onnxruntime")
            .join(library_name),
        executable_dir
            .join("..")
            .join("Resources")
            .join("binaries")
            .join("onnxruntime")
            .join(library_name),
        executable_dir
            .join("..")
            .join("resources")
            .join("binaries")
            .join("onnxruntime")
            .join(library_name),
    ]
    .into_iter()
    .collect()
}

fn runtime_library_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
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

    #[test]
    fn packaged_runtime_candidates_include_tauri_resource_layout() {
        let executable_dir = Path::new("/Applications/mausVoice.app/Contents/MacOS");
        let candidates =
            runtime_library_candidates_from(executable_dir, "libonnxruntime.dylib");

        assert!(candidates.contains(&PathBuf::from(
            "/Applications/mausVoice.app/Contents/MacOS/../Resources/binaries/onnxruntime/libonnxruntime.dylib"
        )));
        assert_eq!(
            candidates.first(),
            Some(&executable_dir.join("libonnxruntime.dylib"))
        );
    }
}
