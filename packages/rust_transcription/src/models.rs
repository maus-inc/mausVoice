use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WhisperModel {
    Tiny,
    Base,
    Small,
    Medium,
    Large,
    #[serde(
        alias = "large-turbo",
        alias = "large_v3_turbo",
        alias = "large-v3-turbo"
    )]
    Turbo,
    #[serde(
        rename = "hindi2hinglish",
        alias = "hindi-hinglish",
        alias = "hindi2hinglish-apex",
        alias = "whisper-hindi2hinglish-apex"
    )]
    Hindi2Hinglish,
    #[serde(
        rename = "parakeet-ctc-0.6b",
        alias = "parakeet-ctc",
        alias = "parakeet_ctc",
        alias = "parakeet_ctc_0.6b"
    )]
    ParakeetCtc06B,
    #[serde(
        rename = "parakeet-tdt-0.6b",
        alias = "parakeet-tdt",
        alias = "parakeet_tdt",
        alias = "parakeet_tdt_0.6b"
    )]
    ParakeetTdt06B,
    #[serde(
        rename = "canary-1b",
        alias = "canary",
        alias = "canary_1b"
    )]
    Canary1B,
}

/// The family of ONNX model. Each family needs a different decoder even though
/// all of them execute their graphs with ONNX Runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnnxModelKind {
    Ctc,
    Tdt,
    Canary,
}

