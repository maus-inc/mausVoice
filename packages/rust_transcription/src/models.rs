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

/// The family of ONNX model served by the Sherpa-ONNX / NeMo exports. Each
/// family needs a different decoder even though all of them run on the ONNX
/// Runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnnxModelKind {
    /// NeMo FastConformer CTC (single encoder that emits logits).
    Ctc,
    /// NeMo FastConformer TDT (encoder + decoder + joiner transducer).
    Tdt,
    /// NeMo Canary encoder-decoder (encoder + autoregressive decoder).
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

    /// Returns `true` for the models that run on the ONNX Runtime rather than
    /// `whisper-rs`.
    pub fn is_onnx(self) -> bool {
        matches!(self, Self::ParakeetCtc06B | Self::ParakeetTdt06B | Self::Canary1B)
    }

    /// The decoder family for the ONNX models, or `None` for Whisper models.
    pub fn onnx_kind(self) -> Option<OnnxModelKind> {
        match self {
            Self::ParakeetCtc06B => Some(OnnxModelKind::Ctc),
            Self::ParakeetTdt06B => Some(OnnxModelKind::Tdt),
            Self::Canary1B => Some(OnnxModelKind::Canary),
            _ => None,
        }
    }

    /// The canonical on-disk filename of the *primary* artifact (the one
    /// `state.model_path` points at). The remaining artifacts live alongside it
    /// in the same directory and are resolved from [`WhisperModel::artifact_set`].
    pub fn filename(self) -> &'static str {
        match self {
            Self::Tiny => "ggml-tiny.bin",
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
            Self::Medium => "ggml-medium.bin",
            Self::Large => "ggml-large-v3.bin",
            Self::Turbo => "ggml-large-v3-turbo.bin",
            Self::Hindi2Hinglish => "ggml-hindi2hinglish-apex-q5_1.bin",
            // The NeMo ONNX exports are downloaded as their native filenames so
            // the inference engine can locate the rest of the artifact set next
            // to the primary file by convention.
            Self::ParakeetCtc06B => "model.int8.onnx",
            Self::ParakeetTdt06B => "encoder.int8.onnx",
            Self::Canary1B => "encoder.int8.onnx",
        }
    }

    /// Canonical sibling filenames used by the ONNX inference engine. The first
    /// entry always matches [`WhisperModel::filename`].
    fn artifact_filenames(self) -> &'static [&'static str] {
        match self {
            Self::ParakeetCtc06B => &["model.int8.onnx", "tokens.txt"],
            Self::ParakeetTdt06B => &[
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt",
            ],
            Self::Canary1B => &["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
            // Whisper models ship as a single GGML file.
            _ => &[],
        }
    }

    /// Every file required to run this model, as `(filename, download_url)`
    /// pairs. The primary artifact is first so the resumable download registry
    /// can track it for progress / pause / cancel while the auxiliaries are
    /// fetched alongside it.
    pub fn artifact_set(self) -> Vec<(&'static str, String)> {
        let base = match self {
            Self::ParakeetCtc06B => {
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-ctc-en-24500/resolve/main/"
            }
            Self::ParakeetTdt06B => {
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-tdt-en-24500/resolve/main/"
            }
            Self::Canary1B => {
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-1b-en-de-es-fr-int8/resolve/main/"
            }
            _ => return Vec::new(),
        };

        self.artifact_filenames()
            .iter()
            .map(|name| (*name, format!("{base}{name}")))
            .collect()
    }

    pub fn download_url(self) -> String {
        let env_var = format!(
            "RUST_TRANSCRIPTION_MODEL_URL_{}",
            self.as_slug().replace('-', "_").to_ascii_uppercase()
        );

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
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-ctc-en-24500/resolve/main/model.int8.onnx"
            }
            Self::ParakeetTdt06B => {
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-tdt-en-24500/resolve/main/encoder.int8.onnx"
            }
            Self::Canary1B => {
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-1b-en-de-es-fr-int8/resolve/main/encoder.int8.onnx"
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
