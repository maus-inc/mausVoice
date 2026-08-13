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

    pub fn filename(self) -> &'static str {
        match self {
            Self::Tiny => "ggml-tiny.bin",
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
            Self::Medium => "ggml-medium.bin",
            Self::Large => "ggml-large-v3.bin",
            Self::Turbo => "ggml-large-v3-turbo.bin",
            Self::Hindi2Hinglish => "ggml-hindi2hinglish-apex-q5_1.bin",
            Self::ParakeetCtc06B => "sherpa-onnx-parakeet-ctc-0.6b.onnx",
            Self::ParakeetTdt06B => "sherpa-onnx-parakeet-tdt-0.6b.onnx",
            Self::Canary1B => "sherpa-onnx-canary-1b.onnx",
        }
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
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-tdt-en-24500/resolve/main/model.int8.onnx"
            }
            Self::Canary1B => {
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-1b-en-de-es-fr-int8/resolve/main/model.int8.onnx"
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