impl WhisperModel {
    pub fn from_slug(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "tiny" => Some(Self::Tiny),
            "base" => Some(Self::Base),
            "small" => Some(Self::Small),
            "medium" => Some(Self::Medium),
            "large" => Some(Self::Large),
            "turbo" | "large-turbo" | "large_v3_turbo" | "large-v3-turbo" => Some(Self::Turbo),
            "hindi2hinglish"
            | "hindi-hinglish"
            | "hindi2hinglish-apex"
            | "whisper-hindi2hinglish-apex" => Some(Self::Hindi2Hinglish),
            "parakeet-ctc-0.6b" | "parakeet-ctc" | "parakeet_ctc" | "parakeet_ctc_0.6b" => {
                Some(Self::ParakeetCtc06B)
            }
            "parakeet-tdt-0.6b" | "parakeet-tdt" | "parakeet_tdt" | "parakeet_tdt_0.6b" => {
                Some(Self::ParakeetTdt06B)
            }
            "canary-1b" | "canary" | "canary_1b" => Some(Self::Canary1B),
            _ => None,
        }
    }

    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Tiny => "tiny",
            Self::Base => "base",
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
            Self::Turbo => "turbo",
            Self::Hindi2Hinglish => "hindi2hinglish",
            Self::ParakeetCtc06B => "parakeet-ctc-0.6b",
            Self::ParakeetTdt06B => "parakeet-tdt-0.6b",
            Self::Canary1B => "canary-1b",
        }
    }

    pub fn is_onnx(self) -> bool {
        matches!(
            self,
            Self::ParakeetCtc06B | Self::ParakeetTdt06B | Self::Canary1B
        )
    }

    pub fn onnx_kind(self) -> Option<OnnxModelKind> {
        match self {
            Self::ParakeetCtc06B => Some(OnnxModelKind::Ctc),
            Self::ParakeetTdt06B => Some(OnnxModelKind::Tdt),
            Self::Canary1B => Some(OnnxModelKind::Canary),
            _ => None,
        }
    }

    /// Filename of the progress-tracked primary artifact. ONNX artifacts are
    /// stored beneath a model-specific directory by [`Self::storage_path`].
    pub fn filename(self) -> &'static str {
        match self {
            Self::Tiny => "ggml-tiny.bin",
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
            Self::Medium => "ggml-medium.bin",
            Self::Large => "ggml-large-v3.bin",
            Self::Turbo => "ggml-large-v3-turbo.bin",
            Self::Hindi2Hinglish => "ggml-hindi2hinglish-apex-q5_1.bin",
            // Track the largest artifact so completion cannot precede its
            // smaller graph/tokenizer companions under normal downloads.
            Self::ParakeetCtc06B => "model_int8.onnx_data",
            Self::ParakeetTdt06B => "encoder-model.int8.onnx",
            Self::Canary1B => "encoder-model.int8.onnx",
        }
    }

    /// Every file required by the model-specific runtime. The first entry is
    /// the largest artifact; one resumable registry job tracks the complete
    /// ordered bundle and finishes only after every entry is durable.
    pub fn artifact_set(self) -> Vec<(&'static str, String)> {
        let mut artifacts = match self {
            Self::ParakeetCtc06B => {
                let root =
                    "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/";
                vec![
                    (
                        "model_int8.onnx_data",
                        format!("{root}onnx/model_int8.onnx_data"),
                    ),
                    ("model_int8.onnx", format!("{root}onnx/model_int8.onnx")),
                    ("tokenizer.json", format!("{root}tokenizer.json")),
                ]
            }
            Self::ParakeetTdt06B => {
                let root =
                    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/";
                vec![
                    (
                        "encoder-model.int8.onnx",
                        format!("{root}encoder-model.int8.onnx"),
                    ),
                    (
                        "decoder_joint-model.int8.onnx",
                        format!("{root}decoder_joint-model.int8.onnx"),
                    ),
                    ("vocab.txt", format!("{root}vocab.txt")),
                ]
            }
            Self::Canary1B => {
                let root =
                    "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/";
                vec![
                    (
                        "encoder-model.int8.onnx",
                        format!("{root}encoder-model.int8.onnx"),
                    ),
                    (
                        "decoder-model.int8.onnx",
                        format!("{root}decoder-model.int8.onnx"),
                    ),
                    ("vocab.txt", format!("{root}vocab.txt")),
                ]
            }
            _ => Vec::new(),
        };

        // Preserve the existing per-model primary URL override contract.
        if let Some((_, primary_url)) = artifacts.first_mut() {
            *primary_url = self.download_url();
        }
        artifacts
    }

    pub fn storage_path(self, models_dir: &Path) -> PathBuf {
        if self.is_onnx() {
            self.artifact_path(models_dir, self.filename())
        } else {
            models_dir.join(self.filename())
        }
    }

    /// Resolve one ONNX artifact in an isolated model directory.
    pub fn artifact_path(self, models_dir: &Path, filename: &str) -> PathBuf {
        models_dir.join(self.as_slug()).join(filename)
    }

    pub fn download_url(self) -> String {
        let env_suffix: String = self
            .as_slug()
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        let env_var = format!("RUST_TRANSCRIPTION_MODEL_URL_{env_suffix}");

        if let Ok(value) = std::env::var(env_var) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        match self {
            Self::Tiny => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
            Self::Base => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
            Self::Small => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
            }
            Self::Medium => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
            }
            Self::Large => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
            }
            Self::Turbo => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
            }
            Self::Hindi2Hinglish => {
                "https://huggingface.co/mausvoice/whisper-hindi2hinglish-apex-ggml/resolve/main/ggml-hindi2hinglish-apex-q5_1.bin"
            }
            Self::ParakeetCtc06B => {
                "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/onnx/model_int8.onnx_data"
            }
            Self::ParakeetTdt06B => {
                "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx"
            }
            Self::Canary1B => {
                "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/encoder-model.int8.onnx"
            }
        }
        .to_string()
    }

    pub fn supported() -> &'static [&'static str] {
        &[
            "tiny",
            "base",
            "small",
            "medium",
            "large",
            "turbo",
            "hindi2hinglish",
            "parakeet-ctc-0.6b",
            "parakeet-tdt-0.6b",
            "canary-1b",
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onnx_models_have_isolated_storage_paths() {
        let root = Path::new("models");
        let tdt = WhisperModel::ParakeetTdt06B.storage_path(root);
        let canary = WhisperModel::Canary1B.storage_path(root);

        assert_ne!(tdt, canary);
        assert_eq!(
            tdt,
            root.join("parakeet-tdt-0.6b")
                .join("encoder-model.int8.onnx")
        );
        assert_eq!(
            canary,
            root.join("canary-1b").join("encoder-model.int8.onnx")
        );
    }

    #[test]
    fn onnx_primary_is_first_in_artifact_set() {
        for model in [
            WhisperModel::ParakeetCtc06B,
            WhisperModel::ParakeetTdt06B,
            WhisperModel::Canary1B,
        ] {
            let artifacts = model.artifact_set();
            assert_eq!(artifacts.first().map(|artifact| artifact.0), Some(model.filename()));
            assert!(artifacts.iter().all(|(_, url)| url.starts_with("https://")));
        }
    }
}
