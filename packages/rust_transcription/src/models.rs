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
    #[serde(rename = "canary-1b", alias = "canary", alias = "canary_1b")]
    Canary1B,
    #[serde(rename = "sense-voice", alias = "sensevoice", alias = "sense_voice")]
    SenseVoice,
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
            "parakeet-ctc-0.6b" | "parakeet-ctc" | "parakeet_ctc" | "parakeet_ctc_0.6b" => {
                Some(Self::ParakeetCtc06B)
            }
            "parakeet-tdt-0.6b" | "parakeet-tdt" | "parakeet_tdt" | "parakeet_tdt_0.6b" => {
                Some(Self::ParakeetTdt06B)
            }
            "canary-1b" | "canary" | "canary_1b" => Some(Self::Canary1B),
            "sense-voice" | "sensevoice" | "sense_voice" => Some(Self::SenseVoice),
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
            Self::ParakeetCtc06B => "parakeet-ctc-0.6b",
            Self::ParakeetTdt06B => "parakeet-tdt-0.6b",
            Self::Canary1B => "canary-1b",
            Self::SenseVoice => "sense-voice",
        }
    }

    pub fn is_onnx(self) -> bool {
        matches!(
            self,
            Self::ParakeetCtc06B | Self::ParakeetTdt06B | Self::Canary1B | Self::SenseVoice
        )
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
            // Track the largest artifact so completion cannot precede its
            // smaller graph/tokenizer companions under normal downloads.
            Self::ParakeetCtc06B => "model_int8.onnx_data",
            Self::ParakeetTdt06B => "encoder-model.int8.onnx",
            Self::Canary1B => "encoder-model.int8.onnx",
            Self::SenseVoice => "model.int8.onnx",
        }
    }

    /// Every file required by the model-specific runtime. ONNX artifacts are
    /// pinned to immutable Hugging Face revisions; executable graph/weight
    /// files additionally carry the upstream LFS SHA-256 digest.
    // PR #63 (#55 integration) — SenseVoice supply-chain pinning. Artifacts are pinned to an
    // immutable Hugging Face revision; the executable graph additionally carries
    // the upstream SHA-256 digest so downloads are verified against tampering.
    // Source: csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
    //   revision 355f4d4884d8afd08aef04b9007a8556d7b463b2 (main)
    //   model.int8.onnx SHA-256 12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d
    // SENSEVOICE_REVISION and SENSEVOICE_DOWNLOAD_URL must stay in sync.
    const SENSEVOICE_REVISION: &str = "355f4d4884d8afd08aef04b9007a8556d7b463b2";
    const SENSEVOICE_MODEL_SHA256: &str =
        "12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d";
    const SENSEVOICE_TOKENS_SHA256: Option<&str> = None;
    const SENSEVOICE_DOWNLOAD_URL: &str =
        "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/355f4d4884d8afd08aef04b9007a8556d7b463b2/model.int8.onnx";
    pub fn artifact_set(self) -> Vec<(&'static str, String, Option<&'static str>)> {
        let artifacts = match self {
            Self::ParakeetCtc06B => {
                let root = "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/7df2cab7aed886b8b7f80d68a8214007e4847601/";
                vec![
                    (
                        "model_int8.onnx_data",
                        format!("{root}onnx/model_int8.onnx_data"),
                        Some("136207926beb9b3bc0779d7a96c179013f51b292c320e96ae7a341ef62ab53d9"),
                    ),
                    (
                        "model_int8.onnx",
                        format!("{root}onnx/model_int8.onnx"),
                        Some("4de804b59b7b839ca21b97b5e506e558a859301d9a231a537e43c8f521037348"),
                    ),
                    ("tokenizer.json", format!("{root}tokenizer.json"), None),
                ]
            }
            Self::ParakeetTdt06B => {
                let root = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/";
                vec![
                    (
                        "encoder-model.int8.onnx",
                        format!("{root}encoder-model.int8.onnx"),
                        Some("6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
                    ),
                    (
                        "decoder_joint-model.int8.onnx",
                        format!("{root}decoder_joint-model.int8.onnx"),
                        Some("eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
                    ),
                    ("vocab.txt", format!("{root}vocab.txt"), None),
                ]
            }
            Self::Canary1B => {
                let root = "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/5ebc1520cef7b6b318b3526ad17adbfe00bc1bfc/";
                vec![
                    (
                        "encoder-model.int8.onnx",
                        format!("{root}encoder-model.int8.onnx"),
                        Some("6d96e9945898e5ace48f4efecd459ca1df81859730be27b8af6b197639403ee1"),
                    ),
                    (
                        "decoder-model.int8.onnx",
                        format!("{root}decoder-model.int8.onnx"),
                        Some("52d83aa7aad41fbbe4f9dfcd341d784735a6eb4c6eb0d3290fc27a0d8ac39abf"),
                    ),
                    ("vocab.txt", format!("{root}vocab.txt"), None),
                ]
            }
            Self::SenseVoice => {
                let root = format!(
                    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/{}/",
                    Self::SENSEVOICE_REVISION
                );
                vec![
                    (
                        "model.int8.onnx",
                        format!("{root}model.int8.onnx"),
                        Some(Self::SENSEVOICE_MODEL_SHA256),
                    ),
                    (
                        "tokens.txt",
                        format!("{root}tokens.txt"),
                        Self::SENSEVOICE_TOKENS_SHA256,
                    ),
                ]
            }
            _ => Vec::new(),
        };
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

    /// Resolve the download URL, optionally overridden by an environment variable.
    /// The variable name is derived from `as_slug()` mapped to uppercase
    /// alphanumeric with every non-alphanumeric character replaced by `_`.
    /// Example: `sense-voice` -> `RUST_TRANSCRIPTION_MODEL_URL_SENSE_VOICE`.
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
            Self::ParakeetCtc06B => {
                "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/onnx/model_int8.onnx_data"
            }
            Self::ParakeetTdt06B => {
                "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx"
            }
            Self::Canary1B => {
                "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/encoder-model.int8.onnx"
            }
            Self::SenseVoice => {
                // Pin the primary download URL to the same immutable revision.
                Self::SENSEVOICE_DOWNLOAD_URL
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
            "parakeet-ctc-0.6b",
            "parakeet-tdt-0.6b",
            "canary-1b",
            "sense-voice",
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
        let onnx_models: Vec<WhisperModel> = WhisperModel::supported()
            .iter()
            .filter_map(|slug| WhisperModel::from_slug(slug))
            .filter(|model| model.is_onnx())
            .collect();
        assert!(!onnx_models.is_empty());

        for model in onnx_models {
            let artifacts = model.artifact_set();
            assert_eq!(
                artifacts.first().map(|artifact| artifact.0),
                Some(model.filename())
            );
            assert!(artifacts.len() > 1);
            assert!(artifacts.iter().all(|(_, url, _)| {
                url.starts_with("https://huggingface.co/") && !url.contains("/resolve/main/")
            }));
            // The primary executable graph must always be digest-pinned,
            // including SenseVoice (no longer exempt).
            assert!(artifacts
                .first()
                .is_some_and(|(_, _, sha256)| sha256.is_some()));
        }
    }

    #[test]
    fn sensevoice_uses_immutable_revision_and_digest() {
        let artifacts = WhisperModel::SenseVoice.artifact_set();
        // No artifact may be served from the mutable `main` branch, and no
        // placeholder text may survive.
        assert!(artifacts
            .iter()
            .all(|(_, url, _)| !url.contains("/resolve/main/")));
        assert!(artifacts.iter().all(|(_, url, _)| !url.contains("REPLACE")));
        // The executable graph must carry a verified digest.
        let (_, _, digest) = &artifacts[0];
        let digest = digest.expect("SenseVoice primary graph must be digest-pinned");
        // The pinned revision must be an immutable 40-char commit SHA, not a
        // placeholder or the mutable `main` branch.
        assert_eq!(
            WhisperModel::SENSEVOICE_REVISION.len(),
            40,
            "SenseVoice must pin an immutable 40-char commit SHA, not a placeholder"
        );
        assert!(
            WhisperModel::SENSEVOICE_REVISION
                .chars()
                .all(|c| c.is_ascii_hexdigit()),
            "SenseVoice revision must be a hexadecimal commit SHA"
        );
        assert!(
            !WhisperModel::SENSEVOICE_REVISION.contains("REPLACE")
                && WhisperModel::SENSEVOICE_REVISION != "main",
            "SenseVoice revision must not be a placeholder or `main`"
        );
        // The digest must be a 64-char SHA-256.
        assert_eq!(
            digest.len(),
            64,
            "SenseVoice digest must be a 64-char SHA-256, not a placeholder"
        );
        assert!(
            digest.chars().all(|c| c.is_ascii_hexdigit()),
            "SenseVoice digest must be a hexadecimal SHA-256"
        );
        // The primary download URL must also be revision-pinned.
        assert!(
            !WhisperModel::SenseVoice
                .download_url()
                .contains("/resolve/main/"),
            "SenseVoice download URL must not use the mutable main branch"
        );
    }

    #[test]
    fn whisper_cpp_models_have_valid_filenames() {
        for slug in ["tiny", "base", "small", "medium", "large", "turbo"] {
            let model = WhisperModel::from_slug(slug).expect("supported whisper slug must parse");
            assert!(model.filename().starts_with("ggml-"));
            assert!(model.filename().ends_with(".bin"));
        }
    }

    #[test]
    fn unsupported_transformers_checkpoint_is_not_exposed_as_a_ggml_model() {
        assert_eq!(WhisperModel::from_slug("hindi2hinglish"), None);
        assert_eq!(WhisperModel::from_slug("hindi2hinglish-apex"), None);
    }
}
